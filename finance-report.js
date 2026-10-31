/**
 * Finanz-Auswertung for taxes: invoices, positions, VAT, Kurtaxe, expenses and stays of a period,
 * plus bulk exports as Excel (.xlsx) and CSV.
 *
 *  report({ from, to, basis, orphans }) - all figures of the period (from/to inclusive, YYYY-MM-DD)
 *      basis 'invoice' (default): invoices by invoice date; 'payment': paid invoices by payment date (Zufluss, EÜR)
 *      orphans true (default): also invoices whose guest was deleted (they are still income)
 *  workbook(report)       - Buffer of an .xlsx with one sheet per table
 *  csvOf(report, kind)    - CSV text of one table (kind: see TABLES)
 *
 * Amounts are recalculated from the invoice positions like the invoice itself does (positions are net,
 * one VAT rate per invoice, none for Kleinunternehmer). Invoices without positions fall back to the
 * stored total. Kurtaxe is every position whose text says Kurtaxe/Gästebeitrag/Ortstaxe/City Tax.
 */
const { xlsx, csv } = require('./xlsx-writer');

const KURTAXE = /kur\s*-?\s*taxe|kurbeitrag|gästebeitrag|gaestebeitrag|gästetaxe|ortstaxe|tourismusabgabe|tourismusbeitrag|city\s*tax|tourist\s*tax|übernachtungssteuer|beherbergungssteuer|bettensteuer/i;
const CLEANING = /reinigung|cleaning|endreinig|putz/i;
const STAY = /nacht|nächte|übernacht|aufenthalt|miete|logis|unterkunft|ferienwohnung|apartment|wohnung/i;
const category = desc => KURTAXE.test(desc) ? 'Kurtaxe' : CLEANING.test(desc) ? 'Reinigung' : STAY.test(desc) ? 'Übernachtung' : 'Sonstiges';

const SOURCES = { 'Booking.com': 'Booking.com', Airbnb: 'Airbnb', Direkt: 'Direkt (Webseite)', manual: 'Manuell' };
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const nightsBetween = (a, b) => (isYmd(a) && isYmd(b)) ? Math.max(0, Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000)) : null;
const deDate = ymd => isYmd(ymd) ? ymd.split('-').reverse().join('.') : '';

function createFinanceReport({ db }) {
    const sql = () => db.getDb();

    function period(q = {}) {
        const now = new Date().getFullYear();
        let from = isYmd(q.from) ? q.from : `${now}-01-01`;
        let to = isYmd(q.to) ? q.to : `${now}-12-31`;
        if (to < from) [from, to] = [to, from];
        return { from, to, basis: q.basis === 'payment' ? 'payment' : 'invoice', orphans: !(q.orphans === false || q.orphans === '0' || q.orphans === 'false') };
    }

    function monthsOf(from, to) {
        const list = [];
        let y = +from.slice(0, 4), m = +from.slice(5, 7);
        const ey = +to.slice(0, 4), em = +to.slice(5, 7);
        while ((y < ey || (y === ey && m <= em)) && list.length < 240) {
            list.push(`${y}-${String(m).padStart(2, '0')}`);
            if (++m > 12) { m = 1; y++; }
        }
        return list;
    }

    function report(q) {
        const p = period(q);
        const { from, to, basis } = p;
        const dateCol = basis === 'payment' ? 'payment_date' : 'invoice_date';
        const all = sql().prepare(`
            SELECT i.id, i.invoice_number, i.guest_id, i.guest_name, i.invoice_date, i.arrival, i.departure,
                   i.total_amount, i.is_paid, i.payment_method, i.payment_date, i.data, g.id AS guest_exists
            FROM invoices i LEFT JOIN guests g ON g.id = i.guest_id
            WHERE i.${dateCol} >= ? AND i.${dateCol} <= ? ${basis === 'payment' ? 'AND i.is_paid' : ''}
            ORDER BY i.${dateCol}, i.invoice_number
        `).all(from, to);
        const orphanCount = all.filter(i => !i.guest_exists).length;
        const rows = p.orphans ? all : all.filter(i => i.guest_exists);

        // Bookings to find the channel of an invoice (same arrival and departure)
        const bookingAt = sql().prepare('SELECT source, uid FROM bookings WHERE checkin = ? AND checkout = ? LIMIT 1');
        const channelOf = (a, d) => {
            if (!a || !d) return 'Ohne Aufenthalt';
            const b = bookingAt.get(a, d);
            if (!b) return 'Nur Rechnung';
            const src = b.source || (String(b.uid).startsWith('manual-') ? 'manual' : 'Booking.com');
            return SOURCES[src] || src;
        };

        const invoices = [];
        const positions = [];
        const kurtaxe = [];
        for (const inv of rows) {
            let data = {};
            try { data = JSON.parse(inv.data) || {}; } catch (e) { /* broken JSON: use the columns */ }
            const klein = !!data.kleinunternehmer;
            const rate = klein ? 0 : (parseFloat(data.mwstSatz) || 0);
            const pos = Array.isArray(data.positions) ? data.positions : [];
            let netto = 0, kt = 0, cleaning = 0, stay = 0, other = 0;
            pos.forEach((ps, idx) => {
                const qty = parseFloat(ps.qty) || 0, price = parseFloat(ps.price) || 0;
                const sum = r2(qty * price);
                const cat = category(String(ps.desc || ''));
                netto += sum;
                if (cat === 'Kurtaxe') kt += sum; else if (cat === 'Reinigung') cleaning += sum; else if (cat === 'Übernachtung') stay += sum; else other += sum;
                const ust = r2(sum * rate / 100);
                positions.push({
                    number: inv.invoice_number, date: inv.invoice_date, guest: inv.guest_name || data.gName || '',
                    pos: idx + 1, desc: String(ps.desc || ''), category: cat, qty, price, netto: sum, rate, ust, brutto: r2(sum + ust)
                });
                if (cat === 'Kurtaxe') {
                    kurtaxe.push({
                        number: inv.invoice_number, date: inv.invoice_date, guest: inv.guest_name || data.gName || '',
                        arrival: inv.arrival, departure: inv.departure, nights: nightsBetween(inv.arrival, inv.departure),
                        desc: String(ps.desc || ''), qty, price, amount: sum, paid: inv.is_paid ? 'ja' : 'nein'
                    });
                }
            });
            let ust, brutto;
            if (pos.length) {
                netto = r2(netto);
                ust = r2(netto * rate / 100);
                brutto = r2(netto + ust);
            } else {
                brutto = r2(inv.total_amount);
                netto = r2(brutto / (1 + rate / 100));
                ust = r2(brutto - netto);
                stay = netto;
            }
            invoices.push({
                number: inv.invoice_number, date: inv.invoice_date, guest: inv.guest_name || data.gName || '',
                address: String(data.gAdresse || '').replace(/\s*\r?\n\s*/g, ', '),
                arrival: inv.arrival, departure: inv.departure, nights: nightsBetween(inv.arrival, inv.departure),
                channel: channelOf(inv.arrival, inv.departure),
                stay: r2(stay), cleaning: r2(cleaning), kurtaxe: r2(kt), other: r2(other),
                netto, rate, rateLabel: klein ? 'Kleinunternehmer (§ 19 UStG)' : `${String(rate).replace('.', ',')} %`,
                ust, brutto, stored: r2(inv.total_amount),
                paid: inv.is_paid ? 'ja' : 'nein', paymentMethod: inv.payment_method || '', paymentDate: inv.payment_date || '',
                open: inv.is_paid ? 0 : brutto,
                note: [!inv.guest_exists ? 'Gast gelöscht' : '', data.guestInvoice ? 'vom Gast erstellt' : '',
                    Math.abs(r2(inv.total_amount) - brutto) > 0.01 && pos.length ? `gespeicherte Summe ${r2(inv.total_amount).toFixed(2).replace('.', ',')} €` : ''].filter(Boolean).join(', ')
            });
        }

        const expenses = sql().prepare(`
            SELECT date, description, category, source, amount FROM expenses WHERE date >= ? AND date <= ? ORDER BY date, id
        `).all(from, to).map(e => ({
            date: e.date, description: e.description || '', category: e.category || 'Ohne Kategorie',
            source: e.source === 'paperless' ? 'Paperless' : (e.source === 'local' || !e.source ? 'Manuell' : e.source), amount: r2(e.amount)
        }));

        const bookings = sql().prepare(`
            SELECT b.checkin, b.checkout, b.source, b.uid, b.summary, g.name AS guest
            FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
            WHERE b.checkin >= ? AND b.checkin <= ? AND b.checkout > b.checkin ORDER BY b.checkin
        `).all(from, to);
        const invAt = sql().prepare('SELECT invoice_number FROM invoices WHERE arrival = ? AND departure = ? LIMIT 1');
        const stays = bookings.map(b => {
            const src = b.source || (String(b.uid).startsWith('manual-') ? 'manual' : 'Booking.com');
            const inv = invAt.get(b.checkin, b.checkout);
            return {
                checkin: b.checkin, checkout: b.checkout, nights: nightsBetween(b.checkin, b.checkout),
                channel: SOURCES[src] || src, guest: b.guest || b.summary || '', invoice: inv ? inv.invoice_number : '',
                note: inv ? '' : (/airbnb|booking/i.test(src) ? 'Abrechnung über das Portal' : 'ohne Rechnung')
            };
        });

        // Per month
        const months = monthsOf(from, to).map(ym => ({ ym, label: `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`, count: 0, netto: 0, ust: 0, brutto: 0, kurtaxe: 0, paid: 0, open: 0, expenses: 0, nights: 0 }));
        const byYm = new Map(months.map(m => [m.ym, m]));
        invoices.forEach(i => {
            const key = String(basis === 'payment' ? i.paymentDate : i.date).slice(0, 7);
            const m = byYm.get(key);
            if (!m) return;
            m.count++; m.netto += i.netto; m.ust += i.ust; m.brutto += i.brutto; m.kurtaxe += i.kurtaxe;
            if (i.paid === 'ja') m.paid += i.brutto; else m.open += i.brutto;
            m.nights += i.nights || 0;
        });
        expenses.forEach(e => { const m = byYm.get(e.date.slice(0, 7)); if (m) m.expenses += e.amount; });
        months.forEach(m => {
            ['netto', 'ust', 'brutto', 'kurtaxe', 'paid', 'open', 'expenses'].forEach(k => { m[k] = r2(m[k]); });
            m.result = r2(m.brutto - m.expenses);
        });

        // VAT by rate
        const vatMap = new Map();
        invoices.forEach(i => {
            const v = vatMap.get(i.rateLabel) || { label: i.rateLabel, rate: i.rate, count: 0, netto: 0, ust: 0, brutto: 0 };
            v.count++; v.netto += i.netto; v.ust += i.ust; v.brutto += i.brutto;
            vatMap.set(i.rateLabel, v);
        });
        const vat = [...vatMap.values()].map(v => ({ ...v, netto: r2(v.netto), ust: r2(v.ust), brutto: r2(v.brutto) })).sort((a, b) => b.rate - a.rate);

        const catMap = new Map();
        expenses.forEach(e => {
            const c = catMap.get(e.category) || { category: e.category, count: 0, amount: 0 };
            c.count++; c.amount += e.amount;
            catMap.set(e.category, c);
        });
        const expenseCategories = [...catMap.values()].map(c => ({ ...c, amount: r2(c.amount) })).sort((a, b) => b.amount - a.amount);

        const sum = (list, k) => r2(list.reduce((s, x) => s + (Number(x[k]) || 0), 0));
        const totals = {
            invoices: invoices.length, netto: sum(invoices, 'netto'), ust: sum(invoices, 'ust'), brutto: sum(invoices, 'brutto'),
            stay: sum(invoices, 'stay'), cleaning: sum(invoices, 'cleaning'), kurtaxe: sum(invoices, 'kurtaxe'), other: sum(invoices, 'other'),
            paid: sum(invoices.filter(i => i.paid === 'ja'), 'brutto'), open: sum(invoices, 'open'),
            expenses: sum(expenses, 'amount'), expenseCount: expenses.length,
            nights: invoices.reduce((s, i) => s + (i.nights || 0), 0),
            stays: stays.length, staysWithoutInvoice: stays.filter(s => !s.invoice).length
        };
        totals.result = r2(totals.brutto - totals.expenses);
        totals.resultNet = r2(totals.netto - totals.expenses);

        return {
            ...p, label: `${deDate(from)} – ${deDate(to)}`, orphanCount,
            totals, months, vat, invoices, positions, kurtaxe, expenses, expenseCategories, stays
        };
    }

    // ---- Tables for the exports (same columns in Excel and CSV)
    const TABLES = {
        months: {
            name: 'Monate', file: 'Monatsuebersicht',
            columns: [
                { header: 'Monat', key: 'label', type: 'text' },
                { header: 'Rechnungen', key: 'count', type: 'int' },
                { header: 'Netto', key: 'netto', type: 'money' },
                { header: 'USt', key: 'ust', type: 'money' },
                { header: 'Brutto', key: 'brutto', type: 'money' },
                { header: 'davon Kurtaxe (netto)', key: 'kurtaxe', type: 'money' },
                { header: 'Bezahlt', key: 'paid', type: 'money' },
                { header: 'Offen', key: 'open', type: 'money' },
                { header: 'Ausgaben', key: 'expenses', type: 'money' },
                { header: 'Ergebnis (Brutto − Ausgaben)', key: 'result', type: 'money' }
            ],
            rows: r => r.months,
            totals: r => ({ label: 'Summe', count: r.totals.invoices, netto: r.totals.netto, ust: r.totals.ust, brutto: r.totals.brutto, kurtaxe: r.totals.kurtaxe, paid: r.totals.paid, open: r.totals.open, expenses: r.totals.expenses, result: r.totals.result })
        },
        vat: {
            name: 'Umsatzsteuer', file: 'Umsatzsteuer',
            columns: [
                { header: 'Steuersatz', key: 'label', type: 'text' },
                { header: 'Rechnungen', key: 'count', type: 'int' },
                { header: 'Netto', key: 'netto', type: 'money' },
                { header: 'USt', key: 'ust', type: 'money' },
                { header: 'Brutto', key: 'brutto', type: 'money' }
            ],
            rows: r => r.vat,
            totals: r => ({ label: 'Summe', count: r.totals.invoices, netto: r.totals.netto, ust: r.totals.ust, brutto: r.totals.brutto })
        },
        invoices: {
            name: 'Rechnungen', file: 'Rechnungen',
            columns: [
                { header: 'Rechnungs-Nr.', key: 'number', type: 'text' },
                { header: 'Rechnungsdatum', key: 'date', type: 'date' },
                { header: 'Gast', key: 'guest', type: 'text' },
                { header: 'Adresse', key: 'address', type: 'text', width: 40 },
                { header: 'Anreise', key: 'arrival', type: 'date' },
                { header: 'Abreise', key: 'departure', type: 'date' },
                { header: 'Nächte', key: 'nights', type: 'int' },
                { header: 'Kanal', key: 'channel', type: 'text' },
                { header: 'Übernachtung (netto)', key: 'stay', type: 'money' },
                { header: 'Reinigung (netto)', key: 'cleaning', type: 'money' },
                { header: 'Kurtaxe (netto)', key: 'kurtaxe', type: 'money' },
                { header: 'Sonstiges (netto)', key: 'other', type: 'money' },
                { header: 'Netto', key: 'netto', type: 'money' },
                { header: 'USt-Satz', key: 'rateLabel', type: 'text' },
                { header: 'USt', key: 'ust', type: 'money' },
                { header: 'Brutto', key: 'brutto', type: 'money' },
                { header: 'Bezahlt', key: 'paid', type: 'text' },
                { header: 'Zahlungsart', key: 'paymentMethod', type: 'text' },
                { header: 'Zahlungsdatum', key: 'paymentDate', type: 'date' },
                { header: 'Hinweis', key: 'note', type: 'text' }
            ],
            rows: r => r.invoices,
            totals: r => ({ number: 'Summe', nights: r.totals.nights, stay: r.totals.stay, cleaning: r.totals.cleaning, kurtaxe: r.totals.kurtaxe, other: r.totals.other, netto: r.totals.netto, ust: r.totals.ust, brutto: r.totals.brutto })
        },
        positions: {
            name: 'Positionen', file: 'Rechnungspositionen',
            columns: [
                { header: 'Rechnungs-Nr.', key: 'number', type: 'text' },
                { header: 'Rechnungsdatum', key: 'date', type: 'date' },
                { header: 'Gast', key: 'guest', type: 'text' },
                { header: 'Pos.', key: 'pos', type: 'int' },
                { header: 'Beschreibung', key: 'desc', type: 'text', width: 40 },
                { header: 'Art', key: 'category', type: 'text' },
                { header: 'Menge', key: 'qty', type: 'num' },
                { header: 'Einzelpreis', key: 'price', type: 'money' },
                { header: 'Netto', key: 'netto', type: 'money' },
                { header: 'USt-Satz %', key: 'rate', type: 'num' },
                { header: 'USt', key: 'ust', type: 'money' },
                { header: 'Brutto', key: 'brutto', type: 'money' }
            ],
            rows: r => r.positions,
            totals: r => ({ number: 'Summe', netto: r2(r.positions.reduce((s, x) => s + x.netto, 0)), ust: r2(r.positions.reduce((s, x) => s + x.ust, 0)), brutto: r2(r.positions.reduce((s, x) => s + x.brutto, 0)) })
        },
        kurtaxe: {
            name: 'Kurtaxe', file: 'Kurtaxe',
            columns: [
                { header: 'Rechnungs-Nr.', key: 'number', type: 'text' },
                { header: 'Rechnungsdatum', key: 'date', type: 'date' },
                { header: 'Gast', key: 'guest', type: 'text' },
                { header: 'Anreise', key: 'arrival', type: 'date' },
                { header: 'Abreise', key: 'departure', type: 'date' },
                { header: 'Nächte', key: 'nights', type: 'int' },
                { header: 'Position', key: 'desc', type: 'text', width: 34 },
                { header: 'Menge', key: 'qty', type: 'num' },
                { header: 'Satz', key: 'price', type: 'money' },
                { header: 'Betrag', key: 'amount', type: 'money' },
                { header: 'Bezahlt', key: 'paid', type: 'text' }
            ],
            rows: r => r.kurtaxe,
            totals: r => ({ number: 'Summe', qty: r2(r.kurtaxe.reduce((s, x) => s + x.qty, 0)), amount: r.totals.kurtaxe })
        },
        expenses: {
            name: 'Ausgaben', file: 'Ausgaben',
            columns: [
                { header: 'Datum', key: 'date', type: 'date' },
                { header: 'Beschreibung', key: 'description', type: 'text', width: 44 },
                { header: 'Kategorie', key: 'category', type: 'text' },
                { header: 'Quelle', key: 'source', type: 'text' },
                { header: 'Betrag', key: 'amount', type: 'money' }
            ],
            rows: r => r.expenses,
            totals: r => ({ date: null, description: 'Summe', amount: r.totals.expenses })
        },
        categories: {
            name: 'Ausgaben nach Kategorie', file: 'Ausgaben-Kategorien',
            columns: [
                { header: 'Kategorie', key: 'category', type: 'text' },
                { header: 'Belege', key: 'count', type: 'int' },
                { header: 'Betrag', key: 'amount', type: 'money' }
            ],
            rows: r => r.expenseCategories,
            totals: r => ({ category: 'Summe', count: r.totals.expenseCount, amount: r.totals.expenses })
        },
        stays: {
            name: 'Belegung', file: 'Belegung',
            columns: [
                { header: 'Anreise', key: 'checkin', type: 'date' },
                { header: 'Abreise', key: 'checkout', type: 'date' },
                { header: 'Nächte', key: 'nights', type: 'int' },
                { header: 'Kanal', key: 'channel', type: 'text' },
                { header: 'Gast', key: 'guest', type: 'text' },
                { header: 'Rechnung', key: 'invoice', type: 'text' },
                { header: 'Hinweis', key: 'note', type: 'text' }
            ],
            rows: r => r.stays,
            totals: r => ({ checkin: 'Summe', nights: r.stays.reduce((s, x) => s + (x.nights || 0), 0) })
        }
    };

    function overviewSheet(r) {
        const t = r.totals;
        const rows = [
            ['Rechnungen', t.invoices, null],
            ['Einnahmen netto', null, t.netto],
            ['Umsatzsteuer', null, t.ust],
            ['Einnahmen brutto', null, t.brutto],
            ['  davon Übernachtung (netto)', null, t.stay],
            ['  davon Reinigung (netto)', null, t.cleaning],
            ['  davon Kurtaxe (netto)', null, t.kurtaxe],
            ['  davon Sonstiges (netto)', null, t.other],
            ['Bezahlt (brutto)', null, t.paid],
            ['Offen (brutto)', null, t.open],
            ['Ausgaben', t.expenseCount, t.expenses],
            ['Ergebnis (Einnahmen brutto − Ausgaben)', null, t.result],
            ['Ergebnis (Einnahmen netto − Ausgaben)', null, t.resultNet],
            ['Abgerechnete Nächte', t.nights, null],
            ['Aufenthalte laut Kalender', t.stays, null],
            ['  davon ohne Rechnung (z. B. Portal-Abrechnung)', t.staysWithoutInvoice, null]
        ].map(([k, n, v]) => ({ k, n, v }));
        const notes = [
            `Zeitraum: ${r.label}`,
            r.basis === 'payment' ? 'Grundlage: bezahlte Rechnungen nach Zahlungsdatum (Zuflussprinzip)' : 'Grundlage: Rechnungen nach Rechnungsdatum',
            r.orphans ? (r.orphanCount ? `Enthält ${r.orphanCount} Rechnung(en) von gelöschten Gästen.` : 'Alle Rechnungen des Zeitraums.') : `Ohne ${r.orphanCount} Rechnung(en) von gelöschten Gästen.`,
            `Erstellt am ${deDate(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date()))}. Bitte vor der Abgabe mit den Belegen abgleichen.`
        ];
        return {
            name: 'Übersicht', title: 'Finanz-Auswertung', notes,
            columns: [{ header: 'Kennzahl', key: 'k', type: 'text', width: 48 }, { header: 'Anzahl', key: 'n', type: 'int', width: 10 }, { header: 'Betrag', key: 'v', type: 'money', width: 16 }],
            rows
        };
    }

    function workbook(r) {
        const sheets = [overviewSheet(r)];
        for (const key of ['months', 'vat', 'invoices', 'positions', 'kurtaxe', 'expenses', 'categories', 'stays']) {
            const t = TABLES[key];
            sheets.push({ name: t.name, columns: t.columns, rows: t.rows(r), totals: t.rows(r).length ? t.totals(r) : null });
        }
        return xlsx(sheets);
    }

    function csvOf(r, kind) {
        const t = TABLES[kind];
        if (!t) return null;
        const rows = t.rows(r);
        return csv(t.columns, rows, rows.length ? t.totals(r) : null);
    }

    const fileBase = r => `${r.from}_bis_${r.to}`;

    return { report, workbook, csvOf, period, fileBase, tables: Object.fromEntries(Object.entries(TABLES).map(([k, t]) => [k, t.file])) };
}

module.exports = createFinanceReport;
module.exports.category = category;
