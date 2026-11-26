'use strict';

/**
 * Ausgaben mit Belegen: Belegdateien, Erkennung (receipt-scan.js), Paperless-ngx in beide Richtungen, Admin-API.
 *
 *  - Tabelle "expenses" bekommt Händler, MwSt, Zahlart, Belegdatei, erkannter Text, Paperless-Status …
 *  - Belegdateien liegen in uploads/receipts/ (nicht öffentlich, nur über /api/expenses/:id/receipt mit Recht "Finanzen")
 *  - Paperless hochladen: Titel "Händler – Beschreibung", Datum, Korrespondent = Händler (wird angelegt, wenn es ihn nicht gibt),
 *    Dokumenttyp, Tags (Namen, fehlende werden angelegt), Kategorie als Tag (optional), Betrag in ein Benutzerfeld.
 *    Paperless verarbeitet Uploads im Hintergrund: die Aufgabe wird abgefragt, bis die Dokument-ID feststeht.
 *  - Paperless übernehmen: Dokumente mit einem Tag (z. B. "Ausgabe Ferienwohnung") werden als Ausgaben angelegt;
 *    Betrag aus dem Benutzerfeld oder aus dem Text, den Paperless erkannt hat. Auf Wunsch automatisch stündlich.
 *  - Einstellungen unter dem Schlüssel "receipts" (nur auf dem Server, der KI-Schlüssel geht nie an den Browser zurück).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const scanner = require('./receipt-scan');

const RECEIPT_DIR = path.join(__dirname, 'uploads', 'receipts');
const SECRET_MASK = '••••••••';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const MAX_FILE = 20 * 1024 * 1024;
const MIME_EXT = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/gif': '.gif', 'image/tiff': '.tif', 'image/bmp': '.bmp' };
const SOURCE_LABEL = { telegram: 'Telegram', upload: 'Hochgeladen', paperless: 'Paperless', local: 'Manuell' };

const DEFAULTS = {
    ai: { enabled: false, apiKey: '', model: scanner.DEFAULT_MODEL },
    upload: {
        enabled: true,              // Belege nach dem Speichern an Paperless schicken
        tags: 'Ferienwohnung, Ausgabe',
        categoryTag: true,          // Kategorie zusätzlich als Tag
        correspondent: true,        // Händler als Korrespondent
        docType: 'Beleg',
        amountField: 'Betrag',
        createMissing: true         // fehlende Tags/Korrespondenten/Dokumenttyp in Paperless anlegen
    },
    import: { tag: '', auto: false, amountField: '' },
    askInBot: true                  // Fotos im Telegram-Bot automatisch als Beleg erkennen
};

module.exports = function createReceipts({ db, axios, paperlessAgent, notify }) {
    const sql = () => db.getDb();

    // -----------------------------------------------------------------------
    // Schema
    // -----------------------------------------------------------------------
    function ensureSchema() {
        const cols = sql().prepare('PRAGMA table_info(expenses)').all().map(c => c.name);
        const add = [
            ['vendor', 'TEXT'], ['vat_rate', 'REAL'], ['vat_amount', 'REAL'], ['payment_method', 'TEXT'], ['invoice_number', 'TEXT'],
            ['receipt_file', 'TEXT'], ['receipt_mime', 'TEXT'], ['receipt_name', 'TEXT'], ['ocr_text', 'TEXT'], ['engine', 'TEXT'],
            ['paperless_status', 'TEXT'], ['paperless_error', 'TEXT'], ['paperless_task', 'TEXT'], ['created_by', 'TEXT'], ['updated_at', 'DATETIME']
        ];
        for (const [name, type] of add) if (!cols.includes(name)) sql().exec(`ALTER TABLE expenses ADD COLUMN ${name} ${type}`);
        fs.mkdirSync(RECEIPT_DIR, { recursive: true });
    }

    // -----------------------------------------------------------------------
    // Einstellungen
    // -----------------------------------------------------------------------
    function getConfig() {
        const s = db.getSetting('receipts') || {};
        const all = db.getAllSettings();
        const c = {
            ai: { ...DEFAULTS.ai, ...(s.ai || {}) },
            upload: { ...DEFAULTS.upload, ...(s.upload || {}) },
            import: { ...DEFAULTS.import, ...(s.import || {}) },
            askInBot: s.askInBot !== undefined ? !!s.askInBot : DEFAULTS.askInBot
        };
        // Alte Felder der Paperless-Seite (Tag + Betragsfeld für den Sync) übernehmen
        if (!c.import.tag && all.paperless_expense_tag) c.import.tag = String(all.paperless_expense_tag);
        if (!c.import.amountField && all.paperless_amount_field) c.import.amountField = String(all.paperless_amount_field);
        return c;
    }

    function publicConfig() {
        const c = getConfig();
        const pl = paperlessSettings();
        return {
            ...c,
            ai: { ...c.ai, apiKey: c.ai.apiKey ? SECRET_MASK : '' },
            paperlessReady: !!(pl.url && pl.token),
            categories: scanner.CATEGORIES,
            models: scanner.AI_MODELS
        };
    }

    function saveConfig(body) {
        const old = getConfig();
        const b = body || {};
        const str = (v, max = 200) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
        const c = {
            ai: {
                enabled: !!(b.ai && b.ai.enabled),
                apiKey: b.ai && b.ai.apiKey !== undefined && b.ai.apiKey !== SECRET_MASK ? str(b.ai.apiKey, 300) : old.ai.apiKey,
                model: b.ai && scanner.AI_MODELS.some(m => m.id === b.ai.model) ? b.ai.model : old.ai.model
            },
            upload: {
                enabled: !!(b.upload && b.upload.enabled),
                tags: str(b.upload && b.upload.tags),
                categoryTag: !!(b.upload && b.upload.categoryTag),
                correspondent: !!(b.upload && b.upload.correspondent),
                docType: str(b.upload && b.upload.docType, 80),
                amountField: str(b.upload && b.upload.amountField, 80),
                createMissing: !!(b.upload && b.upload.createMissing)
            },
            import: {
                tag: str(b.import && b.import.tag, 80),
                auto: !!(b.import && b.import.auto),
                amountField: str(b.import && b.import.amountField, 80)
            },
            askInBot: b.askInBot !== undefined ? !!b.askInBot : old.askInBot
        };
        if (c.ai.enabled && !c.ai.apiKey) throw httpError(400, 'Für die KI-Erkennung wird ein API-Schlüssel gebraucht.');
        db.setSetting('receipts', c);
        // Alte Felder synchron halten (die Paperless-Seite zeigt sie weiter an)
        db.setSetting('paperless_expense_tag', c.import.tag);
        db.setSetting('paperless_amount_field', c.import.amountField);
        return publicConfig();
    }

    function httpError(status, message) {
        const e = new Error(message);
        e.status = status;
        return e;
    }

    // -----------------------------------------------------------------------
    // Ausgaben
    // -----------------------------------------------------------------------
    const FIELDS = ['date', 'amount', 'category', 'description', 'vendor', 'vat_rate', 'vat_amount', 'payment_method', 'invoice_number'];

    function clean(data, partial) {
        const out = {};
        const has = k => Object.prototype.hasOwnProperty.call(data, k);
        if (!partial || has('date')) {
            if (!YMD.test(String(data.date || ''))) throw httpError(400, 'Bitte ein gültiges Datum angeben.');
            out.date = data.date;
        }
        if (!partial || has('amount')) {
            const a = typeof data.amount === 'number' ? data.amount : scanner.parseAmount(data.amount);
            if (a === null || !Number.isFinite(a) || a < 0 || a > 1000000) throw httpError(400, 'Bitte einen gültigen Betrag angeben.');
            out.amount = r2(a);
        }
        for (const k of ['category', 'description', 'vendor', 'payment_method', 'invoice_number']) {
            if (!partial || has(k)) out[k] = data[k] === undefined || data[k] === null || String(data[k]).trim() === '' ? null : String(data[k]).trim().slice(0, k === 'description' ? 300 : 120);
        }
        for (const k of ['vat_rate', 'vat_amount']) {
            if (!partial || has(k)) {
                const v = data[k] === '' || data[k] === null || data[k] === undefined ? null : (typeof data[k] === 'number' ? data[k] : scanner.parseAmount(String(data[k]).replace('%', '')));
                out[k] = v === null || !Number.isFinite(v) ? null : r2(v);
            }
        }
        return out;
    }

    function getExpense(id) {
        return sql().prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    }

    function listExpenses({ year, category, q } = {}) {
        const where = [];
        const args = [];
        if (/^\d{4}$/.test(String(year || ''))) { where.push("substr(date, 1, 4) = ?"); args.push(String(year)); }
        if (category) { where.push('COALESCE(category, \'\') = ?'); args.push(category === '—' ? '' : category); }
        if (q) {
            where.push("(LOWER(COALESCE(vendor,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(category,'') || ' ' || COALESCE(invoice_number,'')) LIKE ?)");
            args.push(`%${String(q).toLowerCase()}%`);
        }
        const rows = sql().prepare(`SELECT id, date, amount, category, description, vendor, vat_rate, vat_amount, payment_method, invoice_number,
                source, paperless_id, paperless_status, paperless_error, receipt_file, receipt_mime, receipt_name, engine, created_by, created_at
            FROM expenses ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, id DESC`).all(...args);
        const years = sql().prepare("SELECT DISTINCT substr(date, 1, 4) AS y FROM expenses WHERE date IS NOT NULL ORDER BY y DESC").all().map(r => r.y);
        return { expenses: rows.map(publicRow), years };
    }

    function publicRow(r) {
        const { receipt_file, ...rest } = r;
        return { ...rest, hasReceipt: !!receipt_file || !!r.paperless_id, sourceLabel: SOURCE_LABEL[r.source] || r.source || 'Manuell' };
    }

    function createExpense(data, extra = {}) {
        const d = clean(data, false);
        const info = sql().prepare(`INSERT INTO expenses (date, amount, category, description, vendor, vat_rate, vat_amount, payment_method, invoice_number,
                source, paperless_id, receipt_file, receipt_mime, receipt_name, ocr_text, engine, created_by, updated_at)
            VALUES (@date, @amount, @category, @description, @vendor, @vat_rate, @vat_amount, @payment_method, @invoice_number,
                @source, @paperless_id, @receipt_file, @receipt_mime, @receipt_name, @ocr_text, @engine, @created_by, CURRENT_TIMESTAMP)`).run({
            ...d,
            source: extra.source || 'local',
            paperless_id: extra.paperless_id || null,
            receipt_file: extra.receipt_file || null,
            receipt_mime: extra.receipt_mime || null,
            receipt_name: extra.receipt_name || null,
            ocr_text: extra.ocr_text ? String(extra.ocr_text).slice(0, 20000) : null,
            engine: extra.engine || null,
            created_by: extra.created_by || null
        });
        return getExpense(info.lastInsertRowid);
    }

    function updateExpense(id, data) {
        const row = getExpense(id);
        if (!row) throw httpError(404, 'Ausgabe nicht gefunden');
        const d = clean(data, true);
        const keys = Object.keys(d).filter(k => FIELDS.includes(k));
        if (keys.length) {
            sql().prepare(`UPDATE expenses SET ${keys.map(k => `${k} = @${k}`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`).run({ ...d, id });
        }
        return getExpense(id);
    }

    function deleteExpense(id) {
        const row = getExpense(id);
        if (!row) return false;
        sql().prepare('DELETE FROM expenses WHERE id = ?').run(id);
        if (row.receipt_file) fs.unlink(path.join(RECEIPT_DIR, path.basename(row.receipt_file)), () => { });
        return true;
    }

    // -----------------------------------------------------------------------
    // Belegdateien
    // -----------------------------------------------------------------------
    function extFor(mime, name) {
        const e = path.extname(String(name || '')).toLowerCase();
        if (/^\.(pdf|jpe?g|png|webp|heic|gif|tiff?|bmp)$/.test(e)) return e === '.jpeg' ? '.jpg' : e;
        return MIME_EXT[String(mime || '').toLowerCase()] || '.bin';
    }

    /** Kopiert eine (temporäre) Datei in den Belegordner. */
    function storeFile(srcPath, mime, originalName) {
        const stat = fs.statSync(srcPath);
        if (stat.size > MAX_FILE) throw httpError(400, 'Die Datei ist zu groß (max. 20 MB).');
        const ext = extFor(mime, originalName || srcPath);
        const name = `${new Date().toISOString().slice(0, 10)}_${crypto.randomBytes(6).toString('hex')}${ext}`;
        fs.copyFileSync(srcPath, path.join(RECEIPT_DIR, name));
        return { file: name, mime: mime || (ext === '.pdf' ? 'application/pdf' : 'image/' + ext.slice(1)), name: originalName ? String(originalName).slice(0, 120) : name };
    }

    function receiptPath(row) {
        return row && row.receipt_file ? path.join(RECEIPT_DIR, path.basename(row.receipt_file)) : null;
    }

    function niceFileName(row) {
        const ext = path.extname(row.receipt_file || '') || '.pdf';
        const who = String(row.vendor || row.description || 'Beleg').replace(/[^\p{L}\d]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'Beleg';
        const amt = Number(row.amount || 0).toFixed(2).replace('.', ',');
        return `${row.date || 'ohne-Datum'}_${who}_${amt}EUR${ext}`;
    }

    /** Erkennung einer Datei (Telegram oder Upload). */
    async function scanFile(filePath, mime, text) {
        const c = getConfig();
        return scanner.scan(filePath, mime, { ai: c.ai, text });
    }

    // -----------------------------------------------------------------------
    // Paperless
    // -----------------------------------------------------------------------
    function paperlessSettings() {
        const all = db.getAllSettings();
        const p = typeof all.paperless === 'string' ? (() => { try { return JSON.parse(all.paperless); } catch (e) { return {}; } })() : (all.paperless || {});
        return { url: String(p.url || '').replace(/\/+$/, ''), token: p.token || '' };
    }

    function plClient() {
        const p = paperlessSettings();
        if (!p.url || !p.token) throw httpError(400, 'Paperless ist nicht eingerichtet (Einstellungen → Paperless NGX).');
        const cfg = { headers: { Authorization: `Token ${p.token}`, Accept: 'application/json; version=5' }, timeout: 30000 };
        if (p.url.startsWith('https') && paperlessAgent) cfg.httpsAgent = paperlessAgent();
        const u = x => `${p.url}${x}`;
        return {
            url: p.url,
            get: (x, extra = {}) => axios.get(u(x), { ...cfg, ...extra }).then(r => r.data),
            post: (x, body, extra = {}) => axios.post(u(x), body, { ...cfg, ...extra, headers: { ...cfg.headers, ...(extra.headers || {}) } }).then(r => r.data),
            patch: (x, body) => axios.patch(u(x), body, cfg).then(r => r.data),
            stream: (x) => axios.get(u(x), { ...cfg, responseType: 'stream', timeout: 60000 })
        };
    }

    function plError(e) {
        if (e && e.response) {
            const d = e.response.data;
            const detail = typeof d === 'string' ? d.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160) : JSON.stringify(d || {}).slice(0, 160);
            return `HTTP ${e.response.status}${detail ? ': ' + detail : ''}`;
        }
        return (e && e.message) || String(e);
    }

    async function findByName(pl, endpoint, name) {
        const data = await pl.get(`/api/${endpoint}/?name__iexact=${encodeURIComponent(name)}&page_size=5`);
        return (data.results || []).find(x => String(x.name).toLowerCase() === name.toLowerCase()) || null;
    }

    /** ID zu einem Namen (oder einer Zahl), legt auf Wunsch fehlende an. */
    async function resolveId(pl, endpoint, nameOrId, create, extra = {}) {
        const v = String(nameOrId || '').trim();
        if (!v) return null;
        if (/^\d+$/.test(v)) return parseInt(v, 10);
        const found = await findByName(pl, endpoint, v);
        if (found) return found.id;
        if (!create) return null;
        const made = await pl.post(`/api/${endpoint}/`, { name: v, matching_algorithm: 0, ...extra });
        return made.id;
    }

    function monetary(field, amount) {
        if (!field) return null;
        if (field.data_type === 'monetary') return `EUR${Number(amount).toFixed(2)}`;
        if (field.data_type === 'float') return Number(amount);
        if (field.data_type === 'integer') return Math.round(Number(amount));
        if (field.data_type === 'string') return Number(amount).toFixed(2).replace('.', ',') + ' €';
        return null;
    }

    async function resolveField(pl, nameOrId) {
        const v = String(nameOrId || '').trim();
        if (!v) return null;
        if (/^\d+$/.test(v)) return pl.get(`/api/custom_fields/${v}/`).catch(() => null);
        return findByName(pl, 'custom_fields', v).catch(() => null);
    }

    const setPl = (id, patch) => {
        const keys = Object.keys(patch);
        sql().prepare(`UPDATE expenses SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id });
    };

    /**
     * Schickt den Beleg einer Ausgabe an Paperless und wartet, bis Paperless die Dokument-ID meldet (max. ~3 Minuten).
     * @returns {Promise<{ ok, documentId?, duplicateOf?, error?, url? }>}
     */
    async function uploadToPaperless(id) {
        const row = getExpense(id);
        if (!row) throw httpError(404, 'Ausgabe nicht gefunden');
        const file = receiptPath(row);
        if (!file || !fs.existsSync(file)) throw httpError(400, 'Zu dieser Ausgabe gibt es keine Belegdatei.');
        if (row.paperless_id) return { ok: true, documentId: row.paperless_id, already: true };
        const c = getConfig().upload;
        let pl;
        try { pl = plClient(); } catch (e) { setPl(id, { paperless_status: 'error', paperless_error: e.message }); throw e; }
        setPl(id, { paperless_status: 'pending', paperless_error: null });
        try {
            const tagNames = String(c.tags || '').split(',').map(t => t.trim()).filter(Boolean);
            if (c.categoryTag && row.category) tagNames.push(row.category);
            const tags = [];
            for (const t of tagNames) {
                const tid = await resolveId(pl, 'tags', t, c.createMissing).catch(() => null);
                if (tid && !tags.includes(tid)) tags.push(tid);
            }
            const correspondent = c.correspondent && row.vendor ? await resolveId(pl, 'correspondents', row.vendor, c.createMissing).catch(() => null) : null;
            const docType = c.docType ? await resolveId(pl, 'document_types', c.docType, c.createMissing).catch(() => null) : null;

            const form = new FormData();
            const buf = fs.readFileSync(file);
            form.append('document', new Blob([buf], { type: row.receipt_mime || 'application/octet-stream' }), niceFileName(row));
            const title = [row.vendor, row.description].filter(Boolean).join(' – ') || `Beleg ${row.date}`;
            form.append('title', title.slice(0, 120));
            if (row.date) form.append('created', row.date);
            if (correspondent) form.append('correspondent', String(correspondent));
            if (docType) form.append('document_type', String(docType));
            tags.forEach(t => form.append('tags', String(t)));
            const taskId = String(await pl.post('/api/documents/post_document/', form, { timeout: 120000 })).replace(/"/g, '').trim();
            setPl(id, { paperless_task: taskId });

            // Auf die Verarbeitung warten
            let docId = null, dupOf = null, failMsg = null;
            for (let i = 0; i < 60 && !docId && !failMsg; i++) {
                await new Promise(r => setTimeout(r, i < 5 ? 2000 : 4000));
                const tasks = await pl.get(`/api/tasks/?task_id=${encodeURIComponent(taskId)}`).catch(() => null);
                const t = Array.isArray(tasks) ? tasks[0] : (tasks && tasks.results ? tasks.results[0] : null);
                if (!t) continue;
                if (t.status === 'SUCCESS' && t.related_document) docId = parseInt(t.related_document, 10);
                else if (t.status === 'FAILURE') {
                    const msg = String(t.result || 'Fehler');
                    const dm = msg.match(/duplicate of .*?\(#(\d+)\)/i);
                    if (dm) dupOf = parseInt(dm[1], 10);
                    failMsg = msg.slice(0, 200);
                }
            }
            if (dupOf) docId = dupOf;
            if (!docId) {
                const err = failMsg || 'Paperless hat das Dokument noch nicht fertig verarbeitet. Es erscheint dort trotzdem.';
                setPl(id, { paperless_status: failMsg ? 'error' : 'sent', paperless_error: err });
                return { ok: !failMsg, error: err };
            }
            if (getExpenseByPaperless(docId, id)) {
                // Gibt es schon als eigene Ausgabe (z. B. vorher übernommen) – nur verknüpfen ist nicht möglich (UNIQUE)
                setPl(id, { paperless_status: 'duplicate', paperless_error: `Schon in Paperless als Dokument #${docId}, das bereits einer anderen Ausgabe zugeordnet ist.` });
                return { ok: true, duplicateOf: docId, url: `${pl.url}/documents/${docId}/details` };
            }
            setPl(id, { paperless_id: docId, paperless_status: dupOf ? 'duplicate' : 'done', paperless_error: dupOf ? `War schon in Paperless (Dokument #${docId}).` : null });

            // Betrag in das Benutzerfeld
            if (c.amountField && !dupOf) {
                try {
                    const field = await resolveField(pl, c.amountField);
                    const value = monetary(field, row.amount);
                    if (field && value !== null) {
                        const doc = await pl.get(`/api/documents/${docId}/`);
                        const cf = (doc.custom_fields || []).filter(x => x.field !== field.id).map(x => ({ field: x.field, value: x.value }));
                        cf.push({ field: field.id, value });
                        await pl.patch(`/api/documents/${docId}/`, { custom_fields: cf });
                    }
                } catch (e) {
                    console.warn('[Beleg] Paperless-Betragsfeld:', plError(e));
                }
            }
            return { ok: true, documentId: docId, duplicateOf: dupOf || null, url: `${pl.url}/documents/${docId}/details` };
        } catch (e) {
            const msg = plError(e);
            console.error('[Beleg] Paperless-Upload:', msg);
            setPl(id, { paperless_status: 'error', paperless_error: msg.slice(0, 300) });
            return { ok: false, error: msg };
        }
    }

    function getExpenseByPaperless(docId, exceptId) {
        return sql().prepare('SELECT id FROM expenses WHERE paperless_id = ? AND id != ?').get(docId, exceptId || 0);
    }

    function parsePaperlessAmount(v) {
        if (v === null || v === undefined || v === '') return null;
        if (typeof v === 'number') return r2(v);
        const s = String(v).replace(/^[A-Z]{3}/, '');
        return scanner.parseAmount(s) ?? (Number.isFinite(parseFloat(s)) ? r2(parseFloat(s)) : null);
    }

    let importBusy = false;
    /** Dokumente mit dem Import-Tag aus Paperless als Ausgaben übernehmen. */
    async function importFromPaperless({ by } = {}) {
        if (importBusy) throw httpError(429, 'Die Übernahme läuft schon.');
        importBusy = true;
        try {
            const c = getConfig().import;
            if (!c.tag) throw httpError(400, 'Kein Tag für die Übernahme eingestellt (Einstellungen → Belege & KI).');
            const pl = plClient();
            const tagId = await resolveId(pl, 'tags', c.tag, false);
            if (!tagId) return { count: 0, skipped: 0, message: `Tag „${c.tag}“ gibt es in Paperless nicht.` };
            const field = c.amountField ? await resolveField(pl, c.amountField) : null;

            const corrNames = new Map();
            const corrName = async (cid) => {
                if (!cid) return null;
                if (!corrNames.has(cid)) corrNames.set(cid, await pl.get(`/api/correspondents/${cid}/`).then(x => x.name).catch(() => null));
                return corrNames.get(cid);
            };

            let next = `/api/documents/?tags__id__all=${tagId}&page_size=100&ordering=-created`;
            let count = 0, skipped = 0, noAmount = 0;
            const seen = new Set();
            for (let page = 0; next && page < 20; page++) {
                const data = await pl.get(next.replace(pl.url, ''));
                for (const doc of data.results || []) {
                    if (seen.has(doc.id)) continue;
                    seen.add(doc.id);
                    if (sql().prepare('SELECT id FROM expenses WHERE paperless_id = ?').get(doc.id)) { skipped++; continue; }
                    const parsed = scanner.parseReceiptText(doc.content || '');
                    let amount = null;
                    if (field && doc.custom_fields) {
                        const f = doc.custom_fields.find(x => x.field === field.id);
                        if (f) amount = parsePaperlessAmount(f.value);
                    }
                    if (amount === null) amount = parsed.amount;
                    if (amount === null) noAmount++;
                    const vendor = (await corrName(doc.correspondent)) || parsed.vendor || null;
                    const date = String(doc.created_date || doc.created || doc.added || '').slice(0, 10);
                    try {
                        createExpense({
                            date: YMD.test(date) ? date : new Date().toISOString().slice(0, 10),
                            amount: amount || 0,
                            category: scanner.guessCategory(vendor, doc.title, (doc.content || '').slice(0, 800)) || parsed.category || 'Sonstiges',
                            description: doc.title || null,
                            vendor,
                            vat_rate: parsed.vat_rate, vat_amount: parsed.vat_amount,
                            payment_method: parsed.payment_method, invoice_number: parsed.invoice_number
                        }, { source: 'paperless', paperless_id: doc.id, ocr_text: doc.content, engine: 'paperless', created_by: by || 'Paperless' });
                        sql().prepare("UPDATE expenses SET paperless_status = 'done' WHERE paperless_id = ?").run(doc.id);
                        count++;
                    } catch (e) {
                        console.warn('[Beleg] Paperless-Übernahme Dokument', doc.id, e.message);
                    }
                }
                next = data.next || null;
            }
            const parts = [`${count} neue Ausgabe${count === 1 ? '' : 'n'} aus Paperless übernommen`];
            if (noAmount) parts.push(`${noAmount} ohne erkannten Betrag (bitte prüfen)`);
            return { count, skipped, noAmount, message: parts.join(', ') };
        } catch (e) {
            if (e.status) throw e;
            throw httpError(502, `Paperless: ${plError(e)}`);
        } finally {
            importBusy = false;
        }
    }

    // Automatische Übernahme (stündlich, wenn eingeschaltet)
    let autoTimer = null;
    function startAutoImport() {
        if (autoTimer) return;
        autoTimer = setInterval(async () => {
            const c = getConfig();
            if (!c.import.auto || !c.import.tag) return;
            try {
                const r = await importFromPaperless({ by: 'Paperless (automatisch)' });
                if (r.count && notify) notify(`🧾 <b>Paperless:</b> ${r.message}.`);
            } catch (e) {
                if (e.status !== 429) console.warn('[Beleg] Automatische Paperless-Übernahme:', e.message);
            }
        }, 60 * 60 * 1000);
        if (autoTimer.unref) autoTimer.unref();
    }

    async function testPaperlessTargets() {
        const pl = plClient();
        const c = getConfig();
        const out = [];
        const check = async (label, endpoint, v) => {
            if (!v) return;
            const r = await resolveId(pl, endpoint, v, false).catch(e => { throw httpError(502, plError(e)); });
            out.push(`${label} „${v}“: ${r ? 'vorhanden' : (c.upload.createMissing ? 'wird beim ersten Beleg angelegt' : 'fehlt')}`);
        };
        for (const t of String(c.upload.tags || '').split(',').map(x => x.trim()).filter(Boolean)) await check('Tag', 'tags', t);
        await check('Dokumenttyp', 'document_types', c.upload.docType);
        if (c.upload.amountField) {
            const f = await resolveField(pl, c.upload.amountField);
            out.push(`Feld „${c.upload.amountField}“: ${f ? `vorhanden (${f.data_type})` : 'fehlt (Betrag wird dann nicht eingetragen)'}`);
        }
        if (c.import.tag) await check('Übernahme-Tag', 'tags', c.import.tag);
        return out;
    }

    // -----------------------------------------------------------------------
    // Admin-API (Bereich "Finanzen"; Einstellungen brauchen "Einstellungen")
    // -----------------------------------------------------------------------
    function registerRoutes(app, { apiLimiter, multerUpload, permissions }) {
        const wrap = fn => async (req, res, next) => {
            if (req.params && req.params.id !== undefined && !/^\d+$/.test(req.params.id)) return next();
            try { await fn(req, res); } catch (e) {
                if (!e.status) console.error('[Beleg] API-Fehler:', e);
                res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Fehler bei den Ausgaben' });
            }
        };
        const userName = req => (req.user && req.user.username) || (req.session && req.session.user && req.session.user.username) || null;

        app.get('/api/expenses', apiLimiter, wrap((req, res) => {
            const r = listExpenses(req.query || {});
            res.json({ success: true, ...r, categories: scanner.CATEGORIES, paperlessReady: (() => { const p = paperlessSettings(); return !!(p.url && p.token); })(),
                paperlessUrl: paperlessSettings().url || null });
        }));

        app.get('/api/expenses/:id', apiLimiter, wrap((req, res) => {
            const row = getExpense(parseInt(req.params.id, 10));
            if (!row) throw httpError(404, 'Ausgabe nicht gefunden');
            res.json({ success: true, expense: { ...publicRow(row), ocr_text: row.ocr_text || '' } });
        }));

        // Neue Ausgabe; optional mit Belegdatei (multipart, Feld "receipt")
        app.post('/api/expenses', apiLimiter, multerUpload.single('receipt'), wrap(async (req, res) => {
            const b = req.body || {};
            let extra = { source: 'local', created_by: userName(req) };
            if (req.file) {
                const f = storeFile(req.file.path, req.file.mimetype, req.file.originalname);
                extra = { ...extra, source: 'upload', receipt_file: f.file, receipt_mime: f.mime, receipt_name: f.name, ocr_text: b.ocr_text || null, engine: b.engine || null };
                fs.unlink(req.file.path, () => { });
            }
            const row = createExpense(b, extra);
            let paperless = null;
            const up = getConfig().upload;
            if (row.receipt_file && (b.paperless === 'true' || b.paperless === true || (b.paperless === undefined && up.enabled))) {
                const p = paperlessSettings();
                if (p.url && p.token) { paperless = 'pending'; uploadToPaperless(row.id).catch(() => { }); }
            }
            res.json({ success: true, message: 'Ausgabe gespeichert', expense: publicRow(getExpense(row.id)), paperless });
        }));

        // Beleg nur auslesen (ohne zu speichern): für das Formular "Neue Ausgabe"
        app.post('/api/expenses/scan', apiLimiter, multerUpload.single('receipt'), wrap(async (req, res) => {
            if (!req.file) throw httpError(400, 'Keine Datei');
            try {
                const r = await scanFile(req.file.path, req.file.mimetype);
                res.json({ success: true, result: r.result, engine: r.engine, aiError: r.aiError || null, text: String(r.text || '').slice(0, 6000) });
            } finally {
                fs.unlink(req.file.path, () => { });
            }
        }));

        app.put('/api/expenses/:id', apiLimiter, multerUpload.single('receipt'), wrap(async (req, res) => {
            const id = parseInt(req.params.id, 10);
            const row = updateExpense(id, req.body || {});
            if (req.file) {
                const f = storeFile(req.file.path, req.file.mimetype, req.file.originalname);
                fs.unlink(req.file.path, () => { });
                if (row.receipt_file) fs.unlink(path.join(RECEIPT_DIR, path.basename(row.receipt_file)), () => { });
                sql().prepare('UPDATE expenses SET receipt_file = ?, receipt_mime = ?, receipt_name = ?, paperless_status = NULL, paperless_error = NULL WHERE id = ?')
                    .run(f.file, f.mime, f.name, id);
            }
            res.json({ success: true, message: 'Ausgabe gespeichert', expense: publicRow(getExpense(id)) });
        }));

        app.delete('/api/expenses/:id', apiLimiter, wrap((req, res) => {
            if (!deleteExpense(parseInt(req.params.id, 10))) throw httpError(404, 'Ausgabe nicht gefunden');
            res.json({ success: true, message: 'Ausgabe gelöscht' });
        }));

        // Beleg ansehen/herunterladen: lokale Datei, sonst aus Paperless durchgereicht
        app.get('/api/expenses/:id/receipt', apiLimiter, wrap(async (req, res) => {
            const row = getExpense(parseInt(req.params.id, 10));
            if (!row) throw httpError(404, 'Ausgabe nicht gefunden');
            const disp = req.query.download ? 'attachment' : 'inline';
            const file = receiptPath(row);
            if (file && fs.existsSync(file)) {
                res.setHeader('Content-Type', row.receipt_mime || 'application/octet-stream');
                res.setHeader('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(niceFileName(row))}`);
                res.setHeader('Cache-Control', 'private, max-age=300');
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; plugin-types application/pdf");
                return fs.createReadStream(file).pipe(res);
            }
            if (row.paperless_id) {
                const pl = plClient();
                const r = await pl.stream(`/api/documents/${row.paperless_id}/${req.query.original ? 'download/?original=true' : 'preview/'}`).catch(e => { throw httpError(502, `Paperless: ${plError(e)}`); });
                res.setHeader('Content-Type', r.headers['content-type'] || 'application/pdf');
                res.setHeader('Content-Disposition', `${disp}; filename="Paperless-${row.paperless_id}.pdf"`);
                res.setHeader('X-Content-Type-Options', 'nosniff');
                return r.data.pipe(res);
            }
            throw httpError(404, 'Kein Beleg vorhanden');
        }));

        app.post('/api/expenses/:id/paperless', apiLimiter, wrap(async (req, res) => {
            const id = parseInt(req.params.id, 10);
            const row = getExpense(id);
            if (!row) throw httpError(404, 'Ausgabe nicht gefunden');
            if (row.paperless_id) return res.json({ success: true, message: 'Ist schon in Paperless.' });
            const r = await uploadToPaperless(id);
            if (!r.ok) throw httpError(502, `Paperless: ${r.error}`);
            res.json({ success: true, message: r.documentId ? `In Paperless abgelegt (Dokument #${r.documentId}).` : (r.error || 'An Paperless geschickt.'), result: r });
        }));

        // Übernahme aus Paperless (ersetzt den alten "Paperless Sync")
        app.post('/api/expenses/sync', apiLimiter, wrap(async (req, res) => {
            const r = await importFromPaperless({ by: userName(req) });
            res.json({ success: true, ...r });
        }));

        // Einstellungen
        app.get('/api/receipts/settings', apiLimiter, wrap((req, res) => res.json({ success: true, settings: publicConfig() })));
        app.put('/api/receipts/settings', apiLimiter, wrap((req, res) => res.json({ success: true, settings: saveConfig(req.body), message: 'Gespeichert' })));
        app.post('/api/receipts/test-ai', apiLimiter, wrap(async (req, res) => {
            const c = getConfig();
            const key = req.body && req.body.apiKey && req.body.apiKey !== SECRET_MASK ? String(req.body.apiKey).trim() : c.ai.apiKey;
            if (!key) throw httpError(400, 'Bitte zuerst einen API-Schlüssel eintragen.');
            try {
                const m = await scanner.testAi({ apiKey: key, model: (req.body && req.body.model) || c.ai.model });
                res.json({ success: true, message: `Verbindung klappt: ${m.name}` });
            } catch (e) {
                const s = e && e.status;
                throw httpError(400, s === 401 ? 'Der API-Schlüssel wird nicht angenommen.' : s === 404 ? 'Dieses Modell ist für den Schlüssel nicht freigeschaltet.' : `KI nicht erreichbar: ${String(e.message || e).slice(0, 150)}`);
            }
        }));
        app.post('/api/receipts/test-paperless', apiLimiter, wrap(async (req, res) => {
            res.json({ success: true, lines: await testPaperlessTargets() });
        }));
        void permissions;
    }

    /** Belegdateien eines Zeitraums für den ZIP-Export. */
    function receiptFilesBetween(from, to) {
        const rows = sql().prepare('SELECT * FROM expenses WHERE date >= ? AND date <= ? AND receipt_file IS NOT NULL ORDER BY date, id').all(from, to);
        const used = new Set();
        const files = [];
        for (const r of rows) {
            const p = receiptPath(r);
            if (!p || !fs.existsSync(p)) continue;
            let name = niceFileName(r);
            for (let i = 2; used.has(name); i++) name = niceFileName(r).replace(/(\.\w+)$/, `_${i}$1`);
            used.add(name);
            files.push({ name, data: fs.readFileSync(p) });
        }
        return files;
    }

    return {
        ensureSchema, getConfig, publicConfig, saveConfig, CATEGORIES: scanner.CATEGORIES,
        createExpense, updateExpense, deleteExpense, getExpense, listExpenses,
        storeFile, scanFile, uploadToPaperless, importFromPaperless, startAutoImport, registerRoutes,
        receiptFilesBetween, paperlessReady: () => { const p = paperlessSettings(); return !!(p.url && p.token); },
        looksLikeReceipt: scanner.looksLikeReceipt, isPdf: scanner.isPdf, niceFileName, receiptPath
    };
};

module.exports.SECRET_MASK = SECRET_MASK;
