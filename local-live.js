/**
 * Live-Tipps: Wetter, Veranstaltungen und Öffnungszeiten in der Umgebung
 * für den TV-Welcome-Screen (public/welcome.html) und „Meine Buchung“ (Tab Umgebung).
 *
 * Quellen (alle ohne Schlüssel, bis auf Ticketmaster):
 *  - Wetter: Open-Meteo (api.open-meteo.com), Ort per Open-Meteo-Geocoding
 *  - Öffnungszeiten: Orte trägt der Gastgeber ein oder übernimmt sie aus OpenStreetMap (Overpass-API);
 *    übernommene Orte holen ihre Öffnungszeiten einmal am Tag neu
 *  - Veranstaltungen: eigene Einträge, Kalender-Links (iCal, z. B. vom Stadtmarketing) und optional
 *    Ticketmaster (kostenloser API-Schlüssel)
 *
 * Settings: 'site_live' (Konfiguration, der Ticketmaster-Schlüssel verlässt den Server nie).
 * Öffentlich: GET /api/live?for=tv|app[&from=YYYY-MM-DD&to=YYYY-MM-DD]
 */

const hours = require('./opening-hours');

const UA = 'RentalInvoice/1.0 (Ferienwohnung, Live-Tipps)';
const MAX_PLACES = 24;
const MAX_EVENTS = 40;
const MAX_ICS = 5;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const WEATHER_TTL = 30 * 60 * 1000;
const EVENTS_TTL = 3 * 60 * 60 * 1000;
const HOURS_TTL = 24 * 60 * 60 * 1000;
const EVENT_HORIZON = 60; // days fetched ahead

const DEFAULTS = {
    enabled: false,
    show_tv: true,
    show_app: true,
    place: '',            // shown name, e.g. "Altena"
    lat: null, lon: null,
    weather: true,
    events_days: 14,      // TV / app without stay dates: this many days ahead
    ics_urls: [],
    events: [],           // own entries: [{ title, date, end, time, place, url }]
    ticketmaster_key: '',
    radius_km: 25,
    places: []            // [{ name, kind, distance, hours, url, osm: 'node/123' }]
};

// OSM tag -> German label (also offered in the admin search)
const KINDS = {
    supermarket: 'Supermarkt', bakery: 'Bäckerei', butcher: 'Metzgerei', convenience: 'Kiosk / Laden', kiosk: 'Kiosk',
    beverages: 'Getränkemarkt', chemist: 'Drogerie', pharmacy: 'Apotheke', restaurant: 'Restaurant', cafe: 'Café',
    fast_food: 'Imbiss', ice_cream: 'Eiscafé', pub: 'Kneipe', bar: 'Bar', biergarten: 'Biergarten', fuel: 'Tankstelle',
    museum: 'Museum', zoo: 'Zoo / Tierpark', attraction: 'Sehenswürdigkeit', gallery: 'Galerie',
    swimming_pool: 'Schwimmbad', water_park: 'Freizeitbad', sports_centre: 'Sportzentrum', doctors: 'Arztpraxis'
};

// WMO weather codes (Open-Meteo) -> label + icon key
const WMO = {
    0: ['Klar', 'sun'], 1: ['Überwiegend klar', 'sun'], 2: ['Teils bewölkt', 'partly'], 3: ['Bewölkt', 'cloud'],
    45: ['Nebel', 'fog'], 48: ['Nebel mit Reif', 'fog'],
    51: ['Leichter Nieselregen', 'drizzle'], 53: ['Nieselregen', 'drizzle'], 55: ['Starker Nieselregen', 'drizzle'],
    56: ['Gefrierender Niesel', 'sleet'], 57: ['Gefrierender Niesel', 'sleet'],
    61: ['Leichter Regen', 'rain'], 63: ['Regen', 'rain'], 65: ['Starker Regen', 'rain'],
    66: ['Gefrierender Regen', 'sleet'], 67: ['Gefrierender Regen', 'sleet'],
    71: ['Leichter Schneefall', 'snow'], 73: ['Schneefall', 'snow'], 75: ['Starker Schneefall', 'snow'], 77: ['Schneegriesel', 'snow'],
    80: ['Regenschauer', 'showers'], 81: ['Regenschauer', 'showers'], 82: ['Heftige Schauer', 'showers'],
    85: ['Schneeschauer', 'snow'], 86: ['Schneeschauer', 'snow'],
    95: ['Gewitter', 'storm'], 96: ['Gewitter mit Hagel', 'storm'], 99: ['Gewitter mit Hagel', 'storm']
};
const wmo = (code, isDay = 1) => {
    const [label, icon] = WMO[code] || ['–', 'cloud'];
    return { label, icon: !isDay && (icon === 'sun' || icon === 'partly') ? (icon === 'sun' ? 'moon' : 'partly-night') : icon };
};

function berlinNow() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date()).map(x => [x.type, x.value]));
    return { ymd: `${p.year}-${p.month}-${p.day}`, minutes: (+p.hour) * 60 + (+p.minute) };
}
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const httpUrl = v => { const u = String(v || '').trim(); return /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u.substring(0, 500) : ''; };
const str = (v, max) => String(v == null ? '' : v).trim().substring(0, max);

function distanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371, rad = x => x * Math.PI / 180;
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}
const fmtKm = km => km < 1 ? `${Math.max(50, Math.round(km * 20) * 50)} m` : `${String(Math.round(km * 10) / 10).replace('.', ',')} km`;

function createLocalLive({ db, axios, ical }) {
    const http = axios.create({ timeout: 12000, maxContentLength: 5 * 1024 * 1024, headers: { 'User-Agent': UA } });
    const cache = { weather: null, weatherAt: 0, weatherKey: '', events: null, eventsAt: 0, eventsKey: '', errors: {} };
    let refreshing = { weather: null, events: null };

    function getConfig() {
        const c = db.getAllSettings().site_live;
        return { ...DEFAULTS, ...(c && typeof c === 'object' ? c : {}) };
    }

    /** Admin view: the Ticketmaster key is never sent back, only whether one is stored. */
    function adminConfig() {
        const c = getConfig();
        const { ticketmaster_key, ...rest } = c;
        return { ...rest, has_ticketmaster_key: !!ticketmaster_key, kinds: KINDS };
    }

    function clean(inp, cur) {
        const lat = parseFloat(inp.lat), lon = parseFloat(inp.lon);
        const okCoord = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
        const int = (v, min, max, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
        const events = (Array.isArray(inp.events) ? inp.events : []).map(e => ({
            title: str(e && e.title, 120),
            date: YMD.test(String(e && e.date)) ? e.date : '',
            end: YMD.test(String(e && e.end)) && e.end >= e.date ? e.end : '',
            time: /^\d{1,2}:\d{2}$/.test(String(e && e.time)) ? e.time : '',
            place: str(e && e.place, 120),
            url: httpUrl(e && e.url)
        })).filter(e => e.title && e.date).slice(0, MAX_EVENTS);
        const places = (Array.isArray(inp.places) ? inp.places : []).map(p => ({
            name: str(p && p.name, 100),
            kind: str(p && p.kind, 40),
            distance: str(p && p.distance, 40),
            hours: str(p && p.hours, 300),
            url: httpUrl(p && p.url),
            osm: /^(node|way|relation)\/\d{1,15}$/.test(String(p && p.osm)) ? p.osm : ''
        })).filter(p => p.name).slice(0, MAX_PLACES);
        let key = cur.ticketmaster_key || '';
        if (inp.ticketmaster_key_clear) key = '';
        else if (typeof inp.ticketmaster_key === 'string' && inp.ticketmaster_key.trim()) key = inp.ticketmaster_key.trim().substring(0, 100);
        return {
            enabled: !!inp.enabled, show_tv: inp.show_tv !== false, show_app: inp.show_app !== false,
            weather: inp.weather !== false,
            place: str(inp.place, 100),
            lat: okCoord ? Math.round(lat * 1e5) / 1e5 : null, lon: okCoord ? Math.round(lon * 1e5) / 1e5 : null,
            events_days: int(inp.events_days, 1, 60, 14),
            radius_km: int(inp.radius_km, 1, 100, 25),
            ics_urls: (Array.isArray(inp.ics_urls) ? inp.ics_urls : String(inp.ics_urls || '').split(/\s+/))
                .map(u => httpUrl(String(u).replace(/^webcal:/i, 'https:'))).filter(Boolean).slice(0, MAX_ICS),
            events, places, ticketmaster_key: key,
            hours_checked: cur.hours_checked || 0
        };
    }

    function save(inp) {
        const cur = getConfig();
        const next = clean(inp || {}, cur);
        // New OSM places: fetch their hours on the next round
        const before = new Set(cur.places.map(p => p.osm).filter(Boolean));
        if (next.places.some(p => p.osm && !before.has(p.osm))) next.hours_checked = 0;
        db.setSetting('site_live', next);
        cache.eventsAt = 0; // sources may have changed
        if (cur.lat !== next.lat || cur.lon !== next.lon) cache.weatherAt = 0;
        return next;
    }

    // ------------------------------------------------------------------
    // Weather (Open-Meteo)
    // ------------------------------------------------------------------
    async function fetchWeather(c) {
        const r = await http.get('https://api.open-meteo.com/v1/forecast', {
            params: {
                latitude: c.lat, longitude: c.lon, timezone: 'Europe/Berlin', forecast_days: 5,
                current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day',
                daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset'
            }
        });
        const d = r.data || {};
        const cur = d.current || {};
        const dl = d.daily || {};
        const round = v => (Number.isFinite(v) ? Math.round(v) : null);
        const days = (dl.time || []).map((date, i) => ({
            date,
            ...wmo(dl.weather_code[i], 1),
            max: round(dl.temperature_2m_max[i]), min: round(dl.temperature_2m_min[i]),
            rain: Number.isFinite(dl.precipitation_probability_max && dl.precipitation_probability_max[i]) ? dl.precipitation_probability_max[i] : null,
            sunrise: String((dl.sunrise || [])[i] || '').slice(11, 16), sunset: String((dl.sunset || [])[i] || '').slice(11, 16)
        }));
        if (!Number.isFinite(cur.temperature_2m) || !days.length) throw new Error('Unerwartete Antwort von Open-Meteo');
        return {
            now: { temp: round(cur.temperature_2m), feels: round(cur.apparent_temperature), wind: round(cur.wind_speed_10m), ...wmo(cur.weather_code, cur.is_day) },
            days,
            updated: new Date().toISOString()
        };
    }

    async function weather(c) {
        if (!c.weather || c.lat == null || c.lon == null) return null;
        const key = `${c.lat},${c.lon}`;
        const fresh = cache.weather && cache.weatherKey === key && Date.now() - cache.weatherAt < WEATHER_TTL;
        if (fresh) return cache.weather;
        if (!refreshing.weather) {
            refreshing.weather = fetchWeather(c).then(w => {
                cache.weather = w; cache.weatherAt = Date.now(); cache.weatherKey = key; delete cache.errors.weather;
            }).catch(e => {
                cache.errors.weather = `Wetter: ${e.message}`;
                cache.weatherAt = Date.now() - WEATHER_TTL + 5 * 60 * 1000; // retry in 5 minutes
                console.warn('⚠️ Live-Tipps Wetter:', e.message);
            }).finally(() => { refreshing.weather = null; });
        }
        await refreshing.weather;
        return cache.weatherKey === key ? cache.weather : null;
    }

    // ------------------------------------------------------------------
    // Events (own, iCal, Ticketmaster)
    // ------------------------------------------------------------------
    const berlinYmd = d => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const berlinHm = d => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    const localYmd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    function icsEvent(ev, start, end, src) {
        const allDay = !!(ev.start && ev.start.dateOnly) || ev.datetype === 'date';
        const date = allDay ? localYmd(start) : berlinYmd(start);
        let endYmd = '';
        if (end) {
            endYmd = allDay ? localYmd(new Date(end.getTime() - 1000)) : berlinYmd(end);
            if (endYmd <= date) endYmd = '';
        }
        const txt = v => (v && typeof v === 'object' ? v.val : v) || '';
        return {
            title: str(txt(ev.summary), 120), date, end: endYmd, time: allDay ? '' : berlinHm(start),
            place: str(txt(ev.location), 120), url: httpUrl(txt(ev.url)), source: src
        };
    }

    async function fetchIcs(url, from, until) {
        const r = await http.get(url, { responseType: 'text', transformResponse: x => x });
        const parsed = ical.parseICS(String(r.data || ''));
        const out = [];
        const fromD = new Date(from + 'T00:00:00Z'), untilD = new Date(addDays(until, 1) + 'T00:00:00Z');
        for (const ev of Object.values(parsed)) {
            if (!ev || ev.type !== 'VEVENT' || !ev.start || !ev.summary) continue;
            const start = new Date(ev.start);
            const end = ev.end ? new Date(ev.end) : null;
            const len = end ? end - start : 0;
            if (ev.rrule) {
                let dates = [];
                try { dates = ev.rrule.between(new Date(fromD - Math.max(len, 0) - 86400000), untilD, true).slice(0, 30); } catch (e) { dates = []; }
                const ex = new Set(Object.keys(ev.exdate || {}).map(k => String(k).slice(0, 10)));
                for (const dt of dates) {
                    if (ex.has(dt.toISOString().slice(0, 10))) continue;
                    out.push(icsEvent(ev, dt, len ? new Date(dt.getTime() + len) : null, 'ical'));
                }
            } else out.push(icsEvent(ev, start, end, 'ical'));
        }
        return out;
    }

    async function fetchTicketmaster(c, from, until) {
        const iso = ymd => `${ymd}T00:00:00Z`;
        const r = await http.get('https://app.ticketmaster.com/discovery/v2/events.json', {
            params: {
                apikey: c.ticketmaster_key, latlong: `${c.lat},${c.lon}`, radius: c.radius_km, unit: 'km',
                locale: '*', size: 50, sort: 'date,asc', startDateTime: iso(from), endDateTime: iso(addDays(until, 1))
            }
        });
        const list = (r.data && r.data._embedded && r.data._embedded.events) || [];
        return list.map(e => {
            const st = (e.dates && e.dates.start) || {};
            const v = (e._embedded && e._embedded.venues && e._embedded.venues[0]) || {};
            return {
                title: str(e.name, 120), date: YMD.test(st.localDate) ? st.localDate : '', end: '',
                time: /^\d{2}:\d{2}/.test(st.localTime || '') ? st.localTime.slice(0, 5) : '',
                place: str([v.name, v.city && v.city.name].filter(Boolean).join(', '), 120), url: httpUrl(e.url), source: 'ticketmaster'
            };
        }).filter(e => e.title && e.date);
    }

    async function refreshEvents(c) {
        const today = berlinNow().ymd;
        const until = addDays(today, EVENT_HORIZON);
        const errors = [];
        const all = c.events.map(e => ({ ...e, source: 'own' }));
        for (const url of c.ics_urls) {
            try { all.push(...await fetchIcs(url, today, until)); } catch (e) {
                errors.push(`Kalender ${url.replace(/^https?:\/\//, '').slice(0, 40)}: ${e.message}`);
            }
        }
        if (c.ticketmaster_key && c.lat != null) {
            try { all.push(...await fetchTicketmaster(c, today, until)); } catch (e) {
                const status = e.response && e.response.status;
                errors.push(`Ticketmaster: ${status === 401 ? 'Schlüssel ungültig' : e.message}`);
            }
        }
        // Dedupe (same title on the same day), sort by date and time
        const seen = new Set();
        const list = all.filter(e => e.title && e.date && (e.end || e.date) >= today && e.date <= until).filter(e => {
            const k = `${e.title.toLowerCase().replace(/\s+/g, ' ')}|${e.date}`;
            if (seen.has(k)) return false;
            seen.add(k); return true;
        }).sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99').localeCompare(b.time || '99')).slice(0, 200);
        return { list, errors };
    }

    async function events(c) {
        const key = JSON.stringify([c.events, c.ics_urls, !!c.ticketmaster_key, c.lat, c.lon, c.radius_km]);
        const today = berlinNow().ymd;
        const fresh = cache.events && cache.eventsKey === key && Date.now() - cache.eventsAt < EVENTS_TTL && cache.eventsDay === today;
        if (!fresh) {
            if (!refreshing.events) {
                refreshing.events = refreshEvents(c).then(({ list, errors }) => {
                    cache.events = list; cache.eventsAt = Date.now(); cache.eventsKey = key; cache.eventsDay = today;
                    if (errors.length) cache.errors.events = errors.join(' · '); else delete cache.errors.events;
                }).catch(e => {
                    cache.errors.events = `Veranstaltungen: ${e.message}`;
                    console.warn('⚠️ Live-Tipps Veranstaltungen:', e.message);
                }).finally(() => { refreshing.events = null; });
            }
            // Only wait on the very first load; later ones refresh in the background
            if (!cache.events || cache.eventsKey !== key) await refreshing.events;
        }
        return cache.eventsKey === key && cache.events ? cache.events : c.events.map(e => ({ ...e, source: 'own' }));
    }

    // ------------------------------------------------------------------
    // Opening hours: OpenStreetMap (Overpass)
    // ------------------------------------------------------------------
    const OVERPASS = 'https://overpass-api.de/api/interpreter';

    async function overpass(query) {
        const r = await http.post(OVERPASS, new URLSearchParams({ data: query }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000
        });
        return (r.data && r.data.elements) || [];
    }

    /** Nearby places with opening hours, for the admin to pick from. */
    async function searchPlaces(radiusM, q) {
        const c = getConfig();
        if (c.lat == null) throw new Error('Bitte zuerst den Ort festlegen');
        const R = Math.min(15000, Math.max(200, parseInt(radiusM, 10) || 3000));
        const around = `(around:${R},${c.lat},${c.lon})`;
        const nameFilter = q ? `["name"~${JSON.stringify(String(q).replace(/[\\"]/g, '').slice(0, 60))},i]` : '["name"]';
        const shops = 'supermarket|bakery|butcher|convenience|kiosk|beverages|chemist';
        const amen = 'pharmacy|restaurant|cafe|fast_food|ice_cream|pub|bar|biergarten|fuel|doctors';
        const tour = 'museum|zoo|attraction|gallery';
        const leis = 'swimming_pool|water_park|sports_centre';
        const query = `[out:json][timeout:25];(
            nwr${around}["opening_hours"]${nameFilter}["shop"~"^(${shops})$"];
            nwr${around}["opening_hours"]${nameFilter}["amenity"~"^(${amen})$"];
            nwr${around}["opening_hours"]${nameFilter}["tourism"~"^(${tour})$"];
            nwr${around}["opening_hours"]${nameFilter}["leisure"~"^(${leis})$"];
        );out center tags 150;`;
        const els = await overpass(query);
        return els.map(e => {
            const t = e.tags || {};
            const lat = e.lat != null ? e.lat : e.center && e.center.lat;
            const lon = e.lon != null ? e.lon : e.center && e.center.lon;
            const kindKey = t.shop || t.amenity || t.tourism || t.leisure || '';
            const km = lat != null ? distanceKm(c.lat, c.lon, lat, lon) : null;
            return {
                name: str(t.name, 100), kind: KINDS[kindKey] || kindKey, hours: str(t.opening_hours, 300),
                url: httpUrl(t.website || t['contact:website']), osm: `${e.type}/${e.id}`,
                km, distance: km != null ? fmtKm(km) : '',
                readable: !!hours.parse(t.opening_hours)
            };
        }).filter(p => p.name && p.hours).sort((a, b) => (a.km || 0) - (b.km || 0)).slice(0, 80);
    }

    /** Once a day: fresh opening hours for places taken from OSM. */
    async function refreshOsmHours(force) {
        const c = getConfig();
        const ids = c.places.map(p => p.osm).filter(Boolean);
        if (!c.enabled || !ids.length) return { updated: 0 };
        if (!force && Date.now() - (c.hours_checked || 0) < HOURS_TTL) return { updated: 0 };
        const by = { node: [], way: [], relation: [] };
        ids.forEach(id => { const [t, n] = id.split('/'); by[t].push(n); });
        const parts = Object.entries(by).filter(([, v]) => v.length).map(([t, v]) => `${t}(id:${v.join(',')});`).join('');
        let els;
        try { els = await overpass(`[out:json][timeout:25];(${parts});out tags;`); } catch (e) {
            cache.errors.hours = `Öffnungszeiten (OpenStreetMap): ${e.message}`;
            return { updated: 0, error: e.message };
        }
        delete cache.errors.hours;
        const map = new Map(els.map(e => [`${e.type}/${e.id}`, (e.tags || {}).opening_hours]));
        let updated = 0;
        const latest = getConfig(); // the admin may have saved meanwhile
        latest.places = latest.places.map(p => {
            const h = p.osm && map.get(p.osm);
            if (h && h !== p.hours) { updated++; return { ...p, hours: str(h, 300) }; }
            return p;
        });
        latest.hours_checked = Date.now();
        db.setSetting('site_live', latest);
        if (updated) console.log(`🕘 Live-Tipps: ${updated} Öffnungszeit(en) aus OpenStreetMap aktualisiert`);
        return { updated };
    }

    // ------------------------------------------------------------------
    // Geocoding (Open-Meteo)
    // ------------------------------------------------------------------
    async function geocode(q) {
        const name = str(q, 100);
        if (name.length < 2) return [];
        const r = await http.get('https://geocoding-api.open-meteo.com/v1/search', { params: { name, count: 8, language: 'de', format: 'json' } });
        return ((r.data && r.data.results) || []).map(x => ({
            name: x.name, region: [x.admin1, x.country_code && x.country_code !== 'DE' ? x.country : ''].filter(Boolean).join(', '),
            postcode: (x.postcodes && x.postcodes[0]) || '', lat: x.latitude, lon: x.longitude
        }));
    }

    // ------------------------------------------------------------------
    // Public payload
    // ------------------------------------------------------------------
    function placesNow(c) {
        const now = berlinNow();
        return c.places.map(p => {
            const st = p.hours ? hours.status(p.hours, now) : null;
            return {
                name: p.name, kind: p.kind, distance: p.distance, url: p.url,
                hours: st ? null : p.hours, // unreadable rule: show as written
                open: st ? st.open : null, soon: st ? !!st.soon : false, state: st ? st.text : '',
                today: st ? st.today : '', week: st ? st.week : null
            };
        });
    }

    async function payload(target, range = {}) {
        const c = getConfig();
        if (!c.enabled) return { success: true, enabled: false };
        if (target === 'tv' && !c.show_tv) return { success: true, enabled: false };
        if (target === 'app' && !c.show_app) return { success: true, enabled: false };
        const today = berlinNow().ymd;
        let from = YMD.test(range.from || '') && range.from > today ? range.from : today;
        let to = YMD.test(range.to || '') ? range.to : addDays(from, c.events_days);
        if (to < from) to = addDays(from, c.events_days);
        if (to > addDays(today, EVENT_HORIZON)) to = addDays(today, EVENT_HORIZON);
        const [w, ev] = await Promise.all([
            weather(c).catch(() => null),
            events(c).catch(() => [])
        ]);
        const list = ev.filter(e => (e.end || e.date) >= from && e.date <= to).slice(0, target === 'tv' ? 6 : 30)
            .map(({ source, ...e }) => e);
        return {
            success: true, enabled: true, place: c.place, today,
            range: { from, to },
            weather: w, events: list, places: placesNow(c)
        };
    }

    function status() {
        return {
            weatherAt: cache.weatherAt && cache.weather ? new Date(cache.weatherAt).toISOString() : null,
            eventsAt: cache.eventsAt && cache.events ? new Date(cache.eventsAt).toISOString() : null,
            eventsCount: cache.events ? cache.events.length : 0,
            hoursChecked: getConfig().hours_checked ? new Date(getConfig().hours_checked).toISOString() : null,
            errors: Object.values(cache.errors)
        };
    }

    // ------------------------------------------------------------------
    // Routes
    // ------------------------------------------------------------------
    /** Public route, also used before the guest-domain rewrite (TV box on the guest host). */
    async function publicHandler(req, res) {
        try {
            const target = req.query.for === 'tv' ? 'tv' : 'app';
            const data = await payload(target, { from: String(req.query.from || ''), to: String(req.query.to || '') });
            res.set('Cache-Control', 'no-store');
            res.json(data);
        } catch (e) {
            console.error('❌ Live-Tipps:', e.message);
            res.status(500).json({ success: false });
        }
    }

    function registerAdminRoutes(app, apiLimiter) {
        app.get('/api/site/live', apiLimiter, (req, res) => {
            res.json({ success: true, config: adminConfig(), status: status() });
        });
        app.put('/api/site/live', apiLimiter, (req, res) => {
            const saved = save((req.body && req.body.live) || {});
            if (saved.enabled) refreshOsmHours(false).catch(() => {});
            res.json({ success: true, config: adminConfig() });
        });
        app.get('/api/site/live/geocode', apiLimiter, async (req, res) => {
            try { res.json({ success: true, results: await geocode(req.query.q) }); } catch (e) {
                res.status(502).json({ success: false, error: `Ortssuche nicht erreichbar (${e.message})` });
            }
        });
        app.get('/api/site/live/osm', apiLimiter, async (req, res) => {
            try { res.json({ success: true, places: await searchPlaces(req.query.radius, req.query.q) }); } catch (e) {
                const busy = e.response && (e.response.status === 429 || e.response.status === 504);
                res.status(502).json({ success: false, error: busy ? 'OpenStreetMap ist gerade ausgelastet. Bitte in einer Minute erneut versuchen.' : e.message });
            }
        });
        app.post('/api/site/live/refresh', apiLimiter, async (req, res) => {
            cache.weatherAt = 0; cache.eventsAt = 0;
            const h = await refreshOsmHours(true).catch(e => ({ error: e.message }));
            const preview = await payload('preview');
            res.json({ success: true, preview, hours: h, status: status() });
        });
        app.get('/api/site/live/preview', apiLimiter, async (req, res) => {
            res.json({ success: true, preview: await payload('preview'), status: status() });
        });
    }

    // Opening hours from OSM: check every 6 hours (refreshes once a day)
    setTimeout(() => refreshOsmHours(false).catch(() => {}), 60 * 1000).unref();
    setInterval(() => refreshOsmHours(false).catch(() => {}), 6 * 60 * 60 * 1000).unref();

    return { publicHandler, registerAdminRoutes, payload, getConfig, save, refreshOsmHours, _test: { placesNow, wmo } };
}

module.exports = createLocalLive;
module.exports.KINDS = KINDS;
