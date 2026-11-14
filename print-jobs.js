// Automatic printing of new bookings on the printer in the apartment's network.
//
// The server (Netcup) cannot reach the printer at home, so the paired TV box does the printing:
// every new booking creates a print job here, the box sees open jobs in its minute sync
// (/api/tv-box/sync -> "print"), downloads the booking sheet as PDF from /api/tv-box/print/:id/pdf
// and sends it to the printer over IPP (port 631) or raw port 9100. It then reports the result.
//
// Settings key "printer": { enabled, host, port, path, mode: 'auto'|'ipp'|'raw', copies, manual }

const DEFAULTS = { enabled: false, host: '', port: 631, path: 'ipp/print', mode: 'auto', copies: 1, manual: true };
const MAX_ATTEMPTS = 4;
const RETRY_SENT_MS = 10 * 60 * 1000; // box took the job but never answered: hand it out again
const KEEP_DAYS = 60;
const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function createPrintJobs({ db, puppeteer, notify, isPlaceholderName, nightsBetween, formatDateDE }) {
    const sql = () => db.getDb();

    sql().exec(`
        CREATE TABLE IF NOT EXISTS print_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER,
            kind TEXT NOT NULL DEFAULT 'booking',
            title TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            error TEXT,
            attempts INTEGER DEFAULT 0,
            warned INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);

    function getConfig() {
        const c = db.getSetting('printer');
        return { ...DEFAULTS, ...(c && typeof c === 'object' ? c : {}) };
    }

    function cleanConfig(input, prev) {
        const b = input || {};
        const host = String(b.host == null ? prev.host : b.host).trim();
        if (host && !/^[a-zA-Z0-9.\-:\[\]]{1,100}$/.test(host)) throw new Error('Drucker-Adresse bitte als IP (z.B. 192.168.178.40) oder Name eingeben.');
        const mode = ['auto', 'ipp', 'raw'].includes(b.mode) ? b.mode : prev.mode;
        let port = parseInt(b.port, 10);
        if (!(port > 0 && port < 65536)) port = mode === 'raw' ? 9100 : 631;
        const path = String(b.path == null ? prev.path : b.path).trim().replace(/^\/+/, '').slice(0, 100);
        if (path && !/^[A-Za-z0-9._~\-\/]*$/.test(path)) throw new Error('Der IPP-Pfad darf nur Buchstaben, Ziffern und / enthalten.');
        const copies = Math.min(5, Math.max(1, parseInt(b.copies, 10) || 1));
        return {
            enabled: b.enabled == null ? prev.enabled : !!b.enabled,
            host, port, path: path || DEFAULTS.path, mode, copies,
            manual: b.manual == null ? prev.manual : !!b.manual
        };
    }

    function addJob(kind, bookingId, title) {
        const now = Date.now();
        const r = sql().prepare('INSERT INTO print_jobs (booking_id, kind, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(bookingId || null, kind, String(title || '').slice(0, 200), 'pending', now, now);
        return Number(r.lastInsertRowid);
    }

    /**
     * Called for every new booking. origin: 'portal' (Booking.com/Airbnb), 'direct' (website request
     * confirmed), 'manual' (entered in the admin). Does nothing when printing is switched off.
     */
    function queueBooking(bookingId, origin) {
        try {
            const cfg = getConfig();
            if (!cfg.enabled || !cfg.host) return null;
            if (origin === 'manual' && !cfg.manual) return null;
            const d = bookingData(bookingId);
            if (!d) return null;
            return addJob('booking', bookingId, `${d.name || 'Neue Buchung'} ${formatDateDE(d.checkin)}`);
        } catch (e) {
            console.error('Druckauftrag anlegen:', e.message);
            return null;
        }
    }

    /** Jobs the box should print now (part of the sync answer). */
    function forBox() {
        const cfg = getConfig();
        if (!cfg.enabled || !cfg.host) return null;
        const now = Date.now();
        const jobs = sql().prepare(`
            SELECT id, kind, title FROM print_jobs
            WHERE attempts < ? AND created_at > ?
              AND (status = 'pending' OR (status = 'sent' AND updated_at < ?))
            ORDER BY id LIMIT 5
        `).all(MAX_ATTEMPTS, now - 7 * 24 * 60 * 60 * 1000, now - RETRY_SENT_MS);
        if (!jobs.length) return null;
        const mark = sql().prepare("UPDATE print_jobs SET status = 'sent', attempts = attempts + 1, updated_at = ? WHERE id = ?");
        for (const j of jobs) mark.run(now, j.id);
        return {
            printer: { host: cfg.host, port: cfg.port, path: cfg.path, mode: cfg.mode, copies: cfg.copies },
            jobs: jobs.map(j => ({ id: j.id, title: j.title || 'Druck' }))
        };
    }

    async function reportResult(id, ok, error, via) {
        const job = sql().prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);
        if (!job) return false;
        const now = Date.now();
        if (ok) {
            sql().prepare("UPDATE print_jobs SET status = 'printed', error = ?, updated_at = ? WHERE id = ?").run(via ? `über ${via}` : null, now, id);
            return true;
        }
        const msg = String(error || 'unbekannter Fehler').slice(0, 300);
        const final = job.attempts >= MAX_ATTEMPTS;
        // not final: back to "pending", the box tries again with the next sync
        sql().prepare('UPDATE print_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(final ? 'failed' : 'pending', msg, now, id);
        if (final && !job.warned) {
            sql().prepare('UPDATE print_jobs SET warned = 1 WHERE id = ?').run(id);
            await notify(`🖨️ *Drucken fehlgeschlagen*\n${job.title || 'Druckauftrag'}\n${msg}\n\nIm Admin unter Einstellungen → Drucker kannst du es erneut versuchen.`, 'print_failed');
        }
        return true;
    }

    /** Jobs nobody picked up for 2 hours (box off or offline): tell the host once. */
    async function checkStale() {
        const cfg = getConfig();
        if (!cfg.enabled) return;
        const old = sql().prepare(`SELECT * FROM print_jobs WHERE status IN ('pending', 'sent') AND warned = 0 AND created_at < ? AND created_at > ?`)
            .all(Date.now() - 2 * 60 * 60 * 1000, Date.now() - 7 * 24 * 60 * 60 * 1000);
        if (!old.length) return;
        const mark = sql().prepare('UPDATE print_jobs SET warned = 1 WHERE id = ?');
        for (const j of old) mark.run(j.id);
        await notify(`🖨️ *Noch nicht gedruckt*\n${old.map(j => '• ' + (j.title || 'Druckauftrag')).join('\n')}\n\nDie TV-Box hat den Druck seit 2 Stunden nicht erledigt. Ist sie an und im WLAN? Sie druckt automatisch, sobald sie wieder online ist.`, 'print_failed');
        sql().prepare('DELETE FROM print_jobs WHERE created_at < ?').run(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
    }

    function recentJobs() {
        return sql().prepare('SELECT id, booking_id, kind, title, status, error, attempts, created_at, updated_at FROM print_jobs ORDER BY id DESC LIMIT 15').all();
    }

    function retryJob(id) {
        const r = sql().prepare("UPDATE print_jobs SET status = 'pending', attempts = 0, warned = 0, error = NULL, updated_at = ? WHERE id = ?").run(Date.now(), id);
        return r.changes > 0;
    }

    // ---------------------------------------------------------------------------------------------
    // Booking sheet
    // ---------------------------------------------------------------------------------------------
    function bookingData(bookingId) {
        const b = sql().prepare(`
            SELECT b.*, g.name AS guest_name, g.email AS guest_email, g.phone AS guest_phone
            FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id WHERE b.id = ?`).get(bookingId);
        if (!b) return null;
        const req = sql().prepare('SELECT * FROM booking_requests WHERE booking_id = ? ORDER BY id DESC LIMIT 1').get(bookingId);
        const source = b.source || (/^airbnb/i.test(b.summary || '') ? 'Airbnb' : 'Booking.com');
        const guessed = String(b.summary || '').split('(')[0].replace(/^(Buchung|Gast|Airbnb|Direkt):/i, '').trim();
        let name = b.guest_name || guessed;
        if (isPlaceholderName(name)) name = '';
        const ref = (String(b.summary || '').match(/\(([^)]+)\)\s*$/) || [])[1] || '';
        const site = db.getSetting('site') || {};
        return {
            id: b.id, source, name, checkin: b.checkin, checkout: b.checkout,
            nights: nightsBetween(b.checkin, b.checkout),
            adults: req ? req.adults : null, children: req ? req.children : null,
            email: (req && req.email) || b.guest_email || '', phone: (req && req.phone) || b.guest_phone || '',
            price: req && req.price_total ? req.price_total : null,
            pin: b.nuki_pin || '', code: b.guest_code || (req && req.code) || '', ref,
            message: req && req.message ? req.message : '',
            note: b.description && !/^Webseiten-Anfrage|^Im Admin eingetragen$/.test(b.description) ? b.description : '',
            hostNote: req && req.host_note ? req.host_note : '',
            title: site.title || 'Ferienwohnung', checkinTime: site.checkin_time || '', checkoutTime: site.checkout_time || ''
        };
    }

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const day = (ymd) => {
        const [y, m, d] = String(ymd).split('-').map(Number);
        return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${formatDateDE(ymd)}`;
    };
    const money = (v) => Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

    function sheetHtml(d, { test = false } = {}) {
        const stamp = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
        const persons = d.adults != null
            ? `${d.adults} Erwachsene${d.children ? `, ${d.children} Kind${d.children === 1 ? '' : 'er'}` : ''}` : '';
        const rows = [
            ['Personen', persons],
            ['Telefon', d.phone],
            ['E-Mail', d.email],
            ['Preis', d.price ? money(d.price) : ''],
            ['Türcode', d.pin ? `<b class="pin">${esc(d.pin)}</b>` : '', true],
            ['Buchungscode', d.code],
            ['Buchungsnummer', d.ref]
        ].filter(r => r[1]);
        const notes = [['Nachricht des Gastes', d.message], ['Notiz', d.hostNote], ['Notiz', d.note]].filter(n => n[1]);
        return `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>
            * { box-sizing: border-box; }
            body { font-family: "DejaVu Sans", Arial, sans-serif; color: #111; margin: 0; font-size: 12.5pt; }
            .top { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2.5pt solid #111; padding-bottom: 8pt; }
            .top h1 { font-size: 26pt; margin: 0; letter-spacing: -.5pt; }
            .src { font-size: 13pt; font-weight: 700; border: 1.5pt solid #111; border-radius: 6pt; padding: 3pt 10pt; }
            .house { color: #555; font-size: 10.5pt; margin-top: 4pt; }
            .name { font-size: 30pt; font-weight: 700; margin: 22pt 0 4pt; line-height: 1.1; }
            .name.empty { color: #777; font-size: 20pt; font-weight: 400; }
            .dates { display: flex; gap: 12pt; margin: 18pt 0; }
            .dates > div { flex: 1; border: 1.5pt solid #111; border-radius: 8pt; padding: 10pt 12pt; }
            .dates small { display: block; text-transform: uppercase; letter-spacing: 1pt; font-size: 9pt; color: #555; }
            .dates b { display: block; font-size: 17pt; margin-top: 3pt; }
            .dates span { font-size: 10.5pt; color: #444; }
            .dates .n { flex: 0 0 90pt; text-align: center; }
            .dates .n b { font-size: 26pt; }
            table { width: 100%; border-collapse: collapse; margin-top: 6pt; }
            td { padding: 7pt 0; border-bottom: .75pt solid #bbb; vertical-align: top; }
            td:first-child { width: 130pt; color: #555; }
            .pin { font-size: 18pt; letter-spacing: 3pt; }
            .note { margin-top: 16pt; border-left: 3pt solid #111; padding: 4pt 0 4pt 10pt; white-space: pre-wrap; }
            .note small { display: block; color: #555; font-size: 9.5pt; margin-bottom: 3pt; }
            .foot { position: fixed; bottom: 0; left: 0; right: 0; font-size: 9pt; color: #777; border-top: .75pt solid #bbb; padding-top: 5pt; }
            .test { margin-top: 24pt; padding: 12pt; border: 1.5pt dashed #111; border-radius: 8pt; font-size: 13pt; }
        </style></head><body>
            <div class="top"><h1>${test ? 'Testseite' : 'Neue Buchung'}</h1><span class="src">${esc(d.source)}</span></div>
            <div class="house">${esc(d.title)}</div>
            <div class="name${d.name ? '' : ' empty'}">${d.name ? esc(d.name) : 'Name noch nicht bekannt'}</div>
            <div class="dates">
                <div><small>Anreise</small><b>${esc(day(d.checkin))}</b>${d.checkinTime ? `<span>ab ${esc(d.checkinTime)} Uhr</span>` : ''}</div>
                <div><small>Abreise</small><b>${esc(day(d.checkout))}</b>${d.checkoutTime ? `<span>bis ${esc(d.checkoutTime)} Uhr</span>` : ''}</div>
                <div class="n"><small>Nächte</small><b>${d.nights}</b></div>
            </div>
            ${rows.length ? `<table>${rows.map(r => `<tr><td>${esc(r[0])}</td><td>${r[2] ? r[1] : esc(r[1])}</td></tr>`).join('')}</table>` : ''}
            ${notes.map(n => `<div class="note"><small>${esc(n[0])}</small>${esc(n[1])}</div>`).join('')}
            ${test ? '<div class="test">Wenn du dieses Blatt in der Hand hältst, funktioniert der automatische Druck. Ab jetzt kommt bei jeder neuen Buchung so ein Blatt aus dem Drucker.</div>' : ''}
            <div class="foot">Automatisch gedruckt am ${esc(stamp)} · Buchung #${esc(d.id || '–')}</div>
        </body></html>`;
    }

    function testData() {
        const site = db.getSetting('site') || {};
        const ymd = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
        return {
            id: 0, source: 'Test', name: 'Max Mustermann', checkin: ymd(7), checkout: ymd(10), nights: 3,
            adults: 2, children: 1, phone: '+49 170 1234567', email: 'max@example.de', price: 285, pin: '123456',
            code: 'TEST01', ref: '', message: '', note: '', hostNote: '',
            title: site.title || 'Ferienwohnung', checkinTime: site.checkin_time || '', checkoutTime: site.checkout_time || ''
        };
    }

    async function renderPdf(html) {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        try {
            const page = await browser.newPage();
            await page.setRequestInterception(true);
            page.on('request', (r) => (r.resourceType() === 'document' || r.url().startsWith('data:')) ? r.continue() : r.abort());
            await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
            return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', right: '16mm', bottom: '16mm', left: '16mm' } });
        } finally {
            await browser.close();
        }
    }

    async function jobPdf(id) {
        const job = sql().prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);
        if (!job) return null;
        if (job.kind === 'test') return renderPdf(sheetHtml(testData(), { test: true }));
        const d = bookingData(job.booking_id);
        if (!d) return null;
        return renderPdf(sheetHtml(d));
    }

    // ---------------------------------------------------------------------------------------------
    // Routes
    // ---------------------------------------------------------------------------------------------
    /** Box routes (public, checked with the box's own key). */
    function registerBoxRoutes(app, { authorized, limiter }) {
        app.get('/api/tv-box/print/:id/pdf', limiter, async (req, res) => {
            if (!authorized(req)) return res.status(403).end();
            try {
                const pdf = await jobPdf(parseInt(req.params.id, 10));
                if (!pdf) return res.status(404).end();
                res.set('Cache-Control', 'no-store');
                res.contentType('application/pdf');
                res.send(Buffer.from(pdf));
            } catch (e) {
                console.error('Buchungsblatt-PDF:', e.message);
                res.status(500).end();
            }
        });
        app.post('/api/tv-box/print/:id/result', limiter, async (req, res) => {
            if (!authorized(req)) return res.status(403).json({ success: false });
            const b = req.body || {};
            const ok = await reportResult(parseInt(req.params.id, 10), !!b.ok, b.error, ['ipp', 'raw'].includes(b.via) ? (b.via === 'ipp' ? 'IPP' : 'Port 9100') : '');
            res.json({ success: ok });
        });
    }

    /** Admin routes (settings area, reprint = bookings area via permissions.js). */
    function registerAdminRoutes(app, limiter, { boxPrinters }) {
        app.get('/api/settings/printer', limiter, (req, res) => {
            res.json({ success: true, config: getConfig(), jobs: recentJobs(), box: boxPrinters() });
        });
        app.put('/api/settings/printer', limiter, (req, res) => {
            try {
                const cfg = cleanConfig(req.body, getConfig());
                if (cfg.enabled && !cfg.host) return res.status(400).json({ success: false, error: 'Bitte zuerst die IP-Adresse des Druckers eintragen.' });
                db.setSetting('printer', cfg);
                res.json({ success: true, config: cfg });
            } catch (e) {
                res.status(400).json({ success: false, error: e.message });
            }
        });
        app.post('/api/settings/printer/test', limiter, (req, res) => {
            const cfg = getConfig();
            if (!cfg.host) return res.status(400).json({ success: false, error: 'Bitte zuerst die IP-Adresse des Druckers eintragen und speichern.' });
            if (!cfg.enabled) return res.status(400).json({ success: false, error: 'Bitte den automatischen Druck erst einschalten und speichern.' });
            res.json({ success: true, id: addJob('test', null, 'Testseite') });
        });
        app.post('/api/settings/printer/jobs/:id/retry', limiter, (req, res) => {
            res.json({ success: retryJob(parseInt(req.params.id, 10)) });
        });
        app.get('/api/settings/printer/preview', limiter, async (req, res) => {
            try {
                const id = parseInt(req.query.booking, 10);
                const d = id ? bookingData(id) : testData();
                if (!d) return res.status(404).end();
                const pdf = await renderPdf(sheetHtml(d, { test: !id }));
                res.contentType('application/pdf');
                res.setHeader('Content-Disposition', 'inline; filename="Buchungsblatt.pdf"');
                res.send(Buffer.from(pdf));
            } catch (e) {
                res.status(500).json({ success: false, error: 'PDF konnte nicht erstellt werden: ' + e.message });
            }
        });
        app.post('/api/bookings/:id/print', limiter, (req, res) => {
            const cfg = getConfig();
            if (!cfg.enabled || !cfg.host) return res.status(400).json({ success: false, error: 'Der Drucker ist noch nicht eingerichtet (Einstellungen → Drucker).' });
            const id = parseInt(req.params.id, 10);
            const d = bookingData(id);
            if (!d) return res.status(404).json({ success: false, error: 'Buchung nicht gefunden' });
            res.json({ success: true, id: addJob('booking', id, `${d.name || 'Buchung'} ${formatDateDE(d.checkin)}`) });
        });
    }

    return { getConfig, queueBooking, forBox, reportResult, checkStale, registerBoxRoutes, registerAdminRoutes, _sheetHtml: sheetHtml, _bookingData: bookingData };
}

module.exports = createPrintJobs;
