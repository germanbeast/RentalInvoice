const db = require('./db');
const botLogic = require('./bot-logic');
const permissions = require('./permissions');
const LANG_LABEL = { de: '🇩🇪 Deutsch', en: '🇬🇧 Englisch', nl: '🇳🇱 Niederländisch', pl: '🇵🇱 Polnisch' };
const addressParser = require('./address-parser');
const addressCheck = require('./address-check');
const ocr = require('./screenshot-ocr');
const geoCheck = require('./geo-check');
const os = require('os');
const path = require('path');

/** Rights of a Telegram chat: a linked user account gets its own rights; an ID that was only approved
 *  under Einstellungen → Telegram (no user linked) keeps full access as before. */
function botPerms(chatId) {
    const user = db.getUserByTelegramId(chatId);
    return user ? permissions.forUser(user) : permissions.ROLES.admin.permissions;
}
const DENIED = '⛔ <b>Keine Berechtigung</b>\nDein Benutzer darf das nicht. Rechte vergibt der Inhaber in der Benutzerverwaltung.';
const CMD_RIGHT = { status: 'offen', offen: 'offen', sync: 'sync', namen: 'namen', codes: 'codes', 'türcodes': 'codes', tuercodes: 'codes',
    anreisen: 'anreisen', nachricht: 'nachricht', rechnung: 'rechnung', pin: 'pin', adresse: 'adresse', anschrift: 'adresse' };
function callbackRight(data) {
    if (data === 'open') return 'offen';
    if (data === 'arrivals') return 'anreisen';
    if (data === 'codes') return 'codes';
    if (data === 'sync' || data.startsWith('ovl:')) return 'sync';
    if (data === 'names' || data.startsWith('nm:')) return 'namen';
    if (data === 'adr' || data.startsWith('adr:') || data.startsWith('ab:') || ['aok', 'aname', 'aback'].includes(data) || data.startsWith('ageo:')) return 'adresse';
    if (data === 'lock:status') return 'lockstatus';
    if (data.startsWith('lock:')) return 'lock';
    if (data === 'gm' || data.startsWith('gm:')) return 'nachricht';
    if (data.startsWith('gl:')) return 'guestlink';
    if (data === 'wl' || data.startsWith('wl:')) return 'wlan';
    if (data.startsWith('inv:') || data === 'new:invoice') return 'rechnung';
    if (data === 'new:pin') return 'pin';
    return null;
}
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
        [btn('✉️ Gästenachricht', 'gm'), btn('📋 Offene Rechnungen', 'open')],
        [btn('🔄 Kalender abfragen', 'sync'), btn('🚪 Schloss', 'lock:status')],
        [btn('📇 Anschrift einfügen', 'adr'), btn('📶 WLAN-Codes', 'wl')],
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
        '• <code>/adresse</code> – Anschrift eines Gastes einfügen (Format egal)\n' +
        '• <code>/sync</code> – Booking.com &amp; Airbnb jetzt abfragen\n' +
        '• <code>/anreisen</code> – kommende Buchungen\n' +
        '• <code>/nachricht</code> – fertige Nachricht für den Gast (zum Kopieren)\n' +
        '• <code>/schloss</code> – Schloss-Status und Batterie\n' +
        '• <code>/zu</code> – Tür abschließen\n' +
        '• <code>/jahr</code> – Jahresrückblick (z. B. <code>/jahr 2025</code>)\n' +
        '• <code>/wlan</code> – WLAN-Codes für Besucher (z. B. <code>/wlan 3</code> = 3 Tage, <code>/wlan 4h Handwerker</code>)\n' +
        '• <code>/auf</code> – Tür aufschließen/öffnen (mit Rückfrage)\n' +
        '• <code>/menu</code> – Hauptmenü\n\n' +
        '<b>Schnell starten</b>\n' +
        'Du kannst gleich alles in eine Nachricht schreiben, z.B.\n' +
        '<code>Rechnung Max Mustermann\nMusterstr. 1\n12345 Musterstadt\n15.03. - 20.03.2026</code>\n' +
        'Der Bot übernimmt, was er erkennt, und fragt nur nach dem Rest.\n\n' +
        '<b>Anschrift einfach reinkopieren</b>\n' +
        'Eine Anschrift ohne Datum (z. B. aus Booking.com kopiert) erkennt der Bot von selbst: Name, Straße, PLZ, Ort, Land, Telefon, E-Mail. ' +
        'Du wählst nur noch die Buchung und bestätigst. Das klappt auch mit einem 📷 Screenshot, der nach dem Speichern aus dem Chat gelöscht wird.\n\n' +
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
        const rows = [[btn('🧾 Rechnung erstellen', `inv:${session.bookingId}`), btn('📇 Anschrift', `adr:${session.bookingId}`)]];
        if (left > 0) rows.push([btn(`👤 Weitere Namen offen (${left})`, 'names')]);
        rows.push([btn('🔐 Türcodes', 'codes'), btn('🏠 Hauptmenü', 'menu')]);
        await send(bot, chatId, text, keyboard(rows));
        // The guest message now greets the guest by name
        if (r.booking.checkout >= new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date())) await showGuestMessage(bot, chatId, session.bookingId);
        return;
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
    // Everything from THIS booking's guest (Meldeschein as fallback for the address); the invoice stays tied to it
    const g = addressCheck.bookingGuest(b.id) || {};
    const prefill = { gName: b.guest_name, arrival: b.checkin, departure: b.checkout, bookingId: b.id, gAdresse: '' };
    if (g.address) { const clean = tidyAddress(g.address); if (clean) prefill.gAdresse = clean; }
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

// ---------------------------------------------------------------------------
// Schloss: Status, /zu, /auf (mit Rückfrage)
// ---------------------------------------------------------------------------
const LOCK_CMD_RE = /^\/(auf|zu|schloss|tür|tuer)(?:@\w+)?$/i;

function lockKeyboard() {
    return keyboard([
        [btn('🔒 Abschließen', 'lock:zu'), btn('🔓 Aufschließen …', 'lock:auf')],
        [btn('🔄 Aktualisieren', 'lock:status'), btn('🏠 Hauptmenü', 'menu')]
    ]);
}

async function showLockStatus(bot, chatId, intro) {
    bot.sendChatAction(chatId, 'typing').catch(() => { });
    let lock;
    try {
        lock = await botLogic.getNukiLock();
    } catch (e) {
        return send(bot, chatId, `❌ <b>Schloss-Status nicht verfügbar</b>\n${esc(e.message)}`, menuOnlyKeyboard());
    }
    const icon = lock.locked ? '🔒' : lock.unlocked ? '🔓' : '🚪';
    let battery = lock.battery !== null ? `${lock.battery} %` : (lock.batteryCritical ? 'fast leer' : 'ok');
    if (lock.batteryCritical) battery = `🪫 ${battery} – bitte tauschen`;
    if (lock.batteryCharging) battery += ' (lädt)';
    let text = (intro ? `${intro}\n\n` : '') +
        (lock.offline ? '📡 <b>Schloss ist offline</b> – angezeigt wird der letzte bekannte Stand\n' : '') +
        `<b>${icon} Schloss: ${esc(lock.lockText)}</b>\n` +
        (lock.doorText ? `🚪 ${esc(lock.doorText)}\n` : '') +
        `Batterie: ${esc(battery)}\n`;
    if (lock.keypadBatteryCritical) text += '🪫 Keypad-Batterie fast leer\n';
    if (lock.doorsensorBatteryCritical) text += '🪫 Türsensor-Batterie fast leer\n';
    text += `Gast im Haus: ${hooks.isOccupied && hooks.isOccupied() ? 'ja' : 'nein'}`;
    return send(bot, chatId, text, lockKeyboard());
}

// ---------------------------------------------------------------------------
// WLAN-Codes (eigener Router mit Anmeldeseite): zusätzliche Codes für Besucher, Handwerker usw.
// ---------------------------------------------------------------------------
function wifiPortal() {
    const w = hooks.wifi ? hooks.wifi() : null;
    if (!w) return { error: 'WLAN ist gerade nicht verfügbar.' };
    if (w.getConfig().mode !== 'portal') return { error: 'WLAN-Codes gibt es nur mit dem eigenen WLAN-Router mit Anmeldeseite (Admin → Webseite → WLAN).' };
    return { w, portal: w.portal };
}

function fmtUntil(iso) {
    return new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' Uhr';
}

/** "/wlan 3", "/wlan 4h Handwerker", "2 tage" -> { hours, note } or null */
function parseWifiArg(arg) {
    const m = String(arg || '').trim().match(/^(\d{1,3})\s*(h|std\.?|stunden?|t|d|tage?|w|wochen?)?\b\s*(.*)$/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const u = (m[2] || 't').toLowerCase();
    const hours = /^(h|std|stunde)/.test(u) ? n : /^w/.test(u) ? n * 7 * 24 : n * 24;
    if (!n || hours > 60 * 24) return null;
    return { hours, note: m[3].trim() };
}

async function showWifiCodes(bot, chatId, intro) {
    const { w, portal, error } = wifiPortal();
    if (error) return send(bot, chatId, `📶 ${esc(error)}`, menuOnlyKeyboard());
    let text = (intro ? `${intro}\n\n` : '') + `<b>📶 WLAN-Codes</b> · WLAN „${esc(w.getConfig().portal.ssid)}“\n`;
    try {
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
        const b = db.getDb().prepare('SELECT b.*, g.name AS guest_name FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id WHERE b.checkin <= ? AND b.checkout >= ? ORDER BY (b.checkout = ?) ASC, b.checkin ASC LIMIT 1').get(today, today, today);
        if (b) text += `\nGast jetzt: ${esc(b.guest_name || 'Gast')} – Code <code>${esc(w.ensureCode(b.id))}</code> (bis ${fmtDate(b.checkout)})\n`;
    } catch (e) { /* ohne Gast */ }
    const codes = portal.listExtraCodes();
    text += codes.length ? '\n<b>Zusätzliche Codes</b>\n' + codes.map(c => `• <code>${esc(c.code)}</code>${c.note ? ` ${esc(c.note)}` : ''} – bis ${esc(fmtUntil(c.valid_until))}${c.devices ? ` · ${c.devices} Gerät${c.devices === 1 ? '' : 'e'}` : ''}`).join('\n') + '\n'
        : '\nKeine zusätzlichen Codes aktiv.\n';
    text += '\nNeuen Code erzeugen (gilt ab sofort). Mit Notiz: z. B. <code>/wlan 4h Handwerker</code>';
    const rows = [
        [btn('4 Stunden', 'wl:new:4'), btn('1 Tag', 'wl:new:24')],
        [btn('3 Tage', 'wl:new:72'), btn('1 Woche', 'wl:new:168')]
    ];
    for (const c of codes.slice(0, 8)) rows.push([btn(`🗑 ${c.code} löschen${c.note ? ` (${short(c.note, 16)})` : ''}`, `wl:del:${c.id}`)]);
    rows.push([btn('🏠 Hauptmenü', 'menu')]);
    return send(bot, chatId, text, keyboard(rows));
}

async function createWifiCode(bot, chatId, hours, note, who) {
    const { w, portal, error } = wifiPortal();
    if (error) return send(bot, chatId, `📶 ${esc(error)}`, menuOnlyKeyboard());
    let x;
    try { x = portal.createExtraCode({ hours, note, by: who }); } catch (e) { return send(bot, chatId, `❌ ${esc(e.message)}`, menuOnlyKeyboard()); }
    const c = w.getConfig().portal;
    const text = `✅ <b>Neuer WLAN-Code</b>${x.note ? ` (${esc(x.note)})` : ''}\n\n` +
        `WLAN: <b>${esc(c.ssid)}</b>${c.wpa ? `\nKennwort: <code>${esc(c.wpa)}</code>` : ''}\n` +
        `Code: <code>${esc(x.code)}</code>\n` +
        `Gültig bis ${esc(fmtUntil(x.valid_until))}, für bis zu ${c.max_devices} Geräte.\n\n` +
        '<i>Mit dem WLAN verbinden, auf der Anmeldeseite den Code eingeben.</i>';
    return send(bot, chatId, text, keyboard([[btn('📶 Alle WLAN-Codes', 'wl')], [btn('🏠 Hauptmenü', 'menu')]]));
}

async function showYearReview(bot, chatId, year) {
    if (!hooks.yearText) return send(bot, chatId, 'Jahresrückblick ist gerade nicht verfügbar.', menuOnlyKeyboard());
    const now = new Date();
    const y = year || (now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear());
    try {
        return send(bot, chatId, hooks.yearText(y), menuOnlyKeyboard());
    } catch (e) {
        return send(bot, chatId, `❌ Jahresrückblick nicht möglich: ${esc(e.message)}`, menuOnlyKeyboard());
    }
}

async function confirmUnlock(bot, chatId) {
    return send(bot, chatId,
        '⚠️ <b>Tür wirklich aus der Ferne öffnen?</b>\n\n' +
        '🔓 <b>Aufschließen</b>: Schloss geht auf, die Tür bleibt zu, bis jemand sie aufdrückt.\n' +
        '🚪 <b>Öffnen</b>: aufschließen und Falle ziehen – die Tür springt auf.',
        keyboard([
            [btn('🔓 Aufschließen', 'lock:auf!'), btn('🚪 Öffnen', 'lock:open!')],
            [btn('❌ Abbrechen', 'lock:status')]
        ]));
}

async function runLockAction(bot, chatId, action, who) {
    const labels = { lock: 'abschließen', unlock: 'aufschließen', unlatch: 'öffnen' };
    bot.sendChatAction(chatId, 'typing').catch(() => { });
    try {
        await botLogic.nukiLockAction(action);
    } catch (e) {
        return send(bot, chatId, `❌ <b>Konnte nicht ${labels[action]}</b>\n${esc(e.message)}`, lockKeyboard());
    }
    console.log(`🔐 Schloss ${labels[action]} per Telegram (${who || chatId})`);
    try { db.logNotification('nuki_remote', `Schloss ${labels[action]} per Telegram (${who || chatId})`, 'sent'); } catch (e) { /* log only */ }
    // The lock needs a few seconds to execute the command and report back to Nuki Web
    await new Promise(r => setTimeout(r, 8000));
    return showLockStatus(bot, chatId, `✅ Befehl „${labels[action]}“ an das Schloss gesendet.`);
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
// Gästenachricht: fertiger Text zum Kopieren in Booking.com / Airbnb
// ---------------------------------------------------------------------------
function guestMessageApi() {
    return hooks.guestMessage ? hooks.guestMessage() : null;
}

async function showGuestMessageList(bot, chatId) {
    const api = guestMessageApi();
    if (!api) return send(bot, chatId, '❌ Die Gästenachricht ist nicht verfügbar.', menuOnlyKeyboard());
    let rows;
    try { rows = api.upcoming(8); } catch (e) {
        console.error('[TG] Gästenachricht-Liste:', e.message);
        return send(bot, chatId, '❌ Buchungen konnten nicht geladen werden.', menuOnlyKeyboard());
    }
    if (!rows.length) return send(bot, chatId, '📅 Keine aktuellen oder kommenden Buchungen.', menuOnlyKeyboard());
    const kb = rows.map(r => {
        const real = r.guest_name || guessNameFromSummary(r.summary);
        const name = botLogic.isPlaceholderGuestName(real) ? 'Name fehlt' : short(real, 22);
        return [btn(`✉️ ${fmtDate(r.checkin).slice(0, 6)}–${fmtDate(r.checkout).slice(0, 6)} · ${name}`, `gm:${r.id}`)];
    });
    kb.push([btn('🏠 Hauptmenü', 'menu')]);
    return send(bot, chatId, '<b>✉️ Gästenachricht</b>\nFür welche Buchung?', keyboard(kb));
}

async function showGuestMessage(bot, chatId, bookingId, langWanted) {
    const api = guestMessageApi();
    if (!api) return send(bot, chatId, '❌ Die Gästenachricht ist nicht verfügbar.', menuOnlyKeyboard());
    const m = api.compose(bookingId, langWanted);
    if (!m) return send(bot, chatId, '⚠️ Diese Buchung existiert nicht mehr.', menuOnlyKeyboard());
    const lang = m.lang || 'de';

    const b = m.booking;
    const who = m.name ? esc(short(m.name, 30)) : 'Gast';
    let text = `✉️ <b>Gästenachricht${lang !== 'de' ? ` (${LANG_LABEL[lang]})` : ''}: ${who}</b> · ${fmtDate(b.checkin).slice(0, 6)}–${fmtDate(b.checkout).slice(0, 6)}\n` +
        'Tippe auf den Text, um ihn zu kopieren, und füge ihn bei Booking.com oder Airbnb ein.\n';
    if (m.link) text += `<i>Der Link gilt bis ${fmtDate(m.linkUntil)}.</i>\n`;
    m.warnings.forEach(w => { text += `⚠️ ${esc(w)}\n`; });
    text += `\n<pre>${esc(m.text)}</pre>`;

    const rows = [];
    const first = [];
    if (m.link) first.push({ text: '📋 Nur Link kopieren', copy_text: { text: m.link } });
    first.push(lang !== 'de' ? btn('🇩🇪 Deutsch', `gm:de:${b.id}`) : btn('🇬🇧 English', `gm:en:${b.id}`));
    rows.push(first);
    if (m.link) rows.push([btn('🔁 Neuer Link', `gl:new?:${b.id}`), btn('🔒 Link sperren', `gl:off:${b.id}`)]);
    if (!m.name) rows.push([btn('👤 Namen eintragen', `nm:${b.id}`)]);
    rows.push([btn('🏠 Hauptmenü', 'menu')]);
    return send(bot, chatId, text, keyboard(rows));
}

async function confirmNewGuestLink(bot, chatId, bookingId) {
    return send(bot, chatId,
        '🔁 <b>Neuen Link erstellen?</b>\n\nDer bisherige Link funktioniert dann nicht mehr. ' +
        'Schick dem Gast danach die neue Nachricht.',
        keyboard([[btn('🔁 Ja, neuer Link', `gl:new!:${bookingId}`), btn('❌ Abbrechen', `gm:${bookingId}`)]]));
}

async function renewGuestLink(bot, chatId, bookingId) {
    const api = guestMessageApi();
    if (!api || !api.ensureLink(bookingId, true)) return send(bot, chatId, '⚠️ Diese Buchung existiert nicht mehr.', menuOnlyKeyboard());
    console.log(`🔁 Gäste-Link für Buchung ${bookingId} erneuert (Telegram ${chatId})`);
    await send(bot, chatId, '✅ Neuer Link erstellt. Der alte Link funktioniert nicht mehr.');
    return showGuestMessage(bot, chatId, bookingId);
}

async function blockGuestLink(bot, chatId, bookingId) {
    const api = guestMessageApi();
    if (!api || !api.revokeLink(bookingId)) return send(bot, chatId, '⚠️ Diese Buchung existiert nicht mehr.', menuOnlyKeyboard());
    console.log(`🔒 Gäste-Link für Buchung ${bookingId} gesperrt (Telegram ${chatId})`);
    return send(bot, chatId,
        '🔒 <b>Link gesperrt.</b>\nDer Gast kommt damit nicht mehr in „Meine Buchung“ und nicht mehr zum Notfall-Öffnen. ' +
        'Anmelden mit Buchungscode und Anreisedatum geht weiterhin.',
        keyboard([[btn('🔁 Neuen Link erstellen', `gm:${bookingId}`), btn('🏠 Hauptmenü', 'menu')]]));
}

// ---------------------------------------------------------------------------
// Anschrift einfügen: unformatierten Text erkennen und beim Gast einer Buchung speichern
// ---------------------------------------------------------------------------
const ADDRESS_PAGE = 6;

function berlinToday() {
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
}

function addDays(ymd, n) {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/** Lower-case words of a name without accents, for comparing "Müller" with "MUELLER" or "Muller". */
function nameWords(name) {
    return String(name || '').toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .split(/[^a-z]+/).filter(w => w.length >= 2 && !['von', 'van', 'der', 'den', 'de', 'zu', 'familie', 'family', 'herr', 'frau'].includes(w));
}

/** 2 = same name, 1 = same last name (or one word in common), 0 = no match */
function nameScore(a, b) {
    const x = nameWords(a), y = nameWords(b);
    if (!x.length || !y.length) return 0;
    if (x.join(' ') === y.join(' ')) return 2;
    if (x[x.length - 1] === y[y.length - 1]) return 1;
    return x.some(w => w.length >= 4 && y.includes(w)) ? 1 : 0;
}

/**
 * Bookings to choose from: the last 60 days up to everything ahead. Order: name matches,
 * then the current stay, then the next arrivals, then the most recent past stays.
 */
function addressCandidates(parsedName) {
    const today = berlinToday();
    const rows = db.getDb().prepare(`
        SELECT b.id, b.summary, b.checkin, b.checkout, b.guest_id, g.name AS guest_name, g.address AS guest_address
        FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
        WHERE b.checkout >= ?
        ORDER BY b.checkin ASC
    `).all(addDays(today, -60));
    const rank = r => {
        const real = r.guest_name && !botLogic.isPlaceholderGuestName(r.guest_name) ? r.guest_name : '';
        const score = parsedName && real ? nameScore(parsedName, real) : 0;
        const current = r.checkin <= today && r.checkout >= today;
        const upcoming = r.checkin > today;
        return { r, score, group: score ? 0 : current ? 1 : upcoming ? 2 : 3 };
    };
    return rows.map(rank).sort((a, b) => {
        if (a.group !== b.group) return a.group - b.group;
        if (a.score !== b.score) return b.score - a.score;
        if (a.group === 3) return b.r.checkout.localeCompare(a.r.checkout); // past: newest first
        return a.r.checkin.localeCompare(b.r.checkin);
    }).map(x => ({ ...x.r, match: x.score }));
}

function bookingLabel(b) {
    const name = b.guest_name && !botLogic.isPlaceholderGuestName(b.guest_name) ? b.guest_name : '❓ ohne Namen';
    return `${fmtDate(b.checkin).slice(0, 6)}–${fmtDate(b.checkout).slice(0, 6)} · ${name}`;
}

function addressFieldsText(p) {
    const line = (icon, label, value) => value ? `${icon} <b>${label}:</b> ${esc(value)}\n` : '';
    let t = '';
    t += line('👤', 'Name', p.name);
    t += line('🏢', 'Firma', p.company);
    t += line('🏠', 'Straße', p.street);
    t += line('🔢', 'Hausnummer', p.houseNumber);
    t += line('➕', 'Zusatz', p.extra);
    t += line('📮', 'PLZ', p.zip);
    t += line('🏙', 'Ort', p.city);
    if (p.state) t += line('🗺', 'Bundesstaat', p.state);
    t += line('🌍', 'Land', p.country);
    t += line('📞', 'Telefon', p.phone);
    t += line('✉️', 'E-Mail', p.email);
    if (p.unknown && p.unknown.length) t += `❔ <b>Nicht zugeordnet:</b> ${esc(p.unknown.join(' · '))}\n`;
    return t || '—\n';
}

/** True when a message without command should go to "Anschrift einfügen" instead of the invoice dialog. */
function isAddressText(body) {
    if (/^\/?(rechnung|pin)\b/i.test(body)) return false;
    const dates = botLogic.parseDates(body.replace(/\n/g, ' '));
    if (dates.matched) return false;
    if (addressParser.looksLikeAddress(body)) return true;
    // Contact data only (Booking.com shows no street): name + phone or e-mail in several lines
    const p = addressParser.parseAddress(body);
    return body.includes('\n') && Boolean(p.name && (p.phone || p.email) && !p.unknown.length);
}

async function startAddressFlow(bot, chatId, bookingId, silent) {
    const old = sessions.get(chatId);
    if (old && old.lastMsgId) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: old.lastMsgId }).catch(() => { });
    const session = { flow: 'address', step: 'await', bookingId: bookingId || null, fixedBooking: !!bookingId, parsed: null, raw: '', page: 0, replaceName: false, data: {}, updatedAt: Date.now(), lastMsgId: null, busy: false };
    sessions.set(chatId, session);
    if (silent) return session;
    let intro = '';
    if (bookingId) {
        const b = getBookingRow(bookingId);
        if (!b) { sessions.delete(chatId); return send(bot, chatId, '⚠️ Diese Buchung existiert nicht mehr.', menuOnlyKeyboard()); }
        intro = `Buchung: <b>${fmtDate(b.checkin)} – ${fmtDate(b.checkout)}</b>${b.guest_name && !botLogic.isPlaceholderGuestName(b.guest_name) ? ` · ${esc(b.guest_name)}` : ''}\n\n`;
    }
    return send(bot, chatId,
        '📇 <b>Anschrift einfügen</b>\n\n' + intro +
        'Schick mir die Anschrift einfach so, wie du sie hast, z. B. aus Booking.com kopiert. Format egal, eine oder mehrere Zeilen:\n' +
        '<code>Max Mustermann\nMusterstr. 12a\n12345 Musterstadt\n+49 170 1234567\nmax@example.de</code>\n\n' +
        'Oder schick einfach einen 📷 <b>Screenshot</b> (z. B. aus der Booking.com-App). Er wird nach dem Speichern wieder gelöscht.\n\n' +
        'Ich erkenne Name, Straße, Hausnummer, PLZ, Ort, Land, Telefon und E-Mail.',
        keyboard([[btn('❌ Abbrechen', 'cancel')]]), session);
}

/** Parses the text, then asks for the booking (or goes straight to the summary when it is known). */
async function handleAddressText(bot, chatId, session, body, fromScreenshot) {
    touch(session);
    const p = addressParser.parseAddress(body);
    if (fromScreenshot) {
        preferKnownGuestName(p, body);
        p.unknown = []; // headings and buttons of the app, not worth showing
    }
    if (!p.street && !p.zip && !p.city && !p.phone && !p.email) {
        return send(bot, chatId,
            fromScreenshot
                ? '🤔 Auf dem Screenshot habe ich keine Anschrift gefunden.\nAm besten so zuschneiden, dass Name und Adresse gut lesbar sind, oder die Anschrift als Text schicken.'
                : '🤔 Darin habe ich keine Anschrift gefunden.\nBitte mindestens Straße oder PLZ und Ort mitschicken, gern mehrzeilig.',
            keyboard([[btn('❌ Abbrechen', 'cancel')]]), session);
    }
    if (!fromScreenshot) session.photoMsgId = null;
    session.original = { ...p };
    session.geo = null;
    session.geoOff = false;
    await runGeoCheck(bot, chatId, session, p);
    session.parsed = p;
    session.raw = body;
    session.page = 0;
    session.replaceName = false;
    if (session.bookingId) return showAddressConfirm(bot, chatId, session);
    return showAddressBookings(bot, chatId, session);
}

/** Looks the address up on OpenStreetMap and fills/corrects what is safe (see geo-check.js). Never blocks saving. */
async function runGeoCheck(bot, chatId, session, p) {
    if (!p.street && !p.city && !p.zip) return;
    bot.sendChatAction(chatId, 'typing').catch(() => { });
    try {
        const r = await Promise.race([geoCheck.check(p), new Promise(res => setTimeout(() => res('timeout'), 15000))]);
        if (r === 'timeout' || !r) { session.geo = r === 'timeout' ? { error: true } : null; return; }
        session.geo = r;
        if (r.changes && Object.keys(r.changes).length) {
            Object.assign(p, r.changes);
            p.address = addressParser.formatAddress(p);
        }
    } catch (e) {
        console.warn('[TG] Kartenabgleich nicht möglich:', e.message);
        session.geo = { error: true };
    }
}

function geoText(session) {
    const g = session.geo;
    if (session.geoOff) return '🗺 <i>Ohne Kartenabgleich (so wie erkannt).</i>\n';
    if (!g) return '';
    if (g.error) return '🗺 <i>Kartenabgleich gerade nicht möglich.</i>\n';
    if (g.ambiguous) return '🗺 Diese Straße gibt es in mehreren Orten. Bitte PLZ oder Ort mitschicken.\n';
    if (!g.found) return '🗺 Auf der Karte (OpenStreetMap) nicht gefunden, bitte kurz prüfen.\n';
    let t = g.fills.length ? `🗺 Mit OpenStreetMap abgeglichen, von der Karte übernommen: ${esc(g.fills.join(', '))}.\n` : '🗺 Auf der Karte (OpenStreetMap) gefunden ✓\n';
    if (g.suggest) {
        const parts = [];
        if (g.suggest.street) parts.push(`Straße „${esc(g.suggest.street)}“`);
        if (g.suggest.zip) parts.push(`PLZ ${esc(g.suggest.zip)}`);
        if (g.suggest.city) parts.push(`Ort „${esc(g.suggest.city)}“`);
        t += `⚠️ Laut Karte eher: ${parts.join(', ')}.\n`;
    }
    return t;
}

function geoButtons(session) {
    const g = session.geo;
    const rows = [];
    if (!g || g.error || session.geoOff) {
        if (session.geoOff) rows.push([btn('🗺 Kartenabgleich wieder an', 'ageo:on')]);
        return rows;
    }
    if (g.suggest) rows.push([btn('🗺 Werte von der Karte übernehmen', 'ageo:map')]);
    if (g.changes && Object.keys(g.changes).length) rows.push([btn('↩️ Ohne Kartenabgleich', 'ageo:off')]);
    return rows;
}

/** Buttons under the summary: map values, original values, or back to the map result. */
async function applyGeoChoice(bot, chatId, session, choice) {
    const p = session.parsed;
    const g = session.geo || {};
    if (choice === 'off') {
        session.parsed = { ...session.original, name: p.name };
        session.geoOff = true;
    } else if (choice === 'on') {
        session.parsed = { ...session.original, name: p.name, ...(g.changes || {}) };
        session.geoOff = false;
    } else if (choice === 'map' && g.suggest) {
        Object.assign(p, g.suggest, g.changes || {});
        g.changes = { ...(g.changes || {}), ...g.suggest };
        g.fills = [...new Set([...(g.fills || []), ...Object.keys(g.suggest).map(k => ({ street: 'Straße', zip: 'PLZ', city: 'Ort' }[k]))])];
        g.suggest = null;
    }
    session.parsed.address = addressParser.formatAddress(session.parsed);
    return session.step === 'confirm' ? showAddressConfirm(bot, chatId, session) : showAddressBookings(bot, chatId, session);
}

async function showAddressBookings(bot, chatId, session) {
    session.step = 'pick';
    touch(session);
    const p = session.parsed;
    let list = [];
    try { list = addressCandidates(p.name); } catch (e) { console.error('[TG] Buchungen für Anschrift:', e.message); }
    const shown = list.slice(session.page * ADDRESS_PAGE, (session.page + 1) * ADDRESS_PAGE);
    let text = '📇 <b>Anschrift erkannt</b>\n\n' + addressFieldsText(p) + geoText(session) + '\n';
    if (!list.length) {
        text += '⚠️ Es gibt keine aktuelle oder kürzliche Buchung, zu der ich das speichern kann.';
        return send(bot, chatId, text, keyboard([[btn('🏠 Hauptmenü', 'menu')]]), session);
    }
    text += '<b>Zu welcher Buchung gehört das?</b>';
    if (session.page === 0 && list[0].match) text += '\n⭐ = Name passt';
    const rows = shown.map(b => [btn(`${b.match ? '⭐ ' : ''}${short(bookingLabel(b), 40)}`, `ab:${b.id}`)]);
    const nav = [];
    if (session.page > 0) nav.push(btn('⬅️ Vorherige', 'ab:prev'));
    if (list.length > (session.page + 1) * ADDRESS_PAGE) nav.push(btn('Weitere ➡️', 'ab:next'));
    if (nav.length) rows.push(nav);
    rows.push(...geoButtons(session));
    rows.push([btn('🧾 Stattdessen Rechnung erstellen', 'ab:inv')]);
    rows.push([btn('❌ Abbrechen', 'cancel')]);
    return send(bot, chatId, text, keyboard(rows), session);
}

async function showAddressConfirm(bot, chatId, session) {
    session.step = 'confirm';
    touch(session);
    const b = getBookingRow(session.bookingId);
    if (!b) {
        session.bookingId = null;
        session.fixedBooking = false;
        return showAddressBookings(bot, chatId, session);
    }
    const p = session.parsed;
    const current = b.guest_name && !botLogic.isPlaceholderGuestName(b.guest_name) ? b.guest_name : '';
    const guest = b.guest_id ? db.getGuestById(b.guest_id) : null;
    const differs = current && p.name && nameScore(current, p.name) < 2;

    let text = `📇 <b>Anschrift speichern</b>\n\n📅 Buchung <b>${fmtDate(b.checkin)} – ${fmtDate(b.checkout)}</b>\n\n`;
    text += addressFieldsText(p) + geoText(session);
    text += '\n<b>So steht es dann beim Gast:</b>\n';
    const name = (!current || (differs && session.replaceName)) ? p.name : current;
    text += `<code>${esc([name || '❓', p.address].filter(Boolean).join('\n'))}</code>\n`;
    if (p.phone) text += `📞 ${esc(p.phone)}\n`;
    if (p.email) text += `✉️ ${esc(p.email)}\n`;

    const notes = [];
    if (!current && !p.name) notes.push('⚠️ <b>Kein Name erkannt</b> und die Buchung hat noch keinen. Bitte die Anschrift mit dem Namen in der ersten Zeile erneut schicken.');
    if (differs) notes.push(session.replaceName
        ? `👤 Der Gastname wird von „${esc(current)}“ auf „${esc(p.name)}“ geändert (auch im Türcode).`
        : `👤 In der Buchung steht „${esc(current)}“. Der Name bleibt so, außer du tippst auf „Name übernehmen“.`);
    if (guest && guest.address && p.address && guest.address.trim() !== p.address.trim()) {
        notes.push(`ℹ️ Bisherige Adresse wird ersetzt: ${esc(guest.address.replace(/\n/g, ', '))}`);
    }
    if (!current && p.name) notes.push(`👤 Die Buchung bekommt den Namen „${esc(p.name)}“ (auch im Türcode).`);
    if (notes.length) text += '\n' + notes.join('\n');

    const rows = [];
    if (current || p.name) rows.push([btn('✅ Speichern', 'aok')]);
    rows.push(...geoButtons(session));
    if (differs) rows.push([btn(session.replaceName ? `↩️ Name „${short(current, 18)}“ behalten` : `👤 Name „${short(p.name, 18)}“ übernehmen`, 'aname')]);
    rows.push(session.fixedBooking ? [btn('❌ Abbrechen', 'cancel')] : [btn('⬅️ Andere Buchung', 'aback'), btn('❌ Abbrechen', 'cancel')]);
    return send(bot, chatId, text, keyboard(rows), session);
}

async function executeAddress(bot, chatId, session, q) {
    if (session.busy) return;
    session.busy = true;
    touch(session);
    try {
        const p = session.parsed;
        const b = getBookingRow(session.bookingId);
        if (!b) throw new Error('Die Buchung existiert nicht mehr.');
        const current = b.guest_name && !botLogic.isPlaceholderGuestName(b.guest_name) ? b.guest_name : '';
        const differs = current && p.name && nameScore(current, p.name) < 2;
        let guestId = b.guest_id;
        let nukiNote = '';
        if (!current || (differs && session.replaceName)) {
            if (!p.name) throw new Error('Kein Name erkannt.');
            await setProgress(bot, q, session, chatId, '⏳ <b>Wird gespeichert …</b>');
            const r = await botLogic.applyGuestName(b.id, p.name);
            guestId = r.guestId;
            if (r.booking.nuki_auth_id && !r.nukiRenamed) nukiNote = `\n⚠️ Der Türcode konnte in Nuki nicht umbenannt werden: ${esc(short(r.nukiError || '', 100))}`;
        }
        const g = db.getGuestById(guestId);
        if (!g) throw new Error('Gast nicht gefunden.');
        db.updateGuest(g.id, {
            ...g,
            address: p.address || g.address,
            phone: p.phone || g.phone,
            email: p.email || g.email
        });
        sessions.delete(chatId);
        if (q && q.message) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => { });
        console.log(`📇 Anschrift für Gast ${g.id} (Buchung ${b.id}) per Telegram gespeichert`);
        botLogic.guestDataSaved(b.id); // e.g. the automatic print waits for these details
        let photoNote = '';
        if (session.photoMsgId) {
            const ok = await bot.deleteMessage(chatId, session.photoMsgId).then(() => true).catch(() => false);
            photoNote = ok ? '\n🗑 Der Screenshot wurde aus dem Chat gelöscht.' : '\nℹ️ Den Screenshot konnte ich nicht löschen (nach 48 Std. geht das nicht mehr), bitte selbst entfernen.';
        }
        const saved = db.getGuestById(g.id);
        const text = `✅ <b>Gespeichert bei ${esc(saved.name)}</b>\n📅 ${fmtDate(b.checkin)} – ${fmtDate(b.checkout)}\n\n` +
            `<code>${esc([saved.name, saved.address].filter(Boolean).join('\n'))}</code>` +
            (saved.phone ? `\n📞 ${esc(saved.phone)}` : '') + (saved.email ? `\n✉️ ${esc(saved.email)}` : '') + nukiNote + photoNote +
            '\n\nDie Anschrift steht jetzt in der Gästeliste und wird bei der nächsten Rechnung automatisch eingesetzt.';
        return send(bot, chatId, text, keyboard([[btn('🧾 Rechnung erstellen', `inv:${b.id}`)], [btn('📇 Weitere Anschrift', 'adr'), btn('🏠 Hauptmenü', 'menu')]]));
    } catch (e) {
        console.error('[TG] Anschrift speichern:', e);
        session.busy = false;
        return send(bot, chatId, `❌ <b>Fehler:</b> ${esc(e.message)}`, keyboard([[btn('🔁 Erneut versuchen', 'aok')], [btn('❌ Abbrechen', 'cancel')]]), session);
    }
}

/** Text while the address dialog is open: a new address replaces the old one, anything else shows the step again. */
async function handleAddressInput(bot, chatId, session, body) {
    if (session.step === 'await') return handleAddressText(bot, chatId, session, body);
    const p = addressParser.parseAddress(body);
    if (p.street || p.zip || p.phone || p.email) return handleAddressText(bot, chatId, session, body);
    return session.step === 'confirm' ? showAddressConfirm(bot, chatId, session) : showAddressBookings(bot, chatId, session);
}

async function addressBack(bot, chatId, session) {
    if (session.step === 'confirm' && !session.fixedBooking) {
        session.bookingId = null;
        return showAddressBookings(bot, chatId, session);
    }
    return cancelSession(bot, chatId, session, false);
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function isImageDocument(msg) {
    return Boolean(msg.document && /^image\/(png|jpe?g|webp|bmp|tiff?)$/i.test(msg.document.mime_type || ''));
}

/** Screenshots: the guest name of a booking that shows up in the text beats a guessed name (OCR adds noise lines). */
function preferKnownGuestName(p, text) {
    try {
        const names = [...new Set(addressCandidates(null).map(b => b.guest_name).filter(n => n && !botLogic.isPlaceholderGuestName(n)))];
        const lines = String(text).split('\n');
        const hit = names.find(n => lines.some(l => nameScore(l, n) === 2));
        if (hit && nameScore(p.name, hit) < 2) p.name = hit;
    } catch (e) { /* best-effort */ }
}

/**
 * Photo or image file sent to the bot: read the text on it (on this server, see screenshot-ocr.js) and continue
 * like a pasted address. The image is only kept in a temp file during recognition; after saving, the photo message
 * is deleted from the chat as well.
 */
async function processPhoto(bot, msg) {
    const chatId = msg.chat.id;
    if (!db.isTelegramIdAuthorized(chatId)) {
        return send(bot, chatId, '⛔ <b>Zugriff verweigert</b>\n\nBitte sende <code>/register</code>, um eine Zugangsanfrage zu stellen.');
    }
    if (!permissions.canBot(botPerms(chatId), 'adresse')) return send(bot, chatId, DENIED);
    const file = msg.photo ? msg.photo[msg.photo.length - 1] : msg.document;
    if (!file || (file.file_size && file.file_size > MAX_IMAGE_BYTES)) {
        return send(bot, chatId, '⚠️ Das Bild ist zu groß (max. 10 MB). Bitte als normales Foto schicken.');
    }
    console.log(`[TG] Bild von [${chatId}] zur Texterkennung`);

    let session = getActiveSession(chatId);
    if (!session || session === 'expired' || session.flow !== 'address') {
        if (session && session !== 'expired') await cancelSession(bot, chatId, session, true);
        session = await startAddressFlow(bot, chatId, null, true);
    } else if (session.busy) {
        return send(bot, chatId, '⏳ Einen Moment bitte – ich bin noch am Arbeiten.');
    } else if (session.step !== 'await' && !session.fixedBooking) {
        session.bookingId = null;
    }
    session.busy = true;
    const waitMsg = await send(bot, chatId, '🔍 <b>Ich lese den Screenshot …</b>\nDas dauert ein paar Sekunden.');
    bot.sendChatAction(chatId, 'typing').catch(() => { });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ocr-'));
    let text = '';
    try {
        const filePath = await bot.downloadFile(file.file_id, tmpDir);
        const r = await ocr.recognize(filePath);
        text = r.text;
    } catch (e) {
        console.error('[TG] Texterkennung fehlgeschlagen:', e.message);
        session.busy = false;
        return send(bot, chatId, `❌ <b>Der Screenshot konnte nicht gelesen werden.</b>\n${esc(short(e.message, 160))}\n\nDu kannst die Anschrift auch als Text schicken.`, keyboard([[btn('❌ Abbrechen', 'cancel')]]), session);
    } finally {
        // The image is not kept on the server
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        if (waitMsg) bot.deleteMessage(chatId, waitMsg.message_id).catch(() => { });
    }
    session.busy = false;
    session.photoMsgId = msg.message_id;
    const caption = msg.caption ? `${msg.caption.trim()}\n` : '';
    return handleAddressText(bot, chatId, session, caption + text, true);
}

/**
 * Invoice dialog: only the real address goes into the invoice, never the rest of a pasted text
 * (Booking.com copies carry the listing title, adults, language …). Recognized street + town -> clean block.
 * Otherwise a short typed address stays as typed; a longer text that is no address returns '' so the bot asks.
 */
function tidyAddress(text, { strict = false } = {}) {
    const typed = String(text || '').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
    if (!typed) return '';
    const p = addressParser.parseAddress(typed);
    if (p.street && (p.zip || p.city || p.country)) return p.address;
    if (strict) return '';
    return typed.split('\n').length <= 4 ? typed : '';
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
            const clean = tidyAddress(text);
            if (!clean) return { ok: false, error: '⚠️ Darin habe ich keine Anschrift gefunden. Bitte Straße mit Hausnummer, PLZ und Ort schicken.' };
            d.gAdresse = clean;
            const parsed = addressParser.parseAddress(text);
            if (parsed.email && d.gEmail === undefined) d.gEmail = parsed.email;
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
    if (flowName === 'invoice' && initialText) {
        // Address from the whole text (labels like "Adresse" / "Land/Region" are understood), dates are already out
        const m = botLogic.parseDates(initialText.replace(/\n/g, ' ')).matched;
        const flatIdx = m ? initialText.replace(/\n/g, ' ').indexOf(m) : -1;
        const work = flatIdx >= 0 ? initialText.slice(0, flatIdx) + '\n' + initialText.slice(flatIdx + m.length) : initialText;
        const addr = addressParser.parseAddress(work);
        data.gAdresse = addr.street && (addr.zip || addr.city || addr.country) ? addr.address : tidyAddress(data.gAdresse, { strict: data.gAdresse.split('\n').length > 4 });
        if (!data.gEmail && addr.email) data.gEmail = addr.email;
    }
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
            if (data.bookingId) invoiceData.bookingId = data.bookingId;
            try { await addressCheck.bindInvoiceGuest(invoiceData); }
            catch (e) { console.warn('[TG] Rechnung: Gast der Buchung nicht zuordenbar:', e.message); }
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
    // A code of this stay with other dates (check-in moved): move it instead of creating a second one
    const reused = await botLogic.reuseStayCode(data.gName, data.arrival, data.departure).catch(e => {
        console.warn('[TG] Bestehender Türcode konnte nicht angepasst werden:', e.message);
        return null;
    });
    if (reused) return reused.pin;

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
const COMMAND_RE = /^\/?(rechnung|pin|adresse|anschrift|sync|namen|codes|türcodes|tuercodes|status|offen|anreisen|nachricht|hilfe|help|start|menü|menu|register|abbrechen|zurück|zurueck)(?:@\w+)?(?=$|[\s:,.-])[:\s,.-]*/i;

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
    if (!msg.text && (msg.photo || isImageDocument(msg))) return processPhoto(bot, msg);
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

    // Reply to a guest-chat notice: goes to the guest by WhatsApp/SMS (see guest-chat.js)
    if (msg.reply_to_message && hooks && hooks.guestChatReply && permissions.can(botPerms(chatId), 'messages', 'edit')
        && await hooks.guestChatReply(bot, msg)) return;

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
    const perms = botPerms(chatId);
    const allowed = (right) => permissions.canBot(perms, right);

    // --- Globale Navigation (in jedem Schritt) ---
    if (active) {
        if (CANCEL_WORDS.has(lower)) return cancelSession(bot, chatId, active, false);
        if (BACK_WORDS.has(lower)) return active.flow === 'address' ? addressBack(bot, chatId, active) : goBack(bot, chatId, active);
        if (MENU_WORDS.has(lower)) return cancelSession(bot, chatId, active, false);
    } else if (BACK_WORDS.has(lower) || CANCEL_WORDS.has(lower) || MENU_WORDS.has(lower)) {
        return showMenu(bot, chatId);
    }

    // Schloss-Befehle nur mit Schrägstrich, damit kein Freitext versehentlich die Tür bedient
    const lockCmd = body.match(LOCK_CMD_RE);
    if (lockCmd) {
        if (active) await cancelSession(bot, chatId, active, true);
        const c = lockCmd[1].toLowerCase();
        if (!allowed(c === 'zu' || c === 'auf' ? 'lock' : 'lockstatus')) return send(bot, chatId, DENIED);
        if (c === 'zu') return runLockAction(bot, chatId, 'lock', msg.from && (msg.from.username || msg.from.first_name));
        if (c === 'auf') return confirmUnlock(bot, chatId);
        return showLockStatus(bot, chatId);
    }

    // Jahresrückblick: /jahr oder /jahr 2025 (ohne Jahr: laufendes Jahr, im Januar das Vorjahr)
    const yearCmd = body.match(/^\/(jahr|rueckblick|rückblick)(?:@\w+)?(?:\s+(\d{4}))?$/i);
    if (yearCmd) {
        if (!allowed('review')) return send(bot, chatId, DENIED);
        if (active) await cancelSession(bot, chatId, active, true);
        return showYearReview(bot, chatId, yearCmd[2] ? parseInt(yearCmd[2], 10) : null);
    }

    // WLAN-Codes: /wlan, /wlan 3, /wlan 4h Handwerker
    const wifiCmd = body.match(/^\/(wlan|wifi)(?:@\w+)?(?:\s+([\s\S]+))?$/i);
    if (wifiCmd) {
        if (!allowed('wlan')) return send(bot, chatId, DENIED);
        if (active) await cancelSession(bot, chatId, active, true);
        if (!wifiCmd[2]) return showWifiCodes(bot, chatId);
        const a = parseWifiArg(wifiCmd[2]);
        if (!a) return showWifiCodes(bot, chatId, '🤔 Dauer nicht erkannt. Beispiele: <code>/wlan 3</code> (3 Tage), <code>/wlan 4h</code>, <code>/wlan 1w Eltern</code>');
        return createWifiCode(bot, chatId, a.hours, a.note, msg.from && (msg.from.username || msg.from.first_name));
    }

    let cmd = detectCommand(body);
    // Im laufenden Dialog gelten nur echte Slash-Befehle als Befehle - sonst könnte eine Antwort
    // wie "Status Quo" als Name versehentlich einen Befehl auslösen.
    if (cmd && active && !body.startsWith('/')) cmd = null;

    // --- Befehle ---
    if (cmd && CMD_RIGHT[cmd.cmd.toLowerCase()] && !allowed(CMD_RIGHT[cmd.cmd.toLowerCase()])) return send(bot, chatId, DENIED);
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
            case 'nachricht':
                return showGuestMessageList(bot, chatId);
            case 'rechnung':
                return startFlow(bot, chatId, 'invoice', cmd.rest);
            case 'pin':
                return startFlow(bot, chatId, 'pin', cmd.rest);
            case 'adresse':
            case 'anschrift': {
                if (active) await cancelSession(bot, chatId, active, true);
                if (!cmd.rest) return startAddressFlow(bot, chatId, null);
                await startAddressFlow(bot, chatId, null, true);
                return handleAddressText(bot, chatId, sessions.get(chatId), cmd.rest);
            }
            default:
                break;
        }
    }

    // --- Antwort in laufendem Dialog ---
    if (active && !active.busy && active.flow === 'address') {
        return handleAddressInput(bot, chatId, active, body);
    }
    if (active && !active.busy) {
        return handleStepInput(bot, chatId, active, body);
    }
    if (active && active.busy) {
        return send(bot, chatId, '⏳ Einen Moment bitte – ich bin noch am Arbeiten.');
    }

    // --- Freitext ohne Befehl: eingefügte Anschrift (ohne Datum) -> beim Gast speichern ---
    if (isAddressText(body)) {
        if (!allowed('adresse')) return send(bot, chatId, DENIED);
        await startAddressFlow(bot, chatId, null, true);
        return handleAddressText(bot, chatId, sessions.get(chatId), body);
    }

    // --- Freitext ohne Befehl: Buchungstext erkennen (mehrzeilig oder mit Datum) ---
    if (body.split('\n').length >= 2 || /\d{1,2}\.\d{1,2}\./.test(body)) {
        if (!allowed('rechnung')) return send(bot, chatId, DENIED);
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
    const needsSession = ['keep', 'skip', 'back', 'cancel', 'ok', 'edit', 'aok', 'aname', 'aback'].includes(data) || data.startsWith('ef:') || data.startsWith('ab:') || data.startsWith('ageo:');
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

    const right = callbackRight(data);
    if (right && !permissions.canBot(botPerms(chatId), right)) {
        await answer('⛔ Keine Berechtigung');
        return;
    }

    await answer();
    const who = q.from && (q.from.username || q.from.first_name);

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
            case data === 'lock:status':
                return showLockStatus(bot, chatId);
            case data === 'lock:zu':
                return runLockAction(bot, chatId, 'lock', who);
            case data === 'lock:auf':
                return confirmUnlock(bot, chatId);
            case data === 'lock:auf!':
            case data === 'lock:open!':
                // Remove the confirmation buttons so a second tap cannot trigger it again
                if (q.message) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => { });
                // An old confirmation lying around in the chat must not open the door days later
                if (!q.message || Date.now() / 1000 - q.message.date > 5 * 60) {
                    return send(bot, chatId, '⏱ Die Rückfrage ist abgelaufen. Bitte noch einmal <code>/auf</code> senden.', lockKeyboard());
                }
                return runLockAction(bot, chatId, data === 'lock:auf!' ? 'unlock' : 'unlatch', who);
            case data === 'gm':
                return showGuestMessageList(bot, chatId);
            case /^gm:(de|en|nl|pl):/.test(data):
                return showGuestMessage(bot, chatId, parseInt(data.slice(6), 10), data.slice(3, 5));
            case data.startsWith('gm:'):
                return showGuestMessage(bot, chatId, parseInt(data.slice(3), 10));
            case data.startsWith('gl:new?:'):
                return confirmNewGuestLink(bot, chatId, parseInt(data.slice(8), 10));
            case data.startsWith('gl:new!:'):
                if (q.message) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => { });
                return renewGuestLink(bot, chatId, parseInt(data.slice(8), 10));
            case data.startsWith('gl:off:'):
                return blockGuestLink(bot, chatId, parseInt(data.slice(7), 10));
            case data.startsWith('nm:'):
                return startNameFlow(bot, chatId, parseInt(data.slice(3), 10));
            case data === 'adr':
                return startAddressFlow(bot, chatId, null);
            case data.startsWith('adr:'):
                return startAddressFlow(bot, chatId, parseInt(data.slice(4), 10));
            case data.startsWith('ab:'): {
                if (active.flow !== 'address' || !active.parsed) return;
                const arg = data.slice(3);
                if (arg === 'next') { active.page++; return showAddressBookings(bot, chatId, active); }
                if (arg === 'prev') { active.page = Math.max(0, active.page - 1); return showAddressBookings(bot, chatId, active); }
                if (arg === 'inv') {
                    if (!permissions.canBot(botPerms(chatId), 'rechnung')) return send(bot, chatId, DENIED);
                    const raw = active.raw;
                    await cancelSession(bot, chatId, active, true);
                    return startFlow(bot, chatId, 'invoice', raw);
                }
                active.bookingId = parseInt(arg, 10);
                active.replaceName = false;
                return showAddressConfirm(bot, chatId, active);
            }
            case data.startsWith('ageo:'):
                if (active.flow !== 'address' || !active.parsed) return;
                return applyGeoChoice(bot, chatId, active, data.slice(5));
            case data === 'aname':
                if (active.flow !== 'address' || active.step !== 'confirm') return;
                active.replaceName = !active.replaceName;
                return showAddressConfirm(bot, chatId, active);
            case data === 'aback':
                if (active.flow !== 'address') return;
                return addressBack(bot, chatId, active);
            case data === 'aok':
                if (active.flow !== 'address' || active.step !== 'confirm') return;
                return executeAddress(bot, chatId, active, q);
            case data === 'wl':
                return showWifiCodes(bot, chatId);
            case data.startsWith('wl:new:'):
                return createWifiCode(bot, chatId, parseInt(data.slice(7), 10), '', who);
            case data.startsWith('wl:del:'): {
                const { portal, error } = wifiPortal();
                if (error) return send(bot, chatId, `📶 ${esc(error)}`, menuOnlyKeyboard());
                const row = portal.deleteExtraCode(parseInt(data.slice(7), 10));
                if (q.message) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => { });
                return showWifiCodes(bot, chatId, row ? `🗑 Code <code>${esc(row.code)}</code> gelöscht. Angemeldete Geräte fliegen in spätestens 2 Minuten raus.` : 'Dieser Code war schon gelöscht.');
            }
            case data.startsWith('ovl:'): {
                const n = hooks.ackOverlap ? hooks.ackOverlap(data.slice(4)) : 0;
                if (q.message) bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id }).catch(() => { });
                return send(bot, chatId, n ? '✅ Erledigt. Zu dieser Überschneidung kommt keine Erinnerung mehr.' : 'Diese Überschneidung besteht nicht mehr.');
            }
            case data.startsWith('inv:'):
                return startInvoiceFromBooking(bot, chatId, parseInt(data.slice(4), 10));
            case data === 'new:invoice':
                return startFlow(bot, chatId, 'invoice', '');
            case data === 'new:pin':
                return startFlow(bot, chatId, 'pin', '');

            case data === 'cancel':
                return cancelSession(bot, chatId, active, false);
            case data === 'back':
                return active.flow === 'address' ? addressBack(bot, chatId, active) : goBack(bot, chatId, active);

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
            { command: 'adresse', description: 'Anschrift eines Gastes einfügen' },
            { command: 'sync', description: 'Kalender jetzt abfragen' },
            { command: 'codes', description: 'Angelegte Türcodes anzeigen' },
            { command: 'status', description: 'Offene Rechnungen anzeigen' },
            { command: 'anreisen', description: 'Kommende Buchungen anzeigen' },
            { command: 'nachricht', description: 'Fertige Nachricht für den Gast' },
            { command: 'schloss', description: 'Schloss-Status und Batterie' },
            { command: 'zu', description: 'Tür abschließen' },
            { command: 'jahr', description: 'Jahresrückblick mit Statistik' },
            { command: 'wlan', description: 'WLAN-Codes für Besucher erzeugen' },
            { command: 'auf', description: 'Tür aufschließen (mit Rückfrage)' },
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
    showGuestMessage,
    // für Tests
    _internal: { parseWifiArg, sessions, detectCommand, applyInput, FLOWS, isAddressText, addressCandidates, nameScore }
};
