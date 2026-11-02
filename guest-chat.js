/**
 * Gäste-Chat: WhatsApp und SMS mit Gästen im Admin ("Nachrichten")
 *
 *  - Guests write to the paired WhatsApp number (whatsapp-web.js, the same account the admin commands use).
 *    Messages from numbers that are not admin users land here instead of being ignored.
 *  - SMS go through an Android phone with the free app "SMS Gateway for Android" (sms-gate.app):
 *    sending via its local server (phone in the home network) or its cloud server, incoming SMS via webhook
 *    to /gast/sms-hook/<secret> (the app needs an https address for that, usually the site's public address).
 *  - Every conversation is keyed by the guest's phone number (digits with country code, e.g. 4917612345678).
 *    It is linked to a booking automatically: guest code in the text (BH-XXXXXX), else the phone number stored
 *    with the guest, a booking request or a Meldeschein. The host can change the link by hand.
 *  - Before the first WhatsApp message to a number, it is checked whether the number exists on WhatsApp
 *    (getNumberId). Without WhatsApp the admin switches to SMS; nothing is sent blindly.
 *  - New guest messages go to Telegram (reply to the Telegram message to answer the guest) and to Web Push.
 *  - Messages and pictures are deleted 13 months after the last message of a conversation (data economy).
 *  - E-Mail, mainly for Booking.com guests: Booking.com gives every guest an alias address
 *    (e.g. name.123456@guest.booking.com) and forwards mails sent to it from the property's registered address.
 *    The address is not in the calendar feed, so the host enters it by hand (per conversation or when starting one).
 *    Sending uses the SMTP access from Einstellungen → E-Mail. Replies are read from the mailbox by IMAP
 *    (optional, polled every 2 minutes, read-only: nothing is moved, deleted or marked as read).
 *    Mail conversations are keyed 'mail:<address>' unless the address belongs to an existing conversation.
 *  - Settings live in the server-only setting 'guest_chat' (never in /api/settings), the SMS and IMAP passwords are masked.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const MEDIA_DIR = path.join(__dirname, 'uploads', 'chat');
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 4000;
const SMS_MAX_TEXT = 1530; // 10 concatenated parts
const CODE_RE = /\bBH-?([A-Z0-9]{6})\b/i;
const MASK = '••••••••';
const MAIL_POLL_MS = 2 * 60 * 1000;
const MAIL_MAX_PER_POLL = 50;
// Senders that are never a guest (Booking.com confirmations, newsletters, bounces)
const MAIL_SYSTEM_RE = /^(no-?reply|noreply|do-?not-?reply|donotreply|mailer-daemon|postmaster|customer[._-]?service|info|news|newsletter|marketing|notifications?|reservations?)([.+_-]|$)/i;
const MEDIA_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4' };

const DEFAULTS = {
    enabled: true,
    show_button: true,       // "Per WhatsApp schreiben" on the guest site and on "Meine Buchung"
    wa_number: '',           // shown to guests; empty = number of the paired WhatsApp account
    notify_telegram: true,
    notify_push: true,
    sms: {
        enabled: false,
        mode: 'cloud',       // 'cloud' (api.sms-gate.app) | 'local' (http://<phone>:8080)
        url: '',             // local: base address of the phone; cloud: empty = https://api.sms-gate.app
        username: '',
        password: '',
        sim: '',             // SIM slot 1/2, empty = default
        hook_base: '',       // address the phone calls for incoming SMS, empty = public address of the site
        secret: ''           // part of the webhook address
    },
    mail: {
        enabled: true,       // E-Mail as a channel (sending needs the SMTP access in Einstellungen → E-Mail)
        imap_enabled: false, // read guest replies from the mailbox
        host: '',
        port: 993,
        user: '',            // empty = SMTP user
        password: '',        // empty = SMTP password
        folder: 'INBOX'
    }
};

/** Lowercase e-mail address, '' when it does not look like one. Accepts "Name <a@b.de>". */
function normEmail(raw) {
    let s = String(raw || '').trim();
    const m = s.match(/<([^>]+)>/);
    if (m) s = m[1];
    s = s.replace(/^mailto:/i, '').trim().toLowerCase();
    return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/.test(s) && s.length <= 200 ? s : '';
}

/** Only the new part of a reply: cut at the quoted older mail or Booking.com's reply marker. */
function stripQuoted(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const cut = [
        /^\s*##-/,                                                  // Booking.com: "##- Bitte geben Sie Ihre Antwort oberhalb dieser Zeile ein -##"
        /^\s*-{2,}\s*(Original|Ursprüngliche)/i,
        /^\s*_{5,}\s*$/,
        /^\s*(Am|On|Le|El|Il|Op)\s.{4,200}(schrieb|wrote|a écrit|escribió|ha scritto|schreef)\s*.*:\s*$/i,
        /^\s*(Von|From):\s.+/,
        /^\s*>/
    ];
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        // "Am Mo., 1. Nov. 2026 um 10:00 schrieb" is often wrapped onto two lines
        const two = l + ' ' + (lines[i + 1] || '');
        if (cut.some(re => re.test(l)) || (/^\s*(Am|On)\s/.test(l) && cut[3].test(two))) break;
        out.push(l);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Digits with country code. German numbers without country code get 49. '' when it does not look like a number. */
function normPhone(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    s = s.replace(/@.*$/, '');
    let d = s.replace(/[^\d]/g, '');
    if (!d) return '';
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.startsWith('0')) d = '49' + d.slice(1);
    if (d.length < 8 || d.length > 15) return '';
    return d;
}

function createGuestChat({ imap, mailParser, express, rateLimit, db, botLogic, getSite, berlinToday, guestMessage, push, wa, telegram, formatDateDE }) {
    const sql = () => db.getDb();
    if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

    sql().exec(`
        CREATE TABLE IF NOT EXISTS guest_chat_contacts (
            conv TEXT PRIMARY KEY,
            phone TEXT,
            name TEXT,
            wa_chat TEXT,
            booking_id INTEGER,
            booking_fixed INTEGER DEFAULT 0,
            last_channel TEXT,
            last_at DATETIME,
            wa_status TEXT,
            wa_checked_at DATETIME,
            email TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS guest_chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conv TEXT NOT NULL,
            channel TEXT NOT NULL,
            direction TEXT NOT NULL,
            body TEXT,
            media TEXT,
            media_type TEXT,
            ext_id TEXT,
            author TEXT,
            status TEXT,
            error TEXT,
            read_at DATETIME,
            subject TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_guest_chat_conv ON guest_chat_messages(conv, id);
        CREATE TABLE IF NOT EXISTS guest_chat_tg (
            tg_chat TEXT NOT NULL,
            tg_msg INTEGER NOT NULL,
            conv TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (tg_chat, tg_msg)
        );
    `);

    const contactCols = sql().prepare('PRAGMA table_info(guest_chat_contacts)').all().map(c => c.name);
    if (!contactCols.includes('wa_status')) sql().exec('ALTER TABLE guest_chat_contacts ADD COLUMN wa_status TEXT');
    if (!contactCols.includes('wa_checked_at')) sql().exec('ALTER TABLE guest_chat_contacts ADD COLUMN wa_checked_at DATETIME');
    if (!contactCols.includes('email')) sql().exec('ALTER TABLE guest_chat_contacts ADD COLUMN email TEXT');
    const msgCols = sql().prepare('PRAGMA table_info(guest_chat_messages)').all().map(c => c.name);
    if (!msgCols.includes('subject')) sql().exec('ALTER TABLE guest_chat_messages ADD COLUMN subject TEXT');
    sql().exec('CREATE INDEX IF NOT EXISTS idx_guest_chat_email ON guest_chat_contacts(email)');

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------
    function getConfig() {
        const s = db.getSetting('guest_chat');
        const c = s && typeof s === 'object' ? s : {};
        const cfg = { ...DEFAULTS, ...c, sms: { ...DEFAULTS.sms, ...(c.sms || {}) }, mail: { ...DEFAULTS.mail, ...(c.mail || {}) } };
        if (!cfg.sms.secret) {
            cfg.sms.secret = crypto.randomBytes(18).toString('base64url');
            db.setSetting('guest_chat', cfg);
        }
        return cfg;
    }

    function publicConfig() {
        const c = getConfig();
        return { ...c, sms: { ...c.sms, password: c.sms.password ? MASK : '', secret: undefined }, mail: { ...c.mail, password: c.mail.password ? MASK : '' } };
    }

    function saveConfig(inp) {
        const old = getConfig();
        const s = inp.sms || {};
        const ml = inp.mail || {};
        const str = (v, n) => String(v == null ? '' : v).trim().substring(0, n);
        const url = str(s.url, 200).replace(/\/+$/, '');
        const hook = str(s.hook_base, 200).replace(/\/+$/, '');
        const cfg = {
            enabled: inp.enabled !== false,
            show_button: inp.show_button !== false,
            wa_number: normPhone(inp.wa_number),
            notify_telegram: inp.notify_telegram !== false,
            notify_push: inp.notify_push !== false,
            sms: {
                enabled: !!s.enabled,
                mode: s.mode === 'local' ? 'local' : 'cloud',
                url: /^https?:\/\/[^\s]+$/i.test(url) ? url : '',
                username: str(s.username, 80),
                password: s.password === MASK ? old.sms.password : str(s.password, 120),
                sim: ['1', '2', '3'].includes(String(s.sim)) ? String(s.sim) : '',
                hook_base: /^https?:\/\/[^\s]+$/i.test(hook) ? hook : '',
                secret: old.sms.secret
            },
            mail: {
                enabled: ml.enabled !== false,
                imap_enabled: !!ml.imap_enabled,
                host: str(ml.host, 120).replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, ''),
                port: Math.min(65535, Math.max(1, parseInt(ml.port, 10) || 993)),
                user: str(ml.user, 120),
                password: ml.password === MASK ? old.mail.password : str(ml.password, 200),
                folder: str(ml.folder, 120) || 'INBOX'
            }
        };
        const changedBox = ['host', 'user', 'folder'].some(k => cfg.mail[k] !== old.mail[k]);
        db.setSetting('guest_chat', cfg);
        if (changedBox) db.setSetting('guest_chat_mail_state', null); // other mailbox: start again from "now"
        mailError = null;
        scheduleMailPoll(5000);
        return cfg;
    }

    function waNumber() {
        const c = getConfig();
        return c.wa_number || (wa.status().number || '');
    }

    /** For the guest pages: WhatsApp number and a prepared first message (with the guest code, if known). */
    function guestButton(booking) {
        const c = getConfig();
        if (!c.enabled || !c.show_button) return null;
        const number = waNumber();
        if (!number) return null;
        const text = booking && booking.guest_code
            ? `Hallo, hier schreibt der Gast der Buchung ${booking.guest_code} (${formatDateDE(booking.checkin)} – ${formatDateDE(booking.checkout)}).\n\n`
            : 'Hallo, ich habe eine Frage zur Ferienwohnung:\n\n';
        return { whatsapp: number, url: `https://wa.me/${number}?text=${encodeURIComponent(text)}` };
    }

    // -----------------------------------------------------------------------
    // Booking match
    // -----------------------------------------------------------------------
    const bookingById = id => id ? sql().prepare('SELECT * FROM bookings WHERE id = ?').get(id) : null;

    function pickBooking(rows) {
        if (!rows.length) return null;
        const today = berlinToday();
        const uniq = [...new Map(rows.filter(Boolean).map(b => [b.id, b])).values()];
        const current = uniq.find(b => b.checkin <= today && b.checkout >= today);
        if (current) return current;
        const next = uniq.filter(b => b.checkin > today).sort((a, b) => a.checkin.localeCompare(b.checkin))[0];
        if (next) return next;
        return uniq.sort((a, b) => b.checkout.localeCompare(a.checkout))[0];
    }

    function bookingsForPhone(phone) {
        if (!phone) return [];
        const out = [];
        const guests = sql().prepare("SELECT id, phone FROM guests WHERE phone IS NOT NULL AND phone != ''").all()
            .filter(g => normPhone(g.phone) === phone).map(g => g.id);
        if (guests.length) {
            out.push(...sql().prepare(`SELECT * FROM bookings WHERE guest_id IN (${guests.map(() => '?').join(',')}) AND checkin IS NOT NULL`).all(...guests));
        }
        sql().prepare("SELECT phone, booking_id FROM booking_requests WHERE booking_id IS NOT NULL AND phone IS NOT NULL AND phone != ''").all()
            .filter(r => normPhone(r.phone) === phone).forEach(r => out.push(bookingById(r.booking_id)));
        try {
            sql().prepare('SELECT booking_id, data FROM guest_registrations WHERE booking_id IS NOT NULL').all().forEach(r => {
                let d = {};
                try { d = JSON.parse(r.data || '{}'); } catch (e) { /* skip */ }
                if (normPhone(d.phone) === phone) out.push(bookingById(r.booking_id));
            });
        } catch (e) { /* table not there yet */ }
        return out.filter(b => b && b.checkin && b.checkout);
    }

    function bookingsForEmail(email) {
        if (!email) return [];
        const out = [];
        const guests = sql().prepare("SELECT id FROM guests WHERE lower(trim(email)) = ?").all(email).map(g => g.id);
        if (guests.length) {
            out.push(...sql().prepare(`SELECT * FROM bookings WHERE guest_id IN (${guests.map(() => '?').join(',')}) AND checkin IS NOT NULL`).all(...guests));
        }
        try {
            sql().prepare("SELECT booking_id FROM booking_requests WHERE booking_id IS NOT NULL AND lower(trim(email)) = ?").all(email)
                .forEach(r => out.push(bookingById(r.booking_id)));
        } catch (e) { /* older table */ }
        try {
            sql().prepare('SELECT booking_id, data FROM guest_registrations WHERE booking_id IS NOT NULL').all().forEach(r => {
                let d = {};
                try { d = JSON.parse(r.data || '{}'); } catch (e) { /* skip */ }
                if (normEmail(d.email) === email) out.push(bookingById(r.booking_id));
            });
        } catch (e) { /* table not there yet */ }
        return out.filter(b => b && b.checkin && b.checkout);
    }

    /** Booking.com mails name the guest in the subject ("Neue Nachricht von Max Muster"): match recent stays by name. */
    function bookingByName(text) {
        const t = String(text || '').toLowerCase();
        if (!t) return null;
        const rows = sql().prepare(`SELECT b.*, g.name AS gname FROM bookings b JOIN guests g ON g.id = b.guest_id
            WHERE b.checkin IS NOT NULL AND b.checkout >= date(?, '-14 days') AND b.checkin <= date(?, '+400 days')`).all(berlinToday(), berlinToday())
            .filter(b => b.gname && !botLogic.isPlaceholderGuestName(b.gname) && b.gname.trim().length >= 5 && t.includes(b.gname.trim().toLowerCase()));
        return rows.length ? pickBooking(rows) : null;
    }

    function bookingByCode(text) {
        const m = String(text || '').match(CODE_RE);
        if (!m) return null;
        return sql().prepare('SELECT * FROM bookings WHERE guest_code = ?').get(`BH-${m[1].toUpperCase()}`) || null;
    }

    function guestName(b) {
        if (!b || !b.guest_id) return '';
        const g = db.getGuestById(b.guest_id);
        return g && !botLogic.isPlaceholderGuestName(g.name) ? g.name : '';
    }

    /** Remember the phone with the guest, so the next message and the guest pages know it. */
    function rememberPhone(b, phone) {
        if (!b || !b.guest_id || !phone) return;
        const g = db.getGuestById(b.guest_id);
        if (g && !normPhone(g.phone)) db.updateGuest(g.id, { ...g, phone: '+' + phone });
    }

    /** The guest's e-mail (e.g. the Booking.com alias) is kept with the guest, if none is stored yet. */
    function rememberEmail(b, email) {
        if (!b || !b.guest_id || !email) return;
        const g = db.getGuestById(b.guest_id);
        if (g && !normEmail(g.email)) db.updateGuest(g.id, { ...g, email });
    }

    function bookingEmail(b) {
        const g = b && b.guest_id ? db.getGuestById(b.guest_id) : null;
        let e = normEmail(g && g.email);
        if (!e && b) {
            try {
                const r = sql().prepare('SELECT email FROM booking_requests WHERE booking_id = ?').get(b.id);
                e = normEmail(r && r.email);
            } catch (err) { /* older table */ }
        }
        return e;
    }

    // -----------------------------------------------------------------------
    // Store
    // -----------------------------------------------------------------------
    const getContact = conv => sql().prepare('SELECT * FROM guest_chat_contacts WHERE conv = ?').get(conv);
    const contactByEmail = email => email ? sql().prepare('SELECT * FROM guest_chat_contacts WHERE email = ? ORDER BY COALESCE(last_at, created_at) DESC').get(email) : null;

    function upsertContact(conv, fields) {
        const c = getContact(conv);
        if (!c) {
            sql().prepare('INSERT INTO guest_chat_contacts (conv, phone, name, wa_chat, booking_id, booking_fixed, last_channel, last_at, email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(conv, fields.phone || null, fields.name || null, fields.wa_chat || null, fields.booking_id || null, fields.booking_fixed ? 1 : 0, fields.last_channel || null, fields.last_at || null, fields.email || null);
        } else {
            const m = { ...c, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
            sql().prepare('UPDATE guest_chat_contacts SET phone = ?, name = ?, wa_chat = ?, booking_id = ?, booking_fixed = ?, last_channel = ?, last_at = ?, email = ? WHERE conv = ?')
                .run(m.phone || null, m.name || null, m.wa_chat || null, m.booking_id || null, m.booking_fixed ? 1 : 0, m.last_channel || null, m.last_at || null, m.email || null, conv);
        }
        return getContact(conv);
    }

    function addMessage(m) {
        const r = sql().prepare(`INSERT INTO guest_chat_messages (conv, channel, direction, body, media, media_type, ext_id, author, status, error, read_at, subject)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.conv, m.channel, m.direction, m.body || '', m.media || null, m.media_type || null,
            m.ext_id || null, m.author || null, m.status || null, m.error || null, m.direction === 'out' ? new Date().toISOString() : null, m.subject || null);
        sql().prepare("UPDATE guest_chat_contacts SET last_at = CURRENT_TIMESTAMP, last_channel = COALESCE(?, last_channel) WHERE conv = ?")
            .run(m.direction === 'in' ? m.channel : null, m.conv);
        return r.lastInsertRowid;
    }

    function saveMedia(buf, mime) {
        const ext = MEDIA_EXT[String(mime || '').split(';')[0]] || 'bin';
        const file = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
        fs.writeFileSync(path.join(MEDIA_DIR, file), buf);
        return file;
    }

    function cleanup() {
        try {
            const old = sql().prepare("SELECT conv FROM guest_chat_contacts WHERE COALESCE(last_at, created_at) < datetime('now', '-13 months')").all();
            for (const { conv } of old) {
                sql().prepare('SELECT media FROM guest_chat_messages WHERE conv = ? AND media IS NOT NULL').all(conv)
                    .forEach(r => { try { fs.unlinkSync(path.join(MEDIA_DIR, path.basename(r.media))); } catch (e) { /* gone */ } });
                sql().prepare('DELETE FROM guest_chat_messages WHERE conv = ?').run(conv);
                sql().prepare('DELETE FROM guest_chat_tg WHERE conv = ?').run(conv);
                sql().prepare('DELETE FROM guest_chat_contacts WHERE conv = ?').run(conv);
            }
            if (old.length) console.log(`🗑️ ${old.length} alte Gäste-Chat(s) gelöscht`);
            sql().prepare("DELETE FROM guest_chat_tg WHERE created_at < datetime('now', '-60 days')").run();
        } catch (e) { console.error('Gäste-Chat Aufräumen Fehler:', e.message); }
    }
    cleanup();
    setInterval(cleanup, 24 * 60 * 60 * 1000).unref();

    // -----------------------------------------------------------------------
    // Incoming
    // -----------------------------------------------------------------------
    function stayText(b) {
        if (!b) return 'keiner Buchung zugeordnet';
        return `Buchung ${formatDateDE(b.checkin)} – ${formatDateDE(b.checkout)}${b.source ? ` (${b.source === 'manual' ? 'Direkt' : b.source})` : ''}`;
    }

    async function notifyHosts(contact, body, channel) {
        const cfg = getConfig();
        const b = bookingById(contact.booking_id);
        const who = contact.name || (contact.phone ? '+' + contact.phone : contact.email || '?');
        const icon = channel === 'sms' ? '📱 SMS' : channel === 'mail' ? '✉️ E-Mail' : '💬 WhatsApp';
        const short = body.length > 1200 ? body.slice(0, 1200) + ' …' : body;
        if (cfg.notify_telegram) {
            const bot = telegram.bot();
            if (bot) {
                const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                const text = `${icon} <b>von ${esc(who)}</b>\n<i>${esc(stayText(b))}</i>\n\n${esc(short)}\n\n<i>↩️ Auf diese Nachricht antworten, um dem Gast zu schreiben.</i>`;
                for (const id of telegram.ids()) {
                    try {
                        const sent = await bot.sendMessage(id, text, { parse_mode: 'HTML', disable_web_page_preview: true });
                        sql().prepare('INSERT OR REPLACE INTO guest_chat_tg (tg_chat, tg_msg, conv) VALUES (?, ?, ?)').run(String(id), sent.message_id, contact.conv);
                    } catch (e) { console.error('❌ Gäste-Chat Telegram:', e.message); }
                }
            }
        }
        if (cfg.notify_push && push) {
            try { await push.send(`${icon} von ${who}: ${short.slice(0, 160)}`, 'guest_chat', { url: '/?view=chat', tag: 'chat-' + contact.conv }); } catch (e) { /* push optional */ }
        }
        db.logNotification('guest_chat', `${icon} von ${who}: ${short.slice(0, 200)}`, 'sent');
    }

    /** Stores an incoming guest message, links it to a booking and tells the host. */
    async function receive({ channel, phone, email, waChat, name, body, subject, media, mediaType, extId }) {
        const cfg = getConfig();
        if (!cfg.enabled) return false;
        let conv = phone || (waChat ? 'wa:' + String(waChat).replace(/@.*$/, '') : '');
        if (!conv && email) {
            const known = contactByEmail(email);
            conv = known ? known.conv : 'mail:' + email;
        }
        if (!conv) return false;
        if (extId && sql().prepare('SELECT 1 FROM guest_chat_messages WHERE ext_id = ? AND channel = ?').get(extId, channel)) return false;

        let contact = getContact(conv);
        let booking = null;
        if (!contact || !contact.booking_fixed) {
            const byCode = bookingByCode(body) || bookingByCode(subject);
            booking = byCode || (phone ? pickBooking(bookingsForPhone(phone)) : null) || (email ? pickBooking(bookingsForEmail(email)) || bookingByName(subject) : null);
            if (byCode) { rememberPhone(byCode, phone); rememberEmail(byCode, email); }
        }
        const bookingId = booking ? booking.id : (contact ? contact.booking_id : null);
        const realName = guestName(booking || bookingById(bookingId));
        if (channel === 'wa') sql().prepare("UPDATE guest_chat_contacts SET wa_status = 'yes' WHERE conv = ?").run(conv);
        contact = upsertContact(conv, {
            phone: phone || (contact && contact.phone) || null,
            email: (contact && contact.email) || email || null,
            name: realName || (contact && contact.name) || name || null,
            wa_chat: waChat || undefined,
            booking_id: bookingId,
            last_channel: channel,
            last_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
        });
        addMessage({ conv, channel, direction: 'in', body: String(body || '').slice(0, MAX_TEXT), subject, media, media_type: mediaType, ext_id: extId, status: 'received' });
        const preview = body || (mediaType ? (/^image/.test(mediaType) ? '📷 Bild' : /^audio/.test(mediaType) ? '🎤 Sprachnachricht' : '📎 Anhang') : '');
        notifyHosts(contact, preview, channel).catch(e => console.error('Gäste-Chat Hinweis Fehler:', e.message));
        return true;
    }

    /** WhatsApp message from someone who is not an admin user (called by server.js). */
    async function receiveWhatsApp(msg, phone) {
        const skip = ['e2e_notification', 'notification_template', 'call_log', 'protocol', 'revoked', 'ciphertext', 'gp2', 'broadcast_notification'];
        if (skip.includes(msg.type)) return false;
        let body = msg.body || '';
        let media = null, mediaType = null;
        if (msg.type === 'location' && msg.location) {
            body = `📍 Standort: https://maps.google.com/?q=${msg.location.latitude},${msg.location.longitude}${msg.location.description ? `\n${msg.location.description}` : ''}`;
        } else if (msg.type === 'vcard') {
            body = '👤 Kontakt geteilt\n' + String(msg.body || '').replace(/^BEGIN:VCARD[\s\S]*?FN:([^\r\n]+)[\s\S]*$/m, '$1');
        } else if (msg.hasMedia) {
            try {
                const m = await msg.downloadMedia();
                if (m && m.data) {
                    const buf = Buffer.from(m.data, 'base64');
                    mediaType = m.mimetype;
                    if (buf.length <= MAX_MEDIA_BYTES) media = saveMedia(buf, m.mimetype);
                    else body = (body ? body + '\n' : '') + '📎 Anhang zu groß, bitte direkt in WhatsApp ansehen';
                }
            } catch (e) {
                body = (body ? body + '\n' : '') + '📎 Anhang konnte nicht geladen werden';
            }
            if (msg.type === 'sticker') { media = null; body = body || '🙂 Sticker'; }
        }
        if (!body && !media) return false;
        const name = (msg._data && msg._data.notifyName) || '';
        return receive({ channel: 'wa', phone, waChat: msg.from, name, body, media, mediaType, extId: msg.id && msg.id._serialized });
    }

    /** A message the host typed directly on the WhatsApp phone: shown in the conversation, if there is one. */
    async function recordOwnWhatsApp(msg, phone) {
        const extId = msg.id && msg.id._serialized;
        if (!extId || !msg.body) return;
        // Messages sent from the admin are stored right after sending; wait so they are not stored twice
        await new Promise(r => setTimeout(r, 4000));
        if (sql().prepare("SELECT 1 FROM guest_chat_messages WHERE ext_id = ? AND channel = 'wa'").get(extId)) return;
        const conv = phone || ('wa:' + String(msg.to || '').replace(/@.*$/, ''));
        if (!getContact(conv)) return;
        addMessage({ conv, channel: 'wa', direction: 'out', body: String(msg.body).slice(0, MAX_TEXT), ext_id: extId, author: 'Handy', status: 'sent' });
    }

    // -----------------------------------------------------------------------
    // SMS (SMS Gateway for Android)
    // -----------------------------------------------------------------------
    function smsApi(cfg, p) {
        const s = cfg.sms;
        if (s.mode === 'local') return `${s.url}${p}`;
        return `${s.url || 'https://api.sms-gate.app'}/3rdparty/v1${p}`;
    }

    function smsReady(cfg = getConfig()) {
        const s = cfg.sms;
        return !!(s.enabled && s.username && s.password && (s.mode === 'cloud' || s.url));
    }

    async function smsRequest(cfg, method, p, body) {
        const res = await fetch(smsApi(cfg, p), {
            method,
            headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${cfg.sms.username}:${cfg.sms.password}`).toString('base64') },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000)
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = { message: text }; }
        if (!res.ok) {
            const err = new Error(res.status === 401 ? 'Benutzername oder Passwort der SMS-App stimmt nicht.' : `SMS-Gateway antwortet mit Fehler ${res.status}${data && data.message ? `: ${data.message}` : ''}`);
            err.status = res.status;
            throw err;
        }
        return data;
    }

    async function sendSms(phone, text) {
        const cfg = getConfig();
        if (!smsReady(cfg)) throw new Error('SMS ist nicht eingerichtet (Einstellungen → Gäste-Chat & SMS).');
        const body = { textMessage: { text: text.slice(0, SMS_MAX_TEXT) }, phoneNumbers: ['+' + phone] };
        if (cfg.sms.sim) body.simNumber = parseInt(cfg.sms.sim, 10);
        try {
            const r = await smsRequest(cfg, 'POST', '/message', body);
            return r && r.id;
        } catch (e) {
            // Older app versions only know the plain "message" field
            if (e.status !== 400) throw e;
            const r = await smsRequest(cfg, 'POST', '/message', { ...body, textMessage: undefined, message: text.slice(0, SMS_MAX_TEXT) });
            return r && r.id;
        }
    }

    function hookUrl(cfg = getConfig()) {
        let base = cfg.sms.hook_base;
        if (!base) {
            const s = getSite();
            base = s.public_url ? String(s.public_url).replace(/\/+$/, '') : '';
        }
        return base ? `${base}/sms-hook/${cfg.sms.secret}` : '';
    }

    async function registerHook() {
        const cfg = getConfig();
        if (!smsReady(cfg)) throw new Error('Bitte zuerst SMS einschalten und Zugangsdaten speichern.');
        const url = hookUrl(cfg);
        if (!url) throw new Error('Keine öffentliche Adresse: bitte unter Webseite → Einrichtung eintragen oder hier eine Adresse für eingehende SMS angeben.');
        await smsRequest(cfg, 'POST', '/webhooks', { id: 'beckhome-sms', url, event: 'sms:received' });
        return url;
    }

    async function testSms(phone) {
        const p = normPhone(phone);
        if (!p) throw new Error('Bitte eine gültige Handynummer angeben.');
        await sendSms(p, '✅ Test-SMS von Ferienwohnung Beckhome. Der SMS-Versand funktioniert.');
        return p;
    }

    // -----------------------------------------------------------------------
    // E-Mail (Booking.com alias address or any guest address): SMTP out, IMAP in
    // -----------------------------------------------------------------------
    function smtpCfg() {
        const m = db.getAllSettings().smtp;
        const o = m && typeof m === 'string' ? (() => { try { return JSON.parse(m); } catch (e) { return {}; } })() : (m || {});
        return o && o.host && o.user ? o : null;
    }

    function mailReady(cfg = getConfig()) {
        return !!(cfg.mail.enabled && smtpCfg());
    }

    function ownAddresses() {
        const m = smtpCfg() || {};
        const c = getConfig().mail;
        return new Set([normEmail(m.user), normEmail(m.from), normEmail(c.user)].filter(Boolean));
    }

    async function sendEmail(conv, text) {
        const cfg = getConfig();
        const m = smtpCfg();
        if (!cfg.mail.enabled) throw new Error('E-Mail ist im Gäste-Chat ausgeschaltet.');
        if (!m) throw new Error('E-Mail-Versand ist nicht eingerichtet (Einstellungen → E-Mail (SMTP)).');
        const c = getContact(conv);
        if (!c || !c.email) throw new Error('Für diese Unterhaltung ist keine E-Mail-Adresse hinterlegt. Bitte unter „E-Mail“ eintragen.');
        const site = getSite() || {};
        const title = site.title || 'Ferienwohnung';
        const last = sql().prepare("SELECT ext_id, subject FROM guest_chat_messages WHERE conv = ? AND channel = 'mail' AND direction = 'in' ORDER BY id DESC LIMIT 1").get(conv);
        const b = bookingById(c.booking_id);
        let subject;
        if (last && last.subject) subject = /^\s*(re|aw|antw)\s*:/i.test(last.subject) ? last.subject : 'Re: ' + last.subject;
        else subject = b ? `${title}: Ihr Aufenthalt ${formatDateDE(b.checkin)} – ${formatDateDE(b.checkout)}${b.guest_code ? ` (${b.guest_code})` : ''}` : title;
        const port = parseInt(m.port, 10) || 587;
        const transporter = nodemailer.createTransport({
            host: m.host, port, secure: port === 465,
            auth: { user: m.user, pass: m.pass },
            connectionTimeout: 15000, greetingTimeout: 15000
        });
        const from = /@/.test(m.from || '') ? m.from : { name: m.from || title, address: m.user };
        const mail = { from, to: c.email, subject: subject.slice(0, 200), text };
        if (last && last.ext_id && /^<.+>$/.test(last.ext_id)) { mail.inReplyTo = last.ext_id; mail.references = [last.ext_id]; }
        const info = await transporter.sendMail(mail);
        return { id: info && info.messageId, subject: mail.subject };
    }

    // ---- Incoming mail (IMAP, read-only) ----
    let mailBusy = false, mailTimer = null, mailError = null, mailCheckedAt = null;

    function imapCreds(cfg = getConfig()) {
        const m = smtpCfg() || {};
        const c = cfg.mail;
        const host = c.host;
        const user = c.user || m.user || '';
        const pass = c.password || (c.user && c.user !== m.user ? '' : m.pass) || '';
        return host && user && pass ? { host, port: c.port || 993, user, pass, folder: c.folder || 'INBOX' } : null;
    }

    function mailInReady(cfg = getConfig()) {
        return !!(imap && mailParser && cfg.enabled && cfg.mail.enabled && cfg.mail.imap_enabled && imapCreds(cfg));
    }

    /** Which address of an incoming mail is the guest? null = not a guest mail. */
    function guestAddress(parsed) {
        const own = ownAddresses();
        const list = h => (h && h.value ? h.value : []).map(a => normEmail(a.address)).filter(Boolean);
        const from = list(parsed.from)[0] || '';
        if (!from || own.has(from)) return null; // our own sent copy
        const cands = [...new Set([...list(parsed.replyTo), from])].filter(a => !own.has(a));
        const known = cands.find(a => contactByEmail(a));
        if (known) return known;
        // Booking.com guest alias (guest.booking.com and similar), never the system senders
        const relay = cands.find(a => /(^|\.)booking\.com$/.test(a.split('@')[1]) && !MAIL_SYSTEM_RE.test(a.split('@')[0]));
        if (relay) return relay;
        // A guest of a current or upcoming stay writing from the address stored with the booking
        const today = berlinToday();
        return cands.find(a => bookingsForEmail(a).some(b => b.checkout >= today)) || null;
    }

    async function handleMail(parsed, uid) {
        const email = guestAddress(parsed);
        if (!email) return false;
        let body = stripQuoted(parsed.text || '');
        if (!body) body = String(parsed.text || '').trim();
        let media = null, mediaType = null;
        const files = (parsed.attachments || []).filter(a => a.contentDisposition !== 'inline' || /^image\//.test(a.contentType || ''))
            .filter(a => MEDIA_EXT[String(a.contentType || '').split(';')[0]] && !a.related);
        if (files.length) {
            const f = files[0];
            if (f.size <= MAX_MEDIA_BYTES && f.content) { media = saveMedia(f.content, f.contentType); mediaType = f.contentType; }
            else body = (body ? body + '\n' : '') + '📎 Anhang zu groß, bitte im E-Mail-Postfach ansehen';
            if (files.length > 1) body = (body ? body + '\n' : '') + `📎 ${files.length - 1} weitere(r) Anhang/Anhänge im E-Mail-Postfach`;
        }
        if (!body && !media) return false;
        const fromName = parsed.from && parsed.from.value && parsed.from.value[0] ? String(parsed.from.value[0].name || '') : '';
        const name = fromName.replace(/\s*(via|über)\s+booking\.com.*$/i, '').replace(/^booking\.com$/i, '').trim();
        return receive({ channel: 'mail', email, name, body, subject: String(parsed.subject || '').slice(0, 300), media, mediaType, extId: parsed.messageId || `imap:${uid}` });
    }

    /** Reads new mails since the last check. The first check (or another mailbox) only notes where "now" is. */
    async function pollMail(manual = false) {
        const cfg = getConfig();
        if (!manual && !mailInReady(cfg)) return { skipped: true };
        if (!imap || !mailParser) throw new Error('Die Pakete für den E-Mail-Empfang fehlen. Bitte das Update ausführen (npm install).');
        const cr = imapCreds(cfg);
        if (!cr) throw new Error('Bitte IMAP-Server, Benutzer und Passwort eintragen.');
        if (mailBusy) return { busy: true };
        mailBusy = true;
        const client = new imap.ImapFlow({ host: cr.host, port: cr.port, secure: cr.port === 993, auth: { user: cr.user, pass: cr.pass }, logger: false, socketTimeout: 60000, greetingTimeout: 15000, connectionTimeout: 15000 });
        client.on('error', e => { mailError = e.message; });
        let added = 0, seen = 0;
        try {
            await client.connect();
            const lock = await client.getMailboxLock(cr.folder);
            try {
                const box = client.mailbox;
                const validity = String(box.uidValidity);
                const st = db.getSetting('guest_chat_mail_state') || {};
                const top = Math.max(0, Number(box.uidNext || 1) - 1);
                if (st.uidvalidity !== validity || !Number.isFinite(st.last_uid)) {
                    db.setSetting('guest_chat_mail_state', { uidvalidity: validity, last_uid: top });
                } else if (top > st.last_uid) {
                    const items = [];
                    for await (const msg of client.fetch(`${st.last_uid + 1}:*`, { uid: true, source: true }, { uid: true })) {
                        if (msg.uid > st.last_uid && msg.source) items.push({ uid: msg.uid, source: msg.source });
                        if (items.length >= MAIL_MAX_PER_POLL) break;
                    }
                    let last = st.last_uid;
                    for (const it of items.sort((a, b) => a.uid - b.uid)) {
                        seen++;
                        try {
                            const parsed = await mailParser.simpleParser(it.source, { skipImageLinks: true });
                            if (await handleMail(parsed, it.uid)) added++;
                        } catch (e) { console.warn('⚠️ Gäste-Chat E-Mail nicht lesbar:', e.message); }
                        last = it.uid;
                    }
                    db.setSetting('guest_chat_mail_state', { uidvalidity: validity, last_uid: last });
                }
            } finally { lock.release(); }
            await client.logout().catch(() => {});
            mailError = null;
            mailCheckedAt = new Date().toISOString();
            if (added) console.log(`✉️ ${added} Gast-E-Mail(s) im Gäste-Chat`);
            return { added, seen };
        } catch (e) {
            try { client.close(); } catch (err) { /* already closed */ }
            mailError = e.authenticationFailed ? 'Anmeldung am E-Mail-Postfach fehlgeschlagen (Benutzer oder Passwort).' : (e.responseText || e.message);
            throw new Error(mailError);
        } finally {
            mailBusy = false;
        }
    }

    function scheduleMailPoll(ms = MAIL_POLL_MS) {
        if (mailTimer) clearTimeout(mailTimer);
        mailTimer = setTimeout(async () => {
            try { await pollMail(); } catch (e) { console.warn('⚠️ Gäste-Chat E-Mail-Abruf:', e.message); }
            scheduleMailPoll();
        }, ms);
        if (mailTimer.unref) mailTimer.unref();
    }
    scheduleMailPoll(20000);

    function mailStatus() {
        const cfg = getConfig();
        return { out: mailReady(cfg), in: mailInReady(cfg), error: mailError, checkedAt: mailCheckedAt, imapPackages: !!(imap && mailParser) };
    }

    // -----------------------------------------------------------------------
    // Does the number have WhatsApp? Checked before the first WhatsApp message to a number.
    // 'yes' | 'no' | 'unknown' (WhatsApp not connected or the check failed). A 'no' is checked again after a day.
    // -----------------------------------------------------------------------
    async function checkWhatsApp(conv, force = false) {
        const c = getContact(conv);
        if (!c) return 'unknown';
        if (c.wa_chat) return 'yes';
        if (!c.phone) return 'none'; // e-mail only
        const fresh = c.wa_checked_at && Date.now() - new Date(String(c.wa_checked_at).replace(' ', 'T') + 'Z').getTime() < 24 * 60 * 60 * 1000;
        if (c.wa_status === 'no' && fresh && !force) return 'no';
        if (!wa.status().ready) return 'unknown';
        let status = 'unknown', chatId = null;
        try {
            chatId = await wa.chatIdFor(c.phone);
            status = chatId ? 'yes' : 'no';
        } catch (e) {
            console.warn('⚠️ WhatsApp-Prüfung fehlgeschlagen:', e.message);
            return 'unknown';
        }
        sql().prepare('UPDATE guest_chat_contacts SET wa_status = ?, wa_chat = COALESCE(?, wa_chat), wa_checked_at = CURRENT_TIMESTAMP WHERE conv = ?')
            .run(status, chatId, conv);
        return status;
    }

    // -----------------------------------------------------------------------
    // Outgoing
    // -----------------------------------------------------------------------
    async function send(conv, text, { channel, author } = {}) {
        const contact = getContact(conv);
        if (!contact) throw new Error('Unterhaltung nicht gefunden.');
        text = String(text || '').trim().slice(0, MAX_TEXT);
        if (!text) throw new Error('Bitte eine Nachricht eingeben.');
        const ch = ['sms', 'wa', 'mail'].includes(channel) ? channel
            : (contact.last_channel || (!contact.phone && contact.email ? 'mail' : contact.wa_status === 'no' ? 'sms' : 'wa'));
        let extId = null, error = null, subject = null;
        try {
            if (ch === 'mail') {
                const r = await sendEmail(conv, text);
                extId = r.id; subject = r.subject;
            } else if (!contact.phone && !contact.wa_chat) {
                throw new Error('Für diese Unterhaltung ist keine Telefonnummer bekannt. Bitte per E-Mail schreiben.');
            } else if (ch === 'sms') {
                if (!contact.phone) throw new Error('Für SMS fehlt die Telefonnummer.');
                extId = await sendSms(contact.phone, text);
            } else {
                if (!wa.status().ready) throw new Error('WhatsApp ist gerade nicht verbunden.');
                // Never send blindly: the number must exist on WhatsApp
                const has = await checkWhatsApp(conv, true);
                if (has === 'no') throw new Error('Diese Nummer gibt es nicht bei WhatsApp. Bitte per SMS schreiben.');
                if (has !== 'yes') throw new Error('Konnte nicht prüfen, ob die Nummer WhatsApp hat. Bitte später noch einmal versuchen.');
                extId = await wa.send(getContact(conv).wa_chat, text);
            }
        } catch (e) { error = e.message; }
        const id = addMessage({ conv, channel: ch, direction: 'out', body: text, subject, ext_id: extId, author, status: error ? 'failed' : 'sent', error });
        if (error) { const err = new Error(error); err.messageId = id; throw err; }
        // Answering counts as reading
        sql().prepare("UPDATE guest_chat_messages SET read_at = CURRENT_TIMESTAMP WHERE conv = ? AND read_at IS NULL").run(conv);
        return id;
    }

    /**
     * Automatic message to the guest of a booking (Anfahrts-Assistent): WhatsApp if the number has it, else SMS,
     * else e-mail (smsText: shorter text for SMS). Returns { channel, conv }. Throws with err.noChannel when there is no way to reach the guest.
     */
    async function sendToBooking(bookingId, text, { author, smsText } = {}) {
        const cfg = getConfig();
        const noChannel = msg => Object.assign(new Error(msg), { noChannel: true });
        if (!cfg.enabled) throw noChannel('Der Gäste-Chat ist ausgeschaltet.');
        let conv;
        try { conv = start({ bookingId }); } catch (e) {
            if (e.needPhone) throw noChannel('Für die Buchung ist weder Telefonnummer noch E-Mail-Adresse bekannt.');
            throw e;
        }
        let c = getContact(conv);
        const failed = [];
        let possible = false;
        if (c.phone || c.wa_chat) {
            if (wa.status().ready) {
                const has = await checkWhatsApp(conv, true);
                if (has === 'yes') {
                    possible = true;
                    try { await send(conv, text, { channel: 'wa', author }); return { channel: 'wa', conv }; } catch (e) { failed.push(`WhatsApp: ${e.message}`); }
                } else failed.push(has === 'no' ? 'Die Nummer hat kein WhatsApp' : 'WhatsApp-Prüfung nicht möglich');
            } else failed.push('WhatsApp ist nicht verbunden');
            if (c.phone && smsReady(cfg)) {
                possible = true;
                try { await send(conv, smsText || text, { channel: 'sms', author }); return { channel: 'sms', conv }; } catch (e) { failed.push(`SMS: ${e.message}`); }
            } else if (c.phone) failed.push('SMS ist nicht eingerichtet');
        }
        c = getContact(conv);
        const email = c.email || bookingEmail(bookingById(c.booking_id || bookingId));
        if (email && mailReady(cfg)) {
            possible = true;
            if (!c.email) upsertContact(conv, { email });
            try { await send(conv, text, { channel: 'mail', author }); return { channel: 'mail', conv }; } catch (e) { failed.push(`E-Mail: ${e.message}`); }
        } else if (email) failed.push('E-Mail-Versand ist nicht eingerichtet');
        else failed.push('keine E-Mail-Adresse bekannt');
        const err = new Error(failed.join(' · '));
        err.noChannel = !possible;
        throw err;
    }

    /** What the automatic messages can use right now (for the admin). */
    function channelStatus() {
        const cfg = getConfig();
        return { enabled: !!cfg.enabled, whatsapp: !!wa.status().ready, sms: smsReady(cfg), mail: mailReady(cfg) };
    }

    /** Start (or reopen) a conversation for a booking or a typed number. Returns the conversation key. */
    function start({ bookingId, phone, email }) {
        let b = bookingId ? bookingById(bookingId) : null;
        // One field for both: an address with @ is an e-mail
        if (phone && String(phone).includes('@') && !email) { email = phone; phone = ''; }
        if (email != null && String(email).trim() && !normEmail(email)) throw new Error('Die E-Mail-Adresse sieht nicht gültig aus.');
        const e = normEmail(email);
        let p = normPhone(phone);
        if (e && !p) return startEmail(b, e, !!bookingId);
        if (b && !p) {
            const g = b.guest_id ? db.getGuestById(b.guest_id) : null;
            p = normPhone(g && g.phone);
            if (!p) {
                const r = sql().prepare('SELECT phone FROM booking_requests WHERE booking_id = ?').get(b.id);
                p = normPhone(r && r.phone);
            }
            if (!p) {
                const conv = sql().prepare('SELECT conv FROM guest_chat_contacts WHERE booking_id = ? ORDER BY last_at DESC').get(b.id);
                if (conv) return conv.conv;
                const known = bookingEmail(b);
                if (known) return startEmail(b, known, true);
                const err = new Error(b.source && /booking/i.test(b.source)
                    ? 'Für diese Buchung ist weder Telefonnummer noch E-Mail bekannt. Bitte die Booking.com-Adresse des Gastes eintragen (steht in der Buchung im Booking.com-Extranet, z. B. name.123456@guest.booking.com).'
                    : 'Für diese Buchung ist keine Telefonnummer bekannt. Bitte Nummer oder E-Mail-Adresse eingeben.');
                err.needPhone = true;
                throw err;
            }
        }
        if (!p) throw new Error('Bitte eine gültige Telefonnummer angeben, z. B. 0176 12345678 oder +43 660 1234567.');
        if (!b) b = pickBooking(bookingsForPhone(p));
        const existing = getContact(p);
        upsertContact(p, {
            phone: p,
            name: guestName(b) || (existing && existing.name) || null,
            booking_id: b ? b.id : (existing && existing.booking_id) || null,
            booking_fixed: bookingId ? 1 : (existing ? existing.booking_fixed : 0)
        });
        if (b && bookingId) rememberPhone(b, p);
        return p;
    }

    /** Conversation by e-mail: the booking's conversation gets the address, else the one with that address, else a new one. */
    function startEmail(b, email, fixed) {
        let c = (b && sql().prepare('SELECT * FROM guest_chat_contacts WHERE booking_id = ? ORDER BY COALESCE(last_at, created_at) DESC').get(b.id)) || contactByEmail(email);
        if (!b) b = pickBooking(bookingsForEmail(email));
        const conv = c ? c.conv : 'mail:' + email;
        c = getContact(conv);
        upsertContact(conv, {
            email,
            name: guestName(b) || (c && c.name) || null,
            booking_id: b ? b.id : (c && c.booking_id) || null,
            booking_fixed: fixed ? 1 : (c ? c.booking_fixed : 0)
        });
        if (b && fixed) rememberEmail(b, email);
        return conv;
    }

    /** Set or remove the e-mail address of a conversation by hand (e.g. the Booking.com alias). */
    function setEmail(conv, raw) {
        const c = getContact(conv);
        if (!c) throw new Error('Unterhaltung nicht gefunden.');
        const e = normEmail(raw);
        if (String(raw || '').trim() && !e) throw new Error('Die E-Mail-Adresse sieht nicht gültig aus.');
        if (!e && !c.phone && !c.wa_chat) throw new Error('Ohne Telefonnummer braucht die Unterhaltung eine E-Mail-Adresse.');
        const other = e && contactByEmail(e);
        if (other && other.conv !== conv) throw new Error('Diese Adresse gehört schon zu einer anderen Unterhaltung.');
        upsertContact(conv, { email: e || null });
        if (e) rememberEmail(bookingById(c.booking_id), e);
        return e;
    }

    // -----------------------------------------------------------------------
    // Telegram: answer by replying to the notice
    // -----------------------------------------------------------------------
    async function handleTelegramReply(bot, msg) {
        const reply = msg.reply_to_message;
        if (!reply || !msg.text) return false;
        const row = sql().prepare('SELECT conv FROM guest_chat_tg WHERE tg_chat = ? AND tg_msg = ?').get(String(msg.chat.id), reply.message_id);
        if (!row) return false;
        const who = (msg.from && (msg.from.first_name || msg.from.username)) || 'Telegram';
        try {
            const id = await send(row.conv, msg.text, { author: who });
            const m = sql().prepare('SELECT channel FROM guest_chat_messages WHERE id = ?').get(id);
            await bot.sendMessage(msg.chat.id, `✅ Per ${m.channel === 'sms' ? 'SMS' : m.channel === 'mail' ? 'E-Mail' : 'WhatsApp'} an den Gast gesendet.`, { reply_to_message_id: msg.message_id });
        } catch (e) {
            await bot.sendMessage(msg.chat.id, `❌ Nicht gesendet: ${e.message}`, { reply_to_message_id: msg.message_id });
        }
        return true;
    }

    // -----------------------------------------------------------------------
    // Views for the admin
    // -----------------------------------------------------------------------
    function bookingInfo(b) {
        if (!b) return null;
        return { id: b.id, checkin: b.checkin, checkout: b.checkout, source: b.source === 'manual' ? 'Direkt' : b.source, code: b.guest_code, name: guestName(b) };
    }

    function conversations() {
        const rows = sql().prepare(`
            SELECT c.*,
                (SELECT COUNT(*) FROM guest_chat_messages m WHERE m.conv = c.conv AND m.direction = 'in' AND m.read_at IS NULL) AS unread,
                (SELECT body FROM guest_chat_messages m WHERE m.conv = c.conv ORDER BY id DESC LIMIT 1) AS last_body,
                (SELECT direction FROM guest_chat_messages m WHERE m.conv = c.conv ORDER BY id DESC LIMIT 1) AS last_dir,
                (SELECT media_type FROM guest_chat_messages m WHERE m.conv = c.conv ORDER BY id DESC LIMIT 1) AS last_media
            FROM guest_chat_contacts c
            ORDER BY COALESCE(c.last_at, c.created_at) DESC
            LIMIT 300
        `).all();
        return rows.map(r => ({
            conv: r.conv, phone: r.phone, email: r.email, name: r.name, unread: r.unread, lastAt: r.last_at || r.created_at,
            lastChannel: r.last_channel, lastBody: r.last_body || (r.last_media ? '📎 Anhang' : ''), lastDir: r.last_dir,
            booking: bookingInfo(bookingById(r.booking_id))
        }));
    }

    function unreadCount() {
        return sql().prepare("SELECT COUNT(DISTINCT conv) AS n FROM guest_chat_messages WHERE direction = 'in' AND read_at IS NULL").get().n;
    }

    function thread(conv, markRead = true) {
        const c = getContact(conv);
        if (!c) return null;
        if (markRead) sql().prepare("UPDATE guest_chat_messages SET read_at = CURRENT_TIMESTAMP WHERE conv = ? AND direction = 'in' AND read_at IS NULL").run(conv);
        const messages = sql().prepare('SELECT * FROM guest_chat_messages WHERE conv = ? ORDER BY id DESC LIMIT 500').all(conv).reverse().map(m => ({
            id: m.id, channel: m.channel, direction: m.direction, body: m.body, subject: m.subject, author: m.author, status: m.status, error: m.error,
            at: m.created_at, media: m.media ? `/api/chat/media/${encodeURIComponent(m.media)}` : null, mediaType: m.media_type
        }));
        const b = bookingById(c.booking_id);
        return {
            conv, phone: c.phone, email: c.email, name: c.name, bookingFixed: !!c.booking_fixed,
            lastChannel: c.last_channel || (!c.phone && !c.wa_chat && c.email ? 'mail' : 'wa'),
            whatsapp: c.wa_chat ? 'yes' : !c.phone ? 'none' : (c.wa_status || 'unknown'), booking: bookingInfo(b), messages
        };
    }

    function bookingChoices() {
        const today = berlinToday();
        return sql().prepare(`SELECT * FROM bookings WHERE checkin IS NOT NULL AND checkout >= date(?, '-60 days') ORDER BY checkin LIMIT 120`).all(today)
            .map(b => bookingInfo(b));
    }

    // -----------------------------------------------------------------------
    // Routes
    // -----------------------------------------------------------------------
    // Public: incoming SMS from the Android app (POST /gast/sms-hook/<secret>)
    const router = express.Router();
    const hookLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
    router.post('/sms-hook/:secret', hookLimiter, async (req, res) => {
        const cfg = getConfig();
        const a = Buffer.from(String(req.params.secret));
        const b = Buffer.from(String(cfg.sms.secret));
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(404).json({ success: false });
        if (!cfg.sms.enabled) return res.json({ success: true, ignored: true });
        const ev = req.body || {};
        if (ev.event !== 'sms:received' || !ev.payload) return res.json({ success: true, ignored: true });
        const p = ev.payload;
        const phone = normPhone(p.phoneNumber || p.sender);
        if (!phone) return res.json({ success: true, ignored: true });
        try {
            await receive({ channel: 'sms', phone, name: '', body: String(p.message || p.text || ''), extId: p.messageId || ev.id });
            res.json({ success: true });
        } catch (e) {
            console.error('SMS-Webhook Fehler:', e.message);
            res.status(500).json({ success: false });
        }
    });

    function registerAdminRoutes(app, apiLimiter) {
        app.get('/api/chat/conversations', apiLimiter, (req, res) => {
            res.json({ success: true, conversations: conversations(), unread: unreadCount() });
        });
        app.get('/api/chat/unread', apiLimiter, (req, res) => {
            res.json({ success: true, unread: unreadCount() });
        });
        app.get('/api/chat/status', apiLimiter, (req, res) => {
            const cfg = getConfig();
            res.json({ success: true, enabled: cfg.enabled, whatsapp: wa.status().ready, waNumber: waNumber(), sms: smsReady(cfg), mail: mailStatus() });
        });
        app.get('/api/chat/thread/:conv', apiLimiter, (req, res) => {
            const t = thread(String(req.params.conv), req.query.read !== '0');
            if (!t) return res.status(404).json({ success: false, error: 'Unterhaltung nicht gefunden' });
            res.json({ success: true, thread: t });
        });
        app.post('/api/chat/thread/:conv/send', apiLimiter, async (req, res) => {
            const author = req.session && req.session.user ? (req.session.user.username || req.session.user) : 'Admin';
            try {
                const id = await send(String(req.params.conv), req.body && req.body.text, { channel: req.body && req.body.channel, author: String(author) });
                res.json({ success: true, id });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message, id: e.messageId });
            }
        });
        app.get('/api/chat/thread/:conv/whatsapp', apiLimiter, async (req, res) => {
            const conv = String(req.params.conv);
            if (!getContact(conv)) return res.status(404).json({ success: false, error: 'Unterhaltung nicht gefunden' });
            res.json({ success: true, whatsapp: await checkWhatsApp(conv, req.query.force === '1'), connected: wa.status().ready });
        });
        app.put('/api/chat/thread/:conv/booking', apiLimiter, (req, res) => {
            const conv = String(req.params.conv);
            const c = getContact(conv);
            if (!c) return res.status(404).json({ success: false, error: 'Unterhaltung nicht gefunden' });
            const id = parseInt(req.body && req.body.bookingId, 10) || null;
            const b = id ? bookingById(id) : null;
            if (id && !b) return res.status(404).json({ success: false, error: 'Buchung nicht gefunden' });
            upsertContact(conv, { booking_id: b ? b.id : null, booking_fixed: b ? 1 : 0, name: guestName(b) || c.name });
            if (b && c.phone) rememberPhone(b, c.phone);
            res.json({ success: true });
        });
        app.put('/api/chat/thread/:conv/email', apiLimiter, (req, res) => {
            try {
                const email = setEmail(String(req.params.conv), req.body && req.body.email);
                res.json({ success: true, email });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message });
            }
        });
        app.put('/api/chat/thread/:conv/read', apiLimiter, (req, res) => {
            if (req.body && req.body.unread) {
                const last = sql().prepare("SELECT id FROM guest_chat_messages WHERE conv = ? AND direction = 'in' ORDER BY id DESC LIMIT 1").get(String(req.params.conv));
                if (last) sql().prepare('UPDATE guest_chat_messages SET read_at = NULL WHERE id = ?').run(last.id);
            } else {
                sql().prepare("UPDATE guest_chat_messages SET read_at = CURRENT_TIMESTAMP WHERE conv = ? AND read_at IS NULL").run(String(req.params.conv));
            }
            res.json({ success: true });
        });
        app.delete('/api/chat/thread/:conv', apiLimiter, (req, res) => {
            const conv = String(req.params.conv);
            sql().prepare('SELECT media FROM guest_chat_messages WHERE conv = ? AND media IS NOT NULL').all(conv)
                .forEach(r => { try { fs.unlinkSync(path.join(MEDIA_DIR, path.basename(r.media))); } catch (e) { /* gone */ } });
            sql().prepare('DELETE FROM guest_chat_messages WHERE conv = ?').run(conv);
            sql().prepare('DELETE FROM guest_chat_tg WHERE conv = ?').run(conv);
            sql().prepare('DELETE FROM guest_chat_contacts WHERE conv = ?').run(conv);
            res.json({ success: true });
        });
        app.post('/api/chat/start', apiLimiter, async (req, res) => {
            try {
                const conv = start({ bookingId: parseInt(req.body && req.body.bookingId, 10) || null, phone: req.body && req.body.phone, email: req.body && req.body.email });
                res.json({ success: true, conv, whatsapp: await checkWhatsApp(conv) });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message, needPhone: !!e.needPhone });
            }
        });
        app.get('/api/chat/bookings', apiLimiter, (req, res) => {
            res.json({ success: true, bookings: bookingChoices() });
        });
        app.get('/api/chat/template/:bookingId', apiLimiter, (req, res) => {
            try {
                const r = guestMessage.compose(parseInt(req.params.bookingId, 10), req.query.lang === 'en' ? 'en' : 'de');
                if (!r) return res.status(404).json({ success: false, error: 'Buchung nicht gefunden' });
                res.json({ success: true, text: r.text, warnings: r.warnings || [] });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message });
            }
        });
        app.get('/api/chat/media/:file', apiLimiter, (req, res) => {
            const file = path.basename(String(req.params.file));
            const full = path.join(MEDIA_DIR, file);
            if (!/^[\w.-]+$/.test(file) || !fs.existsSync(full)) return res.status(404).end();
            res.set('Cache-Control', 'private, max-age=86400');
            res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
            res.set('X-Content-Type-Options', 'nosniff');
            if (file.endsWith('.bin')) res.set('Content-Disposition', 'attachment');
            res.sendFile(full);
        });
        app.get('/api/chat/settings', apiLimiter, (req, res) => {
            res.json({ success: true, settings: publicConfig(), hookUrl: hookUrl(), smsReady: smsReady(), waNumber: wa.status().number || '', mail: mailStatus(), smtpUser: (smtpCfg() || {}).user || '' });
        });
        app.put('/api/chat/settings', apiLimiter, (req, res) => {
            saveConfig(req.body || {});
            res.json({ success: true, settings: publicConfig(), hookUrl: hookUrl(), smsReady: smsReady(), mail: mailStatus() });
        });
        app.post('/api/chat/mail/check', apiLimiter, async (req, res) => {
            try {
                const r = await pollMail(true);
                res.json({ success: true, message: r.busy ? 'Das Postfach wird gerade schon abgerufen.' : `Postfach erreichbar.${r.seen ? ` ${r.seen} neue E-Mail(s) gelesen, ${r.added} davon von Gästen.` : ' Keine neuen E-Mails.'}`, mail: mailStatus() });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message, mail: mailStatus() });
            }
        });
        app.post('/api/chat/sms/test', apiLimiter, async (req, res) => {
            try {
                const p = await testSms(req.body && req.body.phone);
                res.json({ success: true, message: `Test-SMS an +${p} übergeben.` });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message });
            }
        });
        app.post('/api/chat/sms/webhook', apiLimiter, async (req, res) => {
            try {
                const url = await registerHook();
                res.json({ success: true, message: 'Eingehende SMS sind eingerichtet.', url });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message });
            }
        });
    }

    return { router, registerAdminRoutes, receiveWhatsApp, recordOwnWhatsApp, checkWhatsApp, handleTelegramReply, guestButton, start, send, sendToBooking, channelStatus, setEmail, normPhone, _internal: { pickBooking, bookingsForPhone, bookingsForEmail, receive, handleMail, guestAddress, pollMail } };
}

module.exports = createGuestChat;
module.exports.normPhone = normPhone;
module.exports.normEmail = normEmail;
module.exports.stripQuoted = stripQuoted;
