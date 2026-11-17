/**
 * Reads guest data from unformatted text, e.g. copied from Booking.com, Airbnb, an e-mail or typed in one line:
 *
 *   "Max Mustermann, Hauptstr. 5, 12345 Berlin, +49 171 1234567, max@web.de"
 *   "Jan de Vries\nKerkstraat 12\n1012 AB Amsterdam\nNederland\n+31 6 12345678"
 *
 * parseGuestText() -> { name, street, zip, city, country, phone, email, arrival, departure, rest: [] }
 * (empty string when not found; country as German name like in the Meldeschein, "" when unknown)
 */
const { parseDates } = require('./bot-logic');

// Country names (German, English, own language, codes) -> German name
const COUNTRIES = [
    ['Deutschland', ['deutschland', 'germany', 'duitsland', 'niemcy', 'allemagne', 'brd', 'd', 'de', 'deu', 'ger']],
    ['Österreich', ['osterreich', 'oesterreich', 'austria', 'oostenrijk', 'austria', 'at', 'aut', 'a']],
    ['Schweiz', ['schweiz', 'switzerland', 'zwitserland', 'szwajcaria', 'suisse', 'svizzera', 'ch', 'che']],
    ['Niederlande', ['niederlande', 'netherlands', 'the netherlands', 'nederland', 'holland', 'holandia', 'nl', 'nld']],
    ['Belgien', ['belgien', 'belgium', 'belgie', 'belgique', 'belgia', 'be', 'bel', 'b']],
    ['Luxemburg', ['luxemburg', 'luxembourg', 'luksemburg', 'lu', 'lux', 'l']],
    ['Polen', ['polen', 'poland', 'polska', 'pologne', 'pl', 'pol']],
    ['Frankreich', ['frankreich', 'france', 'frankrijk', 'francja', 'fr', 'fra', 'f']],
    ['Dänemark', ['danemark', 'daenemark', 'denmark', 'danmark', 'denemarken', 'dania', 'dk', 'dnk']],
    ['Tschechien', ['tschechien', 'czech republic', 'czechia', 'cesko', 'ceska republika', 'czechy', 'tsjechie', 'cz', 'cze']],
    ['Italien', ['italien', 'italy', 'italia', 'italie', 'wlochy', 'it', 'ita', 'i']],
    ['Spanien', ['spanien', 'spain', 'espana', 'spanje', 'hiszpania', 'es', 'esp', 'e']],
    ['Portugal', ['portugal', 'portugalia', 'pt', 'prt']],
    ['Vereinigtes Königreich', ['vereinigtes konigreich', 'grossbritannien', 'grobritannien', 'england', 'united kingdom', 'great britain', 'uk', 'gb', 'gbr', 'scotland', 'wales', 'verenigd koninkrijk', 'wielka brytania']],
    ['Irland', ['irland', 'ireland', 'ierland', 'irlandia', 'ie', 'irl']],
    ['Schweden', ['schweden', 'sweden', 'sverige', 'zweden', 'szwecja', 'se', 'swe']],
    ['Norwegen', ['norwegen', 'norway', 'norge', 'noorwegen', 'norwegia', 'no', 'nor']],
    ['Finnland', ['finnland', 'finland', 'suomi', 'finlandia', 'fi', 'fin']],
    ['Ungarn', ['ungarn', 'hungary', 'magyarorszag', 'hongarije', 'wegry', 'hu', 'hun']],
    ['Rumänien', ['rumanien', 'romania', 'roemenie', 'rumunia', 'ro', 'rou']],
    ['Bulgarien', ['bulgarien', 'bulgaria', 'bulgarije', 'bg', 'bgr']],
    ['Kroatien', ['kroatien', 'croatia', 'hrvatska', 'kroatie', 'chorwacja', 'hr', 'hrv']],
    ['Slowenien', ['slowenien', 'slovenia', 'slovenija', 'slovenie', 'slowenia', 'si', 'svn']],
    ['Slowakei', ['slowakei', 'slovakia', 'slovensko', 'slowakije', 'slowacja', 'sk', 'svk']],
    ['Griechenland', ['griechenland', 'greece', 'griekenland', 'grecja', 'gr', 'grc']],
    ['Türkei', ['turkei', 'turkey', 'turkiye', 'turkije', 'turcja', 'tr', 'tur']],
    ['Ukraine', ['ukraine', 'ukraina', 'oekraine', 'ua', 'ukr']],
    ['Litauen', ['litauen', 'lithuania', 'lietuva', 'litwa', 'lt', 'ltu']],
    ['Lettland', ['lettland', 'latvia', 'latvija', 'lotwa', 'lv', 'lva']],
    ['Estland', ['estland', 'estonia', 'eesti', 'ee', 'est']],
    ['USA', ['usa', 'united states', 'united states of america', 'vereinigte staaten', 'us', 'verenigde staten', 'stany zjednoczone']],
    ['Kanada', ['kanada', 'canada', 'ca', 'can']],
    ['Australien', ['australien', 'australia', 'australie', 'au', 'aus']]
];
const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const COUNTRY_INDEX = new Map();
COUNTRIES.forEach(([de, names]) => { COUNTRY_INDEX.set(norm(de), de); names.forEach(n => COUNTRY_INDEX.set(norm(n), de)); });
// One- or two-letter codes count only as a line of their own in capitals ("NL"), never inside a name
const SHORT_CODE = /^[A-Z]{1,3}$/;

function countryOf(text) {
    const raw = String(text || '').trim();
    const n = norm(raw);
    if (!n) return '';
    if (n.length <= 3 && !SHORT_CODE.test(raw)) return '';
    return COUNTRY_INDEX.get(n) || '';
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// +49 171 1234567 · 0171/1234567 · (0)6841 12345 · 0031-6-12345678 (at least 7 digits, no dots: dates stay dates)
const PHONE_RE = /(?:\+|00)\d[\d\s\-/()]{5,}\d|\b0\d[\d\s\-/()]{5,}\d/;
const LABEL_RE = /^(name|gast|guest|gastname|vor- und nachname|anschrift|adresse|address|addres|adres|strasse|straße|street|plz(\s*\/?\s*ort)?|ort|stadt|city|land|country|kraj|telefon|tel|phone|mobil|handy|mobile|telefoonnummer|telefonnummer|e-?mail|mail|email)\s*[:.]\s*/i;
// A label in a line of its own (Booking.com extranet: "Gastname" above the name)
const LABEL_ONLY = /^(name|gast|gastname|name des gastes|guest|guest name|vor- und nachname|anschrift|adresse|address|adres|strasse|straße|street|plz|ort|plz\s*\/?\s*ort|stadt|city|land|country|kraj|telefon|tel\.?|telefonnummer|phone|phone number|mobil|handy|mobile|e-?mail|mail|e-?mail-adresse|kontakt|contact|kontaktdaten|gastdaten|guest details)\s*:?$/i;
// Lines that are not part of the address: prices, guests, booking numbers, portals
const NOISE_RE = /(€|\bEUR\b|\b(erwachsene|kind(er)?|gäste|gaeste|nacht|nächte|naechte|adults?|children|guests?|nights?|buchungsnummer|reservierungsnummer|bestätigungsnummer|booking number|confirmation|reservation|booking\.com|airbnb|check-?in|check-?out|anreise|abreise|preis|price|total|gesamt|provision|kommission)\b)/i;

// Postcode + town: "12345 Berlin", "D-12345 Berlin", "1012 AB Amsterdam", "00-950 Warszawa", "SW1A 1AA London"
const ZIP_CITY = [
    /^(?:[A-Z]{1,2}[-\s])?(\d{4}\s?[A-Z]{2})\s+(.+)$/,                 // NL
    /^(?:[A-Z]{1,2}[-\s])?(\d{2}-\d{3})\s+(.+)$/,                       // PL
    /^(?:[A-Z]{1,2}[-\s])?(\d{4,5})\s+(.+)$/,                           // DE, AT, CH, BE, LU, DK, FR ...
    /^([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\s+(.+)$/,                     // UK, postcode first
    /^(.+?)\s+([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/                     // UK, postcode last
];
function zipCity(line) {
    for (let i = 0; i < ZIP_CITY.length; i++) {
        const m = ZIP_CITY[i].exec(line);
        if (!m) continue;
        const [zip, city] = i === 4 ? [m[2], m[1]] : [m[1], m[2]];
        if (/\d{3,}/.test(city) || !/[a-zA-ZÀ-ž]{2}/.test(city)) continue;
        return { zip: zip.trim(), city: city.replace(/[,;]+$/, '').trim() };
    }
    return null;
}

const STREET_WORD = /(straße|strasse|str\.|weg|gasse|platz|allee|ring|damm|ufer|chaussee|steig|pfad|markt|hof|berg|feld|garten|kamp|wall|graben|stieg|zeile|park|straat|laan|weg|plein|singel|gracht|kade|dijk|ulica|ul\.|aleja|al\.|osiedle|os\.|plac|street|st\.|road|rd\.|avenue|ave\.|lane|drive|way|close|court|rue|chemin|via|calle)/i;
const looksLikeStreet = l => /[a-zA-ZÀ-ž]{2}/.test(l) && /\d/.test(l) && (STREET_WORD.test(l) || /^\d+[a-z]?\s+\D{3,}/i.test(l) || /\D{3,}\s+\d+\s*[a-z]?(\s*[-/]\s*\d+[a-z]?)?$/i.test(l));
const looksLikeName = l => /^[A-Za-zÀ-žĄ-żąćęłńóśźżÄÖÜäöüß'’.\- ]{3,80}$/.test(l) && /[A-Za-zÀ-ž]{2}/.test(l) && l.split(/\s+/).length <= 6;

// Where a street starts inside "Name Name Street 5": a street word, a preposition ("Am Bach 3") or "ul."
const STREET_TOKEN = /(straße|strasse|str\.?|weg|gasse|platz|allee|ring|damm|ufer|chaussee|steig|pfad|markt|straat|laan|plein|singel|gracht|kade|dijk|street|road|avenue|lane|drive)$/i;
const STREET_START = /^(am|an|auf|im|in|zum|zur|beim|hinter|unter|ober|vor|ul\.?|ulica|al\.?|aleja|os\.?|osiedle|plac|rue|via|calle|avenue)$/i;
function splitNameStreet(line) {
    const t = line.split(/\s+/);
    if (t.length < 4) return null;
    let idx = t.findIndex((w, i) => i >= 2 && (STREET_START.test(w) || STREET_TOKEN.test(w)));
    if (idx < 0) {
        const num = t.findIndex((w, i) => i >= 3 && /^\d+[a-z]?([-/]\d+[a-z]?)?$/i.test(w));
        if (num > 0) idx = num - 1;
    }
    if (idx < 2) return null;
    const name = t.slice(0, idx).join(' ');
    return looksLikeName(name) ? { name, street: t.slice(idx).join(' ') } : null;
}

/** Splits a stored address ("Street 1\n12345 Town\nCountry") into its parts. */
function splitAddress(address) {
    const lines = String(address || '').split(/\n|,/).map(l => l.trim()).filter(Boolean);
    const out = { street: '', zip: '', city: '', country: '' };
    lines.forEach(l => {
        const zc = !out.zip && zipCity(l);
        if (zc) { out.zip = zc.zip; out.city = zc.city; return; }
        const c = !out.country && countryOf(l);
        if (c) { out.country = c; return; }
        if (!out.street) out.street = l;
    });
    return out;
}

/** Address text as stored at the guest (country left out for Germany, like on a German invoice). */
function addressText(p) {
    return [p.street, [p.zip, p.city].filter(Boolean).join(' '), p.country && p.country !== 'Deutschland' ? p.country : ''].filter(Boolean).join('\n');
}

function parseGuestText(text, today = new Date()) {
    const out = { name: '', street: '', zip: '', city: '', country: '', phone: '', email: '', arrival: '', departure: '', rest: [] };
    let work = String(text || '').replace(/\r/g, '').replace(/\t/g, ' ').trim();
    if (!work) return out;
    // Leading command word ("gast", "/adresse")
    work = work.replace(/^\/?(gast|gastdaten|adresse|anschrift)(@\w+)?\b[:\s,-]*/i, '');

    const dates = parseDates(work.replace(/\n/g, ' '), today);
    if (dates.arrival && dates.departure) {
        out.arrival = dates.arrival;
        out.departure = dates.departure;
        const flat = work.replace(/\n/g, ' ');
        const idx = flat.indexOf(dates.matched);
        if (idx >= 0) work = work.slice(0, idx) + '\n' + work.slice(idx + dates.matched.length);
    }
    const mail = work.match(EMAIL_RE);
    if (mail) { out.email = mail[0]; work = work.replace(mail[0], '\n'); }
    const phone = work.match(PHONE_RE);
    if (phone && phone[0].replace(/\D/g, '').length >= 7) {
        out.phone = phone[0].replace(/\s+/g, ' ').trim();
        work = work.replace(phone[0], '\n');
    }

    // One line with commas or semicolons: every part is a line
    let lines = work.split('\n');
    // One line with commas: every part is a line; in longer texts only lines with a number ("Str. 5, 12345 Ort, Land")
    const few = lines.filter(l => l.trim()).length <= 2;
    lines = lines.flatMap(l => (few || /\d/.test(l) ? l.split(/\s*[,;|]\s*/) : [l]));
    lines = lines
        .map(l => l.replace(LABEL_RE, '').replace(/^[\s,;:\-–—•*]+|[\s,;:\-–—•*]+$/g, '').trim())
        .filter(l => l && !NOISE_RE.test(l) && !LABEL_ONLY.test(l));

    // "Hauptstraße 5 12345 Berlin" (street and town in one line)
    lines = lines.flatMap(l => {
        const m = /^(.*\S)\s+((?:[A-Z]{1,2}-)?\d{4,5}|\d{4}\s?[A-Z]{2}|\d{2}-\d{3})\s+(\D.+)$/.exec(l);
        return m && /\d/.test(m[1]) && /[A-Za-zÀ-ž]{2}/.test(m[1]) ? [m[1].trim(), `${m[2]} ${m[3]}`] : [l];
    })
        // Words left over from labels after the phone number or e-mail was taken out ("Warszawa tel.")
        .map(l => l.replace(/\s+(tel\.?|telefon|phone|mobil|handy|e-?mail)$/i, '').trim())
        .filter(Boolean);
    // "Mustermann, Max" in a line of its own: first name first
    lines = lines.map(l => {
        const m = /^([A-Za-zÀ-žÄÖÜäöüß'’-]{2,40}),\s*([A-Za-zÀ-žÄÖÜäöüß'’ -]{2,40})$/.exec(l);
        return m ? `${m[2].trim()} ${m[1]}` : l;
    });

    const used = new Set();
    lines.forEach((l, i) => {
        if (!out.zip) {
            const zc = zipCity(l);
            if (zc) { out.zip = zc.zip; out.city = zc.city; used.add(i); return; }
        }
        if (!out.country) {
            const c = countryOf(l);
            if (c) { out.country = c; used.add(i); }
        }
    });
    // A town line can end with the country ("1012 AB Amsterdam Nederland")
    if (out.city && !out.country) {
        const parts = out.city.split(/\s+/);
        for (let k = 1; k <= 2 && k < parts.length; k++) {
            const c = countryOf(parts.slice(-k).join(' '));
            if (c) { out.country = c; out.city = parts.slice(0, -k).join(' '); break; }
        }
    }
    const streetIdx = lines.findIndex((l, i) => !used.has(i) && looksLikeStreet(l));
    if (streetIdx >= 0) {
        out.street = lines[streetIdx];
        used.add(streetIdx);
        // "Peter Müller Hauptstraße 5": the name in front of the street
        const hasName = lines.some((l, i) => !used.has(i) && looksLikeName(l));
        const sp = !hasName && splitNameStreet(out.street);
        if (sp) { out.street = sp.street; out.name = sp.name; }
    }
    // Name: before the street, otherwise the first line that reads like a name
    let nameIdx = out.name ? -1 : lines.findIndex((l, i) => !used.has(i) && looksLikeName(l) && (streetIdx < 0 || i < streetIdx));
    if (nameIdx < 0 && !out.name) nameIdx = lines.findIndex((l, i) => !used.has(i) && looksLikeName(l));
    if (nameIdx >= 0) { out.name = lines[nameIdx].replace(/\s+/g, ' '); used.add(nameIdx); }
    // "Mustermann, Max" was split at the comma: the next short word is the first name
    if (out.name && !/\s/.test(out.name)) {
        const next = lines.findIndex((l, i) => !used.has(i) && /^[A-Za-zÀ-žÄÖÜäöüß'’-]{2,30}$/.test(l));
        if (next === nameIdx + 1) { out.name = `${lines[next]} ${out.name}`; used.add(next); }
    }
    out.rest = lines.filter((l, i) => !used.has(i) && !(out.country && countryOf(l) === out.country));
    // Without a street word, a leftover line before the town is the street ("Kerkstraat" is found, "Am Bach 3" too)
    if (!out.street && out.rest.length && out.zip) {
        const cand = out.rest.find(l => /\d/.test(l));
        if (cand) { out.street = cand; out.rest = out.rest.filter(l => l !== cand); }
    }
    if (!out.country && out.zip) {
        if (/^\d{4}\s?[A-Z]{2}$/.test(out.zip)) out.country = 'Niederlande';
        else if (/^\d{2}-\d{3}$/.test(out.zip)) out.country = 'Polen';
        else if (/^\d{5}$/.test(out.zip) && (!out.phone || /^(\+|00)49|^0[1-9]/.test(out.phone.replace(/\s/g, '')))) out.country = 'Deutschland';
    }
    return out;
}

/** True when the text holds more than a name and dates: an address, phone number or e-mail. */
function hasGuestData(p) {
    return !!(p && (p.street || p.zip || p.phone || p.email));
}

module.exports = { parseGuestText, hasGuestData, splitAddress, addressText, countryOf };
