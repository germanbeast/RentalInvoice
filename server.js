/* ===========================
   Ferienwohnung Rechnung – Server (Hardened + SQLite)
   =========================== */

const express = require('express');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const ical = require('node-ical');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const db = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

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
        const cleaned = phone.replace(/[^\d]/g, '');
        const chatId = cleaned + '@c.us';
        await waClient.sendMessage(chatId, message);
        console.log(`\u2709\ufe0f  WhatsApp gesendet an ${phone}: ${message.substring(0, 50)}...`);
        return true;
    } catch (e) {
        console.error('\u274c WhatsApp-Fehler:', e.message);
        return false;
    }
}

// Send to all configured notification recipients
async function sendToAllRecipients(message) {
    const allSettings = db.getAllSettings();
    let phones = [];
    try {
        phones = JSON.parse(allSettings.wa_phones || '[]');
    } catch (e) {
        if (allSettings.wa_phone) phones = [allSettings.wa_phone];
    }
    if (phones.length === 0) return false;
    let anySent = false;
    for (const phone of phones) {
        if (phone && phone.trim()) {
            const sent = await sendWhatsApp(phone.trim(), message);
            if (sent) anySent = true;
        }
    }
    return anySent;
}

// 2FA Code Storage (in-memory, short-lived)
const pending2FA = new Map(); // sessionId -> { code, username, expiresAt }

// Initialize WhatsApp
initWhatsApp();

// =======================
// 1c. SCHEDULED JOBS (Cron)
// =======================
function formatDateDE(dateStr) {
    if (!dateStr) return '\u2014';
    const d = new Date(dateStr);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Job 1: iCal Polling (every 15 minutes)
cron.schedule('*/15 * * * *', async () => {
    try {
        const allSettings = db.getAllSettings();
        const icalUrl = allSettings.booking_ical;
        const waPhone = allSettings.wa_phone;
        const notifyEnabled = allSettings.notifications_enabled;

        if (!icalUrl || notifyEnabled === 'false') return;
        if (!waReady) return;

        console.log('\ud83d\udcc5 iCal-Polling l\u00e4uft...');
        const response = await axios.get(icalUrl, {
            timeout: 10000,
            maxContentLength: 5 * 1024 * 1024,
            headers: { 'User-Agent': 'RentalInvoice/1.0' }
        });
        const data = ical.parseICS(response.data);

        let newCount = 0;
        for (const k in data) {
            if (!data.hasOwnProperty(k)) continue;
            const ev = data[k];
            if (ev.type !== 'VEVENT' || !ev.uid) continue;

            const checkin = ev.start ? new Date(ev.start).toISOString().split('T')[0] : null;
            const checkout = ev.end ? new Date(ev.end).toISOString().split('T')[0] : null;
            const summary = String(ev.summary || 'Buchung').substring(0, 500);

            const existing = db.getBookingByUid(ev.uid);
            const result = db.upsertBooking({
                uid: ev.uid,
                summary,
                checkin,
                checkout,
                description: String(ev.description || '').substring(0, 2000)
            });

            if (result.inserted && !existing) {
                newCount++;
                const msg = `\ud83c\udfe0 Neue Buchung!\n${summary}\n\ud83d\udcc5 ${formatDateDE(checkin)} \u2013 ${formatDateDE(checkout)}`;
                const sent = await sendToAllRecipients(msg);
                db.logNotification('new_booking', msg, sent ? 'sent' : 'failed');
            }
        }

        if (newCount > 0) {
            console.log(`\ud83c\udf89 ${newCount} neue Buchung(en) erkannt und benachrichtigt.`);
        }
    } catch (e) {
        console.error('\u274c iCal-Polling Fehler:', e.message);
    }
});

// Job 2: Reminder Check (daily at 08:00)
cron.schedule('0 8 * * *', async () => {
    try {
        const allSettings = db.getAllSettings();
        const waPhone = allSettings.wa_phone;
        const notifyEnabled = allSettings.notifications_enabled;
        const reminderDays = parseInt(allSettings.reminder_days) || 2;

        if (!waReady || notifyEnabled === 'false') return;

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
});

console.log('\u2705 Cron-Jobs registriert (iCal: alle 15 Min, Reminder: t\u00e4glich 08:00)');

// =======================
// 2. SECURITY HEADERS (Helmet)
// =======================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'"],
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
    max: 30,
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
    const whitelist = ['/api/login', '/api/login/verify', '/api/login/recover', '/api/whatsapp/qr'];
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

app.use(ensureAuthenticated);

// =======================
// 6. STATIC FILE SERVING
// =======================
app.use(express.static(PUBLIC_DIR, {
    dotfiles: 'deny',
    index: 'index.html',
    extensions: ['html']
}));

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
        res.json({ success: true, message: 'Einstellungen gespeichert' });
    } catch (e) {
        console.error('Settings PUT Error:', e.message);
        res.status(500).json({ error: 'Einstellungen konnten nicht gespeichert werden' });
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
        res.json({ success: true, guest, invoices });
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

app.delete('/api/guests/:id', apiLimiter, (req, res) => {
    try {
        db.deleteGuest(parseInt(req.params.id));
        res.json({ success: true, message: 'Gast gelöscht' });
    } catch (e) {
        console.error('Guest DELETE Error:', e.message);
        res.status(500).json({ error: 'Gast konnte nicht gelöscht werden' });
    }
});

// =======================
// 10. INVOICES API
// =======================
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
        const { logo_base64, primary_color } = req.body;

        // Validate base64 size (max 2MB)
        if (logo_base64 && logo_base64.length > 2 * 1024 * 1024) {
            return res.status(400).json({ error: 'Logo ist zu groß (max 2MB)' });
        }

        db.saveBranding({ logo_base64, primary_color });
        res.json({ success: true, message: 'Branding gespeichert' });
    } catch (e) {
        console.error('Branding POST Error:', e.message);
        res.status(500).json({ error: 'Branding konnte nicht gespeichert werden' });
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
            if (request.resourceType() === 'document') {
                request.continue();
            } else {
                request.abort();
            }
        });

        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            preferCSSPageSize: true
        });

        await browser.close();

        res.contentType('application/pdf');
        res.send(pdf);
    } catch (error) {
        console.error('PDF Generation Error:', error.message);
        res.status(500).json({ error: 'PDF-Generierung fehlgeschlagen' });
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

// API: Self-Update
app.post('/api/update', apiLimiter, (req, res) => {
    const { exec } = require('child_process');
    console.log('🔄 Update-Check gestartet...');

    exec('git fetch origin main', { timeout: 30000 }, (fetchErr) => {
        if (fetchErr) {
            return res.status(500).json({ success: false, message: 'Git Fetch fehlgeschlagen' });
        }

        exec('git status -uno', { timeout: 10000 }, (statusErr, stdout) => {
            if (statusErr) {
                return res.status(500).json({ success: false, message: 'Git Status fehlgeschlagen' });
            }

            const upToDate = stdout.includes('Your branch is up to date') ||
                stdout.includes('Auf dem neuesten Stand');

            if (upToDate) {
                return res.json({ success: true, status: 'no_updates', message: 'Keine Updates verfügbar.' });
            }

            console.log('📥 Neue Updates gefunden. Starte Pull...');
            exec('git stash', { timeout: 10000 }, (stashErr) => {
                if (stashErr) console.warn('Git Stash Warning:', stashErr.message);

                exec('git pull origin main', { timeout: 60000 }, (pullErr) => {
                    if (pullErr) {
                        console.error('Git Pull Error:', pullErr);
                        return res.status(500).json({ success: false, message: 'Git Pull fehlgeschlagen' });
                    }

                    exec('git stash pop', { timeout: 10000 }, (popErr) => {
                        if (popErr) console.warn('Git Stash Pop Warning:', popErr.message);

                        exec('npm install', { timeout: 120000 }, (npmErr) => {
                            if (npmErr) console.warn('NPM Install Warning');

                            res.json({ success: true, status: 'updated', message: 'Update erfolgreich. Server startet neu...' });

                            setTimeout(() => {
                                console.log('🔄 Starte Server neu...');
                                db.close();
                                process.exit(0);
                            }, 1500);
                        });
                    });
                });
            });
        });
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
        const waPhone = allSettings.wa_phone;

        if (!waPhone) {
            return res.status(400).json({ error: 'Empf\u00e4nger-Nummer muss in den Einstellungen hinterlegt sein.' });
        }

        const msg = '\u2705 Test-Nachricht von Rental Invoice! WhatsApp-Benachrichtigungen funktionieren.';
        const sent = await sendWhatsApp(waPhone, msg);
        db.logNotification('test', msg, sent ? 'sent' : 'failed');

        if (sent) {
            res.json({ success: true, message: 'Test-Nachricht gesendet!' });
        } else {
            res.status(500).json({ error: 'Nachricht konnte nicht gesendet werden.' });
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
});

// Graceful shutdown
process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT', () => { db.close(); process.exit(0); });
