/**
 * Jahresrückblick (year in review) for the admin dashboard
 *
 *  build(year)       - key figures of one year plus the previous year for comparison: stays, nights,
 *                      occupancy, revenue, expenses, channels, months, returning guests, guest origins
 *  geocode(year)     - coordinates for the guest origins of that year (map). Uses OpenStreetMap Nominatim
 *                      with only "postcode city, country" (never names), max. 1 request per second, cached
 *                      forever in table geo_cache. Countries without a known town use a built-in centre point.
 *
 * Stays are counted by arrival year. Occupied nights are clipped to the year and merged (overlapping
 * bookings and invoices for the same stay count once). Revenue follows the dashboard: invoices by invoice
 * date whose guest still exists.
 */

// ISO code, German name, other spellings (lower case), centre point for the map
const COUNTRIES = [
    ['DE', 'Deutschland', ['germany', 'de', 'd', 'brd', 'deutschland'], 51.2, 10.4],
    ['AT', 'Österreich', ['austria', 'österreich', 'oesterreich', 'a', 'at'], 47.6, 14.1],
    ['CH', 'Schweiz', ['switzerland', 'schweiz', 'suisse', 'svizzera', 'ch'], 46.8, 8.2],
    ['NL', 'Niederlande', ['netherlands', 'niederlande', 'nederland', 'holland', 'nl'], 52.2, 5.5],
    ['BE', 'Belgien', ['belgium', 'belgien', 'belgique', 'belgië', 'be', 'b'], 50.6, 4.6],
    ['LU', 'Luxemburg', ['luxembourg', 'luxemburg', 'lu', 'l'], 49.8, 6.1],
    ['FR', 'Frankreich', ['france', 'frankreich', 'fr', 'f'], 46.6, 2.4],
    ['IT', 'Italien', ['italy', 'italien', 'italia', 'it', 'i'], 42.8, 12.5],
    ['ES', 'Spanien', ['spain', 'spanien', 'españa', 'espana', 'es', 'e'], 40.2, -3.6],
    ['PT', 'Portugal', ['portugal', 'pt', 'p'], 39.6, -8.0],
    ['DK', 'Dänemark', ['denmark', 'dänemark', 'daenemark', 'danmark', 'dk'], 56.0, 9.5],
    ['SE', 'Schweden', ['sweden', 'schweden', 'sverige', 'se', 's'], 62.0, 15.0],
    ['NO', 'Norwegen', ['norway', 'norwegen', 'norge', 'no', 'n'], 61.0, 9.0],
    ['FI', 'Finnland', ['finland', 'finnland', 'suomi', 'fi', 'fin'], 62.5, 26.0],
    ['PL', 'Polen', ['poland', 'polen', 'polska', 'pl'], 52.1, 19.4],
    ['CZ', 'Tschechien', ['czech republic', 'czechia', 'tschechien', 'česko', 'cesko', 'cz'], 49.8, 15.5],
    ['SK', 'Slowakei', ['slovakia', 'slowakei', 'slovensko', 'sk'], 48.7, 19.7],
    ['HU', 'Ungarn', ['hungary', 'ungarn', 'magyarország', 'hu', 'h'], 47.2, 19.4],
    ['SI', 'Slowenien', ['slovenia', 'slowenien', 'slovenija', 'si'], 46.1, 14.8],
    ['HR', 'Kroatien', ['croatia', 'kroatien', 'hrvatska', 'hr'], 45.1, 15.6],
    ['RO', 'Rumänien', ['romania', 'rumänien', 'rumaenien', 'românia', 'ro'], 45.9, 24.9],
    ['BG', 'Bulgarien', ['bulgaria', 'bulgarien', 'bg'], 42.7, 25.3],
    ['GR', 'Griechenland', ['greece', 'griechenland', 'gr'], 39.1, 22.0],
    ['GB', 'Großbritannien', ['united kingdom', 'uk', 'great britain', 'england', 'scotland', 'wales', 'großbritannien', 'grossbritannien', 'vereinigtes königreich', 'gb'], 53.0, -1.8],
    ['IE', 'Irland', ['ireland', 'irland', 'éire', 'ie'], 53.2, -8.0],
    ['IS', 'Island', ['iceland', 'island', 'ísland', 'is'], 64.9, -18.6],
    ['EE', 'Estland', ['estonia', 'estland', 'eesti', 'ee'], 58.6, 25.0],
    ['LV', 'Lettland', ['latvia', 'lettland', 'latvija', 'lv'], 56.9, 24.6],
    ['LT', 'Litauen', ['lithuania', 'litauen', 'lietuva', 'lt'], 55.2, 23.9],
    ['UA', 'Ukraine', ['ukraine', 'ukrajina', 'ua'], 49.0, 31.4],
    ['TR', 'Türkei', ['turkey', 'türkei', 'tuerkei', 'türkiye', 'tr'], 39.0, 35.2],
    ['US', 'USA', ['usa', 'united states', 'united states of america', 'vereinigte staaten', 'us'], 39.8, -98.6],
    ['CA', 'Kanada', ['canada', 'kanada', 'ca'], 56.1, -106.3],
    ['AU', 'Australien', ['australia', 'australien', 'au'], -25.3, 133.8],
    ['NZ', 'Neuseeland', ['new zealand', 'neuseeland', 'nz'], -41.5, 172.8],
    ['CN', 'China', ['china', 'cn'], 35.9, 104.2],
    ['JP', 'Japan', ['japan', 'jp'], 36.2, 138.3],
    ['IN', 'Indien', ['india', 'indien', 'in'], 22.0, 79.0],
    ['IL', 'Israel', ['israel', 'il'], 31.0, 34.9],
    ['BR', 'Brasilien', ['brazil', 'brasilien', 'brasil', 'br'], -14.2, -51.9],
    ['ZA', 'Südafrika', ['south africa', 'südafrika', 'suedafrika', 'za'], -30.6, 22.9]
];
const BY_CODE = new Map(COUNTRIES.map(c => [c[0], { code: c[0], name: c[1], lat: c[3], lon: c[4] }]));
const BY_ALIAS = new Map();
COUNTRIES.forEach(c => c[2].concat(c[1].toLowerCase()).forEach(a => BY_ALIAS.set(a, c[0])));

const countryCode = text => BY_ALIAS.get(String(text || '').trim().toLowerCase().replace(/[.]/g, '')) || null;
const flagOf = code => code && /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65)) : '';

/**
 * Origin from a free-text address ("Street\n12345 City\nCountry", also "A-1010 Wien", "8001 Zürich").
 * Returns { zip, city, cc } (each may be null) or null when nothing usable is in it.
 */
function parseOrigin(address) {
    const lines = String(address || '').split(/\r?\n|,\s*(?=\S)/).map(l => l.trim())
        .filter(l => l && !/^(z\.\s*hd|ust-?id|c\/o)/i.test(l));
    if (!lines.length) return null;
    let zip = null, city = null, cc = null, zipIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/^(?:([A-Z]{1,3})\s*-\s*)?(\d{4,5})(?:\s?[A-Z]{2}(?=\s))?\s+(.{2,})$/); // also Dutch \"1012 AB\"
        if (m) {
            zip = m[2]; city = m[3].replace(/\s+/g, ' ').trim(); zipIdx = i;
            if (m[1]) cc = countryCode(m[1]);
            break;
        }
    }
    // Country: a line after the postcode line, else the last line if it is a known country name
    const tail = zipIdx >= 0 ? lines.slice(zipIdx + 1) : lines.slice(-1);
    for (const l of tail) { const c = countryCode(l); if (c) { cc = c; break; } }
    if (!cc && zip && zip.length === 5 && zipIdx === lines.length - 1) cc = 'DE'; // German address without country line
    if (!zip && !cc) return null;
    return { zip, city, cc };
}

function createYearReview({ db, axios }) {
    const sql = () => db.getDb();
    const isPlaceholder = name => {
        const n = String(name || '').trim();
        return !n || /^gast$/i.test(n) || /^(booking|airbnb) \d{2}\.\d{2}\.$/i.test(n) || /not available|closed|reserved/i.test(n);
    };

    sql().exec(`
        CREATE TABLE IF NOT EXISTS geo_cache (
            query TEXT PRIMARY KEY,
            lat REAL,
            lon REAL,
            cc TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const ymdAdd = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
    const daysIn = year => (new Date(Date.UTC(year + 1, 0, 1)) - new Date(Date.UTC(year, 0, 1))) / 86400000;
    const nightsBetween = (a, b) => Math.max(0, Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000));
    const SOURCES = { 'Booking.com': 'Booking.com', Airbnb: 'Airbnb', Direkt: 'Direkt (Webseite)', manual: 'Manuell' };

    function years() {
        const rows = sql().prepare(`
            SELECT substr(checkin, 1, 4) AS y FROM bookings WHERE checkin IS NOT NULL
            UNION SELECT substr(COALESCE(arrival, invoice_date), 1, 4) FROM invoices WHERE COALESCE(arrival, invoice_date) IS NOT NULL
            UNION SELECT substr(date, 1, 4) FROM expenses WHERE date IS NOT NULL
        `).all();
        const now = new Date().getFullYear();
        const set = new Set(rows.map(r => parseInt(r.y, 10)).filter(y => y >= 2000 && y <= now + 1));
        set.add(now);
        return [...set].sort((a, b) => b - a);
    }

    /** All stays with arrival in `year`: bookings plus invoices that have no matching booking (older data). */
    function staysOf(year) {
        const from = `${year}-01-01`, to = `${year + 1}-01-01`;
        const bookings = sql().prepare(`
            SELECT b.id, b.checkin, b.checkout, b.source, b.uid, b.guest_id, g.name AS guest_name, g.address AS guest_address
            FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
            WHERE b.checkin >= ? AND b.checkin < ? AND b.checkout > b.checkin
        `).all(from, to);
        const invoices = sql().prepare(`
            SELECT id, guest_id, guest_name, arrival, departure, data FROM invoices
            WHERE arrival >= ? AND arrival < ? AND departure > arrival
        `).all(from, to);

        const invAddress = inv => { try { return (JSON.parse(inv.data) || {}).gAdresse || ''; } catch (e) { return ''; } };
        const stays = bookings.map(b => ({
            checkin: b.checkin, checkout: b.checkout,
            source: b.source || (String(b.uid).startsWith('manual-') ? 'manual' : 'Booking.com'),
            guestId: b.guest_id && !isPlaceholder(b.guest_name) ? b.guest_id : null,
            address: b.guest_address || ''
        }));
        for (const inv of invoices) {
            const same = stays.find(s => s.checkin === inv.arrival && s.checkout === inv.departure);
            if (same) {
                // The invoice usually has the address the calendar feed lacks
                if (!same.address) same.address = invAddress(inv);
                if (!same.guestId && inv.guest_id) same.guestId = inv.guest_id;
                continue;
            }
            stays.push({ checkin: inv.arrival, checkout: inv.departure, source: 'invoice', guestId: inv.guest_id || null, address: invAddress(inv) });
        }
        return stays;
    }

    function summary(year) {
        const from = `${year}-01-01`, to = `${year + 1}-01-01`;
        const stays = staysOf(year);

        // Occupied nights inside the year from bookings and invoices (also stays that began the year before)
        const spans = sql().prepare(`
            SELECT checkin AS a, checkout AS b FROM bookings WHERE checkin < ? AND checkout > ?
            UNION ALL SELECT arrival, departure FROM invoices WHERE arrival < ? AND departure > ?
        `).all(to, from, to, from);
        const booked = new Set();
        for (const s of spans) {
            if (!s.a || !s.b) continue;
            for (let d = s.a < from ? from : s.a, i = 0; d < s.b && d < to && i < 400; d = ymdAdd(d, 1), i++) booked.add(d);
        }
        const months = Array.from({ length: 12 }, () => 0);
        booked.forEach(d => { months[parseInt(d.slice(5, 7), 10) - 1]++; });

        const revenue = sql().prepare(`
            SELECT COALESCE(SUM(total_amount), 0) AS total, COUNT(*) AS n,
                   COALESCE(SUM(CASE WHEN is_paid THEN 0 ELSE total_amount END), 0) AS open
            FROM invoices WHERE invoice_date >= ? AND invoice_date < ? AND guest_id IS NOT NULL
        `).get(from, to);
        const revenueByMonth = Array.from({ length: 12 }, () => 0);
        sql().prepare(`
            SELECT CAST(strftime('%m', invoice_date) AS INTEGER) AS m, SUM(total_amount) AS t
            FROM invoices WHERE invoice_date >= ? AND invoice_date < ? AND guest_id IS NOT NULL GROUP BY m
        `).all(from, to).forEach(r => { if (r.m >= 1 && r.m <= 12) revenueByMonth[r.m - 1] = r.t || 0; });
        const expenses = sql().prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE date >= ? AND date < ?').get(from, to).total;

        const channels = {};
        for (const s of stays) {
            const label = s.source === 'invoice' ? 'Nur Rechnung' : (SOURCES[s.source] || s.source);
            const c = channels[label] || (channels[label] = { label, stays: 0, nights: 0 });
            c.stays++;
            c.nights += nightsBetween(s.checkin, s.checkout);
        }

        const lengths = stays.map(s => nightsBetween(s.checkin, s.checkout));
        const guestIds = [...new Set(stays.map(s => s.guestId).filter(Boolean))];
        const returning = guestIds.filter(id => sql().prepare(`
            SELECT 1 FROM bookings WHERE guest_id = ? AND checkin < ?
            UNION SELECT 1 FROM invoices WHERE guest_id = ? AND arrival < ? LIMIT 1
        `).get(id, from, id, from)).length;

        const nights = booked.size;
        const busiest = months.reduce((best, n, i) => (n > months[best] ? i : best), 0);
        return {
            year,
            stays: stays.length,
            nights,
            days: daysIn(year),
            occupancy: Math.round(nights / daysIn(year) * 1000) / 10,
            avgStay: lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length * 10) / 10 : 0,
            longestStay: lengths.length ? Math.max(...lengths) : 0,
            revenue: Math.round(revenue.total * 100) / 100,
            openRevenue: Math.round(revenue.open * 100) / 100,
            invoices: revenue.n,
            perNight: nights ? Math.round(revenue.total / nights * 100) / 100 : 0,
            expenses: Math.round(expenses * 100) / 100,
            result: Math.round((revenue.total - expenses) * 100) / 100,
            months, revenueByMonth,
            busiestMonth: months[busiest] ? busiest + 1 : null,
            channels: Object.values(channels).sort((a, b) => b.nights - a.nights),
            guests: guestIds.length,
            returning,
            _stays: stays
        };
    }

    /** Guest origins of a year, grouped by place. coords from the cache only (see geocode). */
    function origins(stays) {
        const places = new Map();
        let unknown = 0;
        for (const s of stays) {
            const o = parseOrigin(s.address);
            if (!o) { unknown++; continue; }
            const key = `${o.cc || ''}|${o.zip || ''}|${(o.city || '').toLowerCase()}`;
            const p = places.get(key) || { key, zip: o.zip, city: o.city, cc: o.cc, stays: 0 };
            p.stays++;
            places.set(key, p);
        }
        const list = [...places.values()].map(p => {
            const hit = cached(p);
            if (hit && hit.cc && !p.cc) p.cc = hit.cc;
            const c = BY_CODE.get(p.cc);
            return {
                zip: p.zip, city: p.city, cc: p.cc, country: c ? c.name : (p.cc || ''), flag: flagOf(p.cc), stays: p.stays,
                lat: hit && hit.lat != null ? hit.lat : (!p.city && c ? c.lat : null),
                lon: hit && hit.lon != null ? hit.lon : (!p.city && c ? c.lon : null),
                pending: !!p.city && !hit
            };
        }).sort((a, b) => b.stays - a.stays);

        const countries = {};
        list.forEach(p => {
            const k = p.cc || '?';
            const c = countries[k] || (countries[k] = { cc: p.cc, name: p.country || 'Unbekannt', flag: p.flag, stays: 0 });
            c.stays += p.stays;
        });
        return {
            places: list,
            countries: Object.values(countries).sort((a, b) => b.stays - a.stays),
            unknown,
            known: stays.length - unknown,
            pending: list.filter(p => p.pending).length
        };
    }

    const geoQuery = p => `${p.cc || ''}|${p.zip || ''}|${String(p.city || '').toLowerCase()}`;
    function cached(p) {
        if (!p.city) return null;
        return sql().prepare('SELECT lat, lon, cc FROM geo_cache WHERE query = ?').get(geoQuery(p)) || null;
    }

    function build(year) {
        const cur = summary(year);
        const prev = summary(year - 1);
        const stays = cur._stays;
        delete cur._stays;
        delete prev._stays;
        const hasPrev = prev.stays > 0 || prev.revenue > 0 || prev.nights > 0;
        return {
            year, years: years(), today: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date()),
            ...cur,
            previous: hasPrev ? {
                stays: prev.stays, nights: prev.nights, occupancy: prev.occupancy, revenue: prev.revenue,
                perNight: prev.perNight, avgStay: prev.avgStay, expenses: prev.expenses, result: prev.result, months: prev.months
            } : null,
            origins: origins(stays)
        };
    }

    let geocodeBusy = false;
    let lastRequest = 0;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /**
     * Looks up coordinates of not yet known places of `year` (at most `max` per call, 1 per second).
     * Places that cannot be found are cached without coordinates, so they are not asked again.
     */
    async function geocode(year, max = 8) {
        if (geocodeBusy) return { busy: true, looked: 0 };
        geocodeBusy = true;
        let looked = 0;
        try {
            const stays = staysOf(year);
            const todo = [];
            const seen = new Set();
            for (const s of stays) {
                const o = parseOrigin(s.address);
                if (!o || !o.city) continue;
                const q = geoQuery(o);
                if (seen.has(q) || cached(o)) continue;
                seen.add(q);
                todo.push(o);
            }
            for (const o of todo.slice(0, max)) {
                const wait = 1100 - (Date.now() - lastRequest);
                if (wait > 0) await sleep(wait);
                lastRequest = Date.now();
                let hit = null;
                try {
                    const params = { format: 'jsonv2', limit: 1, addressdetails: 1, 'accept-language': 'de' };
                    if (o.zip) params.postalcode = o.zip;
                    params.city = o.city;
                    if (o.cc) params.countrycodes = o.cc.toLowerCase();
                    let res = await axios.get('https://nominatim.openstreetmap.org/search', {
                        params, timeout: 10000, headers: { 'User-Agent': 'RentalInvoice/1.0 (Ferienwohnung, Jahresrückblick)' }
                    });
                    // Postcode and town sometimes do not match exactly -> try the town alone
                    if (!(Array.isArray(res.data) && res.data[0]) && o.zip) {
                        delete params.postalcode;
                        await sleep(1100);
                        lastRequest = Date.now();
                        res = await axios.get('https://nominatim.openstreetmap.org/search', {
                            params, timeout: 10000, headers: { 'User-Agent': 'RentalInvoice/1.0 (Ferienwohnung, Jahresrückblick)' }
                        });
                    }
                    const r = Array.isArray(res.data) && res.data[0];
                    if (r) {
                        hit = {
                            lat: Math.round(parseFloat(r.lat) * 1000) / 1000,
                            lon: Math.round(parseFloat(r.lon) * 1000) / 1000,
                            cc: r.address && r.address.country_code ? String(r.address.country_code).toUpperCase() : o.cc
                        };
                    }
                } catch (e) {
                    console.warn('⚠️ Jahresrückblick: Ort nicht gefunden (Netzwerk):', e.message);
                    break; // network trouble -> try again on the next call, do not cache
                }
                sql().prepare('INSERT OR REPLACE INTO geo_cache (query, lat, lon, cc) VALUES (?, ?, ?, ?)')
                    .run(geoQuery(o), hit ? hit.lat : null, hit ? hit.lon : null, hit ? hit.cc : o.cc);
                looked++;
            }
            return { looked, remaining: Math.max(0, todo.length - looked) };
        } finally {
            geocodeBusy = false;
        }
    }

    /** Short text for Telegram (/jahr). */
    function text(year) {
        const r = build(year);
        const money = n => Number(n).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
        const diff = (cur, prev, unit = '') => {
            if (prev == null || !prev) return '';
            const pct = Math.round((cur - prev) / prev * 100);
            return ` (${pct >= 0 ? '+' : ''}${pct} %${unit} ggü. Vorjahr)`;
        };
        const p = r.previous || {};
        const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
        let t = `<b>📊 Jahresrückblick ${year}</b>\n\n` +
            `🛏 ${r.stays} Aufenthalte · ${r.nights} Nächte belegt${diff(r.nights, p.nights)}\n` +
            `📅 Auslastung ${String(r.occupancy).replace('.', ',')} %${r.busiestMonth ? ` · stärkster Monat ${MONTHS[r.busiestMonth - 1]}` : ''}\n` +
            `⏱ Ø ${String(r.avgStay).replace('.', ',')} Nächte pro Aufenthalt\n` +
            `💶 Umsatz ${money(r.revenue)}${diff(r.revenue, p.revenue)}\n` +
            (r.perNight ? `   pro belegter Nacht ${money(r.perNight)}\n` : '') +
            `🧾 Ausgaben ${money(r.expenses)} · Ergebnis ${money(r.result)}\n`;
        if (r.channels.length) t += `\n<b>Kanäle</b>\n` + r.channels.map(c => `• ${c.label}: ${c.stays}× (${c.nights} Nächte)`).join('\n') + '\n';
        if (r.guests) t += `\n👥 ${r.guests} Gäste mit Namen, davon ${r.returning} ${r.returning === 1 ? 'Stammgast' : 'Stammgäste'}\n`;
        if (r.origins.countries.length) {
            t += `\n<b>Herkunft</b>\n` + r.origins.countries.slice(0, 6).map(c => `${c.flag || '🏳️'} ${c.name}: ${c.stays}`).join('\n');
            if (r.origins.unknown) t += `\n❔ ohne Adresse: ${r.origins.unknown}`;
            t += '\n';
        }
        return t + '\nDie Karte mit allen Herkunftsorten steht im Admin unter Dashboard → Jahresrückblick.';
    }

    return { build, geocode, text, years };
}

module.exports = createYearReview;
module.exports.parseOrigin = parseOrigin;
module.exports.flagOf = flagOf;
