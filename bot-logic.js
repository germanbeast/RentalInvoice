const db = require('./db');
const { renderInvoiceHtml } = require('./invoice-template');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

/**
 * Shared logic for both WhatsApp and Telegram bots.
 */

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

function parseInvoiceText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const data = { gName: '', gAdresse: '', arrival: '', departure: '' };

    if (lines.length === 0) return data;

    // Heuristics
    if (lines[0] && !lines[0].toLowerCase().includes('rechnung')) {
        data.gName = lines[0];
    } else if (lines[1]) {
        data.gName = lines[1];
    }

    const fullText = text.replace(/\n/g, ' ');
    const dates = parseDates(fullText);
    data.arrival = dates.arrival;
    data.departure = dates.departure;

    const addressLines = lines.filter(l =>
        l !== data.gName &&
        !l.toLowerCase().includes('rechnung') &&
        !l.match(/\d{1,2}\.\d{1,2}\./)
    );
    data.gAdresse = addressLines.join('\n');

    return data;
}

async function getStatusText() {
    const open = db.getOpenInvoices();
    if (open.length === 0) {
        return 'Aktuell keine offenen Rechnungen. ✅';
    }
    let text = '*Offene Rechnungen:*\n\n';
    open.forEach(inv => {
        text += `• ${inv.invoice_number} - ${inv.guest_display_name}: ${inv.total_amount.toFixed(2)}€\n`;
    });
    return text;
}

async function finalizeInvoiceData(data) {
    const allSettings = db.getAllSettings();
    const vermieter = allSettings.vermieter || {};
    const bank = allSettings.bank || {};
    const pricing = allSettings.pricing || { price_per_night: 85, cleaning_fee: 50, mwst_rate: 7, kleinunternehmer: false };

    const nights = calcNights(data.arrival, data.departure);

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

    // Nuki Logic
    const existingBooking = db.findBookingForStay(data.gName, data.arrival, data.departure);
    if (existingBooking && existingBooking.nuki_pin) {
        invoiceData.nukiPin = existingBooking.nuki_pin;
    } else {
        try {
            // Internal call to server.js endpoint (relative would be better but let's stick to current pattern)
            const nukiRes = await axios.post(`http://localhost:${process.env.PORT || 3000}/api/nuki/create-pin`, {
                arrival: data.arrival,
                departure: data.departure,
                guestName: data.gName
            });
            if (nukiRes.data.success) {
                invoiceData.nukiPin = nukiRes.data.pin;
                if (existingBooking) {
                    db.updateBookingNukiData(existingBooking.id, nukiRes.data.pin, nukiRes.data.authId);
                }
            }
        } catch (e) {
            console.error('Nuki PIN failed in Bot flow:', e.message);
        }
    }

    return invoiceData;
}

async function generateInvoicePdf(invoiceData) {
    const html = renderInvoiceHtml(invoiceData);
    const pdfRes = await axios.post(`http://localhost:${process.env.PORT || 3000}/api/generate-pdf`, { html }, { responseType: 'arraybuffer' });

    const fileName = `Rechnung_${invoiceData.rNummer}.pdf`;
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, pdfRes.data);

    return { filePath, fileName };
}

module.exports = {
    parseDates,
    calcNights,
    parseInvoiceText,
    getStatusText,
    finalizeInvoiceData,
    generateInvoicePdf
};
