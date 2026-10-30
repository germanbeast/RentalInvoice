/**
 * Guest website (public, under /gast)
 *
 *  - Public pages: apartment description, photos, occupancy calendar (no guest names), price estimate
 *  - Direct booking requests: stored in booking_requests, confirmed or declined by the host in the admin UI
 *  - Guest login with booking code + arrival date. Every booking (Booking.com, Airbnb, direct) gets a code;
 *    Airbnb guests can also use their Airbnb confirmation code (HM...) from the calendar feed.
 *  - Status page for logged-in guests (request status, stay details, arrival info, optional door code)
 *  - iCal export of confirmed direct bookings, to be imported in Booking.com / Airbnb (blocks the dates there)
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const SITE_DIR = path.join(__dirname, 'guest-site');
const PHOTO_DIR = path.join(__dirname, 'uploads', 'site');
const MAX_PHOTOS = 12;
const HORIZON_DAYS = 540;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const SITE_DEFAULTS = {
    enabled: true,
    title: 'Ferienwohnung Beckhome',
    tagline: '',
    description: '',
    features: '',
    location: '',
    max_guests: 4,
    min_nights: 2,
    lead_days: 1,
    checkin_time: '15:00',
    checkout_time: '11:00',
    house_rules: '',
    arrival_info: '',
    payment_info: 'Bitte überweisen Sie den Betrag nach unserer Bestätigung innerhalb von 7 Tagen.',
    show_bank: true,
    show_contact: true,
    pin_days: 0,          // show the door code this many days before arrival (0 = never)
    imprint: '',
    privacy: '',
    testimonials: '',     // one per line: "Text | Name"
    bedrooms: 0,
    size_sqm: 0,
    photos: [],
    floorplan: '',        // floor plan image (file in uploads/site, not part of the photo list)
    ratings: {},          // { booking|airbnb|google: { score, count, url } }, typed in by the host
    reviews: [],          // [{ name, platform, rating, date: 'YYYY-MM', text }]
    address: '',          // for the map and the route link
    show_map: true,
    directions: '',
    tips: []              // excursion tips: [{ name, distance, text, url }]
};

const RATING_PLATFORMS = { booking: { name: 'Booking.com', max: 10 }, airbnb: { name: 'Airbnb', max: 5 }, google: { name: 'Google', max: 5 } };
const MAX_REVIEWS = 40;
const MAX_TIPS = 24;

function createGuestPortal({ express, rateLimit, db, botLogic, nodemailer, multer, notify, createNukiPin, deleteNukiPin, berlinToday, addDays, nightsBetween, formatDateDE }) {
    if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });

    const sql = () => db.getDb();

    // -----------------------------------------------------------------------
    // Settings & helpers
    // -----------------------------------------------------------------------
    function getSite() {
        const s = db.getAllSettings().site;
        return { ...SITE_DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
    }

    function getPricing() {
        const p = db.getAllSettings().pricing || {};
        return { night: Number(p.price_per_night) || 0, cleaning: Number(p.cleaning_fee) || 0 };
    }

    function quote(checkin, checkout) {
        const nights = nightsBetween(checkin, checkout);
        const { night, cleaning } = getPricing();
        if (!night) return { nights, total: null };
        return { nights, night, cleaning, total: Math.round((nights * night + cleaning) * 100) / 100 };
    }

    function randomCode() {
        let s = '';
        const bytes = crypto.randomBytes(6);
        for (let i = 0; i < 6; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
        return `BH-${s}`;
    }

    function codeInUse(code) {
        return !!(sql().prepare('SELECT 1 FROM bookings WHERE guest_code = ?').get(code) ||
            sql().prepare('SELECT 1 FROM booking_requests WHERE code = ?').get(code));
    }

    function newCode() {
        let code;
        do { code = randomCode(); } while (codeInUse(code));
        return code;
    }

    /** Gives every booking without a guest code one (cheap: only touches rows without code). */
    function ensureGuestCodes() {
        const rows = sql().prepare('SELECT id FROM bookings WHERE guest_code IS NULL').all();
        const upd = sql().prepare('UPDATE bookings SET guest_code = ? WHERE id = ?');
        rows.forEach(r => upd.run(newCode(), r.id));
    }

    function normCode(c) {
        return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    const sourceOf = b => b.source || (/^airbnb/i.test(b.summary || '') ? 'Airbnb' : (String(b.uid).startsWith('manual-') ? 'manual' : 'Booking.com'));
    const airbnbCode = b => (String(b.description || '').match(/\b(HM[A-Z0-9]{6,10})\b/i) || [])[1];

    function overlappingBooking(checkin, checkout, ignoreId = null) {
        return sql().prepare(`
            SELECT * FROM bookings
            WHERE checkin IS NOT NULL AND checkout IS NOT NULL AND checkin < ? AND checkout > ? AND id IS NOT ?
            LIMIT 1
        `).get(checkout, checkin, ignoreId);
    }

    function smtpReady() {
        const m = db.getAllSettings().smtp;
        return !!(m && m.host && m.user);
    }

    async function sendMail(to, subject, text) {
        const m = db.getAllSettings().smtp;
        if (!m || !m.host || !to) return false;
        try {
            const port = parseInt(m.port, 10) || 587;
            const transporter = nodemailer.createTransport({
                host: m.host, port, secure: port === 465,
                auth: { user: m.user, pass: m.pass },
                connectionTimeout: 10000, greetingTimeout: 10000
            });
            await transporter.sendMail({ from: m.from || m.user, to, subject: subject.substring(0, 200), text: text.substring(0, 10000) });
            return true;
        } catch (e) {
            console.warn('⚠️ Gäste-Webseite: E-Mail an Gast fehlgeschlagen:', e.message);
            return false;
        }
    }

    function siteUrl(req) {
        const s = getSite();
        if (s.public_url) return String(s.public_url).replace(/\/+$/, '');
        return req ? `${req.protocol}://${req.get('host')}/gast` : '/gast';
    }

    function bankText() {
        const b = db.getAllSettings().bank || {};
        if (!b.iban) return '';
        return `Kontoinhaber: ${b.inhaber || ''}\nIBAN: ${b.iban}${b.bic ? `\nBIC: ${b.bic}` : ''}${b.bank ? `\nBank: ${b.bank}` : ''}`;
    }

    const money = n => (Number(n) || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

    // -----------------------------------------------------------------------
    // Guest status (what a logged-in guest sees)
    // -----------------------------------------------------------------------
    function stayState(checkin, checkout) {
        const today = berlinToday();
        if (checkout < today) return 'past';
        if (checkin <= today) return checkout === today ? 'departing' : 'inhouse';
        return 'upcoming';
    }

    function bookingView(b, req) {
        const site = getSite();
        const settings = db.getAllSettings();
        const guest = b.guest_id ? db.getGuestById(b.guest_id) : null;
        const hasName = guest && !botLogic.isPlaceholderGuestName(guest.name);
        const source = sourceOf(b);
        const state = stayState(b.checkin, b.checkout);
        const daysUntil = nightsBetween(berlinToday(), b.checkin);
        const showPin = Number(site.pin_days) > 0 && b.nuki_pin && state !== 'past' &&
            (state !== 'upcoming' || daysUntil <= Number(site.pin_days));
        const request = sql().prepare('SELECT * FROM booking_requests WHERE booking_id = ?').get(b.id);
        const v = {
            kind: 'booking', code: b.guest_code, status: 'confirmed', source: source === 'manual' ? 'Direkt' : source,
            checkin: b.checkin, checkout: b.checkout, nights: nightsBetween(b.checkin, b.checkout), state, daysUntil,
            name: hasName ? guest.name : '',
            details: { name: hasName ? guest.name : '', email: (guest && guest.email) || '', phone: (guest && guest.phone) || '' },
            needsDetails: !hasName,
            checkinTime: site.checkin_time, checkoutTime: site.checkout_time,
            arrivalInfo: site.arrival_info || '', houseRules: site.house_rules || '', location: site.location || '',
            pin: showPin ? b.nuki_pin : null,
            pinLater: !showPin && Number(site.pin_days) > 0 && !!b.nuki_pin && state === 'upcoming' ? Number(site.pin_days) : null,
            contact: site.show_contact ? contactInfo(settings) : null
        };
        if (request) {
            v.guests = { adults: request.adults, children: request.children };
            v.priceTotal = request.price_total || null;
            v.hostNote = request.host_note || '';
            if (site.show_bank && request.price_total) v.payment = { text: site.payment_info || '', bank: bankText(), reference: b.guest_code };
        }
        return v;
    }

    function requestView(r) {
        const site = getSite();
        const settings = db.getAllSettings();
        return {
            kind: 'request', code: r.code, status: r.status,
            checkin: r.checkin, checkout: r.checkout, nights: nightsBetween(r.checkin, r.checkout), state: stayState(r.checkin, r.checkout),
            name: r.name, guests: { adults: r.adults, children: r.children }, priceTotal: r.price_total || null,
            hostNote: r.host_note || '', source: 'Direkt',
            details: { name: r.name, email: r.email, phone: r.phone || '' },
            contact: site.show_contact ? contactInfo(settings) : null,
            createdAt: r.created_at
        };
    }

    function contactInfo(settings) {
        const v = settings.vermieter || {};
        return { name: v.name || '', phone: v.telefon || '', email: v.email || '' };
    }

    const httpUrl = v => { const u = String(v || '').trim(); return /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u.substring(0, 500) : ''; };
    const num = (v, max) => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.min(max, Math.round(n * 100) / 100) : 0; };

    /** Cleans reviews, platform scores, map and excursion tips sent by the admin form. */
    function cleanExtras(inp) {
        const str = (v, max) => String(v == null ? '' : v).trim().substring(0, max);
        const ratings = {};
        Object.entries(RATING_PLATFORMS).forEach(([key, p]) => {
            const r = (inp.ratings && inp.ratings[key]) || {};
            const score = num(r.score, p.max);
            if (score) ratings[key] = { score, count: Math.min(100000, parseInt(r.count, 10) || 0), url: httpUrl(r.url) };
        });
        const reviews = (Array.isArray(inp.reviews) ? inp.reviews : []).map(r => ({
            name: str(r && r.name, 80),
            platform: RATING_PLATFORMS[r && r.platform] ? r.platform : 'direct',
            rating: num(r && r.rating, 5),
            date: /^\d{4}-\d{2}$/.test(String(r && r.date)) ? r.date : '',
            text: str(r && r.text, 1500)
        })).filter(r => r.text).slice(0, MAX_REVIEWS);
        const tips = (Array.isArray(inp.tips) ? inp.tips : []).map(t => ({
            name: str(t && t.name, 100), distance: str(t && t.distance, 40), text: str(t && t.text, 800), url: httpUrl(t && t.url)
        })).filter(t => t.name).slice(0, MAX_TIPS);
        return { ratings, reviews, tips, address: str(inp.address, 200), show_map: inp.show_map !== false, directions: str(inp.directions, 3000) };
    }

    /** Resolves the session to the current status; null when the booking is gone (e.g. cancelled). */
    function currentStatus(sess, req) {
        if (!sess) return null;
        if (sess.kind === 'booking') {
            const b = sql().prepare('SELECT * FROM bookings WHERE id = ?').get(sess.id);
            if (b) return bookingView(b, req);
            const r = sql().prepare('SELECT * FROM booking_requests WHERE code = ?').get(sess.code);
            if (r) return requestView(r);
            return { kind: 'booking', code: sess.code, status: 'gone' };
        }
        const r = sql().prepare('SELECT * FROM booking_requests WHERE id = ?').get(sess.id);
        if (!r) return null;
        if (r.status === 'confirmed' && r.booking_id) {
            const b = sql().prepare('SELECT * FROM bookings WHERE id = ?').get(r.booking_id);
            if (b) return bookingView(b, req);
        }
        return requestView(r);
    }

    /** Booking row of a logged-in guest (also for a confirmed direct request); null otherwise. */
    function guestBooking(sess) {
        if (!sess) return null;
        if (sess.kind === 'booking') return sql().prepare('SELECT * FROM bookings WHERE id = ?').get(sess.id) || null;
        const r = sql().prepare('SELECT * FROM booking_requests WHERE id = ?').get(sess.id);
        if (!r || r.status !== 'confirmed' || !r.booking_id) return null;
        return sql().prepare('SELECT * FROM bookings WHERE id = ?').get(r.booking_id) || null;
    }

    // -----------------------------------------------------------------------
    // Public router (/gast)
    // -----------------------------------------------------------------------
    const router = express.Router();

    const requestLimiter = rateLimit({
        windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
        message: { success: false, error: 'Zu viele Anfragen. Bitte versuchen Sie es später erneut.' }
    });
    const loginLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true,
        message: { success: false, error: 'Zu viele Versuche. Bitte warten Sie 15 Minuten.' }
    });

    router.use((req, res, next) => {
        if (getSite().enabled === false && !(req.session && req.session.user)) {
            return res.status(404).send('Not Found');
        }
        next();
    });

    router.get('/', (req, res) => {
        // Relative asset links need the trailing slash (/gast -> /gast/)
        if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(301, `${req.baseUrl}/`);
        res.sendFile(path.join(SITE_DIR, 'index.html'));
    });
    router.get('/meine-buchung', (req, res) => res.sendFile(path.join(SITE_DIR, 'account.html')));
    router.use(express.static(SITE_DIR, { index: false, dotfiles: 'deny' }));

    router.get('/bilder/:file', (req, res) => {
        const file = path.basename(String(req.params.file));
        const site = getSite();
        if (!site.photos.includes(file) && file !== site.floorplan) return res.status(404).end();
        res.set('Cache-Control', 'public, max-age=86400');
        res.sendFile(path.join(PHOTO_DIR, file));
    });

    router.get('/api/info', (req, res) => {
        const s = getSite();
        const p = getPricing();
        const settings = db.getAllSettings();
        res.set('Cache-Control', 'no-store');
        res.json({
            success: true,
            title: s.title, tagline: s.tagline, description: s.description,
            features: String(s.features || '').split('\n').map(x => x.trim()).filter(Boolean),
            location: s.location, houseRules: s.house_rules,
            maxGuests: Number(s.max_guests) || 1, minNights: Number(s.min_nights) || 1, leadDays: Number(s.lead_days) || 0,
            checkinTime: s.checkin_time, checkoutTime: s.checkout_time,
            pricePerNight: p.night || null, cleaningFee: p.cleaning || null,
            photos: (s.photos || []).map(f => `bilder/${encodeURIComponent(f)}`),
            contact: s.show_contact ? contactInfo(settings) : null,
            imprint: s.imprint || '', privacy: s.privacy || '',
            bedrooms: Number(s.bedrooms) || 0, sizeSqm: Number(s.size_sqm) || 0,
            testimonials: String(s.testimonials || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
                const i = l.lastIndexOf('|');
                return i > 0 ? { text: l.slice(0, i).trim(), name: l.slice(i + 1).trim() } : { text: l, name: '' };
            }),
            floorplan: s.floorplan ? `bilder/${encodeURIComponent(s.floorplan)}` : null,
            ratings: Object.entries(s.ratings || {}).filter(([k, r]) => RATING_PLATFORMS[k] && r && r.score)
                .map(([k, r]) => ({ platform: k, name: RATING_PLATFORMS[k].name, max: RATING_PLATFORMS[k].max, score: r.score, count: r.count || 0, url: r.url || '' })),
            reviews: (s.reviews || []).map(r => ({ ...r, platformName: (RATING_PLATFORMS[r.platform] || { name: 'Direkt' }).name })),
            address: s.address || '', showMap: s.show_map !== false && !!s.address, directions: s.directions || '',
            tips: s.tips || [],
            today: berlinToday()
        });
    });

    // Occupied periods (no names): [{ from: checkin, to: checkout }], nights from <= d < to are taken
    router.get('/api/availability', (req, res) => {
        const today = berlinToday();
        const rows = sql().prepare(`
            SELECT checkin, checkout FROM bookings
            WHERE checkin IS NOT NULL AND checkout IS NOT NULL AND checkout > ? AND checkin < ?
            ORDER BY checkin
        `).all(today, addDays(today, HORIZON_DAYS));
        res.set('Cache-Control', 'no-store');
        res.json({ success: true, today, horizon: addDays(today, HORIZON_DAYS), booked: rows.map(r => ({ from: r.checkin, to: r.checkout })) });
    });

    function validateStay(checkin, checkout, adults, children) {
        const s = getSite();
        const today = berlinToday();
        if (!YMD.test(checkin) || !YMD.test(checkout)) return 'Bitte An- und Abreisedatum wählen.';
        if (checkout <= checkin) return 'Die Abreise muss nach der Anreise liegen.';
        if (checkin < addDays(today, Number(s.lead_days) || 0)) return 'Dieses Anreisedatum ist leider nicht mehr buchbar.';
        if (checkin > addDays(today, HORIZON_DAYS)) return 'So weit im Voraus ist noch keine Buchung möglich.';
        const nights = nightsBetween(checkin, checkout);
        if (nights < (Number(s.min_nights) || 1)) return `Der Mindestaufenthalt beträgt ${s.min_nights} Nächte.`;
        if (nights > 60) return 'Für Aufenthalte über 60 Nächte kontaktieren Sie uns bitte direkt.';
        if (adults !== undefined) {
            if (!Number.isInteger(adults) || adults < 1) return 'Bitte die Anzahl der Erwachsenen angeben.';
            if (!Number.isInteger(children) || children < 0) return 'Ungültige Anzahl Kinder.';
            if (adults + children > (Number(s.max_guests) || 1)) return `Die Wohnung ist für höchstens ${s.max_guests} Personen.`;
        }
        if (overlappingBooking(checkin, checkout)) return 'Der Zeitraum ist leider schon belegt.';
        return null;
    }

    router.post('/api/quote', (req, res) => {
        const { checkin, checkout } = req.body || {};
        const err = validateStay(String(checkin || ''), String(checkout || ''));
        if (err) return res.json({ success: false, error: err });
        res.json({ success: true, ...quote(checkin, checkout) });
    });

    router.post('/api/request', requestLimiter, async (req, res) => {
        try {
            const b = req.body || {};
            if (b.website) return res.json({ success: true, code: null }); // honeypot: bots fill every field
            const name = String(b.name || '').trim().substring(0, 80);
            const email = String(b.email || '').trim().substring(0, 120);
            const phone = String(b.phone || '').trim().substring(0, 40);
            const message = String(b.message || '').trim().substring(0, 2000);
            const checkin = String(b.checkin || '');
            const checkout = String(b.checkout || '');
            const adults = parseInt(b.adults, 10);
            const children = parseInt(b.children || 0, 10);

            if (name.length < 3) return res.status(400).json({ success: false, error: 'Bitte Ihren vollständigen Namen angeben.' });
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, error: 'Bitte eine gültige E-Mail-Adresse angeben.' });
            if (!b.privacy) return res.status(400).json({ success: false, error: 'Bitte der Datenverarbeitung zustimmen.' });
            const err = validateStay(checkin, checkout, adults, children);
            if (err) return res.status(400).json({ success: false, error: err });

            const q = quote(checkin, checkout);
            const code = newCode();
            const result = sql().prepare(`
                INSERT INTO booking_requests (code, name, email, phone, adults, children, checkin, checkout, message, price_total)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(code, name, email, phone, adults, children, checkin, checkout, message, q.total || 0);

            // Log the guest in right away so they land on their status page
            req.session.guest = { kind: 'request', id: Number(result.lastInsertRowid), code };

            const period = `${formatDateDE(checkin)} – ${formatDateDE(checkout)}`;
            await notify(
                `📝 *Neue Buchungsanfrage (Webseite)*\n${name}, ${adults} Erw.${children ? ` + ${children} Kind${children === 1 ? '' : 'er'}` : ''}\n` +
                `📅 ${period} (${q.nights} Nächte)${q.total ? `\n💶 ${money(q.total)}` : ''}\n✉️ ${email}${phone ? ` · ${phone}` : ''}` +
                `${message ? `\n💬 ${message.substring(0, 300)}` : ''}\n\nBitte im Admin unter „Webseite“ bestätigen oder ablehnen.`,
                'site_request');

            const site = getSite();
            await sendMail(email, `Ihre Anfrage bei ${site.title} (${code})`,
                `Guten Tag ${name},\n\nvielen Dank für Ihre Anfrage für den Zeitraum ${period}.\n` +
                `${q.total ? `Voraussichtlicher Preis: ${money(q.total)}\n` : ''}\n` +
                `Wir melden uns so schnell wie möglich. Den Stand Ihrer Anfrage sehen Sie jederzeit hier:\n${siteUrl(req)}/meine-buchung\n\n` +
                `Ihr Buchungscode: ${code}\nAnreisedatum: ${formatDateDE(checkin)}\n\nViele Grüße\n${site.title}`);

            res.json({ success: true, code, emailSent: smtpReady() });
        } catch (e) {
            console.error('Gäste-Webseite Anfrage Fehler:', e.message);
            res.status(500).json({ success: false, error: 'Die Anfrage konnte nicht gespeichert werden. Bitte später erneut versuchen.' });
        }
    });

    router.post('/api/login', loginLimiter, (req, res) => {
        const code = normCode(req.body && req.body.code);
        const arrival = String((req.body && req.body.arrival) || '');
        const fail = () => res.status(401).json({ success: false, error: 'Keine Buchung mit diesem Code und Anreisedatum gefunden.' });
        if (code.length < 6 || !YMD.test(arrival)) return fail();

        ensureGuestCodes();
        let sess = null;
        const bhCode = code.startsWith('BH') ? `BH-${code.slice(2)}` : null;
        if (bhCode) {
            const b = sql().prepare('SELECT * FROM bookings WHERE guest_code = ? AND checkin = ?').get(bhCode, arrival);
            if (b) sess = { kind: 'booking', id: b.id, code: bhCode };
            if (!sess) {
                const r = sql().prepare('SELECT * FROM booking_requests WHERE code = ? AND checkin = ?').get(bhCode, arrival);
                if (r) sess = { kind: 'request', id: r.id, code: bhCode };
            }
        } else if (code.startsWith('HM')) {
            const cands = sql().prepare("SELECT * FROM bookings WHERE checkin = ? AND description LIKE ?").all(arrival, `%${code}%`);
            const b = cands.find(x => normCode(airbnbCode(x)) === code);
            if (b) sess = { kind: 'booking', id: b.id, code: b.guest_code };
        }
        if (!sess) return fail();

        // New session id on login (keeps an admin login in the same browser)
        const user = req.session.user;
        req.session.regenerate(err => {
            if (err) return res.status(500).json({ success: false, error: 'Anmeldung fehlgeschlagen.' });
            if (user) req.session.user = user;
            req.session.guest = sess;
            res.json({ success: true });
        });
    });

    router.post('/api/logout', (req, res) => {
        if (req.session) delete req.session.guest;
        res.json({ success: true });
    });

    router.get('/api/me', (req, res) => {
        res.set('Cache-Control', 'no-store');
        const st = currentStatus(req.session && req.session.guest, req);
        if (!st) return res.json({ success: false, loggedIn: false });
        res.json({ success: true, status: st });
    });

    // Portal guests add their name and contact details (the calendar feeds contain none)
    router.post('/api/me/details', async (req, res) => {
        try {
            const sess = req.session && req.session.guest;
            const st = currentStatus(sess, req);
            if (!st || st.kind !== 'booking' || st.status !== 'confirmed') return res.status(401).json({ success: false, error: 'Bitte erneut anmelden.' });
            const b = sql().prepare('SELECT * FROM bookings WHERE guest_code = ?').get(st.code);
            if (!b) return res.status(404).json({ success: false, error: 'Buchung nicht gefunden.' });

            const name = String((req.body && req.body.name) || '').trim().substring(0, 80);
            const email = String((req.body && req.body.email) || '').trim().substring(0, 120);
            const phone = String((req.body && req.body.phone) || '').trim().substring(0, 40);
            const arrivalTime = String((req.body && req.body.arrivalTime) || '').trim().substring(0, 40);
            const note = String((req.body && req.body.note) || '').trim().substring(0, 1000);
            if (name.length < 3) return res.status(400).json({ success: false, error: 'Bitte Ihren vollständigen Namen angeben.' });
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, error: 'Bitte eine gültige E-Mail-Adresse angeben.' });

            const before = st.details;
            const nameChanged = name !== before.name;
            if (nameChanged) await botLogic.applyGuestName(b.id, name);
            const fresh = sql().prepare('SELECT guest_id FROM bookings WHERE id = ?').get(b.id);
            if (fresh.guest_id) {
                const g = db.getGuestById(fresh.guest_id);
                db.updateGuest(g.id, { ...g, email: email || g.email, phone: phone || g.phone });
            }

            if (nameChanged || email !== before.email || phone !== before.phone || arrivalTime || note) {
                await notify(
                    `👤 *Gast hat Daten ergänzt (Webseite)*\n${name} · ${sourceOf(b)}\n📅 ${formatDateDE(b.checkin)} – ${formatDateDE(b.checkout)}` +
                    `${email ? `\n✉️ ${email}` : ''}${phone ? `\n📞 ${phone}` : ''}${arrivalTime ? `\n🕒 Ankunft ca. ${arrivalTime}` : ''}${note ? `\n💬 ${note.substring(0, 300)}` : ''}`,
                    'site_details');
            }
            res.json({ success: true });
        } catch (e) {
            console.error('Gäste-Webseite Daten Fehler:', e.message);
            res.status(500).json({ success: false, error: 'Speichern fehlgeschlagen.' });
        }
    });

    // iCal export of confirmed direct bookings (import this link in Booking.com / Airbnb)
    router.get('/kalender/:token', (req, res) => {
        const token = String(req.params.token || '').replace(/\.ics$/, '');
        const expected = String(db.getAllSettings().site_ical_token || '');
        if (!expected || token.length !== expected.length ||
            !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return res.status(404).end();
        const rows = sql().prepare(`
            SELECT id, checkin, checkout FROM bookings
            WHERE source = 'Direkt' AND checkin IS NOT NULL AND checkout >= ?
        `).all(addDays(berlinToday(), -30));
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        const host = req.hostname || 'beckhome';
        const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Beckhome//Gaeste-Webseite//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
        rows.forEach(r => lines.push(
            'BEGIN:VEVENT', `UID:direkt-${r.id}@${host}`, `DTSTAMP:${stamp}`,
            `DTSTART;VALUE=DATE:${r.checkin.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${r.checkout.replace(/-/g, '')}`,
            'SUMMARY:Belegt (Direktbuchung)', 'END:VEVENT'));
        lines.push('END:VCALENDAR');
        res.set('Content-Type', 'text/calendar; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        res.send(lines.join('\r\n') + '\r\n');
    });

    // -----------------------------------------------------------------------
    // Admin routes (registered behind the login)
    // -----------------------------------------------------------------------
    const photoUpload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => cb(null, PHOTO_DIR),
            filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
        }),
        limits: { fileSize: 8 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            const ok = /\.(jpe?g|png|webp)$/i.test(file.originalname) && /^image\/(jpeg|png|webp)$/.test(file.mimetype);
            cb(ok ? null : new Error('Nur Bilder (JPEG, PNG, WebP) erlaubt'), ok);
        }
    });

    function icalToken() {
        let t = db.getAllSettings().site_ical_token;
        if (!t) { t = crypto.randomBytes(18).toString('hex'); db.setSetting('site_ical_token', t); }
        return String(t);
    }

    function registerAdminRoutes(app, apiLimiter) {
        app.get('/api/site/settings', apiLimiter, (req, res) => {
            res.json({ success: true, site: getSite(), icalPath: `/gast/kalender/${icalToken()}.ics`, smtpReady: smtpReady() });
        });

        app.put('/api/site/settings', apiLimiter, (req, res) => {
            const inp = (req.body && req.body.site) || {};
            const cur = getSite();
            const str = (v, max) => String(v == null ? '' : v).substring(0, max);
            const int = (v, min, max, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
            const time = (v, def) => /^\d{1,2}:\d{2}$/.test(String(v || '')) ? String(v) : def;
            const url = String(inp.public_url || '').trim();
            const site = {
                ...cur,
                enabled: inp.enabled !== false,
                title: str(inp.title, 120).trim() || SITE_DEFAULTS.title,
                tagline: str(inp.tagline, 200), description: str(inp.description, 5000), features: str(inp.features, 3000),
                location: str(inp.location, 1000), house_rules: str(inp.house_rules, 3000), arrival_info: str(inp.arrival_info, 5000),
                payment_info: str(inp.payment_info, 1000), imprint: str(inp.imprint, 5000), privacy: str(inp.privacy, 20000),
                testimonials: str(inp.testimonials, 5000),
                bedrooms: int(inp.bedrooms, 0, 20, 0), size_sqm: int(inp.size_sqm, 0, 1000, 0),
                max_guests: int(inp.max_guests, 1, 30, cur.max_guests), min_nights: int(inp.min_nights, 1, 30, cur.min_nights),
                lead_days: int(inp.lead_days, 0, 60, cur.lead_days), pin_days: int(inp.pin_days, 0, 30, 0),
                checkin_time: time(inp.checkin_time, cur.checkin_time), checkout_time: time(inp.checkout_time, cur.checkout_time),
                show_bank: !!inp.show_bank, show_contact: !!inp.show_contact,
                public_url: /^https?:\/\/[^\s]+$/i.test(url) ? url.replace(/\/+$/, '') : ''
            };
            Object.assign(site, cleanExtras(inp));
            db.setSetting('site', site);
            res.json({ success: true, site });
        });

        app.post('/api/site/photos', apiLimiter, (req, res) => {
            photoUpload.single('photo')(req, res, err => {
                if (err) return res.status(400).json({ success: false, error: err.message });
                if (!req.file) return res.status(400).json({ success: false, error: 'Keine Datei' });
                const site = getSite();
                if (site.photos.length >= MAX_PHOTOS) {
                    fs.unlink(req.file.path, () => { });
                    return res.status(400).json({ success: false, error: `Höchstens ${MAX_PHOTOS} Bilder` });
                }
                site.photos = [...site.photos, req.file.filename];
                db.setSetting('site', site);
                res.json({ success: true, photos: site.photos });
            });
        });

        app.delete('/api/site/photos/:file', apiLimiter, (req, res) => {
            const file = path.basename(String(req.params.file));
            const site = getSite();
            if (!site.photos.includes(file)) return res.status(404).json({ success: false });
            site.photos = site.photos.filter(f => f !== file);
            db.setSetting('site', site);
            fs.unlink(path.join(PHOTO_DIR, file), () => { });
            res.json({ success: true, photos: site.photos });
        });

        app.put('/api/site/photos/order', apiLimiter, (req, res) => {
            const order = Array.isArray(req.body && req.body.photos) ? req.body.photos.map(String) : [];
            const site = getSite();
            if (order.length !== site.photos.length || !order.every(f => site.photos.includes(f))) return res.status(400).json({ success: false });
            site.photos = order;
            db.setSetting('site', site);
            res.json({ success: true, photos: site.photos });
        });

        // Floor plan: one image, replaced on every upload
        app.post('/api/site/floorplan', apiLimiter, (req, res) => {
            photoUpload.single('photo')(req, res, err => {
                if (err) return res.status(400).json({ success: false, error: err.message });
                if (!req.file) return res.status(400).json({ success: false, error: 'Keine Datei' });
                const site = getSite();
                const old = site.floorplan;
                site.floorplan = req.file.filename;
                db.setSetting('site', site);
                if (old) fs.unlink(path.join(PHOTO_DIR, path.basename(old)), () => { });
                res.json({ success: true, floorplan: site.floorplan });
            });
        });

        app.delete('/api/site/floorplan', apiLimiter, (req, res) => {
            const site = getSite();
            const old = site.floorplan;
            site.floorplan = '';
            db.setSetting('site', site);
            if (old) fs.unlink(path.join(PHOTO_DIR, path.basename(old)), () => { });
            res.json({ success: true, floorplan: '' });
        });

        app.get('/api/site/photo/:file', apiLimiter, (req, res) => {
            const file = path.basename(String(req.params.file));
            const site = getSite();
            if (!site.photos.includes(file) && file !== site.floorplan) return res.status(404).end();
            res.sendFile(path.join(PHOTO_DIR, file));
        });

        app.get('/api/site/requests', apiLimiter, (req, res) => {
            const rows = sql().prepare(`
                SELECT * FROM booking_requests
                ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, checkin >= date('now') DESC, checkin ASC
                LIMIT 200
            `).all();
            const out = rows.map(r => {
                const clash = r.status === 'pending' ? overlappingBooking(r.checkin, r.checkout) : null;
                return { ...r, nights: nightsBetween(r.checkin, r.checkout), conflict: clash ? { checkin: clash.checkin, checkout: clash.checkout, source: sourceOf(clash) } : null };
            });
            res.json({ success: true, requests: out, pending: out.filter(r => r.status === 'pending').length });
        });

        app.post('/api/site/requests/:id/confirm', apiLimiter, async (req, res) => {
            try {
                const r = sql().prepare('SELECT * FROM booking_requests WHERE id = ?').get(parseInt(req.params.id, 10));
                if (!r) return res.status(404).json({ success: false, error: 'Anfrage nicht gefunden' });
                if (r.status !== 'pending') return res.status(400).json({ success: false, error: 'Anfrage ist nicht mehr offen' });
                const clash = overlappingBooking(r.checkin, r.checkout);
                if (clash) return res.status(409).json({ success: false, error: `Zeitraum ist inzwischen belegt (${sourceOf(clash)} ${formatDateDE(clash.checkin)} – ${formatDateDE(clash.checkout)})` });
                const note = String((req.body && req.body.note) || '').trim().substring(0, 1000);
                const price = req.body && req.body.price != null && req.body.price !== '' ? Math.max(0, Number(req.body.price) || 0) : r.price_total;

                const guest = db.findOrCreateGuest(r.name, r.email, null);
                if (r.phone && !guest.phone) db.updateGuest(guest.id, { ...guest, phone: r.phone });
                const ins = sql().prepare(`
                    INSERT INTO bookings (uid, summary, checkin, checkout, description, source, guest_id, guest_code)
                    VALUES (?, ?, ?, ?, ?, 'Direkt', ?, ?)
                `).run(`direct-${r.id}`, `Direkt: ${r.name}`, r.checkin, r.checkout, `Webseiten-Anfrage ${r.code}`, guest.id, r.code);
                const bookingId = Number(ins.lastInsertRowid);
                sql().prepare(`UPDATE booking_requests SET status = 'confirmed', host_note = ?, price_total = ?, booking_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(note, price, bookingId, r.id);

                let pin = null;
                try {
                    const n = await createNukiPin(r.checkin, r.checkout, r.name);
                    if (n && n.success) { db.updateBookingNukiData(bookingId, n.pin, n.authId); pin = n.pin; }
                } catch (e) { console.warn('⚠️ Direktbuchung: Türcode nicht angelegt:', e.message); }

                const site = getSite();
                const bank = site.show_bank && price ? bankText() : '';
                const mailed = await sendMail(r.email, `Buchungsbestätigung ${site.title} (${r.code})`,
                    `Guten Tag ${r.name},\n\nwir freuen uns, Ihre Buchung zu bestätigen:\n` +
                    `${formatDateDE(r.checkin)} – ${formatDateDE(r.checkout)} (${nightsBetween(r.checkin, r.checkout)} Nächte)\n` +
                    `Anreise ab ${site.checkin_time} Uhr, Abreise bis ${site.checkout_time} Uhr.\n` +
                    `${price ? `\nGesamtpreis: ${money(price)}\n` : ''}` +
                    `${bank ? `${site.payment_info ? `${site.payment_info}\n` : ''}${bank}\nVerwendungszweck: ${r.code}\n` : ''}` +
                    `${note ? `\n${note}\n` : ''}\nAlle Details und später die Anreiseinformationen finden Sie hier:\n${siteUrl(req)}/meine-buchung\n` +
                    `Buchungscode: ${r.code} · Anreisedatum: ${formatDateDE(r.checkin)}\n\nViele Grüße\n${site.title}`);

                res.json({ success: true, bookingId, pin, mailed });
            } catch (e) {
                console.error('Direktbuchung bestätigen Fehler:', e.message);
                res.status(500).json({ success: false, error: e.message });
            }
        });

        app.post('/api/site/requests/:id/decline', apiLimiter, async (req, res) => {
            const r = sql().prepare('SELECT * FROM booking_requests WHERE id = ?').get(parseInt(req.params.id, 10));
            if (!r) return res.status(404).json({ success: false, error: 'Anfrage nicht gefunden' });
            if (r.status !== 'pending') return res.status(400).json({ success: false, error: 'Anfrage ist nicht mehr offen' });
            const note = String((req.body && req.body.note) || '').trim().substring(0, 1000);
            sql().prepare(`UPDATE booking_requests SET status = 'declined', host_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(note, r.id);
            const site = getSite();
            const mailed = await sendMail(r.email, `Ihre Anfrage bei ${site.title} (${r.code})`,
                `Guten Tag ${r.name},\n\nvielen Dank für Ihr Interesse. Leider können wir Ihre Anfrage für ` +
                `${formatDateDE(r.checkin)} – ${formatDateDE(r.checkout)} nicht bestätigen.\n${note ? `\n${note}\n` : ''}\nViele Grüße\n${site.title}`);
            res.json({ success: true, mailed });
        });

        // Cancel a confirmed direct booking: removes the booking (frees the dates) and its door code
        app.post('/api/site/requests/:id/cancel', apiLimiter, async (req, res) => {
            const r = sql().prepare('SELECT * FROM booking_requests WHERE id = ?').get(parseInt(req.params.id, 10));
            if (!r) return res.status(404).json({ success: false, error: 'Anfrage nicht gefunden' });
            if (r.status !== 'confirmed') return res.status(400).json({ success: false, error: 'Nur bestätigte Buchungen können storniert werden' });
            const b = r.booking_id ? sql().prepare('SELECT * FROM bookings WHERE id = ?').get(r.booking_id) : null;
            if (b && b.nuki_auth_id) {
                try { await deleteNukiPin(b.nuki_auth_id); } catch (e) {
                    if (!(e.response && e.response.status === 404)) return res.status(502).json({ success: false, error: 'Türcode konnte nicht gelöscht werden: ' + e.message });
                }
            }
            if (b) sql().prepare('DELETE FROM bookings WHERE id = ?').run(b.id);
            const note = String((req.body && req.body.note) || '').trim().substring(0, 1000);
            sql().prepare(`UPDATE booking_requests SET status = 'cancelled', booking_id = NULL, host_note = COALESCE(NULLIF(?, ''), host_note), updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(note, r.id);
            res.json({ success: true });
        });

        // Ready-to-send message with link + code for a portal booking (Booking.com / Airbnb chat)
        app.get('/api/site/guest-message/:bookingId', apiLimiter, (req, res) => {
            ensureGuestCodes();
            const b = sql().prepare('SELECT * FROM bookings WHERE id = ?').get(parseInt(req.params.bookingId, 10));
            if (!b) return res.status(404).json({ success: false });
            const site = getSite();
            const url = siteUrl(req);
            res.json({
                success: true, code: b.guest_code, url,
                text: `Hallo und vielen Dank für Ihre Buchung!\n\nAuf unserer Gäste-Seite finden Sie alle Infos zu Ihrem Aufenthalt und rechtzeitig vor der Anreise die Anreisedetails:\n` +
                    `${url}/meine-buchung\n\nIhr Buchungscode: ${b.guest_code}\nAnreisedatum: ${formatDateDE(b.checkin)}\n\n` +
                    `Bitte tragen Sie dort kurz Ihren Namen und Ihre Ankunftszeit ein. Wir freuen uns auf Sie!\n${site.title}`
            });
        });
    }

    return { router, registerAdminRoutes, ensureGuestCodes, getSite, guestBooking };
}

module.exports = createGuestPortal;
