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
    const btnTestConnection = $('#btn-paperless-test');
    const btnAddTgId = $('#btn-add-tg-id');
    const btnAddWaPhone = $('#btn-add-wa-phone');
    const btnNukiPin = $('#btn-nuki-pin');
    const btnEmail = $('#btn-email');
    const btnLogout = $('#btn-logout');
    const btnUpdate = $('#btn-update-check');
    const btnSyncPaperless = $('#btn-sync-paperless');

    // Navigation Items
    const navDashboard = $('#nav-dashboard');
    const navInvoice = $('#nav-invoice');
    const navGuests = $('#nav-guests');
    const navExpenses = $('#nav-expenses');

    // View Panes
    const viewDashboard = $('#view-dashboard');
    const viewInvoiceForm = $('#view-invoice-form');
    const viewExpenses = $('#view-expenses');

    const modalSettings = $('#modal-settings');
    const toastContainer = $('#toast-container');
    const appWrapper = $('#app-wrapper');
    const loginScreen = $('#login-screen');
    const loginForm = $('#login-form');
    const updateOverlay = $('#update-overlay');
    const updateStatusText = $('#update-status-text');

    const STORAGE_KEYS = {
        vermieter: 'fw-rechnung-vermieter',
        bank: 'fw-rechnung-bank',
        rechnungsnr: 'fw-rechnung-nr',
        paperless: 'fw-rechnung-paperless',
        draft: 'fw-rechnung-draft',
        archive: 'fw-rechnung-archive',
        nuki: 'fw-rechnung-nuki',
        smtp: 'fw-rechnung-smtp',
        booking_ical: 'fw-rechnung-booking-ical'
    };

    function saveBookingSettings() {
        // Now saved as part of saveAllSettings()
    }

    function loadBookingSettings() {
        // Now loaded as part of loadAllSettings()
    }

    async function checkAuth() {
        try {
            const response = await fetch('/api/me');
            const data = await response.json();
            if (data.authenticated) {
                showApp();
            } else {
                showLogin();
            }
        } catch (err) {
            console.error('Auth check failed:', err);
            showLogin();
        }
    }

    function showLogin() {
        loginScreen.style.display = 'flex';
        appWrapper.style.display = 'none';
        appWrapper.classList.remove('authenticated');
    }

    function showApp() {
        loginScreen.style.display = 'none';
        appWrapper.style.display = 'flex';
        setTimeout(() => {
            appWrapper.classList.add('authenticated');
            updatePreviewScale();
            updatePreview();
        }, 10);
        init(); // Start the app
    }

    let loginStep = 'credentials'; // 'credentials', '2fa', 'recovery'
    let currentSessionId = null;

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = $('#login-user').value;
        const password = $('#login-pass').value;
        const code = $('#login-2fa').value;
        const recoveryKey = $('#login-recovery').value;
        const loginBtn = $('#btn-login');

        const originalBtnText = loginBtn.innerHTML;
        loginBtn.disabled = true;

        try {
            if (loginStep === 'credentials') {
                loginBtn.innerHTML = 'Anmelden...';
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await response.json();

                if (data.success) {
                    if (data.requires2fa) {
                        loginStep = '2fa';
                        currentSessionId = data.sessionId;
                        $('#group-2fa').style.display = 'block';
                        $('#login-pass').parentElement.style.display = 'none';
                        $('#login-user').disabled = true;
                        loginBtn.innerHTML = 'Code verifizieren';
                        loginBtn.disabled = false;
                    } else {
                        showAuthSuccess();
                    }
                } else {
                    showToast(data.message || 'Login fehlgeschlagen', 'error');
                }
            } else if (loginStep === '2fa') {
                loginBtn.innerHTML = 'Verifiziere...';
                const vRes = await fetch('/api/login/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: currentSessionId, code })
                });
                const vData = await vRes.json();
                if (vData.success) {
                    showAuthSuccess();
                } else {
                    showToast(vData.message || 'Falscher Code', 'error');
                    loginBtn.disabled = false;
                    loginBtn.innerHTML = 'Code verifizieren';
                }
            } else if (loginStep === 'recovery') {
                loginBtn.innerHTML = 'Wiederherstellen...';
                const rRes = await fetch('/api/login/recover', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, recoveryKey })
                });
                const rData = await rRes.json();
                if (rData.success) {
                    showAuthSuccess();
                } else {
                    showToast(rData.message || 'Ungültiger Key', 'error');
                    loginBtn.disabled = false;
                    loginBtn.innerHTML = 'Account wiederherstellen';
                }
            }
        } catch (err) {
            console.error('Login error:', err);
            showToast('Server-Fehler beim Login', 'error');
        } finally {
            if (loginBtn.disabled) {
                loginBtn.disabled = false;
                loginBtn.innerHTML = originalBtnText;
            }
        }
    });

    $('#link-show-recovery').addEventListener('click', (e) => {
        e.preventDefault();
        loginStep = 'recovery';
        $('#group-2fa').style.display = 'none';
        $('#login-pass').parentElement.style.display = 'none';
        $('#group-recovery').style.display = 'block';
        $('#btn-login').innerHTML = 'Account wiederherstellen';
        if ($('#link-show-recovery')) $('#link-show-recovery').style.display = 'none';
    });


    function showAuthSuccess() {
        showToast('Erfolgreich angemeldet!', 'success');
        showApp();
        // Reset login form
        loginStep = 'credentials';
        $('#group-2fa').style.display = 'none';
        $('#group-recovery').style.display = 'none';
        $('#login-pass')?.parentElement?.style.setProperty('display', 'block');
        $('#login-user').disabled = false;
        $('#login-user').value = '';
        $('#login-pass').value = '';
        $('#login-2fa').value = '';
        $('#login-recovery').value = '';
        $('#btn-login').innerHTML = 'Anmelden';
        if ($('#link-show-recovery')) $('#link-show-recovery').style.display = 'block';
    }

    // =======================
    // State
    // =======================
    let positions = [];
    let positionIdCounter = 0;

    // Initial Auth Check
    checkAuth();

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
        console.log('🔄 Update Preview...');
        try {
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
            const guestName = $('#g-name').value || 'Gast Name';
            $('#inv-g-name').textContent = guestName;
            $('#inv-g-adresse').innerHTML = nl2br($('#g-adresse').value);

            // Greeting (use template config if available)
            const lastName = guestName.split(' ').pop().toUpperCase();
            const greetingTemplate = currentTemplateConfig?.greeting || 'SEHR GEEHRTE/R';
            const greeting = `${greetingTemplate} ${lastName},`;
            $('#inv-greeting').textContent = greeting;

            // Intro text (use template config if available)
            const introTextElem = $('#inv-intro-text');
            if (introTextElem && currentTemplateConfig?.introText) {
                introTextElem.textContent = currentTemplateConfig.introText;
            }

            // Meta
            $('#inv-r-nummer').textContent = $('#r-nummer').value || '—';
            $('#inv-r-datum').textContent = formatDate($('#r-datum').value);

            // Location + Date in header
            const rDatum = $('#r-datum').value;
            const vAdresse = $('#v-adresse').value || '';
            // Extract city from address (assume last line or after postal code)
            const cityMatch = vAdresse.match(/\d{5}\s+(.+)/);
            const city = cityMatch ? cityMatch[1].split('\n')[0].trim() : 'Jede Stadt';
            $('#inv-location').textContent = city;
            $('#inv-r-datum-header').textContent = formatDate(rDatum) || '01.01.2030';

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
        } catch (err) {
            console.error('❌ updatePreview failed:', err);
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
        'z-methode', 'z-datum', 'z-bezahlt', 'z-show-bank'
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
    // Vermieter
    // =======================

    // =======================
    // Server-side Settings (API)
    // =======================
    async function saveAllSettings() {
        try {
            // First, load existing settings from server to preserve values not shown in UI
            const existing = await fetch('/api/settings');
            const existingData = await existing.json();
            const currentSettings = existingData.success ? existingData.settings : {};

            // Collect new values from UI, only updating what's present
            const newSettings = {
                vermieter: {
                    name: $('#v-name').value || '',
                    adresse: $('#v-adresse').value || '',
                    telefon: $('#v-telefon').value || '',
                    email: $('#v-email').value || '',
                    steuernr: $('#v-steuernr').value || ''
                },
                bank: {
                    inhaber: $('#b-inhaber').value || '',
                    iban: $('#b-iban').value || '',
                    bic: $('#b-bic').value || '',
                    bank: $('#b-bank').value || ''
                },
                paperless: {
                    url: ($('#pl-url').value || '').replace(/\/+$/, ''),
                    token: $('#pl-token').value || '',
                    correspondent: $('#pl-correspondent').value || '',
                    doctype: $('#pl-doctype').value || '',
                    tags: $('#pl-tags').value || ''
                },
                smtp: {
                    host: $('#smtp-host').value || '',
                    port: $('#smtp-port').value || '',
                    user: $('#smtp-user').value || '',
                    pass: $('#smtp-pass').value || '',
                    from: $('#smtp-from').value || ''
                },
                pricing: {
                    price_per_night: parseFloat($('#p-night').value) || 0,
                    cleaning_fee: parseFloat($('#p-cleaning').value) || 0,
                    mwst_rate: parseFloat($('#mwst-satz').value) || 0,
                    kleinunternehmer: $('#kleinunternehmer').checked
                },
                booking_ical: $('#booking-ical-url').value || '',
                paperless_expense_tag: $('#s-pl-expense-tag')?.value || '',
                paperless_amount_field: $('#s-pl-amount-field')?.value || '',
                nuki: {
                    token: $('#nuki-token').value || '',
                    lockId: $('#nuki-lock-id').value || ''
                },
                tg_token: $('#tg-token').value || '',
                reminder_days: $('#reminder-days').value || '2',
                notifications_enabled: $('#notifications-enabled')?.checked !== false ? 'true' : 'false',
                twofactor_enabled: $('#twofactor-enabled').checked ? 'true' : 'false'
            };

            // Only update wa_phones and tg_ids if inputs are present in DOM
            const waInputs = document.querySelectorAll('.wa-phone-input');
            if (waInputs.length > 0) {
                newSettings.wa_phones = JSON.stringify(Array.from(waInputs).map(i => i.value.trim()).filter(v => v));
            }
            const tgInputs = document.querySelectorAll('.tg-id-input');
            if (tgInputs.length > 0) {
                newSettings.tg_ids = JSON.stringify(Array.from(tgInputs).map(i => i.value.trim()).filter(v => v));
            }

            // Merge with existing settings - keep existing keys not in newSettings
            const settings = { ...currentSettings, ...newSettings };

            const res = await fetch('/api/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings })
            });
            const data = await res.json();
            if (data.success) {
                showToast('Einstellungen gespeichert!', 'success');
            } else {
                showToast('Fehler beim Speichern', 'error');
            }
        } catch (e) {
            console.error('Settings save error:', e);
            showToast('Server-Fehler beim Speichern', 'error');
        }
    }

    async function loadAllSettings() {
        try {
            const res = await fetch('/api/settings');
            const data = await res.json();
            if (!data.success || !data.settings) return;
            const s = data.settings;

            // Vermieter
            if (s.vermieter) {
                const v = typeof s.vermieter === 'string' ? JSON.parse(s.vermieter) : s.vermieter;
                if (v.name) $('#v-name').value = v.name;
                if (v.adresse) $('#v-adresse').value = v.adresse;
                if (v.telefon) $('#v-telefon').value = v.telefon;
                if (v.email) $('#v-email').value = v.email;
                if (v.steuernr) $('#v-steuernr').value = v.steuernr;
            }
            // Bank
            if (s.bank) {
                const b = typeof s.bank === 'string' ? JSON.parse(s.bank) : s.bank;
                if (b.inhaber) $('#b-inhaber').value = b.inhaber;
                if (b.iban) $('#b-iban').value = b.iban;
                if (b.bic) $('#b-bic').value = b.bic;
                if (b.bank) $('#b-bank').value = b.bank;
            }
            // Paperless
            if (s.paperless) {
                const p = typeof s.paperless === 'string' ? JSON.parse(s.paperless) : s.paperless;
                if (p.url) $('#pl-url').value = p.url;
                if (p.token) $('#pl-token').value = p.token;
                if (p.correspondent) $('#pl-correspondent').value = p.correspondent;
                if (p.doctype) $('#pl-doctype').value = p.doctype;
                if (p.tags) $('#pl-tags').value = p.tags;
            }
            // SMTP
            if (s.smtp) {
                const m = typeof s.smtp === 'string' ? JSON.parse(s.smtp) : s.smtp;
                if (m.host) $('#smtp-host').value = m.host;
                if (m.port) $('#smtp-port').value = m.port;
                if (m.user) $('#smtp-user').value = m.user;
                if (m.pass) $('#smtp-pass').value = m.pass;
                if (m.from) $('#smtp-from').value = m.from;
            }
            // Nuki
            if (s.nuki) {
                const n = typeof s.nuki === 'string' ? JSON.parse(s.nuki) : s.nuki;
                if (n.token) $('#nuki-token').value = n.token;
                if (n.lockId) $('#nuki-lock-id').value = n.lockId;
            }

            // Pricing
            if (s.pricing) {
                const p = typeof s.pricing === 'string' ? JSON.parse(s.pricing) : s.pricing;
                if (p.price_per_night) $('#p-night').value = p.price_per_night;
                if (p.cleaning_fee) $('#p-cleaning').value = p.cleaning_fee;
                if (p.mwst_rate) $('#mwst-satz').value = p.mwst_rate;
                if (p.kleinunternehmer) $('#kleinunternehmer').checked = p.kleinunternehmer;
            }
            // Booking iCal
            if (s.booking_ical) {
                const url = typeof s.booking_ical === 'string' && s.booking_ical.startsWith('{') ? JSON.parse(s.booking_ical) : s.booking_ical;
                if (typeof url === 'string') $('#booking-ical-url').value = url;
            }
            if (s.paperless_expense_tag) $('#s-pl-expense-tag').value = s.paperless_expense_tag;
            if (s.paperless_amount_field) $('#s-pl-amount-field').value = s.paperless_amount_field;
            // Notifications
            const container = $('#wa-phones-container');
            container.innerHTML = '';
            let phones = [];
            const rawPhones = s.wa_phones;
            if (Array.isArray(rawPhones)) {
                phones = rawPhones;
            } else {
                try { phones = JSON.parse(rawPhones || '[]'); } catch (e) {
                    if (s.wa_phone) phones = [s.wa_phone];
                }
            }
            if (phones.length === 0) addWaPhoneRow('');
            else phones.forEach(p => addWaPhoneRow(p));

            if (s.reminder_days) $('#reminder-days').value = s.reminder_days;

            // Telegram
            if (s.tg_token) $('#tg-token').value = s.tg_token;
            const tgContainer = $('#tg-ids-container');
            if (tgContainer) {
                tgContainer.innerHTML = '';
                let tgIds = [];
                const rawTgIds = s.tg_ids;
                if (Array.isArray(rawTgIds)) {
                    tgIds = rawTgIds.map(String);
                } else {
                    try { tgIds = JSON.parse(rawTgIds || '[]'); } catch (e) {
                        if (s.tg_id) tgIds = [s.tg_id];
                    }
                }
                if (tgIds.length === 0) addTgIdRow('');
                else tgIds.forEach(id => addTgIdRow(id));
            }

            if (s.notifications_enabled !== undefined) {
                if ($('#notifications-enabled')) $('#notifications-enabled').checked = s.notifications_enabled !== 'false';
            }
            if (s.twofactor_enabled !== undefined) {
                $('#twofactor-enabled').checked = s.twofactor_enabled !== 'false';
            }

            loadUsers(); // Refresh user list
            loadVersion(); // Load app version
        } catch (e) {
            console.error('Settings load error:', e);
        }
    }

    async function loadVersion() {
        try {
            const res = await fetch('/api/version');
            const data = await res.json();
            if (data.success && data.version) {
                const versionEl = $('#app-version');
                if (versionEl) {
                    versionEl.textContent = `Version ${data.version}`;
                }
                const currentVersionEl = $('#current-version');
                if (currentVersionEl) {
                    currentVersionEl.textContent = data.version;
                }
            }
        } catch (e) {
            console.error('Version load error:', e);
        }
    }

    // Legacy compatibility shims
    function saveVermieter() { saveAllSettings(); }
    function loadVermieter() { /* loaded via loadAllSettings */ }
    function saveBank() { saveAllSettings(); }
    function loadBank() { /* loaded via loadAllSettings */ }
    function savePaperlessSettings() { /* saved via saveAllSettings */ }
    function loadPaperlessSettings() { /* loaded via loadAllSettings */ }
    function saveSmtpSettings() { /* saved via saveAllSettings */ }
    function loadSmtpSettings() { /* loaded via loadAllSettings */ }
    function saveNukiSettings() { /* saved via saveAllSettings */ }
    function loadNukiSettings() { /* loaded via loadAllSettings */ }

    // WhatsApp Status Polling
    let waStatusInterval = null;

    async function pollWhatsAppStatus() {
        try {
            const res = await fetch('/api/whatsapp/qr');
            const data = await res.json();
            const dot = $('#wa-status-dot');
            const text = $('#wa-status-text');
            const qrGroup = $('#wa-qr-group');
            const qrImage = $('#wa-qr-image');

            if (data.status === 'ready') {
                if (dot) { dot.className = 'badge online'; dot.textContent = 'Online'; }
                if (text) text.textContent = 'Verbunden';
                if (qrGroup) qrGroup.style.display = 'none';
            } else if (data.status === 'qr_pending' && data.qr) {
                if (dot) { dot.className = 'badge'; dot.textContent = 'Verbinde...'; }
                if (text) text.textContent = 'QR-Code scannen';
                if (qrGroup) qrGroup.style.display = 'block';
                if (qrImage) qrImage.src = data.qr;
            } else {
                if (dot) { dot.className = 'badge'; dot.textContent = 'Offline'; }
                if (text) text.textContent = 'Offline';
                if (qrGroup) qrGroup.style.display = 'none';
            }
        } catch (e) {
            console.error('WA Status Error:', e);
        }
    }

    // Telegram Status Polling
    let tgStatusInterval = null;

    async function pollTelegramStatus() {
        try {
            const res = await fetch('/api/telegram/status');
            const data = await res.json();
            const dot = $('#tg-status-dot');
            const text = $('#tg-status-text');

            if (data.status === 'online') {
                if (dot) { dot.className = 'badge online'; dot.textContent = 'Online'; }
                if (text) {
                    if (data.botInfo && data.botInfo.username) {
                        text.textContent = `Verbunden (@${data.botInfo.username})`;
                    } else {
                        text.textContent = 'Verbunden';
                    }
                }
            } else {
                if (dot) { dot.className = 'badge'; dot.textContent = 'Offline'; }
                if (text) text.textContent = 'Offline';
            }
        } catch (e) {
            console.error('Telegram Status Error:', e);
            const dot = $('#tg-status-dot');
            const text = $('#tg-status-text');
            if (dot) { dot.className = 'badge'; dot.textContent = 'Offline'; }
            if (text) text.textContent = 'Offline';
        }
    }

    // Start polling when settings modal opens
    let tgRequestInterval = null;
    if (modalSettings) {
        const observer = new MutationObserver(() => {
            if (modalSettings.style.display !== 'none') {
                // Clear any previous intervals before starting new ones
                clearInterval(waStatusInterval);
                clearInterval(tgStatusInterval);
                clearInterval(tgRequestInterval);

                pollWhatsAppStatus();
                waStatusInterval = setInterval(pollWhatsAppStatus, 5000);

                pollTelegramStatus();
                tgStatusInterval = setInterval(pollTelegramStatus, 5000);

                loadTelegramRequests();
                tgRequestInterval = setInterval(loadTelegramRequests, 8000);
            } else {
                clearInterval(waStatusInterval);
                clearInterval(tgStatusInterval);
                clearInterval(tgRequestInterval);
                waStatusInterval = null;
                tgStatusInterval = null;
                tgRequestInterval = null;
            }
        });
        observer.observe(modalSettings, { attributes: true, attributeFilter: ['style'] });
    }


    // --- NEW: Multi-Number Support ---
    function addWaPhoneRow(val = '') {
        const container = $('#wa-phones-container');
        if (!container) return;
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '0.5rem';
        row.style.alignItems = 'center';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'wa-phone-input';
        input.placeholder = '+4917612345678';
        input.value = val;
        input.style.flex = '1';
        container.appendChild(row);
        row.appendChild(input);

        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className = 'btn btn-ghost btn-danger btn-sm';
        btnDel.innerHTML = '\u2715';
        btnDel.onclick = () => row.remove();
        row.appendChild(btnDel);
    }

    function addTgIdRow(val = '') {
        const container = $('#tg-ids-container');
        if (!container) return;
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.gap = '0.5rem';
        row.style.alignItems = 'center';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tg-id-input';
        input.placeholder = '123456789';
        input.value = val;
        input.style.flex = '1';
        container.appendChild(row);
        row.appendChild(input);

        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className = 'btn btn-ghost btn-danger btn-sm';
        btnDel.innerHTML = '\u2715';
        btnDel.onclick = () => row.remove();
        row.appendChild(btnDel);
    }

    if (btnAddWaPhone) btnAddWaPhone.addEventListener('click', () => addWaPhoneRow(''));
    if (btnAddTgId) btnAddTgId.addEventListener('click', () => addTgIdRow(''));

    // --- NEW: User Management Support ---
    async function loadUsers() {
        const container = $('#users-list-container');
        if (!container) return;

        try {
            const res = await fetch('/api/users');
            const data = await res.json();
            if (!data.success) {
                container.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;">Nur Admins können Benutzer verwalten.</p>';
                return;
            }

            container.innerHTML = '';
            data.users.forEach(user => {
                const div = document.createElement('div');
                div.className = 'card';
                div.style.marginBottom = '0.5rem';
                div.style.padding = '0.75rem';
                div.style.display = 'flex';
                div.style.justifyContent = 'space-between';
                div.style.alignItems = 'center';

                div.innerHTML = `
                    <div style="flex:1">
                        <strong>${user.username}</strong> (${user.role})<br>
                        <small>📱 2FA: ${user.phone || 'Nicht gesetzt'}</small><br>
                        <small style="color:var(--primary-color);">🔑 Recovery: <code>${user.recovery_key || '---'}</code></small>
                    </div>
                    <div style="display: flex; gap: 0.5rem;">
                        <button class="btn btn-outline btn-sm edit-user-btn" data-id="${user.id}">Edit</button>
                        <button class="btn btn-outline btn-sm delete-user-btn" data-id="${user.id}" style="color:red;">Del</button>
                    </div>
                `;

                div.querySelector('.edit-user-btn').onclick = () => editUser(user);
                div.querySelector('.delete-user-btn').onclick = () => deleteUser(user.id, user.username);

                container.appendChild(div);
            });
        } catch (e) {
            console.error('User list error:', e);
            container.innerHTML = '<p>Fehler beim Laden der Benutzer.</p>';
        }
    }

    async function editUser(user) {
        const phone = prompt(`Handy-Nummer für 2FA ändern (Username: ${user.username}):`, user.phone || '');
        if (phone === null) return;
        const pass = prompt(`Neues Passwort (leer lassen um nicht zu ändern):`);
        if (pass === null) return;

        try {
            const res = await fetch(`/api/users/${user.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: user.username, role: user.role, phone, password: pass || undefined })
            });
            const data = await res.json();
            if (data.success) {
                showToast('Benutzer aktualisiert!', 'success');
                loadUsers();
            }
        } catch (e) { showToast('Fehler', 'error'); }
    }

    async function deleteUser(id, username) {
        if (username === 'admin') return showToast('Admin kann nicht gelöscht werden', 'error');
        if (!confirm(`Benutzer "${username}" wirklich löschen?`)) return;
        try {
            const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
            if ((await res.json()).success) {
                showToast('Benutzer gelöscht', 'success');
                loadUsers();
            }
        } catch (e) { showToast('Fehler', 'error'); }
    }

    if ($('#btn-add-user-modal')) {
        $('#btn-add-user-modal').addEventListener('click', async () => {
            const username = prompt('Neuer Benutzername:');
            if (!username) return;
            const password = prompt('Passwort:');
            if (!password) return;
            const phone = prompt('Handy-Nummer für 2FA (+49...):', '');

            try {
                const res = await fetch('/api/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password, role: 'admin', phone })
                });
                const data = await res.json();
                if (data.success) {
                    showToast('Benutzer erstellt!', 'success');
                    loadUsers();
                } else {
                    showToast(data.error || 'Fehler', 'error');
                }
            } catch (e) { showToast('Fehler', 'error'); }
        });
    }

    // WhatsApp test button
    const btnTestWhatsApp = $('#btn-test-whatsapp');
    if (btnTestWhatsApp) {
        btnTestWhatsApp.addEventListener('click', async () => {
            btnTestWhatsApp.disabled = true;
            btnTestWhatsApp.textContent = 'Sende...';
            try {
                const res = await fetch('/api/notifications/test-whatsapp', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    showToast(data.message, 'success');
                } else {
                    showToast(data.error || 'Fehler', 'error');
                }
            } catch (e) {
                showToast('Verbindungsfehler', 'error');
            } finally {
                btnTestWhatsApp.disabled = false;
                btnTestWhatsApp.textContent = 'WhatsApp testen';
            }
        });
    }

    // WhatsApp logout button
    const btnWaLogout = $('#btn-wa-logout');
    if (btnWaLogout) {
        btnWaLogout.addEventListener('click', async () => {
            if (!confirm('WhatsApp-Verbindung trennen? Du musst danach den QR-Code erneut scannen.')) return;
            btnWaLogout.disabled = true;
            try {
                const res = await fetch('/api/whatsapp/logout', { method: 'POST' });
                const data = await res.json();
                showToast(data.message || 'WhatsApp getrennt', 'success');
                // Start polling for new QR
                setTimeout(pollWhatsAppStatus, 3000);
            } catch (e) {
                showToast('Fehler beim Trennen', 'error');
            } finally {
                btnWaLogout.disabled = false;
            }
        });
    }

    function getNextRechnungsnr() {
        const currentYear = new Date().getFullYear();
        // Still use localStorage for invoice counter (local, sequential)
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
    // =======================
    // Invoice Archive (Server API)
    // =======================
    let cachedArchive = [];

    async function fetchArchive() {
        try {
            const res = await fetch('/api/invoices');
            const data = await res.json();
            if (data.success) {
                cachedArchive = data.invoices.map(inv => {
                    const d = (typeof inv.data === 'string' ? JSON.parse(inv.data || '{}') : inv.data) || {};
                    return {
                        ...d,
                        _dbId: inv.id,
                        guestId: inv.guest_id,
                        // DB column is the authoritative total — always keep it as fallback
                        totalAmount: d.totalAmount || inv.total_amount || 0
                    };
                });
            }
        } catch (e) {
            console.error('Fetch archive error:', e);
        }
        return cachedArchive;
    }

    function getArchive() {
        return cachedArchive;
    }

    async function archiveInvoice() {
        const nummer = $('#r-nummer').value;
        const gastName = $('#g-name').value;
        if (!nummer) {
            showToast('Rechnungsnummer erforderlich zum Archivieren', 'error');
            return false;
        }

        const invoiceData = {
            ...collectFormData(),
            vName: $('#v-name').value,
            vAdresse: $('#v-adresse').value,
            vTelefon: $('#v-telefon').value,
            vEmail: $('#v-email').value,
            vSteuernr: $('#v-steuernr').value,
            bInhaber: $('#b-inhaber').value,
            bIban: $('#b-iban').value,
            bBic: $('#b-bic').value,
            bBank: $('#b-bank').value,
            totalAmount: getSubtotal() * (1 + getMwstRate() / 100),
            archivedAt: new Date().toISOString()
        };

        try {
            const res = await fetch('/api/invoices', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(invoiceData)
            });
            const data = await res.json();
            if (data.success) {
                showToast(`Rechnung ${nummer} ${data.message}`, 'success');
                await fetchArchive();
                loadDashboard(); // Refresh stats after archiving
                return true;
            } else {
                showToast('Fehler beim Archivieren', 'error');
                return false;
            }
        } catch (e) {
            console.error('Archive error:', e);
            showToast('Server-Fehler beim Archivieren', 'error');
            return false;
        }
    }

    // =======================
    // View Switcher
    // =======================
    let currentView = 'dashboard';
    let viewPollInterval = null;

    function startViewPolling(viewId) {
        clearInterval(viewPollInterval);
        viewPollInterval = null;
        const POLL_MS = 20000;
        if (viewId === 'dashboard') {
            viewPollInterval = setInterval(loadDashboard, POLL_MS);
        } else if (viewId === 'expenses') {
            viewPollInterval = setInterval(loadExpenses, POLL_MS);
        }
        // 'invoice' view has no background data to poll
    }

    function switchView(viewId) {
        const views = [viewDashboard, viewInvoiceForm, viewExpenses];
        const navItems = [navDashboard, navInvoice, navGuests, navExpenses];

        views.forEach(v => {
            if (v) v.style.display = 'none';
        });
        navItems.forEach(n => {
            if (n) n.classList.remove('active');
        });

        currentView = viewId;

        if (viewId === 'dashboard') {
            viewDashboard.style.display = 'flex';
            navDashboard.classList.add('active');
            loadDashboard();
        } else if (viewId === 'invoice') {
            viewInvoiceForm.style.display = 'flex';
            navInvoice.classList.add('active');
            updatePreview();
        } else if (viewId === 'expenses') {
            viewExpenses.style.display = 'flex';
            navExpenses.classList.add('active');
            loadExpenses();
        }

        startViewPolling(viewId);

        // Close mobile sidebar if open
        if (window.innerWidth <= 768) {
            appWrapper.classList.remove('sidebar-open');
        }
    }

    navDashboard.addEventListener('click', () => switchView('dashboard'));
    navInvoice.addEventListener('click', () => switchView('invoice'));
    navExpenses.addEventListener('click', () => switchView('expenses'));


    // =======================
    // Dashboard Module
    // =======================
    let revenueChart = null;

    async function loadDashboard() {
        try {
            const res = await fetch('/api/stats');
            const data = await res.json();
            if (!data.success) return;

            const s = data.stats;

            // Totals
            $('#stat-total-revenue').textContent = formatCurrency(s.totals.total_revenue || 0);
            $('#stat-total-expenses').textContent = formatCurrency(s.totals.total_expenses || 0);
            $('#stat-net-income').textContent = formatCurrency((s.totals.total_revenue || 0) - (s.totals.total_expenses || 0));
            $('#stat-invoice-count').textContent = s.totals.invoice_count;

            // Top Guests
            const list = $('#top-guests-list');
            list.innerHTML = '';
            if (s.topGuests && s.topGuests.length > 0) {
                s.topGuests.forEach(g => {
                    const li = document.createElement('li');
                    li.className = 'top-guest-item';
                    li.innerHTML = `
                        <span class="top-guest-name">${escapeHtml(g.guest_name)} (${g.count} Rechnungen)</span>
                        <span class="top-guest-total">${formatCurrency(g.total)}</span>
                    `;
                    list.appendChild(li);
                });
            } else {
                list.innerHTML = '<li class="text-muted">Noch keine Daten vorhanden</li>';
            }

            renderRevenueChart(s.revenueByMonth, s.expensesByMonth);

        } catch (e) {
            console.error('Stats load error:', e);
        }
    }

    function renderRevenueChart(revenueData, expenseData) {
        const ctx = $('#revenueChart').getContext('2d');

        // Merge months to ensure alignment
        const months = [...new Set([
            ...revenueData.map(d => d.month),
            ...expenseData.map(d => d.month)
        ])].sort();

        const revValues = months.map(m => {
            const d = revenueData.find(x => x.month === m);
            return d ? d.total : 0;
        });

        const expValues = months.map(m => {
            const d = expenseData.find(x => x.month === m);
            return d ? d.total : 0;
        });

        window.myRevenueChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: months.map(m => {
                    const [y, mm] = m.split('-');
                    const date = new Date(y, parseInt(mm) - 1, 1);
                    return date.toLocaleString('de-DE', { month: 'short', year: '2-digit' });
                }),
                datasets: [
                    {
                        label: 'Umsatz',
                        data: revValues,
                        backgroundColor: 'rgba(99, 102, 241, 0.8)',
                        borderRadius: 4
                    },
                    {
                        label: 'Ausgaben',
                        data: expValues,
                        backgroundColor: 'rgba(239, 68, 68, 0.8)',
                        borderRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: (val) => val.toLocaleString('de-DE') + ' €'
                        }
                    }
                },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { usePointStyle: true, boxWidth: 6 }
                    }
                }
            }
        });
    }

    // =======================
    // Expenses Module
    // =======================
    async function loadExpenses() {
        try {
            const res = await fetch('/api/expenses');
            const data = await res.json();
            if (data.success) {
                renderExpensesList(data.expenses);
            }
        } catch (e) {
            console.error('Expenses load error:', e);
        }
    }

    function renderExpensesList(expenses) {
        const list = $('#expenses-list');
        list.innerHTML = '';

        if (expenses.length === 0) {
            list.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Keine Ausgaben vorhanden.</td></tr>';
            return;
        }

        expenses.forEach(ex => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${formatDate(ex.date)}</td>
                <td>${escapeHtml(ex.description || '—')}</td>
                <td>${escapeHtml(ex.category || '—')}</td>
                <td><span class="source-badge source-${ex.source}">${ex.source === 'paperless' ? 'Paperless' : 'Manuell'}</span></td>
                <td class="text-right expense-amount negative">${formatCurrency(ex.amount)}</td>
                <td class="text-right">
                    <button class="btn btn-ghost btn-danger btn-sm btn-delete-expense" data-id="${ex.id}" title="Löschen">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                    </button>
                </td>
            `;
            list.appendChild(tr);
        });

        // Delete event listeners
        $$('.btn-delete-expense').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Ausgabe wirklich löschen?')) return;
                const id = btn.dataset.id;
                try {
                    const res = await fetch(`/api/expenses/${id}`, { method: 'DELETE' });
                    const d = await res.json();
                    if (d.success) {
                        showToast('Ausgabe gelöscht');
                        loadExpenses();
                    }
                } catch (e) { console.error(e); }
            });
        });
    }

    async function syncPaperlessExpenses() {
        const btn = $('#btn-sync-paperless');
        const originalText = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="update-spinner" style="width:14px; height:14px; border-width:2px;"></span> Sync läuft...';

        try {
            const res = await fetch('/api/expenses/sync', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showToast(data.message);
                loadExpenses();
            } else {
                showToast(data.error || 'Sync fehlgeschlagen', 'error');
            }
        } catch (e) {
            console.error('Sync error:', e);
            showToast('Server-Fehler beim Sync', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }

    btnSyncPaperless.addEventListener('click', syncPaperlessExpenses);


    async function loadArchivedInvoiceById(dbId) {
        if (!dbId) return;
        if (cachedArchive.length === 0) await fetchArchive();
        const index = cachedArchive.findIndex(inv => String(inv._dbId) === String(dbId));
        if (index === -1) {
            showToast('Rechnung nicht im Archiv gefunden', 'error');
            return;
        }
        loadArchivedInvoice(index);
        // Close guests modal and switch to invoice form
        const modalGuests = $('#modal-guests');
        if (modalGuests) modalGuests.style.display = 'none';
        switchView('invoice');
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
        updateNights();

        // Restore Nuki PIN from archived data
        if (d.nukiPin) {
            $('#nuki-pin-result').style.display = 'block';
            $('#nuki-pin-code').textContent = d.nukiPin;
        } else {
            $('#nuki-pin-result').style.display = 'none';
        }

        updatePreview();
        saveDraft();

        showToast(`Rechnung ${d.rNummer} geladen`);
    }


    async function downloadArchivedPdf(dbId, rNummer) {
        if (!dbId) { showToast('Keine Rechnungs-ID', 'error'); return; }
        try {
            showToast('PDF wird generiert...', 'info');
            const res = await fetch(`/api/invoices/${dbId}/pdf`);
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Unbekannter Fehler' }));
                showToast('PDF Fehler: ' + (err.error || res.statusText), 'error');
                return;
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Rechnung-${rNummer || dbId}.pdf`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            showToast('Download fehlgeschlagen: ' + e.message, 'error');
        }
    }

    // =======================
    // Settings Modal
    // =======================
    btnSettings.addEventListener('click', () => {
        modalSettings.style.display = 'flex';
        loadChangelog();
        loadTelegramRequests();
    });

    const settingsModal = $('.settings-modal');

    btnCloseSettings.addEventListener('click', () => {
        modalSettings.style.display = 'none';
        settingsModal.classList.remove('designer-active');
    });

    modalSettings.addEventListener('click', (e) => {
        if (e.target === modalSettings) {
            modalSettings.style.display = 'none';
            settingsModal.classList.remove('designer-active');
        }
    });

    btnSaveSettings.addEventListener('click', async () => {
        await saveAllSettings();
        await saveBranding();
        modalSettings.style.display = 'none';
        settingsModal.classList.remove('designer-active');
    });

    // Settings Sidebar Navigation
    document.querySelectorAll('.settings-sidebar .nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = item.dataset.target;
            const targetPage = $('#' + targetId);
            const pageTitle = item.textContent;

            if (targetPage) {
                // Update Sidebar
                item.closest('.sidebar-nav').querySelectorAll('.nav-item').forEach(nav => nav.classList.remove('active'));
                item.classList.add('active');

                // Update Content
                document.querySelectorAll('.settings-page').forEach(page => page.classList.remove('active'));
                targetPage.classList.add('active');

                // Update Breadcrumbs
                const bcPage = $('#settings-current-page');
                if (bcPage) bcPage.textContent = pageTitle;

                // Toggle larger modal for designer
                if (targetId === 'settings-invoice-designer') {
                    settingsModal.classList.add('designer-active');
                    loadTemplateConfig();
                    updateTemplatePreview();
                } else {
                    settingsModal.classList.remove('designer-active');
                }
            }
        });
    });

    // Helper to switch to a specific settings page
    function openSettingsPage(pageId) {
        const item = $(`.nav-item[data-target="settings-${pageId}"]`);
        if (item) item.click();
    }

    // =======================
    // Sidebar Toggle (Mobile)
    // =======================
    const sidebar = $('#sidebar');
    const btnHamburger = $('#btn-hamburger');

    if (btnHamburger) {
        btnHamburger.addEventListener('click', () => {
            sidebar.classList.toggle('open');
            // Create/toggle overlay
            let overlay = document.querySelector('.sidebar-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'sidebar-overlay';
                document.body.appendChild(overlay);
                overlay.addEventListener('click', () => {
                    sidebar.classList.remove('open');
                    overlay.classList.remove('active');
                });
            }
            overlay.classList.toggle('active');
        });
    }

    // Close sidebar when clicking a nav item on mobile
    document.querySelectorAll('.sidebar-item').forEach(item => {
        item.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                sidebar.classList.remove('open');
                const overlay = document.querySelector('.sidebar-overlay');
                if (overlay) overlay.classList.remove('active');
            }
        });
    });

    // =======================
    // Booking Toggle (collapsible)
    // =======================
    const bookingToggle = $('#booking-toggle');
    const bookingBody = $('#booking-body');

    if (bookingToggle && bookingBody) {
        bookingToggle.addEventListener('click', () => {
            const isOpen = bookingBody.style.display !== 'none';
            bookingBody.style.display = isOpen ? 'none' : 'block';
            bookingToggle.classList.toggle('open', !isOpen);
        });
    }

    // =======================
    // Preview Scale
    // =======================
    function updatePreviewScale() {
        const previewColumn = $('#preview-panel');
        if (!previewColumn) return;
        const availableWidth = previewColumn.clientWidth - 4; // 4px for border/padding
        if (availableWidth <= 0) return;
        const pageWidthMm = 210; // A4 width in mm
        const pageWidthPx = pageWidthMm * 3.7795; // mm to px (~793.7px)
        const scale = Math.max(availableWidth / pageWidthPx, 0.15); // no max cap, just a minimum
        document.documentElement.style.setProperty('--preview-scale', scale);
    }

    // Initial scaling on load (will be 0 if hidden, but we catch it in showApp)
    updatePreviewScale();
    window.addEventListener('resize', updatePreviewScale);

    async function createNukiPin() {
        const fromDate = $('#a-anreise').value;
        const toDate = $('#a-abreise').value;
        const guestName = $('#g-name').value || 'Gast';

        if (!fromDate || !toDate) {
            showToast('Bitte Anreise- und Abreisedatum wählen!', 'error');
            return;
        }

        btnNukiPin.disabled = true;
        btnNukiPin.textContent = 'Generiere PIN...';

        try {
            const response = await fetch('/api/nuki/create-pin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ arrival: fromDate, departure: toDate, guestName })
            });

            const data = await response.json();

            if (data.success) {
                $('#nuki-pin-result').style.display = 'block';
                $('#nuki-pin-code').textContent = data.pin;
                showToast('Keypad-PIN erfolgreich generiert! 🔑', 'success');
                updatePreview();
                scheduleDraftSave();
            } else {
                showToast(`Nuki Fehler: ${data.details || data.error || 'Unbekannt'}`, 'error');
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
            // Updated: Use server-side proxy route instead of CORS proxy
            const response = await fetch('/api/nuki/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, lockId })
            });

            if (response.ok) {
                const data = await response.json();
                showToast(`Nuki-Verbindung erfolgreich! Lock: ${data.name} ✓`, 'success');
            } else {
                const err = await response.json();
                showToast(`Nuki-Fehler: ${err.error || response.statusText}`, 'error');
            }
        } catch (err) {
            showToast(`Nuki-Verbindungsfehler: ${err.message}`, 'error');
        } finally {
            btnNukiTest.disabled = false;
            btnNukiTest.textContent = 'Verbindung testen';
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
    btnReset.addEventListener('click', async () => {
        if (!confirm('Möchtest du wirklich alle Rechnungsdaten zurücksetzen?\n\n(Gespeicherte Vermieter- und Bankdaten bleiben erhalten.)')) {
            return;
        }

        // Delete Nuki PIN if one was generated
        const nukiPinResult = $('#nuki-pin-result');
        const nukiPinCode = $('#nuki-pin-code').textContent;
        if (nukiPinResult.style.display !== 'none' && nukiPinCode && nukiPinCode !== '——-') {
            try {
                const res = await fetch('/api/nuki/delete-pin-by-code', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pin: nukiPinCode })
                });
                const data = await res.json();
                if (data.success) {
                    console.log('Nuki PIN beim Reset gelöscht:', nukiPinCode);
                }
            } catch (e) {
                console.warn('Nuki PIN Löschung beim Reset fehlgeschlagen:', e.message);
            }
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

        // Clear Nuki PIN display
        nukiPinResult.style.display = 'none';
        $('#nuki-pin-code').textContent = '——-';

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
    // Booking.com Integration
    // =======================
    const btnBookingParse = $('#btn-booking-parse');
    const btnBookingCalendar = $('#btn-booking-calendar');
    const bookingPasteArea = $('#booking-smart-paste');
    const calendarView = $('#booking-calendar-view');
    const eventsList = $('#booking-events-list');

    // iCal Fetching
    if (btnBookingCalendar) {
        btnBookingCalendar.addEventListener('click', async () => {
            const url = localStorage.getItem(STORAGE_KEYS.booking_ical);
            if (!url) {
                showToast('Bitte iCal-Link in den Einstellungen hinterlegen', 'error');
                modalSettings.style.display = 'flex';
                return;
            }

            try {
                btnBookingCalendar.disabled = true;
                btnBookingCalendar.textContent = 'Lade...';

                const response = await fetch('/api/calendar/fetch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                const data = await response.json();

                if (data.success && data.events.length > 0) {
                    calendarView.style.display = 'block';
                    eventsList.innerHTML = '';

                    data.events.slice(0, 10).forEach(ev => {
                        const dateRange = `${new Date(ev.start).toLocaleDateString('de-DE')} - ${new Date(ev.end).toLocaleDateString('de-DE')}`;
                        const div = document.createElement('div');
                        div.className = 'calendar-event';
                        div.style = 'padding: 8px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.2s;';
                        div.innerHTML = `
                            <strong>${ev.summary}</strong><br>
                            <small>${dateRange}</small>
                        `;
                        div.addEventListener('mouseover', () => div.style.background = 'var(--bg-secondary)');
                        div.addEventListener('mouseout', () => div.style.background = 'transparent');
                        div.addEventListener('click', () => {
                            $('#a-anreise').value = new Date(ev.start).toISOString().split('T')[0];
                            $('#a-abreise').value = new Date(ev.end).toISOString().split('T')[0];
                            updateNights();
                            showToast('Daten übernommen!');
                        });
                        eventsList.appendChild(div);
                    });
                } else {
                    showToast('Keine Buchungen gefunden', 'error');
                }
            } catch (err) {
                showToast('Fehler beim Kalender-Abruf', 'error');
            } finally {
                btnBookingCalendar.disabled = false;
                btnBookingCalendar.textContent = 'Kalender laden';
            }
        });
    }

    // Smart Parsing
    if (btnBookingParse) {
        btnBookingParse.addEventListener('click', () => {
            const text = bookingPasteArea.value.trim();
            if (!text) return;

            let name = '';
            const lines = text.split('\n').map(l => l.trim()).filter(l => l);
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('Name des Gasts')) {
                    name = lines[i + 1] || '';
                    break;
                }
            }

            const priceMatch = text.match(/Gesamtpreis\s*€\s*(\d+)/i);
            const nrMatch = text.match(/Buchungsnummer:\s*(\d+)/i);
            const addressMatch = text.match(/([^\n]*\d{5}\s+[^\n]*)/);

            if (name) $('#g-name').value = name;
            if (nrMatch) $('#r-hinweis').value = `Booking-Nr: ${nrMatch[1]}`;
            if (priceMatch) {
                positions = [{ id: ++positionIdCounter, desc: 'Übernachtung (Booking.com)', qty: 1, price: parseFloat(priceMatch[1]) }];
                renderPositions();
            }
            if (addressMatch) $('#g-adresse').value = addressMatch[0];

            if (name || priceMatch) {
                showToast('Daten extrahiert!', 'success');
                bookingPasteArea.value = '';
                updateSummary();
                updatePreview();
            }
        });
    }

    // =======================
    // Save Buttons
    // =======================
    if (btnSaveVermieter) btnSaveVermieter.addEventListener('click', saveVermieter);
    if (btnSaveBank) btnSaveBank.addEventListener('click', saveBank);

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

    // =======================
    // Logout
    // =======================
    btnLogout.addEventListener('click', async () => {
        if (!confirm('Möchtest du dich wirklich abmelden?')) return;
        try {
            await fetch('/api/logout', { method: 'POST' });
        } catch (e) { /* ignore */ }
        loginScreen.style.display = 'flex';
        appWrapper.style.display = 'none';
        showToast('Erfolgreich abgemeldet', 'info');
    });

    // =======================
    // Changelog
    // =======================
    async function loadChangelog() {
        const container = $('#changelog-container');
        const versionLabel = $('#current-version');
        if (!container) return;

        try {
            const res = await fetch('/api/changelog');
            const data = await res.json();
            if (!data.success) throw new Error();

            if (versionLabel) versionLabel.textContent = `Version: ${data.currentVersion}`;

            container.innerHTML = '';
            data.releases.forEach((release, i) => {
                const div = document.createElement('div');
                div.style.cssText = `margin-bottom: 1rem; padding-bottom: 1rem; ${i < data.releases.length - 1 ? 'border-bottom: 1px solid var(--border-color);' : ''}`;
                div.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                        <strong style="color: var(--primary-color);">${release.version}</strong>
                        <small style="color: var(--text-muted);">${release.date}</small>
                    </div>
                    <div style="font-weight: 600; margin-bottom: 0.4rem;">${release.title}</div>
                    <ul style="margin: 0; padding-left: 1.2rem; color: var(--text-secondary);">
                        ${release.features.map(f => `<li style="margin-bottom: 0.2rem;">${f}</li>`).join('')}
                    </ul>
                `;
                container.appendChild(div);
            });
        } catch (e) {
            container.innerHTML = '<p style="color: var(--text-muted);">Changelog konnte nicht geladen werden.</p>';
        }
    }

    // =======================
    // Self-Update
    // =======================
    // Re-check if missing (defensive) - DELEGATED EVENT LISTENER
    document.body.addEventListener('click', async (e) => {
        // Handle click on button or its children
        const btn = e.target.closest('#btn-update-check') || e.target.closest('#btn-update');

        if (btn) {
            if (!confirm('Möchtest du jetzt nach Updates suchen und diese installieren?\n\nDer Server startet dabei kurz neu.')) {
                return;
            }

            const originalContent = btn.innerHTML;
            btn.disabled = true;

            // Show Overlay
            updateOverlay.style.display = 'flex';
            updateStatusText.textContent = 'Update wird geprüft...';

            const waitForServerAndReload = async () => {
                updateStatusText.textContent = 'Server startet neu, bitte warten...';
                let attempts = 0;
                const maxAttempts = 30; // 30 × 2s = 60s max
                const poll = setInterval(async () => {
                    attempts++;
                    try {
                        const ping = await fetch('/api/health', { cache: 'no-store' });
                        if (ping.ok) {
                            clearInterval(poll);
                            updateStatusText.textContent = 'Update abgeschlossen! Seite wird neu geladen...';
                            setTimeout(() => window.location.reload(), 800);
                        }
                    } catch (_) {
                        // Server not yet back
                        if (attempts >= maxAttempts) {
                            clearInterval(poll);
                            updateStatusText.textContent = 'Server antwortet nicht. Bitte manuell neu laden.';
                            btn.disabled = false;
                        }
                    }
                }, 2000);
            };

            try {
                let result;
                try {
                    const response = await fetch('/api/update', { method: 'POST' });
                    result = await response.json();
                } catch (networkErr) {
                    // fetch threw = server closed connection during restart (response sent but TCP closed)
                    // Treat as successful update in progress
                    updateStatusText.textContent = 'Update läuft, Server startet neu...';
                    showToast('Update gestartet. Warte auf Server...', 'success');
                    await waitForServerAndReload();
                    return;
                }

                if (result.success) {
                    if (result.status === 'no_updates') {
                        updateStatusText.textContent = 'Keine Updates verfügbar.';
                        showToast('Deine App ist bereits auf dem neuesten Stand.', 'info');
                        setTimeout(() => {
                            updateOverlay.style.display = 'none';
                            btn.disabled = false;
                        }, 2000);
                    } else {
                        updateStatusText.textContent = 'Update erfolgreich! Neustart läuft...';
                        showToast('Update abgeschlossen. App lädt neu.', 'success');
                        await waitForServerAndReload();
                    }
                } else {
                    throw new Error(result.message || 'Update fehlgeschlagen');
                }
            } catch (err) {
                console.error('Update Error:', err);
                updateStatusText.textContent = `Fehler: ${err.message}`;
                showToast(`Update Fehler: ${err.message}`, 'error', 10000);
                setTimeout(() => {
                    updateOverlay.style.display = 'none';
                    btn.disabled = false;
                    btn.innerHTML = originalContent;
                }, 4000);
            }
        }
    });

    // =======================
    // Telegram Requests
    // =======================
    async function loadTelegramRequests() {
        const container = $('#tg-requests-container');
        const group = $('#tg-requests-group');
        if (!container || !group) return;

        try {
            const [pendingRes, historyRes] = await Promise.all([
                fetch('/api/settings/telegram/requests'),
                fetch('/api/settings/telegram/history')
            ]);
            const pendingData = await pendingRes.json();
            const historyData = await historyRes.json();

            group.style.display = 'block';

            const pending = (pendingData.success && pendingData.requests) ? pendingData.requests : [];
            const history = (historyData.success && historyData.history) ? historyData.history : [];

            let html = '';

            if (pending.length > 0) {
                html += `<div style="font-weight:600; margin-bottom:6px; color:var(--primary-color);">Offene Anfragen</div>`;
                html += pending.map(req => `
                    <div class="tg-request-item" style="display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px solid var(--border-color);">
                        <div>
                            <strong>${escapeHtml(req.name)}</strong>
                            ${req.username ? `<small class="text-muted"> (@${escapeHtml(req.username)})</small>` : ''}
                            <br><small class="text-muted">Chat-ID: ${escapeHtml(String(req.chat_id))} &bull; ${new Date(req.created_at).toLocaleDateString('de-DE')}</small>
                        </div>
                        <div class="btn-group">
                            <button type="button" class="btn btn-sm btn-success btn-approve-tg" data-id="${req.id}">Genehmigen</button>
                            <button type="button" class="btn btn-sm btn-danger btn-deny-tg" data-id="${req.id}">Ablehnen</button>
                        </div>
                    </div>
                `).join('');
            } else {
                html += `<div class="text-muted" style="padding:8px 0; font-style:italic;">Keine offenen Anfragen.</div>`;
            }

            if (history.length > 0) {
                html += `<div style="font-weight:600; margin-top:14px; margin-bottom:6px; color:var(--text-muted, #666);">Verlauf</div>`;
                html += history.map(req => {
                    const isApproved = req.status === 'approved';
                    const badge = isApproved
                        ? `<span style="background:var(--accent-green,#22c55e);color:#000;padding:2px 8px;border-radius:12px;font-size:11px;">Aktiv</span>`
                        : `<span style="background:var(--danger,#ef4444);color:#fff;padding:2px 8px;border-radius:12px;font-size:11px;">Abgelehnt</span>`;
                    // Approved: show Revoke button. Denied: show Delete button (enables re-registration)
                    const actionBtn = isApproved
                        ? `<button type="button" class="btn btn-sm btn-danger btn-revoke-tg" data-chatid="${escapeHtml(String(req.chat_id))}" style="margin-left:8px; font-size:11px; padding:2px 8px;">Entziehen</button>`
                        : `<button type="button" class="btn btn-sm btn-ghost btn-delete-tg" data-id="${req.id}" style="margin-left:8px; font-size:11px; padding:2px 8px; opacity:0.7;">Löschen</button>`;
                    return `
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:7px 8px; border-bottom:1px solid var(--border-color);">
                            <div>
                                <strong>${escapeHtml(req.name)}</strong>
                                ${req.username ? `<small class="text-muted"> (@${escapeHtml(req.username)})</small>` : ''}
                                <br><small class="text-muted">Chat-ID: ${escapeHtml(String(req.chat_id))} &bull; ${new Date(req.updated_at || req.created_at).toLocaleDateString('de-DE')}</small>
                            </div>
                            <div style="display:flex; align-items:center;">${badge}${actionBtn}</div>
                        </div>
                    `;
                }).join('');
            }

            container.innerHTML = html;

            container.querySelectorAll('.btn-approve-tg').forEach(btn => {
                btn.addEventListener('click', () => approveTelegramRequest(btn.dataset.id));
            });
            container.querySelectorAll('.btn-deny-tg').forEach(btn => {
                btn.addEventListener('click', () => denyTelegramRequest(btn.dataset.id));
            });
            container.querySelectorAll('.btn-revoke-tg').forEach(btn => {
                btn.addEventListener('click', () => revokeTelegramAccess(btn.dataset.chatid));
            });
            container.querySelectorAll('.btn-delete-tg').forEach(btn => {
                btn.addEventListener('click', () => deleteTgRequest(btn.dataset.id));
            });
        } catch (e) {
            console.error('Failed to load TG requests', e);
        }
    }

    async function approveTelegramRequest(id) {
        if (!confirm('Zugriff genehmigen?')) return;
        try {
            const res = await fetch('/api/settings/telegram/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            const data = await res.json();
            if (data.success) {
                showToast(data.message, 'success');
                await loadTelegramRequests();
                await loadAllSettings(); // Refresh IDs list
            } else {
                showToast(data.error, 'error');
            }
        } catch (e) {
            showToast('Fehler bei Genehmigung', 'error');
        }
    }

    async function denyTelegramRequest(id) {
        if (!confirm('Anfrage ablehnen und löschen?')) return;
        try {
            const res = await fetch('/api/settings/telegram/deny', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            const data = await res.json();
            if (data.success) {
                showToast('Anfrage abgelehnt', 'success');
                await loadTelegramRequests();
            } else {
                showToast(data.error, 'error');
            }
        } catch (e) {
            showToast('Fehler beim Ablehnen', 'error');
        }
    }

    async function revokeTelegramAccess(chatId) {
        if (!confirm(`Zugriff für Chat-ID ${chatId} wirklich entziehen?`)) return;
        try {
            const res = await fetch('/api/settings/telegram/revoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId })
            });
            const data = await res.json();
            if (data.success) {
                showToast('Zugriff entzogen', 'success');
                await loadTelegramRequests();
                await loadAllSettings(); // Refresh tg_ids list
            } else {
                showToast(data.error || 'Fehler', 'error');
            }
        } catch (e) {
            showToast('Fehler beim Entziehen', 'error');
        }
    }

    async function deleteTgRequest(id) {
        if (!confirm('Eintrag vollständig löschen?\nDer User kann sich danach erneut registrieren.')) return;
        try {
            const res = await fetch('/api/settings/telegram/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id })
            });
            const data = await res.json();
            if (data.success) {
                showToast('Eintrag gelöscht', 'success');
                await loadTelegramRequests();
            } else {
                showToast(data.error || 'Fehler', 'error');
            }
        } catch (e) {
            showToast('Fehler beim Löschen', 'error');
        }
    }

    async function init() {
        // Load all settings from server
        await loadAllSettings();
        await loadTelegramRequests();

        await loadBranding();
        await loadTemplateConfig(); // Load template configuration

        // Try to restore draft first
        const draftLoaded = loadDraft();

        if (!draftLoaded) {
            $('#r-datum').value = new Date().toISOString().split('T')[0];
            $('#z-datum').value = new Date().toISOString().split('T')[0];
            $('#r-nummer').value = getNextRechnungsnr();
            addPosition('Übernachtung', 1, 0);
        }

        // Initial render
        updateSummary();
        updatePreview();
        updateNights();

        // Pre-fetch archive
        fetchArchive();

        // Default to Dashboard view
        switchView('dashboard');
    }

    // =======================
    // Guest Autocomplete
    // =======================
    const gNameInput = $('#g-name');
    const acDropdown = $('#guest-autocomplete');
    let acTimer = null;

    if (gNameInput && acDropdown) {
        gNameInput.addEventListener('input', () => {
            clearTimeout(acTimer);
            const q = gNameInput.value.trim();
            if (q.length < 2) { acDropdown.style.display = 'none'; return; }
            acTimer = setTimeout(async () => {
                try {
                    const res = await fetch(`/api/guests?search=${encodeURIComponent(q)}`);
                    const data = await res.json();
                    if (data.success && data.guests.length > 0) {
                        acDropdown.innerHTML = data.guests.map(g => `
                            <div class="guest-autocomplete-item" data-id="${g.id}" data-name="${escapeHtml(g.name)}" data-email="${escapeHtml(g.email || '')}" data-address="${escapeHtml(g.address || '')}">
                                <div class="guest-ac-name">${escapeHtml(g.name)}</div>
                                <div class="guest-ac-meta">${escapeHtml(g.email || '')} ${g.phone ? '• ' + escapeHtml(g.phone) : ''}</div>
                            </div>
                        `).join('');
                        acDropdown.style.display = 'block';
                    } else {
                        acDropdown.style.display = 'none';
                    }
                } catch (e) { acDropdown.style.display = 'none'; }
            }, 250);
        });

        acDropdown.addEventListener('click', (e) => {
            const item = e.target.closest('.guest-autocomplete-item');
            if (item) {
                gNameInput.value = item.dataset.name;
                $('#g-email').value = item.dataset.email || '';
                $('#g-adresse').value = item.dataset.address || '';
                acDropdown.style.display = 'none';
                updatePreview();
                scheduleDraftSave();
            }
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#g-name') && !e.target.closest('#guest-autocomplete')) {
                acDropdown.style.display = 'none';
            }
        });
    }

    // =======================
    // Guests Modal
    // =======================
    const modalGuests = $('#modal-guests');
    let currentGuestId = null;

    if (navGuests && modalGuests) {
        navGuests.addEventListener('click', () => {
            modalGuests.style.display = 'flex';
            loadGuestsList();
        });

        $('#btn-close-guests').addEventListener('click', () => {
            modalGuests.style.display = 'none';
        });

        modalGuests.addEventListener('click', (e) => {
            if (e.target === modalGuests) modalGuests.style.display = 'none';
        });

        $('#guests-search-input').addEventListener('input', (e) => {
            loadGuestsList(e.target.value);
        });

        $('#btn-add-guest').addEventListener('click', () => {
            currentGuestId = null;
            $('#guest-edit-name').value = '';
            $('#guest-edit-email').value = '';
            $('#guest-edit-phone').value = '';
            $('#guest-edit-address').value = '';
            $('#guest-edit-notes').value = '';
            $('#guests-list').style.display = 'none';
            $('#guest-detail').style.display = 'block';
            $('#guest-invoices-list').innerHTML = '<p class="text-muted">Keine Rechnungen vorhanden</p>';
        });

        $('#btn-back-to-list').addEventListener('click', () => {
            $('#guest-detail').style.display = 'none';
            $('#guests-list').style.display = 'grid';
            loadGuestsList();
        });

        $('#btn-save-guest-edit').addEventListener('click', async () => {
            const name = $('#guest-edit-name').value.trim();
            if (!name) { showToast('Name ist erforderlich', 'error'); return; }

            try {
                const res = await fetch('/api/guests', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: currentGuestId,
                        name,
                        email: $('#guest-edit-email').value,
                        phone: $('#guest-edit-phone').value,
                        address: $('#guest-edit-address').value,
                        notes: $('#guest-edit-notes').value
                    })
                });
                const data = await res.json();
                if (data.success) {
                    showToast(data.message, 'success');
                    if (!currentGuestId && data.guest) currentGuestId = data.guest.id;
                }
            } catch (e) {
                showToast('Fehler beim Speichern', 'error');
            }
        });

        $('#btn-delete-guest').addEventListener('click', async () => {
            if (!currentGuestId) return;
            if (!confirm('Diesen Gast wirklich löschen?')) return;

            try {
                const res = await fetch(`/api/guests/${currentGuestId}`, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    showToast('Gast gelöscht', 'success');
                    currentGuestId = null;
                    $('#guest-detail').style.display = 'none';
                    loadDashboard(); // Refresh stats
                    $('#guests-list').style.display = 'grid';
                    loadGuestsList();
                }
            } catch (e) {
                showToast('Fehler beim Löschen', 'error');
            }
        });
    }

    // Live polling for guests modal
    let guestsPollInterval = null;
    if (modalGuests) {
        const guestsObserver = new MutationObserver(() => {
            if (modalGuests.style.display !== 'none') {
                clearInterval(guestsPollInterval);
                guestsPollInterval = setInterval(() => {
                    const guestsList = $('#guests-list');
                    const guestDetail = $('#guest-detail');
                    if (guestsList && guestsList.style.display !== 'none') {
                        const searchInput = $('#guests-search-input');
                        loadGuestsList(searchInput ? searchInput.value : '');
                    } else if (guestDetail && guestDetail.style.display !== 'none' && currentGuestId) {
                        showGuestDetail(currentGuestId);
                    }
                }, 15000);
            } else {
                clearInterval(guestsPollInterval);
                guestsPollInterval = null;
            }
        });
        guestsObserver.observe(modalGuests, { attributes: true, attributeFilter: ['style'] });
    }

    async function loadGuestsList(search = '') {
        try {
            const res = await fetch(`/api/guests?search=${encodeURIComponent(search)}`);
            const data = await res.json();
            const listEl = $('#guests-list');

            if (!data.success || data.guests.length === 0) {
                listEl.innerHTML = `
                    <div class="archive-empty">
                        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                            <circle cx="20" cy="18" r="7" stroke="currentColor" stroke-width="2"/>
                            <path d="M6 42c0-7.7 6.3-14 14-14s14 6.3 14 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                        <p>${search ? 'Keine Treffer gefunden' : 'Noch keine Gäste vorhanden'}</p>
                        <small>${search ? 'Versuche einen anderen Suchbegriff' : 'Klicke "+ Neuer Gast" um einen Gast anzulegen'}</small>
                    </div>
                `;
                return;
            }

            listEl.innerHTML = data.guests.map(g => `
                <div class="guest-card" data-id="${g.id}">
                    <div class="guest-card-name">${escapeHtml(g.name)}</div>
                    ${g.email ? `<div class="guest-card-email">${escapeHtml(g.email)}</div>` : ''}
                    <div class="guest-card-meta">
                        ${g.phone ? escapeHtml(g.phone) : ''}
                        <span class="guest-card-badge">${g.invoice_count || 0} Rechnungen</span>
                    </div>
                </div>
            `).join('');

            listEl.querySelectorAll('.guest-card').forEach(card => {
                card.addEventListener('click', () => showGuestDetail(parseInt(card.dataset.id)));
            });
        } catch (e) {
            console.error('Load guests error:', e);
        }
    }

    async function showGuestDetail(guestId) {
        try {
            const res = await fetch(`/api/guests/${guestId}`);
            const data = await res.json();
            if (!data.success) return;

            currentGuestId = guestId;
            const g = data.guest;
            $('#guest-edit-name').value = g.name || '';
            $('#guest-edit-email').value = g.email || '';
            $('#guest-edit-phone').value = g.phone || '';
            $('#guest-edit-address').value = g.address || '';
            $('#guest-edit-notes').value = g.notes || '';

            // Invoice history
            const invList = $('#guest-invoices-list');
            if (data.invoices && data.invoices.length > 0) {
                invList.innerHTML = data.invoices.map(inv => {
                    const d = typeof inv.data === 'string' ? JSON.parse(inv.data) : (inv.data || {});
                    const amount = inv.total_amount || d.totalAmount || 0;
                    const paid = inv.paid || d.zBezahlt;
                    const paidBadge = paid
                        ? `<span style="background:var(--accent-green,#34d399);color:#000;padding:1px 6px;border-radius:10px;font-size:10px;">Bezahlt</span>`
                        : `<span style="background:var(--warning,#f59e0b);color:#000;padding:1px 6px;border-radius:10px;font-size:10px;">Offen</span>`;
                    return `
                        <div class="guest-invoice-item" style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border); gap:6px; flex-wrap:wrap;">
                            <div style="display:flex;align-items:center;gap:6px;min-width:0;">
                                <span class="guest-invoice-nr" style="font-weight:600;">${escapeHtml(inv.invoice_number || d.rNummer || '—')}</span>
                                <span style="color:var(--text-muted); font-size:0.82rem;">${formatDate(inv.invoice_date || d.rDatum)}</span>
                                ${paidBadge}
                            </div>
                            <div style="display:flex;align-items:center;gap:4px;">
                                <span style="font-weight:600;">${formatCurrency(amount)}</span>
                                ${inv.id ? `<button type="button" class="btn btn-sm btn-outline btn-load-inv" data-id="${inv.id}" data-nr="${escapeHtml(inv.invoice_number || '')}" title="In Formular laden" style="padding:2px 7px; font-size:11px;">Laden</button>` : ''}
                                ${inv.id ? `<button type="button" class="btn btn-sm btn-ghost btn-download-inv-pdf" data-id="${inv.id}" data-nr="${escapeHtml(inv.invoice_number || '')}" title="PDF herunterladen" style="padding:2px 6px; font-size:11px;">PDF</button>` : ''}
                                ${inv.id ? `<button type="button" class="btn btn-sm btn-danger btn-delete-inv" data-id="${inv.id}" data-nr="${escapeHtml(inv.invoice_number || '')}" title="Rechnung löschen" style="padding:2px 7px; font-size:11px;">Löschen</button>` : ''}
                            </div>
                        </div>
                    `;
                }).join('');
                invList.querySelectorAll('.btn-download-inv-pdf').forEach(btn => {
                    btn.addEventListener('click', () => downloadArchivedPdf(btn.dataset.id, btn.dataset.nr));
                });
                invList.querySelectorAll('.btn-load-inv').forEach(btn => {
                    btn.addEventListener('click', () => loadArchivedInvoiceById(btn.dataset.id));
                });
                invList.querySelectorAll('.btn-delete-inv').forEach(btn => {
                    btn.addEventListener('click', () => deleteGuestInvoice(btn.dataset.id, btn.dataset.nr, guestId));
                });
            } else {
                invList.innerHTML = '<p class="text-muted">Keine Rechnungen vorhanden</p>';
            }

            // Nuki PINs
            const nukiList = $('#guest-nuki-list');
            if (nukiList) {
                const activePins = (data.bookings || []).filter(b => b.nuki_pin || b.nuki_auth_id);
                if (activePins.length > 0) {
                    const now = new Date().toISOString().split('T')[0];
                    nukiList.innerHTML = activePins.map(b => {
                        const expired = b.checkout && b.checkout < now;
                        const statusBadge = expired
                            ? `<span style="background:var(--danger,#ef4444);color:#fff;padding:1px 7px;border-radius:12px;font-size:11px;">Abgelaufen</span>`
                            : `<span style="background:var(--accent-green,#34d399);color:#000;padding:1px 7px;border-radius:12px;font-size:11px;">Aktiv</span>`;
                        const extendBtn = `<button type="button" class="btn btn-sm btn-outline btn-extend-nuki-pin" data-booking-id="${b.id}" data-checkin="${b.checkin || ''}" data-checkout="${b.checkout || ''}" style="font-size:11px;padding:2px 8px;">Verlängern</button>`;
                        const deleteBtn = `<button type="button" class="btn btn-sm btn-danger btn-delete-nuki-pin" data-booking-id="${b.id}" style="font-size:11px;padding:2px 8px;">Löschen</button>`;
                        return `
                            <div style="display:flex; justify-content:space-between; align-items:center; padding:7px 0; border-bottom:1px solid var(--border); gap:8px;">
                                <div>
                                    <strong style="font-family:monospace; font-size:1.1em;">${escapeHtml(b.nuki_pin || '—')}</strong>
                                    <br><small class="text-muted">${b.checkin ? formatDate(b.checkin) : '—'} – ${b.checkout ? formatDate(b.checkout) : '—'}</small>
                                </div>
                                <div style="display:flex; align-items:center; gap:6px;">${statusBadge}${extendBtn}${deleteBtn}</div>
                            </div>`;
                    }).join('');
                    nukiList.querySelectorAll('.btn-delete-nuki-pin').forEach(btn => {
                        btn.addEventListener('click', () => deleteGuestNukiPin(btn.dataset.bookingId, guestId));
                    });
                    nukiList.querySelectorAll('.btn-extend-nuki-pin').forEach(btn => {
                        btn.addEventListener('click', () => extendGuestNukiPin(btn.dataset.bookingId, btn.dataset.checkin, btn.dataset.checkout, guestId));
                    });
                } else {
                    nukiList.innerHTML = '<p class="text-muted" style="font-size:0.85rem;">Keine aktiven Nuki-PINs</p>';
                }
            }

            // Wire up the "Neuer PIN" form for this guest
            const btnToggleNewPin = $('#btn-toggle-new-pin-form');
            const newPinForm = $('#guest-new-pin-form');
            if (btnToggleNewPin && newPinForm) {
                // Clone to remove old listeners
                const freshToggle = btnToggleNewPin.cloneNode(true);
                btnToggleNewPin.replaceWith(freshToggle);
                freshToggle.addEventListener('click', () => {
                    newPinForm.style.display = newPinForm.style.display === 'none' ? 'block' : 'none';
                });

                const btnCancel = $('#btn-cancel-new-pin');
                const freshCancel = btnCancel ? btnCancel.cloneNode(true) : null;
                if (btnCancel && freshCancel) {
                    btnCancel.replaceWith(freshCancel);
                    freshCancel.addEventListener('click', () => { newPinForm.style.display = 'none'; });
                }

                const btnCreate = $('#btn-create-guest-pin');
                const freshCreate = btnCreate ? btnCreate.cloneNode(true) : null;
                if (btnCreate && freshCreate) {
                    btnCreate.replaceWith(freshCreate);
                    freshCreate.addEventListener('click', () => createGuestNukiPin(guestId));
                }
            }

            $('#guests-list').style.display = 'none';
            $('#guest-detail').style.display = 'block';
        } catch (e) {
            console.error('Show guest detail error:', e);
        }
    }

    async function deleteGuestNukiPin(bookingId, guestId) {
        if (!confirm('Diesen Nuki-PIN wirklich löschen? Der Tür-Code wird sofort deaktiviert.')) return;
        try {
            const res = await fetch(`/api/nuki/pin/${bookingId}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                showToast('Nuki-PIN gelöscht', 'success');
                showGuestDetail(guestId);
            } else {
                showToast(data.error || 'Fehler beim Löschen', 'error');
            }
        } catch (e) {
            showToast('Fehler: ' + e.message, 'error');
        }
    }

    async function deleteGuestInvoice(invoiceId, invoiceNr, guestId) {
        if (!confirm(`Rechnung ${invoiceNr} wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`)) return;
        try {
            const res = await fetch(`/api/invoices/${invoiceId}`, { method: 'DELETE' });
            const data = await res.json();
            if (data.success) {
                showToast('Rechnung gelöscht', 'success');
                showGuestDetail(guestId);
                loadDashboard(); // Refresh stats
            } else {
                showToast(data.error || 'Fehler beim Löschen', 'error');
            }
        } catch (e) {
            showToast('Fehler: ' + e.message, 'error');
        }
    }

    async function createGuestNukiPin(guestId) {
        const arrival = $('#new-pin-arrival').value;
        const departure = $('#new-pin-departure').value;
        if (!arrival || !departure) {
            showToast('Bitte Anreise und Abreise angeben', 'error');
            return;
        }
        if (departure <= arrival) {
            showToast('Abreise muss nach der Anreise liegen', 'error');
            return;
        }
        const btn = $('#btn-create-guest-pin');
        if (btn) btn.disabled = true;
        try {
            const res = await fetch('/api/nuki/pin/create-for-guest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ guestId, arrival, departure })
            });
            const data = await res.json();
            if (data.success) {
                showToast(`Nuki-PIN erstellt: ${data.pin}`, 'success');
                const form = $('#guest-new-pin-form');
                if (form) form.style.display = 'none';
                showGuestDetail(guestId);
            } else {
                showToast(data.error || 'Fehler beim Erstellen', 'error');
            }
        } catch (e) {
            showToast('Fehler: ' + e.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async function extendGuestNukiPin(bookingId, currentCheckin, currentCheckout, guestId) {
        const newArrival = prompt('Neues Anreisedatum (YYYY-MM-DD):', currentCheckin || '');
        if (!newArrival) return;
        const newDeparture = prompt('Neues Abreisedatum (YYYY-MM-DD):', currentCheckout || '');
        if (!newDeparture) return;
        if (newDeparture <= newArrival) {
            showToast('Abreise muss nach der Anreise liegen', 'error');
            return;
        }
        try {
            const res = await fetch(`/api/nuki/pin/${bookingId}/extend`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ arrival: newArrival, departure: newDeparture })
            });
            const data = await res.json();
            if (data.success) {
                showToast('Nuki-PIN verlängert', 'success');
                showGuestDetail(guestId);
            } else {
                showToast(data.error || 'Fehler beim Verlängern', 'error');
            }
        } catch (e) {
            showToast('Fehler: ' + e.message, 'error');
        }
    }

    // =======================
    // Branding / Logo
    // =======================
    let currentLogoBase64 = null;

    const logoPreview = $('#logo-preview');
    const logoFileInput = $('#logo-file-input');
    const btnUploadLogo = $('#btn-upload-logo');
    const btnRemoveLogo = $('#btn-remove-logo');

    if (btnUploadLogo && logoFileInput) {
        btnUploadLogo.addEventListener('click', () => logoFileInput.click());

        logoFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            if (file.size > 2 * 1024 * 1024) {
                showToast('Logo ist zu groß (max 2MB)', 'error');
                return;
            }

            const reader = new FileReader();
            reader.onload = (ev) => {
                currentLogoBase64 = ev.target.result;
                logoPreview.src = currentLogoBase64;
                logoPreview.style.display = 'block';
                btnRemoveLogo.style.display = 'inline-flex';
            };
            reader.readAsDataURL(file);
        });

        btnRemoveLogo.addEventListener('click', () => {
            currentLogoBase64 = null;
            logoPreview.src = '';
            logoPreview.style.display = 'none';
            btnRemoveLogo.style.display = 'none';
            logoFileInput.value = '';
        });
    }

    async function saveBranding() {
        try {
            await fetch('/api/branding', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ logo_base64: currentLogoBase64 })
            });
        } catch (e) {
            console.error('Save branding error:', e);
        }
    }

    async function loadBranding() {
        try {
            const res = await fetch('/api/branding');
            const data = await res.json();
            if (data.success && data.branding && data.branding.logo_base64) {
                currentLogoBase64 = data.branding.logo_base64;
                logoPreview.src = currentLogoBase64;
                logoPreview.style.display = 'block';
                btnRemoveLogo.style.display = 'inline-flex';
            }
        } catch (e) {
            console.error('Load branding error:', e);
        }
    }

    // =======================
    // Data Migration (localStorage → DB)
    // =======================
    const btnMigrate = $('#btn-migrate-data');
    if (btnMigrate) {
        btnMigrate.addEventListener('click', async () => {
            if (!confirm('Bestehende Browser-Daten (Einstellungen, Archiv) in die Datenbank importieren?\n\nDies überschreibt vorhandene Server-Daten nicht, sondern ergänzt sie.')) return;

            const migrationData = {};
            for (const [key, storageKey] of Object.entries(STORAGE_KEYS)) {
                const raw = localStorage.getItem(storageKey);
                if (raw) migrationData[key] = raw;
            }

            if (Object.keys(migrationData).length === 0) {
                showToast('Keine Browser-Daten zum Importieren gefunden', 'info');
                return;
            }

            try {
                const res = await fetch('/api/migrate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(migrationData)
                });
                const data = await res.json();
                if (data.success) {
                    showToast(data.message, 'success');
                    await loadAllSettings();
                    await fetchArchive();
                } else {
                    showToast('Migration fehlgeschlagen', 'error');
                }
            } catch (e) {
                showToast('Server-Fehler bei der Migration', 'error');
            }
        });
    }

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

    // =======================
    // INVOICE TEMPLATE DESIGNER
    // =======================
    let currentTemplateConfig = {};
    let templateStyleElement = null;
    let previewZoom = 0.75; // Default 75%

    // Template Presets
    const templatePresets = {
        modern: {
            logoText: 'Ferienwohnung Beckhome',
            logoImage: null,
            greeting: 'SEHR GEEHRTE/R',
            introText: 'Ich bedanke mich herzlich für die Zusammenarbeit und Ihr entgegengebrachtes Vertrauen. Anbei die Rechnung für das gemeinsame Projekt:',
            footerText: '',
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
        },
        classic: {
            logoText: 'Ferienwohnung',
            logoImage: null,
            greeting: 'SEHR GEEHRTE/R',
            introText: 'Vielen Dank für Ihre Buchung. Nachfolgend erhalten Sie die Rechnung für Ihren Aufenthalt:',
            footerText: 'Wir freuen uns auf Ihren Besuch!',
            colorPrimary: '#1e293b',
            colorTableBg: '#ffffff',
            colorTableHeader: '#f1f5f9',
            colorText: '#1e293b',
            fontLogo: "'Times New Roman', serif",
            fontBody: "'Arial', sans-serif",
            showLogo: true,
            showTax: true,
            showDateHeader: true,
            showFoldMarks: true
        },
        minimal: {
            logoText: 'Beckhome',
            logoImage: null,
            greeting: 'HALLO',
            introText: '',
            footerText: '',
            colorPrimary: '#000000',
            colorTableBg: '#f9fafb',
            colorTableHeader: '#e5e7eb',
            colorText: '#374151',
            fontLogo: "'Inter', sans-serif",
            fontBody: "'Inter', sans-serif",
            showLogo: true,
            showTax: false,
            showDateHeader: false,
            showFoldMarks: false
        }
    };

    // Default template config
    const defaultTemplateConfig = {
        logoText: 'Ferienwohnung Beckhome',
        logoImage: null, // Base64 image
        greeting: 'SEHR GEEHRTE/R',
        introText: 'Ich bedanke mich herzlich für die Zusammenarbeit und Ihr entgegengebrachtes Vertrauen. Anbei die Rechnung für das gemeinsame Projekt:',
        footerText: '',
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

    async function loadTemplateConfig() {
        try {
            const res = await fetch('/api/branding');
            const data = await res.json();
            if (data.success && data.branding && data.branding.template_config) {
                currentTemplateConfig = { ...defaultTemplateConfig, ...data.branding.template_config };
            } else {
                currentTemplateConfig = { ...defaultTemplateConfig };
            }
            applyTemplateStyles();
            populateTemplateForm();
            updateTemplatePreview();
        } catch (e) {
            console.error('Template config load error:', e);
            currentTemplateConfig = { ...defaultTemplateConfig };
        }
    }

    function applyTemplateStyles() {
        // Remove old style element if exists
        if (templateStyleElement) {
            templateStyleElement.remove();
        }

        // Create new style element with template config
        templateStyleElement = document.createElement('style');
        templateStyleElement.id = 'template-custom-styles';
        templateStyleElement.textContent = `
            /* Template Custom Styles */
            .invoice-page {
                font-family: ${currentTemplateConfig.fontBody || "'Inter', sans-serif"} !important;
                color: ${currentTemplateConfig.colorText || '#2d2721'} !important;
            }

            .inv-sender::before {
                ${currentTemplateConfig.logoImage
                    ? `content: ''; background-image: url(${currentTemplateConfig.logoImage}); background-size: contain; background-repeat: no-repeat; width: 150px; height: 60px;`
                    : `content: '${(currentTemplateConfig.logoText || 'Ferienwohnung Beckhome').replace(/'/g, "\\'")}'; font-family: ${currentTemplateConfig.fontLogo || 'Georgia, serif'};`
                }
                display: ${currentTemplateConfig.showLogo ? 'block' : 'none'} !important;
            }

            .inv-location-date #inv-location {
                display: ${currentTemplateConfig.showDateHeader ? 'block' : 'none'} !important;
            }

            .inv-location-date #inv-r-datum-header {
                display: ${currentTemplateConfig.showDateHeader ? 'block' : 'none'} !important;
            }

            .inv-tax {
                display: ${currentTemplateConfig.showTax ? 'block' : 'none'} !important;
            }

            .inv-title {
                color: ${currentTemplateConfig.colorPrimary || '#0f172a'} !important;
            }

            .inv-table {
                background: ${currentTemplateConfig.colorTableBg || '#f5f1e8'} !important;
            }

            .inv-table thead {
                background: ${currentTemplateConfig.colorTableHeader || '#e8e1d0'} !important;
            }

            .inv-table td {
                background: ${currentTemplateConfig.colorTableBg || '#f5f1e8'} !important;
                color: ${currentTemplateConfig.colorText || '#2d2721'} !important;
            }

            .inv-table th {
                color: ${currentTemplateConfig.colorText || '#2d2721'} !important;
            }

            .inv-payment {
                background: ${currentTemplateConfig.colorTableBg || '#f5f1e8'} !important;
                border-top-color: ${currentTemplateConfig.colorTableHeader || '#e8e1d0'} !important;
            }

            .inv-summary-total {
                color: ${currentTemplateConfig.colorPrimary || '#0f172a'} !important;
            }

            .inv-markers {
                display: ${currentTemplateConfig.showFoldMarks ? 'block' : 'none'} !important;
            }
        `;

        document.head.appendChild(templateStyleElement);
    }

    function populateTemplateForm() {
        $('#tpl-logo-text').value = currentTemplateConfig.logoText || '';
        $('#tpl-greeting').value = currentTemplateConfig.greeting || '';
        $('#tpl-intro').value = currentTemplateConfig.introText || '';
        $('#tpl-footer-text').value = currentTemplateConfig.footerText || '';
        $('#tpl-color-primary').value = currentTemplateConfig.colorPrimary || '#0f172a';
        $('#tpl-color-table-bg').value = currentTemplateConfig.colorTableBg || '#f5f1e8';
        $('#tpl-color-table-header').value = currentTemplateConfig.colorTableHeader || '#e8e1d0';
        $('#tpl-color-text').value = currentTemplateConfig.colorText || '#2d2721';
        $('#tpl-font-logo').value = currentTemplateConfig.fontLogo || 'Georgia, serif';
        $('#tpl-font-body').value = currentTemplateConfig.fontBody || "'Inter', sans-serif";
        $('#tpl-show-logo').checked = currentTemplateConfig.showLogo !== false;
        $('#tpl-show-tax').checked = currentTemplateConfig.showTax !== false;
        $('#tpl-show-date-header').checked = currentTemplateConfig.showDateHeader !== false;
        $('#tpl-show-fold-marks').checked = currentTemplateConfig.showFoldMarks === true;

        // Logo image preview
        const logoPreview = $('#tpl-logo-preview');
        const btnRemoveLogo = $('#btn-tpl-remove-logo');
        if (currentTemplateConfig.logoImage) {
            logoPreview.src = currentTemplateConfig.logoImage;
            logoPreview.style.display = 'block';
            btnRemoveLogo.style.display = 'inline-block';
        } else {
            logoPreview.style.display = 'none';
            btnRemoveLogo.style.display = 'none';
        }
    }

    function updateTemplatePreview() {
        const previewContainer = $('#template-preview-invoice');
        if (!previewContainer) return;

        // Build sample invoice with current template config
        const sampleData = {
            logoText: currentTemplateConfig.logoText || 'Ferienwohnung Beckhome',
            landlordName: $('#v-name')?.value || 'Max Mustermann',
            landlordAddress: $('#v-adresse')?.value || 'Musterstraße 1\n12345 Musterstadt',
            landlordPhone: $('#v-telefon')?.value || '+49 123 456789',
            landlordEmail: $('#v-email')?.value || 'max@example.com',
            landlordTax: $('#v-steuernr')?.value || '12/345/67890',
            invoiceNumber: 'RE-2024-001',
            invoiceDate: '20.02.2026',
            guestName: 'Frau Müller',
            greeting: (currentTemplateConfig.greeting || 'SEHR GEEHRTE/R') + ' MÜLLER,',
            introText: currentTemplateConfig.introText || '',
            items: [
                { description: 'Übernachtung (7 Nächte)', quantity: 7, price: 80.00, total: 560.00 },
                { description: 'Endreinigung', quantity: 1, price: 50.00, total: 50.00 }
            ],
            totalAmount: 610.00,
            footerText: currentTemplateConfig.footerText || ''
        };

        previewContainer.innerHTML = `
            <style>
                .preview-invoice {
                    font-family: ${currentTemplateConfig.fontBody || "'Inter', sans-serif"};
                    color: ${currentTemplateConfig.colorText || '#2d2721'};
                    padding: 15mm 20mm;
                    background: white;
                }
                .preview-header {
                    display: grid;
                    grid-template-columns: 1fr auto;
                    gap: 2rem;
                    margin-bottom: 20mm;
                }
                .preview-logo {
                    ${currentTemplateConfig.logoImage
                        ? `background-image: url(${currentTemplateConfig.logoImage}); background-size: contain; background-repeat: no-repeat; width: 150px; height: 60px;`
                        : `font-family: ${currentTemplateConfig.fontLogo || 'Georgia, serif'}; font-size: 18pt; font-style: italic; color: ${currentTemplateConfig.colorPrimary || '#0f172a'};`
                    }
                    margin-bottom: 4mm;
                    display: ${currentTemplateConfig.showLogo ? 'block' : 'none'};
                }
                .preview-landlord {
                    font-size: 8pt;
                    color: #64748b;
                    line-height: 1.7;
                }
                .preview-date {
                    text-align: right;
                    font-size: 9pt;
                    display: ${currentTemplateConfig.showDateHeader ? 'block' : 'none'};
                }
                .preview-greeting {
                    font-size: 9pt;
                    font-weight: 600;
                    letter-spacing: 0.05em;
                    margin-bottom: 4mm;
                }
                .preview-intro {
                    font-size: 9pt;
                    line-height: 1.6;
                    margin-bottom: 6mm;
                }
                .preview-title {
                    font-size: 20pt;
                    font-weight: 300;
                    letter-spacing: 2px;
                    text-align: center;
                    margin-bottom: 10mm;
                    color: ${currentTemplateConfig.colorPrimary || '#0f172a'};
                }
                .preview-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 9pt;
                    margin-bottom: 8mm;
                    background: ${currentTemplateConfig.colorTableBg || '#f5f1e8'};
                }
                .preview-table th {
                    background: ${currentTemplateConfig.colorTableHeader || '#e8e1d0'};
                    padding: 3mm 2.5mm;
                    text-align: left;
                    font-size: 8pt;
                    font-weight: 600;
                }
                .preview-table td {
                    padding: 2.5mm;
                }
                .preview-total {
                    text-align: right;
                    font-weight: 700;
                    font-size: 12pt;
                    margin-top: 5mm;
                }
                .preview-footer {
                    margin-top: 10mm;
                    text-align: center;
                    padding: 4mm;
                    background: ${currentTemplateConfig.colorTableBg || '#f5f1e8'};
                    border-top: 1px solid ${currentTemplateConfig.colorTableHeader || '#e8e1d0'};
                    font-size: 8pt;
                }
                .preview-tax {
                    display: ${currentTemplateConfig.showTax ? 'block' : 'none'};
                    font-size: 7pt;
                    margin-top: 1mm;
                    color: #64748b;
                }
            </style>
            <div class="preview-invoice">
                <div class="preview-header">
                    <div>
                        <div class="preview-logo">${currentTemplateConfig.logoImage ? '' : sampleData.logoText}</div>
                        <div class="preview-landlord">
                            <strong>${sampleData.landlordName}</strong><br>
                            ${sampleData.landlordAddress.replace(/\n/g, '<br>')}<br>
                            ${sampleData.landlordPhone}<br>
                            ${sampleData.landlordEmail}
                            <div class="preview-tax">${sampleData.landlordTax}</div>
                        </div>
                    </div>
                    <div class="preview-date">
                        ${sampleData.invoiceDate}
                    </div>
                </div>

                <div class="preview-greeting">${sampleData.greeting}</div>
                ${sampleData.introText ? `<div class="preview-intro">${sampleData.introText}</div>` : ''}

                <div class="preview-title">RECHNUNG</div>

                <table class="preview-table">
                    <thead>
                        <tr>
                            <th>Beschreibung</th>
                            <th style="text-align: center;">Anzahl</th>
                            <th style="text-align: right;">Preis</th>
                            <th style="text-align: right;">Gesamt</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${sampleData.items.map(item => `
                            <tr>
                                <td>${item.description}</td>
                                <td style="text-align: center;">${item.quantity}</td>
                                <td style="text-align: right;">${item.price.toFixed(2)} €</td>
                                <td style="text-align: right;">${item.total.toFixed(2)} €</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>

                <div class="preview-total">
                    Gesamtbetrag: ${sampleData.totalAmount.toFixed(2)} €
                </div>

                ${sampleData.footerText ? `<div class="preview-footer">${sampleData.footerText}</div>` : ''}
            </div>
        `;
    }

    // Live preview update on input
    const templateInputs = [
        '#tpl-logo-text', '#tpl-greeting', '#tpl-intro', '#tpl-footer-text',
        '#tpl-color-primary', '#tpl-color-table-bg', '#tpl-color-table-header', '#tpl-color-text',
        '#tpl-font-logo', '#tpl-font-body',
        '#tpl-show-logo', '#tpl-show-tax', '#tpl-show-date-header', '#tpl-show-fold-marks'
    ];

    templateInputs.forEach(selector => {
        const el = $(selector);
        if (el) {
            el.addEventListener('input', () => {
                // Update config from form
                currentTemplateConfig.logoText = $('#tpl-logo-text').value;
                currentTemplateConfig.greeting = $('#tpl-greeting').value;
                currentTemplateConfig.introText = $('#tpl-intro').value;
                currentTemplateConfig.footerText = $('#tpl-footer-text').value;
                currentTemplateConfig.colorPrimary = $('#tpl-color-primary').value;
                currentTemplateConfig.colorTableBg = $('#tpl-color-table-bg').value;
                currentTemplateConfig.colorTableHeader = $('#tpl-color-table-header').value;
                currentTemplateConfig.colorText = $('#tpl-color-text').value;
                currentTemplateConfig.fontLogo = $('#tpl-font-logo').value;
                currentTemplateConfig.fontBody = $('#tpl-font-body').value;
                currentTemplateConfig.showLogo = $('#tpl-show-logo').checked;
                currentTemplateConfig.showTax = $('#tpl-show-tax').checked;
                currentTemplateConfig.showDateHeader = $('#tpl-show-date-header').checked;
                currentTemplateConfig.showFoldMarks = $('#tpl-show-fold-marks').checked;
                // Note: logoImage is handled separately in file upload handler

                applyTemplateStyles();
                updateTemplatePreview();
            });
        }
    });

    // Save template
    const btnSaveTemplate = $('#btn-save-template');
    if (btnSaveTemplate) {
        btnSaveTemplate.addEventListener('click', async () => {
            try {
                btnSaveTemplate.disabled = true;
                btnSaveTemplate.textContent = 'Speichern...';

                const res = await fetch('/api/branding/template', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ template_config: currentTemplateConfig })
                });
                const data = await res.json();
                if (data.success) {
                    showNotification('Template gespeichert! ✓', 'success');
                    // Apply to main invoice preview as well
                    applyTemplateStyles();
                    if (typeof updatePreview === 'function') {
                        updatePreview();
                    }
                } else {
                    showNotification('Fehler beim Speichern', 'error');
                }
            } catch (e) {
                console.error('Template save error:', e);
                showNotification('Fehler beim Speichern', 'error');
            } finally {
                btnSaveTemplate.disabled = false;
                btnSaveTemplate.textContent = 'Template speichern';
            }
        });
    }

    // Reset template
    const btnResetTemplate = $('#btn-reset-template');
    if (btnResetTemplate) {
        btnResetTemplate.addEventListener('click', () => {
            if (confirm('Template auf Standardwerte zurücksetzen?')) {
                currentTemplateConfig = { ...defaultTemplateConfig };
                populateTemplateForm();
                updateTemplatePreview();
            }
        });
    }

    // Template Preset Selector
    const tplPresetSelect = $('#tpl-preset-select');
    if (tplPresetSelect) {
        tplPresetSelect.addEventListener('change', (e) => {
            const presetName = e.target.value;
            if (presetName === 'custom') return;

            if (templatePresets[presetName]) {
                if (confirm(`Template "${presetName}" laden? Aktuelle Änderungen gehen verloren.`)) {
                    currentTemplateConfig = { ...templatePresets[presetName] };
                    populateTemplateForm();
                    applyTemplateStyles();
                    updateTemplatePreview();
                    tplPresetSelect.value = 'custom'; // Switch back to custom after loading
                }
            }
        });
    }

    // Zoom Controls
    const btnZoomIn = $('#btn-zoom-in');
    const btnZoomOut = $('#btn-zoom-out');
    const zoomLevelDisplay = $('#zoom-level');
    const previewInvoice = $('#template-preview-invoice');

    function updateZoom() {
        if (previewInvoice) {
            previewInvoice.style.transform = `scale(${previewZoom})`;
        }
        if (zoomLevelDisplay) {
            zoomLevelDisplay.textContent = `${Math.round(previewZoom * 100)}%`;
        }
    }

    if (btnZoomIn) {
        btnZoomIn.addEventListener('click', () => {
            if (previewZoom < 1.5) {
                previewZoom += 0.1;
                updateZoom();
            }
        });
    }

    if (btnZoomOut) {
        btnZoomOut.addEventListener('click', () => {
            if (previewZoom > 0.3) {
                previewZoom -= 0.1;
                updateZoom();
            }
        });
    }

    // Logo upload handlers
    const btnTplUploadLogo = $('#btn-tpl-upload-logo');
    const tplLogoFileInput = $('#tpl-logo-file-input');
    const btnTplRemoveLogo = $('#btn-tpl-remove-logo');
    const tplLogoPreview = $('#tpl-logo-preview');

    if (btnTplUploadLogo && tplLogoFileInput) {
        btnTplUploadLogo.addEventListener('click', () => {
            tplLogoFileInput.click();
        });

        tplLogoFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            // Validate file type
            if (!file.type.startsWith('image/')) {
                showNotification('Bitte wähle eine Bilddatei', 'error');
                return;
            }

            // Validate file size (max 2MB)
            if (file.size > 2 * 1024 * 1024) {
                showNotification('Bild ist zu groß (max 2MB)', 'error');
                return;
            }

            const reader = new FileReader();
            reader.onload = (event) => {
                const base64 = event.target.result;
                currentTemplateConfig.logoImage = base64;

                // Update preview
                tplLogoPreview.src = base64;
                tplLogoPreview.style.display = 'block';
                btnTplRemoveLogo.style.display = 'inline-block';

                applyTemplateStyles();
                updateTemplatePreview();
            };
            reader.readAsDataURL(file);
        });
    }

    if (btnTplRemoveLogo) {
        btnTplRemoveLogo.addEventListener('click', () => {
            currentTemplateConfig.logoImage = null;
            tplLogoPreview.style.display = 'none';
            btnTplRemoveLogo.style.display = 'none';
            tplLogoFileInput.value = '';

            applyTemplateStyles();
            updateTemplatePreview();
        });
    }

})();
// Version 3.0 - SQLite Database Migration
