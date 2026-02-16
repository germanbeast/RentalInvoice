const db = require('./db');
const botLogic = require('./bot-logic');
const fs = require('fs');

// Simple in-memory state for follow-up questions
const sessions = new Map();

/**
 * Handle Telegram Messages
 */
async function processMessage(bot, msg) {
    const chatId = msg.chat.id;
    const body = msg.text ? msg.text.trim() : '';

    if (!body) return;

    // Authorization
    const isAuthorized = db.isTelegramIdAuthorized(chatId);
    console.log(`[TG] Nachricht von [${chatId}]: "${body}"`);

    if (!isAuthorized) {
        // Registration Flow
        if (body.toLowerCase() === '/register' || body.toLowerCase() === '/start') {
            const firstName = msg.from ? msg.from.first_name : 'Unbekannt';
            const username = msg.from ? msg.from.username : '';

            db.addPendingTelegramRequest(chatId, firstName, username);

            return bot.sendMessage(chatId, `🔒 *Zugriff angefragt*\n\nDeine ID \`${chatId}\` wurde an den Administrator gesendet.\nBitte schalte den Zugriff im Web-Interface (Einstellungen -> Telegram) frei.`, { parse_mode: 'Markdown' });
        }

        console.warn(`[TG] Zugriff verweigert für ID: ${chatId}.`);
        return bot.sendMessage(chatId, `⛔ Zugriff verweigert.\nSende \`/register\` um eine Anfrage zu stellen.`);
    }

    // ALREADY AUTHORIZED: Handle /register and /start
    if (body.toLowerCase() === '/register') {
        return bot.sendMessage(chatId, `✅ *Du bist bereits registriert.*\nDein Zugriff ist aktiv.`, { parse_mode: 'Markdown' });
    }
    if (body.toLowerCase() === '/start') {
        return handleHelpCommand(bot, msg);
    }

    // Follow-up sessions
    if (sessions.has(chatId)) {
        return handleFollowUp(bot, msg, sessions.get(chatId));
    }

    const command = body.split('\n')[0].toLowerCase();

    if (command.includes('rechnung')) {
        return handleInvoiceCommand(bot, msg);
    } else if (command.includes('status')) {
        return bot.sendMessage(chatId, await botLogic.getStatusText(), { parse_mode: 'Markdown' });
    } else if (command.includes('pin')) {
        return handlePinCommand(bot, msg);
    } else if (command.includes('hilfe') || command === '/help') {
        return handleHelpCommand(bot, msg);
    } else {
        if (body.split('\n').length >= 2 || body.match(/\d{2}\.\d{2}\./)) {
            return handleInvoiceCommand(bot, msg);
        }
    }
}

async function handleInvoiceCommand(bot, msg) {
    const chatId = msg.chat.id;
    const body = msg.text;
    const data = botLogic.parseInvoiceText(body);

    if (!data.gName) {
        sessions.set(chatId, { type: 'awaiting_name', data });
        return bot.sendMessage(chatId, 'Für wen ist die Rechnung? (Bitte Vor- und Nachname angeben)');
    }
    if (!data.gAdresse) {
        sessions.set(chatId, { type: 'awaiting_address', data });
        return bot.sendMessage(chatId, 'Wie lautet die Adresse?');
    }
    if (!data.arrival || !data.departure) {
        sessions.set(chatId, { type: 'awaiting_dates', data });
        return bot.sendMessage(chatId, 'Für welchen Zeitraum? (z.B. 15.03. - 20.03.2026)');
    }

    return finalizeInvoiceTG(bot, msg, data);
}

async function handleFollowUp(bot, msg, session) {
    const body = msg.text.trim();
    const chatId = msg.chat.id;

    if (body.toLowerCase() === 'abbrechen') {
        sessions.delete(chatId);
        return bot.sendMessage(chatId, 'Vorgang abgebrochen.');
    }

    if (session.type === 'awaiting_name' || session.type === 'awaiting_pin_name') {
        session.data.gName = body;
        if (session.type === 'awaiting_pin_name') {
            session.type = 'awaiting_pin_dates';
            return bot.sendMessage(chatId, 'Für welchen Zeitraum? (z.B. 15.03. - 20.03.)');
        } else {
            session.type = 'awaiting_address';
            return bot.sendMessage(chatId, 'Wie lautet die Adresse?');
        }
    } else if (session.type === 'awaiting_address') {
        session.data.gAdresse = body;
        session.type = 'awaiting_dates';
        return bot.sendMessage(chatId, 'Für welchen Zeitraum? (z.B. 15.03. - 20.03.2026)');
    } else if (session.type === 'awaiting_dates' || session.type === 'awaiting_pin_dates') {
        const dates = botLogic.parseDates(body);
        if (!dates.arrival || !dates.departure) {
            return bot.sendMessage(chatId, 'Zeitraum nicht erkannt. Bitte DD.MM. - DD.MM.YYYY.');
        }
        session.data.arrival = dates.arrival;
        session.data.departure = dates.departure;
    }

    const data = session.data;
    if (session.type.startsWith('awaiting_pin')) {
        if (data.gName && data.arrival && data.departure) {
            sessions.delete(chatId);
            return finalizePinOnlyTG(bot, msg, data);
        }
    } else {
        if (data.gName && data.gAdresse && data.arrival && data.departure) {
            sessions.delete(chatId);
            return finalizeInvoiceTG(bot, msg, data);
        }
    }
}

async function finalizeInvoiceTG(bot, msg, data) {
    const chatId = msg.chat.id;
    try {
        bot.sendMessage(chatId, '⏳ Erstelle Rechnung...');
        const invoiceData = await botLogic.finalizeInvoiceData(data);
        db.saveInvoice(invoiceData);

        const { filePath } = await botLogic.generateInvoicePdf(invoiceData);
        await bot.sendDocument(chatId, filePath, {
            caption: `✅ Rechnung ${invoiceData.rNummer} erstellt.\n🔑 Nuki-PIN: ${invoiceData.nukiPin || 'Fehlgeschlagen'}`
        });

        fs.unlinkSync(filePath);
    } catch (e) {
        bot.sendMessage(chatId, '❌ Fehler: ' + e.message);
    }
}

async function handlePinCommand(bot, msg) {
    const chatId = msg.chat.id;
    const body = msg.text;
    const data = botLogic.parseInvoiceText(body.replace(/pin/i, '').trim());

    if (!data.gName) {
        sessions.set(chatId, { type: 'awaiting_pin_name', data });
        return bot.sendMessage(chatId, 'Für wen soll der Tür-Code erstellt werden?');
    }
    if (!data.arrival || !data.departure) {
        sessions.set(chatId, { type: 'awaiting_pin_dates', data });
        return bot.sendMessage(chatId, 'Für welchen Zeitraum? (z.B. 15.03. - 20.03.)');
    }
    return finalizePinOnlyTG(bot, msg, data);
}

async function finalizePinOnlyTG(bot, msg, data) {
    const chatId = msg.chat.id;
    try {
        bot.sendMessage(chatId, '⏳ Generiere Nuki-PIN...');
        const axios = require('axios');
        const nukiRes = await axios.post(`http://localhost:${process.env.PORT || 3000}/api/nuki/create-pin`, {
            arrival: data.arrival,
            departure: data.departure,
            guestName: data.gName
        });

        if (nukiRes.data.success) {
            const pin = nukiRes.data.pin;
            const authId = nukiRes.data.authId;
            db.findOrCreateGuest(data.gName, null, null);
            const existingBooking = db.findBookingForStay(data.gName, data.arrival, data.departure);
            if (existingBooking) {
                db.updateBookingNukiData(existingBooking.id, pin, authId);
            }
            bot.sendMessage(chatId, `✅ Tür-Code: *${pin}*\nGast: ${data.gName}\nZeit: ${data.arrival} bis ${data.departure}`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, '❌ Nuki Fehler: ' + (nukiRes.data.error || 'Unbekannt'));
        }
    } catch (e) {
        bot.sendMessage(chatId, '❌ Fehler: ' + e.message);
    }
}

async function handleHelpCommand(bot, msg) {
    const text = `*Telegram Buchungs-Assistent* 🏠\n\n` +
        `• Rechnung [Name]\n` +
        `• Pin [Name]\n` +
        `• Status\n` +
        `• Hilfe\n\n` +
        `Du kannst auch einfach Buchungstexte senden!`;
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
}

module.exports = {
    processMessage
};
