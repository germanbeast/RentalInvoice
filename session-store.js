/**
 * express-session store in the app's SQLite database.
 * Keeps logins across restarts (updates, PM2 restarts) - required for "Angemeldet bleiben".
 */

const PRUNE_MS = 60 * 60 * 1000;

module.exports = function createSessionStore(session, db) {
    const sql = () => db.getDb();

    class SqliteStore extends session.Store {
        constructor() {
            super();
            sql().exec(`
                CREATE TABLE IF NOT EXISTS sessions (
                    sid TEXT PRIMARY KEY,
                    sess TEXT NOT NULL,
                    expires INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
            `);
            this.prune();
            const timer = setInterval(() => this.prune(), PRUNE_MS);
            if (timer.unref) timer.unref();
        }

        expiry(sess) {
            const exp = sess && sess.cookie && sess.cookie.expires;
            return exp ? new Date(exp).getTime() : Date.now() + 24 * 60 * 60 * 1000;
        }

        prune() {
            try { sql().prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); } catch (e) { /* next round */ }
        }

        get(sid, cb) {
            try {
                const row = sql().prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
                if (!row || row.expires < Date.now()) return cb(null, null);
                cb(null, JSON.parse(row.sess));
            } catch (e) { cb(e); }
        }

        set(sid, sess, cb) {
            try {
                sql().prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)')
                    .run(sid, JSON.stringify(sess), this.expiry(sess));
                cb && cb(null);
            } catch (e) { cb && cb(e); }
        }

        touch(sid, sess, cb) {
            try {
                sql().prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(this.expiry(sess), sid);
                cb && cb(null);
            } catch (e) { cb && cb(e); }
        }

        destroy(sid, cb) {
            try {
                sql().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
                cb && cb(null);
            } catch (e) { cb && cb(e); }
        }
    }

    return new SqliteStore();
};
