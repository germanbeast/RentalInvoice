// User roles and per-area permissions for the admin app.
// Every logged-in request to /api/* (and /uploads) passes guard(): the path decides which area it belongs to,
// GET/HEAD needs "view", every other method needs "edit". A path that matches no rule is allowed only for
// users with full rights (owner/admin), so a new route is never open to restricted users by accident.

const LEVELS = { none: 0, view: 1, edit: 2 };

const AREAS = [
    { key: 'calendar', label: 'Kalender & Startseite', hint: 'Belegungskalender, heutige An-/Abreisen, Kalender-Abgleich' },
    { key: 'bookings', label: 'Buchungen, Gäste & Anfragen', hint: 'Buchungsliste, Buchungen eintragen/löschen, Gästeliste, Anfragen der Webseite' },
    { key: 'invoices', label: 'Rechnungen', hint: 'Rechnungen erstellen, ansehen, versenden' },
    { key: 'finance', label: 'Finanzen & Exporte', hint: 'Umsätze, Auslastung & Jahresrückblick, Ausgaben, Erbverwaltung, Excel/CSV/ZIP' },
    { key: 'door', label: 'Türcodes & Notfall-Öffnen', hint: 'Nuki-Codes ansehen/anlegen/löschen, Notfall-Öffnen' },
    { key: 'messages', label: 'Gast-Nachrichten & Chat', hint: 'Gast-Nachricht/Link, WhatsApp/SMS-Postfach' },
    { key: 'meldescheine', label: 'Meldescheine', hint: 'Online-Meldescheine ansehen, drucken, exportieren' },
    { key: 'website', label: 'Gäste-Webseite', hint: 'Texte, Fotos, Grundriss der Webseite' },
    { key: 'settings', label: 'Einstellungen & Integrationen', hint: 'Vermieter-Daten, Nuki, Kalender-Links, WhatsApp, Telegram, Update' },
    { key: 'users', label: 'Benutzerverwaltung', hint: 'Benutzer anlegen, Rechte vergeben' }
];
const AREA_KEYS = AREAS.map(a => a.key);

const all = (level) => Object.fromEntries(AREA_KEYS.map(k => [k, level]));

// Presets; "custom" keeps whatever was ticked. The owner always has every right and cannot be removed.
const ROLES = {
    owner: { label: 'Inhaber', permissions: all('edit') },
    admin: { label: 'Admin', permissions: all('edit') },
    manager: {
        label: 'Manager',
        permissions: {
            calendar: 'edit', bookings: 'edit', invoices: 'edit', finance: 'view', door: 'edit',
            messages: 'edit', meldescheine: 'edit', website: 'edit', settings: 'none', users: 'none'
        }
    },
    cleaning: { label: 'Reinigung', permissions: { ...all('none'), calendar: 'view' } },
    custom: { label: 'Eigene Rechte', permissions: null }
};

/** Clean permission object: every area with 'none' | 'view' | 'edit'. */
function normalize(perms) {
    let p = perms;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
    const out = {};
    for (const k of AREA_KEYS) {
        const v = p && typeof p === 'object' ? p[k] : undefined;
        out[k] = v === 'edit' || v === 'view' ? v : 'none';
    }
    return out;
}

/** Effective permissions of a DB user row. Fixed roles ignore the stored column. */
function forUser(user) {
    if (!user) return all('none');
    const role = ROLES[user.role] ? user.role : 'admin'; // unknown/legacy role = full rights as before
    if (role === 'custom') return normalize(user.permissions);
    return { ...ROLES[role].permissions };
}

function can(perms, area, level = 'view') {
    return !!perms && (LEVELS[perms[area]] || 0) >= LEVELS[level];
}

function isFull(perms) {
    return AREA_KEYS.every(k => perms && perms[k] === 'edit');
}

/** true when every right in `wanted` is also held by `granter` (no one can hand out more than they have). */
function within(wanted, granter) {
    return AREA_KEYS.every(k => (LEVELS[wanted[k]] || 0) <= (LEVELS[granter[k]] || 0));
}

// ---------------------------------------------------------------------------
// Route map. First match wins. `level` overrides the method default (GET = view, else edit).
// 'any' = every logged-in user (own session, own push device, version info).
// ---------------------------------------------------------------------------
const R = (methods, pattern, area, level) => ({ methods, pattern, area, level });
const RULES = [
    R('*', /^\/api\/(me|version|changelog|health|logout)$/, 'any'),
    R('*', /^\/api\/push\/(key|subscribe|unsubscribe|test)$/, 'any'),
    R('*', /^\/api\/push\/devices(\/|$)/, 'settings'),

    R('*', /^\/api\/users(\/|$)/, 'users'),

    // Calendar & overview
    R('GET', /^\/api\/(calendar|overview|activity|status)$/, 'calendar'),
    R('GET', /^\/api\/bookings$/, 'calendar', 'view'), // booking list for the calendar (fields cut by redactBooking)
    R('GET', /^\/api\/site\/settings$/, 'any'), // texts and prices of the public website
    R('*', /^\/api\/(ical\/sync|calendar\/fetch|overlaps\/ack)$/, 'calendar', 'edit'),

    // Door codes (before the generic booking rules)
    R('*', /^\/api\/bookings\/[^/]+\/nuki$/, 'door'),
    R('*', /^\/api\/nuki\/test$/, 'settings'),
    R('*', /^\/api\/nuki(\/|$)/, 'door'),
    R('GET', /^\/api\/notfall\/aushang$/, 'door', 'view'),
    R('*', /^\/api\/notfall(\/|$)/, 'door'),

    // Bookings, guests, requests from the website
    R('*', /^\/api\/bookings(\/|$)/, 'bookings'),
    R('*', /^\/api\/guests(\/|$)/, 'bookings'),
    R('*', /^\/api\/site\/requests(\/|$)/, 'bookings'),

    // Messages to guests
    R('*', /^\/api\/site\/guest-message(\/|$)/, 'messages'),
    R('*', /^\/api\/chat\/(settings|sms)(\/|$)/, 'settings'),
    R('PUT', /^\/api\/chat\/thread\/[^/]+\/read$/, 'messages', 'view'), // opening a chat marks it read
    R('*', /^\/api\/chat(\/|$)/, 'messages'),

    // Guest website content
    R('*', /^\/api\/site(\/|$)/, 'website'),

    // Invoices
    R('*', /^\/api\/invoices(\/|$)/, 'invoices'),
    R('*', /^\/api\/(generate-pdf|send-email)$/, 'invoices', 'edit'),
    R('GET', /^\/api\/branding(\/|$)/, 'invoices', 'view'),
    R('*', /^\/api\/branding(\/|$)/, 'settings'),

    // Finance
    R('*', /^\/api\/(finance|expenses|estate|stats|review)(\/|$)/, 'finance'),
    R('*', /^\/uploads\/estate\//, 'finance'), // other /uploads paths (certificates …): full rights only

    // Meldescheine
    R('*', /^\/api\/meldescheine(\/|$)/, 'meldescheine'),

    // Settings & integrations (GET /api/settings is answered reduced for others, see server.js)
    R('GET', /^\/api\/settings$/, 'any'),
    R('*', /^\/api\/(settings|telegram|whatsapp|notifications|update|migrate)(\/|$)/, 'settings')
];

/** { area, level } for a request, 'any' for every user, or null when no rule matches (full rights only). */
function routeRule(method, path) {
    const m = String(method || 'GET').toUpperCase();
    for (const r of RULES) {
        if (r.methods !== '*' && r.methods !== m) continue;
        if (!r.pattern.test(path)) continue;
        if (r.area === 'any') return 'any';
        return { area: r.area, level: r.level || (m === 'GET' || m === 'HEAD' ? 'view' : 'edit') };
    }
    return null;
}

const PUBLIC_API = new Set(['/api/login', '/api/login/verify', '/api/login/recover', '/api/health']);

/**
 * Express middleware. Loads the user fresh from the DB on every request, so changed rights apply at once
 * and a deleted user is logged out on the next click.
 */
function createGuard(db) {
    return function guard(req, res, next) {
        const p = req.path;
        if (!(p.startsWith('/api/') || p.startsWith('/uploads'))) return next();
        if (PUBLIC_API.has(p)) return next();
        const su = req.session && req.session.user;
        if (!su) return next(); // ensureAuthenticated answers 401

        const user = su.id ? db.getUserById(su.id) : db.getUser(su.username);
        if (!user) {
            return req.session.destroy(() => res.status(401).json({ error: 'Benutzer existiert nicht mehr' }));
        }
        const perms = forUser(user);
        req.user = { id: user.id, username: user.username, role: user.role, permissions: perms };
        if (!su.id || su.username !== user.username || su.role !== user.role) {
            req.session.user = { id: user.id, username: user.username, role: user.role };
        }

        const rule = routeRule(req.method, p);
        if (rule === 'any') return next();
        if (rule ? can(perms, rule.area, rule.level) : isFull(perms)) return next();

        const area = rule && AREAS.find(a => a.key === rule.area);
        return res.status(403).json({
            success: false,
            error: area ? `Keine Berechtigung: ${area.label} (${rule.level === 'edit' ? 'Bearbeiten' : 'Ansehen'})` : 'Keine Berechtigung',
            permission: rule || null
        });
    };
}

/** Removes fields of a booking row (from loadBookingRows) that the user's rights do not cover. */
function redactBooking(row, perms) {
    const r = { ...row };
    if (!can(perms, 'door')) { r.pin = null; }
    if (!can(perms, 'bookings')) { r.guestEmail = null; r.guestId = null; }
    if (!can(perms, 'messages') && !can(perms, 'bookings')) r.guestCode = null;
    if (!can(perms, 'meldescheine')) r.meldescheinId = null;
    return r;
}

// Telegram/WhatsApp bot commands -> required right
const BOT_COMMANDS = {
    status: ['calendar', 'view'], anreisen: ['calendar', 'view'], sync: ['calendar', 'edit'],
    namen: ['bookings', 'edit'],
    offen: ['invoices', 'view'], rechnung: ['invoices', 'edit'],
    codes: ['door', 'view'], pin: ['door', 'edit'], lock: ['door', 'edit'], lockstatus: ['door', 'view'],
    nachricht: ['messages', 'view'], guestlink: ['messages', 'edit'],
    review: ['finance', 'view']
};

function canBot(perms, command) {
    const need = BOT_COMMANDS[command];
    return !need || can(perms, need[0], need[1]);
}

module.exports = {
    LEVELS, AREAS, AREA_KEYS, ROLES, RULES, normalize, forUser, can, isFull, within, routeRule,
    createGuard, redactBooking, canBot, BOT_COMMANDS
};
