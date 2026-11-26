/**
 * Language of a guest (Meine Buchung, WLAN page, TV welcome, guest messages).
 *
 * Order: the host's choice in the admin (bookings.guest_lang) > the guest's own choice on
 * "Meine Buchung" (bookings.guest_lang_pick) > guessed from the guest data
 * (Meldeschein nationality, country of the address, phone prefix, e-mail domain).
 * Without any hint the guest pages use the browser language, the TV and messages German.
 */
const db = require('./db');

const LANGS = ['de', 'en', 'nl', 'pl'];
const NAMES = { de: 'Deutsch', en: 'Englisch', nl: 'Niederländisch', pl: 'Polnisch' };

let migrated = false;
function migrate() {
    if (migrated) return;
    const cols = db.getDb().prepare('PRAGMA table_info(bookings)').all().map(c => c.name);
    if (!cols.includes('guest_lang')) db.getDb().exec("ALTER TABLE bookings ADD COLUMN guest_lang TEXT DEFAULT ''");
    if (!cols.includes('guest_lang_pick')) db.getDb().exec("ALTER TABLE bookings ADD COLUMN guest_lang_pick TEXT DEFAULT ''");
    migrated = true;
}

const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

// Country or nationality (German, English, own language, ISO code) -> language
const COUNTRY = [
    ['de', /^(d|de|deu|brd|deutsch|deutschland|deutsche|germany|german|duitsland|niemcy|niemiecka|niemieckie|osterreich|oesterreich|osterreichisch|austria|austrian|at|aut|schweiz|schweizerisch|switzerland|swiss|ch|che|suisse|svizzera|liechtenstein|li)$/],
    ['nl', /^(nl|nld|niederlande|niederlandisch|netherlands|the netherlands|holland|dutch|nederland|nederlands|nederlandse|be|bel|belgien|belgisch|belgium|belgian|belgie|belgique|holandia)$/],
    ['pl', /^(pl|pol|polen|polnisch|poland|polish|polska|polskie|polski|polska rzeczpospolita|rzeczpospolita polska)$/]
];

function langOfCountry(text) {
    const n = norm(text);
    if (!n) return null;
    for (const [lang, re] of COUNTRY) if (re.test(n)) return lang;
    // Any other country that was named clearly: English
    return n.length >= 3 && !/\d/.test(n) ? 'en' : null;
}

/** Phone prefix: +31/+32 Dutch, +48 Polish, +49/+43/+41/+423 German, other international English. */
function langOfPhone(phone) {
    const p = String(phone || '').replace(/[^\d+]/g, '').replace(/^00/, '+');
    if (!p || p.length < 6) return null;
    if (!p.startsWith('+')) return p.startsWith('0') ? 'de' : null;
    if (/^\+(49|43|41|423)/.test(p)) return 'de';
    if (/^\+(31|32)/.test(p)) return 'nl';
    if (/^\+48/.test(p)) return 'pl';
    return 'en';
}

function langOfEmail(email) {
    const m = /@[^@\s]+\.([a-z]{2,})\s*$/i.exec(String(email || ''));
    if (!m) return null;
    const tld = m[1].toLowerCase();
    if (['de', 'at', 'ch', 'li'].includes(tld)) return 'de';
    if (['nl', 'be'].includes(tld)) return 'nl';
    if (tld === 'pl') return 'pl';
    if (['uk', 'ie', 'us', 'au', 'ca', 'nz', 'dk', 'se', 'no', 'fi', 'fr', 'it', 'es', 'pt', 'cz', 'sk', 'hu', 'ro', 'gr'].includes(tld)) return 'en';
    return null;
}

/** Country from the last line of an address ("Hauptstr. 1\n1012 AB Amsterdam\nNiederlande"). */
const CC_LANG = { DE: 'de', AT: 'de', CH: 'de', LI: 'de', NL: 'nl', BE: 'nl', PL: 'pl' };

function langOfAddress(address) {
    // Parsed like the Telegram address paste (also knows zip formats and towns); Germany is only the parser's default
    try {
        const cc = require('./address-parser').splitAddress(address).countryCode;
        if (cc && cc !== 'DE') return CC_LANG[cc] || 'en';
    } catch (e) { /* fall back to the simple check below */ }
    const lines = String(address || '').split(/\n|,/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    const last = lines[lines.length - 1];
    if (/\d/.test(last)) {
        // "1012 AB Amsterdam" (Dutch zip) or "00-950 Warszawa" (Polish zip) without a country line
        if (/^\d{4}\s?[A-Z]{2}\b/.test(last)) return 'nl';
        if (/^\d{2}-\d{3}\b/.test(last)) return 'pl';
        return null;
    }
    return langOfCountry(last);
}

function registration(bookingId) {
    try {
        const r = db.getDb().prepare('SELECT data FROM guest_registrations WHERE booking_id = ?').get(bookingId);
        return r ? JSON.parse(r.data || '{}') : null;
    } catch (e) { return null; } // no Meldeschein table yet
}

/** Guessed from the guest data: { lang, from } or { lang: null }. */
function detect(b) {
    const reg = registration(b.id);
    if (reg && reg.nationality) {
        const l = langOfCountry(reg.nationality);
        if (l) return { lang: l, from: 'Meldeschein' };
    }
    if (reg && reg.country) {
        const l = langOfCountry(reg.country);
        if (l) return { lang: l, from: 'Meldeschein' };
    }
    const g = b.guest_id ? db.getGuestById(b.guest_id) : null;
    let req = null;
    try { req = db.getDb().prepare('SELECT phone, email FROM booking_requests WHERE booking_id = ?').get(b.id); } catch (e) { req = null; }
    const tries = [
        [g && langOfAddress(g.address), 'Anschrift'],
        [g && langOfPhone(g.phone), 'Telefon'],
        [req && langOfPhone(req.phone), 'Telefon'],
        [reg && langOfPhone(reg.phone), 'Telefon'],
        [g && langOfEmail(g.email), 'E-Mail'],
        [req && langOfEmail(req.email), 'E-Mail']
    ];
    const hit = tries.find(([l]) => l);
    return hit ? { lang: hit[0], from: hit[1] } : { lang: null, from: null };
}

/**
 * Language for a booking row (needs id, guest_id; reads guest_lang/guest_lang_pick itself).
 * { lang, set: host choice or '', pick: guest choice or '', auto: guessed or null, from }
 */
function forBooking(b) {
    migrate();
    if (!b || !b.id) return { lang: null, set: '', pick: '', auto: null, from: null };
    const row = db.getDb().prepare('SELECT id, guest_id, guest_lang, guest_lang_pick FROM bookings WHERE id = ?').get(b.id) || b;
    const set = LANGS.includes(row.guest_lang) ? row.guest_lang : '';
    const pick = LANGS.includes(row.guest_lang_pick) ? row.guest_lang_pick : '';
    const d = detect(row);
    return { lang: set || pick || d.lang, set, pick, auto: d.lang, from: set ? 'Gastgeber' : pick ? 'Gast' : d.from };
}

/** Language for messages and the TV: like forBooking, German when nothing is known. */
function langOrDe(b) {
    return forBooking(b).lang || 'de';
}

function setHost(bookingId, lang) {
    migrate();
    const v = LANGS.includes(lang) ? lang : '';
    return db.getDb().prepare('UPDATE bookings SET guest_lang = ? WHERE id = ?').run(v, bookingId).changes > 0;
}

function setPick(bookingId, lang) {
    migrate();
    if (!LANGS.includes(lang)) return false;
    return db.getDb().prepare('UPDATE bookings SET guest_lang_pick = ? WHERE id = ?').run(lang, bookingId).changes > 0;
}

module.exports = { migrate, LANGS, NAMES, forBooking, langOrDe, setHost, setPick, detect, langOfCountry, langOfPhone, langOfEmail, langOfAddress };
