const db = require('better-sqlite3')('rental.db');

console.log('--- DB REPAIR START ---');

// 1. Inspect Settings
try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'tg_ids'").get();
    console.log('Current tg_ids value:', row ? `"${row.value}"` : 'NULL');

    if (row && row.value) {
        try {
            JSON.parse(row.value);
            console.log('JSON is valid.');
        } catch (e) {
            console.error('JSON is INVALID:', e.message);
            console.log('Resetting tg_ids to empty array []...');
            db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run('tg_ids', '[]');
            console.log('Reset complete.');
        }
    } else {
        console.log('tg_ids is empty/missing. Setting to []...');
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run('tg_ids', '[]');
    }
} catch (e) {
    console.error('Error checking settings:', e);
}

// 2. Add User ID manually to be safe
const myId = '6858093888';
try {
    const current = db.prepare("SELECT value FROM settings WHERE key = 'tg_ids'").get();
    let ids = JSON.parse(current.value || '[]');
    if (!ids.includes(myId)) {
        ids.push(myId);
        console.log(`Adding ID ${myId} to settings...`);
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run('tg_ids', JSON.stringify(ids));
        console.log('ID added.');
    } else {
        console.log(`ID ${myId} is already in settings.`);
    }
} catch (e) {
    console.error('Error adding ID:', e);
}

// 3. Verify Users Table
try {
    const user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(myId);
    console.log('User table check for ID:', user ? 'FOUND' : 'NOT FOUND');
} catch (e) {
    console.error('Error checking user table:', e);
}

console.log('--- DB REPAIR END ---');
