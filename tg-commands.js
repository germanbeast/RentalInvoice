const db = require('./db');
const botLogic = require('./bot-logic');
const fs = require('fs');

/**
 * Telegram booking assistant
 *
 * - Hauptmenü mit Inline-Buttons + gefülltes "/"-Befehlsmenü (setMyCommands)
 * - Dialoge (Rechnung / Tür-Code) mit Slot-Filling: Angaben aus der ersten Nachricht werden übernommen,
 *   es wird nur nach dem gefragt, was fehlt
 * - In JEDEM Schritt: ⬅️ Zurück und ❌ Abbrechen (als Button und als Text: "zurück" / "abbrechen")
 * - Zusammenfassung mit Bestätigung, bevor ein echter Tür-Code oder eine Rechnung erzeugt wird
 * - Sessions laufen nach 10 Minuten Inaktivität ab
 * - Ausgabe als HTML (escaped) - Namen mit _ oder * können Nachrichten nicht mehr zerstören
 */

const SESSION_TTL_MS = 10 * 60 * 1000;

// chatId -> session
const sessions = new Map();

// ---------------------------------------------------------------------------
// Flow-Definitionen
// ---------------------------------------------------------------------------
const FLOWS = {
    invoice: { title: 'Neue Rechnung', icon: '🧾', steps: ['name', 'address', 'email', 'dates', 'payment'] },
    pin: { title: 'Tür-Code', icon: '🔑', steps: ['name', 'dates'] },
    guestname: { title: 'Gastname eintragen', icon: '👤', steps: ['name'] }
};

const FIELD_LABELS = { name: 'Name', address: 'Adresse', email: 'E-Mail', dates: 'Zeitraum', payment: 'Zahlung' };

const PAY_METHODS = ['Überweisung', 'Bar', 'PayPal', 'Booking.com', 'Airbnb'];

const BACK_WORDS = new Set(['zurück', 'zurueck', 'zurück.', 'back', '/zurück', '/zurueck', '/back']);
const CANCEL_WORDS = new Set(['abbrechen', 'abbruch', 'cancel', 'stop', '/abbrechen', '/cancel', '/stop']);
const MENU_WORDS = new Set(['menü', 'menu', '/menü', '/menu']);
const SKIP_WORDS = new Set(['überspringen', 'ueberspringen', 'skip', '-', '/skip', '/überspringen']);

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------
function esc(s) {
    return String(s === undefined || s === null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function fmtDate(iso) {
    if (!iso) return '—';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso);
}

function fmtMoney(n) {
    return `${Number(n || 0).toFixed(2).replace('.', ',')} €`;
}

function short(s, n = 28) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function btn(text, data) {
    return { text, callback_data: data };
}

function keyboard(rows) {
    return { inline_keyboard: rows };
}

function mainMenuKeyboard() {
    return keyboard([
        [btn('🧾 Neue Rechnung', 'new:invoice'), btn('🔑 Nur Tür-Code', 'new:pin')],
        [btn('🔐 Türcodes', 'codes'), btn('📅 Anreisen', 'arrivals')],
        [btn('🔄 Kalender abfragen', 'sync'), btn('📋 Offene Rechnungen', 'open')],
        [btn('❓ Hilfe', 'help')]
    ]);
}

function menuOnlyKeyboard() {
    return keyboard([[btn('🏠 Hauptmenü', 'menu')]]);
}

function touch(session) {
    session.updatedAt = Date.now();
}

function getActiveSession(chatId) {
    const s = sessions.get(chatId);
    if (!s) return null;
    if (Date.now() - s.updatedAt > SESSION_TTL_MS && !s.busy) {
        sessions.delete(chatId);
        return 'expired';
    }
    return s;
}

// Regelmäßig abgelaufene Sessions wegräumen (Speicher)
const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
        if (!s.busy && now - s.updatedAt > SESSION_TTL_MS * 3) sessions.delete(id);
    }
}, 5 * 60 * 1000);
if (sweeper.unref) sweeper.unref();

/**
 * Sendet eine Nachricht und entfernt dabei die Buttons der vorherigen Bot-Nachricht
 * dieser Session (damit keine veralteten Buttons herumliegen).
 */
async function send(bot, chatId, text, replyMarkup, session) {
    if (session && session.lastMsgId) {
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: session.lastMsgId }).catch(() => { });
        session.lastMsgId = null;
    }
    const opts = { parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyMarkup) opts.reply_markup = replyMarkup;
    try {
        const sent = await bot.sendMessage(chatId, text, opts);
        if (session && replyMarkup) session.lastMsgId = sent.message_id;
        return sent;
    } catch (e) {
        console.error('[TG] sendMessage fehlgeschlagen:', e.message);
        // Fallback ohne Formatierung
        try {
            const plain = text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
            const sent = await bot.sendMessage(chatId, plain, replyMarkup ? { reply_markup: replyMarkup } : {});
            if (session && replyMarkup) session.lastMsgId = sent.message_id;
            return sent;
        } catch (e2) {
            console.error('[TG] sendMessage (Fallback) fehlgeschlagen:', e2.message);
        }
    }
}

// ---------------------------------------------------------------------------
// Hauptmenü, Hilfe, Listen
// ---------------------------------------------------------------------------
async function showMenu(bot, chatId, intro) {
    const text = (intro ? `${intro}\n\n` : '') + '<b>🏠 Buchungs-Assistent</b>\nWas möchtest du tun?';
    return send(bot, chatId, text, mainMenuKeyboard());
}

async function showHelp(bot, chatId) {
    const text =
        '<b>🏠 Buchungs-Assistent – Hilfe</b>\n\n' +
        '<b>Befehle</b>\n' +
        '• <code>/rechnung</code> – neue Rechnung (inkl. Tür-Code)\n' +
        '• <code>/pin</code> – nur einen Tür-Code erstellen\n' +
        '• <code>/status</code> – offene Rechnungen\n' +
        '• <code>/codes</code> – Türcodes live aus Nuki anzeigen\n' +
        '• <code>/namen</code> – Gastnamen zu Buchungen nachtragen\n' +
        '• <code>/sync</code> – Booking.com &amp; Airbnb jetzt abfragen\n' +
        '• <code>/anreisen</code> – kommende Buchungen\n' +
        '• <code>/menu</code> – Hauptmenü\n\n' +
        '<b>Schnell starten</b>\n' +
        'Du kannst gleich alles in eine Nachricht schreiben, z.B.\n' +
        '<code>Rechnung Max Mustermann\nMusterstr. 1\n12345 Musterstadt\n15.03. - 20.03.2026</code>\n' +
        'Der Bot übernimmt, was er erkennt, und fragt nur nach dem Rest.\n\n' +
        '<b>Jederzeit möglich</b>\n' +
        '• ⬅️ <b>Zurück</b> (oder „zurück“) – einen Schritt zurück\n' +
        '• ❌ <b>Abbrechen</b> (oder „abbrechen“) – Vorgang beenden\n' +
        'Vor dem Erstellen siehst du immer eine Zusammenfassung zum Bestätigen.';
    return send(bot, chatId, text, menuOnlyKeyboard());
}

async function showOpenInvoices(bot, chatId) {
    let open = [];
    try { open = db.getOpenInvoices(); } catch (e) { console.error('[TG] getOpenInvoices:', e.message); }
    if (!open.length) {
        return send(bot, chatId, '✅ Aktuell keine offenen Rechnungen.', menuOnlyKeyboard());
    }
    let total = 0;
    let text = `<b>📋 Offene Rechnungen (${open.length})</b>\n\n`;
    open.forEach(inv => {
        total += Number(inv.total_amount) || 0;
        text += `• <code>${esc(inv.invoice_number)}</code> – ${esc(inv.guest_display_name)}: ${fmtMoney(inv.total_amount)}\n`;
    });
    text += `\n<b>Summe: ${fmtMoney(total)}</b>`;
    return send(bot, chatId, text, menuOnlyKeyboard());
}

const fmtBerlin = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
});

async function showCodes(bot, chatId) {
    bot.sendChatAction(chatId, 'typing').catch(() => { });
    let codes;
    try {
        codes = await botLogic.listNukiCodes();
    } catch (e) {
        console.error('[TG] Nuki-Codes:', e.message);
        return send(bot, chatId, `❌ <b>Türcodes konnten nicht von Nuki geladen werden.</b>\n${esc(e.message)}`,
            keyboard([[btn('🔁 Erneut versuchen', 'codes'), btn('🏠 Hauptmenü', 'menu')]]));
    }

    const now = Date.now();
    const isExpired = c => c.until && new Date(c.until).getTime() < now;
    const current = codes.filter(c => !isExpired(c));
    const expiredCount = codes.length - current.length;

    if (!current.length) {
        const extra = expiredCount ? `\n<i>(${expiredCount} abgelaufene Einträge ausgeblendet)</i>` : '';
        return send(bot, chatId, `🔐 Aktuell sind keine gültigen Türcodes im Nuki-Schloss angelegt.${extra}`, menuOnlyKeyboard());
    }

    const MAX = 25;
    const shown = current.slice(0, MAX);
    let text = `<b>🔐 Türcodes im Nuki-Schloss (${current.length})</b>\n<i>Live-Abfrage</i>\n\n`;
    shown.forEach(c => {
        const started = !c.from || new Date(c.from).getTime() <= now;
        const icon = !c.enabled ? '⛔' : (started ? '🟢' : '⏳');
        const period = (c.from || c.until)
            ? `${c.from ? fmtBerlin.format(new Date(c.from)) : '…'} – ${c.until ? fmtBerlin.format(new Date(c.until)) : 'unbefristet'}`
            : 'unbefristet';
        text += `${icon} <b>${esc(short(c.name, 30))}</b>${c.enabled ? '' : ' (deaktiviert)'}\n` +
            `   🔑 <code>${esc(c.code)}</code>  ·  ${esc(period)}\n`;
    });
    if (current.length > MAX) text += `\n… und ${current.length - MAX} weitere\n`;
    if (expiredCount) text += `\n<i>${expiredCount} abgelaufene Einträge ausgeblendet</i>`;
    text += '\n🟢 gültig · ⏳ noch nicht gültig · ⛔ deaktiviert';
    return send(bot, chatId, text, keyboard([[btn('🔄 Aktualisieren', 'codes'), btn('🏠 Hauptmenü', 'menu')]]));
}

// ---------------------------------------------------------------------------
// Gastnamen nachtragen (Kalender liefern oft nur "Not available")
// ---------------------------------------------------------------------------
function guessNameFromSummary(summary) {
    return String(summary || '').split('(')[0].replace(/^(Buchung|Gast|Airbnb):/i, '').trim();
}

function getBookingRow(id) {
    return db.getDb().prepare(`
        SELECT b.*, g.name AS guest_name, g.address AS guest_address, g.email AS guest_email
        FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
        WHERE b.id = ?
    `).get(id);
}

function bookingsNeedingName() {
    const rows = db.getDb().prepare(`
        SELECT b.id, b.summary, b.checkin, b.checkout, g.name AS guest_name
        FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
        WHERE b.checkout >= date('now') AND b.uid NOT LIKE 'manual-%'
        ORDER BY b.checkin ASC
    `).all();
    return rows.filter(r => botLogic.isPlaceholderGuestName(r.guest_name || guessNameFromSummary(r.summary)));
}

async function startNameFlow(bot, chatId, bookingId) {
    const b = getBookingRow(bookingId);
    if (!b) return send(bot, chatId, '⚠️ Diese Buchung existiert nicht mehr.', menuOnlyKeyboard());

    const old = sessions.get(chatId);
    if (old && old.lastMsgId) {
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: old.lastMsgId }).catch(() => { });
    }
    const source = /^airbnb/i.test(b.summary || '') ? 'Airbnb' : 'Booking.com';
    const session = {
        flow: 'guestname', step: null, bookingId, booking: { checkin: b.checkin, checkout: b.checkout, source },
        data: { gName: '' }, updatedAt: Date.now(), lastMsgId: null, sequential: false, editing: false, busy: false
    };
    sessions.set(chatId, session);
    return askStep(bot, chatId, session, 'name');
}

async function executeGuestName(bot, chatId, session) {
    if (session.busy) return;
    session.busy = true;
    touch(session);
    try {
        bot.sendChatAction(chatId, 'typing').catch(() => { });
        const r = await botLogic.applyGuestName(session.bookingId, session.data.gName);
        sessions.delete(chatId);

        let text = `✅ <b>Gast gespeichert:</b> ${esc(r.name)}\n📅 ${fmtDate(r.booking.checkin)} – ${fmtDate(r.booking.checkout)}\n`;
        if (r.booking.nuki_auth_id) {
            text += r.nukiRenamed
                ? '🔑 Der Türcode wurde im Nuki-Schloss umbenannt.\n'
                : `⚠️ Der Türcode konnte in Nuki nicht umbenannt werden: ${esc(short(r.nukiError, 120))}\n(Der Code selbst funktioniert weiterhin.)\n`;
        }
        const left = (() => { try { return bookingsNeedingName().length; } catch (e) { return 0; } })();
        const rows = [[btn('🧾 Rechnung erstellen', `inv:${session.bookingId}`)]];
        if (left > 0) rows.push([btn(`👤 Weitere Namen offen (${left})`, 'names')]);
        rows.push([btn('🔐 Türcodes', 'codes'), btn('🏠 Hauptmenü', 'menu')]);
        return send(bot, chatId, text, keyboard(rows));
    } catch (e) {
        console.error('[TG] Gastname speichern:', e);
        session.busy = false;
        session.step = 'name';
        return send(bot, chatId, `❌ <b>Fehler:</b> ${esc(e.message)}\n\nBitte den Namen erneut eingeben.`, stepKeyboard(session, 'name'), session);
    }
}

async function showNamesOpen(bot, chatId) {
    let rows;
    try { rows = bookingsNeedingName(); } catch (e) {
        console.error('[TG] Namen-Abfrage:', e.message);
        return send(bot, chatId, '❌ Buchungen konnten nicht geladen werden.', menuOnlyKeyboard());
    }
    if (!rows.length) return send(bot, chatId, '✅ Für alle kommenden Buchungen ist ein Gastname hinterlegt.', menuOnlyKeyboard());
    const shown = rows.slice(0, 8);
    const kb = shown.map(r => [btn(`👤 ${fmtDate(r.checkin).slice(0, 6)}–${fmtDate(r.checkout).slice(0, 6)} · Namen eintragen`, `nm:${r.id}`)]);
    kb.push([btn('🏠 Hauptmenü', 'menu')]);
    const more = rows.length > shown.length ? `\n… und ${rows.length - shown.length} weitere` : '';
    return send(bot, chatId, `<b>👤 Buchungen ohne Gastnamen (${rows.length})</b>\nWähle eine Buchung:${more}`, keyboard(kb));
}

async function startInvoiceFromBooking(bot, chatId, bookingId) {
    const b = getBookingRow(bookingId);
    if (!b || !b.guest_name || botLogic.isPlaceholderGuestName(b.guest_name)) {
        return send(bot, chatId, '⚠️ Bitte zuerst den Gastnamen eintragen.', keyboard([[btn('👤 Namen eintragen', `nm:${bookingId}`), btn('🏠 Hauptmenü', 'menu')]]));
    }
    const prefill = { gName: b.guest_name, arrival: b.checkin, departure: b.checkout };
    if (b.guest_address) prefill.gAdresse = b.guest_address;
    if (b.guest_email) prefill.gEmail = b.guest_email;
    return startFlow(bot, chatId, 'invoice', '', prefill);
}

let hooks = {};

async function runSync(bot, chatId) {
    if (!hooks.syncCalendars) {
        return send(bot, chatId, '❌ Die Kalenderabfrage ist nicht verfügbar.', menuOnlyKeyboard());
    }
    bot.sendChatAction(chatId, 'typing').catch(() => { });
    const pending = await send(bot, chatId, '🔄 Kalender werden abgefragt …');
    let r;
    try {
        r = await hooks.syncCalendars();
    } catch (e) {
        console.error('[TG] Kalenderabfrage:', e.message);
        return send(bot, chatId, `❌ <b>Abfrage fehlgeschlagen:</b> ${esc(e.message)}`, menuOnlyKeyboard());
    }
    if (r.busy) return send(bot, chatId, '⏳ Eine Abfrage läuft bereits – bitte gleich noch einmal versuchen.', menuOnlyKeyboard());
    if (r.noFeeds) return send(bot, chatId, '⚠️ Es ist kein iCal-Link hinterlegt (Booking.com oder Airbnb). Bitte in den Einstellungen im Webinterface eintragen.', menuOnlyKeyboard());

    let text = '<b>🔄 Kalenderabfrage abgeschlossen</b>\n\n';
    r.feeds.forEach(f => {
        text += f.ok
            ? `✅ <b>${esc(f.source)}</b>: ${f.events} Einträge, ${f.newCount} neu${f.cancelled ? `, ${f.cancelled} storniert` : ''}\n`
            : `❌ <b>${esc(f.source)}</b>: ${esc(short(f.error, 80))}\n`;
    });
    text += r.newCount > 0
        ? `\n🏠 ${r.newCount} neue Buchung(en) erkannt – Türcode wurde angelegt (Details in der Benachrichtigung).`
        : '\nKeine neuen Buchungen.';
    if (r.adjusted && r.adjusted.length) text += `\n🔧 ${r.adjusted.length} Türcode-Zeitraum angepasst.`;
    return send(bot, chatId, text, keyboard([[btn('🔐 Türcodes', 'codes'), btn('🏠 Hauptmenü', 'menu')]]));
}

async function showArrivals(bot, chatId) {
    let rows = [];
    try {
        rows = db.getDb().prepare(`
            SELECT b.summary, b.checkin, b.checkout, b.nuki_pin, g.name AS guest_name
            FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
            WHERE b.checkout >= date('now')
            ORDER BY b.checkin ASC
            LIMIT 10
        `).all();
    } catch (e) {
        console.error('[TG] Anreisen-Abfrage:', e.message);
        return send(bot, chatId, '❌ Buchungen konnten nicht geladen werden.', menuOnlyKeyboard());
    }
    if (!rows.length) {
        return send(bot, chatId, '📅 Keine kommenden Buchungen.', menuOnlyKeyboard());
    }
    let text = '<b>📅 Kommende Buchungen</b>\n\n';
    rows.forEach(r => {
        const real = r.guest_name || guessNameFromSummary(r.summary);
        const missing = botLogic.isPlaceholderGuestName(real);
        const name = missing ? '❓ Name fehlt' : short(real, 36);
        text += `• ${fmtDate(r.checkin)} – ${fmtDate(r.checkout)}\n   ${esc(name)}${r.nuki_pin ? `  🔑 <code>${esc(r.nuki_pin)}</code>` : ''}\n`;
    });
    let missingCount = 0;
    try { missingCount = bookingsNeedingName().length; } catch (e) { /* ignore */ }
    const kb = [];
    if (missingCount > 0) kb.push([btn(`👤 Namen eintragen (${missingCount})`, 'names')]);
    kb.push([btn('🏠 Hauptmenü', 'menu')]);
    return send(bot, chatId, text, keyboard(kb));
}

// ---------------------------------------------------------------------------
// Slot-Filling-Engine
// ---------------------------------------------------------------------------
function isFilled(step, data) {
    switch (step) {
        case 'name': return !!data.gName;
        case 'address': return !!data.gAdresse;
        case 'email': return data.gEmail !== undefined; // null = bewusst übersprungen
        case 'dates': return !!(data.arrival && data.departure);
        case 'payment': return !!data.zMethode;
        default: return false;
    }
}

function valueText(step, data) {
    switch (step) {
        case 'name': return data.gName;
        case 'address': return String(data.gAdresse || '').replace(/\n/g, ', ');
        case 'email': return data.gEmail === null ? '(übersprungen)' : data.gEmail;
        case 'dates': return `${fmtDate(data.arrival)} – ${fmtDate(data.departure)}`;
        case 'payment': return data.zMethode;
        default: return '';
    }
}

function clearSlot(step, data) {
    switch (step) {
        case 'name': data.gName = ''; break;
        case 'address': data.gAdresse = ''; break;
        case 'email': delete data.gEmail; break;
        case 'dates': data.arrival = ''; data.departure = ''; break;
        case 'payment': delete data.zMethode; break;
    }
}

function promptFor(session, step) {
    const flow = FLOWS[session.flow];
    const idx = flow.steps.indexOf(step);
    const progress = `Schritt ${idx + 1}/${flow.steps.length}`;
    if (session.flow === 'guestname') {
        const b = session.booking || {};
        return `${flow.icon} <b>${flow.title}</b>\n\n` +
            `Buchung: <b>${fmtDate(b.checkin)} – ${fmtDate(b.checkout)}</b>${b.source ? ` (${esc(b.source)})` : ''}\n\n` +
            'Wie heißt der Gast?\n<i>Bitte Vor- und Nachname angeben.</i>';
    }
    const head = `${flow.icon} <b>${flow.title}</b> · ${progress}\n\n`;
    const forWho = session.flow === 'pin' ? 'Für wen soll der Tür-Code erstellt werden?' : 'Für wen ist die Rechnung?';
    switch (step) {
        case 'name': return head + `${forWho}\n<i>Bitte Vor- und Nachname angeben.</i>`;
        case 'address': return head + 'Wie lautet die Adresse des Gastes?\n<i>Straße, PLZ und Ort – gern mehrzeilig.</i>';
        case 'email': return head + 'Wie lautet die E-Mail-Adresse?\n<i>Optional – du kannst auch überspringen.</i>';
        case 'dates': return head + 'Für welchen Zeitraum?\n<i>z.B. 15.03. - 20.03.2026</i>';
        case 'payment': return head + 'Wie wurde die Rechnung bezahlt?\n<i>Tippe auf eine Zahlungsart.</i>';
        default: return head;
    }
}

function stepKeyboard(session, step) {
    const flow = FLOWS[session.flow];
    const idx = flow.steps.indexOf(step);
    const rows = [];

    const top = [];
    if (isFilled(step, session.data)) {
        top.push(btn(`✅ Behalten: ${short(valueText(step, session.data), 24)}`, 'keep'));
    }
    if (step === 'email') top.push(btn('⏭ Überspringen', 'skip'));
    if (step === 'payment') {
        for (let i = 0; i < PAY_METHODS.length; i += 2) {
            rows.push(PAY_METHODS.slice(i, i + 2).map((m, j) => btn(m, `pay:${i + j}`)));
        }
    }
    if (top.length) rows.push(top);

    const canGoBack = session.editing || idx > 0;
    rows.push([
        btn(canGoBack ? '⬅️ Zurück' : '🏠 Menü', 'back'),
        btn('❌ Abbrechen', 'cancel')
    ]);
    return keyboard(rows);
}

async function askStep(bot, chatId, session, step, notice) {
    session.step = step;
    touch(session);
    const text = (notice ? `${notice}\n\n` : '') + promptFor(session, step);
    return send(bot, chatId, text, stepKeyboard(session, step), session);
}

/** Nach einer Eingabe: nächsten Schritt bestimmen (oder Bestätigung zeigen). */
async function advance(bot, chatId, session, fromStep) {
    const flow = FLOWS[session.flow];

    if (session.flow === 'guestname') return executeGuestName(bot, chatId, session);

    if (session.editing) {
        session.editing = false;
        return showConfirm(bot, chatId, session);
    }

    if (session.sequential) {
        const idx = flow.steps.indexOf(fromStep);
        const next = flow.steps[idx + 1];
        if (next) return askStep(bot, chatId, session, next);
        session.sequential = false;
        return showConfirm(bot, chatId, session);
    }

    const next = flow.steps.find(s => !isFilled(s, session.data));
    if (next) return askStep(bot, chatId, session, next);
    return showConfirm(bot, chatId, session);
}

function estimateInvoice(data) {
    try {
        const s = db.getAllSettings();
        const p = s.pricing || { price_per_night: 85, cleaning_fee: 50, mwst_rate: 7, kleinunternehmer: false };
        const nights = botLogic.calcNights(data.arrival, data.departure);
        const sub = nights * (Number(p.price_per_night) || 0) + (Number(p.cleaning_fee) || 0);
        const vat = p.kleinunternehmer ? 0 : sub * ((Number(p.mwst_rate) || 0) / 100);
        return { nights, total: sub + vat, kleinunternehmer: !!p.kleinunternehmer };
    } catch (e) {
        return { nights: botLogic.calcNights(data.arrival, data.departure), total: null };
    }
}

function existingPinFor(data) {
    try {
        const b = db.findBookingForStay(data.gName, data.arrival, data.departure);
        return b && b.nuki_pin ? b.nuki_pin : null;
    } catch (e) {
        return null;
    }
}

async function showConfirm(bot, chatId, session) {
    session.step = 'confirm';
    session.sequential = false;
    touch(session);

    const d = session.data;
    const est = estimateInvoice(d);
    const pin = existingPinFor(d);
    const flow = FLOWS[session.flow];

    let text = `${flow.icon} <b>${flow.title} – Zusammenfassung</b>\n\n`;
    text += `👤 <b>Gast:</b> ${esc(d.gName)}\n`;
    if (session.flow === 'invoice') {
        text += `🏠 <b>Adresse:</b> ${esc(String(d.gAdresse).replace(/\n/g, ', '))}\n`;
        text += `✉️ <b>E-Mail:</b> ${d.gEmail ? esc(d.gEmail) : '—'}\n`;
    }
    text += `📅 <b>Zeitraum:</b> ${fmtDate(d.arrival)} – ${fmtDate(d.departure)} (${est.nights} ${est.nights === 1 ? 'Nacht' : 'Nächte'})\n`;
    if (session.flow === 'invoice') text += `💳 <b>Bezahlt via:</b> ${esc(d.zMethode)}\n`;
    if (session.flow === 'invoice' && est.total !== null) {
        text += `💶 <b>Betrag:</b> ${fmtMoney(est.total)}${est.kleinunternehmer ? ' (ohne MwSt.)' : ' (brutto)'}\n`;
    }
    text += '\n';
    if (pin) {
        text += `🔑 Für diesen Aufenthalt existiert bereits der Tür-Code <code>${esc(pin)}</code> – er wird weiterverwendet, es wird <b>kein</b> neuer angelegt.`;
    } else {
        text += '🔑 Beim Bestätigen wird ein <b>neuer Tür-Code</b> im Nuki-Schloss angelegt.';
    }

    const rows = [
        [btn(session.flow === 'invoice' ? '✅ Rechnung erstellen' : (pin ? '✅ Code anzeigen' : '✅ Code erstellen'), 'ok')],
        [btn('✏️ Ändern', 'edit'), btn('⬅️ Zurück', 'back')],
        [btn('❌ Abbrechen', 'cancel')]
    ];
    return send(bot, chatId, text, keyboard(rows), session);
}

async function showEditMenu(bot, chatId, session) {
    touch(session);
    const flow = FLOWS[session.flow];
    const rows = flow.steps.map(s => [btn(`${FIELD_LABELS[s]}: ${short(valueText(s, session.data), 28) || '—'}`, `ef:${s}`)]);
    rows.push([btn('⬅️ Zurück zur Zusammenfassung', 'back'), btn('❌ Abbrechen', 'cancel')]);
    return send(bot, chatId, '✏️ <b>Was möchtest du ändern?</b>', keyboard(rows), session);
}

// ---------------------------------------------------------------------------
// Eingabe-Parser pro Schritt
// ---------------------------------------------------------------------------
/** @returns {{ok:true}|{ok:false,error:string}} und schreibt bei Erfolg in session.data */
function applyInput(session, step, textRaw) {
    const text = textRaw.trim();
    const d = session.data;

    switch (step) {
        case 'name': {
            const clean = text.replace(/^\/?(rechnung|pin)(@\w+)?\b[:\s-]*/i, '').trim();
            if (clean.length < 2 || clean.length > 80 || /\d{1,2}\.\d{1,2}\./.test(clean) || /^\d+$/.test(clean) || clean.includes('\n')) {
                return { ok: false, error: '⚠️ Das sieht nicht nach einem Namen aus. Bitte Vor- und Nachname in <b>einer</b> Zeile angeben.' };
            }
            d.gName = clean;
            return { ok: true };
        }
        case 'address': {
            if (text.length < 5 || text.length > 300) {
                return { ok: false, error: '⚠️ Die Adresse wirkt zu kurz. Bitte Straße, PLZ und Ort angeben.' };
            }
            d.gAdresse = text.split('\n').map(l => l.trim()).filter(Boolean).join('\n');
            return { ok: true };
        }
        case 'email': {
            if (SKIP_WORDS.has(text.toLowerCase())) {
                d.gEmail = null;
                return { ok: true };
            }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
                return { ok: false, error: '⚠️ Ungültige E-Mail-Adresse. Bitte erneut eingeben oder auf „Überspringen“ tippen.' };
            }
            d.gEmail = text;
            return { ok: true };
        }
        case 'payment': {
            const m = PAY_METHODS.find(x => x.toLowerCase() === text.toLowerCase());
            if (!m) return { ok: false, error: '⚠️ Bitte eine Zahlungsart über die Tasten wählen (z. B. Überweisung, Bar, PayPal).' };
            d.zMethode = m;
            return { ok: true };
        }
        case 'dates': {
            const r = botLogic.parseDates(text);
            if (r.error) return { ok: false, error: `⚠️ ${esc(r.error)}` };
            if (!r.arrival || !r.departure) {
                return { ok: false, error: '⚠️ Zeitraum nicht erkannt. Bitte so eingeben: <code>15.03. - 20.03.2026</code>' };
            }
            d.arrival = r.arrival;
            d.departure = r.departure;
            return { ok: true };
        }
    }
    return { ok: false, error: '⚠️ Eingabe nicht verarbeitet.' };
}

// ---------------------------------------------------------------------------
// Navigation: Zurück / Abbrechen
// ---------------------------------------------------------------------------
async function cancelSession(bot, chatId, session, silent) {
    if (session && session.lastMsgId) {
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: session.lastMsgId }).catch(() => { });
    }
    sessions.delete(chatId);
    if (!silent) await showMenu(bot, chatId, '❌ Vorgang abgebrochen.');
}

async function goBack(bot, chatId, session) {
    if (session.busy) return;
    const flow = FLOWS[session.flow];

    // Vom Ändern-Menü oder aus einem Edit-Schritt zurück zur Zusammenfassung
    if (session.step === 'edit_menu' || session.editing) {
        session.editing = false;
        return showConfirm(bot, chatId, session);
    }

    // Von der Zusammenfassung zum letzten Schritt
    if (session.step === 'confirm') {
        session.sequential = true;
        return askStep(bot, chatId, session, flow.steps[flow.steps.length - 1]);
    }

    const idx = flow.steps.indexOf(session.step);
    if (idx <= 0) {
        // Am Anfang: zurück ins Hauptmenü
        return cancelSession(bot, chatId, session, false);
    }
    session.sequential = true;
    return askStep(bot, chatId, session, flow.steps[idx - 1]);
}

// ---------------------------------------------------------------------------
// Flows starten
// ---------------------------------------------------------------------------
async function startFlow(bot, chatId, flowName, initialText, prefill) {
    const old = sessions.get(chatId);
    if (old && old.lastMsgId) {
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: old.lastMsgId }).catch(() => { });
    }

    const parsed = initialText ? botLogic.parseInvoiceText(initialText) : {};
    const data = {
        gName: parsed.gName || '',
        gAdresse: flowName === 'invoice' ? (parsed.gAdresse || '') : '',
        arrival: parsed.arrival || '',
        departure: parsed.departure || ''
    };
    if (flowName === 'invoice' && parsed.gEmail) data.gEmail = parsed.gEmail;
    if (prefill) Object.assign(data, prefill);

    const session = { flow: flowName, step: null, data, updatedAt: Date.now(), lastMsgId: null, sequential: false, editing: false, busy: false };
    sessions.set(chatId, session);

    const notice = parsed.dateError ? `⚠️ ${esc(parsed.dateError)}` : null;
    const next = FLOWS[flowName].steps.find(s => !isFilled(s, data));
    if (next) return askStep(bot, chatId, session, next, notice);
    return showConfirm(bot, chatId, session);
}

// ---------------------------------------------------------------------------
// Ausführen (nach Bestätigung)
// ---------------------------------------------------------------------------
async function setProgress(bot, q, session, chatId, text) {
    // Bestätigungsnachricht in "Arbeitet…" umwandeln (entfernt die Buttons -> kein Doppelklick)
    const msgId = (q && q.message && q.message.message_id) || session.lastMsgId;
    if (msgId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
            session.lastMsgId = null;
            return;
        } catch (e) { /* Fallback unten */ }
    }
    await send(bot, chatId, text, null, session);
}

function errorKeyboard() {
    return keyboard([
        [btn('🔁 Erneut versuchen', 'ok')],
        [btn('✏️ Ändern', 'edit'), btn('❌ Abbrechen', 'cancel')]
    ]);
}

async function executeSession(bot, chatId, session, q) {
    if (session.busy) return;
    session.busy = true;
    touch(session);
    const data = session.data;

    try {
        if (session.flow === 'invoice') {
            await setProgress(bot, q, session, chatId, '⏳ <b>Rechnung wird erstellt …</b>\nDas dauert einige Sekunden.');
            bot.sendChatAction(chatId, 'upload_document').catch(() => { });

            const invoiceData = await botLogic.finalizeInvoiceData(data);
            db.saveInvoice(invoiceData);
            const { filePath } = await botLogic.generateInvoicePdf(invoiceData);
            try {
                await bot.sendDocument(chatId, filePath, {
                    caption: `✅ Rechnung ${invoiceData.rNummer} erstellt.\n🔑 Nuki-PIN: ${invoiceData.nukiPin || 'Fehlgeschlagen'}`,
                    reply_markup: mainMenuKeyboard()
                });
            } finally {
                try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
            }
        } else {
            await setProgress(bot, q, session, chatId, '⏳ <b>Tür-Code wird erstellt …</b>');
            bot.sendChatAction(chatId, 'typing').catch(() => { });
            const pin = await createOrReusePin(data);
            await send(bot, chatId,
                `✅ <b>Tür-Code: <code>${esc(pin)}</code></b>\n` +
                `👤 Gast: ${esc(data.gName)}\n` +
                `📅 ${fmtDate(data.arrival)} – ${fmtDate(data.departure)}`,
                mainMenuKeyboard());
        }
        sessions.delete(chatId);
    } catch (e) {
        console.error('[TG] Ausführung fehlgeschlagen:', e);
        session.busy = false;
        session.step = 'confirm';
        touch(session);
        await send(bot, chatId,
            `❌ <b>Fehler:</b> ${esc(e.message)}\n\nDeine Eingaben sind noch gespeichert.`,
            errorKeyboard(), session);
    }
}

async function createOrReusePin(data) {
    const existing = existingPinFor(data);
    if (existing) return existing;

    const nukiResult = await botLogic.createNukiPinDirect(data.arrival, data.departure, data.gName);
    const pin = nukiResult.pin;
    const authId = nukiResult.authId;

    const guest = db.findOrCreateGuest(data.gName, null, null);
    const existingBooking = db.findBookingForStay(data.gName, data.arrival, data.departure);
    if (existingBooking) {
        db.updateBookingNukiData(existingBooking.id, pin, authId);
        if (!existingBooking.guest_id) {
            db.getDb().prepare('UPDATE bookings SET guest_id = ? WHERE id = ?').run(guest.id, existingBooking.id);
        }
    } else {
        // Keine iCal-Buchung vorhanden: manuelle Buchung anlegen, damit der PIN im Gast sichtbar ist
        db.createManualBooking(guest.id, data.gName, data.arrival, data.departure, pin, authId);
    }
    return pin;
}

// ---------------------------------------------------------------------------
// Befehlserkennung
// ---------------------------------------------------------------------------
const COMMAND_RE = /^\/?(rechnung|pin|sync|namen|codes|türcodes|tuercodes|status|offen|anreisen|hilfe|help|start|menü|menu|register|abbrechen|zurück|zurueck)(?:@\w+)?(?=$|[\s:,.-])[:\s,.-]*/i;

/** Erkennt NUR Wörter am Textanfang (kein includes() mehr -> "Pinar Müller" löst keinen PIN-Befehl aus). */
function detectCommand(body) {
    const m = body.match(COMMAND_RE);
    if (!m) return null;
    return { cmd: m[1].toLowerCase(), rest: body.slice(m[0].length).trim() };
}

// ---------------------------------------------------------------------------
// Einstieg: Textnachrichten
// ---------------------------------------------------------------------------
async function processMessage(bot, msg) {
    const chatId = msg.chat.id;
    const body = msg.text ? msg.text.trim() : '';
    if (!body) return;

    console.log(`[TG] Nachricht von [${chatId}]: "${body.length > 80 ? body.slice(0, 80) + '…' : body}"`);

    // --- Autorisierung ---
    if (!db.isTelegramIdAuthorized(chatId)) {
        const lower = body.toLowerCase();
        if (lower === '/register' || lower === '/start') {
            const firstName = (msg.from && msg.from.first_name) || '';
            const username = (msg.from && msg.from.username) || '';
            db.addPendingTelegramRequest(chatId, firstName, username);
            return send(bot, chatId, `🔒 <b>Zugriff angefragt</b>\n\nDeine ID <code>${esc(chatId)}</code> wurde an den Administrator gesendet.\nBitte warte auf Freischaltung.`);
        }
        console.warn(`[TG] Zugriff verweigert für ID: ${chatId}.`);
        return send(bot, chatId, '⛔ <b>Zugriff verweigert</b>\n\nBitte sende <code>/register</code>, um eine Zugangsanfrage zu stellen.');
    }

    const lower = body.toLowerCase();
    const session = getActiveSession(chatId);

    if (session === 'expired') {
        // Abgelaufene Eingabe: nicht als Antwort interpretieren
        if (BACK_WORDS.has(lower) || CANCEL_WORDS.has(lower) || MENU_WORDS.has(lower)) {
            return showMenu(bot, chatId, '⏱ Die letzte Eingabe war abgelaufen.');
        }
        await send(bot, chatId, '⏱ Die letzte Eingabe ist nach 10 Minuten Inaktivität abgelaufen. Ich starte neu.');
        // weiter wie ohne Session
    }

    const active = session && session !== 'expired' ? session : null;

    // --- Globale Navigation (in jedem Schritt) ---
    if (active) {
        if (CANCEL_WORDS.has(lower)) return cancelSession(bot, chatId, active, false);
        if (BACK_WORDS.has(lower)) return goBack(bot, chatId, active);
        if (MENU_WORDS.has(lower)) return cancelSession(bot, chatId, active, false);
    } else if (BACK_WORDS.has(lower) || CANCEL_WORDS.has(lower) || MENU_WORDS.has(lower)) {
        return showMenu(bot, chatId);
    }

    let cmd = detectCommand(body);
    // Im laufenden Dialog gelten nur echte Slash-Befehle als Befehle - sonst könnte eine Antwort
    // wie "Status Quo" als Name versehentlich einen Befehl auslösen.
    if (cmd && active && !body.startsWith('/')) cmd = null;

    // --- Befehle ---
    if (cmd) {
        switch (cmd.cmd) {
            case 'abbrechen':
                return active ? cancelSession(bot, chatId, active, false) : showMenu(bot, chatId);
            case 'zurück':
            case 'zurueck':
                return active ? goBack(bot, chatId, active) : showMenu(bot, chatId);
            case 'register':
                return send(bot, chatId, '✅ <b>Du bist bereits registriert.</b>\nDein Zugriff ist aktiv.');
            case 'start':
            case 'menü':
            case 'menu':
                if (active) await cancelSession(bot, chatId, active, true);
                return showMenu(bot, chatId);
            case 'hilfe':
            case 'help':
                return showHelp(bot, chatId);
            case 'status':
            case 'offen':
                return showOpenInvoices(bot, chatId);
            case 'sync':
                return runSync(bot, chatId);
            case 'namen':
                return showNamesOpen(bot, chatId);
            case 'codes':
            case 'türcodes':
            case 'tuercodes':
                return showCodes(bot, chatId);
            case 'anreisen':
                return showArrivals(bot, chatId);
            case 'rechnung':
                return startFlow(bot, chatId, 'invoice', cmd.rest);
            case 'pin':
                return startFlow(bot, chatId, 'pin', cmd.rest);
            default:
                break;
        }
    }

    // --- Antwort in laufendem Dialog ---
    if (active && !active.busy) {
        return handleStepInput(bot, chatId, active, body);
    }
    if (active && active.busy) {
        return send(bot, chatId, '⏳ Einen Moment bitte – ich bin noch am Arbeiten.');
    }

    // --- Freitext ohne Befehl: Buchungstext erkennen (mehrzeilig oder mit Datum) ---
    if (body.split('\n').length >= 2 || /\d{1,2}\.\d{1,2}\./.test(body)) {
        return startFlow(bot, chatId, 'invoice', body);
    }

    return showMenu(bot, chatId, '🤔 Das habe ich nicht verstanden.');
}

async function handleStepInput(bot, chatId, session, body) {
    touch(session);

    if (session.step === 'confirm') {
        // Freitext in der Zusammenfassung: Zusammenfassung erneut zeigen
        return showConfirm(bot, chatId, session);
    }
    if (session.step === 'edit_menu') {
        return showEditMenu(bot, chatId, session);
    }

    const step = session.step;

    // Mehrzeilige Eingabe im Namensschritt: komplette Buchungsdaten übernehmen (Slot-Filling)
    if (step === 'name' && body.includes('\n')) {
        const p = botLogic.parseInvoiceText(body);
        if (p.gName) {
            session.data.gName = p.gName;
            if (session.flow === 'invoice') {
                if (p.gAdresse) session.data.gAdresse = p.gAdresse;
                if (p.gEmail) session.data.gEmail = p.gEmail;
            }
            if (p.arrival && p.departure) {
                session.data.arrival = p.arrival;
                session.data.departure = p.departure;
            }
            return advance(bot, chatId, session, step);
        }
    }

    const result = applyInput(session, step, body);
    if (!result.ok) {
        return send(bot, chatId, result.error, stepKeyboard(session, step), session);
    }
    return advance(bot, chatId, session, step);
}

// ---------------------------------------------------------------------------
// Einstieg: Button-Klicks (callback_query)
// ---------------------------------------------------------------------------
async function processCallback(bot, q) {
    const chatId = q.message && q.message.chat ? q.message.chat.id : (q.from && q.from.id);
    const data = q.data || '';
    const answer = (text) => bot.answerCallbackQuery(q.id, text ? { text } : {}).catch(() => { });

    if (!chatId) return answer();

    if (!db.isTelegramIdAuthorized(chatId)) {
        return answer('⛔ Kein Zugriff');
    }

    const session = getActiveSession(chatId);
    const active = session && session !== 'expired' ? session : null;

    // Alte Buttons, die nicht mehr zu einer Session passen
    const needsSession = ['keep', 'skip', 'back', 'cancel', 'ok', 'edit'].includes(data) || data.startsWith('ef:');
    if (needsSession && !active) {
        await answer(session === 'expired' ? '⏱ Abgelaufen' : 'Vorgang nicht mehr aktiv');
        // Buttons der alten Nachricht entfernen
        if (q.message) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => { });
        return showMenu(bot, chatId, session === 'expired' ? '⏱ Die Eingabe war abgelaufen.' : null);
    }

    if (active && active.busy) {
        return answer('⏳ Bitte warten …');
    }

    // Klick auf eine veraltete Nachricht (nicht die aktuelle Session-Nachricht)?
    if (active && needsSession && q.message && active.lastMsgId && q.message.message_id !== active.lastMsgId) {
        await answer('Diese Auswahl ist veraltet.');
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => { });
        return;
    }

    await answer();

    try {
        switch (true) {
            case data === 'menu':
                if (active) await cancelSession(bot, chatId, active, true);
                if (q.message) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => { });
                return showMenu(bot, chatId);
            case data === 'help':
                return showHelp(bot, chatId);
            case data === 'open':
                return showOpenInvoices(bot, chatId);
            case data === 'arrivals':
                return showArrivals(bot, chatId);
            case data === 'codes':
                return showCodes(bot, chatId);
            case data === 'sync':
                return runSync(bot, chatId);
            case data === 'names':
                return showNamesOpen(bot, chatId);
            case data.startsWith('nm:'):
                return startNameFlow(bot, chatId, parseInt(data.slice(3), 10));
            case data.startsWith('inv:'):
                return startInvoiceFromBooking(bot, chatId, parseInt(data.slice(4), 10));
            case data === 'new:invoice':
                return startFlow(bot, chatId, 'invoice', '');
            case data === 'new:pin':
                return startFlow(bot, chatId, 'pin', '');

            case data === 'cancel':
                return cancelSession(bot, chatId, active, false);
            case data === 'back':
                return goBack(bot, chatId, active);

            case data === 'keep': {
                if (!isFilled(active.step, active.data)) return;
                touch(active);
                return advance(bot, chatId, active, active.step);
            }
            case data === 'skip': {
                if (active.step !== 'email') return;
                active.data.gEmail = null;
                return advance(bot, chatId, active, 'email');
            }
            case data.startsWith('pay:'): {
                if (active.step !== 'payment') return;
                const m = PAY_METHODS[parseInt(data.slice(4), 10)];
                if (!m) return;
                active.data.zMethode = m;
                return advance(bot, chatId, active, 'payment');
            }
            case data === 'edit': {
                active.step = 'edit_menu';
                return showEditMenu(bot, chatId, active);
            }
            case data.startsWith('ef:'): {
                const field = data.slice(3);
                if (!FLOWS[active.flow].steps.includes(field)) return;
                active.editing = true;
                active.sequential = false;
                return askStep(bot, chatId, active, field);
            }
            case data === 'ok': {
                if (active.step !== 'confirm') return;
                return executeSession(bot, chatId, active, q);
            }
            default:
                return;
        }
    } catch (e) {
        console.error('[TG] Fehler im Callback:', e);
        bot.sendMessage(chatId, '❌ Fehler: ' + e.message).catch(() => { });
    }
}

// ---------------------------------------------------------------------------
// Setup (von server.js aufgerufen)
// ---------------------------------------------------------------------------
async function setup(bot, options = {}) {
    hooks = options;
    bot.on('callback_query', (q) => {
        processCallback(bot, q).catch(e => console.error('❌ Fehler in tgCommands.processCallback:', e));
    });

    try {
        await bot.setMyCommands([
            { command: 'menu', description: 'Hauptmenü öffnen' },
            { command: 'rechnung', description: 'Neue Rechnung erstellen' },
            { command: 'pin', description: 'Nur Tür-Code erstellen' },
            { command: 'namen', description: 'Gastnamen nachtragen' },
            { command: 'sync', description: 'Kalender jetzt abfragen' },
            { command: 'codes', description: 'Angelegte Türcodes anzeigen' },
            { command: 'status', description: 'Offene Rechnungen anzeigen' },
            { command: 'anreisen', description: 'Kommende Buchungen anzeigen' },
            { command: 'abbrechen', description: 'Aktuellen Vorgang abbrechen' },
            { command: 'hilfe', description: 'Hilfe anzeigen' }
        ]);
    } catch (e) {
        console.warn('[TG] setMyCommands fehlgeschlagen:', e.message);
    }
}

module.exports = {
    processMessage,
    processCallback,
    setup,
    // für Tests
    _internal: { sessions, detectCommand, applyInput, FLOWS }
};
