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
// 1b. WhatsApp via CallMeBot
// =======================
async function sendWhatsApp(phone, apiKey, message) {
    if (!phone || !apiKey) {
        console.warn('⚠️  WhatsApp nicht konfiguriert (Nummer oder API-Key fehlt)');
        return false;
    }
    try {
        const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}&apikey=${encodeURIComponent(apiKey)}`;
        const res = await axios.get(url, { timeout: 15000 });
        console.log(`✉️  WhatsApp gesendet an ${phone}: ${message.substring(0, 50)}...`);
        return true;
    } catch (e) {
        console.error('❌ WhatsApp-Fehler:', e.message);
        return false;
    }
}

// =======================
// 1c. SCHEDULED JOBS (Cron)
// =======================
function formatDateDE(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Job 1: iCal Polling (every 15 minutes)
cron.schedule('*/15 * * * *', async () => {
    try {
        const allSettings = db.getAllSettings();
        const icalUrl = allSettings.booking_ical;
        const waPhone = allSettings.wa_phone;
        const waApiKey = allSettings.wa_apikey;
        const notifyEnabled = allSettings.notifications_enabled;

        if (!icalUrl || notifyEnabled === 'false') return;

        console.log('📅 iCal-Polling läuft...');
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

            // Only notify for truly new bookings
            if (result.inserted && !existing) {
                newCount++;
                const msg = `🏠 Neue Buchung!\n${summary}\n📅 ${formatDateDE(checkin)} – ${formatDateDE(checkout)}`;
                const sent = await sendWhatsApp(waPhone, waApiKey, msg);
                db.logNotification('new_booking', msg, sent ? 'sent' : 'failed');
            }
        }

        if (newCount > 0) {
            console.log(`🎉 ${newCount} neue Buchung(en) erkannt und benachrichtigt.`);
        }
    } catch (e) {
        console.error('❌ iCal-Polling Fehler:', e.message);
    }
});

// Job 2: Reminder Check (daily at 08:00)
cron.schedule('0 8 * * *', async () => {
    try {
        const allSettings = db.getAllSettings();
        const waPhone = allSettings.wa_phone;
        const waApiKey = allSettings.wa_apikey;
        const notifyEnabled = allSettings.notifications_enabled;
        const reminderDays = parseInt(allSettings.reminder_days) || 2;

        if (!waPhone || !waApiKey || notifyEnabled === 'false') return;

        console.log('⏰ Erinnerungs-Check läuft...');
        const upcoming = db.getUpcomingBookings(reminderDays);

        for (const booking of upcoming) {
            const msg = `⏰ Erinnerung: ${booking.summary || 'Gast'} reist bald an!\n📅 Anreise: ${formatDateDE(booking.checkin)}\n📅 Abreise: ${formatDateDE(booking.checkout)}`;
            const sent = await sendWhatsApp(waPhone, waApiKey, msg);
            if (sent) {
                db.markReminderSent(booking.id);
            }
            db.logNotification('reminder', msg, sent ? 'sent' : 'failed');
        }

        if (upcoming.length > 0) {
            console.log(`⏰ ${upcoming.length} Erinnerung(en) versendet.`);
        }
    } catch (e) {
        console.error('❌ Reminder-Check Fehler:', e.message);
    }
});

console.log('✅ Cron-Jobs registriert (iCal: alle 15 Min, Reminder: täglich 08:00)');

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
    if (req.path === '/api/login') return next();

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
app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;

    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ success: false, message: 'Ungültige Eingabe' });
    }

    const sanitizedUsername = username.trim().substring(0, 50);
    if (!/^[a-zA-Z0-9_-]+$/.test(sanitizedUsername)) {
        return res.status(400).json({ success: false, message: 'Ungültiger Benutzername' });
    }

    const user = db.getUser(sanitizedUsername);

    if (!user) {
        bcrypt.compareSync('dummy', '$2a$12$invalidhashforsecuritypurposesonly.');
        return res.status(401).json({ success: false, message: 'Ungültige Anmeldedaten' });
    }

    const isMatch = bcrypt.compareSync(password, user.password);

    if (isMatch) {
        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regeneration error:', err);
                return res.status(500).json({ success: false, message: 'Server-Fehler' });
            }
            req.session.user = { username: user.username, role: user.role };
            res.json({ success: true, user: req.session.user });
        });
    } else {
        return res.status(401).json({ success: false, message: 'Ungültige Anmeldedaten' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ success: false, message: 'Logout fehlgeschlagen' });
        res.clearCookie('__sid');
        res.json({ success: true });
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
// 14b. NOTIFICATION API ROUTES
// =======================
app.get('/api/notifications/status', apiLimiter, (req, res) => {
    try {
        const logs = db.getRecentNotifications(20);
        const allSettings = db.getAllSettings();
        res.json({
            success: true,
            enabled: allSettings.notifications_enabled !== 'false',
            configured: !!(allSettings.wa_phone && allSettings.wa_apikey),
            logs
        });
    } catch (e) {
        console.error('Notification Status Error:', e.message);
        res.status(500).json({ error: 'Status konnte nicht geladen werden' });
    }
});

app.post('/api/notifications/test-whatsapp', apiLimiter, async (req, res) => {
    try {
        const allSettings = db.getAllSettings();
        const waPhone = allSettings.wa_phone;
        const waApiKey = allSettings.wa_apikey;

        if (!waPhone || !waApiKey) {
            return res.status(400).json({ error: 'WhatsApp-Nummer und API-Key m\u00fcssen in den Einstellungen hinterlegt sein.' });
        }

        const msg = '\u2705 Test-Nachricht von Rental Invoice! WhatsApp-Benachrichtigungen funktionieren.';
        const sent = await sendWhatsApp(waPhone, waApiKey, msg);
        db.logNotification('test', msg, sent ? 'sent' : 'failed');

        if (sent) {
            res.json({ success: true, message: 'Test-Nachricht gesendet!' });
        } else {
            res.status(500).json({ error: 'Nachricht konnte nicht gesendet werden. Pr\u00fcfe Nummer und API-Key.' });
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
