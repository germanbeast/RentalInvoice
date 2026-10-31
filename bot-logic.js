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
async function updateNukiAuth(authId, patch, known = null) {
    const nuki = db.getAllSettings().nuki;
    if (!nuki || !nuki.token || !nuki.lockId) throw new Error('Nuki-Zugangsdaten fehlen');
    const lockId = parseInt(nuki.lockId, 10) || nuki.lockId;
    const headers = { 'Authorization': `Bearer ${nuki.token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };

    try {
        let cur = known && String(known.id) === String(authId) ? known : null;
        if (!cur) {
            const listRes = await axios.get(`https://api.nuki.io/smartlock/${lockId}/auth`, { headers, timeout: 15000 });
            const auths = Array.isArray(listRes.data) ? listRes.data : [];
            cur = auths.find(a => String(a.id) === String(authId));
        }
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

// ---------------------------------------------------------------------------
// Door code of a booking: find it, keep it in sync (dates + name) instead of creating new ones
// ---------------------------------------------------------------------------
const NUKI_NAME_MAX = 20;
const DEFAULT_FROM_TIME = 'T15:00:00.000Z';
const DEFAULT_UNTIL_TIME = 'T11:00:00.000Z';

/** Name of a guest's keypad code as shown in the Nuki app ("Gast: Max Muster", max. 20 characters). */
function nukiCodeName(guestName) {
    return `Gast: ${String(guestName || 'Gast').trim() || 'Gast'}`.substring(0, NUKI_NAME_MAX);
}

/** True for code names created before a real guest name was known ("Gast: Booking 12.03.", "Gast Booking" ...). */
function isPlaceholderCodeName(codeName) {
    const rest = String(codeName || '').trim().replace(/^gast\s*:?\s*/i, '').trim();
    if (!rest) return true;
    if (isPlaceholderGuestName(rest)) return true;
    return /^(booking|airbnb|gast)\b[\s\d.:-]*$/i.test(rest);
}

/** Raw authorization list of the lock from Nuki Web. */
async function fetchNukiAuths() {
    const { token, lockId } = nukiCredentials();
    const res = await axios.get(`https://api.nuki.io/smartlock/${lockId}/auth`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        timeout: 15000
    });
    return Array.isArray(res.data) ? res.data : [];
}

/**
 * Finds the live Nuki entry of a booking: by the stored auth id, otherwise by its PIN (the id lookup right
 * after creating a code sometimes fails because Nuki Web lists new codes with a delay). A found id is stored.
 */
function findBookingAuth(booking, auths) {
    if (!booking) return null;
    let cur = null;
    if (booking.nuki_auth_id) cur = auths.find(a => String(a.id) === String(booking.nuki_auth_id));
    if (!cur && booking.nuki_pin) cur = auths.find(a => a.type === 13 && String(a.code) === String(booking.nuki_pin));
    if (cur && String(cur.id) !== String(booking.nuki_auth_id || '')) {
        try { db.updateBookingNukiData(booking.id, booking.nuki_pin || String(cur.code), String(cur.id)); } catch (e) { /* best-effort */ }
        booking.nuki_auth_id = String(cur.id);
    }
    return cur || null;
}

/** Keeps the time of day of an existing Nuki date (UTC) and only swaps the day. */
function withDay(iso, ymd, fallbackTime) {
    const m = /^\d{4}-\d{2}-\d{2}(T.*)$/.exec(String(iso || ''));
    return `${ymd}${m ? m[1] : fallbackTime}`;
}

/**
 * Changes the existing door code of a booking in place.
 * changes: { from, until } as YYYY-MM-DD (time of day of the code is kept), { name } raw code name,
 *          or { guestName } -> "Gast: <name>".
 * Returns { updated: true, pin, authId, name, from, until } or { updated: false, missing: true } when the
 * booking has no code that still exists in Nuki.
 */
async function syncBookingCode(bookingOrId, changes = {}, auths = null) {
    const booking = typeof bookingOrId === 'object' ? bookingOrId
        : db.getDb().prepare('SELECT * FROM bookings WHERE id = ?').get(bookingOrId);
    if (!booking) throw new Error('Buchung nicht gefunden');
    if (!booking.nuki_auth_id && !booking.nuki_pin) return { updated: false, missing: true };
    const list = auths || await fetchNukiAuths();
    const cur = findBookingAuth(booking, list);
    if (!cur) return { updated: false, missing: true };

    const patch = {};
    if (changes.from) patch.allowedFromDate = withDay(cur.allowedFromDate, changes.from, DEFAULT_FROM_TIME);
    if (changes.until) patch.allowedUntilDate = withDay(cur.allowedUntilDate, changes.until, DEFAULT_UNTIL_TIME);
    if (changes.name) patch.name = String(changes.name).trim().substring(0, NUKI_NAME_MAX);
    else if (changes.guestName) patch.name = nukiCodeName(changes.guestName);
    if (typeof changes.enabled === 'boolean') patch.enabled = changes.enabled;

    const differs = Object.keys(patch).some(k => String(patch[k]) !== String(cur[k]));
    if (differs) await updateNukiAuth(cur.id, patch, cur);
    if (!booking.nuki_pin && cur.code) db.updateBookingNukiData(booking.id, String(cur.code), String(cur.id));
    return {
        updated: true, changed: differs, pin: String(cur.code || booking.nuki_pin || ''), authId: String(cur.id),
        name: patch.name || cur.name, from: patch.allowedFromDate || cur.allowedFromDate, until: patch.allowedUntilDate || cur.allowedUntilDate
    };
}

/**
 * A code is requested for a stay (invoice form, Telegram, guest list). If a booking of this stay already
 * has a code - same dates, or overlapping dates when the check-in/out moved - that code is moved to the
 * new period and renamed instead of creating a second one. Returns the result of syncBookingCode or null.
 */
async function reuseStayCode(guestName, arrival, departure) {
    const d = db.getDb();
    const name = String(guestName || '').trim();
    const withCode = "((b.nuki_auth_id IS NOT NULL AND b.nuki_auth_id != '') OR (b.nuki_pin IS NOT NULL AND b.nuki_pin != ''))";
    let booking = null;
    if (name) {
        booking = d.prepare(`
            SELECT b.* FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
            WHERE ${withCode} AND b.checkin < ? AND b.checkout > ?
              AND (g.name = ? COLLATE NOCASE OR b.summary LIKE ?)
            ORDER BY (b.checkin = ? AND b.checkout = ?) DESC LIMIT 1
        `).get(departure, arrival, name, `%${name}%`, arrival, departure);
    }
    if (!booking) {
        // Only one overlapping stay with a code -> that is this stay (the apartment has one unit)
        const rows = d.prepare(`SELECT b.* FROM bookings b WHERE ${withCode} AND b.checkin < ? AND b.checkout > ?`).all(departure, arrival);
        if (rows.length === 1) booking = rows[0];
    }
    if (!booking) return null;
    const r = await syncBookingCode(booking, {
        from: arrival, until: departure,
        guestName: name && !isPlaceholderGuestName(name) ? name : undefined
    });
    if (!r.updated) return null;
    return { ...r, bookingId: booking.id };
}

/**
 * Renames the codes of all current and upcoming bookings of a guest (guest renamed in the admin).
 */
async function renameGuestCodes(guestId, guestName) {
    if (!guestId || isPlaceholderGuestName(guestName)) return 0;
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
    const rows = db.getDb().prepare(`
        SELECT * FROM bookings WHERE guest_id = ? AND checkout >= ?
          AND ((nuki_auth_id IS NOT NULL AND nuki_auth_id != '') OR (nuki_pin IS NOT NULL AND nuki_pin != ''))
    `).all(guestId, today);
    if (!rows.length) return 0;
    const auths = await fetchNukiAuths();
    let n = 0;
    for (const b of rows) {
        try {
            const r = await syncBookingCode(b, { guestName }, auths);
            if (r.changed) n++;
        } catch (e) {
            console.warn(`⚠️ Türcode von Buchung ${b.id} konnte nicht umbenannt werden:`, e.message);
        }
    }
    return n;
}

/**
 * Hourly repair: links codes whose id was never stored, and renames codes still called
 * "Gast: Booking 12.03." / "Gast: Airbnb ..." once the booking has a real guest name.
 * Codes renamed by hand to something else are left alone.
 */
async function reconcileBookingCodes() {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
    const rows = db.getDb().prepare(`
        SELECT b.*, g.name AS guest_name FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
        WHERE b.checkout >= ?
          AND ((b.nuki_auth_id IS NOT NULL AND b.nuki_auth_id != '') OR (b.nuki_pin IS NOT NULL AND b.nuki_pin != ''))
    `).all(today);
    if (!rows.length) return { renamed: [] };
    const auths = await fetchNukiAuths();
    const renamed = [];
    for (const b of rows) {
        const cur = findBookingAuth(b, auths);
        if (!cur || !b.guest_name || isPlaceholderGuestName(b.guest_name)) continue;
        if (!isPlaceholderCodeName(cur.name)) continue;
        const want = nukiCodeName(b.guest_name);
        if (cur.name === want) continue;
        try {
            const before = cur.name || 'ohne Namen';
            await updateNukiAuth(cur.id, { name: want }, cur);
            cur.name = want;
            renamed.push(`${before} → ${want}`);
            await new Promise(r => setTimeout(r, 500));
        } catch (e) {
            console.warn(`⚠️ Türcode von Buchung ${b.id} konnte nicht umbenannt werden:`, e.message);
        }
    }
    return { renamed };
}

// ---------------------------------------------------------------------------
// Smart lock state and remote actions (Nuki Web API)
// ---------------------------------------------------------------------------
const LOCK_STATES = {
    0: 'nicht kalibriert', 1: 'abgeschlossen', 2: 'wird aufgeschlossen', 3: 'aufgeschlossen', 4: 'wird abgeschlossen',
    5: 'Falle gezogen', 6: 'aufgeschlossen (Lock ’n’ Go)', 7: 'Falle wird gezogen', 254: 'Motor blockiert', 255: 'unbekannt'
};
const DOOR_STATES = { 2: 'Tür zu', 3: 'Tür offen' };
const NUKI_ACTIONS = { unlock: 1, lock: 2, unlatch: 3 };

function nukiCredentials() {
    const nuki = db.getAllSettings().nuki;
    if (!nuki || !nuki.token || !nuki.lockId) throw new Error('Nuki-Zugangsdaten fehlen');
    return { token: nuki.token, lockId: parseInt(nuki.lockId, 10) || nuki.lockId };
}

function nukiError(e, what) {
    const status = e.response && e.response.status;
    if (status === 401 || status === 403) {
        const err = new Error(`Der Nuki-Token darf ${what} nicht (${status}). Bitte beim Token in Nuki Web die passende Berechtigung aktivieren.`);
        err.permission = true;
        return err;
    }
    if (status === 429) return new Error('Nuki-API: zu viele Anfragen (429) – bitte kurz warten');
    if (status) return new Error(`Nuki-API ${status}`);
    return new Error('Nuki-API nicht erreichbar: ' + e.message);
}

/**
 * Current lock state from Nuki Web (the lock reports changes to Nuki Web itself, so this is live enough).
 * Returns { lockState, lockText, locked, unlocked, doorState, doorText, battery, batteryCritical,
 *           batteryCharging, keypadBatteryCritical, doorsensorBatteryCritical, name }
 */
async function getNukiLock() {
    const { token, lockId } = nukiCredentials();
    let res;
    try {
        res = await axios.get(`https://api.nuki.io/smartlock/${lockId}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
            timeout: 15000
        });
    } catch (e) {
        throw nukiError(e, 'den Schloss-Status lesen');
    }
    const st = (res.data && res.data.state) || {};
    const lockState = typeof st.state === 'number' ? st.state : 255;
    return {
        name: res.data && res.data.name,
        lockState,
        lockText: LOCK_STATES[lockState] || `Status ${lockState}`,
        locked: lockState === 1,
        unlocked: [3, 5, 6].includes(lockState),
        doorState: st.doorState,
        doorText: DOOR_STATES[st.doorState] || null,
        battery: typeof st.batteryCharge === 'number' ? st.batteryCharge : null,
        batteryCritical: !!st.batteryCritical,
        batteryCharging: !!st.batteryCharging,
        keypadBatteryCritical: !!st.keypadBatteryCritical,
        doorsensorBatteryCritical: !!st.doorsensorBatteryCritical,
        // Nuki Web serverState: 0 ok, 4 offline (no connection via bridge / Wi-Fi)
        offline: !!(res.data && res.data.serverState === 4)
    };
}

/** action: 'lock' | 'unlock' | 'unlatch'. Nuki answers 204 once the command is queued for the lock. */
async function nukiLockAction(action) {
    const code = NUKI_ACTIONS[action];
    if (!code) throw new Error('Unbekannte Aktion');
    const { token, lockId } = nukiCredentials();
    try {
        await axios.post(`https://api.nuki.io/smartlock/${lockId}/action`, { action: code }, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            timeout: 15000
        });
    } catch (e) {
        throw nukiError(e, 'das Schloss bedienen');
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
    if (booking.nuki_auth_id || booking.nuki_pin) {
        try {
            const r = await syncBookingCode(booking, { guestName: name });
            nukiRenamed = r.updated;
            if (r.missing) nukiError = 'Türcode im Nuki-Schloss nicht gefunden';
        } catch (e) {
            nukiError = e.message;
            console.warn(`⚠️ Nuki-Code von Buchung ${bookingId} konnte nicht umbenannt werden:`, e.message);
        }
    }

    if (oldGuestId && oldGuestId !== guest.id) cleanupPlaceholderGuest(oldGuestId);

    return { guestId: guest.id, name, nukiRenamed, nukiError, booking };
}

/**
 * Invoice data from the settings (landlord, bank, prices) without a door code.
 * data: gName, gAdresse, arrival, departure; optional positions, zMethode, zBezahlt, zShowBank, extra.
 */
function buildInvoiceData(data) {
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
        zBezahlt: data.zBezahlt !== false,
        zMethode: data.zMethode || 'Überweisung',
        zDatum: data.zDatum || '',
        zShowBank: !!data.zShowBank,
        bInhaber: bank.inhaber,
        bIban: bank.iban,
        bBic: bank.bic,
        bBank: bank.name,
        positions: data.positions || [
            { desc: 'Übernachtung', qty: nights, price: pricing.price_per_night },
            { desc: 'Endreinigung', qty: 1, price: pricing.cleaning_fee }
        ],
        branding: db.getBranding(),
        ...(data.extra || {})
    };

    // Calculate totalAmount for correct DB storage
    const subtotal = invoiceData.positions.reduce((sum, p) => sum + (p.qty * p.price), 0);
    const mwst = invoiceData.kleinunternehmer ? 0 : subtotal * ((invoiceData.mwstSatz || 0) / 100);
    invoiceData.totalAmount = subtotal + mwst;
    return invoiceData;
}

async function finalizeInvoiceData(data) {
    const invoiceData = buildInvoiceData(data);

    // Nuki Logic
    const existingBooking = db.findBookingForStay(data.gName, data.arrival, data.departure);
    if (existingBooking && existingBooking.nuki_pin) {
        // Reuse the already-created PIN (e.g. from iCal or Telegram PIN-only flow)
        invoiceData.nukiPin = existingBooking.nuki_pin;
    } else {
        let reused = null;
        try { reused = await reuseStayCode(data.gName, data.arrival, data.departure); }
        catch (e) { console.warn('Bestehender Türcode konnte nicht angepasst werden:', e.message); }
        if (reused) { invoiceData.nukiPin = reused.pin; return invoiceData; }
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
    // Current invoice template from the settings, like the admin app shows it
    const html = renderInvoiceHtml({ ...invoiceData, branding: db.getBranding() });

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
            // Only the page itself, inline data and the fonts of the admin app (Google Fonts)
            const url = request.url();
            if (request.resourceType() === 'document' || url.startsWith('data:') ||
                /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) {
                request.continue();
            } else {
                request.abort();
            }
        });
        try {
            await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
        } catch (e) {
            // Offline: fonts missing, the invoice is still rendered with fallback fonts
            console.warn('⚠️ Rechnung: Schriften nicht geladen:', e.message);
        }
        await page.evaluate(() => document.fonts.ready);
        pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
            preferCSSPageSize: true
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
    buildInvoiceData,
    parseDates,
    calcNights,
    parseInvoiceText,
    getStatusText,
    finalizeInvoiceData,
    generateInvoicePdf,
    createNukiPinDirect,
    listNukiCodes,
    updateNukiAuth,
    fetchNukiAuths,
    nukiCodeName,
    isPlaceholderCodeName,
    syncBookingCode,
    reuseStayCode,
    renameGuestCodes,
    reconcileBookingCodes,
    getNukiLock,
    nukiLockAction,
    applyGuestName,
    isPlaceholderGuestName,
    cleanupPlaceholderGuest
};
