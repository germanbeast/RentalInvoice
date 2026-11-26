/**
 * Small reader for OpenStreetMap opening_hours values (the common subset used by shops and restaurants).
 *
 *   "Mo-Fr 08:00-18:00; Sa 08:00-13:00; Su,PH off"
 *   "Mo-Sa 07:00-12:00,14:30-18:30"
 *   "24/7"   "Tu-Su 17:00-01:00"   "Apr-Oct Mo-Su 10:00-18:00; Nov-Mar Sa,Su 11:00-16:00"
 *
 * Later rules replace earlier ones for the days they name (OSM semantics). PH rules apply on German
 * nationwide public holidays. Anything this reader does not understand (week numbers, sunrise …) makes
 * parse() return null; the raw text is then shown without an open/closed state.
 */

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAYS_DE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DAYS_DE_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toMin = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); if (!m) return null; const v = +m[1] * 60 + +m[2]; return v <= 48 * 60 ? v : null; };
const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function expandList(text, names) {
    const out = new Set();
    for (const part of text.split(',')) {
        const r = part.split('-');
        if (r.length === 1) {
            const i = names.indexOf(r[0]);
            if (i < 0) return null;
            out.add(i);
        } else if (r.length === 2) {
            const a = names.indexOf(r[0]), b = names.indexOf(r[1]);
            if (a < 0 || b < 0) return null;
            for (let i = a; ; i = (i + 1) % names.length) { out.add(i); if (i === b) break; }
        } else return null;
    }
    return out;
}

/** [{ months:Set|null, days:Set|null, ph:bool, ranges:[[from,to]] | [] (= closed) }] or null */
function parse(value) {
    let s = String(value || '').trim();
    if (!s) return null;
    s = s.replace(/"[^"]*"/g, '').replace(/\|\|/g, ';').replace(/\s+/g, ' ').trim();
    if (s === '24/7') return [{ months: null, days: null, ph: false, ranges: [[0, 1440]] }];
    const rules = [];
    for (let raw of s.split(';')) {
        raw = raw.trim().replace(/:\s*$/, '');
        if (!raw) continue;
        const tokens = raw.split(' ').filter(Boolean);
        const rule = { months: null, days: null, ph: false, onlyPh: false, ranges: null };
        let i = 0;
        // Month range: "Apr-Oct", "Dec", "Apr-Oct:"
        if (tokens[i] && /^[A-Z][a-z]{2}([-,][A-Z][a-z]{2})*:?$/.test(tokens[i]) && MONTHS.includes(tokens[i].slice(0, 3))) {
            const m = expandList(tokens[i].replace(/:$/, ''), MONTHS);
            if (!m) return null;
            rule.months = m; i++;
        }
        // Weekdays and/or PH: "Mo-Fr", "Sa,Su,PH", "PH"
        if (tokens[i] && /^(Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)([-,](Mo|Tu|We|Th|Fr|Sa|Su|PH|SH))*:?$/.test(tokens[i])) {
            const parts = tokens[i].replace(/:$/, '').split(',');
            const dayParts = parts.filter(p => p !== 'PH' && p !== 'SH');
            rule.ph = parts.includes('PH');
            if (parts.includes('SH') && !dayParts.length && !rule.ph) { continue; } // school holidays: not known here
            if (dayParts.length) {
                const d = expandList(dayParts.join(','), DAYS);
                if (!d) return null;
                rule.days = d;
            } else if (rule.ph) rule.onlyPh = true;
            i++;
        }
        const rest = tokens.slice(i).join('');
        if (!rest || rest === 'open') rule.ranges = [[0, 1440]];
        else if (rest === 'off' || rest === 'closed') rule.ranges = [];
        else {
            rule.ranges = [];
            for (const t of rest.split(',')) {
                const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\+?$/.exec(t) || /^(\d{1,2}:\d{2})\+$/.exec(t);
                if (!m) return null;
                const a = toMin(m[1]);
                let b = m[2] ? toMin(m[2]) : 1440;
                if (a == null || b == null) return null;
                if (b <= a) b += 1440; // overnight: 18:00-02:00
                rule.ranges.push([a, b]);
            }
        }
        rules.push(rule);
    }
    return rules.length ? rules : null;
}

// ---- German nationwide public holidays ----------------------------------
function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return Date.UTC(y, month - 1, day);
}
const ymdUTC = t => new Date(t).toISOString().slice(0, 10);
function isHoliday(ymd) {
    const y = +ymd.slice(0, 4);
    const e = easter(y), D = 86400000;
    const list = [`${y}-01-01`, `${y}-05-01`, `${y}-10-03`, `${y}-12-25`, `${y}-12-26`,
        ymdUTC(e - 2 * D), ymdUTC(e + D), ymdUTC(e + 39 * D), ymdUTC(e + 50 * D)];
    return list.includes(ymd);
}

/** Opening ranges [[from,to]] (minutes, `to` may pass midnight) for a date 'YYYY-MM-DD'. */
function rangesOn(rules, ymd) {
    const d = new Date(ymd + 'T12:00:00Z');
    const wd = (d.getUTCDay() + 6) % 7; // 0 = Monday
    const month = d.getUTCMonth();
    const holiday = isHoliday(ymd);
    let ranges = [];
    for (const r of rules) {
        if (r.months && !r.months.has(month)) continue;
        if (r.onlyPh) { if (holiday) ranges = r.ranges; continue; }
        const dayHit = !r.days || r.days.has(wd);
        if (dayHit || (r.ph && holiday)) ranges = r.ranges;
    }
    return ranges;
}

const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = ymd => (new Date(ymd + 'T12:00:00Z').getUTCDay() + 6) % 7;

function fmtRanges(ranges) {
    if (!ranges.length) return 'geschlossen';
    if (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] >= 1440) return 'durchgehend';
    return ranges.map(([a, b]) => `${hhmm(a)}–${b >= 1440 && b % 1440 === 0 ? '24:00' : hhmm(b)}`).join(', ');
}

/**
 * State at a Berlin local moment: { open, text, today, week: [{ day, hours }] } or null when not readable.
 * `now` = { ymd: 'YYYY-MM-DD', minutes: 0..1439 }
 */
function status(value, now) {
    const rules = parse(value);
    if (!rules) return null;
    const { ymd, minutes } = now;
    const today = rangesOn(rules, ymd);
    const yesterday = rangesOn(rules, addDays(ymd, -1));
    let closesAt = null;
    for (const [a, b] of yesterday) if (b > 1440 && minutes < b - 1440) closesAt = b - 1440;
    for (const [a, b] of today) if (minutes >= a && minutes < b) closesAt = closesAt == null ? b : Math.max(closesAt, b);
    const week = [];
    for (let i = 0; i < 7; i++) {
        const day = addDays(ymd, i - weekday(ymd)); // Monday .. Sunday of this week
        week.push({ day: DAYS_DE[i], hours: fmtRanges(rangesOn(rules, day)) });
    }
    const base = { today: fmtRanges(today), week };
    if (closesAt != null) {
        const always = today.some(([a, b]) => a === 0 && b >= 1440) && rangesOn(rules, addDays(ymd, 1)).some(([a]) => a === 0);
        if (always) return { ...base, open: true, soon: false, text: 'Rund um die Uhr geöffnet' };
        const left = closesAt - minutes;
        return { ...base, open: true, soon: left <= 60, text: left <= 60 ? `Schließt bald · ${hhmm(closesAt)}` : `Geöffnet bis ${hhmm(closesAt)}` };
    }
    const later = today.filter(([a]) => a > minutes).sort((x, y) => x[0] - y[0])[0];
    if (later) return { ...base, open: false, soon: false, text: `Öffnet heute um ${hhmm(later[0])}` };
    for (let i = 1; i <= 7; i++) {
        const day = addDays(ymd, i);
        const r = rangesOn(rules, day).slice().sort((x, y) => x[0] - y[0])[0];
        if (r) {
            const when = i === 1 ? 'morgen' : DAYS_DE_LONG[weekday(day)];
            return { ...base, open: false, soon: false, text: `Geschlossen · öffnet ${when} ${hhmm(r[0])}` };
        }
    }
    return { ...base, open: false, soon: false, text: 'Geschlossen' };
}

module.exports = { parse, status, isHoliday, fmtRanges };
