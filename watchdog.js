#!/usr/bin/env node
/**
 * Server-Wächter (eigener PM2-Prozess "beckhome-watchdog", unabhängig von der App)
 *
 * Prüft jede Minute und meldet Ausfälle direkt über die Telegram-Bot-API an die Benachrichtigungs-IDs aus den
 * Einstellungen (läuft also auch, wenn die App selbst hängt oder abgestürzt ist):
 *   1. App:     http://127.0.0.1:<PORT>/api/health antwortet (inkl. Datenbank)
 *   2. Tunnel:  <Öffentliche Adresse>/api/health über Cloudflare -> Tunnel -> App (nur wenn die App lokal läuft,
 *               sonst wäre es dieselbe Ursache); dazu der Zustand des cloudflared-Dienstes als Hinweis
 *   3. Speicher: freier Platz auf der Festplatte
 *   4. Neustart: ist der Server neu gestartet (z. B. nach Stromausfall/Wartung), kommt eine Meldung mit dem
 *               letzten Lebenszeichen davor
 * Optional pingt er eine externe Heartbeat-Adresse (WATCHDOG_HEARTBEAT_URL in der .env, z. B. healthchecks.io).
 * Fällt der ganze Server aus, bleibt der Ping aus und der externe Dienst meldet das.
 *
 * Nuki (Schloss offline, Nuki Web nicht erreichbar, Batterie) überwacht die App selbst (booking-monitor.js).
 * Die App prüft umgekehrt, ob dieser Wächter noch läuft (Zustandsdatei watchdog-state.json).
 *
 * Start:  pm2 start watchdog.js --name beckhome-watchdog && pm2 save   (macht update.sh automatisch)
 * Test:   node watchdog.js --test   (schickt eine Testnachricht und zeigt das Prüfergebnis)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const DIR = __dirname;
const STATE_FILE = path.join(DIR, 'watchdog-state.json');
const DB_FILE = path.join(DIR, 'rental.db');
const PORT = process.env.PORT || 3000;
const LOCAL_URL = process.env.WATCHDOG_LOCAL_URL || `http://127.0.0.1:${PORT}/api/health`;
const HEARTBEAT_URL = (process.env.WATCHDOG_HEARTBEAT_URL || '').trim();
const TZ = 'Europe/Berlin';

const INTERVAL_MS = Math.max(5000, Number(process.env.WATCHDOG_INTERVAL_MS) || 60 * 1000);
const TG_API = (process.env.WATCHDOG_TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');
const TIMEOUT_MS = 15 * 1000;
// Erst nach so vielen Fehlversuchen in Folge melden (Neustart bei update.sh, kurze Netz-Aussetzer bleiben still)
const FAILS = { app: 3, public: 5 };
const REMIND_MS = 6 * 60 * 60 * 1000;   // solange etwas ausgefallen ist: Erinnerung alle 6 Stunden
const DISK_WARN = { pct: 10, bytes: 2 * 1024 ** 3 };   // warnen unter 10 % oder unter 2 GB frei
const DISK_OK_PCT = 15;
const BOOT_WINDOW_S = 20 * 60;          // Server läuft erst seit < 20 Min -> Neustart melden
const MAX_PENDING = 20;

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtTime = ms => new Date(ms).toLocaleString('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' Uhr';
function fmtDuration(ms) {
    const min = Math.max(1, Math.round(ms / 60000));
    if (min === 1) return '1 Minute';
    if (min < 120) return `${min} Minuten`;
    const h = Math.round(min / 60);
    if (h < 48) return `${h} Stunden`;
    return `${Math.round(h / 24)} Tagen`;
}
const log = (...a) => console.log(new Date().toISOString(), ...a);

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
}
function saveState(state) {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
}

/** Telegram-Token, Empfänger und öffentliche Adresse aus der App-Datenbank (bei jedem Durchlauf neu). */
function readConfig(state) {
    try {
        const Database = require('better-sqlite3');
        const db = new Database(DB_FILE, { fileMustExist: true, readonly: true, timeout: 5000 });
        try {
            const get = key => {
                const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
                if (!row) return null;
                try { return JSON.parse(row.value); } catch (e) { return row.value; }
            };
            let ids = get('tg_ids');
            if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch (e) { ids = [ids]; } }
            if (!Array.isArray(ids)) ids = [];
            const single = get('tg_id');
            if (!ids.length && single) ids = [single];
            const site = get('site');
            const cfg = {
                token: String(get('tg_token') || '').trim(),
                ids: ids.map(i => String(i || '').trim()).filter(Boolean),
                publicUrl: site && typeof site === 'object' ? String(site.public_url || '').trim() : ''
            };
            state.config = cfg; // letzter bekannter Stand, falls die Datenbank später nicht lesbar ist
            return cfg;
        } finally { db.close(); }
    } catch (e) {
        log('⚠️ Einstellungen nicht lesbar:', e.message);
        return state.config || { token: '', ids: [], publicUrl: '' };
    }
}

function publicHealthUrl(publicUrl) {
    if (process.env.WATCHDOG_PUBLIC_URL) return process.env.WATCHDOG_PUBLIC_URL;
    try {
        const u = new URL(publicUrl);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        // Nur echte Domains prüfen (Heimnetz-IP/localhost läuft nicht über den Tunnel)
        if (/^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(u.hostname)) return null;
        return `${u.protocol}//${u.host}/api/health`;
    } catch (e) { return null; }
}

async function checkHealth(url) {
    const started = Date.now();
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual', headers: { 'User-Agent': 'Beckhome-Watchdog/1.0', 'Cache-Control': 'no-cache' } });
        const text = await res.text().catch(() => '');
        let ok = false;
        try { ok = res.ok && JSON.parse(text).ok === true; } catch (e) { /* keine JSON-Antwort */ }
        if (ok) return { ok: true, ms: Date.now() - started };
        let reason = `Antwort ${res.status}`;
        if (res.status === 530 || /error code: 1033/i.test(text)) reason += ' (Cloudflare erreicht den Tunnel nicht)';
        else if (res.status === 502 || res.status === 504) reason += ' (Tunnel erreicht die App nicht)';
        else if (res.status >= 300 && res.status < 400) reason += ' (Weiterleitung, z. B. Cloudflare Access davor?)';
        return { ok: false, reason };
    } catch (e) {
        const c = e.cause && (e.cause.code || e.cause.message);
        const reason = e.name === 'TimeoutError' ? `keine Antwort nach ${TIMEOUT_MS / 1000} s` : (c === 'ECONNREFUSED' ? 'Verbindung abgelehnt (App läuft nicht)' : (c || e.message));
        return { ok: false, reason };
    }
}

function cloudflaredStatus() {
    return new Promise(resolve => {
        execFile('systemctl', ['is-active', 'cloudflared'], { timeout: 5000 }, (err, stdout) => {
            // kein systemd/cloudflared nicht als Dienst eingerichtet -> kein Hinweis
            if (err && (err.code === 'ENOENT' || !stdout)) return resolve('');
            resolve(String(stdout || '').trim());
        });
    });
}

function diskStatus() {
    try {
        const s = fs.statfsSync(DIR);
        const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
        return { free, total, pct: total ? Math.round(free / total * 1000) / 10 : 100 };
    } catch (e) { return null; }
}
const gb = b => (b / 1024 ** 3).toFixed(1).replace('.', ',') + ' GB';

async function sendTelegram(cfg, text) {
    if (!cfg.token || !cfg.ids.length) return false;
    let any = false;
    for (const chatId of cfg.ids) {
        try {
            const res = await fetch(`${TG_API}/bot${cfg.token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
            if (res.ok) any = true;
            else log('⚠️ Telegram', chatId, res.status, (await res.text().catch(() => '')).slice(0, 200));
        } catch (e) {
            log('⚠️ Telegram nicht erreichbar:', e.message);
        }
    }
    return any;
}

// ---------------------------------------------------------------------------
// Ein Prüf-Durchlauf
// ---------------------------------------------------------------------------
function newState() {
    return { version: 1, startedAt: Date.now(), lastRun: 0, checks: {}, pending: [] };
}

/** Zählt Fehlversuche einer Prüfung und liefert die zu sendende Nachricht (oder null). */
function track(state, key, ok, now, texts) {
    const c = state.checks[key] || (state.checks[key] = { fails: 0 });
    if (ok) {
        const msg = c.alerted ? texts.back(now - c.since) : null;
        state.checks[key] = { fails: 0, ok: true, at: now };
        return msg;
    }
    if (!c.fails) c.since = now;
    c.fails++;
    c.ok = false;
    c.at = now;
    c.reason = texts.reason;
    if (!c.alerted && c.fails >= texts.after) {
        c.alerted = now;
        c.remindedAt = now;
        return texts.down(now - c.since);
    }
    if (c.alerted && now - c.remindedAt >= REMIND_MS) {
        c.remindedAt = now;
        return texts.still(now - c.since);
    }
    return null;
}

async function runOnce(state, opts = {}) {
    const now = Date.now();
    const cfg = readConfig(state);
    const msgs = [];

    // 1. App lokal
    const app = await checkHealth(LOCAL_URL);
    const appMsg = track(state, 'app', app.ok, now, {
        after: FAILS.app,
        reason: app.reason,
        down: d => `🔴 <b>App antwortet nicht</b>\nSeit ${fmtDuration(d)} keine Antwort von der App (${esc(app.reason)}).\n` +
            'Gäste-Webseite, Admin, Telegram-Bot und Türcode-Automatik sind betroffen.\n' +
            'Auf dem Server prüfen: <code>pm2 status</code> und <code>pm2 logs invoice-app --lines 50</code>, ggf. <code>pm2 restart invoice-app</code>',
        still: d => `🔴 <b>App ist immer noch nicht erreichbar</b> (seit ${fmtDuration(d)})\nLetzter Fehler: ${esc(app.reason)}`,
        back: d => `✅ <b>App läuft wieder</b>\nNach etwa ${fmtDuration(d)} antwortet die App wieder.`
    });
    if (appMsg) msgs.push(appMsg);

    // 2. Öffentlich über Cloudflare Tunnel (nur sinnvoll, wenn die App lokal läuft)
    const pubUrl = publicHealthUrl(cfg.publicUrl);
    if (pubUrl && app.ok) {
        const pub = await checkHealth(pubUrl);
        let hint = '';
        if (!pub.ok) {
            const cf = await cloudflaredStatus();
            if (cf) hint = `\ncloudflared-Dienst: <b>${esc(cf)}</b>` + (cf !== 'active' ? ' → <code>sudo systemctl restart cloudflared</code>' : '');
        }
        const host = new URL(pubUrl).host;
        const pubMsg = track(state, 'public', pub.ok, now, {
            after: FAILS.public,
            reason: pub.reason,
            down: d => `🟠 <b>${esc(host)} ist von außen nicht erreichbar</b>\nDie App läuft, aber seit ${fmtDuration(d)} kommt über Cloudflare nichts an (${esc(pub.reason)}).` +
                hint + '\nGäste sehen die Webseite nicht, iCal-Abgleich und Admin über die Domain gehen nicht.',
            still: d => `🟠 <b>${esc(host)} ist immer noch nicht erreichbar</b> (seit ${fmtDuration(d)})\nLetzter Fehler: ${esc(pub.reason)}` + hint,
            back: d => `✅ <b>${esc(host)} wieder erreichbar</b>\nNach etwa ${fmtDuration(d)} ist die Webseite über den Tunnel wieder da.`
        });
        if (pubMsg) msgs.push(pubMsg);
        state.publicHost = host;
    } else if (!pubUrl) {
        delete state.checks.public;
        delete state.publicHost;
    }

    // 3. Festplatte
    const disk = diskStatus();
    if (disk) {
        const d = state.checks.disk || (state.checks.disk = {});
        const low = disk.pct < DISK_WARN.pct || disk.free < DISK_WARN.bytes;
        if (low && !d.alerted) {
            d.alerted = now;
            msgs.push(`💾 <b>Festplatte fast voll</b>\nNur noch ${gb(disk.free)} frei (${String(disk.pct).replace('.', ',')} %). ` +
                'Bei vollem Speicher können Datenbank, Rechnungen und Backups nicht mehr geschrieben werden.\n' +
                'Prüfen: <code>df -h</code>, alte Logs leeren mit <code>pm2 flush</code>');
        } else if (!low && d.alerted && disk.pct >= DISK_OK_PCT) {
            delete d.alerted;
            msgs.push(`✅ <b>Festplatte wieder ok</b>\n${gb(disk.free)} frei (${String(disk.pct).replace('.', ',')} %).`);
        }
        Object.assign(d, { ok: !low, free: disk.free, pct: disk.pct, at: now });
    }

    // 4. Externer Heartbeat (Dead-Man-Switch): nur wenn die App lokal antwortet
    if (HEARTBEAT_URL) {
        const url = app.ok ? HEARTBEAT_URL : HEARTBEAT_URL.replace(/\/+$/, '') + '/fail';
        try { await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }); state.heartbeatAt = now; } catch (e) { log('⚠️ Heartbeat:', e.message); }
    }

    // Senden (nicht zugestellte Meldungen beim nächsten Durchlauf erneut versuchen, z. B. Internet weg)
    const queue = [...(state.pending || []), ...msgs.map(text => ({ text, at: now }))];
    state.pending = [];
    for (const m of queue) {
        const text = m.at < now - 2 * 60 * 1000 ? `${m.text}\n<i>(festgestellt ${fmtTime(m.at)})</i>` : m.text;
        if (!(await sendTelegram(cfg, text))) state.pending.push(m);
    }
    state.pending = state.pending.slice(-MAX_PENDING);
    if (!cfg.token || !cfg.ids.length) state.noTelegram = true; else delete state.noTelegram;

    state.lastRun = now;
    state.pid = process.pid;
    if (!opts.dryRun) saveState(state);
    for (const m of msgs) log('📣', m.replace(/<[^>]+>/g, '').split('\n')[0]);
    return { app, pubUrl, disk, cfg };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function startup(state, fresh) {
    const cfg = readConfig(state);
    const bootAt = Date.now() - os.uptime() * 1000;
    if (fresh) {
        await sendTelegram(cfg, '🛡️ <b>Server-Wächter ist aktiv</b>\nIch melde mich, wenn die App, die Webseite über den Tunnel oder der Speicherplatz Probleme machen, und wenn der Server neu gestartet wurde.');
    } else if (os.uptime() < BOOT_WINDOW_S && (!state.bootReported || Math.abs(state.bootReported - bootAt) > 5 * 60 * 1000)) {
        const last = state.lastRun ? `\nLetztes Lebenszeichen davor: ${fmtTime(state.lastRun)} (Ausfall etwa ${fmtDuration(bootAt - state.lastRun)}).` : '';
        await sendTelegram(cfg, `🔄 <b>Server wurde neu gestartet</b>\nHochgefahren um ${fmtTime(bootAt)}.` + last + '\nIch prüfe jetzt, ob alles wieder läuft.');
    }
    state.bootReported = bootAt;
    state.startedAt = Date.now();
}

async function main() {
    if (process.argv.includes('--test')) {
        const state = loadState() || newState();
        const r = await runOnce(state, { dryRun: true });
        console.log('App lokal:', r.app.ok ? `ok (${r.app.ms} ms)` : r.app.reason);
        console.log('Öffentlich:', r.pubUrl || '(keine Domain als Öffentliche Adresse eingetragen)', state.checks.public ? (state.checks.public.ok ? 'ok' : state.checks.public.reason) : '');
        if (r.disk) console.log('Festplatte:', gb(r.disk.free), 'frei', r.disk.pct + ' %');
        console.log('cloudflared:', await cloudflaredStatus() || '-');
        console.log('Telegram-Empfänger:', r.cfg.ids.length || 'keine (Token/IDs in den Einstellungen eintragen)');
        const sent = await sendTelegram(r.cfg, '🧪 <b>Test vom Server-Wächter</b>\nDie Meldungen kommen an.');
        console.log('Testnachricht:', sent ? 'gesendet' : 'NICHT gesendet');
        process.exit(sent ? 0 : 1);
    }

    let state = loadState();
    const fresh = !state;
    if (!state) state = newState();
    state.pending = state.pending || [];
    state.checks = state.checks || {};
    await startup(state, fresh).catch(e => log('⚠️ Start:', e.message));
    saveState(state);
    log(`🛡️ Server-Wächter läuft (App: ${LOCAL_URL}, alle ${INTERVAL_MS / 1000} s)`);

    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try { await runOnce(state); } catch (e) { log('❌ Prüfung fehlgeschlagen:', e.message); } finally { running = false; }
    };
    // Erste Prüfung nach 30 s (nach einem Neustart braucht die App etwas)
    setTimeout(() => { tick(); setInterval(tick, INTERVAL_MS); }, Math.min(30 * 1000, INTERVAL_MS));
}

if (require.main === module) main();

module.exports = { _internal: { track, publicHealthUrl, checkHealth, fmtDuration, FAILS } };
