const Database = require('better-sqlite3');
const db = new Database('rental.db');
const users = db.prepare('SELECT id, username, role, phone, recovery_key, created_at FROM users').all();
console.log(JSON.stringify(users, null, 2));
process.exit(0);
