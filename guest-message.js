/**
 * Ready-to-copy message for the guest (sent to the host via Telegram, pasted into Booking.com / Airbnb by hand)
 *
 * The message contains the stay dates, the door code, a personal direct link to "Meine Buchung" that works
 * without a login and, when emergency opening is switched on, a direct link to the emergency door page.
 *
 * Direct link (/gast/b/<token>) safeguards:
 *  - one random token per booking (32 bytes, base64url = 43 characters, not guessable)
 *  - valid until LINK_GRACE_DAYS after check-out; a cancelled (deleted) booking ends it at once
 *  - the host can block it or replace it with a new one in Telegram; sessions opened with an old link end too
 *  - IP rate limit against guessing; a new session id on every use
 *  - opening the door still only works in the stay window (check-in time to check-out time, see emergency-door.js)
 */

const crypto = require('crypto');

const LINK_GRACE_DAYS = 1;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function createGuestMessage({ express, rateLimit, db, botLogic, getSite, ensureGuestCodes, emergencyDoor, berlinToday, addDays }) {
    const sql = () => db.getDb();

    const cols = sql().prepare('PRAGMA table_info(bookings)').all().map(c => c.name);
    if (!cols.includes('guest_link')) {
        sql().exec('ALTER TABLE bookings ADD COLUMN guest_link TEXT');
        console.log('✅ Migration: guest_link Spalte zu bookings hinzugefügt.');
    }
    if (!cols.includes('guest_link_used_at')) sql().exec('ALTER TABLE bookings ADD COLUMN guest_link_used_at TEXT');
    sql().exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_guest_link ON bookings(guest_link)');

    // -----------------------------------------------------------------------
    // Link handling
    // -----------------------------------------------------------------------
    const fingerprint = token => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
    const linkUntil = b => addDays(b.checkout, LINK_GRACE_DAYS);
    const linkActive = b => !!(b && b.guest_link && b.checkout && berlinToday() <= linkUntil(b));

    function baseUrl() {
        const s = getSite();
        return s.public_url ? String(s.public_url).replace(/\/+$/, '') : '';
    }

    /** Token of the booking; creates one when missing (or always with renew, which ends the old link). */
    function ensureLink(bookingId, renew = false) {
        const b = sql().prepare('SELECT id, guest_link FROM bookings WHERE id = ?').get(bookingId);
        if (!b) return null;
        if (b.guest_link && !renew) return b.guest_link;
        const token = crypto.randomBytes(32).toString('base64url');
        sql().prepare('UPDATE bookings SET guest_link = ?, guest_link_used_at = NULL WHERE id = ?').run(token, bookingId);
        return token;
    }

    function revokeLink(bookingId) {
        return sql().prepare('UPDATE bookings SET guest_link = NULL WHERE id = ?').run(bookingId).changes > 0;
    }

    function bookingByToken(token) {
        if (!TOKEN_RE.test(String(token || ''))) return null;
        const b = sql().prepare('SELECT * FROM bookings WHERE guest_link = ?').get(token);
        return linkActive(b) ? b : null;
    }

    // -----------------------------------------------------------------------
    // Message text
    // -----------------------------------------------------------------------
    const TEXT = {
        de: {
            hello: n => (n ? `Hallo ${n},` : 'Hallo,'),
            thanks: t => `vielen Dank für deine Buchung ${/^ferienwohnung\b/i.test(t) ? 'in der' : 'bei'} ${t}! Wir freuen uns auf dich.`,
            arrival: (d, t) => `📅 Anreise: ${d}${t ? ` ab ${t} Uhr` : ''}`,
            departure: (d, t) => `📅 Abreise: ${d}${t ? ` bis ${t} Uhr` : ''}`,
            pin: p => `🔑 Dein Türcode: ${p}\n(gilt ab der Anreise am Tastenfeld an der Tür)`,
            portal: 'Alle Infos zu deinem Aufenthalt (Anreise, WLAN, Hausregeln) findest du in deinem persönlichen Gästeportal, ganz ohne Anmeldung:',
            emergency: 'Falls das Tastenfeld einmal nicht funktioniert, kannst du die Tür während deines Aufenthalts auch hier öffnen:',
            private: 'Bitte gib die Links nicht weiter, sie gehören nur zu deiner Buchung.',
            code: c => `Dein Buchungscode (falls du doch einmal danach gefragt wirst): ${c}`,
            contact: p => (p ? `Bei Fragen erreichst du uns jederzeit hier oder unter ${p}.` : 'Bei Fragen erreichst du uns jederzeit hier.'),
            bye: 'Bis bald und eine gute Anreise!',
            locale: 'de-DE'
        },
        en: {
            hello: n => (n ? `Hi ${n},` : 'Hi,'),
            thanks: t => `thank you for booking ${t}! We are looking forward to welcoming you.`,
            arrival: (d, t) => `📅 Arrival: ${d}${t ? ` from ${t}` : ''}`,
            departure: (d, t) => `📅 Departure: ${d}${t ? ` by ${t}` : ''}`,
            pin: p => `🔑 Your door code: ${p}\n(works from your arrival at the keypad by the door)`,
            portal: 'All details for your stay (arrival, Wi-Fi, house rules) are in your personal guest portal, no login needed:',
            emergency: 'If the keypad ever fails, you can also open the door here during your stay:',
            private: 'Please do not share these links, they belong to your booking only.',
            code: c => `Your booking code (in case you are asked for it): ${c}`,
            contact: p => (p ? `If you have any questions, just message us here or call ${p}.` : 'If you have any questions, just message us here.'),
            bye: 'See you soon and safe travels!',
            locale: 'en-GB'
        }
    };

    function firstName(name) {
        const n = String(name || '').trim();
        if (!n) return '';
        // "Mustermann, Max" (Booking.com) -> "Max"
        if (n.includes(',')) return n.split(',')[1].trim().split(/\s+/)[0] || n.split(',')[0].trim();
        return n.split(/\s+/)[0];
    }

    function fmtDay(ymd, locale) {
        const [y, m, d] = ymd.split('-').map(Number);
        return new Intl.DateTimeFormat(locale, { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
            .format(new Date(Date.UTC(y, m - 1, d)));
    }

    /**
     * Builds the guest message for a booking.
     * Returns null when the booking does not exist, otherwise
     * { text, link, emergencyLink, name, booking, warnings: [] } (warnings are for the host, not the guest).
     */
    function compose(bookingId, lang = 'de') {
        const L = TEXT[lang] || TEXT.de;
        ensureGuestCodes();
        let b = sql().prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        if (!b) return null;

        const site = getSite();
        const settings = db.getAllSettings();
        const host = settings.vermieter || {};
        const guest = b.guest_id ? db.getGuestById(b.guest_id) : null;
        const name = guest && !botLogic.isPlaceholderGuestName(guest.name) ? guest.name : '';
        const warnings = [];

        const base = baseUrl();
        let link = '';
        let emergencyLink = '';
        if (!base) {
            warnings.push('Ohne öffentliche Adresse der Webseite fehlen die Links. Bitte im Admin unter „Webseite“ → „Einrichtung“ eintragen.');
        } else if (site.enabled === false) {
            warnings.push('Die Gäste-Webseite ist ausgeschaltet, deshalb fehlen die Links.');
        } else if (b.checkout < berlinToday()) {
            warnings.push('Der Aufenthalt ist vorbei, deshalb fehlen die Links.');
        } else {
            const token = ensureLink(b.id);
            link = `${base}/b/${token}`;
            if (emergencyDoor.getConfig().enabled) emergencyLink = `${link}/notfall`;
            else warnings.push('Notfall-Öffnen ist ausgeschaltet, deshalb fehlt der Notfall-Link.');
        }
        if (!b.nuki_pin) warnings.push('Für diese Buchung ist kein Türcode angelegt.');
        if (!name) warnings.push('Der Gastname fehlt noch, die Anrede ist deshalb ohne Namen.');

        const lines = [L.hello(firstName(name)), '', L.thanks(site.title || 'Beckhome'), ''];
        lines.push(L.arrival(fmtDay(b.checkin, L.locale), site.checkin_time));
        lines.push(L.departure(fmtDay(b.checkout, L.locale), site.checkout_time));
        if (b.nuki_pin) lines.push(L.pin(b.nuki_pin));
        if (link) lines.push('', L.portal, `👉 ${link}`);
        if (emergencyLink) lines.push('', L.emergency, `🚪 ${emergencyLink}`);
        if (link) lines.push('', L.private);
        if (b.guest_code) lines.push('', L.code(b.guest_code));
        lines.push('', L.contact(host.telefon || ''), '', L.bye);
        const sign = host.name || site.title;
        if (sign) lines.push(sign);

        b = sql().prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        return { text: lines.join('\n'), link, emergencyLink, name, booking: b, linkUntil: linkUntil(b), warnings };
    }

    /** Current and upcoming bookings for the selection list in Telegram. */
    function upcoming(limit = 8) {
        return sql().prepare(`
            SELECT b.id, b.checkin, b.checkout, b.summary, b.guest_link, g.name AS guest_name
            FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
            WHERE b.checkin IS NOT NULL AND b.checkout >= ?
            ORDER BY b.checkin ASC LIMIT ?
        `).all(berlinToday(), limit);
    }

    // -----------------------------------------------------------------------
    // Public routes (mounted under /gast, before the guest portal)
    // -----------------------------------------------------------------------
    const router = express.Router();

    router.use((req, res, next) => {
        // Sessions opened with a direct link end when the link expires, is blocked or replaced
        const g = req.session && req.session.guest;
        if (g && g.link) {
            const b = sql().prepare('SELECT * FROM bookings WHERE id = ?').get(g.id);
            if (!linkActive(b) || fingerprint(b.guest_link) !== g.link) delete req.session.guest;
        }
        next();
    });

    const linkLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true,
        handler: (req, res) => page(res, 429, 'Zu viele Versuche', 'Bitte warten Sie 15 Minuten und öffnen Sie den Link dann noch einmal.')
    });

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    function page(res, status, title, text, redirect) {
        res.status(status);
        res.set('Cache-Control', 'no-store');
        res.set('Referrer-Policy', 'no-referrer');
        // Meta refresh instead of a 302: the session cookie is SameSite=Strict, and a link tapped in the Booking.com or
        // Airbnb app is a cross-site navigation. The follow-up request starts from our own page, so the cookie is sent.
        res.type('html').send(`<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">${redirect ? `<meta http-equiv="refresh" content="0;url=${esc(redirect)}">` : ''}
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Hanken+Grotesk:wght@400;500&display=swap" rel="stylesheet">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f0e8; color: #1f1c18; font-family: "Hanken Grotesk", system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 32rem; text-align: center; }
  h1 { font-family: "Instrument Serif", Georgia, serif; font-weight: 400; font-size: 2.4rem; line-height: 1.1; margin: 0 0 1rem; }
  p { line-height: 1.6; margin: 0 0 1.5rem; }
  a { display: inline-block; padding: .7rem 1.4rem; border: 1px solid #1f1c18; background: #1f1c18; color: #f5f0e8; border-radius: 2px; text-decoration: none; }
</style></head><body><main>
<h1>${esc(title)}</h1><p>${esc(text)}</p>
<a href="${esc(redirect || 'meine-buchung')}">${redirect ? 'Weiter' : 'Zur Anmeldung'}</a>
</main></body></html>`);
    }

    function openLink(target) {
        return (req, res) => {
            if (getSite().enabled === false && !(req.session && req.session.user)) return res.status(404).send('Not Found');
            const b = bookingByToken(req.params.token);
            if (!b) {
                return page(res, 404, 'Link nicht mehr gültig',
                    'Dieser Link ist abgelaufen oder wurde gesperrt. Sie können sich mit Ihrem Buchungscode und dem Anreisedatum anmelden.');
            }
            let dest = `${req.baseUrl}/meine-buchung`;
            if (target === 'notfall') {
                const c = emergencyDoor.getConfig();
                if (c.enabled) dest = `${req.baseUrl}/notfall?k=${encodeURIComponent(c.key)}`;
            }
            const user = req.session.user;
            req.session.regenerate(err => {
                if (err) return page(res, 500, 'Das hat nicht geklappt', 'Bitte öffnen Sie den Link noch einmal.');
                if (user) req.session.user = user;
                req.session.guest = { kind: 'booking', id: b.id, code: b.guest_code, link: fingerprint(b.guest_link) };
                sql().prepare("UPDATE bookings SET guest_link_used_at = datetime('now') WHERE id = ?").run(b.id);
                page(res, 200, 'Einen Moment …', 'Ihre Buchung wird geöffnet.', dest);
            });
        };
    }

    router.get('/b/:token', linkLimiter, openLink('portal'));
    router.get('/b/:token/notfall', linkLimiter, openLink('notfall'));

    return { router, compose, ensureLink, revokeLink, upcoming, LINK_GRACE_DAYS };
}

module.exports = createGuestMessage;
