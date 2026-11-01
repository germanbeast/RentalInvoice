/* ===========================
   Automatische Datensicherung
   ===========================
   Packs a consistent SQLite snapshot, .env, users.json and uploads/ into a tar.gz, encrypts it with a password
   (OpenSSL-compatible AES-256-CBC + PBKDF2, so it can be decrypted without this app) and stores it in backups/.
   Optionally uploads it to S3-compatible storage (Cloudflare R2, Backblaze, Hetzner Object Storage), WebDAV
   (Nextcloud, Hetzner Storage Box) and/or sends it to the Telegram admins. Runs daily at the configured time;
   a failed run is reported via the notification channels. Restore: backup-restore.js, see BACKUP.md. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');
const axios = require('axios');

const APP_DIR = __dirname;
const BACKUP_DIR = path.join(APP_DIR, 'backups');
const FILE_PREFIX = 'beckhome-backup-';
const FILE_SUFFIX = '.tar.gz.enc';
const PBKDF2_ITER = 200000;
const TELEGRAM_LIMIT = 49 * 1024 * 1024;
const MIN_PASSWORD = 10;

// Paths (relative to the app dir) that go into every backup. Directories are walked recursively.
const INCLUDE = ['.env', 'users.json', 'uploads'];
const WHATSAPP_DIR = '.wwebjs_auth';
const SKIP_NAMES = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile', 'LOCK']);

let deps = { db: null, notify: async () => {}, telegram: () => null };
let running = null;

// =======================
// Config / state
// =======================
const DEFAULTS = {
    enabled: false,
    time: '03:30',
    password: '',
    keepLocal: 7,
    keepRemote: 30,
    includeWhatsApp: false,
    notifySuccess: false,
    s3: { enabled: false, endpoint: '', region: 'auto', bucket: '', accessKey: '', secretKey: '', prefix: 'beckhome/' },
    webdav: { enabled: false, url: '', user: '', pass: '' },
    telegram: { enabled: false }
};
const SECRETS = [['password'], ['s3', 'secretKey'], ['webdav', 'pass']];
const MASK = '••••••••';

function getConfig() {
    let c = deps.db.getSetting('backup');
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = null; } }
    c = c && typeof c === 'object' ? c : {};
    return {
        ...DEFAULTS, ...c,
        s3: { ...DEFAULTS.s3, ...(c.s3 || {}) },
        webdav: { ...DEFAULTS.webdav, ...(c.webdav || {}) },
        telegram: { ...DEFAULTS.telegram, ...(c.telegram || {}) }
    };
}

function getState() {
    let s = deps.db.getSetting('backup_state');
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { s = null; } }
    return s && typeof s === 'object' ? s : { history: [] };
}

function saveState(s) { deps.db.setSetting('backup_state', s); }

function getAt(obj, [a, b]) { return b ? (obj[a] || {})[b] : obj[a]; }
function setAt(obj, [a, b], v) { if (b) { obj[a] = obj[a] || {}; obj[a][b] = v; } else obj[a] = v; }

/** Config for the browser: secrets replaced by a mask. */
function publicConfig() {
    const c = JSON.parse(JSON.stringify(getConfig()));
    for (const p of SECRETS) if (getAt(c, p)) setAt(c, p, MASK);
    return c;
}

const str = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);
const bool = v => v === true || v === 'true' || v === 1 || v === '1';
const int = (v, def, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };

/** Validates and stores the config from the admin form. Masked secrets keep the stored value. */
function saveConfig(input) {
    if (!input || typeof input !== 'object') throw new Error('Ungültige Einstellungen');
    const old = getConfig();
    const s3 = input.s3 || {}, wd = input.webdav || {}, tg = input.telegram || {};
    const c = {
        enabled: bool(input.enabled),
        time: /^([01]\d|2[0-3]):[0-5]\d$/.test(str(input.time)) ? str(input.time) : DEFAULTS.time,
        password: str(input.password, 200),
        keepLocal: int(input.keepLocal, DEFAULTS.keepLocal, 1, 365),
        keepRemote: int(input.keepRemote, DEFAULTS.keepRemote, 0, 3650),
        includeWhatsApp: bool(input.includeWhatsApp),
        notifySuccess: bool(input.notifySuccess),
        s3: {
            enabled: bool(s3.enabled),
            endpoint: str(s3.endpoint).replace(/\/+$/, ''),
            region: str(s3.region, 50) || 'auto',
            bucket: str(s3.bucket, 100),
            accessKey: str(s3.accessKey, 200),
            secretKey: str(s3.secretKey, 200),
            prefix: str(s3.prefix, 200).replace(/^\/+/, '')
        },
        webdav: { enabled: bool(wd.enabled), url: str(wd.url).replace(/\/+$/, ''), user: str(wd.user, 200), pass: str(wd.pass, 200) },
        telegram: { enabled: bool(tg.enabled) }
    };
    for (const p of SECRETS) if (getAt(c, p) === MASK) setAt(c, p, getAt(old, p) || '');
    if (c.enabled && c.password.length < MIN_PASSWORD) throw new Error(`Das Backup-Passwort muss mindestens ${MIN_PASSWORD} Zeichen haben.`);
    if (c.s3.enabled) {
        if (!/^https:\/\//i.test(c.s3.endpoint)) throw new Error('S3: Endpunkt muss mit https:// beginnen.');
        if (!c.s3.bucket || !c.s3.accessKey || !c.s3.secretKey) throw new Error('S3: Bucket, Access Key und Secret Key ausfüllen.');
    }
    if (c.webdav.enabled && !/^https:\/\//i.test(c.webdav.url)) throw new Error('WebDAV: Adresse muss mit https:// beginnen.');
    deps.db.setSetting('backup', c);
    return publicConfig();
}

// =======================
// Archive (tar) + encryption
// =======================
function tarHeader(name, size, mtime, type = '0') {
    const h = Buffer.alloc(512, 0);
    let prefix = '';
    let n = name;
    if (Buffer.byteLength(n) > 100) {
        // ustar: split at a "/" so that name <= 100 and prefix <= 155 bytes
        const i = n.lastIndexOf('/', n.length - 1);
        let cut = -1;
        for (let j = i; j > 0; j = n.lastIndexOf('/', j - 1)) {
            if (Buffer.byteLength(n.slice(j + 1)) <= 100 && Buffer.byteLength(n.slice(0, j)) <= 155) { cut = j; break; }
        }
        if (cut < 0) return null;
        prefix = n.slice(0, cut);
        n = n.slice(cut + 1);
    }
    const oct = (v, len) => v.toString(8).padStart(len - 1, '0') + '\0';
    h.write(n, 0, 100, 'utf8');
    h.write(oct(type === '5' ? 0o755 : 0o600, 8), 100, 'ascii');
    h.write(oct(0, 8), 108, 'ascii');
    h.write(oct(0, 8), 116, 'ascii');
    h.write(oct(size, 12), 124, 'ascii');
    h.write(oct(Math.floor(mtime / 1000), 12), 136, 'ascii');
    h.write('        ', 148, 'ascii');
    h.write(type, 156, 'ascii');
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    h.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return h;
}

async function walk(rel, out) {
    const abs = path.join(APP_DIR, rel);
    let st;
    try { st = await fsp.lstat(abs); } catch (e) { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
        const entries = await fsp.readdir(abs);
        for (const e of entries.sort()) await walk(path.posix.join(rel, e), out);
    } else if (st.isFile() && !SKIP_NAMES.has(path.basename(rel))) {
        out.push(rel);
    }
}

/** Async generator of tar blocks for [{ name, abs }] plus a manifest with sha256 of every file. */
async function* tarStream(files, meta, skipped) {
    const manifest = { ...meta, files: [] };
    for (const f of files) {
        let st, data;
        try {
            st = await fsp.stat(f.abs);
            data = await fsp.readFile(f.abs); // files are small (DB snapshot, photos, PDFs)
        } catch (e) { skipped.push(f.name); continue; }
        const header = tarHeader(f.name, data.length, st.mtimeMs);
        if (!header) { skipped.push(f.name); continue; }
        manifest.files.push({ name: f.name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
        yield header;
        yield data;
        const pad = (512 - (data.length % 512)) % 512;
        if (pad) yield Buffer.alloc(pad, 0);
    }
    const m = Buffer.from(JSON.stringify(manifest, null, 2));
    yield tarHeader('MANIFEST.json', m.length, Date.now());
    yield m;
    const pad = (512 - (m.length % 512)) % 512;
    if (pad) yield Buffer.alloc(pad, 0);
    yield Buffer.alloc(1024, 0);
}

/** OpenSSL `enc -aes-256-cbc -pbkdf2 -iter N -md sha256` compatible: "Salted__" + salt, key/iv from PBKDF2. */
function deriveKey(password, salt, iter = PBKDF2_ITER) {
    const kiv = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iter, 48, 'sha256');
    return { key: kiv.subarray(0, 32), iv: kiv.subarray(32, 48) };
}

function encryptStream(password) {
    const salt = crypto.randomBytes(8);
    const { key, iv } = deriveKey(password, salt);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let first = true;
    return new Transform({
        transform(chunk, enc, cb) {
            if (first) { this.push(Buffer.concat([Buffer.from('Salted__'), salt])); first = false; }
            cb(null, cipher.update(chunk));
        },
        flush(cb) {
            if (first) this.push(Buffer.concat([Buffer.from('Salted__'), salt]));
            cb(null, cipher.final());
        }
    });
}

function decryptStream(password, iter = PBKDF2_ITER) {
    let head = Buffer.alloc(0);
    let decipher = null;
    return new Transform({
        transform(chunk, enc, cb) {
            try {
                if (!decipher) {
                    head = Buffer.concat([head, chunk]);
                    if (head.length < 16) return cb();
                    if (head.subarray(0, 8).toString('latin1') !== 'Salted__') return cb(new Error('Keine Backup-Datei (Kopf fehlt)'));
                    const { key, iv } = deriveKey(password, head.subarray(8, 16), iter);
                    decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
                    chunk = head.subarray(16);
                }
                cb(null, decipher.update(chunk));
            } catch (e) { cb(e); }
        },
        flush(cb) {
            try {
                if (!decipher) return cb(new Error('Datei zu kurz'));
                cb(null, decipher.final());
            } catch (e) { cb(new Error('Falsches Passwort oder beschädigte Datei')); }
        }
    });
}

function stamp(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function createArchive(cfg) {
    await fsp.mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 });
    const name = `${FILE_PREFIX}${stamp()}${FILE_SUFFIX}`;
    const dest = path.join(BACKUP_DIR, name);
    const tmpDb = path.join(BACKUP_DIR, `.snapshot-${process.pid}-${Date.now()}.db`);
    const skipped = [];
    try {
        // Consistent snapshot while the app keeps running (WAL mode)
        await deps.db.getDb().backup(tmpDb);
        const files = [{ name: 'rental.db', abs: tmpDb }];
        const rels = [];
        for (const inc of INCLUDE) await walk(inc, rels);
        if (cfg.includeWhatsApp) await walk(WHATSAPP_DIR, rels);
        for (const r of rels) files.push({ name: r, abs: path.join(APP_DIR, r) });

        let version = '';
        try { version = require('./package.json').version; } catch (e) { /* ignore */ }
        const meta = { app: 'RentalInvoice', version, createdAt: new Date().toISOString(), pbkdf2Iter: PBKDF2_ITER };
        await pipeline(
            Readable.from(tarStream(files, meta, skipped)),
            zlib.createGzip({ level: 9 }),
            encryptStream(cfg.password),
            fs.createWriteStream(dest + '.part', { mode: 0o600 })
        );
        await fsp.rename(dest + '.part', dest);
        const st = await fsp.stat(dest);
        return { name, path: dest, size: st.size, files: files.length - skipped.length, skipped };
    } finally {
        await fsp.rm(tmpDb, { force: true }).catch(() => {});
        await fsp.rm(dest + '.part', { force: true }).catch(() => {});
    }
}

// =======================
// S3 (SigV4, path-style)
// =======================
const sha256hex = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const s3enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function s3Request(s3, method, key, { query = {}, body, bodyHash, headers = {}, responseType } = {}) {
    const url = new URL(s3.endpoint);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const region = s3.region || 'auto';
    const basePath = url.pathname.replace(/\/+$/, '');
    const canonPath = `${basePath}/${s3enc(s3.bucket)}${key ? '/' + key.split('/').map(s3enc).join('/') : ''}`;
    const qs = Object.keys(query).sort().map(k => `${s3enc(k)}=${s3enc(String(query[k]))}`).join('&');
    const payloadHash = bodyHash || sha256hex(body || '');
    const hdrs = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    for (const [k, v] of Object.entries(headers)) hdrs[k.toLowerCase()] = String(v);
    const signed = Object.keys(hdrs).sort();
    const canonical = [method, canonPath, qs, signed.map(k => `${k}:${hdrs[k].trim()}`).join('\n') + '\n', signed.join(';'), payloadHash].join('\n');
    const scope = `${day}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
    const kSign = hmac(hmac(hmac(hmac('AWS4' + s3.secretKey, day), region), 's3'), 'aws4_request');
    const sig = crypto.createHmac('sha256', kSign).update(toSign).digest('hex');
    const reqHeaders = { ...hdrs, Authorization: `AWS4-HMAC-SHA256 Credential=${s3.accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${sig}` };
    delete reqHeaders.host;
    return axios({
        method, url: `${url.origin}${canonPath}${qs ? '?' + qs : ''}`, headers: reqHeaders, data: body,
        maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 10 * 60 * 1000, responseType: responseType || 'text',
        transformResponse: r => r
    });
}

async function fileSha256(p) {
    const h = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(p), h);
    return h.digest('hex');
}

async function s3Upload(s3, file) {
    const key = (s3.prefix || '') + file.name;
    await s3Request(s3, 'PUT', key, {
        body: fs.createReadStream(file.path), bodyHash: await fileSha256(file.path),
        headers: { 'content-length': file.size, 'content-type': 'application/octet-stream' }
    });
    return key;
}

async function s3List(s3) {
    const names = [];
    let token = null;
    do {
        const query = { 'list-type': '2', prefix: s3.prefix || '' };
        if (token) query['continuation-token'] = token;
        const r = await s3Request(s3, 'GET', '', { query });
        const xml = String(r.data || '');
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) names.push(m[1].replace(/&amp;/g, '&'));
        const t = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && t ? t[1] : null;
    } while (token);
    return names;
}

async function s3Prune(s3, keep) {
    if (!keep) return 0;
    const ours = (await s3List(s3)).filter(k => path.posix.basename(k).startsWith(FILE_PREFIX) && k.endsWith(FILE_SUFFIX)).sort();
    let n = 0;
    for (const k of ours.slice(0, Math.max(0, ours.length - keep))) { await s3Request(s3, 'DELETE', k); n++; }
    return n;
}

// =======================
// WebDAV
// =======================
function davAuth(wd) { return wd.user ? { username: wd.user, password: wd.pass } : undefined; }

async function davUpload(wd, file) {
    await axios.request({ method: 'MKCOL', url: wd.url + '/', auth: davAuth(wd), timeout: 30000, validateStatus: () => true });
    await axios.put(`${wd.url}/${encodeURIComponent(file.name)}`, fs.createReadStream(file.path), {
        auth: davAuth(wd), headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size },
        maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 10 * 60 * 1000
    });
    return wd.url + '/' + file.name;
}

async function davList(wd) {
    const r = await axios.request({
        method: 'PROPFIND', url: wd.url + '/', auth: davAuth(wd), timeout: 30000, headers: { Depth: '1', 'Content-Type': 'application/xml' },
        data: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', responseType: 'text', transformResponse: x => x
    });
    const names = [];
    for (const m of String(r.data || '').matchAll(/<(?:[a-z0-9]+:)?href>([^<]+)<\/(?:[a-z0-9]+:)?href>/gi)) {
        const base = decodeURIComponent(m[1].replace(/\/+$/, '').split('/').pop() || '');
        if (base.startsWith(FILE_PREFIX) && base.endsWith(FILE_SUFFIX)) names.push(base);
    }
    return names;
}

async function davPrune(wd, keep) {
    if (!keep) return 0;
    const ours = (await davList(wd)).sort();
    let n = 0;
    for (const f of ours.slice(0, Math.max(0, ours.length - keep))) {
        await axios.delete(`${wd.url}/${encodeURIComponent(f)}`, { auth: davAuth(wd), timeout: 30000 });
        n++;
    }
    return n;
}

// =======================
// Telegram
// =======================
async function telegramSend(file) {
    const t = deps.telegram();
    if (!t || !t.bot) throw new Error('Telegram-Bot ist nicht aktiv');
    if (!t.ids.length) throw new Error('Keine Telegram-Empfänger eingetragen');
    if (file.size > TELEGRAM_LIMIT) throw new Error(`Datei zu groß für Telegram (${fmtSize(file.size)}, max. 49 MB)`);
    let sent = 0;
    for (const id of t.ids) {
        await t.bot.sendDocument(id, fs.createReadStream(file.path), { caption: `🔒 Datensicherung ${file.name}` }, { filename: file.name, contentType: 'application/octet-stream' });
        sent++;
    }
    return `${sent} Empfänger`;
}

// =======================
// Run
// =======================
function fmtSize(b) {
    if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
    return Math.max(1, Math.round(b / 1024)) + ' KB';
}

function errText(e) {
    if (e && e.response) {
        const body = String(e.response.data || '').replace(/\s+/g, ' ');
        const code = body.match(/<Code>([^<]+)<\/Code>/);
        return `HTTP ${e.response.status}${code ? ' ' + code[1] : ''}`;
    }
    return (e && e.message) || String(e);
}

async function listLocal() {
    let names = [];
    try { names = await fsp.readdir(BACKUP_DIR); } catch (e) { return []; }
    const out = [];
    for (const n of names.filter(n => n.startsWith(FILE_PREFIX) && n.endsWith(FILE_SUFFIX)).sort().reverse()) {
        try { const st = await fsp.stat(path.join(BACKUP_DIR, n)); out.push({ name: n, size: st.size, at: st.mtime.toISOString() }); } catch (e) { /* gone */ }
    }
    return out;
}

async function pruneLocal(keep) {
    const files = await listLocal(); // newest first
    for (const f of files.slice(keep)) await fsp.rm(path.join(BACKUP_DIR, f.name), { force: true });
}

async function doRun(trigger) {
    const cfg = getConfig();
    if (!cfg.password || cfg.password.length < MIN_PASSWORD) throw new Error('Kein Backup-Passwort gesetzt');
    const started = Date.now();
    const entry = { at: new Date().toISOString(), trigger, ok: false, targets: [] };
    try {
        const file = await createArchive(cfg);
        Object.assign(entry, { file: file.name, size: file.size, files: file.files, skipped: file.skipped.slice(0, 20) });
        const jobs = [];
        if (cfg.s3.enabled) jobs.push(['Cloud-Speicher (S3)', async () => { const k = await s3Upload(cfg.s3, file); const d = await s3Prune(cfg.s3, cfg.keepRemote); return k + (d ? `, ${d} alte gelöscht` : ''); }]);
        if (cfg.webdav.enabled) jobs.push(['WebDAV', async () => { await davUpload(cfg.webdav, file); const d = await davPrune(cfg.webdav, cfg.keepRemote); return 'hochgeladen' + (d ? `, ${d} alte gelöscht` : ''); }]);
        if (cfg.telegram.enabled) jobs.push(['Telegram', () => telegramSend(file)]);
        for (const [label, fn] of jobs) {
            try { entry.targets.push({ label, ok: true, info: await fn() }); } catch (e) { entry.targets.push({ label, ok: false, error: errText(e) }); }
        }
        await pruneLocal(cfg.keepLocal);
        entry.ok = entry.targets.every(t => t.ok);
        if (!jobs.length) entry.warning = 'Nur auf dem Server gespeichert. Für den Ernstfall ein externes Ziel einrichten.';
    } catch (e) {
        entry.error = errText(e);
    }
    entry.seconds = Math.round((Date.now() - started) / 1000);

    const state = getState();
    state.last = entry;
    if (entry.ok) state.lastOk = entry;
    state.history = [entry, ...(state.history || [])].slice(0, 20);
    saveState(state);

    if (!entry.ok) {
        const failed = entry.error ? `\n${entry.error}` : entry.targets.filter(t => !t.ok).map(t => `\n• ${t.label}: ${t.error}`).join('');
        await deps.notify(`⚠️ *Datensicherung fehlgeschlagen*${failed}\n\nAdmin → Einstellungen → Datensicherung`).catch(() => {});
    } else if (cfg.notifySuccess) {
        await deps.notify(`✅ Datensicherung erstellt (${fmtSize(entry.size)}, ${entry.targets.map(t => t.label).join(', ') || 'nur Server'})`).catch(() => {});
    }
    return entry;
}

/** Runs one backup; parallel calls share the running one. */
function runNow(trigger = 'manual') {
    if (!running) running = doRun(trigger).finally(() => { running = null; });
    return running;
}

/** Checks a target with a small test file (uploaded and deleted again). */
async function testTarget(kind, input) {
    const cfg = getConfig();
    const merged = { ...cfg[kind], ...(input || {}) };
    if (kind === 's3' && merged.secretKey === MASK) merged.secretKey = cfg.s3.secretKey;
    if (kind === 'webdav' && merged.pass === MASK) merged.pass = cfg.webdav.pass;
    if (kind === 's3') {
        merged.endpoint = str(merged.endpoint).replace(/\/+$/, '');
        merged.prefix = str(merged.prefix).replace(/^\/+/, '');
    }
    if (kind === 'webdav') merged.url = str(merged.url).replace(/\/+$/, '');
    const body = Buffer.from(`Verbindungstest ${new Date().toISOString()}\n`);
    try {
        if (kind === 's3') {
            const key = (merged.prefix || '') + 'verbindungstest.txt';
            await s3Request(merged, 'PUT', key, { body, headers: { 'content-length': body.length, 'content-type': 'text/plain' } });
            await s3Request(merged, 'DELETE', key);
            return { ok: true, message: 'Verbindung klappt: Testdatei hochgeladen und wieder gelöscht.' };
        }
        if (kind === 'webdav') {
            await axios.request({ method: 'MKCOL', url: merged.url + '/', auth: davAuth(merged), timeout: 30000, validateStatus: () => true });
            await axios.put(merged.url + '/verbindungstest.txt', body, { auth: davAuth(merged), timeout: 30000 });
            await axios.delete(merged.url + '/verbindungstest.txt', { auth: davAuth(merged), timeout: 30000 }).catch(() => {});
            return { ok: true, message: 'Verbindung klappt: Testdatei hochgeladen und wieder gelöscht.' };
        }
        if (kind === 'telegram') {
            const t = deps.telegram();
            if (!t || !t.bot) throw new Error('Telegram-Bot ist nicht aktiv');
            if (!t.ids.length) throw new Error('Keine Telegram-Empfänger eingetragen');
            return { ok: true, message: `Telegram-Bot aktiv, ${t.ids.length} Empfänger.` };
        }
        throw new Error('Unbekanntes Ziel');
    } catch (e) {
        return { ok: false, message: errText(e) };
    }
}

async function status() {
    const state = getState();
    return { config: publicConfig(), last: state.last || null, lastOk: state.lastOk || null, history: state.history || [], local: await listLocal(), running: !!running };
}

/** Absolute path of a local backup for download, or null. */
function localFile(name) {
    const n = path.basename(String(name || ''));
    if (!n.startsWith(FILE_PREFIX) || !n.endsWith(FILE_SUFFIX)) return null;
    const p = path.join(BACKUP_DIR, n);
    return fs.existsSync(p) ? p : null;
}

/** Dashboard hint for admins: backup off, last run failed, or last good backup older than 2 days. */
function warning() {
    const cfg = getConfig();
    if (!cfg.enabled) return 'Automatische Datensicherung ist aus (Einstellungen → Datensicherung)';
    const st = getState();
    if (st.last && !st.last.ok) return 'Letzte Datensicherung fehlgeschlagen: ' + (st.last.error || (st.last.targets || []).filter(t => !t.ok).map(t => `${t.label}: ${t.error}`).join(', '));
    if (st.lastOk && Date.now() - new Date(st.lastOk.at).getTime() > 50 * 3600 * 1000) return 'Letzte erfolgreiche Datensicherung ist älter als 2 Tage';
    if (!cfg.s3.enabled && !cfg.webdav.enabled && !cfg.telegram.enabled) return 'Datensicherung liegt nur auf dem Server, kein externes Ziel eingerichtet';
    return null;
}

// =======================
// Schedule
// =======================
function localDay(d = new Date()) { return stamp(d).slice(0, 10); }

/** Called every few minutes: runs once per day after the configured time; warns once if the last good backup is old. */
async function tick() {
    const cfg = getConfig();
    if (!cfg.enabled || !cfg.password) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const state = getState();
    if (hhmm >= cfg.time && state.lastAutoDay !== localDay(now)) {
        state.lastAutoDay = localDay(now);
        saveState(state);
        await runNow('auto').catch(e => console.error('❌ Backup:', e.message));
    }
}

function init(options) {
    deps = { ...deps, ...options };
    const cron = require('node-cron');
    cron.schedule('*/5 * * * *', () => { tick().catch(e => console.error('❌ Backup-Zeitplan:', e.message)); });
}

module.exports = { init, status, warning, saveConfig, runNow, testTarget, localFile, BACKUP_DIR, decryptStream, PBKDF2_ITER, FILE_PREFIX, FILE_SUFFIX };
