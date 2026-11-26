'use strict';

/**
 * Belegerkennung: liest Betrag, Datum, Händler, MwSt und Kategorie aus einem Foto oder PDF eines Kassenbons / einer Rechnung.
 *
 * Zwei Wege:
 *  - "ocr" (Standard, kostenlos): Texterkennung auf dem eigenen Server (tesseract.js, wie bei den Anschrift-Screenshots),
 *    PDFs mit Text werden direkt ausgelesen (pdf-parse), eingescannte PDFs als Bild der ersten Seite erkannt.
 *    Danach Regeln: "Summe/Gesamt/zu zahlen" -> Betrag, erstes Datum -> Datum, bekannte Händler -> Kategorie.
 *  - "ki" (optional): Bild/PDF geht an die Claude API (Anthropic), die die Felder als JSON zurückgibt. Braucht einen
 *    API-Schlüssel unter Einstellungen → Belege & KI. Fällt die KI aus, wird automatisch die Texterkennung benutzt.
 *
 * Das Ergebnis ist immer nur ein Vorschlag: der Nutzer bestätigt oder ändert es im Telegram-Bot bzw. in der Admin-Seite.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Kategorien für eine Ferienwohnung (Reihenfolge = Anzeige im Bot / in der Admin-Seite)
const CATEGORIES = [
    'Reinigung & Wäsche',
    'Verbrauchsmaterial',
    'Reparatur & Instandhaltung',
    'Einrichtung & Ausstattung',
    'Strom, Wasser & Heizung',
    'Internet & Telefon',
    'Versicherung',
    'Provisionen & Gebühren',
    'Software & Abos',
    'Werbung & Marketing',
    'Fahrtkosten',
    'Büro & Porto',
    'Steuern & Abgaben',
    'Sonstiges'
];

// Händler -> Kategorie (Kleinschreibung, Teilwort reicht)
const VENDOR_HINTS = [
    [/\b(obi|bauhaus|hornbach|toom|hagebau|globus baumarkt|baumarkt|hellweg|bauking|würth|wuerth|raiffeisen|sanit|elektro|handwerk|installateur|maler|schlüsseldienst|schluesseldienst)\b/i, 'Reparatur & Instandhaltung'],
    [/\b(ikea|jysk|poco|xxxlutz|höffner|hoeffner|roller|möbel|moebel|depot|home ?24|westwing|otto|mediamarkt|media markt|saturn|expert|euronics)\b/i, 'Einrichtung & Ausstattung'],
    [/\b(rewe|edeka|lidl|aldi|netto|penny|kaufland|norma|real|globus|marktkauf|tegut|hit|famila|dm|rossmann|müller|mueller|budni|action|tedi|kik|metro|selgros|nah ?& ?gut)\b/i, 'Verbrauchsmaterial'],
    [/\b(wäscherei|waescherei|wäscheservice|textilreinigung|reinigung|putzfrau|reinigungsservice|cleaning|laundry|wäsche|waesche)\b/i, 'Reinigung & Wäsche'],
    [/\b(stadtwerke|eon|e\.on|vattenfall|enbw|rwe|eprimo|yello|naturstrom|lichtblick|strom|gas|wasserwerk|wasser|abwasser|heizöl|heizoel|fernwärme|fernwaerme|müllabfuhr|abfall)\b/i, 'Strom, Wasser & Heizung'],
    [/\b(telekom|vodafone|o2|telefonica|1&1|1und1|congstar|pyur|unitymedia|netcologne|m-net|ewe tel|internet|dsl)\b/i, 'Internet & Telefon'],
    [/\b(versicherung|allianz|huk|ergo|axa|generali|r\+v|devk|provinzial|gothaer|signal iduna|zurich|haftpflicht)\b/i, 'Versicherung'],
    [/\b(booking\.com|booking b\.v|airbnb|expedia|fewo-direkt|fewo direkt|vrbo|holidu|traum-ferienwohnungen|tripadvisor|kommission|provision|stripe|paypal gebühr)\b/i, 'Provisionen & Gebühren'],
    [/\b(smoobu|lodgify|netflix|spotify|disney|google workspace|microsoft|adobe|apple|icloud|dropbox|hetzner|netcup|ovh|strato|ionos|cloudflare|github|abo|subscription)\b/i, 'Software & Abos'],
    [/\b(shell|aral|esso|jet|total|totalenergies|avia|agip|eni|star tankstelle|tankstelle|db fernverkehr|deutsche bahn|bahn|parkhaus|parken|apcoa|contipark|flixbus|taxi|uber)\b/i, 'Fahrtkosten'],
    [/\b(deutsche post|dhl|hermes|dpd|gls|ups|porto|briefmarke|staples|mcpaper|office)\b/i, 'Büro & Porto'],
    [/\b(finanzamt|kurtaxe|tourismusabgabe|gemeinde|stadtkasse|grundsteuer|rundfunk|gez|ard zdf)\b/i, 'Steuern & Abgaben'],
    [/\b(google ads|facebook|meta platforms|instagram|vistaprint|flyer|werbung|anzeige)\b/i, 'Werbung & Marketing']
];

// Bekannte Ketten in schöner Schreibweise (für den Händlernamen aus dem OCR-Text)
const KNOWN_VENDORS = ['REWE', 'EDEKA', 'Lidl', 'ALDI SÜD', 'ALDI Nord', 'ALDI', 'Netto', 'Penny', 'Kaufland', 'Norma', 'Globus', 'Marktkauf', 'tegut',
    'dm-drogerie markt', 'dm', 'Rossmann', 'Müller', 'Action', 'TEDi', 'OBI', 'BAUHAUS', 'HORNBACH', 'toom', 'hagebau', 'Hellweg', 'IKEA', 'JYSK',
    'POCO', 'XXXLutz', 'MediaMarkt', 'Saturn', 'Amazon', 'Shell', 'Aral', 'Esso', 'JET', 'TotalEnergies', 'Deutsche Post', 'DHL', 'Telekom',
    'Vodafone', 'Booking.com', 'Airbnb', 'Metro', 'Selgros'];

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

/** Kategorie aus Händler/Text; das erste Argument (meist der Händler) hat Vorrang vor den weiteren. */
function guessCategory(...texts) {
    for (const t of texts.filter(Boolean)) {
        for (const [re, cat] of VENDOR_HINTS) if (re.test(t)) return cat;
    }
    return null;
}

/** "1.234,56" / "1234.56" / "12,5" -> Zahl (oder null) */
function parseAmount(s) {
    let t = String(s || '').replace(/[€\s]|EUR/gi, '').replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, '0');
    if (!/\d/.test(t)) return null;
    t = t.replace(/^[+-]/, '');
    if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(t)) t = t.replace(/,/g, '');
    else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
    else if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    const n = parseFloat(t);
    return Number.isFinite(n) ? r2(n) : null;
}

const AMOUNT_RE = /(?:^|[^\d.,])(\d{1,3}(?:[.\s]\d{3})*,\d{2}|\d+,\d{2}|\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})(?![\d])/g;

function amountsIn(line) {
    const out = [];
    let m;
    AMOUNT_RE.lastIndex = 0;
    while ((m = AMOUNT_RE.exec(line))) {
        const n = parseAmount(m[1].replace(/\s/g, '.'));
        if (n !== null && n > 0 && n < 100000) out.push(n);
    }
    return out;
}

const MONTHS_DE = { jan: 1, januar: 1, feb: 2, februar: 2, mär: 3, maer: 3, märz: 3, mrz: 3, mar: 3, apr: 4, april: 4, mai: 5, may: 5, jun: 6, juni: 6, jul: 7, juli: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, okt: 10, oct: 10, oktober: 10, nov: 11, november: 11, dez: 12, dec: 12, dezember: 12 };

function ymd(y, m, d) {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function todayYmd() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}

/** Alle Datumsangaben im Text (in Reihenfolge), nur plausible (nicht in der Zukunft, nicht älter als 3 Jahre). */
function datesIn(text) {
    const out = [];
    const today = todayYmd();
    const minYmd = `${parseInt(today.slice(0, 4), 10) - 3}${today.slice(4)}`;
    const push = (d) => { if (d && d <= today && d >= minYmd) out.push(d); };
    const re = /(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4}|\d{2})(?!\d)|(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\.?\s+([A-Za-zäÄ]{3,9})\.?\s+(\d{4})/g;
    let m;
    while ((m = re.exec(text))) {
        if (m[1]) push(ymd(parseInt(m[3], 10), parseInt(m[2], 10), parseInt(m[1], 10)));
        else if (m[4]) push(ymd(parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10)));
        else if (m[7]) {
            const mon = MONTHS_DE[m[8].toLowerCase()];
            if (mon) push(ymd(parseInt(m[9], 10), mon, parseInt(m[7], 10)));
        }
    }
    return out;
}

const TOTAL_WORDS = /(zu\s*zahlen|gesamtbetrag|endbetrag|rechnungsbetrag|gesamtsumme|bruttobetrag|gesamt\s*brutto|summe\s*brutto|brutto\s*summe|summe|gesamt|total|betrag\s*eur|amount\s*due|zahlbetrag|bar\b|ec[- ]?karte|girocard|kartenzahlung|visa|mastercard)/i;
const STRONG_TOTAL = /(zu\s*zahlen|gesamtbetrag|endbetrag|rechnungsbetrag|gesamtsumme|zahlbetrag|amount\s*due|summe\s*(eur|€)?\s*[\d]|^\s*summe\b|^\s*gesamt\b|^\s*total\b)/i;
const NOT_TOTAL = /(zwischensumme|netto(?!.*brutto)|mwst|ust\b|umsatzsteuer|steuer|rückgeld|rueckgeld|zurück|gegeben|bonus|punkte|rabatt|pfand|payback|ersparnis|gespart)/i;

/** Der wahrscheinliche Endbetrag. */
function findTotal(lines) {
    const cands = [];
    lines.forEach((line, i) => {
        if (!TOTAL_WORDS.test(line) || NOT_TOTAL.test(line)) return;
        let nums = amountsIn(line);
        // "Summe" in einer Zeile, Betrag in der nächsten
        if (!nums.length && lines[i + 1]) nums = amountsIn(lines[i + 1]);
        if (!nums.length) return;
        const strong = STRONG_TOTAL.test(line);
        cands.push({ amount: nums[nums.length - 1], score: (strong ? 3 : 1) + i / lines.length });
    });
    if (cands.length) {
        cands.sort((a, b) => b.score - a.score || b.amount - a.amount);
        // Stärkster Kandidat; bei gleichwertigen der größte (Summe vor Teilbeträgen)
        const top = cands.filter(c => Math.floor(c.score) === Math.floor(cands[0].score));
        return Math.max(...top.map(c => c.amount));
    }
    // Ohne Schlüsselwort: größter Betrag mit Euro-Zeichen, sonst größter Betrag überhaupt
    const euro = lines.filter(l => /€|eur\b/i.test(l) && !NOT_TOTAL.test(l)).flatMap(amountsIn);
    if (euro.length) return Math.max(...euro);
    const all = lines.filter(l => !NOT_TOTAL.test(l)).flatMap(amountsIn);
    return all.length ? Math.max(...all) : null;
}

function findVat(lines, total) {
    let rate = null, amount = null;
    const vatLines = [];
    lines.forEach((l, i) => {
        if (!/(mwst|ust\b|umsatzsteuer|mehrwertsteuer|vat|tax)/i.test(l)) return;
        vatLines.push(l);
        // Tabellenkopf "MwSt % Netto MwSt Brutto": die Werte stehen in den Zeilen darunter
        if (!amountsIn(l).length) vatLines.push(...lines.slice(i + 1, i + 3).filter(x => /\d+\s*%/.test(x)));
    });
    for (const l of vatLines) {
        const rm = l.match(/(19|7|16|5|0)[,.]?0{0,2}\s*%/);
        if (rm && rate === null) rate = parseInt(rm[1], 10);
        const nums = amountsIn(l).filter(n => !total || n < total);
        if (nums.length && amount === null) {
            // In "MwSt 19% 15,97 3,03 19,00" ist der kleinste Betrag meist die Steuer
            amount = Math.min(...nums);
        }
    }
    if (amount === null && rate && total) amount = r2(total - total / (1 + rate / 100));
    if (amount !== null && total && amount >= total) amount = null;
    return { vat_rate: rate, vat_amount: amount };
}

function findVendor(lines) {
    const head = lines.slice(0, 8).join('\n');
    for (const v of KNOWN_VENDORS) {
        const re = new RegExp(`(^|[^a-zäöü])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s/g, '\\s*')}([^a-zäöü]|$)`, 'i');
        if (re.test(head)) return v;
    }
    const whole = lines.join('\n');
    for (const v of KNOWN_VENDORS) {
        if (v.length < 4) continue;
        const re = new RegExp(`(^|[^a-zäöü])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-zäöü]|$)`, 'i');
        if (re.test(whole)) return v;
    }
    // Erste Zeile mit genug Buchstaben, die nicht wie Adresse/Telefon/Datum aussieht
    for (const l of lines.slice(0, 6)) {
        const t = l.replace(/[^\p{L}\d&.\-' ]/gu, ' ').replace(/\s+/g, ' ').trim();
        if (t.length < 3 || (t.match(/\p{L}/gu) || []).length < 3) continue;
        if (/(str\.|straße|strasse|weg\b|platz\b|tel|fax|www\.|http|@|\d{5}|uhr|datum|beleg|kasse|bon\b|rechnung|quittung|kassenbon|filiale|willkommen|vielen dank|danke)/i.test(t)) continue;
        return t.slice(0, 60);
    }
    return null;
}

function findPayment(text) {
    if (/(ec[- ]?karte|girocard|maestro|v ?pay)/i.test(text)) return 'EC-Karte';
    if (/(visa|mastercard|kreditkarte|american express|amex)/i.test(text)) return 'Kreditkarte';
    if (/paypal/i.test(text)) return 'PayPal';
    if (/(überweisung|ueberweisung|iban|zahlbar bis|zahlungsziel)/i.test(text)) return 'Überweisung';
    if (/(lastschrift|sepa-?mandat|abgebucht)/i.test(text)) return 'Lastschrift';
    if (/(\bbar\b|bargeld|gegeben|rückgeld|rueckgeld)/i.test(text)) return 'Bar';
    return null;
}

/** Text eines Belegs -> Vorschlag. */
function parseReceiptText(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const amount = findTotal(lines);
    const dates = datesIn(lines.join('\n'));
    const vendor = findVendor(lines);
    const vat = findVat(lines, amount);
    const category = guessCategory(vendor, lines.slice(0, 12).join('\n')) || guessCategory(lines.join('\n'));
    const invNo = (lines.join('\n').match(/(?:rechnungs?[\s-]*(?:nr|nummer)|beleg[\s-]*nr|bon[\s-]*nr|invoice\s*(?:no|number|#))\.?\s*:?\s*([A-Z0-9][\w\-\/]{2,30})/i) || [])[1] || null;
    return {
        vendor,
        date: dates[0] || null,
        amount,
        currency: 'EUR',
        vat_rate: vat.vat_rate,
        vat_amount: vat.vat_amount,
        category: category || null,
        payment_method: findPayment(lines.join('\n')),
        invoice_number: invNo,
        description: null,
        is_receipt: looksLikeReceipt(text)
    };
}

/** Grobe Einschätzung: ist das ein Kassenbon/eine Rechnung (und keine Anschrift/kein Booking-Screenshot)? */
function looksLikeReceipt(text) {
    const t = String(text || '');
    let score = 0;
    if (/(summe|gesamt|zu zahlen|endbetrag|total|rechnungsbetrag)/i.test(t)) score += 2;
    if (/(mwst|ust\b|umsatzsteuer|mehrwertsteuer|netto|brutto)/i.test(t)) score += 2;
    if (/(kassenbon|quittung|beleg|bon-?nr|kasse\b|rechnung(?!sadresse)|invoice|receipt)/i.test(t)) score += 1;
    if (/(ec[- ]?karte|girocard|visa|mastercard|bar\b|rückgeld|gegeben|tse|terminal|trace-?nr)/i.test(t)) score += 1;
    if ((t.match(/\d+[,.]\d{2}\s*(€|eur|[AB]\b)?/gi) || []).length >= 3) score += 1;
    // Booking.com-/Airbnb-Gastdaten sehen anders aus
    if (/(gast kontaktieren|check-?in|check-?out|anreise|abreise|erwachsene|reservierungsnummer|buchungsnummer)/i.test(t)) score -= 2;
    return score >= 3;
}

// ---------------------------------------------------------------------------
// Texterkennung (lokal)
// ---------------------------------------------------------------------------
async function pdfText(filePath) {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: fs.readFileSync(filePath) });
    try {
        const r = await parser.getText({ first: 3 });
        return String(r.text || '').replace(/--\s*\d+\s*of\s*\d+\s*--/g, '').trim();
    } finally {
        await parser.destroy().catch(() => { });
    }
}

/** Erste Seite eines eingescannten PDFs als PNG (für die Texterkennung). */
async function pdfFirstPageImage(filePath, outDir) {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: fs.readFileSync(filePath) });
    try {
        const r = await parser.getScreenshot({ first: 1, scale: 2.5, imageBuffer: true, imageDataUrl: false });
        const page = r.pages && r.pages[0];
        if (!page || !page.data) return null;
        const out = path.join(outDir, 'page1.png');
        fs.writeFileSync(out, Buffer.from(page.data));
        return out;
    } finally {
        await parser.destroy().catch(() => { });
    }
}

const isPdf = (mime, file) => /pdf/i.test(mime || '') || /\.pdf$/i.test(file || '');

/** Text eines Belegs (Bild oder PDF) auf dem eigenen Server. */
async function extractText(filePath, mime) {
    const ocr = require('./screenshot-ocr');
    if (isPdf(mime, filePath)) {
        const t = await pdfText(filePath).catch(e => { console.warn('[Beleg] PDF-Text:', e.message); return ''; });
        if (t.replace(/\s/g, '').length >= 30) return { text: t, source: 'pdf' };
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beleg-pdf-'));
        try {
            const img = await pdfFirstPageImage(filePath, tmp);
            if (!img) return { text: t, source: 'pdf' };
            const r = await ocr.recognize(img);
            return { text: r.raw || r.text, source: 'pdf-ocr' };
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }
    const r = await ocr.recognize(filePath);
    return { text: r.raw || r.text, source: 'ocr' };
}

// ---------------------------------------------------------------------------
// KI (Claude API)
// ---------------------------------------------------------------------------
const AI_MODELS = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (genaueste)' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (schnell, günstiger)' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (am günstigsten)' }
];
const DEFAULT_MODEL = 'claude-opus-5-5';

const RESULT_SCHEMA = {
    type: 'object',
    properties: {
        is_receipt: { type: 'boolean', description: 'true, wenn das Dokument ein Kassenbon, eine Quittung oder eine Rechnung über eine Ausgabe ist' },
        vendor: { type: ['string', 'null'], description: 'Händler oder Firma, die den Beleg ausgestellt hat, kurz (z. B. "OBI", "Stadtwerke Bremen")' },
        date: { type: ['string', 'null'], description: 'Belegdatum als YYYY-MM-DD' },
        amount: { type: ['number', 'null'], description: 'Bezahlter Endbetrag brutto in der Belegwährung' },
        currency: { type: 'string', description: 'ISO-Währung, meist EUR' },
        vat_rate: { type: ['number', 'null'], description: 'Hauptsteuersatz in Prozent (19, 7 oder 0), null wenn nicht erkennbar' },
        vat_amount: { type: ['number', 'null'], description: 'Enthaltene Umsatzsteuer gesamt' },
        category: { type: 'string', enum: CATEGORIES, description: 'Passende Ausgaben-Kategorie' },
        description: { type: ['string', 'null'], description: 'Was gekauft wurde, kurz auf Deutsch (max. 60 Zeichen), z. B. "Putzmittel und Müllbeutel"' },
        payment_method: { type: ['string', 'null'], description: 'Zahlart: Bar, EC-Karte, Kreditkarte, PayPal, Überweisung oder Lastschrift; null wenn nicht erkennbar' },
        invoice_number: { type: ['string', 'null'], description: 'Rechnungs- oder Belegnummer, falls vorhanden' }
    },
    required: ['is_receipt', 'vendor', 'date', 'amount', 'currency', 'vat_rate', 'vat_amount', 'category', 'description', 'payment_method', 'invoice_number'],
    additionalProperties: false
};

const SYSTEM_PROMPT = 'Du liest Belege (Kassenbons, Quittungen, Rechnungen) für die Buchhaltung einer Ferienwohnung in Deutschland aus. ' +
    'Gib nur Werte zurück, die auf dem Beleg stehen oder sich eindeutig daraus ergeben; was nicht erkennbar ist, ist null. ' +
    'Der Betrag ist der tatsächlich bezahlte Endbetrag (brutto), nicht Zwischensumme, Netto, Rückgeld oder gegebenes Bargeld. ' +
    'Wähle die Kategorie aus der Liste, die für eine Ferienwohnung am besten passt (Lebensmittel, Putzmittel, Toilettenpapier, Kaffee für Gäste = Verbrauchsmaterial).';

const IMG_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

async function scanWithAi(filePath, mime, ai, ocrText) {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ai.apiKey, maxRetries: 2, timeout: 120000 });
    const data = fs.readFileSync(filePath).toString('base64');
    let block;
    if (isPdf(mime, filePath)) {
        block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
    } else {
        const media = IMG_TYPES[path.extname(filePath).toLowerCase()] || (/^image\/(jpeg|png|webp|gif)$/i.test(mime || '') ? mime.toLowerCase() : null);
        if (!media) throw new Error('Bildformat wird von der KI nicht unterstützt');
        block = { type: 'image', source: { type: 'base64', media_type: media, data } };
    }
    const model = AI_MODELS.some(m => m.id === ai.model) ? ai.model : DEFAULT_MODEL;
    const params = {
        model,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: RESULT_SCHEMA } },
        messages: [{
            role: 'user',
            content: [block, { type: 'text', text: `Lies diesen Beleg aus. Heute ist der ${todayYmd()}.` + (ocrText ? `\n\nZur Hilfe der von der Texterkennung gelesene Text (kann Fehler enthalten):\n${String(ocrText).slice(0, 4000)}` : '') }]
        }]
    };
    let msg;
    if (model === 'claude-haiku-5-5') {
        msg = await client.messages.create(params);
    } else {
        // Lehnt das Modell ab, springt der Server automatisch auf ein passendes Ersatzmodell um
        msg = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    }
    if (msg.stop_reason === 'refusal') throw new Error('Die KI hat den Beleg nicht ausgelesen');
    const textBlock = (msg.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('Keine Antwort der KI');
    const r = JSON.parse(textBlock.text);
    return {
        vendor: r.vendor ? String(r.vendor).slice(0, 80) : null,
        date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : null,
        amount: Number.isFinite(r.amount) ? r2(r.amount) : null,
        currency: r.currency || 'EUR',
        vat_rate: Number.isFinite(r.vat_rate) ? r.vat_rate : null,
        vat_amount: Number.isFinite(r.vat_amount) ? r2(r.vat_amount) : null,
        category: CATEGORIES.includes(r.category) ? r.category : null,
        description: r.description ? String(r.description).slice(0, 120) : null,
        payment_method: r.payment_method || null,
        invoice_number: r.invoice_number || null,
        is_receipt: r.is_receipt !== false,
        model: msg.model || model
    };
}

/**
 * Beleg auslesen.
 * @param {string} filePath
 * @param {string} mime
 * @param {{ ai?: { enabled, apiKey, model }, text?: string }} opts  text = schon erkannter OCR-Text (spart einen Durchlauf)
 * @returns {Promise<{ result, text, engine: 'ki'|'ocr', aiError?: string }>}
 */
async function scan(filePath, mime, opts = {}) {
    let text = opts.text || '';
    const ai = opts.ai || {};
    if (!text) {
        try { text = (await extractText(filePath, mime)).text; } catch (e) { console.warn('[Beleg] Texterkennung:', e.message); }
    }
    const local = parseReceiptText(text);
    if (ai.enabled && ai.apiKey) {
        try {
            const r = await scanWithAi(filePath, mime, ai, text);
            // Was die KI nicht findet, darf die Texterkennung ergänzen
            for (const k of Object.keys(local)) if ((r[k] === null || r[k] === undefined) && local[k] !== null) r[k] = local[k];
            return { result: r, text, engine: 'ki' };
        } catch (e) {
            const status = e && e.status ? ` (HTTP ${e.status})` : '';
            console.warn('[Beleg] KI-Erkennung fehlgeschlagen, nehme Texterkennung:', e.message);
            return { result: local, text, engine: 'ocr', aiError: `${e.message || e}${status}`.slice(0, 200) };
        }
    }
    return { result: local, text, engine: 'ocr' };
}

/** Kurzer Test der KI-Verbindung mit dem API-Schlüssel. */
async function testAi(ai) {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ai.apiKey, maxRetries: 0, timeout: 30000 });
    const model = AI_MODELS.some(m => m.id === ai.model) ? ai.model : DEFAULT_MODEL;
    const m = await client.models.retrieve(model);
    return { model: m.id, name: m.display_name || m.id };
}

module.exports = {
    CATEGORIES, AI_MODELS, DEFAULT_MODEL,
    scan, extractText, parseReceiptText, looksLikeReceipt, guessCategory, parseAmount, testAi, isPdf,
    _internal: { findTotal, datesIn, findVendor, findVat }
};
