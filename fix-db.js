const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const db = new Database('rental.db');

console.log('Checking database...');

// 1. Check columns
const tableInfo = db.prepare("PRAGMA table_info(users)").all();
const columns = tableInfo.map(c => c.name);

const required = ['username', 'password', 'role', 'phone', 'recovery_key'];
for (const col of required) {
    if (!columns.includes(col)) {
        console.log(`Adding missing column: ${col}`);
        let def = "TEXT";
        if (col === 'role') def = "TEXT DEFAULT 'admin'";
        if (col === 'phone') def = "TEXT DEFAULT ''";
        db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
    }
}

// 2. Ensure Admin exists
const admin = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
const hashed = bcrypt.hashSync('admin', 12);
const recoveryKey = crypto.randomBytes(8).toString('hex');

if (!admin) {
    console.log('Creating admin user...');
    db.prepare("INSERT INTO users (username, password, role, phone, recovery_key) VALUES (?, ?, ?, ?, ?)")
        .run('admin', hashed, 'admin', '', recoveryKey);
} else {
    console.log('Updating admin password to "admin"...');
    db.prepare("UPDATE users SET password = ? WHERE username = 'admin'").run(hashed);
    if (!admin.recovery_key) {
        db.prepare("UPDATE users SET recovery_key = ? WHERE username = 'admin'").run(recoveryKey);
    }
}

// 3. Ensure all users have keys
db.prepare("UPDATE users SET recovery_key = ? WHERE recovery_key IS NULL").run(crypto.randomBytes(8).toString('hex'));

console.log('Done.');
process.exit(0);
