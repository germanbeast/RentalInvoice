const db = require('./db');
const { renderInvoiceHtml } = require('./invoice-template');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

/**
 * Shared logic for both WhatsApp and Telegram bots.
 */

const MAX_STAY_NIGHTS = 90;

function isValidYmd(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function ymd(y, m, d) {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Extracts an arrival/departure range from free text.
 * Accepts "15.03. - 20.03.", "15.03.-20.03.2026", "15.03.2026 bis 20.03.2026", "15.3 20.3." ...
 *
 * Year handling:
 *  - explicit year on the departure (or arrival) date is used for both dates unless given separately
 *  - without a year: the next occurrence of the arrival date is assumed (a date more than
 *    30 days in the past is moved to next year); a departure before the arrival rolls over
 *    into the following year (28.12. - 03.01.)
 *
 * Returns { arrival, departure, error, matched } - arrival/departure are 'YYYY-MM-DD' or null,
 * `matched` is the exact substring that was recognised (so callers can strip it from the text).
 */
function parseDates(text, today = new Date()) {
    const none = { arrival: null, departure: null, error: null, matched: null };
    if (!text) return none;

    const re = /(\d{1,2})\.(\d{1,2})\.?(\d{4}|\d{2}(?![\d.]))?(?!\d)/g;
    const found = [];
    let m;
    while ((m = re.exec(text)) !== null && found.length < 2) {
        found.push({
            d: parseInt(m[1], 10),
            m: parseInt(m[2], 10),
            y: m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)) : null,
            start: m.index,
            end: m.index + m[0].length
        });
    }
    if (found.length < 2) return none;

    const [a, b] = found;
    const matched = text.slice(a.start, b.end);

    if (a.m < 1 || a.m > 12 || b.m < 1 || b.m > 12 || a.d < 1 || a.d > 31 || b.d < 1 || b.d > 31) {
        return { ...none, matched, error: 'Ungültiges Datum (Tag oder Monat außerhalb des gültigen Bereichs).' };
    }

    const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    let yA = a.y;
    let yB = b.y;

    if (yA === null && yB === null) {
        yA = today.getFullYear();
        // Past dates (more than 30 days ago) are interpreted as next year's stay
        if (isValidYmd(yA, a.m, a.d) && Date.UTC(yA, a.m - 1, a.d) < todayUtc - 30 * 86400000) yA += 1;
        yB = yA;
        if (b.m < a.m || (b.m === a.m && b.d < a.d)) yB = yA + 1;
    } else if (yA === null) {
        yA = yB;
        if (a.m > b.m || (a.m === b.m && a.d > b.d)) yA = yB - 1;
    } else if (yB === null) {
        yB = yA;
        if (b.m < a.m || (b.m === a.m && b.d < a.d)) yB = yA + 1;
    }

    if (!isValidYmd(yA, a.m, a.d)) return { ...none, matched, error: `Das Datum ${a.d}.${a.m}.${yA} existiert nicht.` };
    if (!isValidYmd(yB, b.m, b.d)) return { ...none, matched, error: `Das Datum ${b.d}.${b.m}.${yB} existiert nicht.` };

    const arrival = ymd(yA, a.m, a.d);
    const departure = ymd(yB, b.m, b.d);

    if (departure <= arrival) {
        return { arrival: null, departure: null, matched, error: 'Die Abreise muss nach der Anreise liegen.' };
    }
    const nights = Math.round((Date.UTC(yB, b.m - 1, b.d) - Date.UTC(yA, a.m - 1, a.d)) / 86400000);
    if (nights > MAX_STAY_NIGHTS) {
        return { arrival: null, departure: null, matched, error: `Der Aufenthalt wäre ${nights} Nächte lang – bitte Datum prüfen (Maximum ${MAX_STAY_NIGHTS}).` };
    }

    return { arrival, departure, error: null, matched };
}

function calcNights(anreise, abreise) {
    if (!anreise || !abreise) return 0;
    const start = new Date(anreise);
    const end = new Date(abreise);
    const diff = end - start;
    return Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// Returns true if the string looks like a date, numeric, or is too short to be a real name
function looksLikeDateOrInvalid(str) {
    if (!str || str.trim().length < 2) return true;
    // Matches date patterns like "15.03." or "15.03.2026" or "15.03. - 20.03."
    if (/\d{1,2}\.\d{1,2}\./.test(str)) return true;
    // Purely numeric
    if (/^\d+$/.test(str.trim())) return true;
    return false;
}

const EMAIL_IN_TEXT = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/;

/**
 * Splits a free-text booking message into name / address / e-mail / dates.
 * - A leading command word ("Rechnung", "/pin", ...) is stripped but the rest of the line is kept,
 *   so "Rechnung Max Mustermann" yields the name "Max Mustermann".
 * - Dates may sit on their own line or on the same line as the name.
 * - gEmail is only set when an e-mail address was found (otherwise the key is absent).
 * - dateError carries a human readable reason if a date range was recognised but is invalid.
 */
function parseInvoiceText(text) {
    const data = { gName: '', gAdresse: '', arrival: '', departure: '' };
    if (!text) return data;

    let work = String(text).replace(/\r/g, '');

    // Dates first, so they can be removed from the remaining text
    const dates = parseDates(work.replace(/\n/g, ' '));
    if (dates.matched) {
        // remove the matched range from the original (newline-preserving) text where possible
        const flat = work.replace(/\n/g, ' ');
        const idx = flat.indexOf(dates.matched);
        if (idx >= 0) work = work.slice(0, idx) + '\n' + work.slice(idx + dates.matched.length);
    }
    data.arrival = dates.arrival || '';
    data.departure = dates.departure || '';
    if (dates.error) data.dateError = dates.error;

    let lines = work.split('\n')
        .map(l => l.trim().replace(/^\/?(rechnung|pin)(@\w+)?\b[:\s-]*/i, '').trim())
        .map(l => l.replace(/^[,;\-–—\s]+|[,;\-–—\s]+$/g, '').trim())
        .filter(l => l);

    // Pull out an e-mail address
    const emailLineIdx = lines.findIndex(l => EMAIL_IN_TEXT.test(l));
    if (emailLineIdx >= 0) {
        const mail = lines[emailLineIdx].match(EMAIL_IN_TEXT)[0];
        data.gEmail = mail;
        const rest = lines[emailLineIdx].replace(mail, '').replace(/^[,;\s]+|[,;\s]+$/g, '').trim();
        if (rest) lines[emailLineIdx] = rest; else lines.splice(emailLineIdx, 1);
    }

    lines = lines.filter(l => !looksLikeDateOrInvalid(l));
    if (lines.length === 0) return data;

    data.gName = lines[0];
    data.gAdresse = lines.slice(1).join('\n');
    return data;
}

async function getStatusText() {
    const open = db.getOpenInvoices();
    if (open.length === 0) {
        return 'Aktuell keine offenen Rechnungen. ✅';
    }
    let text = '*Offene Rechnungen:*\n\n';
    open.forEach(inv => {
        text += `• ${inv.invoice_number} - ${inv.guest_display_name}: ${inv.total_amount.toFixed(2)}€\n`;
    });
    return text;
}

async function createNukiPinDirect(arrival, departure, guestName) {
    const allSettings = db.getAllSettings();
    const nuki = allSettings.nuki;
    if (!nuki || !nuki.token || !nuki.lockId) throw new Error('Nuki-Zugangsdaten fehlen');

    const generateValidPin = () => {
        let pin;
        do {
            pin = Array.from({ length: 6 }, () => Math.floor(Math.random() * 9) + 1).join('');
        } while (pin.startsWith('12'));
        return pin;
    };
    const generatedCode = generateValidPin();

    const allowedFrom = `${arrival}T15:00:00.000Z`;
    const allowedUntil = `${departure}T11:00:00.000Z`;
    const safeName = `Gast: ${guestName || 'Gast'}`.substring(0, 20);

    const lockId = parseInt(nuki.lockId, 10) || nuki.lockId;
    await axios.put('https://api.nuki.io/smartlock/auth', {
        name: safeName,
        allowedFromDate: allowedFrom,
        allowedUntilDate: allowedUntil,
        allowedWeekDays: 127,
        allowedFromTime: 0,
        allowedUntilTime: 0,
        type: 13,
        code: generatedCode,
        smartlockIds: [lockId]
    }, {
        headers: {
            'Authorization': `Bearer ${nuki.token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    });

    // Nuki API returns 204 No Content — no authId in response body.
    // Wait briefly then fetch the auth list to find the newly created entry by PIN code.
    let authId = null;
    try {
        await new Promise(r => setTimeout(r, 2000));
        const listRes = await axios.get(`https://api.nuki.io/smartlock/${lockId}/auth`, {
            headers: { 'Authorization': `Bearer ${nuki.token}`, 'Accept': 'application/json' }
        });
        const auths = Array.isArray(listRes.data) ? listRes.data : [];
        const match = auths.find(a => String(a.code) === String(generatedCode));
        if (match) authId = match.id;
    } catch (e) {
        console.warn('Nuki authId lookup failed:', e.message);
    }

    return { success: true, pin: generatedCode, authId };
}

/**
 * Fetches all keypad codes (type 13) live from the Nuki Web API.
 * Returns [{ id, name, code, enabled, from, until, lastActive }] sorted by start date.
 */
async function listNukiCodes() {
    const nuki = db.getAllSettings().nuki;
    if (!nuki || !nuki.token || !nuki.lockId) throw new Error('Nuki-Zugangsdaten fehlen');
    const lockId = parseInt(nuki.lockId, 10) || nuki.lockId;

    let res;
    try {
        res = await axios.get(`https://api.nuki.io/smartlock/${lockId}/auth`, {
            headers: { 'Authorization': `Bearer ${nuki.token}`, 'Accept': 'application/json' },
            timeout: 15000
        });
    } catch (e) {
        const status = e.response && e.response.status;
        if (status === 401) throw new Error('Nuki-Token ungültig oder abgelaufen (401)');
        if (status === 429) throw new Error('Nuki-API: zu viele Anfragen (429) – bitte kurz warten');
        throw new Error('Nuki-API nicht erreichbar: ' + e.message);
    }

    const auths = Array.isArray(res.data) ? res.data : [];
    return auths
        .filter(a => a.type === 13 && a.code !== undefined && a.code !== null && String(a.code) !== '')
        .map(a => ({
            id: a.id,
            name: a.name || 'Unbenannt',
            code: String(a.code),
            enabled: a.enabled !== false,
            from: a.allowedFromDate || null,
            until: a.allowedUntilDate || null,
            lastActive: a.lastActiveDate || null
        }))
        .sort((x, y) => String(x.from || '').localeCompare(String(y.from || '')));
}

/**
 * Updates an existing Nuki keypad code. Nuki's update endpoint is
 * POST /smartlock/{lockId}/auth/{id} and expects the complete authorization,
 * so the current entry is read first and only the given fields are changed.
 * patch: any of { name, allowedFromDate, allowedUntilDate, enabled }
 */
async function updateNukiAuth(authId, patch) {
    const nuki = db.getAllSettings().nuki;
    if (!nuki || !nuki.token || !nuki.lockId) throw new Error('Nuki-Zugangsdaten fehlen');
    const lockId = parseInt(nuki.lockId, 10) || nuki.lockId;
    const headers = { 'Authorization': `Bearer ${nuki.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };

    try {
        const listRes = await axios.get(`https://api.nuki.io/smartlock/${lockId}/auth`, { headers, timeout: 15000 });
        const auths = Array.isArray(listRes.data) ? listRes.data : [];
        const cur = auths.find(a => String(a.id) === String(authId));
        if (!cur) throw new Error('Code im Nuki-Schloss nicht gefunden (evtl. manuell gelöscht)');

        const body = {
            name: cur.name,
            type: cur.type,
            code: Number(cur.code),
            allowedFromDate: cur.allowedFromDate,
            allowedUntilDate: cur.allowedUntilDate,
            allowedWeekDays: cur.allowedWeekDays !== undefined ? cur.allowedWeekDays : 127,
            allowedFromTime: cur.allowedFromTime || 0,
            allowedUntilTime: cur.allowedUntilTime || 0,
            enabled: cur.enabled !== false,
            ...patch
        };
        Object.keys(body).forEach(k => (body[k] === undefined || body[k] === null) && delete body[k]);

        await axios.post(`https://api.nuki.io/smartlock/${lockId}/auth/${authId}`, body, { headers, timeout: 15000 });
    } catch (e) {
        if (e.response) {
            const detail = typeof e.response.data === 'object' ? JSON.stringify(e.response.data) : String(e.response.data || '');
            throw new Error(`Nuki-API ${e.response.status}${detail ? ': ' + detail.slice(0, 160) : ''}`);
        }
        throw e;
    }
}

// True for the neutral names created when the calendar contains no real guest name
function isPlaceholderGuestName(name) {
    const n = String(name || '').trim();
    if (!n || /^gast$/i.test(n)) return true;
    return /^(booking|airbnb) \d{2}\.\d{2}\.$/i.test(n) || /not available|closed|reserved/i.test(n);
}

/** Deletes a placeholder guest ("Booking 30.10." ...) when no booking or invoice references it any more. */
function cleanupPlaceholderGuest(guestId) {
    if (!guestId) return false;
    try {
        const g = db.getGuestById(guestId);
        if (g && isPlaceholderGuestName(g.name) &&
            db.getBookingsByGuestId(guestId).length === 0 &&
            db.getInvoicesByGuestId(guestId).length === 0) {
            db.deleteGuest(guestId);
            return true;
        }
    } catch (e) { /* best-effort */ }
    return false;
}

/**
 * Assigns a real guest name to a booking: links/creates the guest, renames the Nuki code
 * and removes the placeholder guest if nothing else references it.
 */
async function applyGuestName(bookingId, fullName) {
    const name = String(fullName || '').trim();
    if (name.length < 2) throw new Error('Name zu kurz');
    const d = db.getDb();
    const booking = d.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!booking) throw new Error('Buchung nicht gefunden');

    const guest = db.findOrCreateGuest(name, null, null);
    const oldGuestId = booking.guest_id;
    d.prepare('UPDATE bookings SET guest_id = ? WHERE id = ?').run(guest.id, bookingId);

    let nukiRenamed = false;
    let nukiError = null;
    if (booking.nuki_auth_id) {
        try {
            await updateNukiAuth(booking.nuki_auth_id, { name: `Gast: ${name}`.substring(0, 20) });
            nukiRenamed = true;
        } catch (e) {
            nukiError = e.message;
            console.warn(`⚠️ Nuki-Code von Buchung ${bookingId} konnte nicht umbenannt werden:`, e.message);
        }
    }

    if (oldGuestId && oldGuestId !== guest.id) cleanupPlaceholderGuest(oldGuestId);

    return { guestId: guest.id, name, nukiRenamed, nukiError, booking };
}

async function finalizeInvoiceData(data) {
    const allSettings = db.getAllSettings();
    const vermieter = allSettings.vermieter || {};
    const bank = allSettings.bank || {};
    const pricing = allSettings.pricing || { price_per_night: 85, cleaning_fee: 50, mwst_rate: 7, kleinunternehmer: false };

    const nights = calcNights(data.arrival, data.departure);

    const invoiceData = {
        vName: vermieter.name,
        vAdresse: vermieter.adresse,
        vTelefon: vermieter.telefon,
        vEmail: vermieter.email,
        vSteuernr: vermieter.steuernr,
        gName: data.gName,
        gAdresse: data.gAdresse,
        rNummer: db.getNextInvoiceNumber(),
        rDatum: new Date().toISOString().split('T')[0],
        aAnreise: data.arrival,
        aAbreise: data.departure,
        mwstSatz: pricing.mwst_rate,
        kleinunternehmer: pricing.kleinunternehmer,
        zBezahlt: false,
        zMethode: 'Überweisung',
        zDatum: '',
        zShowBank: true,
        bInhaber: bank.inhaber,
        bIban: bank.iban,
        bBic: bank.bic,
        bBank: bank.name,
        positions: [
            { desc: 'Übernachtung', qty: nights, price: pricing.price_per_night },
            { desc: 'Endreinigung', qty: 1, price: pricing.cleaning_fee }
        ],
        branding: db.getBranding()
    };

    // Calculate totalAmount for correct DB storage
    const subtotal = invoiceData.positions.reduce((sum, p) => sum + (p.qty * p.price), 0);
    const mwst = invoiceData.kleinunternehmer ? 0 : subtotal * ((invoiceData.mwstSatz || 0) / 100);
    invoiceData.totalAmount = subtotal + mwst;

    // Nuki Logic
    const existingBooking = db.findBookingForStay(data.gName, data.arrival, data.departure);
    if (existingBooking && existingBooking.nuki_pin) {
        // Reuse the already-created PIN (e.g. from iCal or Telegram PIN-only flow)
        invoiceData.nukiPin = existingBooking.nuki_pin;
    } else {
        try {
            const nukiResult = await createNukiPinDirect(data.arrival, data.departure, data.gName);
            if (nukiResult.success) {
                invoiceData.nukiPin = nukiResult.pin;
                const guest = db.findOrCreateGuest(data.gName, data.gEmail || null, data.gAdresse || null);
                if (existingBooking) {
                    db.updateBookingNukiData(existingBooking.id, nukiResult.pin, nukiResult.authId);
                    if (!existingBooking.guest_id) {
                        db.getDb().prepare('UPDATE bookings SET guest_id = ? WHERE id = ?').run(guest.id, existingBooking.id);
                    }
                } else {
                    // No iCal booking — create a manual one so PIN appears in guest detail
                    db.createManualBooking(guest.id, data.gName, data.arrival, data.departure, nukiResult.pin, nukiResult.authId);
                }
            }
        } catch (e) {
            console.error('Nuki PIN failed in Bot flow:', e.message);
        }
    }

    return invoiceData;
}

async function generateInvoicePdf(invoiceData) {
    const html = renderInvoiceHtml(invoiceData);

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

    let pdfBuffer;
    try {
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
        pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            preferCSSPageSize: true,
            scale: 0.85
        });
    } finally {
        await browser.close();
    }

    const fileName = `Rechnung_${invoiceData.rNummer}.pdf`;
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, pdfBuffer);

    return { filePath, fileName };
}

module.exports = {
    parseDates,
    calcNights,
    parseInvoiceText,
    getStatusText,
    finalizeInvoiceData,
    generateInvoicePdf,
    createNukiPinDirect,
    listNukiCodes,
    updateNukiAuth,
    applyGuestName,
    isPlaceholderGuestName,
    cleanupPlaceholderGuest
};
