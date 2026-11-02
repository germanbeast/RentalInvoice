/**
 * WLAN für Gäste: eigenes WLAN-Passwort pro Buchung ("WLAN-Voucher") über die FRITZ!Box, oder ein festes Passwort.
 *
 *  - Mode 'static': the guest network name and password from Webseite → Inhalte (as before), now also with QR code,
 *    in the arrival message and on the TV.
 *  - Mode 'fritzbox': every booking gets its own easy-to-type password (e.g. "Sonne-Wald-4827", column
 *    bookings.wifi_password). Each day at the switch time (default: check-out time) the server sets the guest WLAN
 *    of the FRITZ!Box (TR-064, see fritzbox.js) to the password of the booking that stays the coming night. Without
 *    a guest a random password is set (optionally the guest WLAN is switched off), so the previous guest is out.
 *    The box is checked every hour; when it cannot be reached the host gets the password per Telegram to set it by hand.
 *  - The guest sees network, password and a QR code (scan = connect) in "Meine Buchung" from the arrival day,
 *    in the arrival message, and on the TV welcome screen while staying.
 *
 * Settings: 'guest_wifi' (config incl. FRITZ!Box login, server only), 'guest_wifi_state' (what the box has now).
 */

const crypto = require('crypto');
const { createFritzBox } = require('./fritzbox');

const DEFAULTS = {
    mode: 'static',          // static | fritzbox
    show_tv: true,           // network + password + QR on the TV welcome screen while a guest stays
    show_arrival: true,      // in the arrival message
    switch_time: '',         // HH:MM, empty = check-out time of the website
    vacant_disable: false,   // switch the guest WLAN off when nobody stays
    notify: true,            // Telegram when switching fails (and when it works again)
    fritz: { url: '', user: '', password: '', insecure: false, index: 0 }
};
const MASK = '••••••••';
const CHECK_EVERY_MIN = 60;

const WORDS = ['Sonne', 'Wolke', 'Regen', 'Stern', 'Mond', 'Nebel', 'Wald', 'Berg', 'Fluss', 'Bach', 'Wiese', 'Insel', 'Hafen', 'Segel',
    'Anker', 'Apfel', 'Birne', 'Kirsche', 'Pflaume', 'Honig', 'Zimt', 'Kakao', 'Brezel', 'Kuchen', 'Garten', 'Rose', 'Tulpe', 'Linde',
    'Ahorn', 'Tanne', 'Birke', 'Eiche', 'Fuchs', 'Hase', 'Igel', 'Biber', 'Adler', 'Falke', 'Eule', 'Otter', 'Dachs', 'Hirsch', 'Kater',
    'Laterne', 'Kerze', 'Kompass', 'Brunnen', 'Muschel', 'Welle', 'Strand', 'Burg', 'Turm', 'Bruecke', 'Feder', 'Wolle', 'Sommer', 'Winter'];

function generatePassword() {
    const w = () => WORDS[crypto.randomInt(WORDS.length)];
    let a = w(), b = w();
    while (b === a) b = w();
    const digits = Array.from({ length: 4 }, () => String(2 + crypto.randomInt(8))).join(''); // 2–9, no 0/O 1/l
    return `${a}-${b}-${digits}`;
}

const randomSecret = () => crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 24);

/** Text for a "join this WLAN" QR code (understood by the iPhone and Android cameras). */
function wifiQrText(ssid, password) {
    const e = s => String(s || '').replace(/([\\;,:"])/g, '\\$1');
    return password ? `WIFI:T:WPA;S:${e(ssid)};P:${e(password)};;` : `WIFI:T:nopass;S:${e(ssid)};;`;
}

/** SVG of a QR code, synchronous (one path, dark modules). */
function qrSvg(qrcode, text) {
    const q = qrcode.create(text, { errorCorrectionLevel: 'M' });
    const n = q.modules.size;
    const m = 2;
    let d = '';
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) if (q.modules.get(y, x)) d += `M${x + m} ${y + m}h1v1h-1z`;
    }
    const s = n + 2 * m;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges"><rect width="${s}" height="${s}" style="fill:#fff;stroke:none"/><path style="fill:#000;stroke:none" d="${d}"/></svg>`;
}

function createWifi({ db, axios, qrcode, botLogic, getSite, telegram, berlinToday, addDays, formatDateDE }) {
    const sql = () => db.getDb();
    const cols = sql().prepare('PRAGMA table_info(bookings)').all().map(c => c.name);
    if (!cols.includes('wifi_password')) sql().exec('ALTER TABLE bookings ADD COLUMN wifi_password TEXT');

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------
    function getConfig() {
        const s = db.getSetting('guest_wifi');
        const c = s && typeof s === 'object' ? s : {};
        return { ...DEFAULTS, ...c, fritz: { ...DEFAULTS.fritz, ...(c.fritz || {}) } };
    }
    function getState() {
        const s = db.getSetting('guest_wifi_state');
        return s && typeof s === 'object' ? s : {};
    }
    const setState = patch => { const s = { ...getState(), ...patch }; db.setSetting('guest_wifi_state', s); return s; };

    const fritzReady = (c = getConfig()) => c.mode === 'fritzbox' && !!(c.fritz.url && c.fritz.user && c.fritz.password);

    function save(inp) {
        const cur = getConfig();
        const f = inp.fritz || {};
        const time = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(inp.switch_time || '')) ? String(inp.switch_time).padStart(5, '0') : '';
        const url = String(f.url || '').trim().replace(/\/+$/, '').slice(0, 200);
        const c = {
            mode: inp.mode === 'fritzbox' ? 'fritzbox' : 'static',
            show_tv: inp.show_tv !== false,
            show_arrival: inp.show_arrival !== false,
            switch_time: time,
            vacant_disable: !!inp.vacant_disable,
            notify: inp.notify !== false,
            fritz: {
                url: url && !/^https?:\/\//i.test(url) ? `https://${url}` : url,
                user: String(f.user || '').trim().slice(0, 100),
                password: f.password === MASK ? cur.fritz.password : String(f.password || '').slice(0, 200),
                insecure: !!f.insecure,
                index: [0, 1, 2, 3, 4].includes(Number(f.index)) ? Number(f.index) : 0
            }
        };
        const loginChanged = c.fritz.url !== cur.fritz.url || c.fritz.user !== cur.fritz.user || c.fritz.password !== cur.fritz.password || c.fritz.index !== cur.fritz.index;
        db.setSetting('guest_wifi', c);
        if (loginChanged) setState({ prefix: null, index: null, last_check: null });
        return c;
    }

    function publicConfig(c = getConfig()) {
        return { ...c, fritz: { ...c.fritz, password: c.fritz.password ? MASK : '' } };
    }

    // -----------------------------------------------------------------------
    // Who has the WLAN now
    // -----------------------------------------------------------------------
    function berlinTime() {
        return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    }
    const switchTime = (c = getConfig()) => c.switch_time || getSite().checkout_time || '11:00';

    /** The night that counts now: from the switch time on the coming night, before it the past night. */
    function nightNow(c = getConfig()) {
        const today = berlinToday();
        return berlinTime() >= switchTime(c) ? today : addDays(today, -1);
    }

    /** Booking that has the WLAN in the night starting on date d (null = nobody). */
    function bookingForNight(d) {
        return sql().prepare('SELECT * FROM bookings WHERE checkin IS NOT NULL AND checkout IS NOT NULL AND checkin <= ? AND checkout > ? ORDER BY checkin DESC LIMIT 1').get(d, d) || null;
    }

    function ensurePassword(bookingId) {
        const r = sql().prepare('SELECT wifi_password FROM bookings WHERE id = ?').get(bookingId);
        if (!r) return '';
        if (r.wifi_password) return r.wifi_password;
        const pw = generatePassword();
        sql().prepare('UPDATE bookings SET wifi_password = ? WHERE id = ? AND wifi_password IS NULL').run(pw, bookingId);
        return sql().prepare('SELECT wifi_password FROM bookings WHERE id = ?').get(bookingId).wifi_password;
    }

    function ssid(c = getConfig()) {
        const site = getSite();
        if (c.mode === 'fritzbox') return getState().ssid || site.wifi_name || 'Gäste-WLAN';
        return site.wifi_name || '';
    }

    /** What the box should have now: { key, bookingId, password } */
    function desired(c = getConfig()) {
        const b = bookingForNight(nightNow(c));
        if (b) return { key: `b:${b.id}`, bookingId: b.id, password: ensurePassword(b.id), booking: b };
        const st = getState();
        const pw = st.applied_for === 'vacant' && st.applied_password ? st.applied_password : (st.vacant_password || randomSecret());
        if (st.vacant_password !== pw) setState({ vacant_password: pw });
        return { key: 'vacant', bookingId: null, password: pw, booking: null };
    }

    // -----------------------------------------------------------------------
    // Guest views
    // -----------------------------------------------------------------------
    const withQr = (name, password) => ({ name, password, qr: qrSvg(qrcode, wifiQrText(name, password)) });

    /**
     * WLAN block for "Meine Buchung" (null = nothing to show).
     * Fritz mode: the own password from the arrival day until the check-out day, before that only a hint.
     */
    function guestView(b) {
        const c = getConfig();
        const site = getSite();
        if (c.mode !== 'fritzbox') return site.wifi_name ? { ...withQr(site.wifi_name, site.wifi_password || ''), personal: false } : null;
        if (!fritzReady(c) || !b) return site.wifi_name ? { ...withQr(site.wifi_name, site.wifi_password || ''), personal: false } : null;
        const today = berlinToday();
        if (b.checkout < today) return null;
        const name = ssid(c);
        const st = switchTime(c);
        if (b.checkin > today) return { name, password: '', later: true, from: b.checkin, personal: true, switchTime: st };
        return { ...withQr(name, ensurePassword(b.id)), personal: true, from: b.checkin, until: b.checkout, switchTime: st };
    }

    /** For the arrival message on the arrival day: { name, password } or null. */
    function arrivalView(b) {
        const c = getConfig();
        if (!c.show_arrival || !b) return null;
        if (c.mode === 'fritzbox' && fritzReady(c)) return { name: ssid(c), password: ensurePassword(b.id), personal: true, switchTime: switchTime(c) };
        const site = getSite();
        return site.wifi_name ? { name: site.wifi_name, password: site.wifi_password || '', personal: false } : null;
    }

    /** For the TV welcome screen: only while a guest stays (fritz mode), null = keep the WLAN box neutral. */
    function tvView() {
        const c = getConfig();
        if (!c.show_tv) return null;
        if (c.mode === 'fritzbox' && fritzReady(c)) {
            const d = desired(c);
            if (!d.bookingId) return null;
            return withQr(ssid(c), d.password);
        }
        const site = getSite();
        return site.wifi_name ? withQr(site.wifi_name, site.wifi_password || '') : null;
    }

    // -----------------------------------------------------------------------
    // Switching the FRITZ!Box
    // -----------------------------------------------------------------------
    function fritz(c = getConfig()) {
        const st = getState();
        return createFritzBox(axios, { ...c.fritz, prefix: st.prefix != null ? st.prefix : null });
    }

    async function guestIndex(fb, c) {
        if (c.fritz.index) return c.fritz.index;
        const st = getState();
        if (st.index) return st.index;
        const list = await fb.listWlans();
        const idx = list[list.length - 1].index;
        setState({ index: idx, prefix: fb.prefix });
        return idx;
    }

    const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    async function tellHost(html) {
        const bot = telegram && telegram.bot();
        if (!bot) return false;
        let sent = false;
        for (const id of telegram.ids()) {
            try { await bot.sendMessage(id, html, { parse_mode: 'HTML', disable_web_page_preview: true }); sent = true; } catch (e) { console.error('❌ WLAN Telegram:', e.message); }
        }
        return sent;
    }

    function guestName(b) {
        if (!b) return '';
        const g = b.guest_id ? db.getGuestById(b.guest_id) : null;
        return g && !botLogic.isPlaceholderGuestName(g.name) ? g.name : '';
    }
    const label = d => d.booking ? `${guestName(d.booking) || 'Gast'} (${formatDateDE(d.booking.checkin)} – ${formatDateDE(d.booking.checkout)})` : 'Leerstand';

    let running = null;
    /**
     * Brings the box to the wanted password. force: also when the state says it is already set.
     * Returns { changed, key, ssid } or throws.
     */
    async function apply({ force = false } = {}) {
        if (running) return running;
        running = (async () => {
            const c = getConfig();
            if (!fritzReady(c)) throw new Error('FRITZ!Box ist nicht eingerichtet');
            const d = desired(c);
            const st = getState();
            const same = st.applied_for === d.key && st.applied_password === d.password;
            const checkDue = !st.last_check || Date.now() - Date.parse(st.last_check) > CHECK_EVERY_MIN * 60 * 1000;
            if (same && !force && !checkDue) return { changed: false, key: d.key };
            const fb = fritz(c);
            try {
                const idx = await guestIndex(fb, c);
                const info = await fb.getInfo(idx);
                let changed = false;
                const now = await fb.getPassword(idx);
                if (now !== d.password) { await fb.setPassword(d.password, idx); changed = true; }
                const wantOn = !(d.key === 'vacant' && c.vacant_disable);
                if (info.enabled !== wantOn) { await fb.setEnabled(wantOn, idx); changed = true; }
                const hadError = !!st.error;
                setState({
                    ssid: info.ssid || st.ssid || '', index: idx, prefix: fb.prefix, enabled: wantOn,
                    applied_for: d.key, applied_password: d.password, applied_at: changed || !same ? new Date().toISOString() : st.applied_at,
                    last_check: new Date().toISOString(), error: null, error_at: null, alerted_for: null
                });
                if (changed) {
                    const what = d.bookingId ? `WLAN-Passwort für ${label(d)} gesetzt` : (wantOn ? 'Gast-WLAN zwischen zwei Gästen auf Zufallspasswort gestellt' : 'Gast-WLAN ausgeschaltet (niemand da)');
                    db.logNotification('guest_wifi', what, 'sent');
                    console.log(`📶 ${what}`);
                }
                if (hadError && c.notify) await tellHost('📶 FRITZ!Box ist wieder erreichbar, das Gast-WLAN ist richtig eingestellt.');
                return { changed, key: d.key, ssid: info.ssid };
            } catch (e) {
                const msg = String(e.message || e).slice(0, 300);
                setState({ error: msg, error_at: new Date().toISOString(), last_check: new Date().toISOString() });
                if (c.notify && st.alerted_for !== d.key && (!same || !st.error)) {
                    const pwLine = d.bookingId
                        ? `Bitte in der FRITZ!Box unter WLAN → Gastzugang das Passwort von Hand setzen:\n<code>${escHtml(d.password)}</code>\n(für ${escHtml(label(d))})`
                        : 'Zwischen zwei Gästen sollte das Gast-WLAN ein neues Passwort bekommen. Bitte von Hand ändern, damit der letzte Gast nicht mehr im WLAN ist.';
                    const ok = await tellHost(`📶 <b>Gast-WLAN konnte nicht umgestellt werden</b>\n${escHtml(msg)}\n\n${pwLine}\n\nIch versuche es alle 5 Minuten weiter.`);
                    if (ok) setState({ alerted_for: d.key });
                }
                throw e;
            }
        })();
        try { return await running; } finally { running = null; }
    }

    async function tick() {
        if (!fritzReady()) return;
        try { await apply(); } catch (e) { console.warn('⚠️ Gast-WLAN:', e.message); }
    }

    function startScheduler() {
        setTimeout(() => tick(), 60 * 1000).unref();
        setInterval(() => tick(), 5 * 60 * 1000).unref();
    }

    /** New password for a booking; when it has the WLAN right now the box is switched at once. */
    async function renew(bookingId) {
        const pw = generatePassword();
        const r = sql().prepare('UPDATE bookings SET wifi_password = ? WHERE id = ?').run(pw, bookingId);
        if (!r.changes) throw new Error('Buchung nicht gefunden');
        let applied = null;
        if (fritzReady() && desired().bookingId === bookingId) applied = await apply({ force: true });
        return { password: pw, applied };
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------
    function upcoming() {
        const today = berlinToday();
        const c = getConfig();
        const d = fritzReady(c) ? desired(c) : null;
        return sql().prepare(`
            SELECT b.id, b.checkin, b.checkout, b.source, b.wifi_password, b.guest_id
            FROM bookings b
            WHERE b.checkin IS NOT NULL AND b.checkout >= ? AND b.checkin <= date(?, '+60 days')
            ORDER BY b.checkin ASC LIMIT 20
        `).all(today, today).map(r => ({
            id: r.id, checkin: r.checkin, checkout: r.checkout,
            source: r.source === 'manual' ? 'Direkt' : (r.source || ''),
            name: guestName(r),
            password: r.wifi_password || ensurePassword(r.id),
            active: !!(d && d.bookingId === r.id)
        }));
    }

    function adminState() {
        const c = getConfig();
        const st = getState();
        const d = fritzReady(c) ? desired(c) : null;
        return {
            config: publicConfig(c),
            state: {
                ssid: st.ssid || '', index: st.index || null, enabled: st.enabled, appliedAt: st.applied_at || null, lastCheck: st.last_check || null,
                error: st.error || null, errorAt: st.error_at || null,
                inSync: !!(d && st.applied_for === d.key && st.applied_password === d.password && !st.error),
                now: d ? { vacant: !d.bookingId, name: d.bookingId ? label(d) : '' } : null
            },
            switchTime: switchTime(c),
            ready: fritzReady(c),
            site: { wifi_name: getSite().wifi_name || '', has_password: !!getSite().wifi_password, checkout_time: getSite().checkout_time || '' },
            upcoming: upcoming()
        };
    }

    function registerAdminRoutes(app, apiLimiter) {
        app.get('/api/site/wifi', apiLimiter, (req, res) => res.json({ success: true, ...adminState() }));

        app.put('/api/site/wifi', apiLimiter, async (req, res) => {
            save((req.body && req.body.wifi) || {});
            // switch right away when the box is set up, errors show up in the state
            if (fritzReady()) { try { await apply({ force: true }); } catch (e) { /* in state */ } }
            res.json({ success: true, ...adminState() });
        });

        // Test with the values from the form (mask = stored password), nothing is saved or changed on the box
        app.post('/api/site/wifi/test', apiLimiter, async (req, res) => {
            const f = (req.body && req.body.fritz) || {};
            const cur = getConfig();
            let url = String(f.url || '').trim().replace(/\/+$/, '');
            if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
            try {
                const fb = createFritzBox(axios, {
                    url, user: String(f.user || '').trim(), insecure: !!f.insecure,
                    password: f.password === MASK ? cur.fritz.password : String(f.password || '')
                });
                const wlans = await fb.listWlans();
                res.json({ success: true, wlans, guestIndex: wlans[wlans.length - 1].index, path: fb.prefix });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message });
            }
        });

        app.post('/api/site/wifi/apply', apiLimiter, async (req, res) => {
            try {
                const r = await apply({ force: true });
                res.json({ success: true, changed: r.changed, ...adminState() });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message, ...adminState() });
            }
        });

        app.post('/api/site/wifi/renew/:id', apiLimiter, async (req, res) => {
            try {
                const r = await renew(parseInt(req.params.id, 10));
                res.json({ success: true, password: r.password, applied: !!r.applied, ...adminState() });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message, ...adminState() });
            }
        });

        app.get('/api/site/wifi/qr', apiLimiter, (req, res) => {
            const c = getConfig();
            const id = parseInt(req.query.booking, 10);
            let name = ssid(c), pw = getSite().wifi_password || '';
            if (id && c.mode === 'fritzbox') pw = ensurePassword(id);
            res.type('image/svg+xml').send(qrSvg(qrcode, wifiQrText(name, pw)));
        });
    }

    return {
        registerAdminRoutes, startScheduler, tick, apply, renew, guestView, arrivalView, tvView, getConfig, save, desired,
        _test: { nightNow, bookingForNight, berlinTime }
    };
}

module.exports = createWifi;
module.exports.generatePassword = generatePassword;
module.exports.wifiQrText = wifiQrText;
module.exports.qrSvg = qrSvg;
