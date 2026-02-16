const db = require('./db');
const botLogic = require('./bot-logic');

// Simple in-memory state for follow-up questions
const sessions = new Map();

/**
 * Main entry point for processing incoming WhatsApp messages.
 */
async function processMessage(msg, waClient, MessageMedia) {
    const from = msg.from;
    const body = msg.body.trim();

    // Ignore Groups and Newsletters/Channels
    if (from.includes('@g.us') || from.includes('@newsletter')) {
        console.log(`[WA] Ignoriere Nachricht von Gruppe/Channel: ${from}`);
        return;
    }

    const user = db.getUserByPhone(from);

    console.log(`[WA] Nachricht von [${from}]: "${body}"`);
    if (!user) {
        console.warn(`[WA] Zugriff verweigert für ID: ${from}. Diese ID/Nummer ist nicht als Admin-Benutzer in der Datenbank registriert.`);
        console.log(`[WA] Tipp: Prüfe ob die Nummer in der DB mit der Absender-ID übereinstimmt.`);
        return; // Ignore unauthorized numbers
    }
    console.log(`[WA] Authentifizierter User: ${user.username} (ID: ${from})`);

    // Check if we are in a follow-up session
    if (sessions.has(from)) {
        return handleFollowUp(msg, waClient, MessageMedia, sessions.get(from));
    }

    const command = body.split('\n')[0].toLowerCase();

    if (command.includes('rechnung')) {
        return handleInvoiceCommand(msg, waClient, MessageMedia);
    } else if (command.includes('status')) {
        return msg.reply(await botLogic.getStatusText());
    } else if (command.includes('pin')) {
        return handlePinCommand(msg, waClient);
    } else if (command.includes('hilfe') || command === '?') {
        return handleHelpCommand(msg);
    } else {
        // Try parsing as freeform invoice if it looks like one
        if (body.split('\n').length >= 2 || body.match(/\d{2}\.\d{2}\./)) {
            return handleInvoiceCommand(msg, waClient, MessageMedia);
        }
        await msg.reply('Entschuldigung, ich habe den Befehl nicht verstanden. Schreibe "Hilfe" für eine Übersicht.');
    }
}

async function handleInvoiceCommand(msg, waClient, MessageMedia) {
    const body = msg.body;
    const from = msg.from;

    const data = botLogic.parseInvoiceText(body);

    // Check for missing data
    if (!data.gName) {
        sessions.set(from, { type: 'awaiting_name', data });
        return msg.reply('Für wen ist die Rechnung? (Bitte Vor- und Nachname angeben)');
    }
    if (!data.gAdresse) {
        sessions.set(from, { type: 'awaiting_address', data });
        return msg.reply('Wie lautet die Adresse?');
    }
    if (!data.arrival || !data.departure) {
        sessions.set(from, { type: 'awaiting_dates', data });
        return msg.reply('Für welchen Zeitraum? (z.B. 15.03. - 20.03.2026)');
    }

    return finalizeInvoiceWA(msg, waClient, MessageMedia, data);
}

async function handleFollowUp(msg, waClient, MessageMedia, session) {
    const body = msg.body.trim();
    const from = msg.from;

    if (body.toLowerCase() === 'abbrechen') {
        sessions.delete(from);
        return msg.reply('Vorgang abgebrochen.');
    }

    if (session.type === 'awaiting_name' || session.type === 'awaiting_pin_name') {
        session.data.gName = body;
        if (session.type === 'awaiting_pin_name') {
            session.type = 'awaiting_pin_dates';
            return msg.reply('Für welchen Zeitraum? (z.B. 15.03. - 20.03.)');
        } else {
            session.type = 'awaiting_address';
            return msg.reply('Wie lautet die Adresse?');
        }
    } else if (session.type === 'awaiting_address') {
        session.data.gAdresse = body;
        session.type = 'awaiting_dates';
        return msg.reply('Für welchen Zeitraum? (z.B. 15.03. - 20.03.2026)');
    } else if (session.type === 'awaiting_dates' || session.type === 'awaiting_pin_dates') {
        const dates = botLogic.parseDates(body);
        if (!dates.arrival || !dates.departure) {
            return msg.reply('Ich konnte den Zeitraum nicht erkennen. Bitte im Format DD.MM. - DD.MM.YYYY angeben.');
        }
        session.data.arrival = dates.arrival;
        session.data.departure = dates.departure;
    }

    // If we reach here, we might have everything
    const data = session.data;
    if (session.type.startsWith('awaiting_pin')) {
        if (data.gName && data.arrival && data.departure) {
            sessions.delete(from);
            return finalizePinOnlyWA(msg, waClient, data);
        }
    } else {
        if (data.gName && data.gAdresse && data.arrival && data.departure) {
            sessions.delete(from);
            return finalizeInvoiceWA(msg, waClient, MessageMedia, data);
        }
    }
}

async function finalizeInvoiceWA(msg, waClient, MessageMedia, data) {
    try {
        await msg.reply('⏳ Erstelle Rechnung und generiere Nuki-PIN...');
        const invoiceData = await botLogic.finalizeInvoiceData(data);

        // Save to DB
        db.saveInvoice(invoiceData);

        // Generate PDF
        const { filePath } = await botLogic.generateInvoicePdf(invoiceData);

        // Send PDF
        const media = MessageMedia.fromFilePath(filePath);
        await waClient.sendMessage(msg.from, media, { caption: `✅ Rechnung ${invoiceData.rNummer} erstellt.\n🔑 Nuki-PIN: ${invoiceData.nukiPin || 'Fehlgeschlagen'}` });

        //Cleanup
        const fs = require('fs');
        fs.unlinkSync(filePath);
    } catch (e) {
        console.error('[WA] Invoice Error:', e);
        await msg.reply('❌ Fehler bei der Rechnungsstellung: ' + e.message);
    }
}

async function handlePinCommand(msg, waClient) {
    const from = msg.from;
    const body = msg.body;
    const data = botLogic.parseInvoiceText(body.replace(/pin/i, '').trim());

    if (!data.gName) {
        sessions.set(from, { type: 'awaiting_pin_name', data });
        return msg.reply('Für wen soll der Tür-Code erstellt werden?');
    }
    if (!data.arrival || !data.departure) {
        sessions.set(from, { type: 'awaiting_pin_dates', data });
        return msg.reply('Für welchen Zeitraum? (z.B. 15.03. - 20.03.)');
    }
    return finalizePinOnlyWA(msg, waClient, data);
}

async function finalizePinOnlyWA(msg, waClient, data) {
    try {
        await msg.reply('⏳ Generiere Nuki-PIN...');
        const axios = require('axios');
        const nukiRes = await axios.post(`http://localhost:${process.env.PORT || 3000}/api/nuki/create-pin`, {
            arrival: data.arrival,
            departure: data.departure,
            guestName: data.gName
        });

        if (nukiRes.data.success) {
            const pin = nukiRes.data.pin;
            const authId = nukiRes.data.authId;
            db.findOrCreateGuest(data.gName, null, null); // Sync guest
            const existingBooking = db.findBookingForStay(data.gName, data.arrival, data.departure);
            if (existingBooking) {
                db.updateBookingNukiData(existingBooking.id, pin, authId);
            }
            await msg.reply(`✅ Nuki-PIN erstellt!\n\n🔑 Code: *${pin}*\n👤 Gast: ${data.gName}\n📅 Zeitraum: ${data.arrival} bis ${data.departure}`);
        } else {
            await msg.reply('❌ Nuki Fehler: ' + (nukiRes.data.error || 'Unbekannt'));
        }
    } catch (e) {
        await msg.reply('❌ Fehler: ' + e.message);
    }
}

async function handleHelpCommand(msg) {
    const text = `*WhatsApp Buchungs-Assistent* 🏠\n\n` +
        `• *Rechnung [Name]*: Startet Erstellung\n` +
        `• *Pin [Name]*: Nur Tür-Code erstellen\n` +
        `• *Status*: Offene Rechnungen anzeigen\n` +
        `• *Hilfe*: Diese Übersicht\n\n` +
        `Du kannst auch einfach Buchungstexte reinkopieren!`;
    await msg.reply(text);
}

module.exports = {
    processMessage
};
