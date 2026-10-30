/**
 * Emergency door opening via the guest website (/gast/notfall)
 *
 * When the outdoor Nuki keypad fails, a guest scans the emergency QR code at the door, logs in with booking code
 * + arrival date and can let the Nuki lock pull the latch. Safeguards:
 *  - off until the host switches it on (setting `emergency_door.enabled`)
 *  - the QR link carries a secret key; without it the button is not offered (proof the guest stands at the door).
 *    The host can generate a new key, which invalidates printed codes.
 *  - only a confirmed booking, only from check-in day + check-in time until check-out day + check-out time
 *  - max OPENINGS_PER_HOUR openings per booking, plus an IP rate limit against guessing
 *  - every attempt is logged (table door_emergency_log) and every opening is reported to the host (Telegram + push)
 */

const path = require('path');
const crypto = require('crypto');

const SITE_DIR = path.join(__dirname, 'guest-site');
const OPENINGS_PER_HOUR = 3;

function createEmergencyDoor({ express, rateLimit, db, botLogic, qrcode, notify, getSite, guestBooking, formatDateDE }) {
    const sql = () => db.getDb();

    sql().exec(`
        CREATE TABLE IF NOT EXISTS door_emergency_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER,
            guest_code TEXT,
            result TEXT NOT NULL,
            detail TEXT,
            ip TEXT,
            user_agent TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    function getConfig() {
        const c = db.getSetting('emergency_door') || {};
        if (!c.key) {
            c.key = crypto.randomBytes(16).toString('hex');
            db.setSetting('emergency_door', { ...c, enabled: !!c.enabled });
        }
        return { enabled: !!c.enabled, key: String(c.key) };
    }

    function keyOk(k) {
        const expected = getConfig().key;
        const given = String(k || '');
        return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    }

    // "YYYY-MM-DD HH:MM" in Berlin time; plain string comparison then works for the stay window
    function berlinNow() {
        return new Intl.DateTimeFormat('sv-SE', {
            timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
        }).format(new Date()).replace(',', '');
    }
    const hhmm = t => (/^\d{1,2}:\d{2}$/.test(String(t || '')) ? String(t).padStart(5, '0') : null);

    function stayWindow(b) {
        const site = getSite();
        return {
            from: `${b.checkin} ${hhmm(site.checkin_time) || '15:00'}`,
            until: `${b.checkout} ${hhmm(site.checkout_time) || '11:00'}`
        };
    }

    function openingsLastHour(bookingId) {
        return sql().prepare(
            "SELECT COUNT(*) AS n FROM door_emergency_log WHERE booking_id = ? AND result = 'opened' AND created_at >= datetime('now', '-1 hour')"
        ).get(bookingId).n;
    }

    /** Whether this session may open the door now; reason is shown to the guest. */
    function check(req, key) {
        if (!getConfig().enabled) return { allowed: false, reason: 'disabled' };
        if (!keyOk(key)) return { allowed: false, reason: 'key' };
        const b = guestBooking(req.session && req.session.guest);
        if (!b) return { allowed: false, reason: 'login' };
        const w = stayWindow(b);
        const now = berlinNow();
        const view = { booking: b, window: w };
        if (now < w.from) return { ...view, allowed: false, reason: 'early' };
        if (now >= w.until) return { ...view, allowed: false, reason: 'late' };
        if (openingsLastHour(b.id) >= OPENINGS_PER_HOUR) return { ...view, allowed: false, reason: 'limit' };
        return { ...view, allowed: true };
    }

    function log(req, b, result, detail) {
        try {
            sql().prepare('INSERT INTO door_emergency_log (booking_id, guest_code, result, detail, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
                .run(b ? b.id : null, b ? b.guest_code : null, result, detail || null, req.ip || '', String(req.get('user-agent') || '').substring(0, 200));
        } catch (e) { console.error('Notfall-Öffnen Log Fehler:', e.message); }
    }

    function guestName(b) {
        const g = b.guest_id ? db.getGuestById(b.guest_id) : null;
        return g && !botLogic.isPlaceholderGuestName(g.name) ? g.name : (b.source || 'Gast');
    }

    // -----------------------------------------------------------------------
    // Public routes (mounted under /gast)
    // -----------------------------------------------------------------------
    const router = express.Router();

    const tooMany = { success: false, error: 'Zu viele Versuche. Bitte warten Sie 15 Minuten oder rufen Sie uns an.' };
    const statusLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: tooMany });
    const openLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
        message: tooMany
    });

    router.get('/notfall', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(SITE_DIR, 'notfall.html'));
    });

    router.post('/api/notfall/status', statusLimiter, (req, res) => {
        res.set('Cache-Control', 'no-store');
        const c = check(req, req.body && req.body.key);
        const out = { success: true, allowed: c.allowed, reason: c.reason || null };
        if (c.window) {
            out.from = c.window.from;
            out.until = c.window.until;
        }
        // Shown with the logout link, also when the door cannot be opened right now
        const b = c.booking || guestBooking(req.session && req.session.guest);
        if (b) out.code = b.guest_code;
        res.json(out);
    });

    router.post('/api/notfall/open', openLimiter, async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const c = check(req, req.body && req.body.key);
        if (!c.allowed) {
            if (c.booking) log(req, c.booking, 'denied', c.reason);
            return res.status(403).json({ success: false, reason: c.reason });
        }
        const b = c.booking;
        const when = `${formatDateDE(b.checkin)} – ${formatDateDE(b.checkout)}`;
        try {
            await botLogic.nukiLockAction('unlatch');
        } catch (e) {
            log(req, b, 'error', e.message);
            console.error('❌ Notfall-Öffnen fehlgeschlagen:', e.message);
            notify(`⚠️ *Notfall-Öffnen fehlgeschlagen*\n${guestName(b)} (${b.guest_code}) · ${when}\n${e.message}\nBitte den Gast kontaktieren.`, 'nuki_emergency');
            return res.status(502).json({ success: false, error: 'Das Schloss hat nicht reagiert. Bitte rufen Sie uns an.' });
        }
        log(req, b, 'opened');
        console.log(`🚪 Notfall-Öffnen durch Gast ${b.guest_code} (${req.ip})`);
        notify(`🚪 *Tür per Notfall-QR geöffnet*\n${guestName(b)} (${b.guest_code}) · ${when}\nDer Gast hat die Tür über die Webseite geöffnet. Prüfe ggf. das Tastenfeld.`, 'nuki_emergency');
        res.json({ success: true });
    });

    // -----------------------------------------------------------------------
    // Admin routes (behind the login)
    // -----------------------------------------------------------------------
    function publicUrl(req) {
        const site = getSite();
        const base = site.public_url ? site.public_url.replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}/gast`;
        return `${base}/notfall?k=${getConfig().key}`;
    }

    function recentLog() {
        return sql().prepare('SELECT id, booking_id, guest_code, result, detail, ip, created_at FROM door_emergency_log ORDER BY id DESC LIMIT 30').all();
    }

    const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    function registerAdminRoutes(app, apiLimiter) {
        app.get('/api/notfall/settings', apiLimiter, (req, res) => {
            const c = getConfig();
            res.json({ success: true, enabled: c.enabled, url: publicUrl(req), hasPublicUrl: !!getSite().public_url, log: recentLog() });
        });

        app.put('/api/notfall/settings', apiLimiter, (req, res) => {
            const c = getConfig();
            const enabled = !!(req.body && req.body.enabled);
            db.setSetting('emergency_door', { ...c, enabled });
            res.json({ success: true, enabled });
        });

        // New key: printed QR codes stop working
        app.post('/api/notfall/new-key', apiLimiter, (req, res) => {
            const c = getConfig();
            db.setSetting('emergency_door', { ...c, key: crypto.randomBytes(16).toString('hex') });
            res.json({ success: true, url: publicUrl(req) });
        });

        // Printable notice with the QR code (A4/A5, open in the browser and print)
        app.get('/api/notfall/aushang', apiLimiter, async (req, res) => {
            try {
                const url = publicUrl(req);
                const svg = await qrcode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
                const site = getSite();
                const v = db.getSetting('vermieter') || {};
                res.set('Cache-Control', 'no-store');
                res.type('html').send(`<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notfall-QR-Code</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Hanken+Grotesk:wght@400;500&display=swap" rel="stylesheet">
<style>
  @page { size: A5 portrait; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f5f0e8; color: #1f1c18; font-family: "Hanken Grotesk", system-ui, sans-serif; }
  .sheet { max-width: 148mm; margin: 2rem auto; background: #fffdf9; border: 1px solid #1f1c18; padding: 12mm 10mm; text-align: center; }
  .kicker { font-size: 10pt; letter-spacing: .14em; text-transform: uppercase; color: #8a4b2a; margin: 0 0 4mm; }
  h1 { font-family: "Instrument Serif", Georgia, serif; font-weight: 400; font-size: 26pt; line-height: 1.1; margin: 0 0 4mm; }
  .qr { width: 72mm; margin: 6mm auto; }
  .qr svg { width: 100%; height: auto; display: block; }
  ol { text-align: left; font-size: 11pt; line-height: 1.5; margin: 0 auto 5mm; padding-left: 6mm; max-width: 110mm; }
  .contact { font-size: 10pt; border-top: 1px solid #1f1c18; padding-top: 3mm; margin-top: 4mm; }
  .en { font-size: 9pt; color: #5c554c; margin-top: 3mm; }
  .tools { text-align: center; margin: 1rem; font-size: 14px; }
  .tools button { font: inherit; padding: .5rem 1.2rem; border: 1px solid #1f1c18; background: #1f1c18; color: #f5f0e8; border-radius: 2px; cursor: pointer; }
  @media print { body { background: none; } .sheet { margin: 0 auto; border-width: 1px; } .tools { display: none; } }
</style></head><body>
<div class="tools"><button type="button" id="print">Drucken</button></div>
<div class="sheet">
  <p class="kicker">${escHtml(site.title || 'Ferienwohnung')}</p>
  <h1>Tastenfeld defekt?</h1>
  <p>Hier kommen Sie trotzdem in die Wohnung.</p>
  <div class="qr">${svg}</div>
  <ol>
    <li>QR-Code mit der Handy-Kamera scannen.</li>
    <li>Mit Buchungscode und Anreisedatum anmelden.</li>
    <li>„Tür öffnen“ tippen und gegen die Tür drücken.</li>
  </ol>
  <p class="en">Keypad not working? Scan the code, log in with your booking code and arrival date, tap “Tür öffnen”.</p>
  ${v.telefon ? `<p class="contact">Hilfe / Help: ${escHtml(v.telefon)}</p>` : ''}
</div>
<script>document.getElementById('print').addEventListener('click', () => print());</script>
</body></html>`);
            } catch (e) {
                res.status(500).send('QR-Code konnte nicht erzeugt werden.');
            }
        });
    }

    return { router, registerAdminRoutes };
}

module.exports = createEmergencyDoor;
