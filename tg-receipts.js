'use strict';

/**
 * Telegram: Belege erfassen.
 *
 *  - Foto oder PDF an den Bot -> Texterkennung (bzw. KI) -> Vorschlag mit Händler, Datum, Betrag, Kategorie, MwSt
 *  - Rückfrage mit Knöpfen: ✅ Speichern, einzelne Werte ändern (Betrag, Datum, Händler, Kategorie, Beschreibung),
 *    Paperless an/aus, ❌ Verwerfen
 *  - Nach dem Speichern: Ausgabe steht in der Admin-App unter "Ausgaben" und in der Finanz-Auswertung,
 *    die Belegdatei wird (wenn eingestellt) an Paperless geschickt; der Bot meldet, wenn Paperless fertig ist.
 *  - /beleg ohne Foto fragt nach dem Foto; /beleg 12,50 REWE Putzmittel legt eine Ausgabe ohne Foto an (mit Rückfrage)
 *  - /ausgaben zeigt Monat, Jahr und die letzten Belege
 *
 * Sessions liegen in derselben Map wie die anderen Dialoge des Bots (flow: 'receipt').
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function createTgReceipts(h) {
    const { send, btn, keyboard, esc, fmtDate, fmtMoney, short, sessions, touch, menuOnlyKeyboard } = h;
    const R = () => h.receipts();

    const TMP_PREFIX = 'tg-beleg-';

    /** Alte temporäre Belegordner (abgelaufene Dialoge) wegräumen. */
    function sweepTmp() {
        try {
            const now = Date.now();
            for (const d of fs.readdirSync(os.tmpdir())) {
                if (!d.startsWith(TMP_PREFIX)) continue;
                const full = path.join(os.tmpdir(), d);
                const st = fs.statSync(full);
                if (now - st.mtimeMs > 6 * 3600 * 1000) fs.rmSync(full, { recursive: true, force: true });
            }
        } catch (e) { /* best-effort */ }
    }

    function cleanup(session) {
        if (session && session.tmpDir) {
            fs.rm(session.tmpDir, { recursive: true, force: true }, () => { });
            session.tmpDir = null;
        }
    }

    function todayYmd() {
        return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    }

    function parseDateInput(t) {
        const s = String(t || '').trim().toLowerCase();
        const today = todayYmd();
        if (s === 'heute') return today;
        if (s === 'gestern' || s === 'vorgestern') {
            const d = new Date(today + 'T12:00:00Z');
            d.setUTCDate(d.getUTCDate() - (s === 'gestern' ? 1 : 2));
            return d.toISOString().slice(0, 10);
        }
        let m = s.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{2}|\d{4})?$/);
        if (m) {
            let y = m[3] ? parseInt(m[3], 10) : parseInt(today.slice(0, 4), 10);
            if (y < 100) y += 2000;
            const mo = parseInt(m[2], 10), d = parseInt(m[1], 10);
            const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const dt = new Date(iso + 'T00:00:00Z');
            if (isNaN(dt) || dt.getUTCMonth() !== mo - 1) return null;
            // "28.12." im Januar meint das Vorjahr
            if (!m[3] && iso > today) return `${y - 1}${iso.slice(4)}`;
            return iso;
        }
        m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? s : null;
    }

    function parseAmountInput(t) {
        const s = String(t || '').replace(/€|eur/gi, '').trim();
        const r = require('./receipt-scan').parseAmount(s);
        if (r !== null) return r;
        const m = s.match(/^(\d+)$/);
        return m ? parseInt(m[1], 10) : null;
    }

    // -----------------------------------------------------------------------
    // Ansicht
    // -----------------------------------------------------------------------
    const pct = v => `${String(v).replace('.', ',')} %`;

    function summaryText(s) {
        const d = s.data;
        const lines = [];
        const head = s.manual ? '🧾 <b>Neue Ausgabe</b>' : `🧾 <b>Beleg erkannt</b> <i>(${s.engine === 'ki' ? 'KI' : 'Texterkennung'})</i>`;
        lines.push(head, '');
        lines.push(`🏪 Händler: ${d.vendor ? `<b>${esc(d.vendor)}</b>` : '❓ <i>nicht erkannt</i>'}`);
        lines.push(`📅 Datum: <b>${fmtDate(d.date)}</b>${s.dateGuessed ? ' <i>(nicht erkannt, heute angenommen)</i>' : ''}`);
        lines.push(`💶 Betrag: ${d.amount !== null && d.amount !== undefined ? `<b>${fmtMoney(d.amount)}</b>` : '❓ <i>nicht erkannt</i>'}`);
        lines.push(`🏷 Kategorie: ${d.category ? `<b>${esc(d.category)}</b>` : '❓ <i>bitte wählen</i>'}`);
        if (d.vat_amount !== null && d.vat_amount !== undefined) lines.push(`🧮 MwSt: ${fmtMoney(d.vat_amount)}${d.vat_rate !== null && d.vat_rate !== undefined ? ` (${pct(d.vat_rate)})` : ''}`);
        else if (d.vat_rate !== null && d.vat_rate !== undefined) lines.push(`🧮 MwSt: ${pct(d.vat_rate)}`);
        if (d.payment_method) lines.push(`💳 Zahlart: ${esc(d.payment_method)}`);
        if (d.description) lines.push(`📝 ${esc(d.description)}`);
        if (s.file && R().paperlessReady()) lines.push(`📄 Paperless: ${s.paperless ? 'wird nach dem Speichern abgelegt' : '<i>nicht ablegen</i>'}`);
        if (s.aiError) lines.push('', `<i>ℹ️ KI nicht erreichbar, Texterkennung benutzt: ${esc(short(s.aiError, 90))}</i>`);
        lines.push('', 'Stimmt das so? Tippe auf einen Wert, um ihn zu ändern.');
        return lines.join('\n');
    }

    function confirmKeyboard(s) {
        const rows = [
            [btn('✅ Speichern', 'rc:ok')],
            [btn('💶 Betrag', 'rc:e:amount'), btn('📅 Datum', 'rc:e:date'), btn('🏪 Händler', 'rc:e:vendor')],
            [btn('🏷 Kategorie', 'rc:cat'), btn('📝 Beschreibung', 'rc:e:description')]
        ];
        if (s.file && R().paperlessReady()) rows.push([btn(s.paperless ? '📄 Paperless: an ✓' : '📄 Paperless: aus', 'rc:pl')]);
        rows.push([btn('❌ Verwerfen', 'rc:cancel')]);
        return keyboard(rows);
    }

    function showConfirm(bot, chatId, s) {
        s.step = 'confirm';
        touch(s);
        return send(bot, chatId, summaryText(s), confirmKeyboard(s), s);
    }

    const ASK = {
        amount: '💶 <b>Wie hoch ist der Betrag?</b>\nz. B. <code>23,50</code>',
        date: '📅 <b>Von wann ist der Beleg?</b>\nz. B. <code>24.11.</code>, <code>24.11.2026</code> oder <code>gestern</code>',
        vendor: '🏪 <b>Bei wem wurde gekauft?</b>\nz. B. <code>OBI</code>',
        description: '📝 <b>Was wurde gekauft?</b>\nz. B. <code>Duschkopf und Silikon</code> (oder <code>-</code> für leer)'
    };

    function askField(bot, chatId, s, field) {
        s.step = `edit:${field}`;
        touch(s);
        return send(bot, chatId, ASK[field], keyboard([[btn('⬅️ Zurück', 'rc:back'), btn('❌ Verwerfen', 'rc:cancel')]]), s);
    }

    function showCategories(bot, chatId, s) {
        s.step = 'category';
        touch(s);
        const cats = R().CATEGORIES;
        const rows = [];
        for (let i = 0; i < cats.length; i += 2) {
            rows.push(cats.slice(i, i + 2).map((c, j) => btn((s.data.category === c ? '✓ ' : '') + c, `rc:c:${i + j}`)));
        }
        rows.push([btn('⬅️ Zurück', 'rc:back')]);
        return send(bot, chatId, '🏷 <b>Welche Kategorie?</b>', keyboard(rows), s);
    }

    // -----------------------------------------------------------------------
    // Start
    // -----------------------------------------------------------------------
    function newSession(chatId, extra) {
        const old = sessions.get(chatId);
        if (old && old.flow === 'receipt') cleanup(old);
        const s = {
            flow: 'receipt', step: 'await', data: { vendor: null, date: todayYmd(), amount: null, category: null, description: null, vat_rate: null, vat_amount: null, payment_method: null, invoice_number: null },
            updatedAt: Date.now(), lastMsgId: null, busy: false, file: null, tmpDir: null, paperless: false, engine: null, text: '', ...extra
        };
        sessions.set(chatId, s);
        return s;
    }

    async function askForPhoto(bot, chatId) {
        sweepTmp();
        const s = newSession(chatId, {});
        return send(bot, chatId, '📸 <b>Beleg erfassen</b>\n\nSchick mir ein <b>Foto</b> vom Kassenbon oder die Rechnung als <b>PDF</b>. ' +
            'Ich lese Betrag, Datum, Händler und Kategorie aus und frage dann nach.\n\n' +
            '<i>Ohne Beleg geht es auch als Text, z. B.</i> <code>/beleg 12,50 REWE Putzmittel</code>',
            keyboard([[btn('❌ Abbrechen', 'rc:cancel')]]), s);
    }

    /** /beleg 12,50 REWE Putzmittel (ohne Foto) */
    async function fromText(bot, chatId, text) {
        const scan = require('./receipt-scan');
        const s = newSession(chatId, { manual: true });
        let rest = String(text || '');
        const am = rest.match(/(\d{1,3}(?:\.\d{3})*,\d{1,2}|\d+[.,]\d{1,2}|\d+)\s*(€|eur\b)?/i);
        if (am) { s.data.amount = parseAmountInput(am[1]); rest = rest.replace(am[0], ' '); }
        const dm = rest.match(/\b(\d{1,2}\.\d{1,2}\.(?:\d{2,4})?|heute|gestern)\b/i);
        if (dm) { const d = parseDateInput(dm[1]); if (d) { s.data.date = d; rest = rest.replace(dm[0], ' '); } }
        const words = rest.replace(/\s+/g, ' ').trim();
        if (words) {
            const parts = words.split(' ');
            s.data.vendor = parts[0];
            s.data.description = parts.slice(1).join(' ') || null;
        }
        s.data.category = scan.guessCategory(words) || null;
        return showConfirm(bot, chatId, s);
    }

    /**
     * Foto/PDF wurde heruntergeladen (und evtl. schon per OCR gelesen).
     * @param {{ filePath, mime, name, text, msgId }} f  Datei liegt in f.tmpDir und gehört ab jetzt der Session
     */
    async function fromFile(bot, chatId, f, from) {
        const old = sessions.get(chatId);
        const s = old && old.flow === 'receipt' && old.step === 'await' ? old : newSession(chatId, {});
        if (old && old !== s) cleanup(old);
        Object.assign(s, { manual: false, file: { path: f.filePath, mime: f.mime, name: f.name }, tmpDir: f.tmpDir, busy: true, from });
        const c = R().getConfig();
        s.paperless = !!(c.upload.enabled && R().paperlessReady());
        const wait = await send(bot, chatId, c.ai.enabled && c.ai.apiKey ? '🔍 <b>Ich lese den Beleg …</b> (KI)' : '🔍 <b>Ich lese den Beleg …</b>\nDas dauert ein paar Sekunden.');
        bot.sendChatAction(chatId, 'typing').catch(() => { });
        try {
            const r = await R().scanFile(f.filePath, f.mime, f.text);
            s.engine = r.engine;
            s.text = r.text || '';
            s.aiError = r.aiError || null;
            const d = r.result || {};
            for (const k of Object.keys(s.data)) if (d[k] !== null && d[k] !== undefined && d[k] !== '') s.data[k] = d[k];
            s.dateGuessed = !d.date;
            if (!s.data.category && s.data.vendor) s.data.category = require('./receipt-scan').guessCategory(s.data.vendor);
        } catch (e) {
            console.error('[TG] Beleg lesen:', e.message);
            s.engine = 'ocr';
            s.dateGuessed = true;
            await send(bot, chatId, `⚠️ Den Beleg konnte ich nicht lesen (${esc(short(e.message, 100))}). Bitte die Werte unten selbst eintragen.`);
        } finally {
            s.busy = false;
            if (wait) bot.deleteMessage(chatId, wait.message_id).catch(() => { });
        }
        return showConfirm(bot, chatId, s);
    }

    // -----------------------------------------------------------------------
    // Eingaben
    // -----------------------------------------------------------------------
    async function handleInput(bot, chatId, s, body) {
        touch(s);
        if (s.step === 'await') {
            // Text statt Foto: als Ausgabe ohne Beleg verstehen, wenn ein Betrag drin steht
            if (/\d/.test(body)) return fromText(bot, chatId, body);
            return send(bot, chatId, '📸 Bitte ein Foto oder PDF schicken – oder z. B. <code>12,50 REWE Putzmittel</code>.', keyboard([[btn('❌ Abbrechen', 'rc:cancel')]]), s);
        }
        if (s.step === 'edit:amount') {
            const a = parseAmountInput(body);
            if (a === null || a <= 0 || a > 1000000) return send(bot, chatId, '🤔 Das ist kein Betrag. Bitte z. B. <code>23,50</code> schreiben.', keyboard([[btn('⬅️ Zurück', 'rc:back')]]), s);
            s.data.amount = a;
            // MwSt passt dann nicht mehr sicher
            if (s.data.vat_rate) s.data.vat_amount = Math.round((a - a / (1 + s.data.vat_rate / 100)) * 100) / 100;
            return showConfirm(bot, chatId, s);
        }
        if (s.step === 'edit:date') {
            const d = parseDateInput(body);
            if (!d) return send(bot, chatId, '🤔 Datum nicht erkannt. Bitte z. B. <code>24.11.2026</code> schreiben.', keyboard([[btn('⬅️ Zurück', 'rc:back')]]), s);
            s.data.date = d;
            s.dateGuessed = false;
            return showConfirm(bot, chatId, s);
        }
        if (s.step === 'edit:vendor' || s.step === 'edit:description') {
            const field = s.step.slice(5);
            const v = body.trim();
            s.data[field] = v === '-' || !v ? null : v.slice(0, field === 'vendor' ? 80 : 200);
            if (field === 'vendor' && s.data.vendor) {
                const cat = require('./receipt-scan').guessCategory(s.data.vendor);
                if (cat && !s.data.category) s.data.category = cat;
            }
            return showConfirm(bot, chatId, s);
        }
        return showConfirm(bot, chatId, s);
    }

    async function save(bot, chatId, s, who) {
        if (s.busy) return;
        if (s.data.amount === null || s.data.amount === undefined) return askField(bot, chatId, s, 'amount');
        if (!s.data.category) return showCategories(bot, chatId, s);
        s.busy = true;
        let row;
        try {
            let extra = { source: 'telegram', created_by: who ? `Telegram: ${who}` : 'Telegram', engine: s.engine, ocr_text: s.text };
            if (s.file) {
                const f = R().storeFile(s.file.path, s.file.mime, s.file.name);
                extra = { ...extra, receipt_file: f.file, receipt_mime: f.mime, receipt_name: f.name };
            }
            row = R().createExpense({ ...s.data }, extra);
        } catch (e) {
            s.busy = false;
            return send(bot, chatId, `❌ <b>Konnte nicht speichern:</b> ${esc(e.message)}`, confirmKeyboard(s), s);
        }
        cleanup(s);
        sessions.delete(chatId);
        if (s.lastMsgId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: s.lastMsgId }).catch(() => { });
        const sendPl = !!(row.receipt_file && s.paperless && R().paperlessReady());
        const text = `✅ <b>Ausgabe gespeichert</b>\n${esc(row.vendor || row.description || 'Beleg')} · ${fmtMoney(row.amount)} · ${fmtDate(row.date)}\n🏷 ${esc(row.category || '')}` +
            (sendPl ? '\n📄 Wird in Paperless abgelegt …' : '') +
            '\n\n<i>Steht jetzt in der Admin-App unter „Ausgaben“ und in der Finanz-Auswertung.</i>';
        await send(bot, chatId, text, keyboard([[btn('📸 Noch ein Beleg', 'rc:new'), btn('💶 Ausgaben', 'rc:list')], [btn('🏠 Hauptmenü', 'menu')]]));
        if (sendPl) {
            R().uploadToPaperless(row.id).then(r => {
                if (r.ok && r.documentId) {
                    const kb = r.url && /^https?:\/\//.test(r.url) ? keyboard([[{ text: '📄 In Paperless öffnen', url: r.url }]]) : undefined;
                    return send(bot, chatId, r.duplicateOf ? `📄 Paperless: Diesen Beleg gab es dort schon (Dokument #${r.documentId}), er ist jetzt verknüpft.` : `📄 In Paperless abgelegt (Dokument #${r.documentId}).`, kb);
                }
                if (r.ok) return send(bot, chatId, `📄 An Paperless geschickt. ${esc(r.error || '')}`);
                return send(bot, chatId, `⚠️ <b>Paperless:</b> ${esc(short(r.error, 200))}\nDu kannst es in der Admin-App unter „Ausgaben“ erneut versuchen.`);
            }).catch(e => send(bot, chatId, `⚠️ <b>Paperless:</b> ${esc(short(e.message, 200))}`));
        }
    }

    async function cancel(bot, chatId, s) {
        cleanup(s);
        if (s.lastMsgId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: s.lastMsgId }).catch(() => { });
        sessions.delete(chatId);
        return send(bot, chatId, '🗑 Beleg verworfen, nichts gespeichert.', menuOnlyKeyboard());
    }

    /** Buttons "rc:…" */
    async function handleCallback(bot, chatId, s, data, who) {
        if (data === 'rc:new') return askForPhoto(bot, chatId);
        if (data === 'rc:list') return showExpenses(bot, chatId);
        if (!s || s.flow !== 'receipt') return send(bot, chatId, 'Dieser Beleg ist nicht mehr offen.', menuOnlyKeyboard());
        if (s.busy) return;
        touch(s);
        if (data === 'rc:cancel') return cancel(bot, chatId, s);
        if (data === 'rc:back') return s.step === 'await' ? cancel(bot, chatId, s) : showConfirm(bot, chatId, s);
        if (data === 'rc:ok') return save(bot, chatId, s, who);
        if (data === 'rc:pl') { s.paperless = !s.paperless; return showConfirm(bot, chatId, s); }
        if (data === 'rc:cat') return showCategories(bot, chatId, s);
        if (data.startsWith('rc:c:')) {
            const c = R().CATEGORIES[parseInt(data.slice(5), 10)];
            if (c) s.data.category = c;
            return showConfirm(bot, chatId, s);
        }
        if (data.startsWith('rc:e:')) {
            const f = data.slice(5);
            if (ASK[f]) return askField(bot, chatId, s, f);
        }
    }

    // -----------------------------------------------------------------------
    // /ausgaben
    // -----------------------------------------------------------------------
    async function showExpenses(bot, chatId) {
        const sql = require('./db').getDb();
        const today = todayYmd();
        const ym = today.slice(0, 7), y = today.slice(0, 4);
        const sum = (where, ...a) => sql.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM expenses WHERE ${where}`).get(...a);
        const m = sum("substr(date, 1, 7) = ?", ym);
        const yr = sum("substr(date, 1, 4) = ?", y);
        const cats = sql.prepare("SELECT COALESCE(category, 'Ohne Kategorie') AS c, SUM(amount) AS s FROM expenses WHERE substr(date, 1, 4) = ? GROUP BY c ORDER BY s DESC LIMIT 4").all(y);
        const last = sql.prepare('SELECT date, vendor, description, amount, receipt_file, paperless_id FROM expenses ORDER BY date DESC, id DESC LIMIT 6').all();
        const MON = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
        let text = '💶 <b>Ausgaben</b>\n\n' +
            `${MON[parseInt(ym.slice(5), 10) - 1]}: <b>${fmtMoney(m.s)}</b> (${m.n} Beleg${m.n === 1 ? '' : 'e'})\n` +
            `${y} gesamt: <b>${fmtMoney(yr.s)}</b> (${yr.n})\n`;
        if (cats.length) text += '\n' + cats.map(c => `• ${esc(c.c)}: ${fmtMoney(c.s)}`).join('\n') + '\n';
        if (last.length) {
            text += '\n<b>Zuletzt</b>\n' + last.map(e => `${fmtDate(e.date).slice(0, 6)} ${esc(short(e.vendor || e.description || 'Beleg', 22))} – ${fmtMoney(e.amount)}${e.receipt_file || e.paperless_id ? ' 📎' : ''}`).join('\n');
        }
        return send(bot, chatId, text, keyboard([[btn('📸 Beleg erfassen', 'rc:new')], [btn('🏠 Hauptmenü', 'menu')]]));
    }

    return { askForPhoto, fromText, fromFile, handleInput, handleCallback, showExpenses, cleanup, sweepTmp, TMP_PREFIX };
};
