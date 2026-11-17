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
 * Ergebnisse werden im Speicher zwischengespeichert. Fällt der Dienst aus, geht alles ohne Abgleich weiter.
 */

const axios = require('axios');

const URL = 'https://nominatim.openstreetmap.org/search';
const HEADERS = { 'User-Agent': 'RentalInvoice/1.0 (Ferienwohnung, Gastadresse pruefen)' };
const TIMEOUT_MS = 6000;
const cache = new Map();
let lastRequest = 0;
let fetcher = (params) => axios.get(URL, { params, timeout: TIMEOUT_MS, headers: HEADERS }).then(r => r.data);

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
    const data = await fetcher({ format: 'jsonv2', addressdetails: 1, limit: 5, ...params });
    const list = Array.isArray(data) ? data : [];
    cache.set(key, list);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return list;
}

function fromHit(h) {
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

    let hits = [];
    let usedStreet = false;
    for (const params of attempts) {
        hits = await search(params);
        if (hits.length) { usedStreet = !!params.street; break; }
    }
    if (!hits.length) return { found: false, changes: {}, fills: [], suggest: null, map: null };

    // Street + country only: several towns have this street -> no guess
    const towns = new Set(hits.map(h => plain(fromHit(h).city)).filter(Boolean));
    if (!p.city && !p.zip && towns.size > 1) {
        return { found: true, ambiguous: true, changes: {}, fills: [], suggest: null, map: null };
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
    return { found: true, changes, fills, suggest: Object.keys(suggest).length ? suggest : null, map: best, usedStreet };
}

function score(hit, p) {
    let s = 0;
    if (p.zip && zipKey(hit.zip) === zipKey(p.zip)) s += 2;
    if (p.city && plain(hit.city) === plain(p.city)) s += 2;
    if (p.houseNumber && hit.houseNumber && plain(hit.houseNumber) === plain(String(p.houseNumber).split('/')[0])) s += 1;
    return s;
}

module.exports = { check, plain, _setFetcher: f => { fetcher = f; cache.clear(); lastRequest = 0; } };
