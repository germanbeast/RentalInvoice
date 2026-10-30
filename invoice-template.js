const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * Renders an invoice exactly like the admin app: the markup is the #invoice-page block from
 * public/index.html, the styles are public/styles.css plus the saved invoice template
 * (Rechnungs-Template), and it is filled the same way as updatePreview() in public/app.js.
 * @param {Object} data Invoice data (guest, dates, positions, branding with template_config, etc.)
 * @returns {string} Full HTML string
 */
function renderInvoiceHtml(data) {
    const styles = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    const page = invoicePageMarkup(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'));
    const tpl = templateConfig(data.branding);

    const fill = {
        vName: data.vName, vAdresse: data.vAdresse, vTelefon: data.vTelefon, vEmail: data.vEmail, vSteuernr: data.vSteuernr,
        gName: data.gName, gAdresse: data.gAdresse,
        rNummer: data.rNummer, rDatum: data.rDatum, aAnreise: data.aAnreise, aAbreise: data.aAbreise,
        mwstSatz: data.mwstSatz, kleinunternehmer: !!data.kleinunternehmer,
        zBezahlt: !!data.zBezahlt, zMethode: data.zMethode || '', zDatum: data.zDatum || '', zShowBank: !!data.zShowBank,
        bInhaber: data.bInhaber, bIban: data.bIban, bBic: data.bBic, bBank: data.bBank,
        nukiPin: data.nukiPin || '',
        positions: data.positions || [],
        // Company invoice made by the guest: greet the person, not the company
        greetingName: (data.guestInvoice && data.guestInvoice.company && data.guestInvoice.name) || '',
        greeting: tpl.greeting, introText: tpl.introText
    };
    // JSON inside <script>: "</script>" or "<!--" in a name must not break out
    const json = JSON.stringify(fill).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Hanken+Grotesk:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
${styles}
        body { background: white !important; margin: 0; padding: 0; }
        .invoice-page { transform: none !important; box-shadow: none !important; border-radius: 0 !important; margin: 0 !important; }
        /* PDF only: Rechnungs-Nr., Datum und Aufenthalt must be on the invoice (§ 14 UStG); the admin preview hides them.
           Slightly tighter spacing so a normal invoice fits on one A4 page. */
        .inv-header { margin-bottom: 10mm; }
        .inv-recipient { margin-bottom: 2mm; }
        .inv-recipient-address { margin-bottom: 5mm; }
        .inv-intro-text { margin-bottom: 4mm; }
        .inv-meta { display: flex; justify-content: space-between; gap: 6mm; text-align: left; margin-bottom: 6mm; padding: 3mm 4mm; background: #f8fafc; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .inv-meta-item { display: block; font-size: 9pt; }
        .inv-meta .inv-label { display: block; font-size: 7pt; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 1mm; }
        .inv-title { margin-bottom: 6mm; }
        .inv-summary { margin-top: 4mm; margin-bottom: 8mm; }
        .inv-payment-status { margin-bottom: .5rem; }
        .inv-footer { margin-top: 4mm; }
        .inv-payment { margin-top: 3mm; }
        .inv-paid-badge.unpaid { border-color: #d97706 !important; background: #fffbeb !important; color: #b45309 !important; }
        .inv-paid-badge.unpaid svg { display: none; }
        /* Never cut anything off: a very long invoice continues on a second page */
        @media print { .invoice-page { padding: 12mm 20mm !important; height: auto !important; max-height: none !important; min-height: 296mm !important; overflow: visible !important; page-break-inside: auto !important; } }
    </style>
    <style>${templateStyles(tpl)}</style>
</head>
<body>
${page}
<script>(${fillInvoice.toString()})(${json});</script>
</body>
</html>`;
}

/** The <div class="invoice-page" id="invoice-page"> … </div> block of the admin page. */
function invoicePageMarkup(html) {
    const start = html.indexOf('<div class="invoice-page" id="invoice-page">');
    if (start < 0) throw new Error('Rechnungs-Layout in public/index.html nicht gefunden');
    const tag = /<\/?div\b[^>]*>/g;
    tag.lastIndex = start;
    let depth = 0;
    let m;
    while ((m = tag.exec(html))) {
        depth += m[0][1] === '/' ? -1 : 1;
        if (depth === 0) return html.slice(start, tag.lastIndex);
    }
    throw new Error('Rechnungs-Layout in public/index.html ist unvollständig');
}

// Same defaults as defaultTemplateConfig in public/app.js
const DEFAULT_TEMPLATE = {
    logoText: 'Ferienwohnung Beckhome',
    logoImage: null,
    greeting: 'SEHR GEEHRTE/R',
    introText: 'Ich bedanke mich herzlich für die Zusammenarbeit und Ihr entgegengebrachtes Vertrauen. Anbei die Rechnung für das gemeinsame Projekt:',
    colorPrimary: '#0f172a',
    colorTableBg: '#f5f1e8',
    colorTableHeader: '#e8e1d0',
    colorText: '#2d2721',
    fontLogo: 'Georgia, serif',
    fontBody: "'Inter', sans-serif",
    showLogo: true,
    showTax: true,
    showDateHeader: true,
    showFoldMarks: false
};

function templateConfig(branding) {
    const saved = branding && branding.template_config && typeof branding.template_config === 'object' ? branding.template_config : {};
    return { ...DEFAULT_TEMPLATE, ...saved };
}

/** Same CSS as applyTemplateStyles() in public/app.js. */
function templateStyles(c) {
    const css = v => String(v == null ? '' : v).replace(/[<>{};\\]/g, '');
    const logo = c.logoImage && /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/.test(c.logoImage)
        ? `content: ''; background-image: url(${c.logoImage}); background-size: contain; background-repeat: no-repeat; width: 150px; height: 60px;`
        : `content: '${css(c.logoText || 'Ferienwohnung Beckhome').replace(/'/g, "\\'")}'; font-family: ${css(c.fontLogo) || 'Georgia, serif'};`;
    return `
        .invoice-page { font-family: ${css(c.fontBody) || "'Inter', sans-serif"} !important; color: ${css(c.colorText) || '#2d2721'} !important; }
        .inv-sender::before { ${logo} display: ${c.showLogo ? 'block' : 'none'} !important; }
        .inv-location-date #inv-location { display: ${c.showDateHeader ? 'block' : 'none'} !important; }
        .inv-location-date #inv-r-datum-header { display: ${c.showDateHeader ? 'block' : 'none'} !important; }
        .inv-tax { display: ${c.showTax ? 'block' : 'none'} !important; }
        .inv-title { color: ${css(c.colorPrimary) || '#0f172a'} !important; }
        .inv-table { background: ${css(c.colorTableBg) || '#f5f1e8'} !important; }
        .inv-table thead { background: ${css(c.colorTableHeader) || '#e8e1d0'} !important; }
        .inv-table td { background: ${css(c.colorTableBg) || '#f5f1e8'} !important; color: ${css(c.colorText) || '#2d2721'} !important; }
        .inv-table th { color: ${css(c.colorText) || '#2d2721'} !important; }
        .inv-payment { background: ${css(c.colorTableBg) || '#f5f1e8'} !important; border-top-color: ${css(c.colorTableHeader) || '#e8e1d0'} !important; }
        .inv-summary-total { color: ${css(c.colorPrimary) || '#0f172a'} !important; }
        .inv-markers { display: ${c.showFoldMarks ? 'block' : 'none'} !important; }
    `;
}

/** Runs in the PDF browser: fills the invoice like updatePreview() in public/app.js. */
function fillInvoice(d) {
    const $ = s => document.querySelector(s);
    const text = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    const lines = (sel, v) => {
        const el = $(sel);
        if (!el) return;
        el.textContent = '';
        String(v || '').split('\n').forEach((line, i) => {
            if (i) el.appendChild(document.createElement('br'));
            el.appendChild(document.createTextNode(line));
        });
    };
    const show = (sel, display) => { const el = $(sel); if (el) el.style.display = display; };
    const formatDate = s => s ? new Date(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
    const formatCurrency = v => Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    const nightsOf = (a, b) => a && b ? Math.max(0, Math.ceil((new Date(b) - new Date(a)) / 86400000)) : 0;

    // Vermieter
    text('#inv-v-name', d.vName || 'Vermieter Name');
    lines('#inv-v-adresse', d.vAdresse || 'Adresse');
    text('#inv-v-telefon', d.vTelefon || '');
    text('#inv-v-email', d.vEmail || '');
    text('#inv-v-steuernr', d.vSteuernr ? `St.-Nr.: ${d.vSteuernr}` : '');

    // Gast
    const guestName = d.gName || 'Gast Name';
    text('#inv-g-name', guestName);
    lines('#inv-g-adresse', d.gAdresse || '');
    text('#inv-greeting', `${d.greeting || 'SEHR GEEHRTE/R'} ${(d.greetingName || guestName).split(' ').pop().toUpperCase()},`);
    if (d.introText) text('#inv-intro-text', d.introText);

    // Meta
    text('#inv-r-nummer', d.rNummer || '—');
    text('#inv-r-datum', formatDate(d.rDatum));
    const cityMatch = String(d.vAdresse || '').match(/\d{5}\s+(.+)/);
    text('#inv-location', cityMatch ? cityMatch[1].split('\n')[0].trim() : '');
    text('#inv-r-datum-header', formatDate(d.rDatum));
    const nights = nightsOf(d.aAnreise, d.aAbreise);
    text('#inv-aufenthalt', d.aAnreise && d.aAbreise
        ? `${formatDate(d.aAnreise)} – ${formatDate(d.aAbreise)} (${nights} ${nights !== 1 ? 'Nächte' : 'Nacht'})` : '—');

    // Positions
    const body = $('#inv-positions-body');
    body.textContent = '';
    if (!d.positions.length) body.innerHTML = '<tr class="inv-empty-row"><td colspan="5">Keine Positionen</td></tr>';
    d.positions.forEach((pos, idx) => {
        const tr = document.createElement('tr');
        [String(idx + 1), pos.desc || '—', String(pos.qty), formatCurrency(pos.price), formatCurrency(pos.qty * pos.price)].forEach((v, i) => {
            const td = document.createElement('td');
            if (i >= 2) td.className = 'text-right';
            td.textContent = v;
            tr.appendChild(td);
        });
        body.appendChild(tr);
    });

    // Summary
    const netto = d.positions.reduce((sum, p) => sum + p.qty * p.price, 0);
    const rate = parseFloat(d.mwstSatz) || 0;
    const mwst = d.kleinunternehmer ? 0 : netto * (rate / 100);
    text('#inv-netto', formatCurrency(netto));
    text('#inv-mwst', formatCurrency(mwst));
    text('#inv-mwst-pct', String(rate));
    text('#inv-total', formatCurrency(netto + mwst));
    $('#inv-mwst').closest('.inv-summary-line').style.display = d.kleinunternehmer ? 'none' : 'flex';
    $('#inv-netto').closest('.inv-summary-line').style.display = d.kleinunternehmer ? 'none' : 'flex';
    show('#inv-kleinunternehmer-notice', d.kleinunternehmer ? 'block' : 'none');

    // Payment
    show('#inv-payment-status', 'block');
    $('#inv-paid-badge').className = `inv-paid-badge ${d.zBezahlt ? 'paid' : 'unpaid'}`;
    text('#inv-paid-text', d.zBezahlt
        ? `Bezahlt via ${d.zMethode}${d.zDatum ? ` am ${formatDate(d.zDatum)}` : ''}` : 'Offen – noch nicht bezahlt');
    show('#inv-payment', d.zShowBank ? 'block' : 'none');
    if (d.zShowBank) {
        text('#inv-b-inhaber', d.bInhaber || '–');
        text('#inv-b-iban', d.bIban || '–');
        text('#inv-b-bic', d.bBic || '–');
        text('#inv-b-bank', d.bBank || '–');
    }
    text('#inv-footer-text', d.zBezahlt ? `Betrag wurde bezahlt via ${d.zMethode}. Vielen Dank!`
        : d.zShowBank ? 'Bitte überweisen Sie den Betrag innerhalb von 14 Tagen auf das angegebene Konto.'
            : 'Vielen Dank für Ihren Aufenthalt!');

    // Door code
    show('#inv-nuki-pin', d.nukiPin ? 'block' : 'none');
    if (d.nukiPin) {
        text('#inv-nuki-pin-code', d.nukiPin);
        text('#inv-nuki-from', formatDate(d.aAnreise));
        text('#inv-nuki-to', formatDate(d.aAbreise));
    }
}

module.exports = { renderInvoiceHtml };
