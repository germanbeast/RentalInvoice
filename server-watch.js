// App side of the server watchdog (watchdog.js runs as its own PM2 process and writes watchdog-state.json).
// - status(): what the admin and the Telegram command /server show
// - check(notify): warns once when the watchdog stopped running (state file older than STALE_MS), and when it is back
'use strict';

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'watchdog-state.json');
const STALE_MS = 10 * 60 * 1000;
const TZ = 'Europe/Berlin';

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtTime = ms => new Date(ms).toLocaleString('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' Uhr';

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
}

/** Watchdog status without secrets (the state file also caches the Telegram token). */
function status(now = Date.now()) {
    const s = readState();
    if (!s) return { installed: false };
    const running = !!s.lastRun && now - s.lastRun < STALE_MS;
    const checks = {};
    for (const [key, c] of Object.entries(s.checks || {})) {
        checks[key] = { ok: c.ok !== false, since: c.ok === false ? c.since || null : null, reason: c.ok === false ? c.reason || null : null, alerted: !!c.alerted };
        if (key === 'disk') Object.assign(checks[key], { free: c.free || null, pct: c.pct || null });
    }
    return {
        installed: true, running, lastRun: s.lastRun || null, startedAt: s.startedAt || null,
        publicHost: s.publicHost || null, heartbeat: !!s.heartbeatAt, noTelegram: !!s.noTelegram,
        pending: (s.pending || []).length, checks
    };
}

/** Telegram text (HTML) for /server. */
function text(now = Date.now()) {
    const st = status(now);
    if (!st.installed) {
        return '🛡️ <b>Server-Wächter</b>\nNoch nicht eingerichtet. Auf dem Server im App-Ordner <code>./update.sh</code> ausführen ' +
            '(oder <code>pm2 start watchdog.js --name beckhome-watchdog &amp;&amp; pm2 save</code>).';
    }
    const line = (ok, label, detail) => `${ok ? '✅' : '🔴'} ${label}${detail ? ': ' + detail : ''}`;
    const rows = [];
    rows.push(line(st.running, 'Wächter', st.running ? `läuft (letzte Prüfung ${fmtTime(st.lastRun)})` : `läuft nicht! Letzte Prüfung ${st.lastRun ? fmtTime(st.lastRun) : 'nie'}`));
    const c = st.checks;
    if (c.app) rows.push(line(c.app.ok, 'App', c.app.ok ? 'antwortet' : `${esc(c.app.reason)} (seit ${fmtTime(c.app.since)})`));
    if (c.public) rows.push(line(c.public.ok, `${esc(st.publicHost || 'Domain')} über Tunnel`, c.public.ok ? 'erreichbar' : `${esc(c.public.reason)} (seit ${fmtTime(c.public.since)})`));
    else rows.push('➖ Domain: keine eigene Domain als Öffentliche Adresse eingetragen');
    if (c.disk && c.disk.free) {
        const free = (c.disk.free / 1024 ** 3).toFixed(1).replace('.', ',');
        rows.push(line(c.disk.ok, 'Festplatte', `${free} GB frei (${String(c.disk.pct).replace('.', ',')} %)`));
    }
    rows.push(st.heartbeat ? '✅ Externer Heartbeat aktiv (meldet auch Totalausfall)' : 'ℹ️ Kein externer Heartbeat: fällt der ganze Server aus, kommt die Meldung erst nach dem Neustart');
    if (st.pending) rows.push(`⏳ ${st.pending} Meldung(en) warten noch auf Zustellung`);
    rows.push('ℹ️ Nuki (offline, Batterie) prüft die App selbst: /schloss');
    return '🛡️ <b>Server-Status</b>\n' + rows.join('\n');
}

/** Called every 10 minutes by the app. `store` keeps the alert flag across restarts. */
async function check(notify, store, now = Date.now()) {
    const s = readState();
    if (!s) return null; // never installed -> stay quiet
    const stale = !s.lastRun || now - s.lastRun >= STALE_MS;
    const flag = store.get() || {};
    if (stale && !flag.alerted) {
        store.set({ alerted: now });
        await notify('⚠️ *Server-Wächter läuft nicht*\n' +
            `Letzte Prüfung: ${s.lastRun ? fmtTime(s.lastRun) : 'nie'}. Solange er aus ist, kommen keine Meldungen bei App- oder Tunnel-Ausfall.\n` +
            'Auf dem Server: `pm2 restart beckhome-watchdog` (oder `./update.sh`)', 'server_watch');
        return 'stale';
    }
    if (!stale && flag.alerted) {
        store.set({});
        await notify('✅ *Server-Wächter läuft wieder*', 'server_watch');
        return 'back';
    }
    return null;
}

module.exports = { status, text, check, STATE_FILE, STALE_MS };
