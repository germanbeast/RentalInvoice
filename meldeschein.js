/**
 * Online-Meldeschein (guest registration, §§ 29–30 Bundesmeldegesetz)
 *
 * Guests fill in the registration form on "Meine Buchung" before arrival: name, birth date, nationality,
 * address, ID document number (foreign guests) and every further person staying (first name, last name, birth date).
 * No signature (host decision 2026-10-31): the guest confirms with a checkbox.
 *  - one form per booking (table guest_registrations), the guest can change it until the arrival day
 *  - the host gets a Telegram message, sees all forms in the admin (Anfragen → Meldescheine),
 *    prints them (single or a whole month/year) and exports them as CSV
 *  - retention: the law asks to keep forms for one year after departure and to destroy them within
 *    three months after that. Forms are deleted automatically 13 months after departure.
 *  - setting site.meldeschein: 'all' (default) | 'off'
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COMPANIONS = 12;
const GERMAN = /^(deutsch(land)?|germany|german|de|d|brd)$/i;

function createMeldeschein({ rateLimit, express, db, botLogic, notify, getSite, guestBooking, berlinToday, nightsBetween, formatDateDE }) {
    const sql = () => db.getDb();

    sql().exec(`
        CREATE TABLE IF NOT EXISTS guest_registrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_id INTEGER UNIQUE,
            guest_code TEXT,
            checkin TEXT,
            checkout TEXT,
            last_name TEXT,
            first_name TEXT,
            data TEXT NOT NULL,
            signature TEXT,
            ip TEXT,
            submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    const enabled = () => getSite().meldeschein !== 'off';
    const isGerman = n => GERMAN.test(String(n || '').trim());

    function cleanup() {
        try {
            const r = sql().prepare("DELETE FROM guest_registrations WHERE checkout < date(?, '-13 months')").run(berlinToday());
            if (r.changes) console.log(`🗑️ ${r.changes} Meldeschein(e) nach Ablauf der Aufbewahrungsfrist gelöscht`);
        } catch (e) { console.error('Meldeschein Aufräumen Fehler:', e.message); }
    }
    cleanup();
    setInterval(cleanup, 24 * 60 * 60 * 1000).unref();

    function rowToForm(r, withSignature = true) {
        const d = JSON.parse(r.data || '{}');
        return {
            id: r.id, bookingId: r.booking_id, code: r.guest_code, checkin: r.checkin, checkout: r.checkout,
            ...d, signature: withSignature ? r.signature : undefined,
            submittedAt: r.submitted_at, updatedAt: r.updated_at
        };
    }

    // Editable until the arrival day (the form is part of the check-in)
    const editable = b => b.checkin >= berlinToday();

    // -----------------------------------------------------------------------
    // Guest API (/gast/api/me/meldeschein)
    // -----------------------------------------------------------------------
    const router = express.Router();
    const saveLimiter = rateLimit({
        windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
        message: { success: false, error: 'Zu viele Versuche. Bitte versuchen Sie es später erneut.' }
    });

    router.get('/api/me/meldeschein', (req, res) => {
        res.set('Cache-Control', 'no-store');
        const b = guestBooking(req.session && req.session.guest);
        if (!b) return res.status(401).json({ success: false, error: 'Bitte erneut anmelden.' });
        if (!enabled()) return res.json({ success: true, enabled: false });
        const r = sql().prepare('SELECT * FROM guest_registrations WHERE booking_id = ?').get(b.id);
        let prefill = null;
        if (!r && b.guest_id) {
            const g = db.getGuestById(b.guest_id);
            if (g && !botLogic.isPlaceholderGuestName(g.name)) {
                const parts = g.name.trim().split(/\s+/);
                prefill = { lastName: parts.length > 1 ? parts.pop() : '', firstName: parts.join(' ') };
            }
        }
        const req2 = sql().prepare('SELECT adults, children FROM booking_requests WHERE booking_id = ?').get(b.id);
        res.json({
            success: true, enabled: true, booked: req2 ? (req2.adults || 1) + (req2.children || 0) : null,
            maxPersons: Math.min(13, Number(getSite().max_guests) || 13), checkin: b.checkin, checkout: b.checkout, nights: nightsBetween(b.checkin, b.checkout),
            form: r ? rowToForm(r) : null, prefill, editable: editable(b), past: b.checkout < berlinToday()
        });
    });

    router.post('/api/me/meldeschein', saveLimiter, async (req, res) => {
        try {
            const b = guestBooking(req.session && req.session.guest);
            if (!b) return res.status(401).json({ success: false, error: 'Bitte erneut anmelden.' });
            if (!enabled()) return res.status(403).json({ success: false, error: 'Der Meldeschein ist gerade nicht verfügbar.' });
            const existing = sql().prepare('SELECT id FROM guest_registrations WHERE booking_id = ?').get(b.id);
            if (existing && !editable(b)) {
                return res.status(409).json({ success: false, error: 'Ab dem Anreisetag ändern wir den Meldeschein gerne für Sie. Bitte melden Sie sich kurz bei uns.' });
            }

            const body = req.body || {};
            const str = (v, max) => String(v == null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().substring(0, max);
            const today = berlinToday();
            const validBirth = v => YMD.test(v) && v >= '1900-01-01' && v <= today;
            const fail = msg => res.status(400).json({ success: false, error: msg });

            const f = {
                lastName: str(body.lastName, 80), firstName: str(body.firstName, 80), birthDate: str(body.birthDate, 10),
                birthPlace: str(body.birthPlace, 80),
                nationality: str(body.nationality, 60), street: str(body.street, 120), zip: str(body.zip, 12),
                city: str(body.city, 80), country: str(body.country, 60) || 'Deutschland',
                idType: ['Reisepass', 'Personalausweis', 'Passersatz'].includes(body.idType) ? body.idType : '',
                idNumber: str(body.idNumber, 30).toUpperCase(),
                email: str(body.email, 120), phone: str(body.phone, 40)
            };
            if (f.lastName.length < 2) return fail('Bitte den Familiennamen angeben.');
            if (f.firstName.length < 1) return fail('Bitte den Vornamen angeben.');
            if (!validBirth(f.birthDate)) return fail('Bitte ein gültiges Geburtsdatum angeben.');
            if (f.nationality.length < 2) return fail('Bitte die Staatsangehörigkeit angeben.');
            if (f.street.length < 3) return fail('Bitte Straße und Hausnummer angeben.');
            if (f.zip.length < 3) return fail('Bitte die Postleitzahl angeben.');
            if (f.city.length < 2) return fail('Bitte den Wohnort angeben.');
            if (!isGerman(f.nationality) && !/^[A-Z0-9 -]{5,30}$/.test(f.idNumber)) {
                return fail('Gäste mit ausländischer Staatsangehörigkeit geben bitte die Nummer ihres Reisepasses oder Ausweises an.');
            }
            if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return fail('Bitte eine gültige E-Mail-Adresse angeben.');

            // Every person staying is registered: the main guest in full, everyone else with name and birth date
            const persons = parseInt(body.persons, 10);
            if (!Number.isInteger(persons) || persons < 1 || persons > MAX_COMPANIONS + 1) return fail('Bitte angeben, wie viele Personen übernachten.');
            const companions = (Array.isArray(body.companions) ? body.companions : []).slice(0, MAX_COMPANIONS).map(c => ({
                lastName: str(c && c.lastName, 80), firstName: str(c && c.firstName, 80), birthDate: str(c && c.birthDate, 10)
            }));
            if (companions.length !== persons - 1) return fail('Bitte für jede weitere Person Vorname, Familienname und Geburtsdatum angeben.');
            for (const [i, c] of companions.entries()) {
                if (!c.firstName || c.lastName.length < 2) return fail(`Bitte Vor- und Familiennamen von Person ${i + 2} angeben.`);
                if (!validBirth(c.birthDate)) return fail(`Bitte das Geburtsdatum von ${c.firstName || `Person ${i + 2}`} angeben.`);
            }
            const signature = null;
            if (body.confirm !== true) return fail('Bitte bestätigen Sie, dass Ihre Angaben stimmen.');

            const data = { ...f, companions, confirmedAt: new Date().toISOString() };
            const ip = String(req.ip || '').substring(0, 60);
            if (existing) {
                sql().prepare(`UPDATE guest_registrations SET checkin = ?, checkout = ?, guest_code = ?, last_name = ?, first_name = ?, data = ?, signature = ?, ip = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                    .run(b.checkin, b.checkout, b.guest_code, f.lastName, f.firstName, JSON.stringify(data), signature, ip, existing.id);
            } else {
                sql().prepare(`INSERT INTO guest_registrations (booking_id, guest_code, checkin, checkout, last_name, first_name, data, signature, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(b.id, b.guest_code, b.checkin, b.checkout, f.lastName, f.firstName, JSON.stringify(data), signature, ip);
            }

            // The booking portals send no names: the registration fills the gap
            const fullName = `${f.firstName} ${f.lastName}`;
            const g = b.guest_id ? db.getGuestById(b.guest_id) : null;
            if (!g || botLogic.isPlaceholderGuestName(g.name)) await botLogic.applyGuestName(b.id, fullName);
            const guestId = sql().prepare('SELECT guest_id FROM bookings WHERE id = ?').get(b.id).guest_id;
            if (guestId) {
                const gg = db.getGuestById(guestId);
                const address = [f.street, `${f.zip} ${f.city}`, isGerman(f.country) ? '' : f.country].filter(Boolean).join('\n');
                if (gg) db.updateGuest(gg.id, { ...gg, address: gg.address || address, email: gg.email || f.email, phone: gg.phone || f.phone });
            }

            const people = 1 + companions.length;
            notify(`📝 *Meldeschein ${existing ? 'geändert' : 'eingegangen'}*\n${fullName} · ${f.nationality}\n📅 ${formatDateDE(b.checkin)} – ${formatDateDE(b.checkout)} · ${people} ${people === 1 ? 'Person' : 'Personen'}\nIm Admin unter Anfragen → Meldescheine.`, 'site_details')
                .catch(() => { });
            res.json({ success: true });
        } catch (e) {
            console.error('Meldeschein speichern Fehler:', e.message);
            res.status(500).json({ success: false, error: 'Speichern fehlgeschlagen. Bitte später erneut versuchen.' });
        }
    });

    // -----------------------------------------------------------------------
    // Admin (behind the login)
    // -----------------------------------------------------------------------
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const de = ymd => (YMD.test(String(ymd || '')) ? formatDateDE(ymd) : '');
    const stamp = ts => ts ? new Date(String(ts).replace(' ', 'T') + (String(ts).includes('Z') ? '' : 'Z'))
        .toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' }) : '';

    function rowsFor(q) {
        const year = /^\d{4}$/.test(String(q.year || '')) ? String(q.year) : '';
        const month = /^\d{2}$/.test(String(q.month || '')) ? String(q.month) : '';
        const prefix = year ? (month ? `${year}-${month}` : year) : '';
        return sql().prepare(`SELECT * FROM guest_registrations WHERE (? = '' OR checkin LIKE ? || '%') ORDER BY checkin DESC, id DESC`)
            .all(prefix, prefix);
    }

    function host() {
        const v = db.getSetting('vermieter') || {};
        const site = getSite();
        return { name: v.name || site.title || 'Ferienwohnung', address: site.address || v.adresse || '', title: site.title || '' };
    }

    function formHtml(f, h) {
        const comp = f.companions || [];
        const row = (label, value) => `<tr><th>${label}</th><td>${esc(value) || '&nbsp;'}</td></tr>`;
        return `<section class="ms">
  <header><div><p class="k">Meldeschein für Beherbergungsstätten</p><h1>${esc(h.title || h.name)}</h1>
  <p class="h">${esc(h.name)}${h.address ? ` · ${esc(String(h.address).replace(/\n/g, ', '))}` : ''}</p></div>
  <div class="nr">Nr. ${f.id}<br>${esc(f.code || '')}</div></header>
  <table class="grid">
    ${row('Tag der Ankunft', de(f.checkin))}
    ${row('Voraussichtliche Abreise', de(f.checkout))}
    ${row('Familienname', f.lastName)}
    ${row('Vorname(n)', f.firstName)}
    ${row('Geburtsdatum', de(f.birthDate))}
    ${f.birthPlace ? row('Geburtsort', f.birthPlace) : ''}
    ${row('Staatsangehörigkeit(en)', f.nationality)}
    ${row('Anschrift', [f.street, `${f.zip} ${f.city}`, f.country].filter(Boolean).join(', '))}
    ${f.idNumber ? row(`Ausweisdokument`, `${f.idType ? f.idType + ' · ' : ''}${f.idNumber}`) : ''}
    ${f.email || f.phone ? row('Kontakt', [f.email, f.phone].filter(Boolean).join(' · ')) : ''}
    ${row('Personen insgesamt', String(comp.length + 1))}
  </table>
  ${comp.length ? `<h2>Weitere Personen</h2><table class="list"><thead><tr><th>Familienname</th><th>Vorname</th><th>Geburtsdatum</th></tr></thead><tbody>
    ${comp.map(c => `<tr><td>${esc(c.lastName)}</td><td>${esc(c.firstName)}</td><td>${de(c.birthDate)}</td></tr>`).join('')}</tbody></table>` : ''}
  <div class="sig">
  <p class="meta">Vom Gast online ausgefüllt und als richtig bestätigt am ${esc(stamp(f.submittedAt))}${f.updatedAt && f.updatedAt !== f.submittedAt ? `, zuletzt geändert am ${esc(stamp(f.updatedAt))}` : ''}.<br>
  Aufbewahrung ein Jahr ab Abreise (§ 30 Abs. 4 BMG), danach Vernichtung.</p></div>
</section>`;
    }

    function printPage(forms, title, autoPrint) {
        const h = host();
        return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Hanken+Grotesk:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  @page { size: A4 portrait; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f5f0e8; color: #1f1c18; font: 10.5pt/1.45 "Hanken Grotesk", system-ui, sans-serif; }
  .ms { max-width: 182mm; margin: 1.5rem auto; background: #fffdf9; border: 1px solid #d9cfbf; padding: 12mm; break-after: page; }
  .ms:last-of-type { break-after: auto; }
  header { display: flex; justify-content: space-between; gap: 8mm; border-bottom: 1.5px solid #1f1c18; padding-bottom: 4mm; margin-bottom: 5mm; }
  .k { margin: 0 0 1mm; font-size: 8.5pt; letter-spacing: .14em; text-transform: uppercase; color: #8a4b2a; }
  h1 { font: 400 22pt/1.1 "Instrument Serif", Georgia, serif; margin: 0 0 1mm; }
  h2 { font: 400 14pt/1.2 "Instrument Serif", Georgia, serif; margin: 6mm 0 2mm; }
  .h { margin: 0; color: #4d463d; font-size: 9.5pt; }
  .nr { text-align: right; font-size: 9pt; color: #4d463d; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; }
  .grid th { width: 52mm; text-align: left; font-weight: 500; color: #675e52; font-size: 9pt; padding: 2mm 3mm 2mm 0; border-bottom: 1px solid #e6ddcf; vertical-align: top; }
  .grid td { padding: 2mm 0; border-bottom: 1px solid #e6ddcf; font-weight: 500; }
  .list th { text-align: left; font-size: 8.5pt; font-weight: 500; color: #675e52; border-bottom: 1px solid #1f1c18; padding: 1.5mm 2mm 1.5mm 0; }
  .list td { padding: 1.8mm 2mm 1.8mm 0; border-bottom: 1px solid #e6ddcf; }
  .sig { display: flex; justify-content: space-between; align-items: flex-end; gap: 8mm; margin-top: 8mm; }
  .sig p { margin: 0; font-size: 8.5pt; color: #675e52; }
  .tools { text-align: center; margin: 1rem; font-size: 14px; }
  .tools button { font: inherit; padding: .5rem 1.2rem; border: 1px solid #1f1c18; background: #1f1c18; color: #f5f0e8; border-radius: 2px; cursor: pointer; }
  .empty { text-align: center; padding: 3rem 1rem; color: #675e52; }
  @media print { body { background: none; } .ms { margin: 0; border: 0; padding: 0; max-width: none; } .tools { display: none; } }
</style></head><body>
<div class="tools"><button type="button" id="print">Drucken / als PDF speichern</button></div>
${forms.length ? forms.map(f => formHtml(f, h)).join('\n') : '<p class="empty">Für diesen Zeitraum gibt es keine Meldescheine.</p>'}
<script>document.getElementById('print').addEventListener('click', () => print());${autoPrint && forms.length ? 'window.addEventListener("load", () => setTimeout(print, 400));' : ''}</script>
</body></html>`;
    }

    function csvCell(v) {
        const s = String(v == null ? '' : v);
        return /[";\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
    }

    function registerAdminRoutes(app, apiLimiter) {
        app.get('/api/meldescheine', apiLimiter, (req, res) => {
            const forms = rowsFor(req.query).map(r => {
                const f = rowToForm(r, false);
                return {
                    id: f.id, bookingId: f.bookingId, code: f.code, checkin: f.checkin, checkout: f.checkout,
                    name: `${f.firstName} ${f.lastName}`, birthDate: f.birthDate, nationality: f.nationality,
                    city: f.city, country: f.country, companions: (f.companions || []).length,
                    submittedAt: f.submittedAt, updatedAt: f.updatedAt
                };
            });
            // Bookings of the next 30 days (and current stays) still without a form
            const today = berlinToday();
            const missing = enabled() ? sql().prepare(`
                SELECT b.id, b.checkin, b.checkout, b.source, b.summary, b.guest_code, g.name AS guest_name
                FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
                WHERE b.checkout >= ? AND b.checkin <= date(?, '+30 days')
                  AND NOT EXISTS (SELECT 1 FROM guest_registrations r WHERE r.booking_id = b.id)
                ORDER BY b.checkin`).all(today, today).map(b => ({
                id: b.id, checkin: b.checkin, checkout: b.checkout, source: b.source || '', code: b.guest_code,
                name: b.guest_name && !botLogic.isPlaceholderGuestName(b.guest_name) ? b.guest_name : ''
            })) : [];
            const years = sql().prepare("SELECT DISTINCT substr(checkin, 1, 4) AS y FROM guest_registrations ORDER BY y DESC").all().map(r => r.y);
            res.json({ success: true, enabled: enabled(), forms, missing, years });
        });

        app.get('/api/meldescheine/druck', apiLimiter, (req, res) => {
            const forms = rowsFor(req.query).reverse().map(r => rowToForm(r));
            const label = [req.query.month, req.query.year].filter(Boolean).join('/');
            res.set('Cache-Control', 'no-store');
            res.type('html').send(printPage(forms, `Meldescheine ${label}`.trim(), req.query.print === '1'));
        });

        app.get('/api/meldescheine/export.csv', apiLimiter, (req, res) => {
            const rows = rowsFor(req.query).reverse().map(r => rowToForm(r, false));
            const head = ['Nr', 'Buchungscode', 'Anreise', 'Abreise', 'Familienname', 'Vorname', 'Geburtsdatum', 'Geburtsort', 'Staatsangehörigkeit',
                'Straße', 'PLZ', 'Ort', 'Land', 'Ausweisart', 'Ausweisnummer', 'E-Mail', 'Telefon', 'Personen gesamt', 'Weitere Personen', 'Erfasst am'];
            const lines = rows.map(f => [
                f.id, f.code, de(f.checkin), de(f.checkout), f.lastName, f.firstName, de(f.birthDate), f.birthPlace, f.nationality,
                f.street, f.zip, f.city, f.country, f.idType, f.idNumber, f.email, f.phone, (f.companions || []).length + 1,
                (f.companions || []).map(c => `${c.firstName} ${c.lastName}${c.birthDate ? ` (${de(c.birthDate)})` : ''}`).join(' | '),
                stamp(f.submittedAt)
            ].map(csvCell).join(';'));
            const name = `Meldescheine${req.query.year ? '-' + String(req.query.year).replace(/\D/g, '') : ''}${req.query.month ? '-' + String(req.query.month).replace(/\D/g, '') : ''}.csv`;
            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', `attachment; filename="${name}"`);
            res.set('Cache-Control', 'no-store');
            res.send('\uFEFF' + [head.join(';'), ...lines].join('\r\n') + '\r\n');
        });

        app.get('/api/meldescheine/:id/druck', apiLimiter, (req, res) => {
            const r = sql().prepare('SELECT * FROM guest_registrations WHERE id = ?').get(parseInt(req.params.id, 10));
            if (!r) return res.status(404).send('Meldeschein nicht gefunden.');
            const f = rowToForm(r);
            res.set('Cache-Control', 'no-store');
            res.type('html').send(printPage([f], `Meldeschein ${f.firstName} ${f.lastName}`, req.query.print === '1'));
        });

        app.delete('/api/meldescheine/:id', apiLimiter, (req, res) => {
            const r = sql().prepare('DELETE FROM guest_registrations WHERE id = ?').run(parseInt(req.params.id, 10));
            res.json({ success: r.changes > 0 });
        });
    }

    return { router, registerAdminRoutes };
}

module.exports = createMeldeschein;
