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
 *  - Settings live in the server-only setting 'guest_chat' (never in /api/settings), the SMS password is masked.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEDIA_DIR = path.join(__dirname, 'uploads', 'chat');
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 4000;
const SMS_MAX_TEXT = 1530; // 10 concatenated parts
const CODE_RE = /\bBH-?([A-Z0-9]{6})\b/i;
const MASK = '••••••••';
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
    }
};

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

function createGuestChat({ express, rateLimit, db, botLogic, getSite, berlinToday, guestMessage, push, wa, telegram, formatDateDE }) {
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

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------
    function getConfig() {
        const s = db.getSetting('guest_chat');
        const c = s && typeof s === 'object' ? s : {};
        const cfg = { ...DEFAULTS, ...c, sms: { ...DEFAULTS.sms, ...(c.sms || {}) } };
        if (!cfg.sms.secret) {
            cfg.sms.secret = crypto.randomBytes(18).toString('base64url');
            db.setSetting('guest_chat', cfg);
        }
        return cfg;
    }

    function publicConfig() {
        const c = getConfig();
        return { ...c, sms: { ...c.sms, password: c.sms.password ? MASK : '', secret: undefined } };
    }

    function saveConfig(inp) {
        const old = getConfig();
        const s = inp.sms || {};
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
            }
        };
        db.setSetting('guest_chat', cfg);
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

    // -----------------------------------------------------------------------
    // Store
    // -----------------------------------------------------------------------
    const getContact = conv => sql().prepare('SELECT * FROM guest_chat_contacts WHERE conv = ?').get(conv);

    function upsertContact(conv, fields) {
        const c = getContact(conv);
        if (!c) {
            sql().prepare('INSERT INTO guest_chat_contacts (conv, phone, name, wa_chat, booking_id, booking_fixed, last_channel, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .run(conv, fields.phone || null, fields.name || null, fields.wa_chat || null, fields.booking_id || null, fields.booking_fixed ? 1 : 0, fields.last_channel || null, fields.last_at || null);
        } else {
            const m = { ...c, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
            sql().prepare('UPDATE guest_chat_contacts SET phone = ?, name = ?, wa_chat = ?, booking_id = ?, booking_fixed = ?, last_channel = ?, last_at = ? WHERE conv = ?')
                .run(m.phone || null, m.name || null, m.wa_chat || null, m.booking_id || null, m.booking_fixed ? 1 : 0, m.last_channel || null, m.last_at || null, conv);
        }
        return getContact(conv);
    }

    function addMessage(m) {
        const r = sql().prepare(`INSERT INTO guest_chat_messages (conv, channel, direction, body, media, media_type, ext_id, author, status, error, read_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.conv, m.channel, m.direction, m.body || '', m.media || null, m.media_type || null,
            m.ext_id || null, m.author || null, m.status || null, m.error || null, m.direction === 'out' ? new Date().toISOString() : null);
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
        const who = contact.name || ('+' + (contact.phone || '?'));
        const icon = channel === 'sms' ? '📱 SMS' : '💬 WhatsApp';
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
    async function receive({ channel, phone, waChat, name, body, media, mediaType, extId }) {
        const cfg = getConfig();
        if (!cfg.enabled) return false;
        const conv = phone || (waChat ? 'wa:' + String(waChat).replace(/@.*$/, '') : '');
        if (!conv) return false;
        if (extId && sql().prepare('SELECT 1 FROM guest_chat_messages WHERE ext_id = ? AND channel = ?').get(extId, channel)) return false;

        let contact = getContact(conv);
        let booking = null;
        if (!contact || !contact.booking_fixed) {
            booking = bookingByCode(body) || pickBooking(bookingsForPhone(phone));
            if (booking && bookingByCode(body)) rememberPhone(booking, phone);
        }
        const bookingId = booking ? booking.id : (contact ? contact.booking_id : null);
        const realName = guestName(booking || bookingById(bookingId));
        if (channel === 'wa') sql().prepare("UPDATE guest_chat_contacts SET wa_status = 'yes' WHERE conv = ?").run(conv);
        contact = upsertContact(conv, {
            phone: phone || (contact && contact.phone) || null,
            name: realName || (contact && contact.name) || name || null,
            wa_chat: waChat || undefined,
            booking_id: bookingId,
            last_channel: channel,
            last_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
        });
        addMessage({ conv, channel, direction: 'in', body: String(body || '').slice(0, MAX_TEXT), media, media_type: mediaType, ext_id: extId, status: 'received' });
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
    // Does the number have WhatsApp? Checked before the first WhatsApp message to a number.
    // 'yes' | 'no' | 'unknown' (WhatsApp not connected or the check failed). A 'no' is checked again after a day.
    // -----------------------------------------------------------------------
    async function checkWhatsApp(conv, force = false) {
        const c = getContact(conv);
        if (!c) return 'unknown';
        if (c.wa_chat) return 'yes';
        if (!c.phone) return 'no';
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
        const ch = channel === 'sms' ? 'sms' : channel === 'wa' ? 'wa' : (contact.last_channel || (contact.wa_status === 'no' ? 'sms' : 'wa'));
        let extId = null, error = null;
        try {
            if (ch === 'sms') {
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
        const id = addMessage({ conv, channel: ch, direction: 'out', body: text, ext_id: extId, author, status: error ? 'failed' : 'sent', error });
        if (error) { const err = new Error(error); err.messageId = id; throw err; }
        // Answering counts as reading
        sql().prepare("UPDATE guest_chat_messages SET read_at = CURRENT_TIMESTAMP WHERE conv = ? AND read_at IS NULL").run(conv);
        return id;
    }

    /** Start (or reopen) a conversation for a booking or a typed number. Returns the conversation key. */
    function start({ bookingId, phone }) {
        let b = bookingId ? bookingById(bookingId) : null;
        let p = normPhone(phone);
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
                const err = new Error('Für diese Buchung ist keine Telefonnummer bekannt. Bitte die Nummer eingeben.');
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
            await bot.sendMessage(msg.chat.id, `✅ Per ${m.channel === 'sms' ? 'SMS' : 'WhatsApp'} an den Gast gesendet.`, { reply_to_message_id: msg.message_id });
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
            conv: r.conv, phone: r.phone, name: r.name, unread: r.unread, lastAt: r.last_at || r.created_at,
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
            id: m.id, channel: m.channel, direction: m.direction, body: m.body, author: m.author, status: m.status, error: m.error,
            at: m.created_at, media: m.media ? `/api/chat/media/${encodeURIComponent(m.media)}` : null, mediaType: m.media_type
        }));
        const b = bookingById(c.booking_id);
        return {
            conv, phone: c.phone, name: c.name, bookingFixed: !!c.booking_fixed, lastChannel: c.last_channel || 'wa',
            whatsapp: c.wa_chat ? 'yes' : (c.wa_status || 'unknown'), booking: bookingInfo(b), messages
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
            res.json({ success: true, enabled: cfg.enabled, whatsapp: wa.status().ready, waNumber: waNumber(), sms: smsReady(cfg) });
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
                const conv = start({ bookingId: parseInt(req.body && req.body.bookingId, 10) || null, phone: req.body && req.body.phone });
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
            res.json({ success: true, settings: publicConfig(), hookUrl: hookUrl(), smsReady: smsReady(), waNumber: wa.status().number || '' });
        });
        app.put('/api/chat/settings', apiLimiter, (req, res) => {
            saveConfig(req.body || {});
            res.json({ success: true, settings: publicConfig(), hookUrl: hookUrl(), smsReady: smsReady() });
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

    return { router, registerAdminRoutes, receiveWhatsApp, recordOwnWhatsApp, checkWhatsApp, handleTelegramReply, guestButton, start, send, normPhone, _internal: { pickBooking, bookingsForPhone, receive } };
}

module.exports = createGuestChat;
module.exports.normPhone = normPhone;
