/**
 * Gutscheine (vouchers) for guests, e.g. "2 Nächte gratis beim nächsten Aufenthalt".
 *
 *  - Kinds: 'nights' (free nights at the nightly price), 'amount' (€ off the total), 'percent' (% off the total)
 *  - Every voucher has a unique code (GS-XXXXXX), optional guest, validity (einlösbar ab/bis = date of redemption),
 *    optional minimum stay, an internal note and a dedication printed on the voucher. Single use.
 *  - Redemption:
 *      · website booking request: the guest types the code, the quote shows the discount, the request reserves
 *        the voucher; confirming the request redeems it, declining/cancelling releases it
 *      · "Buchung eintragen" in the admin: optional code, redeemed for that booking
 *      · admin invoice form: "Gutschein einlösen" adds a discount position; saving the invoice redeems it
 *      · invoices built for a stay (Telegram bot, guest self invoice) get the discount line of a voucher
 *        that was redeemed for that stay automatically
 *  - status: 'active' | 'redeemed' | 'cancelled'; "reserviert" (pending request) and "abgelaufen" are derived
 */

const crypto = require('crypto');
const db = require('./db');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['nights', 'amount', 'percent'];

const sql = () => db.getDb();
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const money = n => (Number(n) || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

let schemaReady = false;
function ensureSchema() {
    if (schemaReady) return;
    sql().exec(`
        CREATE TABLE IF NOT EXISTS vouchers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            kind TEXT NOT NULL DEFAULT 'nights',
            value REAL NOT NULL DEFAULT 0,
            guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
            guest_name TEXT,
            valid_from DATE,
            valid_until DATE,
            min_nights INTEGER DEFAULT 0,
            note TEXT,
            dedication TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            request_id INTEGER,
            booking_id INTEGER,
            invoice_id INTEGER,
            redeemed_at DATETIME,
            redeemed_checkin DATE,
            redeemed_checkout DATE,
            redeemed_value REAL,
            redeemed_via TEXT,
            created_by TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_vouchers_booking ON vouchers(booking_id);
        CREATE INDEX IF NOT EXISTS idx_vouchers_request ON vouchers(request_id);
    `);
    const reqCols = sql().prepare('PRAGMA table_info(booking_requests)').all().map(c => c.name);
    if (reqCols.length) {
        if (!reqCols.includes('voucher_code')) sql().exec('ALTER TABLE booking_requests ADD COLUMN voucher_code TEXT');
        if (!reqCols.includes('voucher_discount')) sql().exec('ALTER TABLE booking_requests ADD COLUMN voucher_discount REAL DEFAULT 0');
    }
    schemaReady = true;
}

function berlinToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
}

function nightsBetween(a, b) {
    if (!YMD.test(String(a)) || !YMD.test(String(b))) return 0;
    return Math.max(0, Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000));
}

function formatDE(ymd) {
    return YMD.test(String(ymd || '')) ? ymd.split('-').reverse().join('.') : '';
}

function pricing() {
    const p = db.getAllSettings().pricing || {};
    return {
        night: Number(p.price_per_night) || 0,
        cleaning: Number(p.cleaning_fee) || 0,
        mwst: p.kleinunternehmer ? 0 : (Number(p.mwst_rate) || 0)
    };
}

function normCode(c) {
    const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s.startsWith('GS') && s.length > 2 ? `GS-${s.slice(2)}` : s;
}

function newCode() {
    ensureSchema();
    for (;;) {
        const bytes = crypto.randomBytes(6);
        let s = '';
        for (let i = 0; i < 6; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
        const code = `GS-${s}`;
        if (!sql().prepare('SELECT 1 FROM vouchers WHERE code = ?').get(code)) return code;
    }
}

/** "2 Gratisnächte", "50,00 €", "10 %" */
function valueLabel(v) {
    const n = Number(v.value) || 0;
    if (v.kind === 'nights') return `${n} ${n === 1 ? 'Gratisnacht' : 'Gratisnächte'}`;
    if (v.kind === 'percent') return `${n.toLocaleString('de-DE')} % Rabatt`;
    return `${money(n)} Guthaben`;
}

/** Status as shown: active | reserved | expired | upcoming | redeemed | cancelled */
function displayStatus(v, today = berlinToday()) {
    if (v.status === 'cancelled') return 'cancelled';
    if (v.status === 'redeemed') return 'redeemed';
    if (v.request_id) {
        const r = sql().prepare('SELECT status FROM booking_requests WHERE id = ?').get(v.request_id);
        if (r && r.status === 'pending') return 'reserved';
    }
    if (v.valid_until && v.valid_until < today) return 'expired';
    if (v.valid_from && v.valid_from > today) return 'upcoming';
    return 'active';
}

function rowView(v) {
    const guest = v.guest_id ? db.getGuestById(v.guest_id) : null;
    const booking = v.booking_id ? sql().prepare('SELECT id, checkin, checkout, summary FROM bookings WHERE id = ?').get(v.booking_id) : null;
    const invoice = v.invoice_id ? sql().prepare('SELECT id, invoice_number FROM invoices WHERE id = ?').get(v.invoice_id) : null;
    const request = v.request_id ? sql().prepare('SELECT id, code, name, checkin, checkout, status FROM booking_requests WHERE id = ?').get(v.request_id) : null;
    return {
        id: v.id, code: v.code, kind: v.kind, value: v.value, label: valueLabel(v),
        guestId: v.guest_id || null, guestName: (guest && guest.name) || v.guest_name || '',
        guestEmail: (guest && guest.email) || '',
        validFrom: v.valid_from || '', validUntil: v.valid_until || '', minNights: v.min_nights || 0,
        note: v.note || '', dedication: v.dedication || '',
        status: displayStatus(v), rawStatus: v.status,
        redeemedAt: v.redeemed_at || null, redeemedCheckin: v.redeemed_checkin || null, redeemedCheckout: v.redeemed_checkout || null,
        redeemedValue: v.redeemed_value != null ? v.redeemed_value : null, redeemedVia: v.redeemed_via || '',
        booking: booking || null, invoice: invoice ? { id: invoice.id, number: invoice.invoice_number } : null,
        request: request || null,
        createdBy: v.created_by || '', createdAt: v.created_at
    };
}

function getByCode(code) {
    ensureSchema();
    const c = normCode(code);
    return c ? sql().prepare('SELECT * FROM vouchers WHERE code = ?').get(c) : null;
}

function getById(id) {
    ensureSchema();
    return sql().prepare('SELECT * FROM vouchers WHERE id = ?').get(id);
}

/**
 * Discount of a voucher for a stay.
 * ctx: { checkin, checkout, nightPrice?, total? (gross price of the stay), mwst? }
 * Returns { discount (gross €), freeNights, line: invoice position (net price) }.
 */
function discountFor(v, ctx) {
    const p = pricing();
    const nights = nightsBetween(ctx.checkin, ctx.checkout);
    const nightPrice = Number(ctx.nightPrice) > 0 ? Number(ctx.nightPrice) : p.night;
    const mwst = ctx.mwst != null ? Number(ctx.mwst) || 0 : p.mwst;
    const total = ctx.total != null ? Math.max(0, Number(ctx.total) || 0) : round2(nights * nightPrice + p.cleaning);
    const value = Number(v.value) || 0;
    const desc = `Gutschein ${v.code}`;
    if (v.kind === 'nights') {
        const free = Math.min(Math.max(0, Math.floor(value)), nights);
        const discount = Math.min(round2(free * nightPrice), total);
        return { discount, freeNights: free, line: { desc: `${desc} (${free} ${free === 1 ? 'Gratisnacht' : 'Gratisnächte'})`, qty: free, price: -round2(nightPrice) } };
    }
    if (v.kind === 'percent') {
        const pct = Math.min(100, Math.max(0, value));
        const discount = round2(total * pct / 100);
        return { discount, freeNights: 0, line: { desc: `${desc} (${pct.toLocaleString('de-DE')} % Rabatt)`, qty: 1, price: -round2(discount / (1 + mwst / 100)) } };
    }
    const discount = Math.min(round2(value), total);
    return { discount, freeNights: 0, line: { desc: `${desc} (Guthaben)`, qty: 1, price: -round2(discount / (1 + mwst / 100)) } };
}

/**
 * Can this code be used for this stay?
 * opts: { checkin, checkout, nightPrice, total, mwst, requestId, bookingId }
 * A voucher already redeemed for exactly this stay (same booking, or same dates) stays usable, so an invoice for
 * a stay booked with a voucher can carry the discount.
 */
function check(code, opts = {}) {
    ensureSchema();
    const v = getByCode(code);
    if (!v) return { ok: false, error: 'Diesen Gutscheincode gibt es nicht.' };
    const today = berlinToday();
    const sameStay = (opts.bookingId && v.booking_id === opts.bookingId) ||
        (opts.requestId && v.request_id === opts.requestId) ||
        (v.redeemed_checkin && v.redeemed_checkin === opts.checkin && v.redeemed_checkout === opts.checkout);
    if (v.status === 'cancelled') return { ok: false, error: 'Dieser Gutschein ist nicht mehr gültig.' };
    if (v.status === 'redeemed' && !sameStay) return { ok: false, error: `Dieser Gutschein wurde bereits eingelöst${v.redeemed_at ? ` (${formatDE(String(v.redeemed_at).slice(0, 10))})` : ''}.` };
    if (v.status === 'active') {
        const st = displayStatus(v, today);
        if (st === 'reserved' && !sameStay) return { ok: false, error: 'Dieser Gutschein ist bereits für eine andere Anfrage vorgemerkt.' };
        if (st === 'expired') return { ok: false, error: `Dieser Gutschein war nur bis ${formatDE(v.valid_until)} einlösbar.` };
        if (st === 'upcoming') return { ok: false, error: `Dieser Gutschein ist erst ab ${formatDE(v.valid_from)} einlösbar.` };
    }
    const nights = nightsBetween(opts.checkin, opts.checkout);
    if (opts.checkin && opts.checkout) {
        if (nights < 1) return { ok: false, error: 'Bitte zuerst den Zeitraum wählen.' };
        if (v.min_nights && nights < v.min_nights) return { ok: false, error: `Dieser Gutschein gilt ab ${v.min_nights} Nächten Aufenthalt.` };
    }
    const d = opts.checkin && opts.checkout ? discountFor(v, opts) : { discount: null, freeNights: 0, line: null };
    return { ok: true, voucher: v, view: rowView(v), label: valueLabel(v), ...d };
}

/** Marks a voucher for a pending website request (it cannot be used elsewhere until the request is decided). */
function reserveForRequest(voucherId, requestId) {
    ensureSchema();
    sql().prepare(`UPDATE vouchers SET request_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'`).run(requestId, voucherId);
}

/** Request declined/cancelled: the voucher is usable again (unless an invoice already uses it). */
function releaseRequest(requestId) {
    ensureSchema();
    sql().prepare(`UPDATE vouchers SET status = CASE WHEN invoice_id IS NULL THEN 'active' ELSE status END,
                   request_id = NULL, booking_id = CASE WHEN invoice_id IS NULL THEN NULL ELSE booking_id END,
                   redeemed_at = CASE WHEN invoice_id IS NULL THEN NULL ELSE redeemed_at END,
                   redeemed_checkin = CASE WHEN invoice_id IS NULL THEN NULL ELSE redeemed_checkin END,
                   redeemed_checkout = CASE WHEN invoice_id IS NULL THEN NULL ELSE redeemed_checkout END,
                   redeemed_value = CASE WHEN invoice_id IS NULL THEN NULL ELSE redeemed_value END,
                   updated_at = CURRENT_TIMESTAMP WHERE request_id = ?`).run(requestId);
}

/** Booking deleted: vouchers redeemed only for that booking (no invoice) become usable again. */
function releaseBooking(bookingId) {
    ensureSchema();
    sql().prepare(`UPDATE vouchers SET status = 'active', booking_id = NULL, request_id = NULL, redeemed_at = NULL,
                   redeemed_checkin = NULL, redeemed_checkout = NULL, redeemed_value = NULL, redeemed_via = NULL,
                   updated_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND invoice_id IS NULL AND status = 'redeemed'`).run(bookingId);
}

/**
 * Redeems a voucher. info: { bookingId, invoiceId, checkin, checkout, value, via, guestId }
 * Keeps already known links (a voucher redeemed for a booking later gets the invoice id as well).
 */
function redeem(voucherId, info = {}) {
    ensureSchema();
    const v = getById(voucherId);
    if (!v || v.status === 'cancelled') return false;
    sql().prepare(`UPDATE vouchers SET status = 'redeemed',
                   booking_id = COALESCE(?, booking_id), invoice_id = COALESCE(?, invoice_id),
                   redeemed_checkin = COALESCE(?, redeemed_checkin), redeemed_checkout = COALESCE(?, redeemed_checkout),
                   redeemed_value = CASE WHEN ? = 1 THEN ? ELSE COALESCE(redeemed_value, ?) END, redeemed_via = COALESCE(redeemed_via, ?),
                   redeemed_at = COALESCE(redeemed_at, CURRENT_TIMESTAMP),
                   guest_id = COALESCE(guest_id, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(info.bookingId || null, info.invoiceId || null, info.checkin || null, info.checkout || null,
            info.invoiceId && info.value != null ? 1 : 0, info.value != null ? round2(info.value) : null,
            info.value != null ? round2(info.value) : null, info.via || null, info.guestId || null, voucherId);
    return true;
}

/** Voucher redeemed for a stay: by booking id, else by the exact dates. */
function forStay({ bookingId, checkin, checkout } = {}) {
    ensureSchema();
    if (bookingId) {
        const v = sql().prepare(`SELECT * FROM vouchers WHERE booking_id = ? AND status = 'redeemed' ORDER BY id LIMIT 1`).get(bookingId);
        if (v) return v;
    }
    if (checkin && checkout) {
        return sql().prepare(`SELECT * FROM vouchers WHERE redeemed_checkin = ? AND redeemed_checkout = ? AND status = 'redeemed' ORDER BY id LIMIT 1`).get(checkin, checkout) || null;
    }
    return null;
}

/**
 * Invoice position for the voucher of a stay, or null. ctx like discountFor plus bookingId.
 * Used by bot-logic.buildInvoiceData (Telegram/WhatsApp) and the guest self invoice.
 */
function invoiceLineForStay(ctx) {
    const v = forStay(ctx);
    if (!v) return null;
    const d = discountFor(v, ctx);
    if (!d.discount) return null;
    return { voucher: v, line: d.line, discount: d.discount };
}

/** Text for the guest (WhatsApp/E-Mail). */
function guestText(v, siteTitle, siteUrl) {
    const view = rowView(v);
    const lines = [
        `Hallo${view.guestName ? ` ${view.guestName.split(' ')[0]}` : ''},`,
        '',
        `als kleines Dankeschön schenken wir Ihnen einen Gutschein für Ihren nächsten Aufenthalt bei ${siteTitle || 'uns'}: ${view.label}.`,
        v.dedication ? `\n${v.dedication}\n` : '',
        `Gutscheincode: ${v.code}`,
        v.valid_until ? `Einlösbar bis: ${formatDE(v.valid_until)}` : '',
        v.min_nights ? `Gilt ab ${v.min_nights} Nächten Aufenthalt.` : '',
        '',
        siteUrl ? `Einfach bei der Buchungsanfrage auf unserer Webseite den Code eintragen (oder direkt über diesen Link buchen):\n${siteUrl}/?gutschein=${encodeURIComponent(v.code)}#buchen\nGerne können Sie sich auch direkt bei uns melden.` : 'Melden Sie sich einfach direkt bei uns und nennen Sie den Code.',
        '',
        'Wir freuen uns auf Sie!'
    ];
    return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Admin routes (rights: area "vouchers", see permissions.js)
// ---------------------------------------------------------------------------
function registerAdminRoutes(app, limiter, { getSite, permissions } = {}) {
    ensureSchema();

    function clean(body, existing) {
        const b = body || {};
        const kind = KINDS.includes(b.kind) ? b.kind : (existing ? existing.kind : 'nights');
        let value = Number(String(b.value != null ? b.value : (existing ? existing.value : '')).replace(',', '.'));
        if (!(value > 0)) return { error: 'Bitte einen Wert größer 0 angeben.' };
        if (kind === 'nights') { value = Math.floor(value); if (value < 1 || value > 60) return { error: 'Gratisnächte: 1 bis 60.' }; }
        if (kind === 'percent' && value > 100) return { error: 'Höchstens 100 %.' };
        if (kind === 'amount' && value > 100000) return { error: 'Betrag zu hoch.' };
        const validFrom = YMD.test(String(b.validFrom || '')) ? b.validFrom : null;
        const validUntil = YMD.test(String(b.validUntil || '')) ? b.validUntil : null;
        if (validFrom && validUntil && validUntil < validFrom) return { error: '„Einlösbar bis“ liegt vor „Einlösbar ab“.' };
        const minNights = Math.max(0, Math.min(60, parseInt(b.minNights, 10) || 0));
        let guestId = parseInt(b.guestId, 10) || null;
        const guestName = String(b.guestName || '').trim().substring(0, 80);
        if (guestId && !db.getGuestById(guestId)) guestId = null;
        if (!guestId && guestName) {
            const g = sql().prepare('SELECT id FROM guests WHERE lower(name) = lower(?) ORDER BY id LIMIT 1').get(guestName);
            if (g) guestId = g.id;
        }
        let code = existing ? existing.code : null;
        if (!existing && b.code) {
            code = normCode(b.code);
            if (!/^[A-Z0-9-]{4,20}$/.test(code)) return { error: 'Eigener Code: 4 bis 20 Zeichen (Buchstaben, Ziffern, Bindestrich).' };
            if (sql().prepare('SELECT 1 FROM vouchers WHERE code = ?').get(code)) return { error: 'Diesen Code gibt es schon.' };
        }
        return {
            kind, value, validFrom, validUntil, minNights, guestId, guestName,
            note: String(b.note || '').trim().substring(0, 1000),
            dedication: String(b.dedication || '').trim().substring(0, 600),
            code
        };
    }

    app.get('/api/vouchers', limiter, (req, res) => {
        const rows = sql().prepare('SELECT * FROM vouchers ORDER BY created_at DESC, id DESC LIMIT 1000').all();
        const list = rows.map(rowView);
        const open = list.filter(v => v.status === 'active' || v.status === 'reserved' || v.status === 'upcoming');
        res.json({
            success: true, vouchers: list,
            summary: {
                open: open.length,
                openNights: open.filter(v => v.kind === 'nights').reduce((s, v) => s + v.value, 0),
                openAmount: open.filter(v => v.kind === 'amount').reduce((s, v) => s + v.value, 0),
                openPercent: open.filter(v => v.kind === 'percent').length,
                redeemed: list.filter(v => v.status === 'redeemed').length,
                redeemedValue: round2(list.filter(v => v.status === 'redeemed').reduce((s, v) => s + (v.redeemedValue || 0), 0))
            }
        });
    });

    // Check a code for a stay (invoice form, "Buchung eintragen"). Allowed for vouchers, invoices or bookings.
    app.get('/api/vouchers/check', limiter, (req, res) => {
        const perms = req.user && req.user.permissions;
        if (permissions && perms && !(permissions.can(perms, 'vouchers') || permissions.can(perms, 'invoices', 'edit') || permissions.can(perms, 'bookings', 'edit'))) {
            return res.status(403).json({ success: false, error: 'Keine Berechtigung: Gutscheine' });
        }
        const q = req.query || {};
        const r = check(String(q.code || ''), {
            checkin: YMD.test(String(q.checkin || '')) ? q.checkin : null,
            checkout: YMD.test(String(q.checkout || '')) ? q.checkout : null,
            nightPrice: q.nightPrice != null && q.nightPrice !== '' ? Number(q.nightPrice) : undefined,
            total: q.total != null && q.total !== '' ? Number(q.total) : undefined,
            mwst: q.mwst != null && q.mwst !== '' ? Number(q.mwst) : undefined,
            bookingId: parseInt(q.bookingId, 10) || undefined
        });
        if (!r.ok) return res.json({ success: false, error: r.error });
        res.json({ success: true, voucher: r.view, label: r.label, discount: r.discount, freeNights: r.freeNights, line: r.line });
    });

    app.get('/api/vouchers/:id/text', limiter, (req, res) => {
        const v = getById(parseInt(req.params.id, 10));
        if (!v) return res.status(404).json({ success: false, error: 'Gutschein nicht gefunden' });
        const site = getSite ? getSite() : {};
        res.json({ success: true, text: guestText(v, site.title, site.public_url ? String(site.public_url).replace(/\/+$/, '') : '') });
    });

    // Printable voucher (A5 landscape card), opens the print dialog
    app.get('/api/vouchers/:id/print', limiter, (req, res) => {
        const v = getById(parseInt(req.params.id, 10));
        if (!v) return res.status(404).send('Gutschein nicht gefunden');
        const site = getSite ? getSite() : {};
        const view = rowView(v);
        const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const url = site.public_url ? String(site.public_url).replace(/\/+$/, '').replace(/^https?:\/\//, '') : '';
        const big = v.kind === 'nights' ? `${v.value} ${v.value === 1 ? 'Nacht' : 'Nächte'}` : v.kind === 'percent' ? `${Number(v.value).toLocaleString('de-DE')} %` : money(v.value);
        const sub = v.kind === 'nights' ? 'gratis bei Ihrem nächsten Aufenthalt' : v.kind === 'percent' ? 'Rabatt auf Ihren nächsten Aufenthalt' : 'Guthaben für Ihren nächsten Aufenthalt';
        res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'");
        res.type('html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Gutschein ${esc(v.code)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Inter:wght@400;500;600&display=swap">
<style>
@page { size: A5 landscape; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; background: #ece8e1; font-family: Inter, system-ui, sans-serif; color: #2a2724; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet { width: 210mm; height: 148mm; margin: 12px auto; background: #faf7f2; position: relative; padding: 14mm 16mm; display: flex; flex-direction: column; }
.sheet::before { content: ''; position: absolute; inset: 6mm; border: 1px solid #c9b79c; pointer-events: none; }
.brand { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 15pt; letter-spacing: .18em; text-transform: uppercase; color: #8a7458; }
.kicker { margin-top: 9mm; font-size: 9pt; letter-spacing: .3em; text-transform: uppercase; color: #8a7458; }
.big { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 600; font-size: 54pt; line-height: 1; margin-top: 3mm; }
.sub { font-size: 12pt; margin-top: 2mm; }
.ded { margin-top: 6mm; font-family: 'Cormorant Garamond', Georgia, serif; font-size: 14pt; font-style: italic; max-width: 150mm; white-space: pre-line; }
.foot { margin-top: auto; display: flex; justify-content: space-between; align-items: flex-end; gap: 10mm; font-size: 9pt; color: #5d5650; }
.code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 16pt; letter-spacing: .08em; color: #2a2724; border: 1px dashed #8a7458; padding: 2mm 4mm; display: inline-block; margin-top: 1.5mm; }
.for { font-size: 10pt; margin-top: 4mm; }
.bar { text-align: center; margin: 14px; }
.bar button { font: inherit; padding: 8px 18px; border: 0; border-radius: 6px; background: #2b62e3; color: #fff; cursor: pointer; }
@media print { body { background: #fff; } .sheet { margin: 0; } .bar { display: none; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">Drucken / als PDF speichern</button></div>
<div class="sheet">
  <div class="brand">${esc(site.title || 'Ferienwohnung')}</div>
  <div class="kicker">Gutschein</div>
  <div class="big">${esc(big)}</div>
  <div class="sub">${esc(sub)}</div>
  ${view.guestName ? `<div class="for">für ${esc(view.guestName)}</div>` : ''}
  ${v.dedication ? `<div class="ded">${esc(v.dedication)}</div>` : ''}
  <div class="foot">
    <div>Gutscheincode<br><span class="code">${esc(v.code)}</span></div>
    <div style="text-align:right">
      ${v.valid_until ? `Einlösbar bis ${esc(formatDE(v.valid_until))}<br>` : ''}
      ${v.min_nights ? `ab ${esc(v.min_nights)} Nächten Aufenthalt<br>` : ''}
      ${url ? `Einlösen bei der Buchung auf ${esc(url)}` : 'Einlösen bei direkter Buchung'}
    </div>
  </div>
</div>
<script>setTimeout(function () { window.print(); }, 600);</script>
</body></html>`);
    });

    app.post('/api/vouchers', limiter, (req, res) => {
        const c = clean(req.body);
        if (c.error) return res.status(400).json({ success: false, error: c.error });
        const code = c.code || newCode();
        const ins = sql().prepare(`INSERT INTO vouchers (code, kind, value, guest_id, guest_name, valid_from, valid_until, min_nights, note, dedication, created_by)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(code, c.kind, c.value, c.guestId, c.guestName, c.validFrom, c.validUntil, c.minNights, c.note, c.dedication, (req.user && req.user.username) || '');
        res.json({ success: true, voucher: rowView(getById(Number(ins.lastInsertRowid))) });
    });

    app.put('/api/vouchers/:id', limiter, (req, res) => {
        const v = getById(parseInt(req.params.id, 10));
        if (!v) return res.status(404).json({ success: false, error: 'Gutschein nicht gefunden' });
        const c = clean(req.body, v);
        if (c.error) return res.status(400).json({ success: false, error: c.error });
        if (v.status === 'redeemed' && (c.kind !== v.kind || c.value !== v.value)) {
            return res.status(400).json({ success: false, error: 'Ein eingelöster Gutschein kann im Wert nicht mehr geändert werden.' });
        }
        sql().prepare(`UPDATE vouchers SET kind = ?, value = ?, guest_id = ?, guest_name = ?, valid_from = ?, valid_until = ?, min_nights = ?,
                       note = ?, dedication = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(c.kind, c.value, c.guestId, c.guestName, c.validFrom, c.validUntil, c.minNights, c.note, c.dedication, v.id);
        res.json({ success: true, voucher: rowView(getById(v.id)) });
    });

    // action: cancel (entwerten) | activate (wieder aktivieren, also undoes a redemption) | redeem (by hand)
    app.post('/api/vouchers/:id/status', limiter, (req, res) => {
        const v = getById(parseInt(req.params.id, 10));
        if (!v) return res.status(404).json({ success: false, error: 'Gutschein nicht gefunden' });
        const action = String((req.body && req.body.action) || '');
        if (action === 'cancel') {
            if (v.status === 'redeemed') return res.status(400).json({ success: false, error: 'Bereits eingelöst. Zuerst „Wieder aktivieren“.' });
            sql().prepare(`UPDATE vouchers SET status = 'cancelled', request_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(v.id);
        } else if (action === 'activate') {
            sql().prepare(`UPDATE vouchers SET status = 'active', request_id = NULL, booking_id = NULL, invoice_id = NULL, redeemed_at = NULL,
                           redeemed_checkin = NULL, redeemed_checkout = NULL, redeemed_value = NULL, redeemed_via = NULL,
                           updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(v.id);
        } else if (action === 'redeem') {
            if (v.status !== 'active') return res.status(400).json({ success: false, error: 'Nur offene Gutscheine können eingelöst werden.' });
            const value = req.body.value != null && req.body.value !== '' ? Number(req.body.value) : null;
            redeem(v.id, { via: 'Von Hand', value: value != null && value >= 0 ? value : null });
        } else {
            return res.status(400).json({ success: false, error: 'Unbekannte Aktion' });
        }
        res.json({ success: true, voucher: rowView(getById(v.id)) });
    });

    app.delete('/api/vouchers/:id', limiter, (req, res) => {
        const v = getById(parseInt(req.params.id, 10));
        if (!v) return res.status(404).json({ success: false, error: 'Gutschein nicht gefunden' });
        if (v.status === 'redeemed' || v.invoice_id) return res.status(400).json({ success: false, error: 'Eingelöste Gutscheine bleiben zur Nachvollziehbarkeit gespeichert. Bitte „Entwerten“ oder „Wieder aktivieren“ nutzen.' });
        sql().prepare('DELETE FROM vouchers WHERE id = ?').run(v.id);
        res.json({ success: true });
    });
}

module.exports = {
    ensureSchema, normCode, newCode, valueLabel, displayStatus, rowView, getByCode, getById, discountFor, check,
    reserveForRequest, releaseRequest, releaseBooking, redeem, forStay, invoiceLineForStay, guestText,
    registerAdminRoutes, formatDE, money
};
