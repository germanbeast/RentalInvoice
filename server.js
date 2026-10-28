/* ===========================
   Ferienwohnung Rechnung – Server (Hardened + SQLite)
   =========================== */

const { exec } = require('child_process');
const express = require('express');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const ical = require('node-ical');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const multer = require('multer');
const db = require('./db');
const waCommands = require('./wa-commands');
const tgCommands = require('./tg-commands');
const TelegramBot = require('node-telegram-bot-api');
const packageJson = require('./package.json');
const { renderEstateReportHtml } = require('./estate-report-template');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads', 'estate');
const CERTS_DIR = path.join(__dirname, 'uploads', 'certs');

// Ensure uploads directories exist
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(CERTS_DIR)) {
    fs.mkdirSync(CERTS_DIR, { recursive: true });
}

// Configure Multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|pdf|gif/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
            return cb(null, true);
        } else {
            cb(new Error('Nur Bilder (JPEG, PNG, GIF) und PDFs erlaubt'));
        }
    }
});

// Configure Multer for certificate uploads
const certStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, CERTS_DIR);
    },
    filename: (req, file, cb) => {
        // Always overwrite with fixed name
        cb(null, 'paperless-cert.pem');
    }
});

const uploadCert = multer({
    storage: certStorage,
    limits: { fileSize: 1024 * 1024 }, // 1MB limit for certs
    fileFilter: (req, file, cb) => {
        const allowedTypes = /pem|crt|cer/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        if (extname || file.mimetype === 'application/x-pem-file' || file.mimetype === 'application/x-x509-ca-cert') {
            return cb(null, true);
        } else {
            cb(new Error('Nur Zertifikate (.pem, .crt, .cer) erlaubt'));
        }
    }
});

// =======================
// Helper: Create HTTPS Agent with Custom Certificate
// =======================
function createPaperlessHttpsAgent() {
    const certPath = path.join(CERTS_DIR, 'paperless-cert.pem');

    // Always disable certificate validation for Paperless (works with Cloudflare Origin Certs)
    // If custom cert exists, try to use it, but still disable validation as fallback
    if (fs.existsSync(certPath)) {
        try {
            const ca = fs.readFileSync(certPath);
            return new https.Agent({
                ca: ca,
                rejectUnauthorized: false  // Changed: allow even with custom cert (for Cloudflare)
            });
        } catch (err) {
            console.error('⚠️  Fehler beim Laden des Paperless-Zertifikats:', err.message);
        }
    }

    // No cert file or error - disable validation (works with self-signed/Cloudflare certs)
    return new https.Agent({
        rejectUnauthorized: false
    });
}

// =======================
// 1. DATABASE INIT
// =======================
db.init();

// =======================
// 1b. WhatsApp Web Client
// =======================
let waClient = null;
let waQrCode = null;
let waReady = false;
let waStatus = 'disconnected'; // disconnected, qr_pending, connecting, ready

function initWhatsApp() {
    waClient = new Client({
        authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        }
    });

    waClient.on('qr', async (qr) => {
        waStatus = 'qr_pending';
        waQrCode = await qrcode.toDataURL(qr);
        console.log('\ud83d\udcf1 WhatsApp QR-Code bereit. Bitte in der App scannen.');
    });

    waClient.on('ready', () => {
        waReady = true;
        waStatus = 'ready';
        waQrCode = null;
        console.log('\u2705 WhatsApp Web verbunden!');
    });

    waClient.on('message', async (msg) => {
        // Log incoming message
        if (msg.body) {
            console.log(`📩 [WA] Nachricht von ${msg.from}: "${msg.body.substring(0, 50)}..."`);
        }

        try {
            // STRICT LOOP PROTECTION: Never process messages sent by the bot account itself.
            // This prevents the bot from responding to its own messages (Spam Loop).
            if (msg.fromMe) {
                return;
            }

            await waCommands.processMessage(msg, waClient, MessageMedia);
        } catch (e) {
            console.error('❌ Fehler in waCommands.processMessage:', e);
        }
    });

    waClient.on('authenticated', () => {
        waStatus = 'connecting';
        console.log('\ud83d\udd10 WhatsApp authentifiziert, lade Session...');
    });

    waClient.on('auth_failure', (msg) => {
        waReady = false;
        waStatus = 'disconnected';
        console.error('\u274c WhatsApp Auth-Fehler:', msg);
    });

    waClient.on('disconnected', (reason) => {
        waReady = false;
        waStatus = 'disconnected';
        waQrCode = null;
        console.warn('\u26a0\ufe0f  WhatsApp getrennt:', reason);
        // Auto-reconnect after 30s
        setTimeout(() => {
            console.log('\ud83d\udd04 WhatsApp Reconnect...');
            waClient.initialize().catch(e => console.error('WA Reconnect Error:', e.message));
        }, 30000);
    });

    waClient.initialize().catch(e => {
        console.error('\u274c WhatsApp init fehlgeschlagen:', e.message);
        waStatus = 'disconnected';
    });
}

async function sendWhatsApp(phone, message) {
    if (!waReady || !waClient) {
        console.warn('\u26a0\ufe0f  WhatsApp nicht verbunden');
        return false;
    }
    try {
        let cleaned = phone.replace(/[^\d]/g, '');
        // Automatische Konvertierung von dt. Nummern (z.B. 0176 -> 49176)
        if (cleaned.startsWith('0') && !cleaned.startsWith('00')) {
            cleaned = '49' + cleaned.substring(1);
        }
        const chatId = cleaned + '@c.us';
        await waClient.sendMessage(chatId, message);
        console.log(`\u2709\ufe0f  WhatsApp gesendet an ${phone}: ${message.substring(0, 50)}...`);
        return true;
    } catch (e) {
        console.error('\u274c WhatsApp-Fehler:', e.message);
        return false;
    }
}

// =======================
// 1c. Telegram Bot
// =======================
let currentTgToken = null;
let tgBot = null; // Define tgBot here

async function initTelegram() {
    const allSettings = db.getAllSettings();
    const token = allSettings.tg_token;

    if (!token) {
        if (tgBot) {
            try { await tgBot.stopPolling(); } catch (e) { }
            tgBot = null;
            currentTgToken = null;
        }
        console.warn('⚠️ Telegram Token nicht konfiguriert. Telegram Bot wird nicht gestartet.');
        return;
    }

    // Skip if already running with same token
    if (tgBot && token === currentTgToken) {
        return;
    }

    // Stop existing bot if running
    if (tgBot) {
        try {
            console.log('⏳ Stoppe alte Telegram Bot Instanz...');
            await tgBot.stopPolling();
        } catch (e) { }
    }

    try {
        currentTgToken = token;
        tgBot = new TelegramBot(token, { polling: true });
        console.log('✅ Telegram Bot initialisiert (Polling).');

        tgBot.on('message', (msg) => {
            tgCommands.processMessage(tgBot, msg).catch(e => {
                console.error('❌ Fehler in tgCommands.processMessage:', e);
            });
        });

        // Inline-Buttons (callback_query) + "/"-Befehlsmenü registrieren
        tgCommands.setup(tgBot, { syncCalendars: () => runIcalSync({ manual: true }) }).catch(e => console.error('❌ Fehler in tgCommands.setup:', e));

        tgBot.on('polling_error', (error) => {
            if (error.code === 'ETELEGRAM' && error.message.includes('401')) {
                console.error('❌ Telegram Token ungültig (401). Polling gestoppt.');
                tgBot.stopPolling();
            } else {
                console.error('⚠️ Telegram Polling Fehler:', error.message);
            }
        });
    } catch (e) {
        console.error('❌ Telegram Bot konnte nicht gestartet werden:', e.message);
    }
}

async function sendTelegram(chatId, message, replyMarkup) {
    if (!tgBot) return false;
    try {
        try {
            await tgBot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
        } catch (mdErr) {
            // e.g. names containing _ or * break Markdown parsing -> resend as plain text
            await tgBot.sendMessage(chatId, message.replace(/[*_`]/g, ''), replyMarkup ? { reply_markup: replyMarkup } : {});
        }
        console.log(`✉️ Telegram gesendet an ${chatId}`);
        return true;
    } catch (e) {
        console.error('❌ Telegram Fehler:', e.message);
        return false;
    }
}

// Send to all configured notification recipients
async function sendToAllRecipients(message, opts = {}) {
    const allSettings = db.getAllSettings();
    let anySent = false;

    // WhatsApp Notifications
    let phones = [];
    const rawPhones = allSettings.wa_phones;
    if (Array.isArray(rawPhones)) {
        phones = rawPhones;
    } else {
        try { phones = JSON.parse(rawPhones || '[]'); } catch (e) {
            if (allSettings.wa_phone) phones = [allSettings.wa_phone];
        }
    }
    for (const phone of phones) {
        if (phone && String(phone).trim()) {
            if (await sendWhatsApp(String(phone).trim(), message)) anySent = true;
        }
    }

    // Telegram Notifications
    let tgIds = [];
    const rawTgIds = allSettings.tg_ids;
    if (Array.isArray(rawTgIds)) {
        tgIds = rawTgIds.map(String);
    } else {
        try { tgIds = JSON.parse(rawTgIds || '[]'); } catch (e) {
            if (allSettings.tg_id) tgIds = [allSettings.tg_id];
        }
    }
    for (const id of tgIds) {
        if (id && String(id).trim()) {
            if (await sendTelegram(String(id).trim(), message, opts.tgKeyboard)) anySent = true;
        }
    }

    return anySent;
}

// 2FA Code Storage (in-memory, short-lived)
const pending2FA = new Map(); // sessionId -> { code, username, expiresAt }

// =======================
// 1c. SCHEDULED JOBS (Cron)
// =======================
// iCal all-day events (VALUE=DATE) are parsed by node-ical as local midnight. Calling
// toISOString() on them shifts the date one day back on servers west of UTC+0 (e.g. Europe/Berlin).
function icalDateToYmd(d) {
    if (!d) return null;
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return null;
    if (d.dateOnly) {
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, '0');
        const day = String(dt.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
}

// Adjust the validity period of an existing Nuki keypad code
async function updateNukiPinDates(authId, arrival, departure) {
    await require('./bot-logic').updateNukiAuth(authId, {
        allowedFromDate: `${arrival}T15:00:00.000Z`,
        allowedUntilDate: `${departure}T11:00:00.000Z`
    });
}

function formatDateDE(dateStr) {
    if (!dateStr) return '\u2014';
    const d = new Date(dateStr);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Job 1: iCal Polling (every 15 minutes) - Booking.com and Airbnb feeds
function getIcalFeeds(allSettings) {
    const feeds = [];
    const clean = v => (typeof v === 'string' ? v.trim() : '');
    if (clean(allSettings.booking_ical)) feeds.push({ source: 'Booking.com', url: clean(allSettings.booking_ical) });
    if (clean(allSettings.airbnb_ical)) feeds.push({ source: 'Airbnb', url: clean(allSettings.airbnb_ical) });
    return feeds;
}

const bookingMonitor = require('./booking-monitor')({
    db,
    axios,
    deleteNukiPin: (authId) => deleteNukiPin(authId),
    botLogic: require('./bot-logic'),
    formatDateDE: (d) => formatDateDE(d),
    notify: async (msg, type) => {
        const sent = await sendToAllRecipients(msg);
        db.logNotification(type, msg, sent ? 'sent' : 'failed');
    }
});

async function pollIcalFeed(feed, todayYmd, adjusted) {
    const response = await axios.get(feed.url, {
        timeout: 10000,
        maxContentLength: 5 * 1024 * 1024,
        headers: { 'User-Agent': 'RentalInvoice/1.0' }
    });
    // A calendar feed must be an iCal document - an error page or login redirect must never count as "no bookings"
    if (typeof response.data !== 'string' || !response.data.includes('BEGIN:VCALENDAR')) {
        throw new Error('Antwort ist kein iCal-Kalender (Link prüfen)');
    }
    const data = ical.parseICS(response.data);
    let newCount = 0;
    let events = 0;
    const seen = new Set();

    for (const k in data) {
        if (!data.hasOwnProperty(k)) continue;
        const ev = data[k];
        if (ev.type !== 'VEVENT' || !ev.uid) continue;
        events++;
        seen.add(ev.uid);

        const rawSummary = String(ev.summary || 'Buchung').substring(0, 500);
        // Airbnb exports blocked dates as "Airbnb (Not available)" - only "Reserved" are real stays
        if (feed.source === 'Airbnb' && /not available/i.test(rawSummary)) continue;

        const checkin = icalDateToYmd(ev.start);
        const checkout = icalDateToYmd(ev.end);
        if (!checkin || !checkout) continue;
        const summary = feed.source === 'Airbnb' ? `Airbnb: ${rawSummary}` : rawSummary;

        const existing = db.getBookingByUid(ev.uid);
        // A direct booking from the guest website imported into the portal comes back as a block with the
        // exact same dates -> that is our own booking, not a new stay (no second door code)
        if (!existing && db.getDb().prepare("SELECT 1 FROM bookings WHERE source = 'Direkt' AND checkin = ? AND checkout = ?").get(checkin, checkout)) continue;
        const result = db.upsertBooking({
            uid: ev.uid,
            summary,
            checkin,
            checkout,
            description: String(ev.description || '').substring(0, 2000),
            source: feed.source
        });

        // Existing booking whose dates changed (booking modified, or corrected date parsing):
        // keep the already created door code in sync with the new period.
        if (existing && existing.nuki_auth_id && checkout >= todayYmd &&
            (existing.checkin !== checkin || existing.checkout !== checkout)) {
            try {
                await updateNukiPinDates(existing.nuki_auth_id, checkin, checkout);
                adjusted.push(`${summary.split('(')[0].trim()}: ${formatDateDE(checkin)} – ${formatDateDE(checkout)}`);
            } catch (ue) {
                console.warn(`⚠️ Nuki-Zeitraum für Buchung ${existing.id} konnte nicht angepasst werden:`, ue.message);
            }
        }

        if (result.inserted && !existing) {
            // Stays that are already over (old entries in a freshly connected feed) get no code and no message
            if (checkout < todayYmd) continue;
            newCount++;

            // --- Brand New: Auto-Nuki PIN for iCal ---
            let pinMsg = '';
            let needsName = false;
            try {
                // Booking.com: guess guest name from summary (e.g., "Mustermann, Max (12345)")
                // Airbnb: no guest name in the feed -> unique placeholder per stay
                const guessedName = summary.split('(')[0].trim().replace('Buchung:', '').trim();
                const hasRealName = guessedName && !/not available|closed|reserved/i.test(guessedName);
                needsName = feed.source === 'Airbnb' || !hasRealName;
                const guestName = feed.source === 'Airbnb'
                    ? `Airbnb ${formatDateDE(checkin).slice(0, 6)}`
                    : (hasRealName ? guessedName : `Booking ${formatDateDE(checkin).slice(0, 6)}`);

                // Create Nuki PIN
                const nukiResult = await createNukiPin(checkin, checkout, guestName);

                if (nukiResult.success) {
                    // Find or create guest to link them
                    const guest = db.findOrCreateGuest(guestName, null, null);

                    // Update booking with PIN and GuestID
                    db.updateBookingNukiData(result.id, nukiResult.pin, nukiResult.authId);
                    // Also link guest_id
                    db.getDb().prepare('UPDATE bookings SET guest_id = ? WHERE id = ?').run(guest.id, result.id);

                    pinMsg = `\n🔑 Tür-Code: *${nukiResult.pin}*`;
                }
            } catch (ne) {
                console.warn('⚠️ Auto-Nuki PIN fehlgeschlagen:', ne.message);
            }

            const msg = `🏠 *Neue Buchung (${feed.source})!*\n${summary}\n📅 ${formatDateDE(checkin)} – ${formatDateDE(checkout)}${pinMsg}`;
            // Calendars rarely contain the guest name -> offer to add it right from the Telegram message
            const tgKeyboard = needsName
                ? { inline_keyboard: [[{ text: '👤 Namen eintragen', callback_data: `nm:${result.id}` }]] }
                : undefined;
            const sent = await sendToAllRecipients(msg, { tgKeyboard });
            db.logNotification('new_booking', msg, sent ? 'sent' : 'failed');
        }
    }
    return { newCount, events, seen };
}

let icalSyncRunning = false;

/**
 * Polls all configured calendars (Booking.com, Airbnb).
 * manual=true ignores the "notifications disabled" switch (used by the manual sync button / Telegram /sync).
 * Returns { busy, noFeeds, disabled, feeds:[{source, ok, events, newCount, error}], newCount, adjusted }
 */
async function runIcalSync({ manual = false } = {}) {
    if (icalSyncRunning) return { busy: true, feeds: [], newCount: 0, adjusted: [] };
    icalSyncRunning = true;
    try {
        const allSettings = db.getAllSettings();
        const feeds = getIcalFeeds(allSettings);
        if (feeds.length === 0) return { noFeeds: true, feeds: [], newCount: 0, adjusted: [] };
        if (!manual && allSettings.notifications_enabled === 'false') return { disabled: true, feeds: [], newCount: 0, adjusted: [] };

        console.log(`\ud83d\udcc5 iCal-Polling l\u00e4uft${manual ? ' (manuell)' : ''}...`);
        const adjusted = [];
        const todayYmd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
        const results = [];
        let newCount = 0;

        // Each feed is isolated: an error in one calendar does not stop the other
        for (const feed of feeds) {
            try {
                const r = await pollIcalFeed(feed, todayYmd, adjusted);
                newCount += r.newCount;
                let cancelled = 0;
                try {
                    cancelled = (await bookingMonitor.processMissing(feed.source, r.seen)).cancelled || 0;
                } catch (me) {
                    console.error(`\u274c Storno-Erkennung (${feed.source}) Fehler:`, me.message);
                }
                results.push({ source: feed.source, ok: true, events: r.events, newCount: r.newCount, cancelled });
            } catch (fe) {
                console.error(`\u274c iCal-Polling (${feed.source}) Fehler:`, fe.message);
                results.push({ source: feed.source, ok: false, error: fe.message });
            }
        }

        try {
            await bookingMonitor.checkOverlaps();
        } catch (oe) {
            console.error('\u274c Doppelbuchungs-Prüfung Fehler:', oe.message);
        }

        if (adjusted.length > 0) {
            const adjMsg = `🔧 *Tür-Code-Zeitraum angepasst*\n${adjusted.map(a => '• ' + a).join('\n')}`;
            const adjSent = await sendToAllRecipients(adjMsg);
            db.logNotification('booking_adjusted', adjMsg, adjSent ? 'sent' : 'failed');
        }

        if (newCount > 0) {
            console.log(`\ud83c\udf89 ${newCount} neue Buchung(en) erkannt und benachrichtigt.`);
        }
        try {
            db.setSetting('ical_last_sync', { at: new Date().toISOString(), manual, feeds: results });
        } catch (se) { /* status only */ }
        return { feeds: results, newCount, adjusted };
    } finally {
        icalSyncRunning = false;
    }
}

cron.schedule('*/15 * * * *', () => {
    runIcalSync().catch(e => console.error('\u274c iCal-Polling Fehler:', e.message));
});

// Job 1b: delete expired door codes from the Nuki lock (hourly, plus once shortly after start)
//
// Nuki answers DELETE with 204 as soon as the *server* accepted the request; the entry stays in the
// list until the lock itself has synced the deletion. Therefore a delete is requested only once,
// remembered (setting `nuki_delete_requests`), retried after RETRY_MS and only reported again as
// "stuck" if the lock still has not removed it after STUCK_MS.
const NUKI_DELETE_RETRY_MS = 6 * 60 * 60 * 1000;
const NUKI_DELETE_STUCK_MS = 24 * 60 * 60 * 1000;
const NUKI_DELETE_FORGET_MS = 30 * 24 * 60 * 60 * 1000;

async function cleanupExpiredNukiCodes() {
    const settings = db.getAllSettings();
    const nuki = settings.nuki;
    if (!nuki || !nuki.token || !nuki.lockId) return { deleted: [], stuck: [], failed: 0, confirmed: 0 };

    const lockId = parseInt(nuki.lockId, 10) || nuki.lockId;
    const listRes = await axios.get(`https://api.nuki.io/smartlock/${lockId}/auth`, {
        headers: { 'Authorization': `Bearer ${nuki.token}`, 'Accept': 'application/json' },
        timeout: 15000
    });
    const auths = Array.isArray(listRes.data) ? listRes.data : [];

    const now = Date.now();
    const todayYmd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
    const rawState = settings.nuki_delete_requests;
    const state = rawState && typeof rawState === 'object' ? { ...rawState } : {};
    const deleted = [];
    const stuck = [];
    let failed = 0;
    let confirmed = 0;

    // Requests the lock has completed (entry gone from the list) -> mark them done. They are kept for a
    // while because Nuki Web sometimes lists an already deleted code again; such a reappearing entry is
    // then only deleted again silently instead of being reported as a new expired code over and over.
    const liveIds = new Set(auths.map(a => String(a.id)));
    const liveCodes = new Set(auths.filter(a => a.code !== undefined && a.code !== null && String(a.code) !== '').map(a => String(a.code)));
    for (const id of Object.keys(state)) {
        const req = state[id];
        if (liveIds.has(id)) continue;
        if (!req || typeof req !== 'object') { delete state[id]; continue; }
        if (!req.gone) { req.gone = now; confirmed++; }
        else if (now - req.gone >= NUKI_DELETE_FORGET_MS) delete state[id];
    }

    for (const a of auths) {
        // Only keypad codes created by this system ("Gast: ...") whose validity has ended.
        // Codes without an end date or with other names (e.g. cleaning staff) are never touched.
        if (a.type !== 13 || !a.allowedUntilDate || !/^gast|^airbnb/i.test(String(a.name || ''))) continue;
        if (new Date(a.allowedUntilDate).getTime() >= now) continue;

        // Cross-check with the synced iCal booking: never delete while the booking still runs or lies ahead
        const booking = db.getDb().prepare(
            "SELECT id, checkout FROM bookings WHERE nuki_auth_id = ? OR (? != '' AND nuki_pin = ?) LIMIT 1"
        ).get(String(a.id), String(a.code || ''), String(a.code || ''));
        if (booking && booking.checkout && booking.checkout > todayYmd) continue;

        const key = String(a.id);
        const req = state[key];
        const label = `${a.name} (bis ${formatDateDE(a.allowedUntilDate)})`;

        if (req) {
            // Delete already requested - waiting for the lock to sync (or the entry showed up again)
            if (req.gone) { delete req.gone; req.ts = now; req.warned = true; }
            if (now - req.ts >= NUKI_DELETE_STUCK_MS && !req.warned) {
                req.warned = true;
                stuck.push(label);
            }
            if (now - (req.lastTry || req.ts) < NUKI_DELETE_RETRY_MS) continue;
            try {
                await deleteNukiPin(a.id);
                req.lastTry = now;
            } catch (re) {
                req.lastTry = now;
                console.warn(`⚠️ Erneutes Löschen von Nuki-Code ${a.id} fehlgeschlagen:`, re.message);
            }
            continue;
        }

        try {
            await deleteNukiPin(a.id);
            state[key] = { ts: now, lastTry: now };
            if (booking) {
                db.clearNukiAuth(booking.id);
                db.getDb().prepare('UPDATE bookings SET nuki_pin = NULL WHERE id = ?').run(booking.id);
            }
            deleted.push(label);
            await new Promise(r => setTimeout(r, 500)); // be gentle with the Nuki API
        } catch (de) {
            failed++;
            console.warn(`⚠️ Nuki-Code ${a.id} konnte nicht gelöscht werden:`, de.message);
        }
    }

    // Past bookings whose code is no longer present in Nuki (deleted by hand or by the lock): drop the
    // stale reference. Also covers bookings that only kept the PIN (authId lookup failed on creation),
    // which otherwise stayed visible as "door code" forever.
    const stale = db.getDb().prepare(
        `SELECT id, nuki_auth_id, nuki_pin FROM bookings
         WHERE ((nuki_auth_id IS NOT NULL AND nuki_auth_id != '') OR (nuki_pin IS NOT NULL AND nuki_pin != ''))
           AND checkout < ?`
    ).all(todayYmd);
    for (const b of stale) {
        const authLive = b.nuki_auth_id && liveIds.has(String(b.nuki_auth_id));
        const pinLive = !b.nuki_auth_id && b.nuki_pin && liveCodes.has(String(b.nuki_pin));
        if (!authLive && !pinLive) {
            db.clearNukiAuth(b.id);
            db.getDb().prepare('UPDATE bookings SET nuki_pin = NULL WHERE id = ?').run(b.id);
        }
    }

    if (JSON.stringify(state) !== JSON.stringify(rawState || {})) db.setSetting('nuki_delete_requests', state);
    return { deleted, stuck, failed, confirmed };
}

async function runNukiCleanup() {
    try {
        const { deleted, stuck, failed, confirmed } = await cleanupExpiredNukiCodes();
        if (confirmed > 0) console.log(`✅ ${confirmed} Nuki-Code(s) vom Schloss entfernt (Löschung bestätigt).`);
        if (deleted.length > 0) {
            console.log(`🧹 Löschung von ${deleted.length} abgelaufenen Nuki-Code(s) angefordert.`);
            const msg = `🧹 *${deleted.length} abgelaufene${deleted.length === 1 ? 'r Türcode wird' : ' Türcodes werden'} gelöscht*\n${deleted.map(d => '• ' + d).join('\n')}\n_Nuki entfernt sie, sobald das Schloss synchronisiert hat. Die Codes sind bereits abgelaufen und nicht mehr nutzbar._`;
            const sent = await sendToAllRecipients(msg);
            db.logNotification('nuki_cleanup', msg, sent ? 'sent' : 'failed');
        }
        if (stuck.length > 0) {
            const msg = `⚠️ *Türcode nach 24 Stunden noch im Schloss*\n${stuck.map(d => '• ' + d).join('\n')}\nNuki konnte die Löschung noch nicht ausführen (Schloss/Bridge offline?). Bitte ggf. in der Nuki-App löschen. Der Code ist abgelaufen und nicht mehr nutzbar.`;
            const sent = await sendToAllRecipients(msg);
            db.logNotification('nuki_cleanup_stuck', msg, sent ? 'sent' : 'failed');
        }
        if (failed > 0) console.warn(`⚠️ ${failed} Nuki-Code(s) konnten nicht gelöscht werden (nächster Versuch in 1 Stunde).`);
    } catch (e) {
        console.error('❌ Nuki-Cleanup Fehler:', e.message);
    }
}

cron.schedule('10 * * * *', runNukiCleanup);

// Job 1c: detect first use of a guest's door code (every 10 minutes)
cron.schedule('*/10 * * * *', () => {
    bookingMonitor.checkArrivals().catch(e => console.error('\u274c Anreise-Erkennung Fehler:', e.message));
});
setTimeout(runNukiCleanup, 90 * 1000);

// Job 2: Reminder Check (daily at 08:00)
cron.schedule('0 8 * * *', async () => {
    try {
        console.log('🧹 Nuki-Cleanup & Reminder Job läuft...');

        // 1. Expired Nuki codes are deleted by the hourly cleanup job (runNukiCleanup)
        await runNukiCleanup();

        // 2. Reminders (existing logic)
        // ...
        try {
            const allSettings = db.getAllSettings();
            const waPhone = allSettings.wa_phone;
            const notifyEnabled = allSettings.notifications_enabled;
            const reminderDays = parseInt(allSettings.reminder_days) || 2;

            if (notifyEnabled === 'false') return;

            console.log('\u23f0 Erinnerungs-Check l\u00e4uft...');
            const upcoming = db.getUpcomingBookings(reminderDays);

            for (const booking of upcoming) {
                const msg = `\u23f0 Erinnerung: ${booking.summary || 'Gast'} reist bald an!\n\ud83d\udcc5 Anreise: ${formatDateDE(booking.checkin)}\n\ud83d\udcc5 Abreise: ${formatDateDE(booking.checkout)}`;
                const sent = await sendToAllRecipients(msg);
                if (sent) {
                    db.markReminderSent(booking.id);
                }
                db.logNotification('reminder', msg, sent ? 'sent' : 'failed');
            }

            if (upcoming.length > 0) {
                console.log(`\u23f0 ${upcoming.length} Erinnerung(en) versendet.`);
            }
        } catch (e) {
            console.error('\u274c Reminder-Check Fehler:', e.message);
        }
    } catch (e) {
        console.error('\u274c Cron Job 2 Fehler:', e.message);
    }
});

// =======================
// Nuki Helpers
// =======================
async function createNukiPin(arrival, departure, guestName) {
    const allSettings = db.getAllSettings();
    const nuki = allSettings.nuki;

    if (!nuki || !nuki.token || !nuki.lockId) throw new Error('Nuki-Zugangsdaten fehlen');

    // Generate a random 6-digit PIN (1-9 only, no 0 allowed!)
    const generateValidPin = () => {
        let pin;
        do {
            pin = Array.from({ length: 6 }, () => Math.floor(Math.random() * 9) + 1).join('');
        } while (pin.startsWith('12'));
        return pin;
    };
    const generatedCode = generateValidPin();

    const allowedFrom = `${arrival}T15:00:00.000Z`;
    const allowedUntil = `${departure}T11:00:00.000Z`;
    const safeName = `Gast: ${guestName || 'Gast'}`.substring(0, 20);

    const lockId = parseInt(nuki.lockId, 10) || nuki.lockId;
    await axios.put('https://api.nuki.io/smartlock/auth', {
        name: safeName,
        allowedFromDate: allowedFrom,
        allowedUntilDate: allowedUntil,
        allowedWeekDays: 127,
        allowedFromTime: 0,
        allowedUntilTime: 0,
        type: 13, // Keypad code
        code: generatedCode,
        smartlockIds: [lockId]
    }, {
        headers: {
            'Authorization': `Bearer ${nuki.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    });

    // Nuki API returns 204 No Content — no authId in response body.
    // Wait briefly then fetch the auth list to find the newly created entry by PIN code.
    let authId = null;
    try {
        await new Promise(r => setTimeout(r, 2000));
        const listRes = await axios.get(`https://api.nuki.io/smartlock/${lockId}/auth`, {
            headers: { 'Authorization': `Bearer ${nuki.token}`, 'Accept': 'application/json' }
        });
        const auths = Array.isArray(listRes.data) ? listRes.data : [];
        const match = auths.find(a => String(a.code) === String(generatedCode));
        if (match) authId = match.id;
    } catch (e) {
        console.warn('Nuki authId lookup failed:', e.message);
    }

    return { success: true, pin: generatedCode, authId };
}

async function deleteNukiPin(authId) {
    const allSettings = db.getAllSettings();
    const nuki = allSettings.nuki;
    if (!nuki || !nuki.token || !nuki.lockId) throw new Error('Nuki-Zugangsdaten fehlen');

    await axios.delete(`https://api.nuki.io/smartlock/${nuki.lockId}/auth/${authId}`, {
        headers: {
            'Authorization': `Bearer ${nuki.token}`,
            'Accept': 'application/json'
        }
    });
    return { success: true };
}


console.log('\u2705 Cron-Jobs registriert (iCal Booking.com + Airbnb: alle 15 Min, Nuki-Cleanup: st\u00fcndlich, Reminder: t\u00e4glich 08:00)');

// =======================
// 2. SECURITY HEADERS (Helmet)
// =======================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'", "https://cdnjs.cloudflare.com"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: null
        }
    },
    crossOriginEmbedderPolicy: false,
    hsts: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// =======================
// 0. Init & Config
// =======================
console.log(`🏠 RentalInvoice v${packageJson.version}`);

// =======================
// 3. RATE LIMITING
// =======================
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Zu viele Anfragen. Bitte warten.' }
});
app.use(globalLimiter);

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Zu viele Login-Versuche. Bitte warte 15 Minuten.' },
    skipSuccessfulRequests: true
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'API Rate-Limit erreicht. Bitte warten.' }
});

// =======================
// 4. MIDDLEWARE
// =======================
app.use(bodyParser.json({ limit: '10mb' }));
app.use(cookieParser());

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
    console.warn('⚠️  Kein SESSION_SECRET in .env gesetzt! Zufälliger Key wird verwendet.');
}

app.use(session({
    secret: sessionSecret,
    name: '__sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 8 * 60 * 60 * 1000
    }
}));

app.disable('x-powered-by');

// =======================
// 5. AUTHENTICATION
// =======================
function ensureAuthenticated(req, res, next) {
    const whitelist = ['/api/login', '/api/login/verify', '/api/login/recover', '/api/whatsapp/qr', '/api/health'];
    if (whitelist.includes(req.path)) return next();

    if (req.session && req.session.user) return next();

    if (req.path === '/' || req.path === '/index.html') return next();

    const allowedLoginAssets = ['/styles.css', '/app.js'];
    if (allowedLoginAssets.includes(req.path)) return next();

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Nicht authentifiziert' });
    }

    return res.status(404).send('Not Found');
}

// =======================
// 6. PUBLIC STATIC FILES (NO AUTH REQUIRED)
// =======================
// Serve welcome.html without authentication for TV Kiosk mode
app.get('/welcome.html', (req, res) => {
    const filePath = path.join(PUBLIC_DIR, 'welcome.html');
    res.sendFile(filePath);
});

// Public, minimal data for the TV welcome screen (no secrets: no WLAN, no codes, no invoices).
// Name mode via setting welcome_name_mode: 'first' (default) | 'full' | 'none'
app.get('/api/welcome', (req, res) => {
    try {
        const s = db.getAllSettings();
        const today = berlinToday();
        const mode = ['first', 'full', 'none'].includes(s.welcome_name_mode) ? s.welcome_name_mode : 'first';
        const current = loadBookingRows()
            .filter(r => r.checkin <= today && r.checkout >= today && r.state !== 'past')
            .sort((a, b) => (a.checkout === today) - (b.checkout === today) || a.checkin.localeCompare(b.checkin))[0];
        let name = '';
        if (current && current.name && mode !== 'none') {
            const parts = current.name.trim().split(/\s+/);
            name = mode === 'full' ? current.name : parts[0];
        }
        res.set('Cache-Control', 'no-store');
        res.json({
            success: true, today,
            guest: current ? { name, checkin: current.checkin, checkout: current.checkout, departureToday: current.checkout === today } : null,
            phone: (s.vermieter && s.vermieter.telefon) || ''
        });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// Serve CSS and JS files without authentication
app.use('/styles.css', express.static(path.join(PUBLIC_DIR, 'styles.css')));
app.use('/app.js', express.static(path.join(PUBLIC_DIR, 'app.js')));

// Public guest website (description, availability, booking requests, guest login + status)
const guestPortal = require('./guest-portal')({
    express, rateLimit, db, nodemailer, multer,
    botLogic: require('./bot-logic'),
    notify: async (msg, type) => {
        const sent = await sendToAllRecipients(msg);
        db.logNotification(type, msg, sent ? 'sent' : 'failed');
    },
    createNukiPin: (arrival, departure, name) => createNukiPin(arrival, departure, name),
    deleteNukiPin: (authId) => deleteNukiPin(authId),
    berlinToday: () => berlinToday(),
    addDays: (ymd, n) => addDays(ymd, n),
    nightsBetween: (a, b) => nightsBetween(a, b),
    formatDateDE: (d) => formatDateDE(d)
});
app.use('/gast', guestPortal.router);

app.use(ensureAuthenticated);

// =======================
// 7. PROTECTED STATIC FILE SERVING
// =======================
app.use(express.static(PUBLIC_DIR, {
    dotfiles: 'deny',
    index: 'index.html',
    extensions: ['html']
}));

// =======================
// 6b. HEALTH CHECK
// =======================
app.get('/api/health', (req, res) => {
    res.json({ ok: true });
});

// =======================
// 7. AUTH API ROUTES
// =======================
app.post('/api/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ success: false, message: 'Ung\u00fcltige Eingabe' });
    }

    const sanitizedUsername = username.trim().substring(0, 50);
    if (!/^[a-zA-Z0-9_-]+$/.test(sanitizedUsername)) {
        return res.status(400).json({ success: false, message: 'Ung\u00fcltiger Benutzername' });
    }

    const user = db.getUser(sanitizedUsername);

    if (!user) {
        bcrypt.compareSync('dummy', '$2a$12$invalidhashforsecuritypurposesonly.');
        return res.status(401).json({ success: false, message: 'Ung\u00fcltige Anmeldedaten' });
    }

    const isMatch = bcrypt.compareSync(password, user.password);

    if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Ung\u00fcltige Anmeldedaten' });
    }

    // Check if 2FA should be used (WhatsApp connected + user has phone)
    const allSettings = db.getAllSettings();
    const twoFaEnabled = allSettings.twofactor_enabled !== 'false';

    if (waReady && twoFaEnabled && user.phone) {
        // Generate 6-digit code
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const sessionId = crypto.randomBytes(16).toString('hex');
        pending2FA.set(sessionId, {
            code,
            username: user.username,
            expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
        });

        // Clean expired codes
        for (const [key, val] of pending2FA) {
            if (val.expiresAt < Date.now()) pending2FA.delete(key);
        }

        // Send code via WhatsApp to user's phone
        const msg = `\ud83d\udd10 Dein Login-Code: *${code}*\n\nG\u00fcltig f\u00fcr 5 Minuten.`;
        const sent = await sendWhatsApp(user.phone, msg);

        if (!sent) {
            // Fallback: skip 2FA if WhatsApp send fails
            return req.session.regenerate((err) => {
                if (err) return res.status(500).json({ success: false, message: 'Server-Fehler' });
                req.session.user = { username: user.username, role: user.role };
                res.json({ success: true, user: req.session.user });
            });
        }

        return res.json({
            success: true,
            requires2fa: true,
            sessionId,
            message: 'Code per WhatsApp gesendet'
        });
    }

    // No 2FA — direct login
    req.session.regenerate((err) => {
        if (err) {
            console.error('Session regeneration error:', err);
            return res.status(500).json({ success: false, message: 'Server-Fehler' });
        }
        req.session.user = { username: user.username, role: user.role };
        res.json({ success: true, user: req.session.user });
    });
});

// 2FA Verify
app.post('/api/login/verify', loginLimiter, (req, res) => {
    const { sessionId, code } = req.body;

    if (!sessionId || !code) {
        return res.status(400).json({ success: false, message: 'Code und Session-ID erforderlich' });
    }

    const entry = pending2FA.get(sessionId);
    if (!entry) {
        return res.status(401).json({ success: false, message: 'Ung\u00fcltige oder abgelaufene Anfrage' });
    }

    if (entry.expiresAt < Date.now()) {
        pending2FA.delete(sessionId);
        return res.status(401).json({ success: false, message: 'Code abgelaufen. Bitte erneut anmelden.' });
    }

    if (entry.code !== code.trim()) {
        return res.status(401).json({ success: false, message: 'Falscher Code' });
    }

    // Code correct — create session
    pending2FA.delete(sessionId);
    const user = db.getUser(entry.username);

    req.session.regenerate((err) => {
        if (err) {
            console.error('Session regeneration error:', err);
            return res.status(500).json({ success: false, message: 'Server-Fehler' });
        }
        req.session.user = { id: user.id, username: user.username, role: user.role };
        res.json({ success: true, user: req.session.user });
    });
});

// Recovery Key Login
app.post('/api/login/recover', loginLimiter, (req, res) => {
    const { username, recoveryKey } = req.body;

    if (!username || !recoveryKey) {
        return res.status(400).json({ success: false, message: 'Benutzername und Recovery-Key erforderlich' });
    }

    if (db.verifyRecoveryKey(username, recoveryKey)) {
        const user = db.getUser(username);
        req.session.regenerate((err) => {
            if (err) return res.status(500).json({ success: false, message: 'Server-Fehler' });
            req.session.user = { id: user.id, username: user.username, role: user.role };
            res.json({ success: true, message: 'Wiederherstellung erfolgreich', user: req.session.user });
        });
    } else {
        res.status(401).json({ success: false, message: 'Ungültiger Recovery-Key' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ success: false, message: 'Logout fehlgeschlagen' });
        res.clearCookie('__sid');
        res.json({ success: true });
    });
});

app.get('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('__sid');
        res.redirect('/');
    });
});

app.get('/api/me', (req, res) => {
    if (req.session && req.session.user) {
        res.json({ authenticated: true, user: req.session.user });
    } else {
        res.json({ authenticated: false });
    }
});

// Version Info
app.get('/api/version', (req, res) => {
    res.json({
        success: true,
        version: packageJson.version,
        name: packageJson.name
    });
});

// =======================
// 7b. USER MANAGEMENT API
// =======================
app.get('/api/users', (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Nur Admins erlaubt' });
    try {
        const users = db.getAllUsers();
        res.json({ success: true, users });
    } catch (e) {
        res.status(500).json({ error: 'Fehler beim Laden der Benutzer' });
    }
});

app.post('/api/users', loginLimiter, (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Nur Admins erlaubt' });
    const { username, password, role, phone } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });

    try {
        const hashed = bcrypt.hashSync(password, 12);
        db.createUser(username, hashed, role || 'admin', phone || '');
        res.json({ success: true, message: 'Benutzer erstellt' });
    } catch (e) {
        res.status(500).json({ error: 'Benutzer konnte nicht erstellt werden' });
    }
});

app.put('/api/users/:id', (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Nur Admins erlaubt' });
    const { username, password, role, phone } = req.body;
    const { id } = req.params;

    try {
        const data = { username, role, phone };
        if (password) {
            data.password = bcrypt.hashSync(password, 12);
        }
        db.updateUser(id, data);
        res.json({ success: true, message: 'Benutzer aktualisiert' });
    } catch (e) {
        res.status(500).json({ error: 'Benutzer konnte nicht aktualisiert werden' });
    }
});

app.delete('/api/users/:id', (req, res) => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Nur Admins erlaubt' });
    const { id } = req.params;
    try {
        db.deleteUser(id);
        res.json({ success: true, message: 'Benutzer gelöscht' });
    } catch (e) {
        res.status(500).json({ error: 'Benutzer konnte nicht gelöscht werden' });
    }
});

// =======================
// 8b. OVERVIEW / BOOKINGS / STATUS API (web UI)
// =======================
const botLogicShared = require('./bot-logic');

function berlinToday() {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
}
function addDays(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return dt.toISOString().slice(0, 10);
}
function nightsBetween(a, b) {
    if (!a || !b) return 0;
    return Math.max(0, Math.round((Date.UTC(...b.split('-').map((x, i) => i === 1 ? x - 1 : +x)) - Date.UTC(...a.split('-').map((x, i) => i === 1 ? x - 1 : +x))) / 86400000));
}

function loadBookingRows() {
    guestPortal.ensureGuestCodes();
    const rows = db.getDb().prepare(`
        SELECT b.id, b.uid, b.summary, b.checkin, b.checkout, b.source, b.nuki_pin, b.nuki_auth_id, b.guest_code,
               b.arrived_at, b.guest_id, g.name AS guest_name, g.email AS guest_email
        FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
        WHERE b.checkin IS NOT NULL AND b.checkout IS NOT NULL
        ORDER BY b.checkin DESC
        LIMIT 1000
    `).all();
    const today = berlinToday();
    return rows.map(r => {
        const source = r.source || (/^airbnb/i.test(r.summary || '') ? 'Airbnb' : (String(r.uid).startsWith('manual-') ? 'manual' : 'Booking.com'));
        const guessed = String(r.summary || '').split('(')[0].replace(/^(Buchung|Gast|Airbnb):/i, '').trim();
        const name = r.guest_name || guessed;
        const needsName = botLogicShared.isPlaceholderGuestName(name);
        let state = 'upcoming';
        if (r.checkout < today) state = 'past';
        else if (r.checkin <= today) state = r.checkout === today ? 'departing' : 'inhouse';
        return {
            id: r.id, source, name: needsName ? '' : name, needsName,
            checkin: r.checkin, checkout: r.checkout, nights: nightsBetween(r.checkin, r.checkout),
            hasCode: !!(r.nuki_auth_id || r.nuki_pin), pin: r.nuki_pin || null,
            arrivedAt: r.arrived_at || null, guestId: r.guest_id || null, guestEmail: r.guest_email || null, state,
            guestCode: r.guest_code || null
        };
    });
}

// Guest website admin: settings, photos, booking requests
guestPortal.registerAdminRoutes(app, apiLimiter);

app.get('/api/bookings', apiLimiter, (req, res) => {
    try {
        let rows = loadBookingRows();
        const filter = String(req.query.filter || 'upcoming');
        if (filter === 'upcoming') rows = rows.filter(r => r.state !== 'past').sort((a, b) => a.checkin.localeCompare(b.checkin));
        else if (filter === 'past') rows = rows.filter(r => r.state === 'past');
        else if (filter === 'noname') rows = rows.filter(r => r.needsName && r.state !== 'past').sort((a, b) => a.checkin.localeCompare(b.checkin));
        const q = String(req.query.q || '').trim().toLowerCase();
        if (q) rows = rows.filter(r => `${r.name} ${r.source} ${r.checkin} ${r.checkout}`.toLowerCase().includes(q));
        res.json({ success: true, bookings: rows.slice(0, 300) });
    } catch (e) {
        console.error('Bookings API Error:', e.message);
        res.status(500).json({ success: false, error: 'Buchungen konnten nicht geladen werden' });
    }
});

// Assign a real guest name to a booking (also renames the Nuki code)
// Occupancy calendar: bookings of one month, occupancy rate and free gaps for the next 120 days
app.get('/api/calendar', apiLimiter, (req, res) => {
    try {
        const today = berlinToday();
        const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : today.slice(0, 7);
        const first = `${month}-01`;
        const next = addDays(first, 32).slice(0, 7) + '-01';
        const daysInMonth = nightsBetween(first, next);
        const all = loadBookingRows();

        const bookings = all.filter(r => r.checkin < next && r.checkout > first)
            .sort((a, b) => a.checkin.localeCompare(b.checkin));
        const booked = new Set();
        bookings.forEach(r => {
            for (let d = r.checkin < first ? first : r.checkin; d < r.checkout && d < next; d = addDays(d, 1)) booked.add(d);
        });

        // Gaps between stays from today on; touching or overlapping stays are merged first
        const horizon = addDays(today, 120);
        const stays = all.filter(r => r.checkout > today && r.checkin < horizon)
            .map(r => [r.checkin < today ? today : r.checkin, r.checkout])
            .sort((a, b) => a[0].localeCompare(b[0]));
        const gaps = [];
        let free = today;
        stays.forEach(([from, to]) => {
            if (from > free) gaps.push({ from: free, to: from, nights: nightsBetween(free, from), open: false });
            if (to > free) free = to;
        });
        if (free < horizon) gaps.push({ from: free, to: horizon, nights: nightsBetween(free, horizon), open: true });

        res.json({
            success: true, today, month, first, daysInMonth,
            bookings,
            occupancy: { nights: booked.size, days: daysInMonth, rate: Math.round(booked.size / daysInMonth * 100) },
            gaps
        });
    } catch (e) {
        console.error('Calendar API Error:', e.message);
        res.status(500).json({ success: false, error: 'Kalender konnte nicht geladen werden' });
    }
});

app.put('/api/bookings/:id/guest', apiLimiter, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const name = String((req.body && req.body.name) || '').trim();
        if (!id || name.length < 2 || name.length > 80) return res.status(400).json({ success: false, error: 'Bitte einen gültigen Namen angeben (2–80 Zeichen).' });
        const r = await botLogicShared.applyGuestName(id, name);
        res.json({ success: true, name: r.name, nukiRenamed: r.nukiRenamed, nukiError: r.nukiError });
    } catch (e) {
        console.error('Booking guest name Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/overview', apiLimiter, (req, res) => {
    try {
        const today = berlinToday();
        const horizon = addDays(today, 14);
        const all = loadBookingRows();
        const active = all.filter(r => r.state !== 'past');

        const inHouse = active.filter(r => r.state === 'inhouse' || r.state === 'departing');
        const events = [];
        active.forEach(r => {
            if (r.checkin >= today && r.checkin <= horizon) events.push({ date: r.checkin, type: 'arrival', booking: r });
            if (r.checkout >= today && r.checkout <= horizon) events.push({ date: r.checkout, type: 'departure', booking: r });
        });
        events.sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'departure' ? -1 : 1));

        const open = db.getOpenInvoices();
        const openTotal = open.reduce((s, i) => s + (Number(i.total_amount) || 0), 0);

        const warnings = [];
        try {
            bookingMonitor.findOverlaps().forEach(([a, b]) => {
                warnings.push({ type: 'overlap', text: `Überschneidung: ${a.source || 'Booking.com'} ${formatDateDE(a.checkin)}–${formatDateDE(a.checkout)} ↔ ${b.source || 'Airbnb'} ${formatDateDE(b.checkin)}–${formatDateDE(b.checkout)}` });
            });
        } catch (e) { /* ignore */ }
        active.filter(r => !r.hasCode && r.source !== 'manual' && r.checkin <= addDays(today, 7) && r.state !== 'departing').forEach(r => {
            warnings.push({ type: 'nocode', text: `Kein Türcode für ${r.name || r.source + '-Buchung'} (${formatDateDE(r.checkin)})` });
        });
        const sync = db.getAllSettings().ical_last_sync || null;
        if (sync && Array.isArray(sync.feeds)) {
            sync.feeds.filter(f => !f.ok).forEach(f => warnings.push({ type: 'sync', text: `${f.source}: Kalenderabfrage fehlgeschlagen (${f.error})` }));
        }

        res.json({
            success: true, today,
            inHouse, events: events.slice(0, 12),
            namesMissing: active.filter(r => r.needsName && r.source !== 'manual').length,
            openInvoices: { count: open.length, total: openTotal },
            warnings, sync
        });
    } catch (e) {
        console.error('Overview API Error:', e.message);
        res.status(500).json({ success: false, error: 'Übersicht konnte nicht geladen werden' });
    }
});

// Connection status (Nuki is cached for 2 minutes to spare the API)
let nukiStatusCache = { at: 0, value: null };
app.get('/api/status', apiLimiter, async (req, res) => {
    try {
        const s = db.getAllSettings();
        const result = { telegram: { configured: !!s.tg_token, running: !!tgBot } };

        const nuki = s.nuki;
        if (!nuki || !nuki.token || !nuki.lockId) {
            result.nuki = { configured: false };
        } else {
            if (Date.now() - nukiStatusCache.at > 2 * 60 * 1000 || req.query.refresh === '1') {
                try {
                    const codes = await botLogicShared.listNukiCodes();
                    nukiStatusCache = { at: Date.now(), value: { configured: true, ok: true, codes: codes.length } };
                } catch (e) {
                    nukiStatusCache = { at: Date.now(), value: { configured: true, ok: false, error: e.message } };
                }
            }
            result.nuki = nukiStatusCache.value;
        }

        const feeds = getIcalFeeds(s);
        const last = s.ical_last_sync || null;
        result.calendars = {
            configured: feeds.map(f => f.source),
            lastSync: last ? last.at : null,
            feeds: last && Array.isArray(last.feeds) ? last.feeds : []
        };
        res.json({ success: true, ...result });
    } catch (e) {
        console.error('Status API Error:', e.message);
        res.status(500).json({ success: false, error: 'Status konnte nicht geladen werden' });
    }
});

// =======================
// 8. SETTINGS API
// =======================
app.get('/api/settings', apiLimiter, (req, res) => {
    try {
        const settings = db.getAllSettings();
        res.json({ success: true, settings });
    } catch (e) {
        console.error('Settings GET Error:', e.message);
        res.status(500).json({ error: 'Einstellungen konnten nicht geladen werden' });
    }
});

app.put('/api/settings', apiLimiter, (req, res) => {
    try {
        const { settings } = req.body;
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ error: 'Ungültige Einstellungen' });
        }
        db.setAllSettings(settings);

        // Re-init Telegram if token changed
        if (settings.tg_token) {
            initTelegram().catch(e => console.error('Error re-init Telegram:', e));
        } else if (currentTgToken && !settings.tg_token) {
            // If token was removed, stop polling
            if (tgBot) {
                tgBot.stopPolling();
                console.log('🛑 Telegram Bot Polling gestoppt (Token entfernt).');
                tgBot = null;
                currentTgToken = null;
            }
        }

        res.json({ success: true, message: 'Einstellungen gespeichert' });
    } catch (e) {
        console.error('Settings PUT Error:', e.message);
        res.status(500).json({ error: 'Einstellungen konnten nicht gespeichert werden' });
    }
});

// Telegram Requests API
app.get('/api/settings/telegram/requests', apiLimiter, (req, res) => {
    try {
        const requests = db.getPendingTelegramRequests();
        res.json({ success: true, requests });
    } catch (e) {
        res.status(500).json({ error: 'Anfragen konnten nicht geladen werden' });
    }
});

app.post('/api/settings/telegram/approve', apiLimiter, (req, res) => {
    try {
        const { id } = req.body;
        const success = db.approveTelegramRequest(id);
        if (success) {
            res.json({ success: true, message: 'Anfrage genehmigt' });
        } else {
            res.status(400).json({ error: 'Konnte nicht genehmigt werden (evtl. schon genehmigt)' });
        }
    } catch (e) {
        console.error('Telegram Approve Error:', e.message);
        res.status(500).json({ error: 'Fehler beim Genehmigen: ' + e.message });
    }
});

app.post('/api/settings/telegram/deny', apiLimiter, (req, res) => {
    try {
        const { id } = req.body;
        db.denyTelegramRequest(id);
        res.json({ success: true, message: 'Anfrage abgelehnt' });
    } catch (e) {
        res.status(500).json({ error: 'Fehler beim Ablehnen' });
    }
});

app.get('/api/settings/telegram/history', apiLimiter, (req, res) => {
    try {
        const history = db.getTelegramRequestHistory();
        res.json({ success: true, history });
    } catch (e) {
        res.status(500).json({ error: 'Verlauf konnte nicht geladen werden' });
    }
});

app.post('/api/settings/telegram/delete', apiLimiter, (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ error: 'id fehlt' });
        db.deleteTelegramRequest(id);
        res.json({ success: true, message: 'Eintrag gelöscht' });
    } catch (e) {
        console.error('Telegram Delete Error:', e.message);
        res.status(500).json({ error: 'Fehler beim Löschen: ' + e.message });
    }
});

app.get('/api/telegram/status', apiLimiter, (req, res) => {
    try {
        let status = 'offline';
        let botInfo = null;

        if (tgBot && currentTgToken) {
            status = 'online';
            // Try to get bot info
            tgBot.getMe()
                .then(info => {
                    res.json({
                        success: true,
                        status: 'online',
                        botInfo: {
                            username: info.username,
                            first_name: info.first_name
                        }
                    });
                })
                .catch(() => {
                    res.json({ success: true, status: 'online' });
                });
        } else {
            res.json({ success: true, status: 'offline' });
        }
    } catch (e) {
        res.json({ success: true, status: 'offline' });
    }
});

app.post('/api/settings/telegram/revoke', apiLimiter, (req, res) => {
    try {
        const { chatId } = req.body;
        if (!chatId) return res.status(400).json({ error: 'chatId fehlt' });
        db.revokeTelegramAccess(chatId);
        res.json({ success: true, message: 'Zugriff entzogen' });
    } catch (e) {
        console.error('Telegram Revoke Error:', e.message);
        res.status(500).json({ error: 'Fehler beim Entziehen: ' + e.message });
    }
});

// Upload Cloudflare/Custom Certificate for Paperless
app.post('/api/settings/paperless/upload-cert', apiLimiter, uploadCert.single('certificate'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Kein Zertifikat hochgeladen' });
        }
        res.json({
            success: true,
            message: 'Zertifikat erfolgreich hochgeladen',
            filename: req.file.filename,
            path: req.file.path
        });
    } catch (e) {
        console.error('Certificate Upload Error:', e.message);
        res.status(500).json({ error: 'Zertifikat konnte nicht hochgeladen werden: ' + e.message });
    }
});

// Check if certificate exists
app.get('/api/settings/paperless/cert-status', apiLimiter, (req, res) => {
    try {
        const certPath = path.join(CERTS_DIR, 'paperless-cert.pem');
        const exists = fs.existsSync(certPath);

        let certInfo = null;
        if (exists) {
            const stats = fs.statSync(certPath);
            certInfo = {
                exists: true,
                uploadedAt: stats.mtime,
                size: stats.size
            };
        }

        res.json({
            success: true,
            certificate: certInfo || { exists: false }
        });
    } catch (e) {
        console.error('Certificate Status Error:', e.message);
        res.status(500).json({ error: 'Zertifikat-Status konnte nicht abgerufen werden' });
    }
});

// Delete certificate
app.delete('/api/settings/paperless/cert', apiLimiter, (req, res) => {
    try {
        const certPath = path.join(CERTS_DIR, 'paperless-cert.pem');
        if (fs.existsSync(certPath)) {
            fs.unlinkSync(certPath);
            res.json({ success: true, message: 'Zertifikat gelöscht' });
        } else {
            res.status(404).json({ error: 'Kein Zertifikat vorhanden' });
        }
    } catch (e) {
        console.error('Certificate Delete Error:', e.message);
        res.status(500).json({ error: 'Zertifikat konnte nicht gelöscht werden: ' + e.message });
    }
});

// Test Paperless connection (server-side proxy to use custom cert)
app.post('/api/settings/paperless/test', apiLimiter, async (req, res) => {
    try {
        const { url, token } = req.body;
        if (!url || !token) {
            return res.status(400).json({ error: 'URL und Token erforderlich' });
        }

        // Create HTTPS agent with custom certificate if available
        const httpsAgent = createPaperlessHttpsAgent();
        const axiosConfig = {
            headers: {
                'Authorization': `Token ${token}`,
                'User-Agent': 'Ferienwohnung-Rechnung/1.0',
                'Accept': 'application/json'
            },
            timeout: 10000, // 10 second timeout
            validateStatus: (status) => status < 500 // Don't throw on 4xx errors
        };
        if (httpsAgent) {
            axiosConfig.httpsAgent = httpsAgent;
        }

        const cleanUrl = url.replace(/\/+$/, '');
        console.log('🔍 Paperless Test:', {
            url: `${cleanUrl}/api/`,
            headers: { ...axiosConfig.headers, Authorization: 'Token ***' }
        });

        const response = await axios.get(`${cleanUrl}/api/`, axiosConfig);

        console.log('✅ Paperless Response:', {
            status: response.status,
            statusText: response.statusText,
            data: response.data ? Object.keys(response.data) : 'no data'
        });

        if (response.status === 200) {
            res.json({ success: true, message: 'Paperless-Verbindung erfolgreich!' });
        } else {
            console.error('❌ Paperless Test Failed:', {
                status: response.status,
                data: response.data
            });
            res.json({
                success: false,
                error: `HTTP ${response.status}`,
                details: response.data?.detail || JSON.stringify(response.data)
            });
        }
    } catch (e) {
        console.error('❌ Paperless Test Error:', {
            message: e.message,
            status: e.response?.status,
            data: e.response?.data
        });
        res.status(500).json({
            success: false,
            error: e.response?.data?.detail || e.message || 'Verbindungsfehler',
            details: e.response?.data ? JSON.stringify(e.response.data) : undefined
        });
    }
});

// =======================
// 9. GUESTS API
// =======================
app.get('/api/guests', apiLimiter, (req, res) => {
    try {
        const search = req.query.search || '';
        const guests = db.getAllGuests(search);
        res.json({ success: true, guests });
    } catch (e) {
        console.error('Guests GET Error:', e.message);
        res.status(500).json({ error: 'Gäste konnten nicht geladen werden' });
    }
});

app.get('/api/guests/:id', apiLimiter, (req, res) => {
    try {
        const guest = db.getGuestById(parseInt(req.params.id));
        if (!guest) return res.status(404).json({ error: 'Gast nicht gefunden' });
        const invoices = db.getInvoicesByGuestId(guest.id);
        const bookings = db.getBookingsByGuestId(guest.id);
        res.json({ success: true, guest, invoices, bookings });
    } catch (e) {
        console.error('Guest GET Error:', e.message);
        res.status(500).json({ error: 'Gast konnte nicht geladen werden' });
    }
});

app.post('/api/guests', apiLimiter, (req, res) => {
    try {
        const { id, name, email, address, phone, notes } = req.body;
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return res.status(400).json({ error: 'Name ist erforderlich' });
        }

        const data = { name: name.trim(), email, address, phone, notes };

        if (id) {
            db.updateGuest(parseInt(id), data);
            res.json({ success: true, message: 'Gast aktualisiert', guest: { id: parseInt(id), ...data } });
        } else {
            const guest = db.createGuest(data);
            res.json({ success: true, message: 'Gast erstellt', guest });
        }
    } catch (e) {
        console.error('Guest POST Error:', e.message);
        res.status(500).json({ error: 'Gast konnte nicht gespeichert werden' });
    }
});

app.delete('/api/guests/:id', apiLimiter, async (req, res) => {
    try {
        const guestId = parseInt(req.params.id);
        // Cascade: delete all active Nuki PINs for this guest before deleting
        const bookings = db.getBookingsByGuestId(guestId);
        for (const booking of bookings) {
            if (booking.nuki_auth_id) {
                try {
                    await deleteNukiPin(booking.nuki_auth_id);
                } catch (nukiErr) {
                    console.warn(`Nuki PIN Löschen fehlgeschlagen für Booking ${booking.id}:`, nukiErr.message);
                }
                db.clearNukiAuth(booking.id);
            }
        }
        db.deleteGuest(guestId);
        res.json({ success: true, message: 'Gast gelöscht' });
    } catch (e) {
        console.error('Guest DELETE Error:', e.message);
        res.status(500).json({ error: 'Gast konnte nicht gelöscht werden' });
    }
});

// Delete a single Nuki PIN by booking ID
app.delete('/api/nuki/pin/:bookingId', apiLimiter, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.bookingId);
        const booking = db.getDb().prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        if (!booking) {
            return res.status(404).json({ error: 'Buchung nicht gefunden' });
        }
        // Try to revoke from Nuki API — find auth_id from DB or look it up live by PIN code
        let nukiAuthId = booking.nuki_auth_id;
        if (!nukiAuthId && booking.nuki_pin) {
            try {
                const allSettings = db.getAllSettings();
                const nuki = allSettings.nuki;
                if (nuki && nuki.token && nuki.lockId) {
                    const lockId = parseInt(nuki.lockId, 10) || nuki.lockId;
                    const listRes = await axios.get(`https://api.nuki.io/smartlock/${lockId}/auth`, {
                        headers: { 'Authorization': `Bearer ${nuki.token}`, 'Accept': 'application/json' }
                    });
                    const auths = Array.isArray(listRes.data) ? listRes.data : [];
                    const match = auths.find(a => String(a.code) === String(booking.nuki_pin));
                    if (match) nukiAuthId = match.id;
                }
            } catch (lookupErr) {
                console.warn('Nuki authId Lookup beim Löschen fehlgeschlagen:', lookupErr.message);
            }
        }
        if (nukiAuthId) {
            try {
                await deleteNukiPin(nukiAuthId);
            } catch (nukiErr) {
                console.warn(`Nuki API Löschen fehlgeschlagen (lokal trotzdem gelöscht):`, nukiErr.message);
            }
        }
        db.clearNukiAuth(bookingId);
        db.getDb().prepare('UPDATE bookings SET nuki_pin = NULL WHERE id = ?').run(bookingId);
        res.json({ success: true, message: 'Nuki-PIN gelöscht' });
    } catch (e) {
        console.error('Nuki PIN Delete Error:', e.message);
        res.status(500).json({ error: 'Nuki-PIN konnte nicht gelöscht werden: ' + e.message });
    }
});

// Create a new Nuki PIN for a guest (from the Guests UI)
app.post('/api/nuki/pin/create-for-guest', apiLimiter, async (req, res) => {
    try {
        const { guestId, arrival, departure } = req.body;
        if (!guestId || !arrival || !departure) {
            return res.status(400).json({ error: 'guestId, arrival und departure erforderlich' });
        }
        const guest = db.getGuestById(parseInt(guestId));
        if (!guest) return res.status(404).json({ error: 'Gast nicht gefunden' });

        const nukiResult = await createNukiPin(arrival, departure, guest.name);
        // Check if a booking for this stay already exists
        const existingBooking = db.findBookingForStay(guest.name, arrival, departure);
        if (existingBooking) {
            db.updateBookingNukiData(existingBooking.id, nukiResult.pin, nukiResult.authId);
            if (!existingBooking.guest_id) {
                db.getDb().prepare('UPDATE bookings SET guest_id = ? WHERE id = ?').run(guest.id, existingBooking.id);
            }
        } else {
            db.createManualBooking(guest.id, guest.name, arrival, departure, nukiResult.pin, nukiResult.authId);
        }
        res.json({ success: true, pin: nukiResult.pin, authId: nukiResult.authId });
    } catch (e) {
        console.error('Nuki PIN Create for Guest Error:', e.message);
        res.status(500).json({ error: 'Nuki-PIN konnte nicht erstellt werden: ' + e.message });
    }
});

// Extend (update dates of) an existing Nuki PIN by booking ID
app.put('/api/nuki/pin/:bookingId/extend', apiLimiter, async (req, res) => {
    try {
        const bookingId = parseInt(req.params.bookingId);
        const { arrival, departure } = req.body;
        if (!arrival || !departure) return res.status(400).json({ error: 'arrival und departure erforderlich' });

        const booking = db.getDb().prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        if (!booking) return res.status(404).json({ error: 'Buchung nicht gefunden' });

        const allSettings = db.getAllSettings();
        const nuki = allSettings.nuki;
        if (!nuki || !nuki.token || !nuki.lockId) throw new Error('Nuki-Zugangsdaten fehlen');

        // If there is an existing auth entry, update it; otherwise create a new PIN
        if (booking.nuki_auth_id) {
            await updateNukiPinDates(booking.nuki_auth_id, arrival, departure);
            // Update local dates
            db.getDb().prepare('UPDATE bookings SET checkin = ?, checkout = ? WHERE id = ?').run(arrival, departure, bookingId);
            res.json({ success: true, pin: booking.nuki_pin });
        } else {
            // No auth_id stored — create a new PIN
            const guestName = booking.summary ? booking.summary.replace('Gast: ', '') : 'Gast';
            const nukiResult = await createNukiPin(arrival, departure, guestName);
            db.updateBookingNukiData(bookingId, nukiResult.pin, nukiResult.authId);
            db.getDb().prepare('UPDATE bookings SET checkin = ?, checkout = ? WHERE id = ?').run(arrival, departure, bookingId);
            res.json({ success: true, pin: nukiResult.pin });
        }
    } catch (e) {
        console.error('Nuki PIN Extend Error:', e.message);
        res.status(500).json({ error: 'Nuki-PIN konnte nicht verlängert werden: ' + e.message });
    }
});

// =======================
// 10. INVOICES API
// =======================

app.post('/api/nuki/test', apiLimiter, async (req, res) => {
    const { token, lockId } = req.body;
    if (!token || !lockId) return res.status(400).json({ error: 'Token und LockID benötigt' });

    try {
        const response = await axios.get(`https://api.nuki.io/smartlock/${lockId}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            },
            timeout: 5000
        });
        res.json({ success: true, name: response.data.name });
    } catch (e) {
        console.error('Nuki Test Error:', e.message);
        res.status(500).json({
            error: e.response && e.response.data ? (e.response.data.message || 'API Error') : e.message
        });
    }
});

app.get('/api/invoices', apiLimiter, (req, res) => {
    try {
        const search = req.query.search || '';
        const invoices = db.getAllInvoices(search);
        // Parse JSON data for each invoice
        const parsed = invoices.map(inv => ({
            ...inv,
            data: typeof inv.data === 'string' ? JSON.parse(inv.data) : inv.data
        }));
        res.json({ success: true, invoices: parsed });
    } catch (e) {
        console.error('Invoices GET Error:', e.message);
        res.status(500).json({ error: 'Rechnungen konnten nicht geladen werden' });
    }
});

app.get('/api/invoices/guest/:guestId', apiLimiter, (req, res) => {
    try {
        const invoices = db.getInvoicesByGuestId(parseInt(req.params.guestId));
        const parsed = invoices.map(inv => ({
            ...inv,
            data: typeof inv.data === 'string' ? JSON.parse(inv.data) : inv.data
        }));
        res.json({ success: true, invoices: parsed });
    } catch (e) {
        console.error('Guest Invoices GET Error:', e.message);
        res.status(500).json({ error: 'Rechnungen konnten nicht geladen werden' });
    }
});

app.post('/api/invoices', apiLimiter, (req, res) => {
    try {
        const data = req.body;
        if (!data.rNummer && !data.invoice_number) {
            return res.status(400).json({ error: 'Rechnungsnummer ist erforderlich' });
        }
        const result = db.saveInvoice(data);
        const message = result.updated ? 'Rechnung aktualisiert' : 'Rechnung archiviert';
        res.json({ success: true, message, id: result.id });
    } catch (e) {
        console.error('Invoice POST Error:', e.message);
        res.status(500).json({ error: 'Rechnung konnte nicht gespeichert werden' });
    }
});

app.get('/api/invoices/:id/pdf', apiLimiter, async (req, res) => {
    try {
        const invoices = db.getAllInvoices();
        const invoice = invoices.find(i => i.id === parseInt(req.params.id));
        if (!invoice) return res.status(404).json({ error: 'Rechnung nicht gefunden' });

        const data = typeof invoice.data === 'string' ? JSON.parse(invoice.data) : (invoice.data || {});
        const botLogic = require('./bot-logic');
        const { filePath } = await botLogic.generateInvoicePdf(data);

        const filename = `Rechnung-${(data.rNummer || invoice.invoice_number || 'download').replace(/[^a-zA-Z0-9-_]/g, '_')}.pdf`;
        res.download(filePath, filename, (err) => {
            fs.unlink(filePath, () => { });
            if (err && !res.headersSent) {
                res.status(500).json({ error: 'Download fehlgeschlagen' });
            }
        });
    } catch (e) {
        console.error('Invoice PDF Download Error:', e.message);
        if (!res.headersSent) res.status(500).json({ error: 'PDF-Generierung fehlgeschlagen: ' + e.message });
    }
});

app.delete('/api/invoices/:id', apiLimiter, (req, res) => {
    try {
        db.deleteInvoice(parseInt(req.params.id));
        res.json({ success: true, message: 'Rechnung gelöscht' });
    } catch (e) {
        console.error('Invoice DELETE Error:', e.message);
        res.status(500).json({ error: 'Rechnung konnte nicht gelöscht werden' });
    }
});

// =======================
// 11. BRANDING API
// =======================
app.get('/api/branding', apiLimiter, (req, res) => {
    try {
        const branding = db.getBranding();
        res.json({ success: true, branding });
    } catch (e) {
        console.error('Branding GET Error:', e.message);
        res.status(500).json({ error: 'Branding konnte nicht geladen werden' });
    }
});

app.post('/api/branding', apiLimiter, (req, res) => {
    try {
        const { logo_base64, primary_color, template_config } = req.body;

        // Validate base64 size (max 2MB)
        if (logo_base64 && logo_base64.length > 2 * 1024 * 1024) {
            return res.status(400).json({ error: 'Logo ist zu groß (max 2MB)' });
        }

        db.saveBranding({ logo_base64, primary_color, template_config });
        res.json({ success: true, message: 'Branding gespeichert' });
    } catch (e) {
        console.error('Branding POST Error:', e.message);
        res.status(500).json({ error: 'Branding konnte nicht gespeichert werden' });
    }
});

// Template-specific endpoint
app.post('/api/branding/template', apiLimiter, (req, res) => {
    try {
        const { template_config } = req.body;
        const currentBranding = db.getBranding() || {};

        db.saveBranding({
            logo_base64: currentBranding.logo_base64 || null,
            primary_color: currentBranding.primary_color || null,
            template_config
        });

        res.json({ success: true, message: 'Template-Konfiguration gespeichert' });
    } catch (e) {
        console.error('Template Config POST Error:', e.message, e.stack);
        res.status(500).json({ success: false, error: 'Template-Konfiguration konnte nicht gespeichert werden' });
    }
});

// =======================
// 12. MIGRATION API (localStorage → DB)
// =======================
app.post('/api/migrate', apiLimiter, (req, res) => {
    try {
        const data = req.body;
        const results = db.migrateFromLocalStorage(data);
        res.json({
            success: true,
            message: `Migration abgeschlossen: ${results.settings} Einstellungen, ${results.invoices} Rechnungen importiert`,
            results
        });
    } catch (e) {
        console.error('Migration Error:', e.message);
        res.status(500).json({ error: 'Migration fehlgeschlagen' });
    }
});

// =======================
// 12. EXPENSES API
// =======================
app.get('/api/expenses', apiLimiter, (req, res) => {
    try {
        const expenses = db.getAllExpenses();
        res.json({ success: true, expenses });
    } catch (e) {
        console.error('Expenses GET Error:', e.message);
        res.status(500).json({ error: 'Ausgaben konnten nicht geladen werden' });
    }
});

app.post('/api/expenses', apiLimiter, (req, res) => {
    try {
        const expense = db.createExpense(req.body);
        res.json({ success: true, message: 'Ausgabe gespeichert', expense });
    } catch (e) {
        console.error('Expense POST Error:', e.message);
        res.status(500).json({ error: 'Ausgabe konnte nicht gespeichert werden' });
    }
});

app.delete('/api/expenses/:id', apiLimiter, (req, res) => {
    try {
        db.deleteExpense(parseInt(req.params.id));
        res.json({ success: true, message: 'Ausgabe gelöscht' });
    } catch (e) {
        console.error('Expense DELETE Error:', e.message);
        res.status(500).json({ error: 'Ausgabe konnte nicht gelöscht werden' });
    }
});

app.post('/api/expenses/sync', apiLimiter, async (req, res) => {
    try {
        const allSettings = db.getAllSettings();
        const pl = allSettings.paperless || {};
        const tag = allSettings.paperless_expense_tag || 'BeckhomeInvoice';
        const amountFieldName = allSettings.paperless_amount_field || 'Betrag';

        if (!pl.url || !pl.token) {
            return res.status(400).json({ error: 'Paperless-Zugangsdaten nicht konfiguriert' });
        }

        // 1. Get Tag ID from Paperless
        const tagsRes = await axios.get(`${pl.url}/api/tags/?name__icontains=${encodeURIComponent(tag)}`, {
            headers: { 'Authorization': `Token ${pl.token}` }
        });
        const tagObj = tagsRes.data.results.find(t => t.name.toLowerCase() === tag.toLowerCase());
        if (!tagObj) return res.json({ success: true, message: `Tag "${tag}" nicht in Paperless gefunden.`, count: 0 });

        // 2. Search documents with this tag
        const docsRes = await axios.get(`${pl.url}/api/documents/?tags__id__all=${tagObj.id}`, {
            headers: { 'Authorization': `Token ${pl.token}` }
        });

        // 3. Get Custom Fields definitions to find the right ID
        const fieldsRes = await axios.get(`${pl.url}/api/custom_fields/`, {
            headers: { 'Authorization': `Token ${pl.token}` }
        });
        const amountFieldDef = fieldsRes.data.results.find(f => f.name.toLowerCase() === amountFieldName.toLowerCase());

        let count = 0;
        for (const doc of docsRes.data.results) {
            // Check if already synced
            if (db.getExpenseByPaperlessId(doc.id)) continue;

            let amount = 0;
            if (amountFieldDef && doc.custom_fields) {
                const fieldVal = doc.custom_fields.find(cf => cf.field === amountFieldDef.id);
                if (fieldVal && fieldVal.value) amount = parseFloat(fieldVal.value);
            }

            db.createExpense({
                date: doc.created ? doc.created.split('T')[0] : (doc.added ? doc.added.split('T')[0] : new Date().toISOString().split('T')[0]),
                amount: amount,
                category: 'Paperless',
                description: doc.title,
                source: 'paperless',
                paperless_id: doc.id
            });
            count++;
        }

        res.json({ success: true, message: `${count} neue Ausgaben synchronisiert`, count });
    } catch (e) {
        console.error('Expense Sync Error:', e.message);
        res.status(500).json({ error: 'Synchronisierung fehlgeschlagen' });
    }
});

// =======================
// 13. STATS API
// =======================
app.get('/api/stats', apiLimiter, (req, res) => {
    try {
        const stats = db.getStats();
        res.json({ success: true, stats });
    } catch (e) {
        console.error('Stats GET Error:', e.message);
        res.status(500).json({ error: 'Statistiken konnten nicht geladen werden' });
    }
});

// =======================
// 12b. ESTATE MANAGEMENT API
// =======================

// Fahrtkostenabrechnung
app.get('/api/estate/mileage', apiLimiter, (req, res) => {
    try {
        const mileage = db.getAllEstateMileage();
        res.json({ success: true, mileage });
    } catch (e) {
        console.error('Estate Mileage GET Error:', e.message);
        res.status(500).json({ error: 'Fahrtkostenabrechnung konnte nicht geladen werden' });
    }
});

app.post('/api/estate/mileage', apiLimiter, (req, res) => {
    try {
        const { date, from_location, to_location, purpose, distance_km, rate_per_km, notes } = req.body;

        if (!date || !from_location || !to_location || !purpose || !distance_km) {
            return res.status(400).json({ error: 'Alle Pflichtfelder müssen ausgefüllt werden' });
        }

        if (isNaN(distance_km) || distance_km <= 0) {
            return res.status(400).json({ error: 'Ungültige Kilometerangabe' });
        }

        const mileage = db.createEstateMileage({ date, from_location, to_location, purpose, distance_km, rate_per_km, notes });
        res.json({ success: true, message: 'Fahrtkosten gespeichert', mileage });
    } catch (e) {
        console.error('Estate Mileage POST Error:', e.message);
        res.status(500).json({ error: 'Fahrtkosten konnten nicht gespeichert werden' });
    }
});

app.delete('/api/estate/mileage/:id', apiLimiter, (req, res) => {
    try {
        db.deleteEstateMileage(parseInt(req.params.id));
        res.json({ success: true, message: 'Fahrtkosten gelöscht' });
    } catch (e) {
        console.error('Estate Mileage DELETE Error:', e.message);
        res.status(500).json({ error: 'Fahrtkosten konnten nicht gelöscht werden' });
    }
});

// Aufwendungen/Auslagen
app.get('/api/estate/expenses', apiLimiter, (req, res) => {
    try {
        const expenses = db.getAllEstateExpenses();
        res.json({ success: true, expenses });
    } catch (e) {
        console.error('Estate Expenses GET Error:', e.message);
        res.status(500).json({ error: 'Aufwendungen konnten nicht geladen werden' });
    }
});

app.post('/api/estate/expenses', apiLimiter, (req, res) => {
    try {
        const { date, category, description, amount, receipt_file, notes } = req.body;

        if (!date || !category || !description || !amount) {
            return res.status(400).json({ error: 'Alle Pflichtfelder müssen ausgefüllt werden' });
        }

        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Ungültiger Betrag' });
        }

        const expense = db.createEstateExpense({ date, category, description, amount, receipt_file, notes });
        res.json({ success: true, message: 'Aufwendung gespeichert', expense });
    } catch (e) {
        console.error('Estate Expense POST Error:', e.message);
        res.status(500).json({ error: 'Aufwendung konnte nicht gespeichert werden' });
    }
});

app.delete('/api/estate/expenses/:id', apiLimiter, (req, res) => {
    try {
        db.deleteEstateExpense(parseInt(req.params.id));
        res.json({ success: true, message: 'Aufwendung gelöscht' });
    } catch (e) {
        console.error('Estate Expense DELETE Error:', e.message);
        res.status(500).json({ error: 'Aufwendung konnte nicht gelöscht werden' });
    }
});

// Rechnungen
app.get('/api/estate/invoices', apiLimiter, (req, res) => {
    try {
        const invoices = db.getAllEstateInvoices();
        res.json({ success: true, invoices });
    } catch (e) {
        console.error('Estate Invoices GET Error:', e.message);
        res.status(500).json({ error: 'Rechnungen konnten nicht geladen werden' });
    }
});

app.post('/api/estate/invoices', apiLimiter, (req, res) => {
    try {
        const { date, vendor, invoice_number, description, amount, file_path, category, notes } = req.body;

        if (!date || !vendor || !description || !amount) {
            return res.status(400).json({ error: 'Alle Pflichtfelder müssen ausgefüllt werden' });
        }

        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Ungültiger Betrag' });
        }

        const invoice = db.createEstateInvoice({ date, vendor, invoice_number, description, amount, file_path, category, notes });
        res.json({ success: true, message: 'Rechnung gespeichert', invoice });
    } catch (e) {
        console.error('Estate Invoice POST Error:', e.message);
        res.status(500).json({ error: 'Rechnung konnte nicht gespeichert werden' });
    }
});

app.delete('/api/estate/invoices/:id', apiLimiter, (req, res) => {
    try {
        db.deleteEstateInvoice(parseInt(req.params.id));
        res.json({ success: true, message: 'Rechnung gelöscht' });
    } catch (e) {
        console.error('Estate Invoice DELETE Error:', e.message);
        res.status(500).json({ error: 'Rechnung konnte nicht gelöscht werden' });
    }
});

// Statistiken & PDF-Vorbereitung
app.get('/api/estate/stats', apiLimiter, (req, res) => {
    try {
        const stats = db.getEstateStats();
        res.json({ success: true, stats });
    } catch (e) {
        console.error('Estate Stats GET Error:', e.message);
        res.status(500).json({ error: 'Statistiken konnten nicht geladen werden' });
    }
});

// PDF-Abrechnung generieren
app.post('/api/estate/generate-report', apiLimiter, async (req, res) => {
    try {
        const mileage = db.getAllEstateMileage();
        const expenses = db.getAllEstateExpenses();
        const invoices = db.getAllEstateInvoices();
        const stats = db.getEstateStats();

        const html = renderEstateReportHtml({ mileage, expenses, invoices, stats });

        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (request.resourceType() === 'document' || request.url().startsWith('data:')) request.continue();
            else request.abort();
        });
        await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' }
        });
        await browser.close();

        res.contentType('application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Erbverwaltung-Abrechnung-${new Date().toISOString().split('T')[0]}.pdf"`);
        res.send(pdf);
    } catch (e) {
        console.error('Estate Report Generation Error:', e.message);
        res.status(500).json({ error: 'PDF-Generierung fehlgeschlagen: ' + e.message });
    }
});

// UPDATE Endpoints for Edit Feature
app.put('/api/estate/mileage/:id', apiLimiter, (req, res) => {
    try {
        const { id } = req.params;
        const { date, from_location, to_location, purpose, distance_km, rate_per_km, notes } = req.body;

        if (!date || !from_location || !to_location || !purpose || !distance_km) {
            return res.status(400).json({ error: 'Alle Pflichtfelder müssen ausgefüllt werden' });
        }

        if (isNaN(distance_km) || distance_km <= 0) {
            return res.status(400).json({ error: 'Ungültige Kilometerangabe' });
        }

        db.updateEstateMileage(parseInt(id), { date, from_location, to_location, purpose, distance_km, rate_per_km, notes });
        res.json({ success: true, message: 'Fahrtkosten aktualisiert' });
    } catch (e) {
        console.error('Estate Mileage PUT Error:', e.message);
        res.status(500).json({ error: 'Fahrtkosten konnten nicht aktualisiert werden' });
    }
});

app.put('/api/estate/expenses/:id', apiLimiter, (req, res) => {
    try {
        const { id } = req.params;
        const { date, category, description, amount, receipt_file, notes } = req.body;

        if (!date || !category || !description || !amount) {
            return res.status(400).json({ error: 'Alle Pflichtfelder müssen ausgefüllt werden' });
        }

        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Ungültiger Betrag' });
        }

        db.updateEstateExpense(parseInt(id), { date, category, description, amount, receipt_file, notes });
        res.json({ success: true, message: 'Aufwendung aktualisiert' });
    } catch (e) {
        console.error('Estate Expense PUT Error:', e.message);
        res.status(500).json({ error: 'Aufwendung konnte nicht aktualisiert werden' });
    }
});

app.put('/api/estate/invoices/:id', apiLimiter, (req, res) => {
    try {
        const { id } = req.params;
        const { date, vendor, invoice_number, description, amount, file_path, category, notes } = req.body;

        if (!date || !vendor || !description || !amount) {
            return res.status(400).json({ error: 'Alle Pflichtfelder müssen ausgefüllt werden' });
        }

        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Ungültiger Betrag' });
        }

        db.updateEstateInvoice(parseInt(id), { date, vendor, invoice_number, description, amount, file_path, category, notes });
        res.json({ success: true, message: 'Rechnung aktualisiert' });
    } catch (e) {
        console.error('Estate Invoice PUT Error:', e.message);
        res.status(500).json({ error: 'Rechnung konnte nicht aktualisiert werden' });
    }
});

// File Upload for Estate Expenses/Invoices
app.post('/api/estate/upload', apiLimiter, upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Keine Datei hochgeladen' });
        }

        const filePath = `/uploads/estate/${req.file.filename}`;
        res.json({ success: true, filePath, filename: req.file.originalname });
    } catch (e) {
        console.error('Estate Upload Error:', e.message);
        res.status(500).json({ error: 'Datei konnte nicht hochgeladen werden' });
    }
});

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Paperless NGX Sync for Estate Invoices
app.post('/api/estate/paperless-sync', apiLimiter, async (req, res) => {
    try {
        const allSettings = db.getAllSettings();
        const pl = allSettings.paperless || {};
        const tag = allSettings.paperless_estate_tag || 'Erbverwaltung';
        const amountFieldName = allSettings.paperless_amount_field || 'Betrag';

        if (!pl.url || !pl.token) {
            return res.status(400).json({ error: 'Paperless-Zugangsdaten nicht konfiguriert' });
        }

        // Create HTTPS agent with custom certificate if available
        const httpsAgent = createPaperlessHttpsAgent();
        const axiosConfig = {
            headers: {
                'Authorization': `Token ${pl.token}`,
                'User-Agent': 'Ferienwohnung-Rechnung/1.0',
                'Accept': 'application/json'
            }
        };
        if (httpsAgent) {
            axiosConfig.httpsAgent = httpsAgent;
        }

        // 1. Get Tag ID from Paperless
        const tagsRes = await axios.get(`${pl.url}/api/tags/?name__icontains=${encodeURIComponent(tag)}`, axiosConfig);
        const tagObj = tagsRes.data.results.find(t => t.name.toLowerCase() === tag.toLowerCase());
        if (!tagObj) return res.json({ success: true, message: `Tag "${tag}" nicht in Paperless gefunden.`, count: 0 });

        // 2. Search documents with this tag
        const docsRes = await axios.get(`${pl.url}/api/documents/?tags__id__all=${tagObj.id}`, axiosConfig);

        // 3. Get Custom Fields definitions
        const fieldsRes = await axios.get(`${pl.url}/api/custom_fields/`, axiosConfig);
        const amountFieldDef = fieldsRes.data.results.find(f => f.name.toLowerCase() === amountFieldName.toLowerCase());

        let count = 0;
        for (const doc of docsRes.data.results) {
            // Check if already synced
            if (db.getEstateInvoiceByPaperlessId(doc.id)) continue;

            let amount = 0;
            if (amountFieldDef && doc.custom_fields) {
                const fieldVal = doc.custom_fields.find(cf => cf.field === amountFieldDef.id);
                if (fieldVal && fieldVal.value) amount = parseFloat(fieldVal.value);
            }

            db.createEstateInvoice({
                date: doc.created ? doc.created.split('T')[0] : (doc.added ? doc.added.split('T')[0] : new Date().toISOString().split('T')[0]),
                vendor: 'Paperless Import',
                invoice_number: doc.id.toString(),
                description: doc.title,
                amount: amount,
                file_path: `${pl.url}/api/documents/${doc.id}/download/`,
                category: 'Paperless',
                notes: `Importiert von Paperless NGX (Doc ID: ${doc.id})`
            });
            count++;
        }

        res.json({ success: true, message: `${count} neue Rechnungen aus Paperless synchronisiert`, count });
    } catch (e) {
        console.error('Estate Paperless Sync Error:', e.message);
        res.status(500).json({ error: 'Synchronisierung fehlgeschlagen: ' + e.message });
    }
});

// =======================
// 13. PROTECTED SERVICE API ROUTES
// =======================

// API: Generate PDF
app.post('/api/generate-pdf', apiLimiter, async (req, res) => {
    try {
        const { html } = req.body;
        if (!html) return res.status(400).json({ error: 'HTML content is required' });

        if (html.length > 1024 * 1024) {
            return res.status(400).json({ error: 'HTML content too large' });
        }

        const browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process'
            ]
        });
        const page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (request.resourceType() === 'document' || request.url().startsWith('data:')) {
                request.continue();
            } else {
                request.abort();
            }
        });

        await page.setContent(html, { waitUntil: 'load', timeout: 60000 });

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            preferCSSPageSize: true,
            scale: 0.85
        });

        await browser.close();

        res.contentType('application/pdf');
        res.send(pdf);
    } catch (error) {
        console.error('PDF Generation Error:', error.message);
        res.status(500).json({ error: 'PDF-Generierung fehlgeschlagen' });
    }
});

// API: Nuki Create PIN (Server-side)
app.post('/api/nuki/create-pin', apiLimiter, async (req, res) => {
    try {
        const { arrival, departure, guestName } = req.body;
        const result = await createNukiPin(arrival, departure, guestName);
        res.json(result);
    } catch (error) {
        console.error('Nuki Server API Error:', error.message);
        res.status(500).json({ error: 'Nuki PIN-Generierung fehlgeschlagen', details: error.message });
    }
});

// API: Delete Nuki PIN by PIN code (for form reset cleanup)
app.post('/api/nuki/delete-pin-by-code', apiLimiter, async (req, res) => {
    try {
        const { pin } = req.body;
        if (!pin) return res.status(400).json({ error: 'PIN-Code fehlt' });

        const allSettings = db.getAllSettings();
        const nuki = allSettings.nuki;
        if (!nuki || !nuki.token || !nuki.lockId) {
            return res.json({ success: false, error: 'Nuki-Zugangsdaten fehlen' });
        }

        // Look up auth_id by PIN code
        const lockId = parseInt(nuki.lockId, 10) || nuki.lockId;
        const listRes = await axios.get(`https://api.nuki.io/smartlock/${lockId}/auth`, {
            headers: { 'Authorization': `Bearer ${nuki.token}`, 'Accept': 'application/json' }
        });
        const auths = Array.isArray(listRes.data) ? listRes.data : [];
        const match = auths.find(a => String(a.code) === String(pin));

        if (match) {
            await deleteNukiPin(match.id);
            res.json({ success: true, message: 'Nuki-PIN gelöscht' });
        } else {
            res.json({ success: false, error: 'PIN nicht bei Nuki gefunden' });
        }
    } catch (error) {
        console.error('Nuki Delete by Code Error:', error.message);
        res.status(500).json({ error: 'Fehler beim Löschen: ' + error.message });
    }
});

// API: Send Email
app.post('/api/send-email', apiLimiter, async (req, res) => {
    try {
        const { to, subject, body, pdfBuffer, fileName, smtpConfig } = req.body;

        if (!to || !subject || !smtpConfig || !smtpConfig.host) {
            return res.status(400).json({ error: 'Pflichtfelder fehlen' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(to)) {
            return res.status(400).json({ error: 'Ungültige E-Mail-Adresse' });
        }

        const transporter = nodemailer.createTransport({
            host: smtpConfig.host,
            port: parseInt(smtpConfig.port) || 587,
            secure: smtpConfig.secure || false,
            auth: {
                user: smtpConfig.user,
                pass: smtpConfig.pass
            },
            connectionTimeout: 10000,
            greetingTimeout: 10000
        });

        const mailOptions = {
            from: smtpConfig.from || smtpConfig.user,
            to,
            subject: String(subject).substring(0, 200),
            text: String(body || '').substring(0, 10000),
            attachments: pdfBuffer ? [
                {
                    filename: String(fileName || 'Rechnung.pdf').replace(/[^a-zA-Z0-9._-]/g, '_'),
                    content: Buffer.from(pdfBuffer, 'base64')
                }
            ] : []
        };

        await transporter.sendMail(mailOptions);
        res.json({ success: true, message: 'E-Mail erfolgreich gesendet' });
    } catch (error) {
        console.error('Email Error:', error.message);
        res.status(500).json({ error: 'E-Mail-Versand fehlgeschlagen' });
    }
});

// API: manual calendar sync (Booking.com + Airbnb) - same logic as the 15-minute job
app.post('/api/ical/sync', apiLimiter, async (req, res) => {
    try {
        // Optionally persist freshly entered calendar links (only these two keys are touched)
        const body = req.body || {};
        for (const key of ['booking_ical', 'airbnb_ical']) {
            if (typeof body[key] === 'string') {
                const url = body[key].trim();
                if (url && !/^https?:\/\//i.test(url)) {
                    return res.status(400).json({ success: false, error: `Ungültiger Link (${key === 'airbnb_ical' ? 'Airbnb' : 'Booking.com'}): muss mit https:// beginnen.` });
                }
                db.setSetting(key, url);
            }
        }
        const result = await runIcalSync({ manual: true });
        if (result.busy) return res.status(409).json({ success: false, error: 'Eine Abfrage läuft bereits – bitte kurz warten.' });
        if (result.noFeeds) return res.status(400).json({ success: false, error: 'Kein iCal-Link hinterlegt (Booking.com oder Airbnb).' });
        res.json({ success: true, ...result });
    } catch (e) {
        console.error('Manuelle iCal-Abfrage Fehler:', e.message);
        res.status(500).json({ success: false, error: 'Abfrage fehlgeschlagen: ' + e.message });
    }
});

// API: Fetch iCal Calendar
app.post('/api/calendar/fetch', apiLimiter, async (req, res) => {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const parsed = new URL(url);

        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return res.status(400).json({ error: 'Nur HTTP(S)-URLs erlaubt' });
        }

        const hostname = parsed.hostname.toLowerCase();
        const blockedPatterns = [
            /^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./,
            /^192\.168\./, /^0\./, /^169\.254\./, /^\[?::1\]?$/,
            /^\[?fe80:/i, /^\[?fc00:/i, /^\[?fd/i
        ];

        for (const pattern of blockedPatterns) {
            if (pattern.test(hostname)) {
                return res.status(400).json({ error: 'Interne URLs sind nicht erlaubt' });
            }
        }
    } catch (e) {
        return res.status(400).json({ error: 'Ungültige URL' });
    }

    try {
        const response = await axios.get(url, {
            timeout: 10000,
            maxContentLength: 5 * 1024 * 1024,
            headers: { 'User-Agent': 'RentalInvoice/1.0' }
        });
        const data = ical.parseICS(response.data);

        const events = [];
        for (let k in data) {
            if (data.hasOwnProperty(k)) {
                const ev = data[k];
                if (ev.type === 'VEVENT') {
                    events.push({
                        summary: String(ev.summary || '').substring(0, 500),
                        start: ev.start,
                        end: ev.end,
                        description: String(ev.description || '').substring(0, 2000),
                        uid: String(ev.uid || '').substring(0, 200)
                    });
                }
            }
        }

        events.sort((a, b) => new Date(b.start) - new Date(a.start));
        res.json({ success: true, events });
    } catch (error) {
        console.error('iCal Fetch Error:', error.message);
        res.status(500).json({ error: 'Kalender konnte nicht geladen werden' });
    }
});

// =======================
// System & Updates
// =======================
app.get('/api/changelog', (req, res) => {
    try {
        const changelogPath = path.join(__dirname, 'changelog.json');
        if (fs.existsSync(changelogPath)) {
            const data = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
            const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
            res.json({ success: true, currentVersion: packageJson.version, releases: data.releases || [] });
        } else {
            res.json({ success: false, message: 'Changelog nicht gefunden' });
        }
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// Prüft per git fetch, ob auf origin/main neuere Commits liegen (ohne zu installieren)
app.get('/api/update/check', apiLimiter, (req, res) => {
    const execOpts = { timeout: 30000, cwd: __dirname };
    exec('git fetch origin main', execOpts, (fetchErr, _o, fetchStderr) => {
        if (fetchErr) {
            const detail = (fetchStderr || fetchErr.message || '').trim();
            return res.status(500).json({ success: false, message: `Update-Prüfung fehlgeschlagen: ${detail}` });
        }
        exec('git rev-list --count HEAD..origin/main', execOpts, (countErr, countOut) => {
            if (countErr) return res.status(500).json({ success: false, message: countErr.message });
            const behind = parseInt(String(countOut).trim(), 10) || 0;
            const currentVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
            exec('git show origin/main:package.json', execOpts, (showErr, showOut) => {
                let remoteVersion = currentVersion;
                if (!showErr) {
                    try { remoteVersion = JSON.parse(showOut).version || currentVersion; } catch (e) { /* ignore */ }
                }
                res.json({ success: true, updateAvailable: behind > 0, behind, currentVersion, remoteVersion });
            });
        });
    });
});

// The server checkout is a pure deployment copy (database, .env, sessions are git-ignored), so the update
// does not merge: it fetches origin/main and resets to it. A former `git pull` + `git stash pop` could end in
// a merge conflict (e.g. package-lock.json changed by npm install) which then blocked every later update
// ("you have unmerged files"). Local changes to tracked files are kept in `git stash list` for recovery.
app.post('/api/update', apiLimiter, (req, res) => {
    const execOpts = { timeout: 10000, cwd: __dirname };
    const run = (cmd, opts = {}) => new Promise((resolve, reject) => {
        exec(cmd, { ...execOpts, ...opts }, (err, stdout, stderr) => {
            if (err) { err.detail = String(stderr || err.message || '').trim(); return reject(err); }
            resolve(String(stdout).trim());
        });
    });
    const tryRun = (cmd, opts) => run(cmd, opts).catch(e => { console.warn(`Git Warnung (${cmd}):`, e.detail); return null; });

    (async () => {
        console.log('📥 Update gestartet. Arbeitsverzeichnis:', __dirname);
        // Leftover conflict from an earlier update -> clear it, otherwise stash and reset refuse to work
        await tryRun('git reset --merge');
        await tryRun(`git stash push -m "update ${new Date().toISOString()}"`);

        try {
            await run('git fetch origin main', { timeout: 60000 });
        } catch (e) {
            console.error('Git Fetch Error:', e.detail);
            return res.status(500).json({ success: false, message: `Git Fetch fehlgeschlagen: ${e.detail}` });
        }

        const before = await tryRun('git rev-parse HEAD');
        const target = await run('git rev-parse origin/main');
        if (before === target) {
            return res.json({ success: true, status: 'no_updates', message: 'Bereits auf dem neuesten Stand.' });
        }

        await run('git reset --hard origin/main');
        console.log(`Git: ${before ? before.slice(0, 7) : '?'} -> ${target.slice(0, 7)}`);

        try {
            await run('npm install --no-audit --no-fund', { timeout: 120000 });
        } catch (e) {
            console.warn('NPM Install Warning:', e.detail);
        }

        res.json({ success: true, status: 'updated', message: 'Update erfolgreich. Server startet neu...' });
        setTimeout(() => {
            console.log('🔄 Starte Server neu...');
            db.close();
            process.exit(0);
        }, 3000);
    })().catch(e => {
        console.error('Update Error:', e.detail || e.message);
        if (!res.headersSent) res.status(500).json({ success: false, message: `Update fehlgeschlagen: ${e.detail || e.message}` });
    });
});


// =======================
// 14b. WHATSAPP & NOTIFICATION API ROUTES
// =======================

// Get WhatsApp QR Code for scanning
app.get('/api/whatsapp/qr', apiLimiter, (req, res) => {
    if (waReady) {
        return res.json({ success: true, status: 'ready', message: 'WhatsApp ist bereits verbunden.' });
    }
    if (waQrCode) {
        return res.json({ success: true, status: 'qr_pending', qr: waQrCode });
    }
    res.json({ success: true, status: waStatus, message: 'Kein QR-Code verf\u00fcgbar. Bitte warten...' });
});

// Get WhatsApp connection status
app.get('/api/whatsapp/status', apiLimiter, (req, res) => {
    try {
        const logs = db.getRecentNotifications(20);
        const allSettings = db.getAllSettings();
        res.json({
            success: true,
            waStatus,
            waReady,
            enabled: allSettings.notifications_enabled !== 'false',
            configured: !!allSettings.wa_phone,
            logs
        });
    } catch (e) {
        console.error('WA Status Error:', e.message);
        res.status(500).json({ error: 'Status konnte nicht geladen werden' });
    }
});

// Logout WhatsApp (to re-scan QR)
app.post('/api/whatsapp/logout', apiLimiter, async (req, res) => {
    try {
        if (waClient) {
            await waClient.logout();
            waReady = false;
            waStatus = 'disconnected';
            waQrCode = null;
            // Re-initialize for new QR
            setTimeout(() => initWhatsApp(), 2000);
        }
        res.json({ success: true, message: 'WhatsApp abgemeldet. Neuer QR-Code wird generiert...' });
    } catch (e) {
        console.error('WA Logout Error:', e.message);
        res.status(500).json({ error: 'Abmeldung fehlgeschlagen' });
    }
});

// Test WhatsApp message
app.post('/api/notifications/test-whatsapp', apiLimiter, async (req, res) => {
    try {
        if (!waReady) {
            return res.status(400).json({ error: 'WhatsApp ist nicht verbunden. Bitte zuerst QR-Code scannen.' });
        }

        const allSettings = db.getAllSettings();
        let phones = [];
        const rawPhones = allSettings.wa_phones;
        if (Array.isArray(rawPhones)) {
            phones = rawPhones;
        } else {
            try { phones = JSON.parse(rawPhones || '[]'); } catch (e) {
                if (allSettings.wa_phone) phones = [allSettings.wa_phone];
            }
        }
        if (phones.length === 0 && allSettings.wa_phone) {
            phones.push(allSettings.wa_phone);
        }

        const validPhones = phones.filter(p => p && String(p).trim());
        if (validPhones.length === 0) {
            return res.status(400).json({ error: 'Es sind keine Empf\u00e4nger-Nummern hinterlegt.' });
        }

        const msg = '\u2705 Test-Nachricht von Rental Invoice! WhatsApp-Benachrichtigungen funktionieren.';
        let anySent = false;

        for (const phone of validPhones) {
            const sent = await sendWhatsApp(String(phone).trim(), msg);
            if (sent) anySent = true;
        }

        db.logNotification('test', msg, anySent ? 'sent' : 'failed');

        if (anySent) {
            res.json({ success: true, message: `Test-Nachricht an ${validPhones.length} Nummer(n) gesendet!` });
        } else {
            res.status(500).json({ error: 'Nachricht konnte an keine Nummer gesendet werden.' });
        }
    } catch (e) {
        console.error('Test WhatsApp Error:', e.message);
        res.status(500).json({ error: 'Fehler beim Senden' });
    }
});

// =======================
// 15. CATCH-ALL & ERROR HANDLING
// =======================
app.use((req, res) => {
    res.status(404).send('Not Found');
});

app.use((err, req, res, next) => {
    console.error('Server Error:', err.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten' });
});

// =======================
// 15. START SERVER
// =======================
app.listen(PORT, () => {
    console.log(`🔒 Server (Hardened + SQLite) running on http://localhost:${PORT}`);
    console.log(`   Static files: ${PUBLIC_DIR}`);

    // Initialize bots
    initWhatsApp();
    initTelegram();
});

// Graceful shutdown
process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT', () => { db.close(); process.exit(0); });
