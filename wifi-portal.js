/**
 * Gäste-WLAN mit Anmeldeseite: eigener Router (z. B. GL.iNet GL-A1300 mit OpenWrt + openNDS) an der FRITZ!Box.
 *
 * How it works (openNDS "Forward Authentication Service", fas_secure_enabled 4):
 *  1. A phone joins the WLAN "Beckhome Gäste". openNDS on the router sends it to https://<public_url>/wlan?fas=<base64>
 *     (the router lets only this host through before login, "walled garden"). The base64 string holds clientip,
 *     clientmac, gatewayname, hid (hashed client token) and more, comma-space separated.
 *  2. The guest types the access code of the booking (bookings.wifi_code, shown on "Meine Buchung", in the arrival
 *     message and on the TV). Phones that were online in this stay before, or a guest logged in to "Meine Buchung"
 *     in that browser, are let in without the code.
 *  3. We put "rhid sessionlength 0 0 0 0 custom" into the queue of that router (rhid = sha256(hid + faskey)).
 *  4. The router's authmon daemon fetches the queue every few seconds (GET /wlan?auth_get=view&gatewayhash=…&payload=…
 *     [&authmac=…]), runs "ndsctl auth" and acknowledges. The waiting page sees the acknowledgement and says "online".
 *
 * The session lasts until the check-out day at check-out time plus the grace time. Devices per booking are counted
 * by MAC address (table wifi_portal_devices). The router itself is set up with one command that downloads
 * /wlan/setup.sh?k=<setup token> (see setupScript()).
 */

const crypto = require('crypto');
const guestLang = require('./guest-lang');
const path = require('path');
const express = require('express');

const SITE_DIR = path.join(__dirname, 'guest-site');
const HEX64 = /^[0-9a-f]{64}$/;
const QUEUE_TTL_MS = 3 * 60 * 1000;          // a queued login the router did not pick up is dropped after 3 minutes
const ROUTER_OFFLINE_MIN = 15;               // Telegram when the router has not asked for 15 minutes
const OWNER_SESSION_MIN = 7 * 24 * 60;       // owner code: one week
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEqual = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Parses the fas query value (base64 of "name=value, name=value, …"). Returns {} when it is not valid. */
function parseFas(raw) {
    const s = String(raw || '').replace(/ /g, '+').trim();
    if (!s || s.length > 4096 || !/^[A-Za-z0-9+/=_-]+$/.test(s)) return {};
    let dec;
    try { dec = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { return {}; }
    const out = {};
    for (const part of dec.split(', ')) {
        const i = part.indexOf('=');
        if (i < 1) continue;
        const k = part.slice(0, i).trim();
        if (/^[a-z_]{2,30}$/.test(k)) out[k] = part.slice(i + 1).trim();
    }
    return out;
}

const decodeSafe = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
const normMac = m => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '').replace(/(..)(?=.)/g, '$1:');
const normCode = c => String(c || '').replace(/\D/g, '');

/** Hashes authmon could use for this gateway name (it hashes the url-encoded name, the fas string may differ). */
function gatewayHashes(name) {
    const n = String(name || '').trim();
    const set = new Set([sha256(n), sha256(decodeSafe(n)), sha256(encodeURIComponent(decodeSafe(n)))]);
    return [...set];
}

/** Epoch ms of a local Berlin date + time ("2026-11-17", "11:00"). */
function berlinEpoch(ymd, hhmm) {
    const [y, mo, d] = ymd.split('-').map(Number);
    const [h, mi] = String(hhmm || '00:00').split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        .formatToParts(new Date(guess)).reduce((a, p) => (a[p.type] = p.value, a), {});
    const asBerlin = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    return guess - (asBerlin - guess);
}

function createWifiPortal({ db, getConfig, getSite, guestBooking, guestName, chatButton, telegram, berlinToday, formatDateDE }) {
    const sql = () => db.getDb();
    sql().exec(`
        CREATE TABLE IF NOT EXISTS wifi_portal_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER,
            kind TEXT NOT NULL DEFAULT 'guest',
            mac TEXT NOT NULL,
            ip TEXT,
            gateway TEXT,
            user_agent TEXT,
            first_at TEXT NOT NULL,
            last_at TEXT NOT NULL,
            until TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_wifi_portal_devices_booking ON wifi_portal_devices(booking_id);
        CREATE INDEX IF NOT EXISTS idx_wifi_portal_devices_mac ON wifi_portal_devices(mac);
        -- last counters the router reported per device (openNDS counts per session, in KB)
        CREATE TABLE IF NOT EXISTS wifi_portal_clients (
            mac TEXT PRIMARY KEY,
            last_down INTEGER NOT NULL DEFAULT 0,
            last_up INTEGER NOT NULL DEFAULT 0,
            last_seen TEXT
        );
        -- data volume per day (KB), from the router's reports every 2 minutes
        CREATE TABLE IF NOT EXISTS wifi_portal_usage (
            day TEXT PRIMARY KEY,
            down_kb INTEGER NOT NULL DEFAULT 0,
            up_kb INTEGER NOT NULL DEFAULT 0
        );
    `);
    {
        const dc = sql().prepare('PRAGMA table_info(wifi_portal_devices)').all().map(c => c.name);
        if (!dc.includes('down_kb')) sql().exec('ALTER TABLE wifi_portal_devices ADD COLUMN down_kb INTEGER NOT NULL DEFAULT 0');
        if (!dc.includes('up_kb')) sql().exec('ALTER TABLE wifi_portal_devices ADD COLUMN up_kb INTEGER NOT NULL DEFAULT 0');
        if (!dc.includes('code_id')) sql().exec('ALTER TABLE wifi_portal_devices ADD COLUMN code_id INTEGER');
    }
    // Extra access codes made by the host (e.g. per Telegram) for visitors, craftsmen, own use
    sql().exec(`
        CREATE TABLE IF NOT EXISTS wifi_portal_codes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL,
            note TEXT,
            created_at TEXT NOT NULL,
            created_by TEXT,
            valid_until TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_wifi_portal_codes_code ON wifi_portal_codes(code);
    `);

    // gatewayhash -> Map(rhid -> { line, at, deviceId })
    const queues = new Map();
    // rhids the router acknowledged (rhid -> time), so the waiting page can say "online"
    const acked = new Map();
    // failed code attempts: key -> [timestamps]
    const failures = new Map();
    let routerLive = null; // { at, ua, ip } last authmon request (DB copy at most every 5 minutes)

    const cfg = () => getConfig().portal;
    const active = () => getConfig().mode === 'portal';

    // -----------------------------------------------------------------------
    // Who may use the WLAN
    // -----------------------------------------------------------------------
    /** Window of a booking: arrival day 00:00 until check-out day at check-out time + grace. */
    function windowOf(b) {
        const site = getSite();
        return {
            from: berlinEpoch(b.checkin, '00:00'),
            until: berlinEpoch(b.checkout, site.checkout_time || '11:00') + (Number(cfg().grace_min) || 0) * 60 * 1000
        };
    }

    function bookingByCode(code) {
        if (!/^\d{6}$/.test(code)) return null;
        const today = berlinToday();
        return sql().prepare(`SELECT * FROM bookings WHERE wifi_code = ? AND checkout >= date(?, '-2 days') ORDER BY checkin DESC LIMIT 1`).get(code, today) || null;
    }

    /** Check of a booking for now: { ok, reason, until } */
    function bookingAccess(b, now = Date.now()) {
        if (!b || !b.checkin || !b.checkout) return { ok: false, reason: 'code' };
        const w = windowOf(b);
        if (now < w.from) return { ok: false, reason: 'early', from: b.checkin };
        if (now > w.until) return { ok: false, reason: 'over' };
        return { ok: true, until: w.until };
    }

    function devicesOf(bookingId) {
        return sql().prepare(`SELECT * FROM wifi_portal_devices WHERE booking_id = ? AND kind = 'guest' ORDER BY first_at`).all(bookingId);
    }

    // -----------------------------------------------------------------------
    // Extra codes (made per Telegram): 6 digits, valid from now for some hours or days
    // -----------------------------------------------------------------------
    function extraByCode(code) {
        if (!/^\d{6}$/.test(code)) return null;
        return sql().prepare('SELECT * FROM wifi_portal_codes WHERE code = ? AND valid_until > ? ORDER BY id DESC LIMIT 1').get(code, new Date().toISOString()) || null;
    }

    function listExtraCodes() {
        const rows = sql().prepare('SELECT * FROM wifi_portal_codes WHERE valid_until > ? ORDER BY valid_until').all(new Date().toISOString());
        return rows.map(r => ({ ...r, devices: sql().prepare(`SELECT COUNT(*) AS n FROM wifi_portal_devices WHERE kind = 'code' AND code_id = ?`).get(r.id).n }));
    }

    /** New extra code, valid for `hours` from now. Returns the row. */
    function createExtraCode({ hours, note = '', by = '' }) {
        const h = Math.min(24 * 60, Math.max(1, Math.round(Number(hours) || 24)));
        const nowIso = new Date().toISOString();
        const today = berlinToday();
        const owner = String(cfg().owner_code || '');
        for (let i = 0; i < 50; i++) {
            const code = String(100000 + crypto.randomInt(900000));
            if (owner.startsWith(code)) continue;
            if (sql().prepare(`SELECT 1 FROM bookings WHERE wifi_code = ? AND checkout >= date(?, '-2 days')`).get(code, today)) continue;
            if (sql().prepare('SELECT 1 FROM wifi_portal_codes WHERE code = ? AND valid_until > ?').get(code, nowIso)) continue;
            const until = new Date(Date.now() + h * 3600 * 1000).toISOString();
            const id = sql().prepare('INSERT INTO wifi_portal_codes (code, note, created_at, created_by, valid_until) VALUES (?, ?, ?, ?, ?)')
                .run(code, String(note || '').slice(0, 80), nowIso, String(by || '').slice(0, 60), until).lastInsertRowid;
            db.logNotification('guest_wifi', `WLAN-Code ${code} erstellt (gültig ${h} Std.)${by ? ` von ${by}` : ''}`, 'sent');
            return sql().prepare('SELECT * FROM wifi_portal_codes WHERE id = ?').get(id);
        }
        throw new Error('Kein freier Code gefunden');
    }

    /** Deletes an extra code; its devices are logged out at the router's next report. */
    function deleteExtraCode(id) {
        const row = sql().prepare('SELECT * FROM wifi_portal_codes WHERE id = ?').get(id);
        if (!row) return null;
        for (const d of sql().prepare(`SELECT mac FROM wifi_portal_devices WHERE kind = 'code' AND code_id = ?`).all(id)) queueKick(d.mac);
        sql().prepare(`DELETE FROM wifi_portal_devices WHERE kind = 'code' AND code_id = ?`).run(id);
        sql().prepare('DELETE FROM wifi_portal_codes WHERE id = ?').run(id);
        return row;
    }

    // -----------------------------------------------------------------------
    // Logging devices out: the router gets "kick=mac,…" in the answer to its report every 2 minutes
    // and runs "ndsctl deauth". Kept until the router no longer lists the device (at most 30 minutes).
    // -----------------------------------------------------------------------
    const KICK_TTL_MS = 30 * 60 * 1000;
    function kickList() {
        const list = (db.getSetting('guest_wifi_state') || {}).portal_kick;
        return list && typeof list === 'object' && !Array.isArray(list) ? list : {};
    }
    function saveKicks(list) {
        db.setSetting('guest_wifi_state', { ...(db.getSetting('guest_wifi_state') || {}), portal_kick: list });
    }
    function queueKick(mac) {
        const m = normMac(mac);
        if (m.length !== 17) return;
        saveKicks({ ...kickList(), [m]: Date.now() });
    }
    /** MACs the router should log out now; drops entries the router no longer lists as logged in. */
    function kicksFor(clients) {
        const list = kickList();
        const online = new Set(clients.map(c => c.mac));
        const now = Date.now();
        const out = [];
        let changed = false;
        for (const [mac, at] of Object.entries(list)) {
            if (!online.has(mac) || now - at > KICK_TTL_MS) { delete list[mac]; changed = true; continue; }
            out.push(mac);
        }
        if (changed) saveKicks(list);
        return out;
    }

    // -----------------------------------------------------------------------
    // Brute-force protection (all guests share one public IP behind the FRITZ!Box, so count per device and per router)
    // -----------------------------------------------------------------------
    function tooManyFailures(mac, gw) {
        const now = Date.now();
        const recent = (k, win) => (failures.get(k) || []).filter(t => now - t < win);
        return recent(`m:${mac}`, 15 * 60 * 1000).length >= 8 || recent(`g:${gw}`, 60 * 60 * 1000).length >= 40;
    }
    function noteFailure(mac, gw) {
        const now = Date.now();
        for (const k of [`m:${mac}`, `g:${gw}`]) {
            const list = (failures.get(k) || []).filter(t => now - t < 60 * 60 * 1000);
            list.push(now);
            failures.set(k, list);
        }
    }

    // -----------------------------------------------------------------------
    // Queue for authmon
    // -----------------------------------------------------------------------
    function cleanup() {
        const now = Date.now();
        for (const [gw, q] of queues) {
            for (const [rhid, e] of q) if (now - e.at > QUEUE_TTL_MS) q.delete(rhid);
            if (!q.size) queues.delete(gw);
        }
        for (const [rhid, t] of acked) if (now - t > 10 * 60 * 1000) acked.delete(rhid);
    }

    const rhidOf = fas => sha256(String(fas.hid || '').trim() + String(cfg().faskey || '').trim());

    function enqueue(fas, minutes, custom) {
        cleanup();
        const rhid = rhidOf(fas);
        const line = `${rhid} ${Math.max(1, Math.round(minutes))} 0 0 0 0 ${Buffer.from(custom).toString('base64')}`;
        const entry = { line, at: Date.now() };
        for (const gw of gatewayHashes(fas.gatewayname)) {
            if (!queues.has(gw)) queues.set(gw, new Map());
            queues.get(gw).set(rhid, entry);
        }
        acked.delete(rhid);
        return rhid;
    }

    function ack(rhid) {
        let hit = false;
        for (const q of queues.values()) if (q.delete(rhid)) hit = true;
        if (hit) acked.set(rhid, Date.now());
    }

    function noteRouter(req) {
        const now = Date.now();
        const ua = String(req.get('user-agent') || '').slice(0, 80);
        const prev = routerLive;
        routerLive = { at: now, ua };
        const st = db.getSetting('guest_wifi_state') || {};
        const stored = st.portal_router || {};
        if (!stored.at || now - stored.at > 5 * 60 * 1000 || stored.ua !== ua) {
            db.setSetting('guest_wifi_state', { ...st, portal_router: { at: now, ua, first_at: stored.first_at || now } });
        }
        return prev;
    }

    /** Handles the authmon requests (also POST from the php-cli variant). Answers text/plain. */
    function handleAuthGet(req, res) {
        res.set('Cache-Control', 'no-store').type('text/plain');
        const c = cfg();
        const p = { ...(req.query || {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
        const action = String(p.auth_get || '');
        const gw = String(p.gatewayhash || '');
        // The payload is base64; from the query string a '+' arrives as a space
        const payload = String(p.payload == null ? '' : p.payload).replace(/ /g, '+');
        if (!active() || !c.faskey || !HEX64.test(gw) || !['view', 'list', 'clear', 'deauthed', 'custom'].includes(action)) return res.send('');
        // openNDS 11 signs every request with HMAC-SHA256(faskey); older versions (10.x) send no authmac.
        // Without it only the harmless queue actions are allowed, the gateway hash comes from a random gateway name.
        const authmac = String(p.authmac || '');
        if (authmac) {
            const expect = crypto.createHmac('sha256', String(c.faskey).trim()).update(`${action}\n${gw}\n${payload}`).digest('hex');
            if (!HEX64.test(authmac) || !safeEqual(expect, authmac)) return res.send('');
        } else if (!gatewayHashes(c.gateway).includes(gw)) {
            return res.send('');
        }
        noteRouter(req);
        let decoded = '';
        try { decoded = Buffer.from(payload, 'base64').toString('utf8'); } catch (e) { decoded = ''; }

        if (action === 'custom' && /^stats1\b/.test(decoded)) {
            const clients = processStats(decoded);
            const kick = kicksFor(clients);
            const up = updateState();
            if (up.upToDate && (db.getSetting('guest_wifi_state') || {}).portal_update_now) {
                db.setSetting('guest_wifi_state', { ...(db.getSetting('guest_wifi_state') || {}), portal_update_now: null });
                up.now = false;
            }
            return res.send(`ack wifi=${powerState().on ? 'on' : 'off'}${kick.length ? ` kick=${kick.join(',')}` : ''}${up.current ? ` setup=${up.current}` : ''}${up.now ? ' now=1' : ''}`);
        }
        if (action === 'deauthed' || action === 'custom') return res.send('ack');
        if (action === 'clear') { queues.delete(gw); return res.send(''); }
        cleanup();
        const q = queues.get(gw) || new Map();
        if (action === 'view' && decoded && decoded.trim() !== 'none') {
            for (const r of decoded.trim().split(/\s+/)) if (HEX64.test(r)) ack(r);
            return res.send('ack');
        }
        const list = [...q.values()].map(e => encodeURIComponent(e.line));
        if (action === 'list') for (const r of [...q.keys()]) ack(r);
        res.send(['*', ...list].join(' '));
    }

    // -----------------------------------------------------------------------
    // Statistics from the router: "stats1 wifi=1 up=12345 clients=mac,downKB,upKB;mac,…;" every 2 minutes
    // -----------------------------------------------------------------------
    let liveStats = null; // { at, wifiOn, uptime, clients: [{ mac, down, up }] }

    function processStats(text) {
        const field = k => { const m = new RegExp(`\\b${k}=(\\S*)`).exec(text); return m ? m[1] : ''; };
        const clients = field('clients').split(';').map(x => x.split(',')).filter(x => x.length === 3)
            .map(([mac, down, up]) => ({ mac: normMac(mac), down: Math.max(0, parseInt(down, 10) || 0), up: Math.max(0, parseInt(up, 10) || 0) }))
            .filter(c => c.mac.length === 17).slice(0, 200);
        const now = new Date();
        const nowIso = now.toISOString();
        const day = berlinToday();
        let addDown = 0, addUp = 0;
        const tx = sql().transaction(() => {
            for (const c of clients) {
                const prev = sql().prepare('SELECT * FROM wifi_portal_clients WHERE mac = ?').get(c.mac);
                // counters restart with each session (and router restart): a smaller value is a new count
                const dDown = prev && c.down >= prev.last_down ? c.down - prev.last_down : c.down;
                const dUp = prev && c.up >= prev.last_up ? c.up - prev.last_up : c.up;
                sql().prepare(`INSERT INTO wifi_portal_clients (mac, last_down, last_up, last_seen) VALUES (?, ?, ?, ?)
                    ON CONFLICT(mac) DO UPDATE SET last_down = excluded.last_down, last_up = excluded.last_up, last_seen = excluded.last_seen`).run(c.mac, c.down, c.up, nowIso);
                if (!dDown && !dUp) continue;
                addDown += dDown; addUp += dUp;
                const dev = sql().prepare('SELECT id FROM wifi_portal_devices WHERE mac = ? ORDER BY last_at DESC LIMIT 1').get(c.mac);
                if (dev) sql().prepare('UPDATE wifi_portal_devices SET down_kb = down_kb + ?, up_kb = up_kb + ? WHERE id = ?').run(dDown, dUp, dev.id);
            }
            if (addDown || addUp) {
                sql().prepare(`INSERT INTO wifi_portal_usage (day, down_kb, up_kb) VALUES (?, ?, ?)
                    ON CONFLICT(day) DO UPDATE SET down_kb = down_kb + excluded.down_kb, up_kb = up_kb + excluded.up_kb`).run(day, addDown, addUp);
            }
        });
        tx();
        const ver = /^[0-9a-f]{12}$/.test(field('ver')) ? field('ver') : '';
        liveStats = { at: now.getTime(), wifiOn: field('wifi') !== '0', uptime: parseInt(field('up'), 10) || 0, clients, ver };
        const st = db.getSetting('guest_wifi_state') || {};
        const prevStats = st.portal_stats || {};
        if (!prevStats.at || now.getTime() - prevStats.at > 10 * 60 * 1000 || prevStats.wifiOn !== liveStats.wifiOn || (ver && st.portal_router_ver !== ver)) {
            db.setSetting('guest_wifi_state', { ...st, portal_stats: { at: liveStats.at, wifiOn: liveStats.wifiOn }, ...(ver ? { portal_router_ver: ver } : {}) });
        }
        return clients;
    }

    const fmtKb = kb => kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1).replace('.', ',')} GB` : kb >= 1024 ? `${Math.round(kb / 1024)} MB` : `${kb} KB`;

    function adminStats() {
        const st = db.getSetting('guest_wifi_state') || {};
        const s = liveStats || (st.portal_stats ? { ...st.portal_stats, clients: [] } : null);
        const fresh = !!(s && Date.now() - s.at < 6 * 60 * 1000);
        const today = berlinToday();
        const days = sql().prepare(`SELECT day, down_kb, up_kb FROM wifi_portal_usage WHERE day >= date(?, '-29 days') ORDER BY day`).all(today);
        const sum = rows => rows.reduce((a, r) => a + r.down_kb + r.up_kb, 0);
        const todayRow = days.find(d => d.day === today);
        const online = fresh && liveStats ? liveStats.clients.map(c => {
            const dev = sql().prepare('SELECT * FROM wifi_portal_devices WHERE mac = ? ORDER BY last_at DESC LIMIT 1').get(c.mac);
            const b = dev && dev.booking_id ? sql().prepare('SELECT * FROM bookings WHERE id = ?').get(dev.booking_id) : null;
            return { mac: c.mac, kind: dev ? deviceLabel(dev.user_agent) : 'Gerät', who: dev ? (dev.kind === 'owner' ? 'Gastgeber' : dev.kind === 'code' ? extraLabel(dev.code_id) : (guestName(b) || 'Gast')) : '?', session: fmtKb(c.down + c.up) };
        }) : [];
        // current stay: sum of its devices
        const cur = sql().prepare('SELECT * FROM bookings WHERE checkin <= ? AND checkout >= ? ORDER BY (checkout = ?) ASC, checkin ASC LIMIT 1').get(today, today, today);
        const stay = cur ? sql().prepare(`SELECT COALESCE(SUM(down_kb + up_kb), 0) AS kb, COUNT(*) AS n FROM wifi_portal_devices WHERE booking_id = ?`).get(cur.id) : null;
        const chart = [];
        for (let i = 13; i >= 0; i--) {
            const d = new Date(Date.parse(today + 'T12:00:00Z') - i * 864e5).toISOString().slice(0, 10);
            const r = days.find(x => x.day === d);
            chart.push({ day: d, kb: r ? r.down_kb + r.up_kb : 0 });
        }
        return {
            reported: s ? new Date(s.at).toISOString() : null, fresh, wifiOn: s ? s.wifiOn : null,
            onlineCount: online.length, online,
            today: fmtKb(todayRow ? todayRow.down_kb + todayRow.up_kb : 0),
            days30: fmtKb(sum(days)),
            stay: cur && stay ? { name: guestName(cur) || 'Gast', volume: fmtKb(stay.kb), devices: stay.n } : null,
            chart: chart.map(c => ({ ...c, label: fmtKb(c.kb) }))
        };
    }

    // -----------------------------------------------------------------------
    // WLAN on/off: off while nobody stays (optional), the router asks every 2 minutes
    // -----------------------------------------------------------------------
    function powerState(now = Date.now()) {
        const c = cfg();
        const ov = (db.getSetting('guest_wifi_state') || {}).portal_power;
        if (ov && ov.until && Date.parse(ov.until) > now) return { on: ov.state === 'on', reason: 'manual', until: ov.until };
        if (!c.vacant_off) return { on: true, reason: 'always' };
        const today = berlinToday();
        const rows = sql().prepare(`SELECT * FROM bookings WHERE checkin IS NOT NULL AND checkout >= date(?, '-1 day') AND checkin <= date(?, '+400 days') ORDER BY checkin`).all(today, today);
        for (const b of rows) {
            const w = windowOf(b);
            if (now >= w.from && now <= w.until) return { on: true, reason: 'guest', until: new Date(w.until).toISOString(), name: guestName(b) || 'Gast' };
        }
        const next = rows.map(b => windowOf(b)).filter(w => w.from > now).sort((a, b) => a.from - b.from)[0];
        return { on: false, reason: 'vacant', next: next ? new Date(next.from).toISOString() : null };
    }

    function setPowerOverride(mode) {
        const st = db.getSetting('guest_wifi_state') || {};
        let ov = null;
        if (mode === 'on24') ov = { state: 'on', until: new Date(Date.now() + 24 * 3600 * 1000).toISOString() };
        else if (mode === 'off24') ov = { state: 'off', until: new Date(Date.now() + 24 * 3600 * 1000).toISOString() };
        db.setSetting('guest_wifi_state', { ...st, portal_power: ov });
    }

    // -----------------------------------------------------------------------
    // Guest page API
    // -----------------------------------------------------------------------
    function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }

    function siteInfo() {
        const site = getSite();
        const c = cfg();
        const v = db.getAllSettings().vermieter || {};
        return {
            title: site.title || 'Ferienwohnung', ssid: c.ssid, maxDevices: c.max_devices, checkoutTime: site.checkout_time || '',
            phone: site.show_contact !== false ? String(v.telefon || '') : ''
        };
    }

    /** Checks the fas string from the page. Returns { fas, mac } or null. */
    function readFas(raw) {
        const fas = parseFas(raw);
        const mac = normMac(fas.clientmac);
        if (!fas.hid || !/^[0-9a-f]{64}$/i.test(fas.hid) || mac.length !== 17 || !fas.gatewayname) return null;
        return { fas, mac };
    }

    function rememberDevice({ bookingId, kind, mac, fas, ua, until, codeId = null }) {
        const now = new Date().toISOString();
        const untilIso = new Date(until).toISOString();
        const row = sql().prepare('SELECT id FROM wifi_portal_devices WHERE mac = ? AND kind = ? AND COALESCE(booking_id, 0) = COALESCE(?, 0) AND COALESCE(code_id, 0) = COALESCE(?, 0)').get(mac, kind, bookingId, codeId);
        if (row) {
            sql().prepare('UPDATE wifi_portal_devices SET ip = ?, gateway = ?, user_agent = ?, last_at = ?, until = ? WHERE id = ?')
                .run(String(fas.clientip || '').slice(0, 45), String(fas.gatewayname || '').slice(0, 80), ua, now, untilIso, row.id);
        } else {
            sql().prepare('INSERT INTO wifi_portal_devices (booking_id, kind, mac, ip, gateway, user_agent, first_at, last_at, until, code_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(bookingId, kind, mac, String(fas.clientip || '').slice(0, 45), String(fas.gatewayname || '').slice(0, 80), ua, now, now, untilIso, codeId);
        }
    }

    /** Lets a device of a booking in (device limit counted per MAC). Returns the JSON answer. */
    function admitBooking(b, f, ua, how) {
        const acc = bookingAccess(b);
        if (!acc.ok) return refusal(acc);
        const c = cfg();
        const known = devicesOf(b.id);
        if (!known.some(d => d.mac === f.mac) && known.length >= c.max_devices) {
            return { success: false, reason: 'limit', error: `Mit diesem Code sind schon ${known.length} Geräte angemeldet (höchstens ${c.max_devices}). Bitte melden Sie sich bei uns, dann schalten wir ein weiteres frei.` };
        }
        const minutes = Math.max(15, (acc.until - Date.now()) / 60000);
        const rhid = enqueue(f.fas, minutes, `booking=${b.id}`);
        rememberDevice({ bookingId: b.id, kind: 'guest', mac: f.mac, fas: f.fas, ua, until: acc.until });
        db.logNotification('guest_wifi', `WLAN-Anmeldung (${how}) für ${guestName(b) || 'Gast'} ${formatDateDE(b.checkin)} – ${formatDateDE(b.checkout)}`, 'sent');
        return { success: true, wait: rhid, name: firstName(guestName(b)), until: new Date(acc.until).toISOString(), checkout: b.checkout, welcome: welcomeFor(b), lang: guestLang.forBooking(b).lang };
    }

    /** Lets a device in with an extra code (same device limit as a booking). */
    function admitExtra(x, f, ua) {
        const c = cfg();
        const until = Date.parse(x.valid_until);
        const known = sql().prepare(`SELECT mac FROM wifi_portal_devices WHERE kind = 'code' AND code_id = ?`).all(x.id);
        if (!known.some(d => d.mac === f.mac) && known.length >= c.max_devices) {
            return { success: false, reason: 'limit', error: `Mit diesem Code sind schon ${known.length} Geräte angemeldet (höchstens ${c.max_devices}). Bitte melden Sie sich bei uns, dann schalten wir ein weiteres frei.` };
        }
        const rhid = enqueue(f.fas, Math.max(15, (until - Date.now()) / 60000), 'code');
        rememberDevice({ bookingId: null, kind: 'code', mac: f.mac, fas: f.fas, ua, until, codeId: x.id });
        return { success: true, wait: rhid, name: '', until: new Date(until).toISOString() };
    }

    /** What the page shows after the login: check-out, house rules, contact (the live tips come from api/live). */
    function welcomeFor(b) {
        const site = getSite();
        const v = db.getAllSettings().vermieter || {};
        let chat = null;
        try { chat = chatButton ? chatButton(b) : null; } catch (e) { chat = null; }
        return {
            checkout: b.checkout, checkoutTime: site.checkout_time || '',
            rules: String(site.house_rules || '').slice(0, 3000),
            whatsapp: chat && chat.url ? chat.url : '',
            phone: site.show_contact !== false ? String(v.telefon || '') : ''
        };
    }

    function refusal(acc) {
        if (acc.reason === 'early') return { success: false, reason: 'early', error: `Ihr Zugangscode gilt ab dem Anreisetag, ${formatDateDE(acc.from)}.` };
        if (acc.reason === 'over') return { success: false, reason: 'over', error: 'Ihr Aufenthalt ist beendet, der Zugangscode gilt nicht mehr. Vielen Dank für Ihren Besuch!' };
        return { success: false, reason: 'code', error: 'Dieser Code passt leider nicht. Sie finden ihn auf „Meine Buchung“, in Ihrer Anreise-Nachricht und auf dem Fernseher.' };
    }

    /** Booking of a device that was online in this stay before (same MAC, still valid). */
    function knownDevice(mac) {
        const rows = sql().prepare(`SELECT * FROM wifi_portal_devices WHERE mac = ? AND until > ? ORDER BY last_at DESC LIMIT 5`).all(mac, new Date().toISOString());
        for (const r of rows) {
            if (r.kind === 'owner') return { owner: true, row: r };
            if (r.kind === 'code') {
                const x = r.code_id ? sql().prepare('SELECT * FROM wifi_portal_codes WHERE id = ? AND valid_until > ?').get(r.code_id, new Date().toISOString()) : null;
                if (x) return { extra: x, row: r };
                continue;
            }
            const b = sql().prepare('SELECT * FROM bookings WHERE id = ?').get(r.booking_id);
            if (b && bookingAccess(b).ok) return { booking: b, row: r };
        }
        return null;
    }

    function sessionBooking(req) {
        try {
            const b = guestBooking(req.session && req.session.guest);
            return b && bookingAccess(b).ok ? b : null;
        } catch (e) { return null; }
    }

    function registerRoutes(router, { rateLimit }) {
        const pageLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'Zu viele Anfragen. Bitte kurz warten.' } });

        // The page itself and the authmon endpoint share the URL (faspath = /wlan)
        const page = (req, res) => {
            if (req.query && req.query.auth_get !== undefined) return handleAuthGet(req, res);
            if (req.body && req.body.auth_get !== undefined) return handleAuthGet(req, res);
            // openNDS (start-up check, authmon) must never see an HTTP error here, or it treats the FAS as down
            if (req.method !== 'GET' || req.path === '/wlan.') return res.set('Cache-Control', 'no-store').type('text/plain').send('ok');
            res.set('Cache-Control', 'no-store');
            res.sendFile(path.join(SITE_DIR, 'wlan.html'));
        };
        // openNDS' authmon and libopennds post their requests form-encoded (the app itself only parses JSON);
        // the start-up check fetches faspath with a trailing dot (".../wlan.")
        const form = express.urlencoded({ extended: false, limit: '64kb' });
        const text = express.text({ type: 'text/plain', limit: '64kb' });
        const parseText = (req, res, next) => {
            if (typeof req.body === 'string') { req.body = Object.fromEntries(new URLSearchParams(req.body)); }
            next();
        };
        router.all(['/wlan', '/wlan.'], form, text, parseText, (req, res, next) => {
            if (req.method === 'GET' || req.method === 'POST' || req.method === 'HEAD') return page(req, res);
            next();
        });

        // Setup script for the router (one command in the guide, protected by the setup token)
        router.get('/wlan/setup.sh', pageLimiter, (req, res) => {
            const c = cfg();
            res.set('Cache-Control', 'no-store').type('text/plain; charset=utf-8');
            if (!c.setup_token || !safeEqual(String(req.query.k || ''), c.setup_token)) {
                return res.status(403).send('echo "Dieser Einrichtungs-Link ist nicht (mehr) gültig. Bitte den Befehl neu aus dem Admin kopieren (Webseite -> WLAN)."\nexit 1\n');
            }
            if (!fasTarget()) return res.status(409).send('echo "Im Admin fehlt die öffentliche https-Adresse (Webseite -> Einrichtung)."\nexit 1\n');
            res.send(setupScript());
        });

        // What the page shows first: is this device already known, is the guest logged in to "Meine Buchung"?
        router.post('/api/wlan/hello', pageLimiter, (req, res) => {
            res.set('Cache-Control', 'no-store');
            const base = { success: true, site: siteInfo(), enabled: active() };
            if (req.body && req.body.preview) return res.json({ ...base, preview: true });
            if (req.body && req.body.status) return res.json({ ...base, online: true });
            const f = readFas(req.body && req.body.fas);
            if (!f) return res.json({ ...base, invalid: true });
            const ua = String(req.get('user-agent') || '').slice(0, 200);
            const known = active() ? knownDevice(f.mac) : null;
            if (known && known.owner) {
                const rhid = enqueue(f.fas, Math.max(15, (Date.parse(known.row.until) - Date.now()) / 60000), 'owner');
                rememberDevice({ bookingId: null, kind: 'owner', mac: f.mac, fas: f.fas, ua, until: Date.parse(known.row.until) });
                return res.json({ ...base, auto: true, wait: rhid, name: '' });
            }
            if (known && known.extra) {
                const r = admitExtra(known.extra, f, ua);
                if (r.success) return res.json({ ...base, auto: true, ...r });
            }
            if (known && known.booking) {
                const r = admitBooking(known.booking, f, ua, 'Gerät bekannt');
                if (r.success) return res.json({ ...base, auto: true, ...r });
            }
            const sb = active() ? sessionBooking(req) : null;
            res.json({ ...base, session: sb ? { name: firstName(guestName(sb)) || 'Gast', lang: guestLang.forBooking(sb).lang } : null });
        });

        router.post('/api/wlan/login', pageLimiter, (req, res) => {
            res.set('Cache-Control', 'no-store');
            if (req.body && req.body.preview) {
                const code = normCode(req.body.code);
                const site = getSite();
                const sample = { checkout: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), checkoutTime: site.checkout_time || '', rules: String(site.house_rules || ''),
                    whatsapp: (chatButton && (() => { try { const c = chatButton(null); return c && c.url; } catch (e) { return ''; } })()) || '',
                    phone: site.show_contact !== false ? String((db.getAllSettings().vermieter || {}).telefon || '') : '' };
                return res.json(code.length === 6 ? { success: true, preview: true, name: 'Anna', until: new Date(Date.now() + 3 * 864e5).toISOString(), welcome: sample }
                    : refusal({ reason: 'code' }));
            }
            if (!active()) return res.status(503).json({ success: false, error: 'Die WLAN-Anmeldung ist gerade ausgeschaltet. Bitte melden Sie sich bei uns.' });
            const f = readFas(req.body && req.body.fas);
            if (!f) return res.status(400).json({ success: false, error: 'Diese Seite muss über das WLAN geöffnet werden. Bitte die WLAN-Verbindung kurz trennen und neu verbinden.' });
            const ua = String(req.get('user-agent') || '').slice(0, 200);
            if (req.body.useSession) {
                const sb = sessionBooking(req);
                if (!sb) return res.json({ success: false, error: 'Bitte den Zugangscode eingeben.' });
                return res.json(admitBooking(sb, f, ua, 'Meine Buchung'));
            }
            const gw = sha256(f.fas.gatewayname);
            if (tooManyFailures(f.mac, gw)) return res.status(429).json({ success: false, error: 'Zu viele falsche Versuche. Bitte warten Sie 15 Minuten oder rufen Sie uns an.' });
            const code = normCode(req.body.code);
            const c = cfg();
            if (c.owner_code && code && safeEqual(code, c.owner_code)) {
                const until = Date.now() + OWNER_SESSION_MIN * 60 * 1000;
                const rhid = enqueue(f.fas, OWNER_SESSION_MIN, 'owner');
                rememberDevice({ bookingId: null, kind: 'owner', mac: f.mac, fas: f.fas, ua, until });
                db.logNotification('guest_wifi', 'WLAN-Anmeldung mit dem Gastgeber-Code', 'sent');
                return res.json({ success: true, wait: rhid, name: '', owner: true, until: new Date(until).toISOString() });
            }
            const x = extraByCode(code);
            if (x) {
                const r = admitExtra(x, f, ua);
                if (r.success) db.logNotification('guest_wifi', `WLAN-Anmeldung mit Code ${x.code}${x.note ? ` (${x.note})` : ''}`, 'sent');
                return res.json(r);
            }
            const b = bookingByCode(code);
            if (!b) { noteFailure(f.mac, gw); return res.json(refusal({ reason: 'code' })); }
            res.json(admitBooking(b, f, ua, 'Code'));
        });

        // Waiting page: has the router picked up the login?
        router.post('/api/wlan/status', pageLimiter, (req, res) => {
            res.set('Cache-Control', 'no-store');
            const rhid = String((req.body && req.body.wait) || '');
            if (!HEX64.test(rhid)) return res.json({ success: false });
            cleanup();
            if (acked.has(rhid)) return res.json({ success: true, online: true });
            const pending = [...queues.values()].some(q => q.has(rhid));
            res.json({ success: true, online: false, pending, router: routerLive ? Math.round((Date.now() - routerLive.at) / 1000) : null });
        });
    }

    // -----------------------------------------------------------------------
    // Router setup script (OpenWrt, BusyBox ash)
    // -----------------------------------------------------------------------
    function publicBase() {
        const u = String(getSite().public_url || '').replace(/\/+$/, '');
        return u;
    }
    function fasTarget() {
        const base = publicBase();
        if (!base) return null;
        try {
            const u = new URL(base);
            if (u.protocol !== 'https:') return null;
            const p = u.pathname.replace(/\/+$/, '');
            return { host: u.hostname, path: `${p}/wlan`, url: `https://${u.hostname}${p}/wlan` };
        } catch (e) { return null; }
    }

    function setupCommand() {
        const t = fasTarget();
        const c = cfg();
        if (!t || !c.setup_token) return '';
        return `wget -qO /tmp/beckhome-wlan.sh "${t.url}/setup.sh?k=${c.setup_token}" && sh /tmp/beckhome-wlan.sh`;
    }

    const shq = s => `'${String(s).replace(/'/g, `'"'"'`)}'`;

    function setupScript() {
        const c = cfg();
        const t = fasTarget();
        const lines = [
            '#!/bin/sh',
            '# Gäste-WLAN mit Anmeldeseite (OpenWrt + openNDS), erzeugt von der Ferienwohnungs-App.',
            `# Erstellt: ${new Date().toISOString()}`,
            '# Darf mehrfach ausgeführt werden, es stellt jedes Mal denselben Zustand her.',
            '',
            `SSID=${shq(c.ssid)}`,
            `WLANKEY=${shq(c.wpa)}`,
            `FASKEY=${shq(c.faskey)}`,
            `FQDN=${shq(t.host)}`,
            `FASPATH=${shq(t.path)}`,
            `GWNAME=${shq(c.gateway)}`,
            `MAXCLIENTS=${shq(Math.max(10, c.max_devices * 4))}`,
            `SETUPURL=${shq(`${t.url}/setup.sh?k=${c.setup_token}`)}`,
            ''
        ];
        // Version = hash of everything except the time stamp: the router updates itself when it differs
        const ver = sha256(lines.filter(l => !l.startsWith('# Erstellt')).join('\n') + SETUP_BODY).slice(0, 12);
        return lines.join('\n') + `SETUPVER='${ver}'\n` + SETUP_BODY;
    }

    /** Version of the setup script the server would hand out now ('' when it cannot be built). */
    function setupVersion() {
        const c = cfg();
        if (!fasTarget() || !c.setup_token || !c.faskey) return '';
        const m = /^SETUPVER='([0-9a-f]+)'$/m.exec(setupScript());
        return m ? m[1] : '';
    }

    /** Router's script version and whether an update was asked for "now" in the admin. */
    function updateState() {
        const st = db.getSetting('guest_wifi_state') || {};
        const current = setupVersion();
        const router = (liveStats && liveStats.ver) || st.portal_router_ver || '';
        const now = !!(st.portal_update_now && Date.now() - st.portal_update_now < 24 * 3600 * 1000);
        return { current, router, upToDate: !!(current && router === current), pending: !!(current && router && router !== current), now };
    }

    function requestUpdateNow() {
        db.setSetting('guest_wifi_state', { ...(db.getSetting('guest_wifi_state') || {}), portal_update_now: Date.now() });
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------
    function routerStatus() {
        const st = (db.getSetting('guest_wifi_state') || {}).portal_router || {};
        const at = routerLive ? routerLive.at : st.at || null;
        const ua = routerLive ? routerLive.ua : st.ua || '';
        const m = /NDS:([\w.-]+)/.exec(ua);
        return { lastSeen: at ? new Date(at).toISOString() : null, online: !!(at && Date.now() - at < 2 * 60 * 1000), version: m ? m[1] : '' };
    }

    function adminDevices() {
        const rows = sql().prepare(`SELECT * FROM wifi_portal_devices WHERE until > ? ORDER BY last_at DESC LIMIT 50`).all(new Date().toISOString());
        return rows.map(r => {
            const b = r.booking_id ? sql().prepare('SELECT * FROM bookings WHERE id = ?').get(r.booking_id) : null;
            return {
                id: r.id, kind: r.kind, mac: r.mac, ua: deviceLabel(r.user_agent), volume: fmtKb((r.down_kb || 0) + (r.up_kb || 0)), since: r.first_at, last: r.last_at, until: r.until,
                who: r.kind === 'owner' ? 'Gastgeber-Code' : r.kind === 'code' ? extraLabel(r.code_id) : (b ? `${guestName(b) || 'Gast'} · ${formatDateDE(b.checkin)} – ${formatDateDE(b.checkout)}` : 'Buchung gelöscht')
            };
        });
    }

    function deviceLabel(ua) {
        const s = String(ua || '');
        if (/iPhone/.test(s)) return 'iPhone';
        if (/iPad/.test(s)) return 'iPad';
        if (/Android/.test(s)) return /Mobile/.test(s) ? 'Android-Handy' : 'Android-Tablet';
        if (/Macintosh/.test(s)) return 'Mac';
        if (/Windows/.test(s)) return 'Windows-PC';
        if (/CaptiveNetworkSupport|wispr/i.test(s)) return 'Apple-Gerät';
        return 'Gerät';
    }

    function extraLabel(codeId) {
        const x = codeId ? sql().prepare('SELECT code, note FROM wifi_portal_codes WHERE id = ?').get(codeId) : null;
        return x ? `WLAN-Code ${x.code}${x.note ? ` · ${x.note}` : ''}` : 'WLAN-Code';
    }

    /** Forgets a device and logs it out on the router (at its next report, within 2 minutes). */
    function removeDevice(id) {
        const row = sql().prepare('SELECT mac FROM wifi_portal_devices WHERE id = ?').get(id);
        if (!row) return false;
        sql().prepare('DELETE FROM wifi_portal_devices WHERE id = ?').run(id);
        queueKick(row.mac);
        return true;
    }

    function adminState() {
        return {
            router: routerStatus(),
            command: setupCommand(),
            fasUrl: (fasTarget() || {}).url || '',
            publicUrlProblem: fasTarget() ? '' : (publicBase() ? 'Die öffentliche Adresse muss mit https:// beginnen.' : 'Unter Webseite → Einrichtung fehlt die öffentliche Adresse (z. B. https://beckhome.cloud).'),
            devices: adminDevices(),
            update: updateState(),
            stats: adminStats(),
            power: { ...powerState(), vacantOff: !!cfg().vacant_off }
        };
    }

    // -----------------------------------------------------------------------
    // Router watch: Telegram when it stops asking (only once it worked)
    // -----------------------------------------------------------------------
    async function watch() {
        if (!active() || !cfg().alert) return;
        const st = db.getSetting('guest_wifi_state') || {};
        const r = routerStatus();
        if (!r.lastSeen) return;
        const silentMin = (Date.now() - Date.parse(r.lastSeen)) / 60000;
        const bot = telegram && telegram.bot();
        const send = async text => {
            if (!bot) return false;
            let ok = false;
            for (const id of telegram.ids()) { try { await bot.sendMessage(id, text, { parse_mode: 'HTML' }); ok = true; } catch (e) { /* next */ } }
            return ok;
        };
        if (silentMin >= ROUTER_OFFLINE_MIN && !st.portal_alerted) {
            const ok = await send(`📶 <b>WLAN-Router meldet sich nicht</b>\nDer Router mit der Anmeldeseite hat sich seit ${Math.round(silentMin)} Minuten nicht beim Server gemeldet. Neue Gäste kommen dann nicht ins WLAN.\n\nBitte prüfen: Hat der Router Strom, steckt das Kabel zur FRITZ!Box? Notfalls den Router kurz vom Strom nehmen.`);
            if (ok) db.setSetting('guest_wifi_state', { ...(db.getSetting('guest_wifi_state') || {}), portal_alerted: new Date().toISOString() });
        } else if (silentMin < 5 && st.portal_alerted) {
            await send('📶 Der WLAN-Router ist wieder da, die Anmeldeseite funktioniert.');
            db.setSetting('guest_wifi_state', { ...(db.getSetting('guest_wifi_state') || {}), portal_alerted: null });
        }
    }

    return {
        registerRoutes, adminState, removeDevice, watch, setPowerOverride, powerState, setupCommand, setupScript, bookingAccess, windowOf,
        createExtraCode, listExtraCodes, deleteExtraCode, routerStatus, requestUpdateNow, updateState,
        _test: { processStats, adminStats, parseFas, gatewayHashes, queues, acked, berlinEpoch, enqueue, rhidOf, kicksFor, queueKick, extraByCode, handleAuthGet }
    };
}

// ---------------------------------------------------------------------------
// Body of the setup script (after the variables). BusyBox ash, works with opkg (OpenWrt 23/24) and apk (25+).
// ---------------------------------------------------------------------------
const SETUP_BODY = String.raw`
say()  { echo ""; echo "==> $*"; }
ok()   { echo "    ok: $*"; }
fail() { echo ""; echo "!!! FEHLER: $*"; echo "!!! Bitte diese Meldung abfotografieren und dem Admin schicken."; exit 1; }

[ -f /etc/openwrt_release ] || fail "Das ist kein OpenWrt-Router."
. /etc/openwrt_release
echo "Gäste-WLAN mit Anmeldeseite wird eingerichtet ($DISTRIB_DESCRIPTION)"

if command -v apk >/dev/null 2>&1; then PM=apk; else PM=opkg; fi
pm_update()  { if [ "$PM" = apk ]; then apk update; else opkg update; fi; }
pm_has()     { if [ "$PM" = apk ]; then apk info -e "$1" >/dev/null 2>&1; else opkg list-installed | grep -q "^$1 "; fi; }
pm_install() { if [ "$PM" = apk ]; then apk add "$@"; else opkg install "$@"; fi; }

# --- 1. Internet ------------------------------------------------------------
say "1/6 Internet prüfen"
FASIP=""
for i in 1 2 3 4 5 6; do
    FASIP=$(nslookup "$FQDN" 2>/dev/null | awk '/^Name/ { n=1 } n && /^Address/ && $NF ~ /^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$/ { print $NF; exit }')
    [ -n "$FASIP" ] && break
    sleep 5
done
[ -n "$FASIP" ] || fail "Der Router kommt nicht ins Internet. Steckt das Kabel von der FRITZ!Box im blauen WAN-Anschluss des Routers?"
ok "$FQDN = $FASIP"

WANIP=$(ubus call network.interface.wan status 2>/dev/null | jsonfilter -e '@["ipv4-address"][0].address' 2>/dev/null)
[ -n "$WANIP" ] && ok "Router-Adresse im FRITZ!Box-Netz: $WANIP"

# Gäste-Netz: 192.168.50.x, außer die FRITZ!Box nutzt das schon
GNET=192.168.50
case "$WANIP" in 192.168.50.*) GNET=192.168.150 ;; esac
LANIP=$(uci -q get network.lan.ipaddr)
case "$WANIP" in 192.168.1.*)
    if [ "$LANIP" = "192.168.1.1" ]; then
        uci set network.lan.ipaddr='192.168.2.1'
        echo "    Hinweis: Die FRITZ!Box nutzt 192.168.1.x, der Router ist am Kabel-Anschluss künftig unter 192.168.2.1 erreichbar."
    fi ;;
esac

# --- 2. Pakete ----------------------------------------------------------------
say "2/6 Programme installieren (openNDS, dnsmasq-full) - dauert 1-2 Minuten"
pm_update >/dev/null 2>&1 || pm_update || fail "Paketliste konnte nicht geladen werden."
pm_has ca-bundle || pm_install ca-bundle >/dev/null 2>&1
pm_has opennds || pm_install opennds || fail "openNDS konnte nicht installiert werden."
ok "openNDS installiert"

if ! pm_has dnsmasq-full; then
    # Erst herunterladen, dann tauschen: ohne dnsmasq hat der Router kurz kein DNS.
    rm -rf /tmp/bh-pkg && mkdir -p /tmp/bh-pkg && cd /tmp/bh-pkg || fail "/tmp nicht beschreibbar"
    if [ "$PM" = apk ]; then apk fetch -o /tmp/bh-pkg dnsmasq-full >/dev/null 2>&1; else opkg download dnsmasq-full >/dev/null 2>&1; fi
    PKG=$(ls /tmp/bh-pkg/dnsmasq-full* 2>/dev/null | head -1)
    [ -n "$PKG" ] || fail "dnsmasq-full konnte nicht geladen werden."
    UP=$(grep nameserver /tmp/resolv.conf.d/resolv.conf.auto 2>/dev/null | head -2)
    [ -n "$UP" ] || UP="nameserver 1.1.1.1"
    rm -f /tmp/resolv.conf; echo "$UP" > /tmp/resolv.conf
    if [ "$PM" = apk ]; then apk del dnsmasq >/dev/null 2>&1; apk add "$PKG" >/dev/null 2>&1 || apk add dnsmasq-full >/dev/null 2>&1
    else opkg remove dnsmasq >/dev/null 2>&1; opkg install "$PKG" >/dev/null 2>&1 || opkg install dnsmasq-full >/dev/null 2>&1; fi
    if ! pm_has dnsmasq-full; then
        pm_install dnsmasq >/dev/null 2>&1
        /etc/init.d/dnsmasq restart
        fail "dnsmasq-full konnte nicht installiert werden (der normale dnsmasq ist wieder drauf)."
    fi
    cd /
    ok "dnsmasq-full installiert"
else
    ok "dnsmasq-full war schon da"
fi

# --- 3. Netz für Gäste --------------------------------------------------------
say "3/6 Gäste-Netz anlegen ($GNET.0/24)"
uci set system.@system[0].hostname='Gaeste-WLAN'
uci set system.@system[0].zonename='Europe/Berlin'
uci set system.@system[0].timezone='CET-1CEST,M3.5.0,M10.5.0/3'

uci set network.gaeste_dev=device
uci set network.gaeste_dev.type='bridge'
uci set network.gaeste_dev.name='br-gaeste'
uci set network.gaeste_dev.bridge_empty='1'
uci set network.gaeste=interface
uci set network.gaeste.proto='static'
uci set network.gaeste.device='br-gaeste'
uci set network.gaeste.ipaddr="$GNET.1"
uci set network.gaeste.netmask='255.255.255.0'

uci set dhcp.gaeste=dhcp
uci set dhcp.gaeste.interface='gaeste'
uci set dhcp.gaeste.start='100'
uci set dhcp.gaeste.limit='150'
uci set dhcp.gaeste.leasetime='12h'

uci set firewall.gaeste_zone=zone
uci set firewall.gaeste_zone.name='gaeste'
uci -q delete firewall.gaeste_zone.network
uci add_list firewall.gaeste_zone.network='gaeste'
uci set firewall.gaeste_zone.input='REJECT'
uci set firewall.gaeste_zone.output='ACCEPT'
uci set firewall.gaeste_zone.forward='REJECT'
uci set firewall.gaeste_fwd=forwarding
uci set firewall.gaeste_fwd.src='gaeste'
uci set firewall.gaeste_fwd.dest='wan'
uci set firewall.gaeste_dns=rule
uci set firewall.gaeste_dns.name='Gaeste DNS+DHCP+Portal'
uci set firewall.gaeste_dns.src='gaeste'
uci -q delete firewall.gaeste_dns.dest_port
uci add_list firewall.gaeste_dns.dest_port='53'
uci add_list firewall.gaeste_dns.dest_port='67'
uci add_list firewall.gaeste_dns.dest_port='68'
uci add_list firewall.gaeste_dns.dest_port='2050'
uci set firewall.gaeste_dns.proto='tcp udp'
uci set firewall.gaeste_dns.target='ACCEPT'
# Gäste kommen nicht ins Heimnetz der FRITZ!Box (und an kein anderes privates Netz)
uci set firewall.gaeste_privat=rule
uci set firewall.gaeste_privat.name='Gaeste nicht ins Heimnetz'
uci set firewall.gaeste_privat.src='gaeste'
uci set firewall.gaeste_privat.dest='wan'
uci -q delete firewall.gaeste_privat.dest_ip
uci add_list firewall.gaeste_privat.dest_ip='10.0.0.0/8'
uci add_list firewall.gaeste_privat.dest_ip='172.16.0.0/12'
uci add_list firewall.gaeste_privat.dest_ip='192.168.0.0/16'
uci add_list firewall.gaeste_privat.dest_ip='169.254.0.0/16'
uci set firewall.gaeste_privat.proto='all'
uci set firewall.gaeste_privat.target='REJECT'
ok "Netz, DHCP und Firewall"

# --- 4. WLAN --------------------------------------------------------------------
say "4/6 WLAN \"$SSID\" einrichten"
RADIOS=$(uci -q show wireless | sed -n "s/^wireless\.\([^.=]*\)=wifi-device$/\1/p")
[ -n "$RADIOS" ] || fail "Kein WLAN-Funkmodul gefunden."
for s in $(uci -q show wireless | sed -n "s/^wireless\.\([^.=]*\)=wifi-iface$/\1/p"); do
    case "$s" in gaeste_*) ;; *) uci set wireless.$s.disabled='1' ;; esac
done
for r in $RADIOS; do
    uci set wireless.$r.disabled='0'
    uci set wireless.$r.country='DE'
    uci set wireless.gaeste_$r=wifi-iface
    uci set wireless.gaeste_$r.device="$r"
    uci set wireless.gaeste_$r.mode='ap'
    uci set wireless.gaeste_$r.network='gaeste'
    uci set wireless.gaeste_$r.ssid="$SSID"
    uci set wireless.gaeste_$r.disabled='0'
    if [ -n "$WLANKEY" ]; then
        uci set wireless.gaeste_$r.encryption='psk2'
        uci set wireless.gaeste_$r.key="$WLANKEY"
    else
        uci set wireless.gaeste_$r.encryption='none'
        uci -q delete wireless.gaeste_$r.key
    fi
done
ok "WLAN auf: $(echo $RADIOS)"

# --- 5. openNDS -----------------------------------------------------------------
say "5/6 Anmeldeseite (openNDS) einstellen"
S=$(uci -q show opennds | sed -n "s/^opennds\.\([^.=]*\)=opennds$/\1/p" | head -1)
[ -n "$S" ] || S=$(uci add opennds opennds)
O="opennds.$S"
uci set $O.enabled='1'
uci set $O.debuglevel='1'
uci set $O.gatewayinterface='br-gaeste'
uci set $O.gatewayname="$GWNAME"
uci set $O.enable_serial_number_suffix='0'
uci set $O.login_option_enabled='0'
uci set $O.fasport='443'
uci set $O.fasremotefqdn="$FQDN"
uci set $O.fasremoteip="$FASIP"
uci set $O.faspath="$FASPATH"
uci set $O.fas_secure_enabled='4'
uci set $O.faskey="$FASKEY"
uci set $O.maxclients="$MAXCLIENTS"
uci set $O.preauthidletimeout='30'
uci set $O.authidletimeout='720'
uci set $O.sessiontimeout='1440'
uci -q delete $O.walledgarden_fqdn_list
uci -q delete $O.walledgarden_port_list
uci add_list $O.walledgarden_fqdn_list="$FQDN fonts.googleapis.com fonts.gstatic.com"
uci add_list $O.walledgarden_port_list='443'
uci -q delete $O.authenticated_users
# Private Netze sperrt schon die Firewall-Zone oben. openNDS 10.x mit nftables verliert bei
# 'block to <Netz>' die Adresse und sperrt dann alles, darum hier nur 'allow all'.
uci add_list $O.authenticated_users='allow all'
ok "openNDS mit $FQDN$FASPATH"

# Alle 2 Minuten: Geräte + Datenvolumen an den Server melden, WLAN nach dessen Antwort an/aus (Leerstand).
# Ohne Antwort bleibt (bzw. geht) das WLAN an, damit Gäste nie ohne Netz dastehen.
cat > /usr/bin/beckhome-wlan-sync <<'SYNC'
#!/bin/sh
CL=$(ndsctl json 2>/dev/null | tr ',{}' '\n\n\n' | awk -F'"' '/"mac":/ { m=$4 } /"state":/ { s=$4 } /"download_this_session":/ { d=$4 } /"upload_this_session":/ { if (s=="Authenticated") printf "%s,%s,%s;", m, d, $4 }')
ON=1
[ "$(uci -q get wireless.gaeste_radio0.disabled)" = "1" ] && ON=0
UP=$(cut -d. -f1 /proc/uptime)
SETUPURL=''; SETUPVER=''
[ -f /etc/beckhome-wlan.conf ] && . /etc/beckhome-wlan.conf
R=$(/usr/lib/opennds/libopennds.sh send_to_fas_custom "stats1 wifi=$ON up=$UP ver=$SETUPVER clients=$CL" 2>/dev/null)
# Neues Einrichtungs-Skript auf dem Server: nachts (3-5 Uhr), sobald kein Gast online ist oder wenn im Admin
# "Jetzt aktualisieren" gedrückt wurde. Pro Version und Tag nur ein Versuch.
NEW=$(echo "$R" | sed -n 's/.*setup=\([0-9a-f]*\).*/\1/p')
if [ -n "$NEW" ] && [ -n "$SETUPURL" ] && [ "$NEW" != "$SETUPVER" ] && [ ! -e /tmp/bh-setup.lock ] \
   && [ "$(cat /tmp/bh-setup.tried 2>/dev/null)" != "$NEW-$(date +%j)" ]; then
    H=$(TZ='CET-1CEST,M3.5.0,M10.5.0/3' date +%H)
    case "$R" in *now=1*) H=03 ;; esac
    if [ -z "$CL" ] || [ "$H" = 03 ] || [ "$H" = 04 ]; then
        echo "$NEW-$(date +%j)" > /tmp/bh-setup.tried
        touch /tmp/bh-setup.lock
        logger -t beckhome "Router-Skript wird aktualisiert ($SETUPVER -> $NEW)"
        ( if wget -qO /tmp/bh-setup.sh "$SETUPURL" && sh /tmp/bh-setup.sh > /tmp/bh-setup.log 2>&1; then
              logger -t beckhome "Router-Skript aktualisiert"
          else
              logger -t beckhome "Router-Skript-Update fehlgeschlagen, siehe /tmp/bh-setup.log"
          fi
          rm -f /tmp/bh-setup.lock ) </dev/null >/dev/null 2>&1 &
        exit 0
    fi
fi
# Im Admin gelöschte Geräte abmelden
for m in $(echo "$R" | sed -n 's/.*kick=\([0-9a-f:,]*\).*/\1/p' | tr ',' ' '); do
    ndsctl deauth "$m" >/dev/null 2>&1 && logger -t beckhome "Gerät $m abgemeldet"
done
WANT=1
case "$R" in *wifi=off*) WANT=0 ;; esac
[ "$WANT" = "$ON" ] && exit 0
for s in $(uci -q show wireless | sed -n "s/^wireless\.\(gaeste_[^.=]*\)=wifi-iface$/\1/p"); do
    uci set wireless.$s.disabled=$((1 - WANT))
done
uci commit wireless
wifi reload
if [ "$WANT" = 1 ]; then logger -t beckhome "Gaeste-WLAN an"; else logger -t beckhome "Gaeste-WLAN aus (Leerstand)"; fi
SYNC
chmod +x /usr/bin/beckhome-wlan-sync
touch /etc/crontabs/root
grep -v beckhome-wlan-sync /etc/crontabs/root > /tmp/bh-cron; echo "*/2 * * * * /usr/bin/beckhome-wlan-sync" >> /tmp/bh-cron
cat /tmp/bh-cron > /etc/crontabs/root; rm -f /tmp/bh-cron
/etc/init.d/cron enable >/dev/null 2>&1
ok "Meldung an den Server alle 2 Minuten (Geräte, Datenvolumen, WLAN an/aus)"

# --- 6. Übernehmen ----------------------------------------------------------------
say "6/6 Einstellungen übernehmen und neu starten"
uci commit
/etc/init.d/system reload >/dev/null 2>&1
/etc/init.d/network reload
sleep 3
wifi reload
/etc/init.d/firewall reload >/dev/null 2>&1
/etc/init.d/dnsmasq restart
sleep 2
/etc/init.d/opennds enable
/etc/init.d/opennds restart
/etc/init.d/cron restart >/dev/null 2>&1
sleep 12
if ndsctl status >/dev/null 2>&1; then
    ok "openNDS läuft"
else
    fail "openNDS ist nicht gestartet. Bitte 'logread | grep -i opennds' ausführen und die Ausgabe schicken."
fi

# Für das automatische Update: woher das Skript kommt und welche Version jetzt läuft
umask 077
printf "SETUPURL='%s'\nSETUPVER='%s'\n" "$SETUPURL" "$SETUPVER" > /etc/beckhome-wlan.conf
grep -q '^/etc/beckhome-wlan.conf$' /etc/sysupgrade.conf 2>/dev/null || echo /etc/beckhome-wlan.conf >> /etc/sysupgrade.conf
ok "Automatische Updates eingeschaltet (Version $SETUPVER)"

echo ""
echo "============================================================"
echo " FERTIG! WLAN \"$SSID\" ist an."
echo " Mit dem Handy verbinden: die Anmeldeseite öffnet sich."
echo " Im Admin unter Webseite -> WLAN steht in ca. 1 Minute"
echo " \"Router verbunden\"."
echo "============================================================"
`;

module.exports = createWifiPortal;
module.exports.parseFas = parseFas;
module.exports.gatewayHashes = gatewayHashes;
module.exports.berlinEpoch = berlinEpoch;
