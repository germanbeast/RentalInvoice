/**
 * Web Push (PWA notifications on Android / iOS / desktop)
 *
 *  - VAPID keys are generated once and stored in setting `push_vapid` (never sent to the browser except the public key)
 *  - Subscriptions live in table push_subscriptions, one row per device/browser
 *  - mode 'bookings': only important messages (new booking, cancellation, double booking, lock warnings)
 *    mode 'all':      everything that also goes to Telegram/WhatsApp
 */

const webpush = require('web-push');

const BOOKING_TYPES = new Set(['new_booking', 'booking_cancelled', 'overlap_warning', 'cancel_guard']);
const IMPORTANT_TYPES = new Set([...BOOKING_TYPES, 'nuki_unlocked', 'nuki_battery', 'nuki_offline', 'nuki_emergency']);
const MAX_FAILS = 5; // drop a subscription after this many consecutive non-permanent failures

function createPush({ db }) {
    const sql = () => db.getDb();
    let ready = false;

    function init() {
        sql().exec(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                endpoint TEXT UNIQUE NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                label TEXT DEFAULT '',
                mode TEXT DEFAULT 'bookings',
                username TEXT DEFAULT '',
                fail_count INTEGER DEFAULT 0,
                last_sent_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        let keys = db.getSetting('push_vapid');
        if (!keys || !keys.publicKey || !keys.privateKey) {
            keys = webpush.generateVAPIDKeys();
            db.setSetting('push_vapid', keys);
            console.log('🔔 Web-Push: neue VAPID-Schlüssel erzeugt.');
        }
        webpush.setVapidDetails(subject(), keys.publicKey, keys.privateKey);
        ready = true;
    }

    // Apple rejects VAPID subjects pointing to localhost, so fall back to the project URL
    function subject() {
        const v = db.getSetting('vermieter') || {};
        const mail = String(v.email || '').trim();
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) ? `mailto:${mail}` : 'https://github.com/germanbeast/RentalInvoice';
    }

    function publicKey() {
        const keys = db.getSetting('push_vapid');
        return keys ? keys.publicKey : null;
    }

    function subscribe(sub, { label = '', mode = 'bookings', username = '' } = {}) {
        if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys ||
            typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') {
            throw new Error('Ungültiges Abo');
        }
        const m = mode === 'all' ? 'all' : 'bookings';
        sql().prepare(`
            INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, mode, username)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
                label = excluded.label, mode = excluded.mode, username = excluded.username, fail_count = 0
        `).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(label).substring(0, 80), m, username);
        return sql().prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(sub.endpoint).id;
    }

    function list() {
        return sql().prepare('SELECT id, endpoint, label, mode, username, last_sent_at, created_at FROM push_subscriptions ORDER BY created_at').all();
    }

    function setMode(id, mode) {
        return sql().prepare('UPDATE push_subscriptions SET mode = ? WHERE id = ?').run(mode === 'all' ? 'all' : 'bookings', id).changes > 0;
    }

    function removeById(id) {
        return sql().prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id).changes > 0;
    }

    function removeByEndpoint(endpoint) {
        return sql().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0;
    }

    /** Telegram markdown message -> { title, body } (first line is the title) */
    function toPayload(message) {
        const plain = String(message || '').replace(/[*_`]/g, '').trim();
        const [first, ...rest] = plain.split('\n');
        return { title: first.trim() || 'Ferienwohnung', body: rest.join('\n').trim() };
    }

    async function sendRow(row, payload) {
        try {
            await webpush.sendNotification(
                { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
                JSON.stringify(payload),
                { TTL: 24 * 60 * 60, urgency: 'high' }
            );
            sql().prepare('UPDATE push_subscriptions SET fail_count = 0, last_sent_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
            return true;
        } catch (e) {
            const status = e.statusCode;
            if (status === 404 || status === 410 || (row.fail_count || 0) + 1 >= MAX_FAILS) {
                removeById(row.id); // device unsubscribed or app removed
                console.log(`🔔 Push-Abo ${row.id} (${row.label || 'Gerät'}) entfernt (${status || e.message}).`);
            } else {
                sql().prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?').run(row.id);
                console.warn(`⚠️ Push an ${row.label || 'Gerät ' + row.id} fehlgeschlagen:`, status || e.message);
            }
            return false;
        }
    }

    /**
     * Send a notification to all matching devices. Returns true if at least one device got it.
     * type: notification type (see BOOKING_TYPES); opts.url: page opened on tap; opts.only: restrict to one subscription id
     */
    async function send(message, type = 'other', opts = {}) {
        if (!ready) return false;
        let rows = sql().prepare('SELECT * FROM push_subscriptions').all();
        if (opts.only) rows = rows.filter(r => r.id === opts.only);
        else rows = rows.filter(r => r.mode === 'all' || IMPORTANT_TYPES.has(type));
        // Devices of users whose rights do not cover this kind of message are skipped (see permissions.js)
        if (opts.canReceive && !opts.only) rows = rows.filter(r => opts.canReceive(r.username, type));
        if (rows.length === 0) return false;

        const payload = { ...toPayload(message), url: opts.url || (BOOKING_TYPES.has(type) ? '/?view=bookings' : '/'), tag: opts.tag };
        const results = await Promise.all(rows.map(r => sendRow(r, payload)));
        return results.some(Boolean);
    }

    return { init, publicKey, subscribe, list, setMode, removeById, removeByEndpoint, send, BOOKING_TYPES };
}

module.exports = createPush;
