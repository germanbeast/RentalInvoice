/**
 * Robust VEVENT reader for portal calendars (Booking.com, Airbnb).
 *
 * node-ical keys events by UID and merges entries that share a UID ("last one wins").
 * Portal feeds do not always keep UIDs unique: a closed period split into several blocks
 * (e.g. "CLOSED - Not available" 02.–08.11.) can arrive as multiple VEVENTs with the same UID,
 * and only one of them survived -> the other days showed as free. Here every VEVENT is parsed
 * on its own, so no block is lost. A missing DTEND counts as one day (RFC 5545, 3.6.1).
 */
const ical = require('node-ical');

const VEVENT_RE = /BEGIN:VEVENT\r?\n[\s\S]*?\r?\nEND:VEVENT/g;

function ymdLocal(dt) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// iCal all-day events (VALUE=DATE) are parsed by node-ical as local midnight. Calling
// toISOString() on them shifts the date one day back on servers west of UTC+0 (e.g. Europe/Berlin).
function icalDateToYmd(d) {
    if (!d) return null;
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return null;
    if (d.dateOnly) return ymdLocal(dt);
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
}

function addDaysYmd(ymd, n) {
    const d = new Date(ymd + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/**
 * Returns every VEVENT of the feed: { uid, rawUid, summary, description, start, end, checkin, checkout }.
 * UIDs that occur more than once get a "#<checkin>" suffix so each block is stored separately.
 * `keepPlainUid(rawUid, checkin, checkout)` may name the occurrence that keeps the plain UID
 * (the one already stored), so existing bookings and their door codes are not touched;
 * otherwise the first occurrence keeps it.
 */
function parseEvents(text, { keepPlainUid } = {}) {
    const blocks = String(text || '').match(VEVENT_RE) || [];
    // Time zone definitions stay with every single event (needed for DTSTART;TZID=...)
    const tz = (String(text || '').match(/BEGIN:VTIMEZONE\r?\n[\s\S]*?\r?\nEND:VTIMEZONE/g) || []).join('\r\n');
    const header = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${tz ? tz + '\r\n' : ''}`;
    const events = [];
    for (const block of blocks) {
        let parsed;
        try { parsed = ical.parseICS(`${header}${block}\r\nEND:VCALENDAR\r\n`); } catch (e) { continue; }
        for (const k of Object.keys(parsed)) {
            const ev = parsed[k];
            if (!ev || ev.type !== 'VEVENT' || !ev.uid) continue;
            const checkin = icalDateToYmd(ev.start);
            if (!checkin) continue;
            let checkout = icalDateToYmd(ev.end);
            // No DTEND/DURATION, or an end on the same day -> the block covers its start day
            if (!checkout || checkout <= checkin) checkout = addDaysYmd(checkin, 1);
            events.push({
                rawUid: String(ev.uid),
                uid: String(ev.uid),
                summary: ev.summary,
                description: ev.description,
                start: ev.start,
                end: ev.end,
                checkin,
                checkout
            });
        }
    }

    const byUid = new Map();
    for (const ev of events) {
        if (!byUid.has(ev.rawUid)) byUid.set(ev.rawUid, []);
        byUid.get(ev.rawUid).push(ev);
    }
    const out = [];
    for (const [rawUid, list] of byUid) {
        if (list.length === 1) { out.push(list[0]); continue; }
        // Identical copies of the same block count once
        const unique = [];
        for (const ev of list) if (!unique.some(u => u.checkin === ev.checkin && u.checkout === ev.checkout)) unique.push(ev);
        if (unique.length === 1) { out.push(unique[0]); continue; }
        const plain = (keepPlainUid && unique.find(ev => keepPlainUid(rawUid, ev.checkin, ev.checkout))) || unique[0];
        for (const ev of unique) {
            if (ev !== plain) ev.uid = `${rawUid}#${ev.checkin}`;
            out.push(ev);
        }
    }
    return out;
}

module.exports = { parseEvents, icalDateToYmd, addDaysYmd };
