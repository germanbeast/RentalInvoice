/* ===========================
   Database Module (SQLite)
   =========================== */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'rental.db');

let db;

function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        initSchema();
    }
    return db;
}

// =======================
// Schema
// =======================
function initSchema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'admin',
            phone TEXT DEFAULT '',
            telegram_id TEXT DEFAULT '',
            recovery_key TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS guests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT,
            address TEXT,
            phone TEXT,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS invoices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            invoice_number TEXT UNIQUE NOT NULL,
            guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
            guest_name TEXT,
            invoice_date DATE,
            arrival DATE,
            departure DATE,
            total_amount REAL DEFAULT 0,
            is_paid BOOLEAN DEFAULT 0,
            payment_method TEXT,
            payment_date DATE,
            data JSON NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS branding (
            id INTEGER PRIMARY KEY DEFAULT 1,
            logo_base64 TEXT,
            primary_color TEXT DEFAULT '#6366f1',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date DATE NOT NULL,
            amount REAL NOT NULL,
            category TEXT,
            description TEXT,
            source TEXT DEFAULT 'local',
            paperless_id INTEGER UNIQUE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uid TEXT UNIQUE NOT NULL,
            summary TEXT,
            checkin DATE,
            checkout DATE,
            description TEXT,
            notified BOOLEAN DEFAULT 0,
            reminder_sent BOOLEAN DEFAULT 0,
            nuki_pin TEXT,
            nuki_auth_id TEXT,
            guest_id INTEGER REFERENCES guests(id) ON DELETE SET NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS notification_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            message TEXT,
            status TEXT DEFAULT 'sent',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS telegram_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT UNIQUE NOT NULL,
            name TEXT DEFAULT '',
            username TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    // Migrations
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const hasTgId = tableInfo.some(col => col.name === 'telegram_id');
    if (!hasTgId) {
        db.exec("ALTER TABLE users ADD COLUMN telegram_id TEXT DEFAULT ''");
        console.log('✅ Migration: telegram_id Spalte zu users Tabelle hinzugefügt.');
    }

    console.log('✅ Datenbank-Schema initialisiert.');
}

// =======================
// Users
// =======================
function getUser(username) {
    return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getAllUsers() {
    return getDb().prepare('SELECT id, username, role, phone, recovery_key, created_at FROM users ORDER BY created_at').all();
}

function getUserByPhone(phone) {
    if (!phone) return null;
    // Normalize incoming: remove all non-digits (e.g. 49151...)
    const cleaned = phone.replace(/[^\d]/g, '');
    if (cleaned.length < 5) return null;

    // Use the last 9 digits for matching (German mobile standard)
    const suffix = cleaned.slice(-9);

    // Search in DB, also normalizing the stored numbers on the fly
    return getDb().prepare(`
        SELECT * FROM users 
        WHERE REPLACE(REPLACE(phone, '+', ''), ' ', '') LIKE ?
    `).get(`%${suffix}`);
}

function getUserByTelegramId(tgId) {
    if (!tgId) return null;
    return getDb().prepare("SELECT * FROM users WHERE telegram_id = ?").get(String(tgId));
}

function isTelegramIdAuthorized(tgId) {
    if (!tgId) return false;
    const strId = String(tgId);

    // 1. Check users table
    const user = getUserByTelegramId(strId);
    if (user) {
        console.log(`[DB] TG-Autorisierung (Tabelle): ID ${strId} erlaubt.`);
        return true;
    }

    // 2. Check settings (global tg_ids list)
    // getAllSettings() auto-parses JSON, so tg_ids may already be an Array
    const settings = getAllSettings();
    if (settings.tg_ids) {
        try {
            const rawIds = settings.tg_ids;
            let allowedIds;
            if (Array.isArray(rawIds)) {
                allowedIds = rawIds.map(String);
            } else if (typeof rawIds === 'string' && rawIds.trim()) {
                allowedIds = JSON.parse(rawIds).map(String);
            } else {
                allowedIds = [];
            }
            if (allowedIds.includes(strId)) {
                console.log(`[DB] TG-Autorisierung (Einstellungen): ID ${strId} erlaubt.`);
                return true;
            }
        } catch (e) {
            console.error('[DB] Fehler beim Parsen von tg_ids Settings:', e.message);
        }
    }

    console.warn(`[DB] TG-Autorisierung FEHLGESCHLAGEN: ID ${strId} nicht gefunden.`);
    return false;
}

function createUser(username, hashedPassword, role = 'admin', phone = '', telegramId = '') {
    const recoveryKey = require('crypto').randomBytes(8).toString('hex'); // 16 chars
    return getDb().prepare(
        'INSERT OR REPLACE INTO users (username, password, role, phone, telegram_id, recovery_key) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(username, hashedPassword, role, phone, telegramId, recoveryKey);
}

function verifyRecoveryKey(username, key) {
    const user = getUser(username);
    if (!user || !user.recovery_key) return false;
    return user.recovery_key.toLowerCase() === key.trim().toLowerCase();
}

function updateUserPassword(username, hashedPassword) {
    return getDb().prepare(
        'UPDATE users SET password = ? WHERE username = ?'
    ).run(hashedPassword, username);
}

function updateUser(id, data) {
    const db = getDb();
    if (data.password) {
        db.prepare('UPDATE users SET username = ?, password = ?, role = ?, phone = ? WHERE id = ?')
            .run(data.username, data.password, data.role || 'admin', data.phone || '', id);
    } else {
        db.prepare('UPDATE users SET username = ?, role = ?, phone = ? WHERE id = ?')
            .run(data.username, data.role || 'admin', data.phone || '', id);
    }
}

function deleteUser(id) {
    return getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}

function initDefaultUser() {
    const defaultPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const existing = getUser('admin');

    if (!existing) {
        const hashed = bcrypt.hashSync(defaultPassword, 12);
        createUser('admin', hashed, 'admin');
        console.log('✅ Standard-Benutzer "admin" erstellt.');
    } else {
        // Sync password if ADMIN_PASSWORD env var changed
        if (!bcrypt.compareSync(defaultPassword, existing.password)) {
            console.log('🔄 ADMIN_PASSWORD hat sich geändert. Aktualisiere...');
            updateUserPassword('admin', bcrypt.hashSync(defaultPassword, 12));
            console.log('✅ Admin-Passwort synchronisiert.');
        }
    }

    // Ensure columns exist (for existing databases)
    try {
        getDb().prepare("SELECT phone FROM users LIMIT 1").get();
    } catch (e) {
        getDb().exec("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''");
        console.log('🔄 Spalte "phone" zur User-Tabelle hinzugefügt.');
    }
    try {
        getDb().prepare("SELECT recovery_key FROM users LIMIT 1").get();
    } catch (e) {
        getDb().exec("ALTER TABLE users ADD COLUMN recovery_key TEXT");
        console.log('🔄 Spalte "recovery_key" zur User-Tabelle hinzugefügt.');
        // Generate keys for existing users
        const users = getAllUsers();
        for (const u of users) {
            const k = require('crypto').randomBytes(8).toString('hex');
            getDb().prepare("UPDATE users SET recovery_key = ? WHERE id = ?").run(k, u.id);
        }
    }
}

// Migrate from users.json if it exists
function migrateUsersJson() {
    const usersFile = path.join(__dirname, 'users.json');
    if (fs.existsSync(usersFile)) {
        try {
            const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
            for (const [username, userData] of Object.entries(users)) {
                const existing = getUser(username);
                if (!existing) {
                    createUser(username, userData.password, userData.role || 'admin');
                    console.log(`📦 Migriert: Benutzer "${username}" aus users.json`);
                }
            }
            fs.renameSync(usersFile, usersFile + '.bak');
            console.log('✅ users.json → users.json.bak (Migration abgeschlossen)');
        } catch (e) {
            console.error('⚠️ Migration von users.json fehlgeschlagen:', e.message);
        }
    }
}

// =======================
// Settings
// =======================
function getSetting(key) {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
    const val = typeof value === 'string' ? value : JSON.stringify(value);
    return getDb().prepare(
        'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
    ).run(key, val);
}

function getAllSettings() {
    const rows = getDb().prepare('SELECT key, value FROM settings').all();
    const result = {};
    for (const row of rows) {
        try { result[row.key] = JSON.parse(row.value); } catch { result[row.key] = row.value; }
    }
    return result;
}

function setAllSettings(settings) {
    const stmt = getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const transaction = getDb().transaction((items) => {
        for (const [key, value] of Object.entries(items)) {
            const val = typeof value === 'string' ? value : JSON.stringify(value);
            stmt.run(key, val);
        }
    });
    transaction(settings);
}

// =======================
// Guests
// =======================
function getAllGuests(search = '') {
    if (search) {
        const q = `%${search}%`;
        return getDb().prepare(
            `SELECT g.*, COUNT(i.id) as invoice_count 
             FROM guests g LEFT JOIN invoices i ON i.guest_id = g.id 
             WHERE g.name LIKE ? OR g.email LIKE ? OR g.phone LIKE ?
             GROUP BY g.id ORDER BY g.updated_at DESC`
        ).all(q, q, q);
    }
    return getDb().prepare(
        `SELECT g.*, COUNT(i.id) as invoice_count 
         FROM guests g LEFT JOIN invoices i ON i.guest_id = g.id 
         GROUP BY g.id ORDER BY g.updated_at DESC`
    ).all();
}

function getGuestById(id) {
    return getDb().prepare('SELECT * FROM guests WHERE id = ?').get(id);
}

function createGuest(data) {
    const result = getDb().prepare(
        `INSERT INTO guests (name, email, address, phone, notes) 
         VALUES (?, ?, ?, ?, ?)`
    ).run(data.name, data.email || null, data.address || null, data.phone || null, data.notes || null);
    return { id: result.lastInsertRowid, ...data };
}

function updateGuest(id, data) {
    return getDb().prepare(
        `UPDATE guests SET name = ?, email = ?, address = ?, phone = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
    ).run(data.name, data.email || null, data.address || null, data.phone || null, data.notes || null, id);
}

function deleteGuest(id) {
    return getDb().prepare('DELETE FROM guests WHERE id = ?').run(id);
}

function findOrCreateGuest(name, email, address) {
    // Try to find by email first, then by name
    let guest = null;
    if (email) {
        guest = getDb().prepare('SELECT * FROM guests WHERE email = ?').get(email);
    }
    if (!guest && name) {
        guest = getDb().prepare('SELECT * FROM guests WHERE name = ?').get(name);
    }
    if (guest) {
        // Update if address changed
        if (address && address !== guest.address) {
            updateGuest(guest.id, { ...guest, address });
        }
        return guest;
    }
    // Create new guest
    return createGuest({ name, email, address });
}

// =======================
// Invoices
// =======================
function getAllInvoices(search = '') {
    if (search) {
        const q = `%${search}%`;
        return getDb().prepare(
            `SELECT i.*, g.name as guest_display_name 
             FROM invoices i LEFT JOIN guests g ON i.guest_id = g.id 
             WHERE i.invoice_number LIKE ? OR i.guest_name LIKE ? OR g.name LIKE ?
             ORDER BY i.created_at DESC`
        ).all(q, q, q);
    }
    return getDb().prepare(
        `SELECT i.*, g.name as guest_display_name 
         FROM invoices i LEFT JOIN guests g ON i.guest_id = g.id 
         ORDER BY i.created_at DESC`
    ).all();
}

function getInvoicesByGuestId(guestId) {
    return getDb().prepare(
        `SELECT * FROM invoices WHERE guest_id = ? ORDER BY created_at DESC`
    ).all(guestId);
}

function getOpenInvoices() {
    return getDb().prepare(`
        SELECT i.*, g.name as guest_display_name 
        FROM invoices i 
        LEFT JOIN guests g ON i.guest_id = g.id 
        WHERE i.is_paid = 0 
        ORDER BY i.invoice_date DESC
    `).all();
}

function getNextInvoiceNumber() {
    const currentYear = new Date().getFullYear();
    const prefix = `${currentYear}-`;
    const lastInvoice = getDb().prepare("SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1").get(`${prefix}%`);

    let nextNr = 1;
    if (lastInvoice) {
        const parts = lastInvoice.invoice_number.split('-');
        if (parts.length === 2 && parts[0] === String(currentYear)) {
            nextNr = parseInt(parts[1]) + 1;
        }
    }
    return `${prefix}${String(nextNr).padStart(3, '0')}`;
}

function saveInvoice(data) {
    // Find or create guest
    let guestId = data.guest_id || null;
    const guestName = data.gName || data.guest_name || '';

    if (!guestId && guestName) {
        const guest = findOrCreateGuest(guestName, data.gEmail || null, data.gAdresse || null);
        guestId = guest.id;
    }

    const jsonData = typeof data === 'string' ? data : JSON.stringify(data);

    // Upsert by invoice_number
    const existing = getDb().prepare('SELECT id FROM invoices WHERE invoice_number = ?').get(data.rNummer || data.invoice_number);

    if (existing) {
        getDb().prepare(
            `UPDATE invoices SET guest_id = ?, guest_name = ?, invoice_date = ?, arrival = ?, departure = ?,
             total_amount = ?, is_paid = ?, payment_method = ?, payment_date = ?, data = ?
             WHERE id = ?`
        ).run(
            guestId, guestName, data.rDatum || data.invoice_date || null,
            data.aAnreise || data.arrival || null, data.aAbreise || data.departure || null,
            data.totalAmount || data.total_amount || 0,
            data.zBezahlt || data.is_paid ? 1 : 0,
            data.zMethode || data.payment_method || null,
            data.zDatum || data.payment_date || null,
            jsonData, existing.id
        );
        return { id: existing.id, updated: true };
    } else {
        const result = getDb().prepare(
            `INSERT INTO invoices (invoice_number, guest_id, guest_name, invoice_date, arrival, departure,
             total_amount, is_paid, payment_method, payment_date, data)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            data.rNummer || data.invoice_number,
            guestId, guestName, data.rDatum || data.invoice_date || null,
            data.aAnreise || data.arrival || null, data.aAbreise || data.departure || null,
            data.totalAmount || data.total_amount || 0,
            data.zBezahlt || data.is_paid ? 1 : 0,
            data.zMethode || data.payment_method || null,
            data.zDatum || data.payment_date || null,
            jsonData
        );
        return { id: result.lastInsertRowid, updated: false };
    }
}

function deleteInvoice(id) {
    return getDb().prepare('DELETE FROM invoices WHERE id = ?').run(id);
}

// =======================
// Branding
// =======================
function getBranding() {
    return getDb().prepare('SELECT * FROM branding WHERE id = 1').get() || { logo_base64: null, primary_color: '#6366f1' };
}

function saveBranding(data) {
    const existing = getDb().prepare('SELECT id FROM branding WHERE id = 1').get();
    if (existing) {
        return getDb().prepare(
            'UPDATE branding SET logo_base64 = ?, primary_color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
        ).run(data.logo_base64 || null, data.primary_color || '#6366f1');
    } else {
        return getDb().prepare(
            'INSERT INTO branding (id, logo_base64, primary_color) VALUES (1, ?, ?)'
        ).run(data.logo_base64 || null, data.primary_color || '#6366f1');
    }
}

// =======================
// Expenses
// =======================
function getAllExpenses() {
    return getDb().prepare('SELECT * FROM expenses ORDER BY date DESC, created_at DESC').all();
}

function createExpense(data) {
    const result = getDb().prepare(
        `INSERT INTO expenses (date, amount, category, description, source, paperless_id) 
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(data.date, data.amount, data.category || null, data.description || null, data.source || 'local', data.paperless_id || null);
    return { id: result.lastInsertRowid, ...data };
}

function deleteExpense(id) {
    return getDb().prepare('DELETE FROM expenses WHERE id = ?').run(id);
}

function getExpenseByPaperlessId(paperlessId) {
    return getDb().prepare('SELECT * FROM expenses WHERE paperless_id = ?').get(paperlessId);
}

// =======================
// Statistics
// =======================
function getStats() {
    const db = getDb();

    // Revenue by month (last 12 months)
    const revenueByMonth = db.prepare(`
        SELECT strftime('%Y-%m', invoice_date) as month, SUM(total_amount) as total
        FROM invoices
        WHERE invoice_date >= date('now', '-12 months')
        GROUP BY month
        ORDER BY month ASC
    `).all();

    // Expenses by month (last 12 months)
    const expensesByMonth = db.prepare(`
        SELECT strftime('%Y-%m', date) as month, SUM(amount) as total
        FROM expenses
        WHERE date >= date('now', '-12 months')
        GROUP BY month
        ORDER BY month ASC
    `).all();

    // Key metrics
    const totals = db.prepare(`
        SELECT 
            (SELECT SUM(total_amount) FROM invoices) as total_revenue,
            (SELECT SUM(amount) FROM expenses) as total_expenses,
            (SELECT COUNT(*) FROM invoices) as invoice_count,
            (SELECT COUNT(*) FROM guests) as guest_count
    `).get();

    // Top guests by revenue
    const topGuests = db.prepare(`
        SELECT guest_name, SUM(total_amount) as total, COUNT(*) as count
        FROM invoices
        WHERE guest_name IS NOT NULL AND guest_name != ''
        GROUP BY guest_name
        ORDER BY total DESC
        LIMIT 5
    `).all();

    return {
        revenueByMonth,
        expensesByMonth,
        totals,
        topGuests
    };
}

// =======================
// Bookings & Notifications
// =======================
function getBookingByUid(uid) {
    const db = getDb();
    return db.prepare('SELECT * FROM bookings WHERE uid = ?').get(uid);
}

function upsertBooking(data) {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM bookings WHERE uid = ?').get(data.uid);
    if (existing) {
        db.prepare('UPDATE bookings SET summary = ?, checkin = ?, checkout = ?, description = ? WHERE uid = ?')
            .run(data.summary, data.checkin, data.checkout, data.description, data.uid);
        return { updated: true, id: existing.id };
    } else {
        const result = db.prepare('INSERT INTO bookings (uid, summary, checkin, checkout, description) VALUES (?, ?, ?, ?, ?)')
            .run(data.uid, data.summary, data.checkin, data.checkout, data.description);
        return { inserted: true, id: result.lastInsertRowid };
    }
}

function getUpcomingBookings(daysAhead = 2) {
    const db = getDb();
    return db.prepare(`
        SELECT * FROM bookings
        WHERE checkin BETWEEN date('now') AND date('now', '+' || ? || ' days')
          AND reminder_sent = 0
        ORDER BY checkin ASC
    `).all(daysAhead);
}

function markReminderSent(id) {
    const db = getDb();
    db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ?').run(id);
}

function logNotification(type, message, status = 'sent') {
    const db = getDb();
    db.prepare('INSERT INTO notification_log (type, message, status) VALUES (?, ?, ?)').run(type, message, status);
}

function getRecentNotifications(limit = 20) {
    const db = getDb();
    return db.prepare('SELECT * FROM notification_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

// =======================
// Bulk Migration (from localStorage)
// =======================
function migrateFromLocalStorage(data) {
    const results = { settings: 0, invoices: 0, guests: 0 };

    getDb().transaction(() => {
        // Settings
        const settingsKeys = ['vermieter', 'bank', 'paperless', 'smtp', 'nuki', 'booking_ical', 'rechnungsnr'];
        for (const key of settingsKeys) {
            if (data[key] !== undefined && data[key] !== null) {
                setSetting(key, data[key]);
                results.settings++;
            }
        }

        // Archive → invoices
        if (Array.isArray(data.archive)) {
            for (const inv of data.archive) {
                try {
                    saveInvoice(inv);
                    results.invoices++;
                } catch (e) {
                    console.warn(`⚠️ Migration: Rechnung ${inv.rNummer} übersprungen:`, e.message);
                }
            }
        }
    })();

    return results;
}

function updateBookingNukiData(id, pin, authId) {
    return getDb().prepare('UPDATE bookings SET nuki_pin = ?, nuki_auth_id = ? WHERE id = ?').run(pin, authId, id);
}

function getExpiredNukiAuths() {
    // Yesterday's date
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    return getDb().prepare(`
        SELECT id, nuki_auth_id 
        FROM bookings 
        WHERE checkout <= ? AND nuki_auth_id IS NOT NULL AND nuki_auth_id != ''
    `).all(dateStr);
}

function clearNukiAuth(id) {
    return getDb().prepare('UPDATE bookings SET nuki_auth_id = NULL WHERE id = ?').run(id);
}

function findBookingForStay(guestName, arrival, departure) {
    // Helper to link manual invoices to iCal bookings
    return getDb().prepare(`
        SELECT * FROM bookings 
        WHERE (summary LIKE ? OR description LIKE ?) 
        AND checkin = ? AND checkout = ?
        LIMIT 1
    `).get(`%${guestName}%`, `%${guestName}%`, arrival, departure);
}

// =======================
// Telegram Helper
// =======================
function getPendingTelegramRequests() {
    const db = getDb();
    return db.prepare('SELECT * FROM telegram_requests ORDER BY created_at DESC').all();
}

function addPendingTelegramRequest(chatId, name, username) {
    const db = getDb();
    try {
        db.prepare('INSERT INTO telegram_requests (chat_id, name, username) VALUES (?, ?, ?)')
            .run(String(chatId), name, username);
        return true; // Return true so we don't treat it as error
    } catch (e) {
        // Likely already exists
        return true; // Return true so we don't treat it as error
    }
}

function approveTelegramRequest(id) {
    const db = getDb();
    const req = db.prepare('SELECT * FROM telegram_requests WHERE id = ?').get(id);
    if (!req) return false;

    // Add to allowed IDs
    // getAllSettings() already parses JSON, so tg_ids may already be an array
    const settings = getAllSettings();
    let ids = [];
    const rawIds = settings.tg_ids;
    if (Array.isArray(rawIds)) {
        ids = rawIds.map(String);
    } else if (typeof rawIds === 'string' && rawIds.trim()) {
        try { ids = JSON.parse(rawIds); } catch (e) { ids = []; }
    }

    if (!ids.includes(req.chat_id)) {
        ids.push(req.chat_id);
    }

    setSetting('tg_ids', JSON.stringify(ids));

    // Remove request
    db.prepare('DELETE FROM telegram_requests WHERE id = ?').run(id);
    return true;
}

function denyTelegramRequest(id) {
    const db = getDb();
    db.prepare('DELETE FROM telegram_requests WHERE id = ?').run(id);
    return true;
}

// =======================
// Init & Export
// =======================
function init() {
    getDb();
    migrateUsersJson();
    initDefaultUser();
    console.log(`📁 Datenbank: ${DB_PATH}`);
}

function close() {
    if (db) {
        db.close();
        db = null;
    }
}

module.exports = {
    init,
    close,
    getDb,
    // Users
    getUser,
    getAllUsers,
    getUserByPhone,
    getUserByTelegramId,
    createUser,
    updateUserPassword,
    updateUser,
    deleteUser,
    verifyRecoveryKey,
    // Settings
    getSetting,
    setSetting,
    getAllSettings,
    setAllSettings,
    // Guests
    getAllGuests,
    getGuestById,
    createGuest,
    updateGuest,
    deleteGuest,
    findOrCreateGuest,
    // Invoices
    getAllInvoices,
    getInvoicesByGuestId,
    getOpenInvoices,
    getNextInvoiceNumber,
    saveInvoice,
    deleteInvoice,
    // Branding
    getBranding,
    saveBranding,
    // Expenses
    getAllExpenses,
    createExpense,
    deleteExpense,
    getExpenseByPaperlessId,
    // Stats
    getStats,
    // Bookings & Notifications
    getBookingByUid,
    upsertBooking,
    getUpcomingBookings,
    markReminderSent,
    logNotification,
    getRecentNotifications,
    updateBookingNukiData,
    getExpiredNukiAuths,
    clearNukiAuth,
    findBookingForStay,
    isTelegramIdAuthorized,
    // TG Registration
    getPendingTelegramRequests,
    addPendingTelegramRequest,
    approveTelegramRequest,
    denyTelegramRequest,
    // Migration
    migrateFromLocalStorage
};
