/* ===========================
   Ferienwohnung Rechnung – Server (Hardened)
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
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// =======================
// 1. SECURITY HEADERS (Helmet)
// =======================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false, // needed for fonts
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// =======================
// 2. RATE LIMITING
// =======================
// Global: 100 requests per minute
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Zu viele Anfragen. Bitte warten.' }
});
app.use(globalLimiter);

// Login: 5 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Zu viele Login-Versuche. Bitte warte 15 Minuten.' },
    skipSuccessfulRequests: true
});

// API: 30 requests per minute
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'API Rate-Limit erreicht. Bitte warten.' }
});

// =======================
// 3. MIDDLEWARE
// =======================
app.use(bodyParser.json({ limit: '5mb' })); // Limit payload size
app.use(cookieParser());

// Generate a strong session secret if not set
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
    console.warn('⚠️  Kein SESSION_SECRET in .env gesetzt! Zufälliger Key wird verwendet (ändert sich bei Neustart).');
}

app.use(session({
    secret: sessionSecret,
    name: '__sid', // Don't reveal framework
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'strict',
        maxAge: 8 * 60 * 60 * 1000 // 8 hours
    }
}));

// Disable Express fingerprinting
app.disable('x-powered-by');

// =======================
// 4. USER MANAGEMENT
// =======================
function initUsers() {
    let users = {};
    const defaultPassword = process.env.ADMIN_PASSWORD || 'admin123';

    if (fs.existsSync(USERS_FILE)) {
        try {
            users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        } catch (e) {
            console.error('❌ users.json ist beschädigt. Erstelle neu...');
            users = {};
        }

        if (users["admin"]) {
            const currentHash = users["admin"].password;
            const needsUpdate = !bcrypt.compareSync(defaultPassword, currentHash);

            if (needsUpdate) {
                console.log('🔄 ADMIN_PASSWORD in .env hat sich geändert. Aktualisiere...');
                users["admin"].password = bcrypt.hashSync(defaultPassword, 12);
                fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                console.log('✅ Admin-Passwort synchronisiert.');
            }
        }
    }

    if (!users["admin"]) {
        const hashedPassword = bcrypt.hashSync(defaultPassword, 12);
        users["admin"] = {
            username: "admin",
            password: hashedPassword,
            role: "admin"
        };
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        console.log('✅ Standard-Benutzer "admin" erstellt.');
    }
}
initUsers();

// =======================
// 5. AUTHENTICATION
// =======================

// Auth Middleware – STRICT: blocks ALL unauthenticated access except login page and login API
function ensureAuthenticated(req, res, next) {
    // Always allow login API
    if (req.path === '/api/login') {
        return next();
    }

    // Check if authenticated
    if (req.session && req.session.user) {
        return next();
    }

    // Unauthenticated: only allow the login page itself (index.html serves both login + app)
    if (req.path === '/' || req.path === '/index.html') {
        return next();
    }

    // Allow loading CSS/JS needed for the login page
    const allowedLoginAssets = ['/styles.css', '/app.js'];
    if (allowedLoginAssets.includes(req.path)) {
        return next();
    }

    // Everything else: DENIED
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Nicht authentifiziert' });
    }

    // Non-API requests: return 404 to not reveal file existence
    return res.status(404).send('Not Found');
}

// Apply auth middleware BEFORE static files
app.use(ensureAuthenticated);

// =======================
// 6. STATIC FILE SERVING (public/ only)
// =======================
// CRITICAL: Only serve from public/ directory, never the project root
app.use(express.static(PUBLIC_DIR, {
    dotfiles: 'deny',       // Block .env, .git, etc.
    index: 'index.html',
    extensions: ['html']
}));

// =======================
// 7. API ROUTES
// =======================

// API: Login (with rate limiting)
app.post('/api/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;

    // Input validation
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ success: false, message: 'Ungültige Eingabe' });
    }

    // Sanitize username (alphanumeric only, max 50 chars)
    const sanitizedUsername = username.trim().substring(0, 50);
    if (!/^[a-zA-Z0-9_-]+$/.test(sanitizedUsername)) {
        return res.status(400).json({ success: false, message: 'Ungültiger Benutzername' });
    }

    let users;
    try {
        users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (e) {
        console.error('❌ Fehler beim Lesen der users.json');
        return res.status(500).json({ success: false, message: 'Server-Fehler' });
    }

    const user = users[sanitizedUsername];

    if (!user) {
        // Timing-safe: still run bcrypt to prevent user enumeration
        bcrypt.compareSync('dummy', '$2a$12$invalidhashforsecuritypurposesonly.');
        return res.status(401).json({ success: false, message: 'Ungültige Anmeldedaten' });
    }

    const isMatch = bcrypt.compareSync(password, user.password);

    if (isMatch) {
        // Regenerate session to prevent session fixation
        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regeneration error:', err);
                return res.status(500).json({ success: false, message: 'Server-Fehler' });
            }
            req.session.user = { username: user.username, role: user.role };
            res.json({ success: true, user: req.session.user });
        });
    } else {
        // Generic error message to prevent user enumeration
        return res.status(401).json({ success: false, message: 'Ungültige Anmeldedaten' });
    }
});

// API: Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Logout fehlgeschlagen' });
        }
        res.clearCookie('__sid');
        res.json({ success: true });
    });
});

// API: Me (Check auth status)
app.get('/api/me', (req, res) => {
    if (req.session && req.session.user) {
        res.json({ authenticated: true, user: req.session.user });
    } else {
        res.json({ authenticated: false });
    }
});

// =======================
// 8. PROTECTED API ROUTES (all require auth via middleware above)
// =======================

// API: Generate PDF
app.post('/api/generate-pdf', apiLimiter, async (req, res) => {
    try {
        const { html } = req.body;
        if (!html) return res.status(400).json({ error: 'HTML content is required' });

        // Limit HTML size to prevent abuse (max 1MB)
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

        // Block network requests from the rendered page (prevent SSRF via HTML)
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

        // Input validation
        if (!to || !subject || !smtpConfig || !smtpConfig.host) {
            return res.status(400).json({ error: 'Pflichtfelder fehlen' });
        }

        // Validate email format
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

    // Input validation
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'URL is required' });
    }

    // SSRF Protection: Only allow HTTPS URLs and block internal IPs
    try {
        const parsed = new URL(url);

        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return res.status(400).json({ error: 'Nur HTTP(S)-URLs erlaubt' });
        }

        // Block internal/private IPs
        const hostname = parsed.hostname.toLowerCase();
        const blockedPatterns = [
            /^localhost$/i,
            /^127\./,
            /^10\./,
            /^172\.(1[6-9]|2\d|3[01])\./,
            /^192\.168\./,
            /^0\./,
            /^169\.254\./,
            /^\[?::1\]?$/,
            /^\[?fe80:/i,
            /^\[?fc00:/i,
            /^\[?fd/i
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
            maxContentLength: 5 * 1024 * 1024, // 5MB max
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
// 9. CATCH-ALL & ERROR HANDLING
// =======================

// Catch-all: Return 404 for any unknown routes (don't reveal structure)
app.use((req, res) => {
    res.status(404).send('Not Found');
});

// Global error handler: Never leak stack traces
app.use((err, req, res, next) => {
    console.error('Server Error:', err.message);
    res.status(500).json({ error: 'Ein Fehler ist aufgetreten' });
});

// =======================
// 10. START SERVER
// =======================
app.listen(PORT, () => {
    console.log(`🔒 Server (Hardened) running on http://localhost:${PORT}`);
    console.log(`   Static files: ${PUBLIC_DIR}`);
});
