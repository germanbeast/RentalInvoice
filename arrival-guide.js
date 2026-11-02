/**
 * Anfahrts-Assistent: am Anreisetag bekommt der Gast Route, Parkhinweis, Türcode und den Ablauf zum Öffnen der Haustür
 *
 *  - The host keeps the texts and photos in Webseite → Ankunft (setting 'arrival_guide'): a note for the last metres,
 *    parking (empty = the text from the guest folder), a description of the house door and the steps to open it.
 *    A step may contain {code}, it becomes the guest's door code.
 *  - On the arrival day at the set time (default 10:00, the door codes work from 11:00) the message goes out through
 *    the guest chat: WhatsApp if the number has WhatsApp, else SMS, else e-mail (e.g. the Booking.com address).
 *    Without any way to reach the guest, the host gets the finished text in Telegram to paste into Booking.com / Airbnb.
 *    Failed sends are retried three times every 15 minutes, then the host gets the text too.
 *  - "Meine Buchung" shows the same as tab "Ankunft" with the photos. The photos are only served to a guest
 *    with a running booking (the door is not shown to the public).
 *  - The message links to /b/<token>/ankunft (direct link without login, see guest-message.js).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PHOTO_DIR = path.join(__dirname, 'uploads', 'site');
const PHOTO_RE = /^arr-\d+-[a-f0-9]{8}\.(jpe?g|png|webp)$/;
const MAX_STEPS = 10;
const MAX_ATTEMPTS = 3;
const RETRY_MIN = 15;

const DEFAULTS = {
    auto_send: false,
    send_time: '10:00',
    notify_host: true,
    route_note: '',     // last metres / sat nav hint
    parking: '',        // empty = site.parking
    parking_photo: '',
    door_text: '',      // how to find the house door
    door_photo: '',
    steps: []           // [{ text, photo }]
};

function createArrivalGuide({ express, rateLimit, db, multer, botLogic, getSite, guestBooking, guestMessage, emergencyDoor, guestChat, wifiFor, telegram, push, berlinToday, formatDateDE }) {
    const sql = () => db.getDb();

    const cols = sql().prepare('PRAGMA table_info(bookings)').all().map(c => c.name);
    const addCol = (name, type) => {
        if (!cols.includes(name)) sql().exec(`ALTER TABLE bookings ADD COLUMN ${name} ${type}`);
    };
    addCol('arrival_sent_at', 'TEXT');
    addCol('arrival_channel', 'TEXT');   // wa | sms | mail | telegram (host got the text to paste)
    addCol('arrival_attempts', 'INTEGER DEFAULT 0');
    addCol('arrival_last_try', 'TEXT');
    addCol('arrival_error', 'TEXT');
    addCol('arrival_for', 'TEXT');       // arrival date the state above belongs to (a moved booking starts over)

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------
    function getConfig() {
        const s = db.getSetting('arrival_guide');
        const c = s && typeof s === 'object' ? s : {};
        return { ...DEFAULTS, ...c, steps: Array.isArray(c.steps) ? c.steps : [] };
    }

    const photoOk = f => (typeof f === 'string' && PHOTO_RE.test(f) && fs.existsSync(path.join(PHOTO_DIR, f))) ? f : '';

    function save(inp) {
        const str = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').slice(0, max).trim();
        const cur = getConfig();
        const time = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(inp.send_time || '')) ? String(inp.send_time).padStart(5, '0') : cur.send_time;
        const c = {
            auto_send: !!inp.auto_send,
            send_time: time,
            notify_host: inp.notify_host !== false,
            route_note: str(inp.route_note, 1000),
            parking: str(inp.parking, 1000),
            parking_photo: photoOk(inp.parking_photo),
            door_text: str(inp.door_text, 1500),
            door_photo: photoOk(inp.door_photo),
            steps: (Array.isArray(inp.steps) ? inp.steps : []).slice(0, MAX_STEPS)
                .map(s => ({ text: str(s && s.text, 500), photo: photoOk(s && s.photo) }))
                .filter(s => s.text || s.photo)
        };
        db.setSetting('arrival_guide', c);
        cleanupPhotos(c);
        return c;
    }

    /** Deletes uploaded arrival photos that are no longer used (uploads of the last hour stay: not saved yet). */
    function cleanupPhotos(c = getConfig()) {
        const used = new Set(usedPhotos(c));
        let files = [];
        try { files = fs.readdirSync(PHOTO_DIR); } catch (e) { return; }
        const hourAgo = Date.now() - 60 * 60 * 1000;
        for (const f of files) {
            if (!PHOTO_RE.test(f) || used.has(f)) continue;
            const ts = Number(f.split('-')[1]);
            if (ts < hourAgo) fs.unlink(path.join(PHOTO_DIR, f), () => { });
        }
    }

    const usedPhotos = c => [c.parking_photo, c.door_photo, ...c.steps.map(s => s.photo)].filter(Boolean);

    function hasContent(c = getConfig(), site = getSite()) {
        return !!(site.address || c.route_note || c.parking || site.parking || c.door_text || c.steps.length);
    }

    const routeUrl = addr => addr ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}` : '';
    const withCode = (text, pin, fallback) => String(text || '').replace(/\{\s*(code|türcode|pin)\s*\}/gi, pin || fallback);

    // -----------------------------------------------------------------------
    // Guest view ("Meine Buchung" → Ankunft)
    // -----------------------------------------------------------------------
    /** Arrival data for a booking view; pin = the code the page may show (null before pin_days). */
    function guestView(b, pin) {
        const c = getConfig();
        const site = getSite();
        if (!b || !hasContent(c, site)) return null;
        const img = f => f ? `api/me/ankunft/bild/${encodeURIComponent(f)}` : null;
        return {
            address: site.address || '',
            routeUrl: routeUrl(site.address),
            routeNote: c.route_note,
            parking: c.parking || site.parking || '',
            parkingPhoto: img(c.parking_photo),
            door: c.door_text,
            doorPhoto: img(c.door_photo),
            steps: c.steps.map(s => ({ text: withCode(s.text, pin, '(Ihr Türcode)'), photo: img(s.photo) })),
            emergency: !!(emergencyDoor && emergencyDoor.getConfig().enabled)
        };
    }

    // -----------------------------------------------------------------------
    // Message text
    // -----------------------------------------------------------------------
    const TEXT = {
        de: {
            hello: n => (n ? `Hallo ${n},` : 'Hallo,'),
            intro: t => `heute ist dein Anreisetag, wir freuen uns auf dich! 🚗 Hier ist alles für eine entspannte Ankunft.${t ? ` Einchecken kannst du ab ${t} Uhr.` : ''}`,
            address: 'Adresse', route: 'Route', parking: 'Parken', door: 'Haustür',
            pin: p => `🔑 Dein Türcode: ${p}`,
            wifi: (n, p) => `📶 WLAN: ${n}${p ? `\nPasswort: ${p}` : ''}`,
            wifiOwn: (t, l) => `Das Passwort gilt nur für deinen Aufenthalt${t ? `, ab ${t} Uhr` : ''}.${l ? ' Unter dem Link unten gibt es dazu einen QR-Code zum Scannen.' : ''}`,
            nopin: '(dein Türcode)',
            steps: 'So öffnest du die Tür:',
            photos: '📸 Alle Schritte mit Fotos:',
            emergency: 'Falls das Tastenfeld nicht reagiert, kannst du die Tür hier öffnen:',
            contact: p => (p ? `Bei Fragen erreichst du uns jederzeit hier oder unter ${p}.` : 'Bei Fragen erreichst du uns jederzeit hier.'),
            bye: 'Gute Fahrt!'
        },
        en: {
            hello: n => (n ? `Hi ${n},` : 'Hi,'),
            intro: t => `today is your arrival day, we are looking forward to welcoming you! 🚗 Here is everything for a smooth arrival.${t ? ` Check-in is from ${t}.` : ''}`,
            address: 'Address', route: 'Route', parking: 'Parking', door: 'Front door',
            pin: p => `🔑 Your door code: ${p}`,
            wifi: (n, p) => `📶 Wi-Fi: ${n}${p ? `\nPassword: ${p}` : ''}`,
            wifiOwn: (t, l) => `The password is valid for your stay only${t ? `, from ${t}` : ''}.${l ? ' The page linked below also has a QR code to scan.' : ''}`,
            nopin: '(your door code)',
            steps: 'How to open the door:',
            photos: '📸 All steps with photos:',
            emergency: 'If the keypad does not respond, you can open the door here:',
            contact: p => (p ? `If you have any questions, just message us here or call ${p}.` : 'If you have any questions, just message us here.'),
            bye: 'Safe travels!'
        }
    };

    function firstName(name) {
        const n = String(name || '').trim();
        if (!n) return '';
        if (n.includes(',')) return n.split(',')[1].trim().split(/\s+/)[0] || n.split(',')[0].trim();
        return n.split(/\s+/)[0];
    }

    /** English when the Meldeschein says the guest is not German (the texts the host types stay as they are). */
    function langFor(b) {
        try {
            const r = sql().prepare('SELECT data FROM guest_registrations WHERE booking_id = ?').get(b.id);
            const d = r && JSON.parse(r.data || '{}');
            const nat = String((d && d.nationality) || '').trim();
            if (nat && !/^(deutsch(land)?|germany|german|de|d|brd|österreich|oesterreich|austria|österreichisch|schweiz|switzerland|schweizerisch)$/i.test(nat)) return 'en';
        } catch (e) { /* no Meldeschein table yet */ }
        return 'de';
    }

    /** { text, warnings, lang } for a booking, null if it does not exist. */
    function compose(bookingId, lang) {
        const b = sql().prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        if (!b) return null;
        lang = TEXT[lang] ? lang : langFor(b);
        const L = TEXT[lang];
        const c = getConfig();
        const site = getSite();
        const settings = db.getAllSettings();
        const host = settings.vermieter || {};
        const guest = b.guest_id ? db.getGuestById(b.guest_id) : null;
        const name = guest && !botLogic.isPlaceholderGuestName(guest.name) ? guest.name : '';
        const warnings = [];

        let link = '', emergencyLink = '';
        const base = site.public_url ? String(site.public_url).replace(/\/+$/, '') : '';
        if (base && site.enabled !== false && b.checkout >= berlinToday()) {
            const token = guestMessage.ensureLink(b.id);
            if (token) {
                link = `${base}/b/${token}/ankunft`;
                if (emergencyDoor && emergencyDoor.getConfig().enabled) emergencyLink = `${base}/b/${token}/notfall`;
            }
        } else if (!base) warnings.push('Ohne öffentliche Adresse der Webseite fehlt der Link zu den Fotos.');
        if (!b.nuki_pin) warnings.push('Für diese Buchung ist kein Türcode angelegt.');
        if (!hasContent(c, site)) warnings.push('Unter Webseite → Ankunft ist noch nichts eingetragen.');

        const lines = [L.hello(firstName(name)), '', L.intro(site.checkin_time || '')];
        if (site.address) {
            lines.push('', `📍 ${L.address}: ${site.address}`, `🧭 ${L.route}: ${routeUrl(site.address)}`);
            if (c.route_note) lines.push(c.route_note);
        } else if (c.route_note) lines.push('', `🧭 ${c.route_note}`);
        const parking = c.parking || site.parking;
        if (parking) lines.push('', `🅿️ ${L.parking}: ${parking}`);
        if (c.door_text) lines.push('', `🚪 ${L.door}: ${c.door_text}`);
        if (b.nuki_pin) lines.push('', L.pin(b.nuki_pin));
        if (c.steps.some(s => s.text)) {
            lines.push('', L.steps);
            c.steps.filter(s => s.text).forEach((s, i) => lines.push(`${i + 1}. ${withCode(s.text, b.nuki_pin, L.nopin)}`));
        }
        const wifi = wifiFor ? wifiFor(b) : null;
        if (wifi && wifi.name) {
            lines.push('', L.wifi(wifi.name, wifi.password));
            if (wifi.personal) lines.push(L.wifiOwn(wifi.switchTime, !!link));
        }
        if (link) lines.push('', L.photos, link);
        if (emergencyLink) lines.push('', L.emergency, emergencyLink);
        lines.push('', L.contact(host.telefon || ''), L.bye);
        const sign = host.name || site.title;
        if (sign) lines.push(sign);
        // SMS: short and without emoji (one emoji makes every part 70 instead of 160 characters)
        const P = lang === 'en'
            ? { hi: n => `Hi ${n || 'there'}, today is your arrival day!`, addr: 'Address', code: 'Door code', link: 'Directions, parking and how to open the door, with photos', ask: 'Questions' }
            : { hi: n => `Hallo ${n || ''}, heute ist dein Anreisetag!`.replace('Hallo ,', 'Hallo,'), addr: 'Adresse', code: 'Türcode', link: 'Anfahrt, Parken und wie du die Haustür öffnest, mit Fotos', ask: 'Fragen' };
        const sms = [P.hi(firstName(name))];
        if (site.address) sms.push(`${P.addr}: ${site.address}.`);
        if (b.nuki_pin) sms.push(`${P.code}: ${b.nuki_pin}.`);
        if (wifi && wifi.name) sms.push(`${lang === 'en' ? 'Wi-Fi' : 'WLAN'}: ${wifi.name}${wifi.password ? ` / ${wifi.password}` : ''}`);
        if (link) sms.push(`${P.link}: ${link}`);
        else {
            if (parking) sms.push(`${L.parking}: ${parking}`);
            if (c.door_text) sms.push(`${L.door}: ${c.door_text}`);
            c.steps.filter(s => s.text).forEach((s, i) => sms.push(`${i + 1}. ${withCode(s.text, b.nuki_pin, L.nopin)}`));
        }
        if (host.telefon) sms.push(`${P.ask}: ${host.telefon}`);
        if (sign) sms.push(sign);
        return { text: lines.join('\n'), smsText: sms.join('\n'), warnings, lang, name, booking: b };
    }

    // -----------------------------------------------------------------------
    // Sending
    // -----------------------------------------------------------------------
    const CH_NAME = { wa: 'WhatsApp', sms: 'SMS', mail: 'E-Mail', telegram: 'Telegram (zum Weiterleiten)' };
    const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const guestLabel = (m) => `${m.name || 'Gast'} (${formatDateDE(m.booking.checkin)} – ${formatDateDE(m.booking.checkout)}${m.booking.source ? `, ${m.booking.source === 'manual' ? 'Direkt' : m.booking.source}` : ''})`;

    async function tellHost(html, plain) {
        const bot = telegram.bot();
        let sent = false;
        if (bot) {
            for (const id of telegram.ids()) {
                try { await bot.sendMessage(id, html, { parse_mode: 'HTML', disable_web_page_preview: true }); sent = true; } catch (e) { console.error('❌ Anfahrt Telegram:', e.message); }
            }
        }
        if (push) { try { await push.send(plain, 'arrival_guide', { url: '/?view=website' }); } catch (e) { /* optional */ } }
        return sent;
    }

    /**
     * Sends the arrival message for a booking. Returns { channel, text } or throws.
     * fallback: when no channel works, the host gets the text in Telegram (channel 'telegram').
     */
    async function sendFor(bookingId, { author = 'Anfahrts-Assistent', fallback = true, quiet = false, auto = false } = {}) {
        const m = compose(bookingId);
        if (!m) throw new Error('Buchung nicht gefunden.');
        const c = getConfig();
        sql().prepare('UPDATE bookings SET arrival_for = checkin WHERE id = ?').run(bookingId);
        if (auto) sql().prepare("UPDATE bookings SET arrival_attempts = COALESCE(arrival_attempts, 0) + 1, arrival_last_try = datetime('now') WHERE id = ?").run(bookingId);
        let result;
        try {
            result = await guestChat.sendToBooking(bookingId, m.text, { author, smsText: m.smsText });
        } catch (e) {
            const b = sql().prepare('SELECT arrival_attempts FROM bookings WHERE id = ?').get(bookingId);
            const giveUp = e.noChannel || !auto || (b && b.arrival_attempts >= MAX_ATTEMPTS);
            sql().prepare('UPDATE bookings SET arrival_error = ? WHERE id = ?').run(String(e.message).slice(0, 500), bookingId);
            if (!fallback || !giveUp) throw e;
            const html = `🚗 <b>Anfahrts-Infos für ${escHtml(guestLabel(m))}</b>\nAutomatisch senden ging nicht: ${escHtml(e.message)}\n\nBitte über Booking.com / Airbnb weiterleiten (antippen kopiert):\n\n<pre>${escHtml(m.text)}</pre>`;
            const ok = await tellHost(html, `🚗 Anfahrts-Infos für ${m.name || 'Gast'} bitte von Hand weiterleiten`);
            if (!ok) throw Object.assign(new Error(`${e.message} · Telegram ist auch nicht eingerichtet`), { noChannel: e.noChannel });
            sql().prepare("UPDATE bookings SET arrival_sent_at = datetime('now'), arrival_channel = 'telegram' WHERE id = ?").run(bookingId);
            db.logNotification('arrival_guide', `Anfahrts-Infos für ${m.name || 'Gast'} an Telegram (von Hand weiterleiten): ${e.message}`, 'sent');
            return { channel: 'telegram', text: m.text, error: e.message, warnings: m.warnings };
        }
        sql().prepare("UPDATE bookings SET arrival_sent_at = datetime('now'), arrival_channel = ?, arrival_error = NULL WHERE id = ?").run(result.channel, bookingId);
        db.logNotification('arrival_guide', `Anfahrts-Infos an ${m.name || 'Gast'} per ${CH_NAME[result.channel]}`, 'sent');
        if (c.notify_host && !quiet) {
            const warn = m.warnings.length ? `\n⚠️ ${m.warnings.map(escHtml).join('\n⚠️ ')}` : '';
            await tellHost(`🚗 Anfahrts-Infos an <b>${escHtml(guestLabel(m))}</b> per ${CH_NAME[result.channel]} gesendet.${warn}`,
                `🚗 Anfahrts-Infos an ${m.name || 'Gast'} per ${CH_NAME[result.channel]} gesendet`);
        }
        return { channel: result.channel, text: m.text, warnings: m.warnings };
    }

    function berlinTime() {
        return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    }

    let running = false;
    /** Called every 5 minutes: today's arrivals after the send time that have not got the message. */
    async function tick() {
        const c = getConfig();
        // Booking moved to another arrival day: send again on the new day
        sql().prepare(`UPDATE bookings SET arrival_sent_at = NULL, arrival_channel = NULL, arrival_attempts = 0, arrival_last_try = NULL, arrival_error = NULL, arrival_for = NULL
            WHERE arrival_for IS NOT NULL AND arrival_for != checkin`).run();
        if (!c.auto_send || running) return;
        if (berlinTime() < c.send_time) return;
        running = true;
        try {
            const due = sql().prepare(`
                SELECT id FROM bookings
                WHERE checkin = ? AND arrival_sent_at IS NULL
                  AND COALESCE(arrival_attempts, 0) < ?
                  AND (arrival_last_try IS NULL OR arrival_last_try <= datetime('now', ?))
            `).all(berlinToday(), MAX_ATTEMPTS, `-${RETRY_MIN - 1} minutes`);
            for (const { id } of due) {
                try {
                    const r = await sendFor(id, { auto: true });
                    console.log(`🚗 Anfahrts-Infos für Buchung ${id} per ${r.channel}`);
                } catch (e) {
                    console.warn(`⚠️ Anfahrts-Infos für Buchung ${id} nicht gesendet:`, e.message);
                }
            }
        } finally { running = false; }
    }

    function startScheduler() {
        setTimeout(() => tick().catch(() => { }), 90 * 1000).unref();
        setInterval(() => tick().catch(() => { }), 5 * 60 * 1000).unref();
    }

    function upcoming() {
        return sql().prepare(`
            SELECT b.id, b.checkin, b.checkout, b.source, b.nuki_pin, b.arrival_sent_at, b.arrival_channel, b.arrival_error, b.arrival_attempts, g.name AS guest_name
            FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
            WHERE b.checkin IS NOT NULL AND b.checkout >= ? AND b.checkin <= date(?, '+30 days')
            ORDER BY b.checkin ASC LIMIT 20
        `).all(berlinToday(), berlinToday()).map(r => ({
            id: r.id, checkin: r.checkin, checkout: r.checkout, source: r.source === 'manual' ? 'Direkt' : r.source,
            name: r.guest_name && !botLogic.isPlaceholderGuestName(r.guest_name) ? r.guest_name : '',
            hasPin: !!r.nuki_pin, sentAt: r.arrival_sent_at, channel: r.arrival_channel, error: r.arrival_error, attempts: r.arrival_attempts || 0
        }));
    }

    // -----------------------------------------------------------------------
    // Public routes (/gast): photos only for a guest with a running booking
    // -----------------------------------------------------------------------
    const router = express.Router();
    const imgLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });

    router.get('/api/me/ankunft/bild/:file', imgLimiter, (req, res) => {
        const file = path.basename(String(req.params.file));
        const b = guestBooking(req.session && req.session.guest);
        if (!b || b.checkout < berlinToday() || !usedPhotos(getConfig()).includes(file)) return res.status(404).end();
        res.set('Cache-Control', 'private, max-age=3600');
        res.sendFile(path.join(PHOTO_DIR, file));
    });

    // -----------------------------------------------------------------------
    // Admin routes
    // -----------------------------------------------------------------------
    const upload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => cb(null, PHOTO_DIR),
            filename: (req, file, cb) => cb(null, `arr-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase().replace('.jpeg', '.jpg')}`)
        }),
        limits: { fileSize: 8 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            const ok = /\.(jpe?g|png|webp)$/i.test(file.originalname) && /^image\/(jpeg|png|webp)$/.test(file.mimetype);
            cb(ok ? null : new Error('Nur Bilder (JPEG, PNG, WebP) erlaubt'), ok);
        }
    });

    function adminState() {
        const site = getSite();
        return {
            config: getConfig(), upcoming: upcoming(), today: berlinToday(),
            site: { address: site.address || '', parking: site.parking || '', checkin_time: site.checkin_time, public_url: site.public_url || '' },
            emergency: !!(emergencyDoor && emergencyDoor.getConfig().enabled),
            channels: guestChat.channelStatus()
        };
    }

    function registerAdminRoutes(app, apiLimiter) {
        app.get('/api/site/arrival', apiLimiter, (req, res) => res.json({ success: true, ...adminState() }));

        app.put('/api/site/arrival', apiLimiter, (req, res) => {
            save((req.body && req.body.arrival) || {});
            res.json({ success: true, ...adminState() });
        });

        app.post('/api/site/arrival/photo', apiLimiter, (req, res) => {
            upload.single('photo')(req, res, err => {
                if (err) return res.status(400).json({ success: false, error: err.message });
                if (!req.file) return res.status(400).json({ success: false, error: 'Keine Datei' });
                res.json({ success: true, file: req.file.filename });
            });
        });

        app.get('/api/site/arrival/photo/:file', apiLimiter, (req, res) => {
            const file = path.basename(String(req.params.file));
            if (!PHOTO_RE.test(file)) return res.status(404).end();
            res.sendFile(path.join(PHOTO_DIR, file), err => { if (err && !res.headersSent) res.status(404).end(); });
        });

        app.get('/api/site/arrival/preview/:id', apiLimiter, (req, res) => {
            const m = compose(parseInt(req.params.id, 10), req.query.lang);
            if (!m) return res.status(404).json({ success: false, error: 'Buchung nicht gefunden' });
            res.json({ success: true, text: m.text, warnings: m.warnings, lang: m.lang });
        });

        app.post('/api/site/arrival/send/:id', apiLimiter, async (req, res) => {
            const id = parseInt(req.params.id, 10);
            const who = req.session && req.session.user && (req.session.user.username || req.session.user.name);
            try {
                const r = await sendFor(id, { author: who || 'Admin', fallback: !!(req.body && req.body.telegram), quiet: true });
                res.json({ success: true, channel: r.channel, channelName: CH_NAME[r.channel], warnings: r.warnings, upcoming: upcoming() });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message, noChannel: !!e.noChannel, upcoming: upcoming() });
            }
        });
    }

    return { router, registerAdminRoutes, guestView, compose, sendFor, tick, startScheduler, getConfig, save, _test: { withCode, langFor, berlinTime } };
}

module.exports = createArrivalGuide;
