/**
 * Guest address on invoices: always from the guest of the booking, never from whatever was in the form before.
 *
 * - bookingGuest(): the data an invoice for a booking starts with (guest of the booking, Meldeschein as fallback).
 * - bindInvoiceGuest(): before saving, ties the invoice to the guest of its booking (or the guest picked in the form)
 *   and keeps that guest's address up to date. Without such a link nothing is overwritten (see db.findOrCreateGuest).
 * - audit(): finds invoices and guests that probably carry another guest's address (the bug fixed in v1.50.1),
 *   with a suggestion where the right address is known (Meldeschein the guest filled in, or the guest record).
 */
const db = require('./db');
const botLogic = require('./bot-logic');

const GERMAN = /^(deutsch(land)?|germany|german|de|d|brd)$/i;

/** Comparable form: lower case, no accents/punctuation, no country line for Germany, no "z. Hd."/USt-IdNr. lines. */
function normAddress(text) {
    return String(text || '').split('\n')
        .map(l => l.trim())
        .filter(l => l && !/^(z\.\s*hd\.|ust-?idnr|vat)/i.test(l) && !GERMAN.test(l))
        .join(' ')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/ß/g, 'ss')
        .replace(/str(asse|\.)?(?=\s|\d|$)/g, 'str')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function nameWords(n) {
    return String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9ß ]+/g, ' ').split(/\s+/).filter(w => w.length > 1);
}

/** Same person as far as names tell: same name or same last name. Empty names never count as different. */
function samePerson(a, b) {
    const x = nameWords(a), y = nameWords(b);
    if (!x.length || !y.length) return true;
    if (x.join(' ') === y.join(' ')) return true;
    return x[x.length - 1] === y[y.length - 1];
}

const realName = n => (n && !botLogic.isPlaceholderGuestName(n)) ? n : '';

function meldescheinAddress(bookingId) {
    try {
        const r = db.getDb().prepare('SELECT data FROM guest_registrations WHERE booking_id = ?').get(bookingId);
        if (!r) return '';
        const f = JSON.parse(r.data || '{}');
        if (!f.street || !(f.zip || f.city)) return '';
        return [f.street, `${f.zip || ''} ${f.city || ''}`.trim(), GERMAN.test(String(f.country || '').trim()) ? '' : f.country].filter(Boolean).join('\n');
    } catch (e) { return ''; } // table exists only once the Meldeschein module ran
}

/** Start data for an invoice of this booking. Null when the booking does not exist. */
function bookingGuest(bookingId) {
    const b = db.getDb().prepare(`
        SELECT b.id, b.checkin, b.checkout, b.summary, b.guest_id, g.name, g.email, g.address
        FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id WHERE b.id = ?`).get(bookingId);
    if (!b) return null;
    const name = realName(b.name);
    let address = String(b.address || '').trim();
    let addressSource = address ? 'guest' : '';
    if (!address) {
        address = meldescheinAddress(b.id);
        if (address) addressSource = 'meldeschein';
    }
    return {
        bookingId: b.id, guestId: name ? b.guest_id : null, name, email: name ? (b.email || '') : '',
        address, addressSource, checkin: b.checkin, checkout: b.checkout
    };
}

/**
 * Called right before an invoice is saved. data.bookingId / data.guestId come from the admin form or the Telegram
 * flow that started from a booking. Sets data.guest_id and updates that guest's address when it was changed on
 * the invoice (that is a deliberate correction, the form started with the guest's own address).
 */
async function bindInvoiceGuest(data) {
    const d = db.getDb();
    const name = String(data.gName || data.guest_name || '').trim();
    const address = String(data.gAdresse || '').trim();
    let guest = null;

    const picked = Number(data.guestId || data.guest_id) || null;
    if (picked) guest = db.getGuestById(picked) || null;

    const bookingId = Number(data.bookingId) || null;
    const booking = bookingId ? d.prepare('SELECT id, guest_id FROM bookings WHERE id = ?').get(bookingId) : null;
    if (!booking && bookingId) delete data.bookingId;
    if (!guest && booking) {
        const g = booking.guest_id ? db.getGuestById(booking.guest_id) : null;
        if (g && realName(g.name)) guest = g;
        else if (name.length >= 2) {
            // Booking without a real name yet: the name on the invoice becomes the booking's guest
            const r = await botLogic.applyGuestName(booking.id, name);
            guest = db.getGuestById(r.guestId);
        }
    }
    if (!guest) return null;

    data.guest_id = guest.id;
    data.guestId = guest.id;
    // Only the plain address goes to the guest, not "z. Hd." / USt-IdNr. lines of a company invoice
    const plain = address.split('\n').filter(l => !/^(z\.\s*hd\.|ust-?idnr)/i.test(l.trim())).join('\n').trim();
    if (plain && normAddress(plain) !== normAddress(guest.address)) {
        db.updateGuest(guest.id, { ...guest, address: plain });
    }
    return guest;
}

// ---------------------------------------------------------------------------
// Check of existing data
// ---------------------------------------------------------------------------
function ackSet() {
    const s = db.getAllSettings().address_check_ack;
    return new Set(Array.isArray(s) ? s : []);
}

function acknowledge(key) {
    const set = ackSet();
    set.add(String(key).slice(0, 80));
    db.setSetting('address_check_ack', [...set].slice(-500));
}

function audit() {
    const d = db.getDb();
    const ack = ackSet();
    const guests = d.prepare('SELECT id, name, email, address, updated_at FROM guests').all();
    const guestById = new Map(guests.map(g => [g.id, g]));
    const invoices = d.prepare('SELECT id, invoice_number, guest_id, guest_name, arrival, departure, invoice_date, data FROM invoices ORDER BY invoice_date ASC, id ASC').all()
        .map(i => {
            let data = {};
            try { data = JSON.parse(i.data || '{}') || {}; } catch (e) { /* ignore */ }
            return { ...i, data, addr: String(data.gAdresse || '').trim(), norm: normAddress(data.gAdresse) };
        });

    // Who an address belongs to: every (name, address) pair seen on invoices, guests and Meldescheine
    const owners = new Map();
    const own = (norm, name, where) => {
        if (!norm || norm.length < 6 || !realName(name)) return;
        if (!owners.has(norm)) owners.set(norm, []);
        owners.get(norm).push({ name, where });
    };
    invoices.forEach(i => own(i.norm, i.data.gName || i.guest_name, { invoiceId: i.id, number: i.invoice_number, date: i.invoice_date || i.arrival }));
    guests.forEach(g => own(normAddress(g.address), g.name, { guestId: g.id }));

    const bookingFor = i => {
        if (i.data.bookingId) {
            const b = d.prepare('SELECT id, guest_id FROM bookings WHERE id = ?').get(i.data.bookingId);
            if (b) return b;
        }
        if (!i.arrival || !i.departure) return null;
        const rows = d.prepare('SELECT id, guest_id FROM bookings WHERE checkin = ? AND checkout = ?').all(i.arrival, i.departure);
        return rows.length === 1 ? rows[0] : null;
    };

    const isEarlier = (w, i) => {
        const a = w.date || '', b = i.invoice_date || i.arrival || '';
        return a && b && a !== b ? a < b : w.invoiceId < i.id;
    };
    // First invoice per address = its owner
    const firstOwner = new Map();
    invoices.forEach(i => {
        const name = realName(i.data.gName || i.guest_name);
        if (!i.norm || !name) return;
        const cur = firstOwner.get(i.norm);
        if (!cur || isEarlier({ date: i.invoice_date || i.arrival, invoiceId: i.id }, cur)) firstOwner.set(i.norm, { ...i, name });
    });

    const invoiceIssues = [];
    for (const i of invoices) {
        const name = i.data.gName || i.guest_name || '';
        if (!i.norm || !realName(name)) continue;
        const key = `inv:${i.id}:${i.norm.slice(0, 40)}`;
        if (ack.has(key)) continue;
        const reasons = [];
        // 1) The address also appears for a different person, earlier than this invoice
        const others = (owners.get(i.norm) || []).filter(o => !samePerson(o.name, name));
        // Only earlier invoices count: the first invoice with an address shows whose address it is
        const earlier = others.filter(o => o.where.invoiceId && o.where.invoiceId !== i.id && isEarlier(o.where, i));
        if (earlier.length) reasons.push(`Gleiche Anschrift wie bei ${[...new Set(earlier.map(o => o.name))].slice(0, 2).join(', ')}`);
        // 2) The guest of the booking (or a Meldeschein) has a different address
        const b = bookingFor(i);
        const mAddr = b ? meldescheinAddress(b.id) : '';
        const bg = b && b.guest_id ? guestById.get(b.guest_id) : null;
        let suggestion = '', suggestionSource = '';
        if (mAddr && normAddress(mAddr) !== i.norm) { suggestion = mAddr; suggestionSource = 'Meldeschein des Gastes'; }
        else if (bg && realName(bg.name) && samePerson(bg.name, name) && bg.address && normAddress(bg.address) !== i.norm) {
            const shared = (owners.get(normAddress(bg.address)) || []).some(o => !samePerson(o.name, bg.name));
            if (!shared) { suggestion = bg.address; suggestionSource = 'Gastdaten der Buchung'; }
        }
        if (suggestion && !reasons.length) reasons.push(`Weicht ab von: ${suggestionSource}`);
        if (!reasons.length) continue;
        invoiceIssues.push({
            key, invoiceId: i.id, number: i.invoice_number, name, address: i.addr,
            arrival: i.arrival, departure: i.departure, date: i.invoice_date,
            reasons, suggestion, suggestionSource, bookingId: b ? b.id : null,
            guestInvoice: !!i.data.guestInvoice
        });
    }

    // Guests whose stored address also belongs to another person
    const guestIssues = [];
    for (const g of guests) {
        const norm = normAddress(g.address);
        if (!norm || !realName(g.name)) continue;
        const key = `guest:${g.id}:${norm.slice(0, 40)}`;
        if (ack.has(key)) continue;
        const others = (owners.get(norm) || []).filter(o => !samePerson(o.name, g.name));
        if (!others.length) continue;
        const first = firstOwner.get(norm);
        if (first && samePerson(first.name, g.name)) continue; // this guest had the address first
        const bookings = d.prepare('SELECT id FROM bookings WHERE guest_id = ? ORDER BY checkin DESC').all(g.id);
        let suggestion = '', suggestionSource = '';
        for (const b of bookings) {
            const m = meldescheinAddress(b.id);
            if (m && normAddress(m) !== norm) { suggestion = m; suggestionSource = 'Meldeschein des Gastes'; break; }
        }
        guestIssues.push({
            key, guestId: g.id, name: g.name, address: g.address,
            reasons: [`Gleiche Anschrift wie bei ${[...new Set(others.map(o => o.name))].slice(0, 2).join(', ')}`],
            suggestion, suggestionSource
        });
    }
    return { invoices: invoiceIssues, guests: guestIssues };
}

/** Corrects the address of a saved invoice (the admin chose to). Keeps a note of the old value in the data. */
function fixInvoiceAddress(invoiceId, address) {
    const d = db.getDb();
    const row = d.prepare('SELECT id, data FROM invoices WHERE id = ?').get(invoiceId);
    if (!row) return false;
    let data = {};
    try { data = JSON.parse(row.data || '{}') || {}; } catch (e) { /* ignore */ }
    const corrections = Array.isArray(data.addressCorrections) ? data.addressCorrections : [];
    corrections.push({ at: new Date().toISOString(), old: data.gAdresse || '' });
    data.gAdresse = address;
    data.addressCorrections = corrections.slice(-5);
    d.prepare('UPDATE invoices SET data = ? WHERE id = ?').run(JSON.stringify(data), row.id);
    return true;
}

module.exports = { normAddress, samePerson, bookingGuest, bindInvoiceGuest, audit, acknowledge, fixInvoiceAddress, meldescheinAddress };
