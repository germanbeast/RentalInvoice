function renderEstateReportHtml(data) {
    const { mileage, expenses, invoices, stats } = data;
    const today = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const formatCurrency = (val) => {
        return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(val);
    };

    const formatDate = (dateStr) => {
        return new Date(dateStr).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    };

    return `
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <title>Erbverwaltung - Kostenabrechnung</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 10pt; line-height: 1.5; color: #333; }
        .page { width: 210mm; padding: 20mm 15mm; }

        h1 { font-size: 20pt; font-weight: 700; margin-bottom: 5mm; color: #1e40af; }
        h2 { font-size: 14pt; font-weight: 600; margin-top: 10mm; margin-bottom: 3mm; color: #1e40af; border-bottom: 2px solid #3b82f6; padding-bottom: 2mm; }
        h3 { font-size: 11pt; font-weight: 600; margin-top: 6mm; margin-bottom: 2mm; color: #1e293b; }

        .header { margin-bottom: 10mm; }
        .meta { font-size: 9pt; color: #64748b; margin-bottom: 8mm; }

        table { width: 100%; border-collapse: collapse; margin-bottom: 6mm; }
        thead { background: #f1f5f9; }
        th, td { padding: 3mm 2mm; text-align: left; border-bottom: 1px solid #e2e8f0; }
        th { font-size: 9pt; font-weight: 600; color: #475569; text-transform: uppercase; }
        td { font-size: 10pt; }
        .text-right { text-align: right; }
        .text-center { text-align: center; }

        .summary-box { background: #f8fafc; border: 2px solid #3b82f6; border-radius: 4px; padding: 5mm; margin-top: 10mm; }
        .summary-row { display: flex; justify-content: space-between; padding: 2mm 0; border-bottom: 1px solid #e2e8f0; }
        .summary-row:last-child { border-bottom: none; font-weight: 700; font-size: 12pt; color: #1e40af; }

        .footer { margin-top: 15mm; padding-top: 5mm; border-top: 1px solid #e2e8f0; font-size: 8pt; color: #94a3b8; text-align: center; }
    </style>
</head>
<body>
    <div class="page">
        <div class="header">
            <h1>Erbverwaltung - Kostenabrechnung</h1>
            <div class="meta">
                Erstellt am: ${today}<br>
                Zeitraum: Gesamtabrechnung
            </div>
        </div>

        <!-- Fahrtkostenabrechnung -->
        <h2>1. Fahrtkostenabrechnung</h2>
        <table>
            <thead>
                <tr>
                    <th>Datum</th>
                    <th>Von</th>
                    <th>Nach</th>
                    <th>Zweck</th>
                    <th class="text-right">km</th>
                    <th class="text-right">€/km</th>
                    <th class="text-right">Betrag</th>
                </tr>
            </thead>
            <tbody>
                ${mileage.map(m => `
                    <tr>
                        <td>${formatDate(m.date)}</td>
                        <td>${m.from_location}</td>
                        <td>${m.to_location}</td>
                        <td>${m.purpose}</td>
                        <td class="text-right">${m.distance_km.toFixed(1)}</td>
                        <td class="text-right">${formatCurrency(m.rate_per_km)}</td>
                        <td class="text-right">${formatCurrency(m.total_amount)}</td>
                    </tr>
                `).join('')}
                ${mileage.length === 0 ? '<tr><td colspan="7" class="text-center" style="color: #94a3b8;">Keine Fahrtkostenabrechnung vorhanden</td></tr>' : ''}
            </tbody>
        </table>
        <p style="text-align: right; font-weight: 600; margin-top: 2mm;">Summe Fahrtkosten: ${formatCurrency(stats.totals.mileage)}</p>

        <!-- Aufwendungen/Auslagen -->
        <h2>2. Aufwendungen & Auslagen</h2>
        <table>
            <thead>
                <tr>
                    <th>Datum</th>
                    <th>Kategorie</th>
                    <th>Beschreibung</th>
                    <th class="text-right">Betrag</th>
                </tr>
            </thead>
            <tbody>
                ${expenses.map(e => `
                    <tr>
                        <td>${formatDate(e.date)}</td>
                        <td>${e.category}</td>
                        <td>${e.description}</td>
                        <td class="text-right">${formatCurrency(e.amount)}</td>
                    </tr>
                `).join('')}
                ${expenses.length === 0 ? '<tr><td colspan="4" class="text-center" style="color: #94a3b8;">Keine Aufwendungen vorhanden</td></tr>' : ''}
            </tbody>
        </table>
        <p style="text-align: right; font-weight: 600; margin-top: 2mm;">Summe Aufwendungen: ${formatCurrency(stats.totals.expenses)}</p>

        <!-- Rechnungen -->
        <h2>3. Rechnungen</h2>
        <table>
            <thead>
                <tr>
                    <th>Datum</th>
                    <th>Lieferant</th>
                    <th>Rechnungs-Nr.</th>
                    <th>Beschreibung</th>
                    <th class="text-right">Betrag</th>
                </tr>
            </thead>
            <tbody>
                ${invoices.map(inv => `
                    <tr>
                        <td>${formatDate(inv.date)}</td>
                        <td>${inv.vendor}</td>
                        <td>${inv.invoice_number || '—'}</td>
                        <td>${inv.description}</td>
                        <td class="text-right">${formatCurrency(inv.amount)}</td>
                    </tr>
                `).join('')}
                ${invoices.length === 0 ? '<tr><td colspan="5" class="text-center" style="color: #94a3b8;">Keine Rechnungen vorhanden</td></tr>' : ''}
            </tbody>
        </table>
        <p style="text-align: right; font-weight: 600; margin-top: 2mm;">Summe Rechnungen: ${formatCurrency(stats.totals.invoices)}</p>

        <!-- Gesamtsumme -->
        <div class="summary-box">
            <div class="summary-row">
                <span>Fahrtkosten:</span>
                <span>${formatCurrency(stats.totals.mileage)}</span>
            </div>
            <div class="summary-row">
                <span>Aufwendungen & Auslagen:</span>
                <span>${formatCurrency(stats.totals.expenses)}</span>
            </div>
            <div class="summary-row">
                <span>Rechnungen:</span>
                <span>${formatCurrency(stats.totals.invoices)}</span>
            </div>
            <div class="summary-row">
                <span>GESAMTSUMME:</span>
                <span>${formatCurrency(stats.totals.grand_total)}</span>
            </div>
        </div>

        <div class="footer">
            Erbverwaltung - Kostenabrechnung | Erstellt mit Ferienwohnungs-Rechnungs-App
        </div>
    </div>
</body>
</html>
    `;
}

module.exports = { renderEstateReportHtml };
