/**
 * TV welcome screen extras for the current guest:
 *  - Farewell on departure day: "Danke, <Name>" plus check-out hints (time and a short list, set in
 *    Admin → Einstellungen → TV-Box). The preset hints are translated on the TV (guest-site/i18n.js),
 *    own hints appear as written.
 *  - "Neue Handtücher" button: the guest confirms on the TV, the host gets a Telegram/WhatsApp/push
 *    message with the booking. At most one request per booking every 30 minutes, last requests are
 *    listed in the admin.
 */
const db = require('./db');

// German keys, translated in guest-site/i18n.js
const DEFAULT_HINTS = [
    'Geschirr spülen oder in die Spülmaschine räumen',
    'Müll in die Tonnen vor dem Haus bringen',
    'Benutzte Handtücher ins Bad legen',
    'Fenster schließen und Heizung herunterdrehen',
    'Licht und Geräte ausschalten',
    'Wohnungstür beim Gehen fest zuziehen'
];
const DEFAULTS = {
    farewell: true,       // show the farewell on departure day
    hints: DEFAULT_HINTS,
    message: '',          // own farewell text (empty = built-in, translated)
    towels: true          // show the towel button
};
const MAX_HINTS = 8;
const TOWEL_COOLDOWN_MS = 30 * 60 * 1000;
const LOG_MAX = 30;

module.exports = function tvGuest({ notify, berlinToday, formatDateDE }) {
    function getConfig() {
        const c = db.getSetting('tv_guest') || {};
        return { ...DEFAULTS, ...c, hints: Array.isArray(c.hints) ? c.hints : DEFAULT_HINTS };
    }

    function save(inp) {
        const cur = getConfig();
        const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        const next = {
            farewell: inp.farewell !== undefined ? !!inp.farewell : cur.farewell,
            towels: inp.towels !== undefined ? !!inp.towels : cur.towels,
            message: inp.message !== undefined ? clean(inp.message).slice(0, 200) : cur.message,
            hints: inp.hints !== undefined
                ? (Array.isArray(inp.hints) ? inp.hints : String(inp.hints).split('\n')).map(clean).filter(Boolean).map(s => s.slice(0, 120)).slice(0, MAX_HINTS)
                : cur.hints
        };
        db.setSetting('tv_guest', next);
        return next;
    }

    /** "HH:MM" in Berlin now. */
    function berlinTime() {
        return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    }
    const toMin = t => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };

    /**
     * Which booking the TV is about. On a changeover day the departing guest until 30 minutes after
     * the check-out time (12:00 without one), then the arriving one.
     */
    function pickCurrent(rows, checkoutTime) {
        const today = berlinToday();
        const here = rows.filter(r => r.checkin <= today && r.checkout >= today && r.state !== 'past');
        const limit = (toMin(checkoutTime) ?? 12 * 60) + 30;
        const departingFirst = toMin(berlinTime()) < limit;
        return here.sort((a, b) => {
            const da = a.checkout === today, dbb = b.checkout === today;
            if (da !== dbb) return departingFirst ? (da ? -1 : 1) : (da ? 1 : -1);
            return a.checkin.localeCompare(b.checkin);
        })[0] || null;
    }

    /** Extra fields for /api/welcome. */
    function welcomeExtras(current) {
        const c = getConfig();
        const today = berlinToday();
        const departure = !!(current && current.checkout === today && c.farewell);
        return {
            farewell: departure ? { hints: c.hints, message: c.message } : null,
            towels: c.towels && !!current
        };
    }

    // ---- Towels ----
    function log() { return db.getSetting('towel_requests') || []; }

    /** source: 'tv' (button on the TV) or 'wlan' (start page after the WLAN login). */
    async function requestTowels(current, { preview, source = 'tv' } = {}) {
        if (!getConfig().towels) return { ok: false, status: 404, error: 'aus' };
        const now = Date.now();
        const key = current ? `b${current.id}` : 'none';
        const entries = log();
        const last = entries.find(e => e.key === key && !e.preview === !preview);
        if (last && now - last.at < TOWEL_COOLDOWN_MS) {
            return { ok: true, already: true, at: last.at };
        }
        const name = current ? (current.name || 'Gast') : 'kein Gast eingetragen';
        const stay = current ? `${formatDateDE(current.checkin)} – ${formatDateDE(current.checkout)}` : '';
        const time = berlinTime();
        // Telegram uses Markdown (falls back to plain text if a name breaks it), WhatsApp/push plain
        const msg = `🧺 *Neue Handtücher gewünscht*\n`
            + `Gast: ${name}\n`
            + (stay ? `Aufenthalt: ${stay}${current.checkout === berlinToday() ? ' (reist heute ab)' : ''}\n` : '')
            + `Angefragt ${source === 'wlan' ? 'auf der WLAN-Startseite' : 'am Fernseher'} um ${time} Uhr`
            + (preview ? '\n\n_Test aus der Admin-Vorschau_' : '');
        const sent = await notify(msg, 'towels');
        entries.unshift({ key, at: now, bookingId: current ? current.id : null, name, stay, preview: !!preview, sent: !!sent, source });
        db.setSetting('towel_requests', entries.slice(0, LOG_MAX));
        return { ok: true, already: false, at: now, sent: !!sent };
    }

    /**
     * Routes. allowed(req) = paired TV box or admin preview, current() = booking on the TV now.
     */
    function registerRoutes(app, { allowed, isAdmin, current, limiter }) {
        app.post('/api/tv-box/towels', limiter, async (req, res) => {
            if (!allowed(req)) return res.status(403).json({ success: false });
            if (!req.is('application/json')) return res.status(415).json({ success: false });
            try {
                const r = await requestTowels(current(), { preview: isAdmin(req) });
                if (!r.ok) return res.status(r.status).json({ success: false });
                res.json({ success: true, already: r.already, at: r.at });
            } catch (e) {
                console.error('Handtücher:', e.message);
                res.status(500).json({ success: false });
            }
        });
    }

    function registerAdminRoutes(app, limiter) {
        app.get('/api/settings/tv-guest', limiter, (req, res) => {
            res.json({ success: true, config: getConfig(), defaults: DEFAULT_HINTS, requests: log().slice(0, 10) });
        });
        app.put('/api/settings/tv-guest', limiter, (req, res) => {
            res.json({ success: true, config: save(req.body || {}) });
        });
    }

    return { getConfig, save, pickCurrent, welcomeExtras, requestTowels, registerRoutes, registerAdminRoutes, DEFAULT_HINTS, _test: { toMin } };
};
