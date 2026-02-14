/* ===========================
   Ferienwohnung Rechnung – App Logic
   =========================== */

(function () {
    'use strict';

    // =======================
    // DOM References
    // =======================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const form = $('#invoice-form');
    const positionsBody = $('#positions-body');
    const invPositionsBody = $('#inv-positions-body');

    // Buttons
    const btnAddPos = $('#btn-add-position');
    const btnPrint = $('#btn-print');
    const btnPaperless = $('#btn-paperless');
    const btnReset = $('#btn-reset');
    const btnSaveVermieter = $('#btn-save-vermieter');
    const btnSaveBank = $('#btn-save-bank');
    const btnSettings = $('#btn-settings');
    const btnCloseSettings = $('#btn-close-settings');
    const btnSaveSettings = $('#btn-save-settings');
    const btnTestConnection = $('#btn-test-connection');
    const btnArchive = $('#btn-archive');
    const btnArchiveSave = $('#btn-archive-save');
    const btnCloseArchive = $('#btn-close-archive');
    const btnNukiPin = $('#btn-nuki-pin');
    const btnEmail = $('#btn-email');
    const btnUpdate = $('#btn-update');

    const modalSettings = $('#modal-settings');
    const modalArchive = $('#modal-archive');
    const toastContainer = $('#toast-container');

    // =======================
    // State
    // =======================
    let positions = [];
    let positionIdCounter = 0;

    // =======================
    // Utility
    // =======================
    function formatCurrency(val) {
        return val.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    }

    function formatDate(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    function calcNights(anreise, abreise) {
        if (!anreise || !abreise) return 0;
        const a = new Date(anreise);
        const b = new Date(abreise);
        const diff = Math.round((b - a) / (1000 * 60 * 60 * 24));
        return Math.max(0, diff);
    }

    function showToast(message, type = 'success', duration = 3500) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease forwards';
            setTimeout(() => toast.remove(), 350);
        }, duration);
    }

    function nl2br(str) {
        return (str || '').replace(/\n/g, '<br>');
    }

    // =======================
    // Positions
    // =======================
    function addPosition(desc = '', qty = 1, price = 0) {
        const id = ++positionIdCounter;
        positions.push({ id, desc, qty, price });
        renderPositions();
        updatePreview();
        scheduleDraftSave();
    }

    function removePosition(id) {
        positions = positions.filter(p => p.id !== id);
        renderPositions();
        updatePreview();
        scheduleDraftSave();
    }

    function renderPositions() {
        positionsBody.innerHTML = '';

        positions.forEach((pos, idx) => {
            const tr = document.createElement('tr');
            const total = pos.qty * pos.price;

            tr.innerHTML = `
                <td>
                    <input type="text" value="${escapeHtml(pos.desc)}" data-id="${pos.id}" data-field="desc" placeholder="z.B. Übernachtung" class="pos-input">
                </td>
                <td>
                    <input type="number" value="${pos.qty}" data-id="${pos.id}" data-field="qty" min="0" step="1" class="pos-input">
                </td>
                <td>
                    <input type="number" value="${pos.price}" data-id="${pos.id}" data-field="price" min="0" step="0.01" class="pos-input">
                </td>
                <td class="pos-total">${formatCurrency(total)}</td>
                <td>
                    <button type="button" class="btn-remove-pos" data-id="${pos.id}" title="Entfernen">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                    </button>
                </td>
            `;

            positionsBody.appendChild(tr);
        });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Position input handlers
    positionsBody.addEventListener('input', (e) => {
        const input = e.target;
        if (!input.dataset.id) return;

        const pos = positions.find(p => p.id === parseInt(input.dataset.id));
        if (!pos) return;

        const field = input.dataset.field;
        if (field === 'desc') {
            pos.desc = input.value;
        } else if (field === 'qty') {
            pos.qty = parseFloat(input.value) || 0;
        } else if (field === 'price') {
            pos.price = parseFloat(input.value) || 0;
        }

        // Update row total
        const row = input.closest('tr');
        const totalCell = row.querySelector('.pos-total');
        if (totalCell) {
            totalCell.textContent = formatCurrency(pos.qty * pos.price);
        }

        updateSummary();
        updatePreview();
        scheduleDraftSave();
    });

    positionsBody.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-remove-pos');
        if (btn) {
            removePosition(parseInt(btn.dataset.id));
        }
    });

    btnAddPos.addEventListener('click', () => addPosition());

    // =======================
    // Calculations
    // =======================
    function getSubtotal() {
        return positions.reduce((sum, p) => sum + (p.qty * p.price), 0);
    }

    function getMwstRate() {
        if ($('#kleinunternehmer').checked) return 0;
        return parseFloat($('#mwst-satz').value) || 0;
    }

    function updateSummary() {
        const netto = getSubtotal();
        const rate = getMwstRate();
        const mwst = netto * (rate / 100);
        const total = netto + mwst;

        $('#sum-netto').textContent = formatCurrency(netto);
        $('#sum-mwst').textContent = formatCurrency(mwst);
        $('#sum-mwst-label').textContent = rate;
        $('#sum-total').textContent = formatCurrency(total);
    }

    function updateNights() {
        const anreise = $('#a-anreise').value;
        const abreise = $('#a-abreise').value;
        const nights = calcNights(anreise, abreise);
        const badge = $('#naechte-badge');
        const text = $('#naechte-text');

        if (nights > 0) {
            badge.style.display = 'inline-flex';
            text.textContent = `${nights} Nacht${nights !== 1 ? 'e' : ''}`;
        } else {
            badge.style.display = 'none';
        }
    }

    // =======================
    // Live Preview
    // =======================
    function updatePreview() {
        // Vermieter
        $('#inv-v-name').textContent = $('#v-name').value || 'Vermieter Name';
        $('#inv-v-adresse').innerHTML = nl2br($('#v-adresse').value || 'Adresse');
        const tel = $('#v-telefon').value;
        const email = $('#v-email').value;
        $('#inv-v-telefon').textContent = tel;
        $('#inv-v-email').textContent = email;
        const steuernr = $('#v-steuernr').value;
        $('#inv-v-steuernr').textContent = steuernr ? `St.-Nr.: ${steuernr}` : '';

        // Gast
        $('#inv-g-name').textContent = $('#g-name').value || 'Gast Name';
        $('#inv-g-adresse').innerHTML = nl2br($('#g-adresse').value);

        // Meta
        $('#inv-r-nummer').textContent = $('#r-nummer').value || '—';
        $('#inv-r-datum').textContent = formatDate($('#r-datum').value);

        const anreise = $('#a-anreise').value;
        const abreise = $('#a-abreise').value;
        const nights = calcNights(anreise, abreise);
        let aufenthaltText = '—';
        if (anreise && abreise) {
            aufenthaltText = `${formatDate(anreise)} – ${formatDate(abreise)} (${nights} Nacht${nights !== 1 ? 'e' : ''})`;
        }
        $('#inv-aufenthalt').textContent = aufenthaltText;

        // Positions
        invPositionsBody.innerHTML = '';
        if (positions.length === 0) {
            invPositionsBody.innerHTML = '<tr class="inv-empty-row"><td colspan="5">Keine Positionen</td></tr>';
        } else {
            positions.forEach((pos, idx) => {
                const total = pos.qty * pos.price;
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${idx + 1}</td>
                    <td>${escapeHtml(pos.desc) || '—'}</td>
                    <td class="text-right">${pos.qty}</td>
                    <td class="text-right">${formatCurrency(pos.price)}</td>
                    <td class="text-right">${formatCurrency(total)}</td>
                `;
                invPositionsBody.appendChild(tr);
            });
        }

        // Summary
        const netto = getSubtotal();
        const rate = getMwstRate();
        const mwst = netto * (rate / 100);
        const total = netto + mwst;
        const isKleinunternehmer = $('#kleinunternehmer').checked;

        $('#inv-netto').textContent = formatCurrency(netto);
        $('#inv-mwst').textContent = formatCurrency(mwst);
        $('#inv-mwst-pct').textContent = rate;
        $('#inv-total').textContent = formatCurrency(total);

        // Hide/Show MWST row based on rate/Kleinunternehmer
        const mwstRow = $('#inv-mwst').closest('.inv-summary-line');
        const nettoRow = $('#inv-netto').closest('.inv-summary-line');
        const kleinunternehmerNotice = $('#inv-kleinunternehmer-notice');

        if (isKleinunternehmer) {
            if (mwstRow) mwstRow.style.display = 'none';
            if (nettoRow) nettoRow.style.display = 'none';
            if (kleinunternehmerNotice) kleinunternehmerNotice.style.display = 'block';
        } else {
            if (mwstRow) mwstRow.style.display = 'flex';
            if (nettoRow) nettoRow.style.display = 'flex';
            if (kleinunternehmerNotice) kleinunternehmerNotice.style.display = 'none';
        }

        // Payment status
        const isBezahlt = $('#z-bezahlt').checked;
        const methode = $('#z-methode').value;
        const zahlDatum = $('#z-datum').value;
        const showBank = $('#z-show-bank').checked;

        // Payment status badge in preview
        const paymentStatus = $('#inv-payment-status');
        const paidBadge = $('#inv-paid-badge');
        const paidText = $('#inv-paid-text');

        if (isBezahlt) {
            paymentStatus.style.display = 'block';
            let badgeText = `Bezahlt via ${methode}`;
            if (zahlDatum) {
                badgeText += ` am ${formatDate(zahlDatum)}`;
            }
            paidText.textContent = badgeText;
            paidBadge.className = 'inv-paid-badge paid';
        } else {
            paymentStatus.style.display = 'block';
            paidText.textContent = 'Offen – noch nicht bezahlt';
            paidBadge.className = 'inv-paid-badge unpaid';
        }

        // Bank section visibility
        const invPayment = $('#inv-payment');
        if (showBank) {
            invPayment.style.display = 'block';
            $('#inv-b-inhaber').textContent = $('#b-inhaber').value || '–';
            $('#inv-b-iban').textContent = $('#b-iban').value || '–';
            $('#inv-b-bic').textContent = $('#b-bic').value || '–';
            $('#inv-b-bank').textContent = $('#b-bank').value || '–';
        } else {
            invPayment.style.display = 'none';
        }

        // Footer text
        const footerTextElem = $('#inv-footer-text');
        let footerText = '';

        if (isBezahlt) {
            footerText = `Betrag wurde bezahlt via ${methode}. Vielen Dank!`;
        } else if (showBank) {
            footerText = 'Bitte überweisen Sie den Betrag innerhalb von 14 Tagen auf das angegebene Konto.';
        } else {
            footerText = 'Vielen Dank für Ihren Aufenthalt!';
        }

        if (footerTextElem) footerTextElem.textContent = footerText;

        // Nuki PIN Info in Preview
        const nukiInfo = $('#inv-nuki-pin');
        const nukiPinCode = $('#nuki-pin-code').textContent;
        const nukiPinResult = $('#nuki-pin-result');

        if (nukiPinResult.style.display !== 'none' && nukiPinCode !== '——-') {
            nukiInfo.style.display = 'block';
            $('#inv-nuki-pin-code').textContent = nukiPinCode;
            $('#inv-nuki-from').textContent = formatDate($('#a-anreise').value);
            $('#inv-nuki-to').textContent = formatDate($('#a-abreise').value);
        } else {
            nukiInfo.style.display = 'none';
        }
    }

    // =======================
    // Form -> Preview Binding
    // =======================
    const formInputs = [
        'v-name', 'v-adresse', 'v-telefon', 'v-email', 'v-steuernr',
        'g-name', 'g-adresse',
        'r-nummer', 'r-datum', 'a-anreise', 'a-abreise',
        'mwst-satz', 'kleinunternehmer',
        'b-inhaber', 'b-iban', 'b-bic', 'b-bank',
        'z-methode', 'z-datum'
    ];

    formInputs.forEach(id => {
        const el = $(`#${id}`);
        if (el) {
            el.addEventListener('input', () => {
                updatePreview();
                updateSummary();
                scheduleDraftSave();
                if (id === 'a-anreise' || id === 'a-abreise') {
                    updateNights();
                }
            });
        }
    });

    // =======================
    // localStorage
    // =======================
    const STORAGE_KEYS = {
        vermieter: 'fw-rechnung-vermieter',
        bank: 'fw-rechnung-bank',
        rechnungsnr: 'fw-rechnung-nr',
        paperless: 'fw-rechnung-paperless',
        draft: 'fw-rechnung-draft',
        archive: 'fw-rechnung-archive',
        nuki: 'fw-rechnung-nuki',
        smtp: 'fw-rechnung-smtp'
    };

    function saveVermieter() {
        const data = {
            name: $('#v-name').value,
            adresse: $('#v-adresse').value,
            telefon: $('#v-telefon').value,
            email: $('#v-email').value,
            steuernr: $('#v-steuernr').value
        };
        localStorage.setItem(STORAGE_KEYS.vermieter, JSON.stringify(data));
        showToast('Vermieter-Daten gespeichert');
    }

    function loadVermieter() {
        const raw = localStorage.getItem(STORAGE_KEYS.vermieter);
        if (!raw) return;
        try {
            const data = JSON.parse(raw);
            if (data.name) $('#v-name').value = data.name;
            if (data.adresse) $('#v-adresse').value = data.adresse;
            if (data.telefon) $('#v-telefon').value = data.telefon;
            if (data.email) $('#v-email').value = data.email;
            if (data.steuernr) $('#v-steuernr').value = data.steuernr;
        } catch (e) { /* ignore */ }
    }

    function saveBank() {
        const data = {
            inhaber: $('#b-inhaber').value,
            iban: $('#b-iban').value,
            bic: $('#b-bic').value,
            bank: $('#b-bank').value
        };
        localStorage.setItem(STORAGE_KEYS.bank, JSON.stringify(data));
        showToast('Bankdaten gespeichert');
    }

    function loadBank() {
        const raw = localStorage.getItem(STORAGE_KEYS.bank);
        if (!raw) return;
        try {
            const data = JSON.parse(raw);
            if (data.inhaber) $('#b-inhaber').value = data.inhaber;
            if (data.iban) $('#b-iban').value = data.iban;
            if (data.bic) $('#b-bic').value = data.bic;
            if (data.bank) $('#b-bank').value = data.bank;
        } catch (e) { /* ignore */ }
    }

    function savePaperlessSettings() {
        const data = {
            url: $('#pl-url').value.replace(/\/+$/, ''),  // Remove trailing slashes
            token: $('#pl-token').value,
            correspondent: $('#pl-correspondent').value,
            doctype: $('#pl-doctype').value,
            tags: $('#pl-tags').value
        };
        localStorage.setItem(STORAGE_KEYS.paperless, JSON.stringify(data));
        showToast('Paperless-Einstellungen gespeichert');
    }

    function loadPaperlessSettings() {
        const raw = localStorage.getItem(STORAGE_KEYS.paperless);
        if (!raw) return;
        try {
            const data = JSON.parse(raw);
            if (data.url) $('#pl-url').value = data.url;
            if (data.token) $('#pl-token').value = data.token;
            if (data.correspondent) $('#pl-correspondent').value = data.correspondent;
            if (data.doctype) $('#pl-doctype').value = data.doctype;
            if (data.tags) $('#pl-tags').value = data.tags;
        } catch (e) { /* ignore */ }
    }

    function saveSmtpSettings() {
        const data = {
            host: $('#smtp-host').value,
            port: $('#smtp-port').value,
            user: $('#smtp-user').value,
            pass: $('#smtp-pass').value,
            from: $('#smtp-from').value
        };
        localStorage.setItem(STORAGE_KEYS.smtp, JSON.stringify(data));
        showToast('SMTP-Einstellungen gespeichert');
    }

    function loadSmtpSettings() {
        const raw = localStorage.getItem(STORAGE_KEYS.smtp);
        if (!raw) return;
        try {
            const data = JSON.parse(raw);
            if (data.host) $('#smtp-host').value = data.host;
            if (data.port) $('#smtp-port').value = data.port;
            if (data.user) $('#smtp-user').value = data.user;
            if (data.pass) $('#smtp-pass').value = data.pass;
            if (data.from) $('#smtp-from').value = data.from;
        } catch (e) { /* ignore */ }
    }

    function saveNukiSettings() {
        const data = {
            token: $('#nuki-token').value,
            lockId: $('#nuki-lock-id').value
        };
        localStorage.setItem(STORAGE_KEYS.nuki, JSON.stringify(data));
        showToast('Nuki-Einstellungen gespeichert');
    }

    function loadNukiSettings() {
        const raw = localStorage.getItem(STORAGE_KEYS.nuki);
        if (!raw) return;
        try {
            const data = JSON.parse(raw);
            $('#nuki-token').value = data.token || '';
            $('#nuki-lock-id').value = data.lockId || '';
        } catch (e) { /* ignore */ }
    }

    function getNextRechnungsnr() {
        const currentYear = new Date().getFullYear();
        const raw = localStorage.getItem(STORAGE_KEYS.rechnungsnr);
        let lastNr = 0;
        let lastYear = currentYear;

        if (raw) {
            try {
                const data = JSON.parse(raw);
                lastNr = data.nr || 0;
                lastYear = data.year || currentYear;
            } catch (e) { /* ignore */ }
        }

        // Reset counter on new year
        if (lastYear !== currentYear) {
            lastNr = 0;
        }

        const nextNr = lastNr + 1;
        localStorage.setItem(STORAGE_KEYS.rechnungsnr, JSON.stringify({ nr: nextNr, year: currentYear }));
        return `${currentYear}-${String(nextNr).padStart(3, '0')}`;
    }

    // =======================
    // Auto-Save Draft
    // =======================
    let draftTimer = null;

    function collectFormData() {
        return {
            vName: $('#v-name').value,
            vAdresse: $('#v-adresse').value,
            gName: $('#g-name').value,
            gAdresse: $('#g-adresse').value,
            gEmail: $('#g-email').value,
            rNummer: $('#r-nummer').value,
            rDatum: $('#r-datum').value,
            aAnreise: $('#a-anreise').value,
            aAbreise: $('#a-abreise').value,
            mwstSatz: $('#mwst-satz').value,
            kleinunternehmer: $('#kleinunternehmer').checked,
            zBezahlt: $('#z-bezahlt').checked,
            zMethode: $('#z-methode').value,
            zDatum: $('#z-datum').value,
            zShowBank: $('#z-show-bank').checked,
            nukiPin: $('#nuki-pin-result').style.display !== 'none' ? $('#nuki-pin-code').textContent : null,
            positions: positions.map(p => ({ desc: p.desc, qty: p.qty, price: p.price })),
            timestamp: Date.now()
        };
    }

    function saveDraft() {
        try {
            localStorage.setItem(STORAGE_KEYS.draft, JSON.stringify(collectFormData()));
        } catch (e) { /* storage full */ }
    }

    function scheduleDraftSave() {
        clearTimeout(draftTimer);
        draftTimer = setTimeout(saveDraft, 500);
    }

    function loadDraft() {
        const raw = localStorage.getItem(STORAGE_KEYS.draft);
        if (!raw) return false;
        try {
            const d = JSON.parse(raw);
            if (d.gName) $('#g-name').value = d.gName;
            if (d.gAdresse) $('#g-adresse').value = d.gAdresse;
            if (d.gEmail) $('#g-email').value = d.gEmail;
            if (d.rNummer) $('#r-nummer').value = d.rNummer;
            if (d.rDatum) $('#r-datum').value = d.rDatum;
            if (d.aAnreise) $('#a-anreise').value = d.aAnreise;
            if (d.aAbreise) $('#a-abreise').value = d.aAbreise;
            if (d.mwstSatz !== undefined) $('#mwst-satz').value = d.mwstSatz;
            if (d.kleinunternehmer !== undefined) {
                $('#kleinunternehmer').checked = d.kleinunternehmer;
                $('#mwst-group').style.display = d.kleinunternehmer ? 'none' : 'block';
            }
            if (d.zBezahlt !== undefined) $('#z-bezahlt').checked = d.zBezahlt;
            if (d.zMethode) $('#z-methode').value = d.zMethode;
            if (d.zDatum) $('#z-datum').value = d.zDatum;
            if (d.zShowBank !== undefined) {
                $('#z-show-bank').checked = d.zShowBank;
                $('#fieldset-bank').style.display = d.zShowBank ? 'block' : 'none';
            }
            if (d.nukiPin) {
                $('#nuki-pin-result').style.display = 'block';
                $('#nuki-pin-code').textContent = d.nukiPin;
            } else {
                $('#nuki-pin-result').style.display = 'none';
            }
            if (d.positions && d.positions.length > 0) {
                positions = [];
                positionIdCounter = 0;
                d.positions.forEach(p => {
                    const id = ++positionIdCounter;
                    positions.push({ id, desc: p.desc || '', qty: p.qty || 0, price: p.price || 0 });
                });
                renderPositions();
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    function clearDraft() {
        localStorage.removeItem(STORAGE_KEYS.draft);
    }

    // =======================
    // Invoice Archive
    // =======================
    function getArchive() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEYS.archive)) || [];
        } catch (e) {
            return [];
        }
    }

    function saveArchive(archive) {
        localStorage.setItem(STORAGE_KEYS.archive, JSON.stringify(archive));
    }

    function archiveInvoice() {
        const nummer = $('#r-nummer').value;
        const gastName = $('#g-name').value;
        if (!nummer) {
            showToast('Rechnungsnummer erforderlich zum Archivieren', 'error');
            return false;
        }

        const archive = getArchive();

        // Prevent duplicate archiving of same invoice number
        const existingIdx = archive.findIndex(a => a.rNummer === nummer);
        const invoiceData = {
            ...collectFormData(),
            // Also save vermieter for full snapshot
            vName: $('#v-name').value,
            vAdresse: $('#v-adresse').value,
            vTelefon: $('#v-telefon').value,
            vEmail: $('#v-email').value,
            vSteuernr: $('#v-steuernr').value,
            bInhaber: $('#b-inhaber').value,
            bIban: $('#b-iban').value,
            bBic: $('#b-bic').value,
            bBank: $('#b-bank').value,
            // Computed values for display
            totalAmount: getSubtotal() * (1 + getMwstRate() / 100),
            archivedAt: new Date().toISOString()
        };

        if (existingIdx >= 0) {
            archive[existingIdx] = invoiceData;
            showToast(`Rechnung ${nummer} aktualisiert im Archiv ✓`);
        } else {
            archive.unshift(invoiceData);
            showToast(`Rechnung ${nummer} archiviert ✓`);
        }

        saveArchive(archive);
        return true;
    }

    function deleteArchivedInvoice(index) {
        const archive = getArchive();
        if (index >= 0 && index < archive.length) {
            const removed = archive.splice(index, 1)[0];
            saveArchive(archive);
            showToast(`Rechnung ${removed.rNummer} gelöscht`);
            renderArchiveList();
        }
    }

    function loadArchivedInvoice(index) {
        const archive = getArchive();
        if (index < 0 || index >= archive.length) return;
        const d = archive[index];

        // Restore vermieter (from snapshot)
        if (d.vName) $('#v-name').value = d.vName;
        if (d.vAdresse) $('#v-adresse').value = d.vAdresse;
        if (d.vTelefon) $('#v-telefon').value = d.vTelefon;
        if (d.vEmail) $('#v-email').value = d.vEmail;
        if (d.vSteuernr) $('#v-steuernr').value = d.vSteuernr;

        // Guest
        $('#g-name').value = d.gName || '';
        $('#g-adresse').value = d.gAdresse || '';
        $('#g-email').value = d.gEmail || '';

        // Invoice details
        $('#r-nummer').value = d.rNummer || '';
        $('#r-datum').value = d.rDatum || '';
        $('#a-anreise').value = d.aAnreise || '';
        $('#a-abreise').value = d.aAbreise || '';
        $('#mwst-satz').value = d.mwstSatz || '7';
        $('#kleinunternehmer').checked = d.kleinunternehmer || false;
        $('#mwst-group').style.display = d.kleinunternehmer ? 'none' : 'block';

        // Payment
        $('#z-bezahlt').checked = d.zBezahlt !== undefined ? d.zBezahlt : true;
        $('#z-methode').value = d.zMethode || 'PayPal';
        $('#z-datum').value = d.zDatum || '';
        $('#z-show-bank').checked = d.zShowBank || false;
        $('#fieldset-bank').style.display = d.zShowBank ? 'block' : 'none';

        // Bank
        if (d.bInhaber) $('#b-inhaber').value = d.bInhaber;
        if (d.bIban) $('#b-iban').value = d.bIban;
        if (d.bBic) $('#b-bic').value = d.bBic;
        if (d.bBank) $('#b-bank').value = d.bBank;

        // Positions
        positions = [];
        positionIdCounter = 0;
        if (d.positions && d.positions.length > 0) {
            d.positions.forEach(p => {
                const id = ++positionIdCounter;
                positions.push({ id, desc: p.desc || '', qty: p.qty || 0, price: p.price || 0 });
            });
        }
        renderPositions();
        updateSummary();
        updatePreview();
        updateNights();
        saveDraft();

        modalArchive.style.display = 'none';
        showToast(`Rechnung ${d.rNummer} geladen`);
    }

    function renderArchiveList(filter = '') {
        const list = $('#archive-list');
        const archive = getArchive();
        const query = filter.toLowerCase().trim();

        const filtered = query
            ? archive.filter(a => {
                const searchable = [
                    a.rNummer, a.gName, a.rDatum,
                    a.zMethode, a.gAdresse
                ].join(' ').toLowerCase();
                return searchable.includes(query);
            })
            : archive;

        if (filtered.length === 0) {
            list.innerHTML = `
                <div class="archive-empty">
                    <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                        <path d="M8 14h32a2 2 0 012 2v2a2 2 0 01-2 2H8a2 2 0 01-2-2v-2a2 2 0 012-2z" stroke="currentColor" stroke-width="2"/>
                        <path d="M10 20v14a4 4 0 004 4h20a4 4 0 004-4V20M20 28h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                    <p>${query ? 'Keine Treffer gefunden' : 'Noch keine Rechnungen archiviert'}</p>
                    <small>${query ? 'Versuche einen anderen Suchbegriff' : 'Klicke "Archivieren" um eine Rechnung zu speichern'}</small>
                </div>
            `;
            return;
        }

        list.innerHTML = filtered.map((inv, displayIdx) => {
            // Find actual index in full archive for actions
            const realIdx = archive.indexOf(inv);
            const total = inv.totalAmount || 0;
            const paid = inv.zBezahlt;
            const paidClass = paid ? 'archive-badge-paid' : 'archive-badge-unpaid';
            const paidLabel = paid ? `Bezahlt (${inv.zMethode || 'PayPal'})` : 'Offen';

            return `
                <div class="archive-item">
                    <div class="archive-item-main">
                        <div class="archive-item-top">
                            <span class="archive-nr">${escapeHtml(inv.rNummer || '—')}</span>
                            <span class="archive-date">${formatDate(inv.rDatum)}</span>
                        </div>
                        <div class="archive-item-guest">${escapeHtml(inv.gName || 'Unbekannter Gast')}</div>
                        <div class="archive-item-bottom">
                            <span class="archive-total">${formatCurrency(total)}</span>
                            <span class="archive-badge ${paidClass}">${paidLabel}</span>
                        </div>
                    </div>
                    <div class="archive-item-actions">
                        <button type="button" class="btn btn-sm btn-outline btn-archive-load" data-idx="${realIdx}" title="Laden">
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 10v2h10v-2M7 2v7M4 6l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                            Laden
                        </button>
                        <button type="button" class="btn btn-sm btn-ghost btn-danger btn-archive-delete" data-idx="${realIdx}" title="Löschen">
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M4 4V3h6v1M5 6v4M9 6v4M3 4l.7 7.3a1 1 0 001 .7h4.6a1 1 0 001-.7L11 4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        // Event delegation for archive actions
        list.querySelectorAll('.btn-archive-load').forEach(btn => {
            btn.addEventListener('click', () => {
                loadArchivedInvoice(parseInt(btn.dataset.idx));
            });
        });

        list.querySelectorAll('.btn-archive-delete').forEach(btn => {
            btn.addEventListener('click', () => {
                if (confirm('Diese Rechnung wirklich aus dem Archiv löschen?')) {
                    deleteArchivedInvoice(parseInt(btn.dataset.idx));
                }
            });
        });
    }

    // =======================
    // Settings Modal
    // =======================
    btnSettings.addEventListener('click', () => {
        modalSettings.style.display = 'flex';
    });

    btnCloseSettings.addEventListener('click', () => {
        modalSettings.style.display = 'none';
    });

    modalSettings.addEventListener('click', (e) => {
        if (e.target === modalSettings) {
            modalSettings.style.display = 'none';
        }
    });

    btnSaveSettings.addEventListener('click', () => {
        savePaperlessSettings();
        saveSmtpSettings();
        saveNukiSettings();
        modalSettings.style.display = 'none';
    });

    async function createNukiPin() {
        const token = $('#nuki-token').value;
        const lockId = $('#nuki-lock-id').value;
        const fromDate = $('#a-anreise').value;
        const toDate = $('#a-abreise').value;
        const guestName = $('#g-name').value || 'Gast';

        if (!token || !lockId) {
            showToast('Nuki API-Token und Lock-ID fehlen in den Einstellungen!', 'error');
            return;
        }

        if (!fromDate || !toDate) {
            showToast('Bitte Anreise- und Abreisedatum wählen!', 'error');
            return;
        }

        btnNukiPin.disabled = true;
        btnNukiPin.textContent = 'Generiere PIN...';

        try {
            // Nuki API uses from/until dates. Keypad PINs are 6 digits.
            // Documentation: PUT /smartlock/{smartlockId}/auth
            const allowedFrom = `${fromDate}T15:00:00.000Z`; // Check-in time
            const allowedUntil = `${toDate}T11:00:00.000Z`;   // Check-out time

            // Generate a random 6-digit PIN (1-9 only, no 0 allowed!)
            const generateValidPin = () => {
                let pin;
                do {
                    pin = Array.from({ length: 6 }, () => Math.floor(Math.random() * 9) + 1).join('');
                } while (pin.startsWith('12')); // Nuki PINs cannot start with 12
                return pin;
            };
            const generatedCode = generateValidPin();

            // Name must be max 20 characters
            const safeName = `Gast: ${guestName}`.substring(0, 20);

            const apiUrl = `https://api.nuki.io/smartlock/auth`;
            const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(apiUrl)}`;

            const response = await fetch(proxyUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    name: safeName,
                    allowedFromDate: allowedFrom,
                    allowedUntilDate: allowedUntil,
                    allowedWeekDays: 127, // All days
                    allowedFromTime: 0,    // 00:00
                    allowedUntilTime: 0,   // 00:00 (Nuki docs say 0 for both means all day)
                    type: 13, // 13 is Keypad code
                    code: generatedCode,
                    smartlockIds: [lockId]
                })
            });

            if (response.ok) {
                $('#nuki-pin-result').style.display = 'block';
                $('#nuki-pin-code').textContent = generatedCode;
                showToast('Keypad-PIN erfolgreich generiert! 🔑', 'success');
                updatePreview();
                scheduleDraftSave();
            } else {
                const err = await response.json().catch(() => ({}));
                const errMsg = err.message || response.statusText || 'Ungültige Anfrage';
                showToast(`Nuki Fehler: ${errMsg}`, 'error');
            }
        } catch (error) {
            console.error('Nuki API Error:', error);
            showToast('Verbindung zu Nuki fehlgeschlagen.', 'error');
        } finally {
            btnNukiPin.disabled = false;
            btnNukiPin.textContent = 'Keypad-PIN für Zeitraum generieren';
        }
    }

    btnNukiPin.addEventListener('click', createNukiPin);

    btnTestConnection.addEventListener('click', async () => {
        const url = $('#pl-url').value.replace(/\/+$/, '');
        const token = $('#pl-token').value;

        if (!url || !token) {
            showToast('Bitte URL und Token eingeben', 'error');
            return;
        }

        btnTestConnection.disabled = true;
        btnTestConnection.textContent = 'Teste…';

        try {
            const response = await fetch(`${url}/api/`, {
                method: 'GET',
                headers: {
                    'Authorization': `Token ${token}`
                }
            });

            if (response.ok) {
                showToast('Paperless-Verbindung erfolgreich! ✓', 'success');
            } else {
                showToast(`Paperless-Fehler: HTTP ${response.status}`, 'error');
            }
        } catch (err) {
            showToast(`Verbindungsfehler: ${err.message}`, 'error');
        } finally {
            btnTestConnection.disabled = false;
            btnTestConnection.textContent = 'Paperless testen';
        }
    });

    $('#btn-nuki-test').addEventListener('click', async () => {
        const token = $('#nuki-token').value;
        const lockId = $('#nuki-lock-id').value;

        if (!token || !lockId) {
            showToast('Bitte Token und Lock-ID eingeben', 'error');
            return;
        }

        const btnNukiTest = $('#btn-nuki-test');
        btnNukiTest.disabled = true;
        btnNukiTest.textContent = 'Teste…';

        try {
            const apiUrl = `https://api.nuki.io/smartlock/${lockId}`;
            const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(apiUrl)}`;

            const response = await fetch(proxyUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json'
                }
            });

            if (response.ok) {
                const data = await response.json();
                showToast(`Nuki-Verbindung erfolgreich! Lock: ${data.name} ✓`, 'success');
            } else {
                const err = await response.json();
                showToast(`Nuki-Fehler: ${err.message || response.statusText}`, 'error');
            }
        } catch (err) {
            showToast(`Nuki-Verbindungsfehler: ${err.message}`, 'error');
        } finally {
            btnNukiTest.disabled = false;
            btnNukiTest.textContent = 'Nuki testen';
        }
    });

    // =======================
    // Print
    // =======================
    btnPrint.addEventListener('click', () => {
        archiveInvoice();
        window.print();
    });

    // =======================
    // E-Mail Versand (Server Version)
    // =======================
    async function sendCheckInEmail() {
        const nr = $('#r-nummer').value || 'Unbekannt';
        const name = $('#g-name').value || 'Gast';
        const email = $('#g-email').value;
        const von = formatDate($('#a-anreise').value);
        const bis = formatDate($('#a-abreise').value);
        const pin = $('#nuki-pin-code').textContent;
        const hasPin = $('#nuki-pin-result').style.display !== 'none' && pin !== '——-';

        if (!email) {
            showToast('Bitte E-Mail-Adresse des Gastes eingeben!', 'error');
            return;
        }

        const smtpRaw = localStorage.getItem(STORAGE_KEYS.smtp);
        if (!smtpRaw) {
            showToast('Bitte SMTP-Einstellungen konfigurieren!', 'error');
            btnSettings.click();
            return;
        }
        const smtpConfig = JSON.parse(smtpRaw);

        btnEmail.disabled = true;
        const originalText = btnEmail.textContent;
        btnEmail.textContent = 'Sende...';
        showToast('Generiere PDF & sende E-Mail...', 'info');

        try {
            // 1. Get HTML of current invoice page with styles
            const styles = Array.from(document.styleSheets)
                .map(sheet => {
                    try {
                        return Array.from(sheet.cssRules).map(r => r.cssText).join('\n');
                    } catch (e) { return ''; }
                }).join('\n');

            const invoiceHtml = `
                <html>
                <head>
                    <style>
                        ${styles}
                        body { background: white !important; padding: 0 !important; }
                        .invoice-page { box-shadow: none !important; margin: 0 !important; border-radius: 0 !important; }
                    </style>
                </head>
                <body>
                    ${$('#invoice-page').outerHTML}
                </body>
                </html>
            `;

            // 2. Generate PDF on Server
            const pdfRes = await fetch('/api/generate-pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ html: invoiceHtml })
            });

            if (!pdfRes.ok) throw new Error('PDF-Generierung fehlgeschlagen');
            const pdfBlob = await pdfRes.blob();

            // Convert blob to base64 for email API
            const pdfBase64 = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(pdfBlob);
            });

            // 3. Send Email via Server
            let bodyText = `Hallo ${name},\n\nvielen Dank für deine Buchung! Anbei findest du die Rechnung zu deinem Aufenthalt vom ${von} bis ${bis}.\n\n`;
            if (hasPin) {
                bodyText += `Dein Zugangscode für das Nuki Smart Lock lautet: ${pin}\n(Gültig während des gesamten Aufenthalts)\n\n`;
            }
            bodyText += `Wir wünschen dir eine gute Reise!\n\nMit freundlichen Grüßen,\n${$('#v-name').value}`;

            const emailRes = await fetch('/api/send-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: email,
                    subject: `Ihre Buchung: Rechnung ${nr} & Check-in Details`,
                    body: bodyText,
                    pdfBuffer: pdfBase64,
                    fileName: `Rechnung_${nr}.pdf`,
                    smtpConfig: smtpConfig
                })
            });

            if (!emailRes.ok) {
                const err = await emailRes.text();
                throw new Error(err || 'E-Mail-Versand fehlgeschlagen');
            }

            showToast('E-Mail erfolgreich versendet! ✓', 'success');
            archiveInvoice(); // Auto-archive on success
        } catch (error) {
            console.error(error);
            showToast('Fehler: ' + error.message, 'error');
        } finally {
            btnEmail.disabled = false;
            btnEmail.textContent = originalText;
        }
    }

    btnEmail.addEventListener('click', sendCheckInEmail);

    // =======================
    // Paperless NGX Export
    // =======================
    btnPaperless.addEventListener('click', async () => {
        const settings = loadPaperlessSettings();

        if (!settings.url || !settings.token) {
            showToast('Bitte zuerst Paperless-Einstellungen konfigurieren', 'error');
            modalSettings.style.display = 'flex';
            return;
        }

        // Validate minimum fields
        if (!$('#r-nummer').value || !$('#g-name').value) {
            showToast('Rechnungsnummer und Gastname sind erforderlich', 'error');
            return;
        }

        btnPaperless.disabled = true;
        const originalText = btnPaperless.innerHTML;
        btnPaperless.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" class="spin"><circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" stroke-dasharray="30 14" stroke-linecap="round"/></svg>
            PDF wird erstellt…
        `;

        try {
            // 1. Get HTML of current invoice page with styles
            const styles = Array.from(document.styleSheets)
                .map(sheet => {
                    try {
                        return Array.from(sheet.cssRules).map(r => r.cssText).join('\n');
                    } catch (e) { return ''; }
                }).join('\n');

            const invoiceHtml = `
                <html>
                <head>
                    <style>
                        ${styles}
                        body { background: white !important; padding: 0 !important; }
                        .invoice-page { box-shadow: none !important; margin: 0 !important; border-radius: 0 !important; }
                    </style>
                </head>
                <body>
                    ${$('#invoice-page').outerHTML}
                </body>
                </html>
            `;

            // 2. Generate PDF on Server
            const pdfRes = await fetch('/api/generate-pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ html: invoiceHtml })
            });

            if (!pdfRes.ok) throw new Error('PDF-Generierung auf dem Server fehlgeschlagen');
            const pdfBlob = await pdfRes.blob();

            btnPaperless.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" class="spin"><circle cx="9" cy="9" r="7" stroke="currentColor" stroke-width="2" stroke-dasharray="30 14" stroke-linecap="round"/></svg>
                Sende an Paperless…
            `;

            // Prepare form data
            const formData = new FormData();
            const filename = `Rechnung_${$('#r-nummer').value}_${$('#g-name').value.replace(/\s+/g, '_')}.pdf`;
            formData.append('document', pdfBlob, filename);
            formData.append('title', `Rechnung ${$('#r-nummer').value} – ${$('#g-name').value}`);
            formData.append('created', $('#r-datum').value || new Date().toISOString().split('T')[0]);

            if (settings.correspondent) {
                formData.append('correspondent', settings.correspondent);
            }
            if (settings.doctype) {
                formData.append('document_type', settings.doctype);
            }
            if (settings.tags) {
                const tagIds = settings.tags.split(',').map(t => t.trim()).filter(t => t);
                tagIds.forEach(tagId => formData.append('tags', tagId));
            }

            // Upload to Paperless
            const response = await fetch(`${settings.url}/api/documents/post_document/`, {
                method: 'POST',
                headers: {
                    'Authorization': `Token ${settings.token}`
                },
                body: formData
            });

            if (response.ok) {
                const result = await response.text();
                archiveInvoice();
                showToast(`Erfolgreich an Paperless gesendet! 🎉`, 'success', 5000);
            } else {
                const errorText = await response.text();
                showToast(`Paperless-Fehler: HTTP ${response.status}`, 'error', 5000);
                console.error('Paperless error:', errorText);
            }
        } catch (err) {
            showToast(`Fehler: ${err.message}`, 'error', 5000);
            console.error('Export error:', err);
        } finally {
            btnPaperless.disabled = false;
            btnPaperless.innerHTML = originalText;
        }
    });

    // =======================
    // Reset
    // =======================
    btnReset.addEventListener('click', () => {
        if (!confirm('Möchtest du wirklich alle Rechnungsdaten zurücksetzen?\n\n(Gespeicherte Vermieter- und Bankdaten bleiben erhalten.)')) {
            return;
        }

        // Clear guest
        $('#g-name').value = '';
        $('#g-adresse').value = '';

        // Clear dates
        $('#a-anreise').value = '';
        $('#a-abreise').value = '';
        $('#naechte-badge').style.display = 'none';

        // New invoice number
        $('#r-nummer').value = getNextRechnungsnr();
        $('#r-datum').value = new Date().toISOString().split('T')[0];

        // Reset payment
        $('#z-bezahlt').checked = true;
        $('#z-methode').value = 'PayPal';
        $('#z-datum').value = '';
        $('#z-show-bank').checked = false;
        $('#fieldset-bank').style.display = 'none';

        // Clear positions
        positions = [];
        renderPositions();

        // Clear draft
        clearDraft();

        updateSummary();
        updatePreview();
        showToast('Rechnungsdaten zurückgesetzt');
    });

    // =======================
    // Save Buttons
    // =======================
    btnSaveVermieter.addEventListener('click', saveVermieter);
    btnSaveBank.addEventListener('click', saveBank);

    // =======================
    // Init
    // =======================
    // =======================
    // Payment toggles
    // =======================
    $('#z-bezahlt').addEventListener('change', () => {
        updatePreview();
        scheduleDraftSave();
    });

    $('#kleinunternehmer').addEventListener('change', () => {
        const isKlein = $('#kleinunternehmer').checked;
        $('#mwst-group').style.display = isKlein ? 'none' : 'block';
        updatePreview();
        updateSummary();
        scheduleDraftSave();
    });

    $('#z-show-bank').addEventListener('change', () => {
        const showBank = $('#z-show-bank').checked;
        $('#fieldset-bank').style.display = showBank ? 'block' : 'none';
        updatePreview();
        scheduleDraftSave();
    });

    // When method changes to Überweisung, auto-enable bank
    $('#z-methode').addEventListener('change', () => {
        const methode = $('#z-methode').value;
        if (methode === 'Überweisung' && !$('#z-show-bank').checked) {
            $('#z-show-bank').checked = true;
            $('#fieldset-bank').style.display = 'block';
        }
        updatePreview();
        scheduleDraftSave();
    });

    // =======================
    // Archive Modal
    // =======================
    btnArchive.addEventListener('click', () => {
        renderArchiveList();
        modalArchive.style.display = 'flex';
        $('#archive-search-input').value = '';
        $('#archive-search-input').focus();
    });

    btnCloseArchive.addEventListener('click', () => {
        modalArchive.style.display = 'none';
    });

    modalArchive.addEventListener('click', (e) => {
        if (e.target === modalArchive) {
            modalArchive.style.display = 'none';
        }
    });

    $('#archive-search-input').addEventListener('input', (e) => {
        renderArchiveList(e.target.value);
    });

    btnArchiveSave.addEventListener('click', () => {
        archiveInvoice();
    });

    // =======================
    // Self-Update
    // =======================
    btnUpdate.addEventListener('click', async () => {
        if (!confirm('Möchtest du jetzt nach Updates suchen und diese installieren?\n\nDer Server startet dabei kurz neu.')) {
            return;
        }

        const originalContent = btnUpdate.innerHTML;
        btnUpdate.disabled = true;
        btnUpdate.innerHTML = `
            <svg class="spin" width="20" height="20" viewBox="0 0 24 24" fill="none" style="margin-right: 8px;">
                <path d="M12 4V2m0 20v-2m8-8h2M2 12h2m15.364-7.364l-1.414 1.414M6.05 17.95l-1.414 1.414M17.95 17.95l1.414 1.414M6.05 6.05L4.636 4.636" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
            Update...
        `;

        try {
            showToast('Update-Prozess gestartet...', 'info', 10000);

            const response = await fetch('/api/update', { method: 'POST' });
            const result = await response.json();

            if (result.success) {
                showToast('Update erfolgreich! Seite lädt neu...', 'success', 5000);
                // Kurze Pause, dann Reload
                setTimeout(() => {
                    window.location.reload();
                }, 3000);
            } else {
                throw new Error(result.message || 'Update fehlgeschlagen');
            }
        } catch (err) {
            console.error('Update Error:', err);
            showToast(`Update-Fehler: ${err.message}`, 'error', 10000);
            btnUpdate.disabled = false;
            btnUpdate.innerHTML = originalContent;
        }
    });

    function init() {
        // Load saved data
        loadVermieter();
        loadBank();
        loadPaperlessSettings();
        loadSmtpSettings();
        loadNukiSettings();

        // Try to restore draft first
        const draftLoaded = loadDraft();

        if (!draftLoaded) {
            // Set today's date
            $('#r-datum').value = new Date().toISOString().split('T')[0];
            $('#z-datum').value = new Date().toISOString().split('T')[0];

            // Set next invoice number
            $('#r-nummer').value = getNextRechnungsnr();

            // Add one default position
            addPosition('Übernachtung', 1, 0);
        }

        // Initial render
        updateSummary();
        updatePreview();
        updateNights();
    }

    init();

    // Add spin animation for loading
    const style = document.createElement('style');
    style.textContent = `
    @keyframes spin {
        to { transform: rotate(360deg); }
    }
    .spin {
        animation: spin 1s linear infinite;
    }
`;
    document.head.appendChild(style);

})();
