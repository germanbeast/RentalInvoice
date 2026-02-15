const express = require('express');
const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const ical = require('node-ical');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(cookieParser());
app.use(session({
    secret: process.env.SESSION_SECRET || 'ferienwohnung-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Initialisiere Users-Datei falls nicht vorhanden oder Passwort-Update nötig
function initUsers() {
    let users = {};
    const defaultPassword = process.env.ADMIN_PASSWORD || 'admin123';

    if (fs.existsSync(USERS_FILE)) {
        users = JSON.parse(fs.readFileSync(USERS_FILE));

        // Passwort-Sync check: Wenn admin existiert, prüfe ob Bcrypt-Match mit .env
        if (users["admin"]) {
            const currentHash = users["admin"].password;
            const needsUpdate = !bcrypt.compareSync(defaultPassword, currentHash);

            if (needsUpdate) {
                console.log('🔄 ADMIN_PASSWORD in .env hat sich geändert. Aktualisiere Datenbank...');
                users["admin"].password = bcrypt.hashSync(defaultPassword, 10);
                fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
                console.log('✅ Admin-Passwort erfolgreich synchronisiert.');
            }
        }
    } else {
        // Neuinstallation
        const hashedPassword = bcrypt.hashSync(defaultPassword, 10);
        users = {
            "admin": {
                username: "admin",
                password: hashedPassword,
                role: "admin"
            }
        };
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        console.log('✅ Standard-Benutzer "admin" erstellt.');
    }
}
initUsers();

// Auth Middleware
function ensureAuthenticated(req, res, next) {
    if (req.session.user) {
        return next();
    }
    // API Call?
    if (req.path.startsWith('/api/') && req.path !== '/api/login') {
        return res.status(401).json({ error: 'Nicht authentifiziert' });
    }
    // Static file/Page? -> Redirect handled in frontend or serve login
    next();
}

// API: Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    console.log(`🔐 Login-Versuch fÃ¼r Benutzer: ${username}`);

    const users = JSON.parse(fs.readFileSync(USERS_FILE));
    const user = users[username];

    if (!user) {
        console.warn(`❌ Benutzer ${username} nicht gefunden.`);
        return res.status(401).json({ success: false, message: 'Benutzer nicht gefunden' });
    }

    const isMatch = bcrypt.compareSync(password, user.password);
    console.log(`🔍 Passwort-Match fÃ¼r ${username}: ${isMatch}`);

    if (isMatch) {
        req.session.user = { username: user.username, role: user.role };
        res.json({ success: true, user: req.session.user });
    } else {
        res.status(401).json({ success: false, message: 'UngÃ¼ltiges Passwort' });
    }
});

// API: Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// API: Me (Check status)
app.get('/api/me', (req, res) => {
    if (req.session.user) {
        res.json({ authenticated: true, user: req.session.user });
    } else {
        res.json({ authenticated: false });
    }
});

// Statische Dateien nach Auth-Check
app.use(ensureAuthenticated);
app.use(express.static(path.join(__dirname)));

// API: Generate PDF
app.post('/api/generate-pdf', async (req, res) => {
    try {
        const { html } = req.body;
        if (!html) return res.status(400).send('HTML content is required');

        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        await page.setContent(html, { waitUntil: 'networkidle0' });

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
        console.error('PDF Generation Error:', error);
        res.status(500).send('Failed to generate PDF');
    }
});

// API: Send Email
app.post('/api/send-email', async (req, res) => {
    try {
        const { to, subject, body, pdfBuffer, fileName, smtpConfig } = req.body;

        if (!smtpConfig || !smtpConfig.host) {
            return res.status(400).send('SMTP configuration is missing');
        }

        const transporter = nodemailer.createTransport({
            host: smtpConfig.host,
            port: smtpConfig.port || 587,
            secure: smtpConfig.secure || false,
            auth: {
                user: smtpConfig.user,
                pass: smtpConfig.pass
            }
        });

        const mailOptions = {
            from: smtpConfig.from || smtpConfig.user,
            to,
            subject,
            text: body,
            attachments: [
                {
                    filename: fileName || 'Rechnung.pdf',
                    content: Buffer.from(pdfBuffer, 'base64')
                }
            ]
        };

        await transporter.sendMail(mailOptions);
        res.send({ success: true, message: 'Email sent successfully' });
    } catch (error) {
        console.error('Email Sending Error:', error);
        res.status(500).send('Failed to send email: ' + error.message);
    }
});

// API: Fetch iCal Calendar
app.post('/api/calendar/fetch', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
        console.log(`📅 Fetching Calendar: ${url}`);
        const response = await axios.get(url);
        const data = ical.parseICS(response.data);

        const events = [];
        for (let k in data) {
            if (data.hasOwnProperty(k)) {
                const ev = data[k];
                if (ev.type === 'VEVENT') {
                    events.push({
                        summary: ev.summary,
                        start: ev.start,
                        end: ev.end,
                        description: ev.description,
                        uid: ev.uid
                    });
                }
            }
        }

        // Sort by date (newest first)
        events.sort((a, b) => new Date(b.start) - new Date(a.start));

        res.json({ success: true, events });
    } catch (error) {
        console.error('iCal Fetch Error:', error);
        res.status(500).json({ success: false, message: 'Fehler beim Laden des Kalenders: ' + error.message });
    }
});

// API: Self-Update
app.post('/api/update', (req, res) => {
    const { exec } = require('child_process');
    console.log('🔄 Update-Check gestartet...');

    // 1. Git Fetch um Remote-Status zu prüfen
    exec('git fetch origin main', (fetchErr) => {
        if (fetchErr) {
            return res.status(500).json({ success: false, message: 'Git Fetch failed: ' + fetchErr.message });
        }

        // 2. Prüfen ob Änderungen vorliegen
        exec('git status -uno', (statusErr, stdout) => {
            if (statusErr) {
                return res.status(500).json({ success: false, message: 'Git Status failed' });
            }

            // Check for both English and German "up to date" messages
            const upToDate = stdout.includes('Your branch is up to date') ||
                stdout.includes('Auf dem neuesten Stand');

            if (upToDate) {
                return res.json({ success: true, status: 'no_updates', message: 'Keine Updates verfügbar.' });
            }

            // 3. Wenn Updates da sind -> Pull & Install
            console.log('📥 Neue Updates gefunden. Starte Pull...');
            // Force pull if needed or at least stay robust
            exec('git pull origin main', (pullErr, pullStdout) => {
                if (pullErr) {
                    console.error('Git Pull Error:', pullErr);
                    return res.status(500).json({ success: false, message: 'Git Pull failed' });
                }

                exec('npm install', (npmErr) => {
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

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
