const db = require('./db');
const { renderInvoiceHtml } = require('./invoice-template');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

// Simple in-memory state for follow-up questions
const sessions = new Map();

/**
 * Main entry point for processing incoming WhatsApp messages.
 */
async function processMessage(msg, waClient, MessageMedia) {
    const from = msg.from;
    const body = msg.body.trim();
    const user = db.getUserByPhone(from);

    if (!user) {
        console.warn(`Unbefugter Zugriff von ${from}`);
        return; // Ignore unauthorized numbers
    }

    // Check if we are in a follow-up session
    if (sessions.has(from)) {
        return handleFollowUp(msg, waClient, MessageMedia, sessions.get(from));
    }

    const command = body.split('\n')[0].toLowerCase();

    if (command.includes('rechnung')) {
        return handleInvoiceCommand(msg, waClient, MessageMedia);
    } else if (command.includes('status')) {
        return handleStatusCommand(msg);
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

    const data = parseInvoiceText(body);

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

    return finalizeInvoice(msg, waClient, MessageMedia, data);
}

async function handleFollowUp(msg, waClient, MessageMedia, session) {
    const body = msg.body.trim();
    const from = msg.from;

    if (body.toLowerCase() === 'abbrechen') {
        sessions.delete(from);
        return msg.reply('Vorgang abgebrochen.');
    }

    if (session.type === 'awaiting_name') {
        session.data.gName = body;
        session.type = 'awaiting_address';
        return msg.reply('Wie lautet die Adresse?');
    } else if (session.type === 'awaiting_address') {
        session.data.gAdresse = body;
        session.type = 'awaiting_dates';
        return msg.reply('Für welchen Zeitraum? (z.B. 15.03. - 20.03.2026)');
    } else if (session.type === 'awaiting_dates') {
        const dates = parseDates(body);
        if (!dates.arrival || !dates.departure) {
            return msg.reply('Ich konnte den Zeitraum nicht erkennen. Bitte im Format DD.MM. - DD.MM.YYYY angeben.');
        }
        session.data.arrival = dates.arrival;
        session.data.departure = dates.departure;
    }

    // If we reach here, we might have everything
    const data = session.data;
    if (data.gName && data.gAdresse && data.arrival && data.departure) {
        sessions.delete(from);
        return finalizeInvoice(msg, waClient, MessageMedia, data);
    }
}

async function finalizeInvoice(msg, waClient, MessageMedia, data) {
    try {
        await msg.reply('⏳ Erstelle Rechnung und generiere Nuki-PIN...');

        const allSettings = db.getAllSettings();
        const vermieter = allSettings.vermieter || {};
        const bank = allSettings.bank || {};
        const pricing = allSettings.pricing || { price_per_night: 85, cleaning_fee: 50, mwst_rate: 7, kleinunternehmer: false };

        const nights = calcNights(data.arrival, data.departure);
        const subtotal = (nights * pricing.price_per_night) + pricing.cleaning_fee;

        const invoiceData = {
            vName: vermieter.name,
            vAdresse: vermieter.adresse,
            vTelefon: vermieter.telefon,
            vEmail: vermieter.email,
            vSteuernr: vermieter.steuernr,
            gName: data.gName,
            gAdresse: data.gAdresse,
            rNummer: db.getNextInvoiceNumber(),
            rDatum: new Date().toISOString().split('T')[0],
            aAnreise: data.arrival,
            aAbreise: data.departure,
            mwstSatz: pricing.mwst_rate,
            kleinunternehmer: pricing.kleinunternehmer,
            zBezahlt: false,
            zMethode: 'Überweisung',
            zDatum: '',
            zShowBank: true,
            bInhaber: bank.inhaber,
            bIban: bank.iban,
            bBic: bank.bic,
            bBank: bank.name,
            positions: [
                { desc: 'Übernachtung', qty: nights, price: pricing.price_per_night },
                { desc: 'Endreinigung', qty: 1, price: pricing.cleaning_fee }
            ],
            branding: db.getBranding()
        };

        // 1. Create Nuki PIN
        try {
            const nukiUrl = `http://localhost:${process.env.PORT || 3000}/api/nuki/create-pin`;
            const nukiRes = await axios.post(nukiUrl, {
                arrival: data.arrival,
                departure: data.departure,
                guestName: data.gName
            });
            if (nukiRes.data.success) {
                invoiceData.nukiPin = nukiRes.data.pin;
            }
        } catch (e) {
            console.error('Nuki PIN failed in WhatsApp flow:', e.message);
            // Continue even without Nuki PIN
        }

        // 2. Save to DB
        db.saveInvoice(invoiceData);

        // 3. Generate PDF
        const html = renderInvoiceHtml(invoiceData);
        const pdfUrl = `http://localhost:${process.env.PORT || 3000}/api/generate-pdf`;
        const pdfRes = await axios.post(pdfUrl, { html }, { responseType: 'arraybuffer' });

        const fileName = `Rechnung_${invoiceData.rNummer}.pdf`;
        const filePath = path.join(__dirname, 'temp', fileName);
        if (!fs.existsSync(path.join(__dirname, 'temp'))) fs.mkdirSync(path.join(__dirname, 'temp'));
        fs.writeFileSync(filePath, pdfRes.data);

        // 4. Send PDF
        const media = MessageMedia.fromFilePath(filePath);
        await waClient.sendMessage(msg.from, media, { caption: `✅ Rechnung ${invoiceData.rNummer} erstellt.\n🔑 Nuki-PIN: ${invoiceData.nukiPin || 'Fehlgeschlagen'}` });

        // Cleanup
        fs.unlinkSync(filePath);

    } catch (e) {
        console.error('Finalize Invoice Error:', e);
        await msg.reply('❌ Fehler bei der Rechnungsstellung: ' + e.message);
    }
}

function parseInvoiceText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const data = { gName: '', gAdresse: '', arrival: '', departure: '' };

    // Heuristics
    // 1. Look for Name (First line if it doesn't contain "Rechnung")
    if (lines[0] && !lines[0].toLowerCase().includes('rechnung')) {
        data.gName = lines[0];
    } else if (lines[1]) {
        data.gName = lines[1];
    }

    // 2. Look for Date range (Regex)
    const dateRegex = /(\d{1,2}\.\d{1,2}\.?\s*(?:-\s*\d{1,2}\.\d{1,2}\.?)?\s*\d{0,4})/g;
    const fullText = text.replace(/\n/g, ' ');
    const dates = parseDates(fullText);
    data.arrival = dates.arrival;
    data.departure = dates.departure;

    // 3. Look for Address (Everything else)
    const addressLines = lines.filter(l =>
        l !== data.gName &&
        !l.toLowerCase().includes('rechnung') &&
        !l.match(/\d{1,2}\.\d{1,2}\./)
    );
    data.gAdresse = addressLines.join('\n');

    return data;
}

function parseDates(text) {
    const dateRangeRegex = /(\d{1,2})\.(\d{1,2})\.?\s*(?:-\s*)?(\d{1,2})\.(\d{1,2})\.?(?:\s*(\d{2,4}))?/;
    const match = text.match(dateRangeRegex);
    if (match) {
        let [_, d1, m1, d2, m2, y] = match;
        const currentYear = new Date().getFullYear();
        const year = y ? (y.length === 2 ? '20' + y : y) : currentYear;

        const arrival = `${year}-${m1.padStart(2, '0')}-${d1.padStart(2, '0')}`;
        const departure = `${year}-${m2.padStart(2, '0')}-${d2.padStart(2, '0')}`;
        return { arrival, departure };
    }
    return { arrival: null, departure: null };
}

function calcNights(anreise, abreise) {
    if (!anreise || !abreise) return 0;
    const start = new Date(anreise);
    const end = new Date(abreise);
    const diff = end - start;
    return Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

async function handleStatusCommand(msg) {
    const open = db.getOpenInvoices();
    if (open.length === 0) {
        return msg.reply('Aktuell keine offenen Rechnungen. ✅');
    }
    let text = '*Offene Rechnungen:*\n\n';
    open.forEach(inv => {
        text += `• ${inv.invoice_number} - ${inv.guest_display_name}: ${inv.total_amount.toFixed(2)}€\n`;
    });
    await msg.reply(text);
}

async function handleHelpCommand(msg) {
    const text = `*WhatsApp Buchungs-Assistent* 🏠\n\n` +
        `*Befehle:*\n` +
        `• *Rechnung* - Erstellt eine neue Rechnung. Sende einfach Name, Adresse und Zeitraum.\n` +
        `• *Status* - Zeigt alle unbezahlten Rechnungen an.\n` +
        `• *Hilfe* - Zeigt diese Übersicht.\n\n` +
        `*Beispiel:*\n` +
        `Max Mustermann\nMusterweg 1, 12345 Berlin\n15.03. - 20.03.`;
    await msg.reply(text);
}

module.exports = { processMessage };
