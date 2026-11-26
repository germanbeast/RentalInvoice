'use strict';

/**
 * Anschrift mit OpenStreetMap (Nominatim) abgleichen
 *
 * Nach dem Erkennen einer Anschrift (address-parser.js) wird sie bei OpenStreetMap gesucht:
 * - fehlende PLZ oder fehlender Ort werden ergänzt,
 * - die Schreibweise des Orts wird übernommen, wenn sie sich nur in Akzenten/Groß-Kleinschreibung unterscheidet
 *   („CADCA“ -> „Čadca“),
 * - widerspricht die Karte einer vorhandenen PLZ oder einem Ort, wird nichts geändert, sondern nur ein Vorschlag gemacht.
 *
 * Kostenlos und ohne Schlüssel. Nominatim erlaubt höchstens 1 Anfrage pro Sekunde mit eigenem User-Agent;
 * Ergebnisse werden im Speicher zwischengespeichert. Antwortet Nominatim nicht oder blockiert es den Server
 * (passiert bei Rechenzentrums-IPs), wird Photon (photon.komoot.io, ebenfalls OpenStreetMap-Daten) gefragt.
 * Fallen beide aus, geht alles ohne Abgleich weiter und der Grund wird angezeigt.
 */

const axios = require('axios');

const URL = 'https://nominatim.openstreetmap.org/search';
const PHOTON_URL = 'https://photon.komoot.io/api/';
const HEADERS = { 'User-Agent': 'RentalInvoice/1.0 (holiday flat invoicing; guest address check)', 'Accept-Language': 'de,en' };
const TIMEOUT_MS = 5000;
const BUDGET_MS = 12000;           // whole check, so the bot never waits long
const NOMINATIM_PAUSE_MS = 10 * 60 * 1000; // after a block/timeout go straight to Photon for a while
const cache = new Map();
let lastRequest = 0;
let nominatimDownUntil = 0;
let fetcher = (params) => axios.get(URL, { params, timeout: TIMEOUT_MS, headers: HEADERS }).then(r => r.data);
let photonFetcher = (params) => axios.get(PHOTON_URL, { params, timeout: TIMEOUT_MS, headers: HEADERS }).then(r => r.data);

/** Short German reason for the bot message ("blockiert", "antwortet nicht" …). */
function reasonOf(e) {
    const st = e && e.response && e.response.status;
    if (st === 403) return 'Kartendienst blockiert Anfragen von diesem Server';
    if (st === 429) return 'zu viele Anfragen an den Kartendienst, gleich nochmal versuchen';
    if (st >= 500) return `Kartendienst gestört (Fehler ${st})`;
    if (st) return `Kartendienst antwortet mit Fehler ${st}`;
    const code = e && e.code;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(e && e.message)) return 'Kartendienst antwortet nicht rechtzeitig';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Server findet den Kartendienst nicht (DNS/Internet)';
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return 'Verbindung zum Kartendienst abgebrochen';
    return 'Kartendienst nicht erreichbar';
}

function logError(service, e) {
    const st = e && e.response && e.response.status;
    const body = e && e.response && e.response.data ? String(typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data)).replace(/\s+/g, ' ').slice(0, 200) : '';
    console.warn(`[Geo] ${service} fehlgeschlagen:`, st || (e && e.code) || '', (e && e.message) || '', body);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** "Čadca" and "CADCA" are the same town; "Müller" and "Mueller" too. */
function plain(s) {
    return String(s || '').toLowerCase()
        .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
        .replace(/[^a-z0-9]/g, '');
}

const zipKey = z => String(z || '').replace(/[\s-]/g, '').toUpperCase();

async function search(params) {
    const key = JSON.stringify(params);
    if (cache.has(key)) return cache.get(key);
    const wait = 1100 - (Date.now() - lastRequest);
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    let data;
    try {
        data = await fetcher({ format: 'jsonv2', addressdetails: 1, limit: 5, ...params });
    } catch (e) {
        logError('Nominatim', e);
        nominatimDownUntil = Date.now() + NOMINATIM_PAUSE_MS;
        throw e;
    }
    const list = (Array.isArray(data) ? data : []).map(fromHit);
    remember(key, list);
    return list;
}

function remember(key, list) {
    cache.set(key, list);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
}

/** Same lookup via Photon (free text, OSM data). Hits are filtered to the country if one is known. */
async function searchPhoton(p, withStreet) {
    const mainNumber = String(p.houseNumber || '').split('/')[0];
    const parts = withStreet && p.street ? [`${p.street} ${mainNumber}`.trim()] : [];
    if (p.zip) parts.push(p.zip);
    if (p.city) parts.push(p.city);
    if (!parts.length) return [];
    const q = parts.join(', ');
    const key = 'photon:' + q + '|' + (p.countryCode || '');
    if (cache.has(key)) return cache.get(key);
    let data;
    try {
        data = await photonFetcher({ q, limit: 8, lang: 'de' });
    } catch (e) {
        logError('Photon', e);
        throw e;
    }
    const features = (data && Array.isArray(data.features)) ? data.features : [];
    let list = features.map(f => fromPhoton(f && f.properties));
    if (p.countryCode) list = list.filter(h => !h.countryCode || h.countryCode === p.countryCode.toUpperCase());
    if (withStreet) list = list.filter(h => h.street);
    remember(key, list);
    return list;
}

function fromPhoton(a) {
    a = a || {};
    const placeTypes = ['city', 'town', 'village', 'hamlet', 'municipality', 'locality', 'suburb'];
    const isPlace = placeTypes.includes(a.osm_value) || placeTypes.includes(a.type);
    const isStreet = a.osm_key === 'highway' || a.type === 'street';
    return {
        zip: a.postcode || '',
        city: a.city || (isPlace ? a.name : '') || a.locality || a.district || '',
        street: a.street || (isStreet ? a.name : '') || '',
        houseNumber: a.housenumber || '',
        countryCode: String(a.countrycode || '').toUpperCase()
    };
}

function fromHit(h) {
    if (h && h.zip !== undefined && !h.address) return h; // already converted
    const a = (h && h.address) || {};
    return {
        zip: a.postcode || '',
        city: a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb || '',
        street: a.road || a.pedestrian || a.square || '',
        houseNumber: a.house_number || '',
        countryCode: String(a.country_code || '').toUpperCase()
    };
}

/**
 * @param {object} p  result of addressParser.parseAddress
 * @returns {Promise<null | {found: boolean, changes: object, fills: string[], suggest: object|null, map: object}>}
 *   changes: fields that may be applied right away (empty field filled, same town with correct spelling)
 *   suggest: map values that contradict what was typed (only applied on request)
 */
async function check(p) {
    if (!p || (!p.street && !p.city && !p.zip)) return null;
    const base = {};
    if (p.countryCode) base.countrycodes = p.countryCode.toLowerCase();
    const mainNumber = String(p.houseNumber || '').split('/')[0];
    const street = p.street ? `${mainNumber} ${p.street}`.trim() : '';
    const attempts = [];
    if (street && (p.city || p.zip)) attempts.push({ ...base, street, ...(p.city ? { city: p.city } : {}), ...(p.zip ? { postalcode: p.zip } : {}) });
    if (street && p.city) attempts.push({ ...base, street, city: p.city });
    if (street && p.zip) attempts.push({ ...base, street, postalcode: p.zip });
    if (p.city || p.zip) attempts.push({ ...base, ...(p.city ? { city: p.city } : {}), ...(p.zip ? { postalcode: p.zip } : {}) });
    if (street && !p.city && !p.zip && p.countryCode) attempts.push({ ...base, street });

    const started = Date.now();
    let hits = [];
    let usedStreet = false;
    let failure = null;
    let source = 'nominatim';
    if (Date.now() >= nominatimDownUntil) {
        for (const params of attempts) {
            if (Date.now() - started > BUDGET_MS) { failure = failure || { code: 'ETIMEDOUT' }; break; }
            try {
                hits = await search(params);
            } catch (e) { failure = e; break; }
            if (hits.length) { usedStreet = !!params.street; break; }
        }
    } else failure = { code: 'PAUSED' };

    // Nominatim blocked/slow -> Photon, same OSM data
    if (failure && !hits.length) {
        source = 'photon';
        const tries = [];
        if (street) tries.push(true);
        if (p.city || p.zip) tries.push(false);
        let photonError = null;
        for (const withStreet of tries) {
            if (Date.now() - started > BUDGET_MS + 6000) break;
            try {
                hits = await searchPhoton(p, withStreet);
                photonError = null;
            } catch (e) { photonError = e; break; }
            if (hits.length) { usedStreet = withStreet; break; }
        }
        if (photonError) {
            const reason = reasonOf(failure.code === 'PAUSED' ? photonError : failure);
            return { error: true, reason, found: false, changes: {}, fills: [], suggest: null, map: null };
        }
    }
    if (!hits.length) return { found: false, changes: {}, fills: [], suggest: null, map: null, source };

    // Street + country only: several towns have this street -> no guess
    const towns = new Set(hits.map(h => plain(fromHit(h).city)).filter(Boolean));
    if (!p.city && !p.zip && towns.size > 1) {
        return { found: true, ambiguous: true, changes: {}, fills: [], suggest: null, map: null, source };
    }

    // Prefer a hit whose town/postcode matches what was typed
    const best = hits.map(fromHit).sort((a, b) => score(b, p) - score(a, p))[0];
    const changes = {};
    const fills = [];
    const suggest = {};

    if (best.zip) {
        if (!p.zip) { changes.zip = best.zip; fills.push('PLZ'); }
        else if (zipKey(best.zip) !== zipKey(p.zip)) {
            // Several postcodes per town are normal: only a hint when the street itself was found
            if (usedStreet) suggest.zip = best.zip;
        } else if (best.zip !== p.zip) changes.zip = best.zip; // "02201" -> "022 01"
    }
    if (best.city) {
        if (!p.city) { changes.city = best.city; fills.push('Ort'); }
        else if (plain(best.city) === plain(p.city)) { if (best.city !== p.city) { changes.city = best.city; fills.push('Schreibweise Ort'); } }
        else if (!plain(best.city).includes(plain(p.city)) && !plain(p.city).includes(plain(best.city))) suggest.city = best.city;
    }
    if (best.street && p.street && usedStreet && plain(best.street) !== plain(p.street)) {
        // Same street in another spelling ("Hauptstr." vs "Hauptstraße") is fine, real differences are only shown
        const a = plain(best.street).replace(/strasse|str$/g, ''), b = plain(p.street).replace(/strasse|str$/g, '');
        if (a !== b) suggest.street = best.street;
    }
    return { found: true, changes, fills, suggest: Object.keys(suggest).length ? suggest : null, map: best, usedStreet, source };
}

function score(hit, p) {
    let s = 0;
    if (p.zip && zipKey(hit.zip) === zipKey(p.zip)) s += 2;
    if (p.city && plain(hit.city) === plain(p.city)) s += 2;
    if (p.houseNumber && hit.houseNumber && plain(hit.houseNumber) === plain(String(p.houseNumber).split('/')[0])) s += 1;
    return s;
}

module.exports = {
    check, plain, reasonOf,
    _setFetcher: (f, photon) => { fetcher = f; if (photon) photonFetcher = photon; cache.clear(); lastRequest = 0; nominatimDownUntil = 0; }
};
