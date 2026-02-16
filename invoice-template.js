const fs = require('fs');
const path = require('path');

/**
 * Renders a 1:1 identical invoice HTML as the frontend.
 * @param {Object} data Invoice data (guest, dates, positions, branding, etc.)
 * @returns {string} Full HTML string with embedded CSS
 */
function renderInvoiceHtml(data) {
    const stylesPath = path.join(__dirname, 'public', 'styles.css');
    const styles = fs.readFileSync(stylesPath, 'utf8');

    const {
        vName, vAdresse, vTelefon, vEmail, vSteuernr,
        gName, gAdresse,
        rNummer, rDatum, aAnreise, aAbreise,
        mwstSatz, kleinunternehmer,
        zBezahlt, zMethode, zDatum, zShowBank,
        bInhaber, bIban, bBic, bBank,
        nukiPin,
        positions,
        branding // { logo_base64, primary_color }
    } = data;

    const nights = calcNights(aAnreise, aAbreise);
    const aufenthaltText = aAnreise && aAbreise
        ? `${formatDate(aAnreise)} – ${formatDate(aAbreise)} (${nights} Nacht${nights !== 1 ? 'e' : ''})`
        : '—';

    const netto = positions.reduce((sum, p) => sum + (p.qty * p.price), 0);
    const rate = parseFloat(mwstSatz) || 0;
    const mwst = netto * (rate / 100);
    const total = netto + mwst;

    const logoHtml = branding && branding.logo_base64
        ? `<img src="${branding.logo_base64}" style="max-height: 80px; margin-bottom: 20px;">`
        : '';

    // Replicate the HTML from index.html #invoice-page
    return `
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <style>
        ${styles}
        body { background: white !important; padding: 0 !important; margin: 0; font-family: 'Inter', sans-serif; }
        .invoice-page { box-shadow: none !important; margin: 0 !important; border-radius: 0 !important; width: 100%; height: 100%; }
        @media print {
            body { margin: 0; }
            .invoice-page { border: none; }
        }
    </style>
</head>
<body>
    <div class="invoice-page">
        <!-- FALTMARKEN -->
        <div class="inv-markers">
            <div class="inv-marker inv-marker-fold-1"></div>
            <div class="inv-marker inv-marker-fold-2"></div>
        </div>
        
        <!-- HEADER -->
        <div class="inv-header">
            <div class="inv-logo">${logoHtml}</div>
            <div class="inv-sender">
                <strong>${vName || 'Vermieter Name'}</strong>
                <div class="inv-addr">${nl2br(vAdresse || 'Adresse')}</div>
                <div class="inv-contact">
                    <span>${vTelefon || ''}</span>
                    <span>${vEmail || ''}</span>
                </div>
                <div class="inv-tax">${vSteuernr ? `St.-Nr.: ${vSteuernr}` : ''}</div>
            </div>
        </div>

        <!-- RECIPIENT -->
        <div class="inv-recipient">
            <div class="inv-label">Rechnung an</div>
            <strong>${gName || 'Gast Name'}</strong>
            <div class="inv-addr">${nl2br(gAdresse || '')}</div>
        </div>

        <!-- META -->
        <div class="inv-meta">
            <div class="inv-meta-item">
                <span class="inv-label">Rechnungs-Nr.</span>
                <span>${rNummer || '—'}</span>
            </div>
            <div class="inv-meta-item">
                <span class="inv-label">Datum</span>
                <span>${formatDate(rDatum)}</span>
            </div>
            <div class="inv-meta-item">
                <span class="inv-label">Aufenthalt</span>
                <span>${aufenthaltText}</span>
            </div>
        </div>

        <h2 class="inv-title">Rechnung</h2>

        <!-- TABLE -->
        <table class="inv-table">
            <thead>
                <tr>
                    <th>Pos.</th>
                    <th>Bezeichnung</th>
                    <th class="text-right">Anzahl</th>
                    <th class="text-right">Einzelpreis</th>
                    <th class="text-right">Gesamt</th>
                </tr>
            </thead>
            <tbody>
                ${positions.length === 0 ? '<tr class="inv-empty-row"><td colspan="5">Keine Positionen</td></tr>' :
            positions.map((pos, idx) => `
                    <tr>
                        <td>${idx + 1}</td>
                        <td>${escapeHtml(pos.desc) || '—'}</td>
                        <td class="text-right">${pos.qty}</td>
                        <td class="text-right">${formatCurrency(pos.price)}</td>
                        <td class="text-right">${formatCurrency(pos.qty * pos.price)}</td>
                    </tr>
                    `).join('')}
            </tbody>
        </table>

        <!-- SUMMARY -->
        <div class="inv-summary">
            ${kleinunternehmer ? '' : `
            <div class="inv-summary-line">
                <span>Nettobetrag</span>
                <span>${formatCurrency(netto)}</span>
            </div>
            <div class="inv-summary-line">
                <span>MwSt. ${rate}%</span>
                <span>${formatCurrency(mwst)}</span>
            </div>
            `}
            <div class="inv-summary-line inv-summary-total">
                <span>Gesamtbetrag</span>
                <span>${formatCurrency(total)}</span>
            </div>
        </div>

        <!-- PAYMENT STATUS -->
        <div class="inv-payment-status">
            <div class="inv-paid-badge ${zBezahlt ? 'paid' : 'unpaid'}">
                ${zBezahlt ? `
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
                <span>Bezahlt via ${zMethode}${zDatum ? ` am ${formatDate(zDatum)}` : ''}</span>
                ` : `
                <span>Offen – noch nicht bezahlt</span>
                `}
            </div>
        </div>

        <!-- NUKI -->
        ${nukiPin ? `
        <div class="inv-nuki-pin">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" class="inv-nuki-icon">
                <path d="M6.5 9.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" stroke="currentColor" stroke-width="1.5" />
                <path d="M8.5 7.5L14 7.5V9.5M11.5 7.5V9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
            <div class="inv-nuki-content">
                <span class="inv-nuki-label">Ihr Zugangscode:</span>
                <span class="inv-nuki-code">${nukiPin}</span>
                <span class="inv-nuki-period">Gültig: ${formatDate(aAnreise)} bis ${formatDate(aAbreise)}</span>
            </div>
        </div>
        ` : ''}

        <!-- BANK -->
        ${zShowBank ? `
        <div class="inv-payment">
            <div class="inv-label">Bankverbindung</div>
            <div class="inv-bank-grid">
                <span>Kontoinhaber:</span><span>${bInhaber || '–'}</span>
                <span>IBAN:</span><span>${bIban || '–'}</span>
                <span>BIC:</span><span>${bBic || '–'}</span>
                <span>Bank:</span><span>${bBank || '–'}</span>
            </div>
        </div>
        ` : ''}

        <!-- FOOTER -->
        <div class="inv-footer">
            ${kleinunternehmer ? `
            <div class="inv-legal-notice">
                Kleinunternehmer (MwSt.-Befreiung nach § 19 UStG) — Der Rechnungsbetrag enthält gemäß § 19 UStG keine Umsatzsteuer.
            </div>
            ` : ''}
            <div class="inv-footer-text">
                ${zBezahlt ? `Betrag wurde bezahlt via ${zMethode}. Vielen Dank!` : (zShowBank ? 'Bitte überweisen Sie den Betrag innerhalb von 14 Tagen auf das angegebene Konto.' : 'Vielen Dank für Ihren Aufenthalt!')}
            </div>
        </div>
    </div>
</body>
</html>
    `;
}

// Helpers
function formatDate(date) {
    if (!date) return '—';
    const d = new Date(date);
    if (isNaN(d.getTime())) return date;
    return d.toLocaleDateString('de-DE');
}

function calcNights(anreise, abreise) {
    if (!anreise || !abreise) return 0;
    const start = new Date(anreise);
    const end = new Date(abreise);
    const diff = end - start;
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

function formatCurrency(val) {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(val);
}

function nl2br(str) {
    if (!str) return '';
    return str.replace(/\n/g, '<br>');
}

function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

module.exports = { renderInvoiceHtml };
