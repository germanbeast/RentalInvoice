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
    const btnSaveInvoice = $('#btn-save-invoice');
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
    const navEstate = $('#nav-estate');
    const navWelcome = $('#nav-welcome');

    // View Panes
    const viewDashboard = $('#view-dashboard');
    const viewInvoiceForm = $('#view-invoice-form');
    const viewExpenses = $('#view-expenses');
    const viewEstate = $('#view-estate');
    const viewBookings = $('#view-bookings');
    const navBookings = $('#nav-bookings');
    const viewWebsite = $('#view-website');
    const navWebsite = $('#nav-website');
    const viewCalendar = $('#view-calendar');
    const navCalendar = $('#nav-calendar');
    const viewOccupancy = $('#view-occupancy');
    const navOccupancy = $('#nav-occupancy');
    const viewFinance = $('#view-finance');
    const navFinance = $('#nav-finance');

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
        // Check if this is a TV welcome screen request (bypass auth)
        const urlParams = new URLSearchParams(window.location.search);
        const welcomeGuest = urlParams.get('welcome');

        if (welcomeGuest) {
            // Skip auth check for TV welcome screen
            return;
        }

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
        // In the installed phone app staying logged in is the expected default
        const remember = $('#login-remember');
        if (remember && (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true)) remember.checked = true;
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
        refreshSiteBadge();
        loadTopbarUser();
    }

    let loginStep = 'credentials'; // 'credentials', '2fa', 'recovery'
    let currentSessionId = null;

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = $('#login-user').value;
        const password = $('#login-pass').value;
        const code = $('#login-2fa').value;
        const recoveryKey = $('#login-recovery').value;
        const remember = $('#login-remember').checked;
        const loginBtn = $('#btn-login');

        const originalBtnText = loginBtn.innerHTML;
        loginBtn.disabled = true;

        try {
            if (loginStep === 'credentials') {
                loginBtn.innerHTML = 'Anmelden...';
                const response = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password, remember })
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
                    body: JSON.stringify({ username, recoveryKey, remember })
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
        const mwst = $('#kleinunternehmer').checked ? 0 : netto * (rate / 100);
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
            text.textContent = `${nights} ${nights !== 1 ? 'Nächte' : 'Nacht'}`;
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
            $('#inv-g-adresse').innerHTML = nl2br(escapeHtml($('#g-adresse').value));

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
            const city = cityMatch ? cityMatch[1].split('\n')[0].trim() : '';
            $('#inv-location').textContent = city;
            $('#inv-r-datum-header').textContent = formatDate(rDatum) || '01.01.2030';

            const anreise = $('#a-anreise').value;
            const abreise = $('#a-abreise').value;
            const nights = calcNights(anreise, abreise);
            let aufenthaltText = '—';
            if (anreise && abreise) {
                aufenthaltText = `${formatDate(anreise)} – ${formatDate(abreise)} (${nights} ${nights !== 1 ? 'Nächte' : 'Nacht'})`;
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
            const isKleinunternehmer = $('#kleinunternehmer').checked;
            const mwst = isKleinunternehmer ? 0 : netto * (rate / 100);
            const total = netto + mwst;

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
                airbnb_ical: ($('#airbnb-ical-url')?.value || '').trim(),
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
            if (typeof s.airbnb_ical === 'string' && $('#airbnb-ical-url')) $('#airbnb-ical-url').value = s.airbnb_ical;
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
                        <small style="color:var(--primary-color);">🔑 Recovery: ${user.has_recovery_key ? 'eingerichtet' : 'keiner'}</small>
                    </div>
                    <div style="display: flex; gap: 0.5rem;">
                        <button class="btn btn-outline btn-sm recovery-user-btn" data-id="${user.id}">Neuer Recovery-Key</button>
                        <button class="btn btn-outline btn-sm edit-user-btn" data-id="${user.id}">Edit</button>
                        <button class="btn btn-outline btn-sm delete-user-btn" data-id="${user.id}" style="color:red;">Del</button>
                    </div>
                `;

                div.querySelector('.recovery-user-btn').onclick = () => newRecoveryKey(user);
                div.querySelector('.edit-user-btn').onclick = () => editUser(user);
                div.querySelector('.delete-user-btn').onclick = () => deleteUser(user.id, user.username);

                container.appendChild(div);
            });
        } catch (e) {
            console.error('User list error:', e);
            container.innerHTML = '<p>Fehler beim Laden der Benutzer.</p>';
        }
    }

    // The server keeps only a hash: the key is visible this one time
    function showRecoveryKey(username, key) {
        prompt(`Wiederherstellungs-Schlüssel für ${username}. Jetzt notieren, er wird nur dieses eine Mal angezeigt:`, key);
    }

    async function newRecoveryKey(user) {
        if (!confirm(`Neuen Recovery-Key für ${user.username} erzeugen? Der alte Schlüssel gilt dann nicht mehr.`)) return;
        try {
            const res = await fetch(`/api/users/${user.id}/recovery-key`, { method: 'POST' });
            const data = await res.json();
            if (!data.success) return showToast(data.error || 'Fehler', 'error');
            showRecoveryKey(user.username, data.recoveryKey);
            loadUsers();
        } catch (e) { showToast('Fehler', 'error'); }
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
                    if (data.recoveryKey) showRecoveryKey(username, data.recoveryKey);
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
            totalAmount: getSubtotal() * (1 + ($('#kleinunternehmer').checked ? 0 : getMwstRate()) / 100),
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
    let viewRefresh = null;

    function startViewPolling(viewId) {
        clearInterval(viewPollInterval);
        viewPollInterval = null;
        const POLL_MS = 20000;
        let refresh = null;
        if (viewId === 'calendar') {
            refresh = () => { if (!document.querySelector('#tl-pop:not([hidden]) input')) loadCalendarHome(); };
        } else if (viewId === 'dashboard') {
            refresh = loadDashboard;
        } else if (viewId === 'expenses') {
            refresh = loadExpenses;
        } else if (viewId === 'bookings') {
            refresh = () => { if (!document.querySelector('#bookings-list input')) loadBookings(); };
        } else if (viewId === 'website') {
            refresh = () => { if (siteTab === 'requests' && !document.querySelector('#site-requests input')) loadSiteRequests(); };
        }
        // 'invoice' view has no background data to poll
        // Skip refreshes while the tab is hidden (saves CPU/battery on weak devices)
        viewRefresh = refresh;
        if (refresh) viewPollInterval = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    }

    // Catch up immediately when the tab becomes visible again
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && viewRefresh) viewRefresh();
    });

    function switchView(viewId) {
        const views = [viewDashboard, viewInvoiceForm, viewExpenses, viewEstate, viewBookings, viewWebsite, viewCalendar, viewOccupancy, viewFinance];
        const navItems = [navDashboard, navInvoice, navGuests, navExpenses, navEstate, navBookings, navWebsite, navCalendar, navOccupancy, navFinance];

        views.forEach(v => {
            if (v) v.style.display = 'none';
        });
        navItems.forEach(n => {
            if (n) n.classList.remove('active');
        });

        currentView = viewId;

        if (viewId === 'calendar' && viewCalendar) {
            viewCalendar.style.display = 'flex';
            navCalendar.classList.add('active');
            loadCalendarHome();
        } else if (viewId === 'dashboard') {
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
        } else if (viewId === 'bookings') {
            viewBookings.style.display = 'flex';
            navBookings.classList.add('active');
            loadBookings();
        } else if (viewId === 'estate') {
            viewEstate.style.display = 'flex';
            navEstate.classList.add('active');
            loadEstateData();
        } else if (viewId === 'website') {
            viewWebsite.style.display = 'flex';
            navWebsite.classList.add('active');
            loadWebsite();
        } else if (viewId === 'occupancy' && viewOccupancy) {
            viewOccupancy.style.display = 'flex';
            navOccupancy.classList.add('active');
            loadReview(reviewYear);
        } else if (viewId === 'finance' && viewFinance) {
            viewFinance.style.display = 'flex';
            navFinance.classList.add('active');
            loadFinance();
        }

        startViewPolling(viewId);
        syncNavGroups();
        hideTlPop();

        // Close mobile sidebar if open
        if (window.innerWidth <= 768) {
            appWrapper.classList.remove('sidebar-open');
        }
    }

    navDashboard.addEventListener('click', () => switchView('dashboard'));
    if (navCalendar) navCalendar.addEventListener('click', () => switchView('calendar'));
    navInvoice.addEventListener('click', () => switchView('invoice'));
    navExpenses.addEventListener('click', () => switchView('expenses'));
    if (navBookings) navBookings.addEventListener('click', () => switchView('bookings'));
    if (navEstate) navEstate.addEventListener('click', () => switchView('estate'));
    if (navWebsite) navWebsite.addEventListener('click', () => switchView('website'));
    if (navOccupancy) navOccupancy.addEventListener('click', () => switchView('occupancy'));
    if (navFinance) navFinance.addEventListener('click', () => switchView('finance'));

    if (navWelcome) {
        navWelcome.addEventListener('click', () => {
            // Vorschau: genau die Seite, die auch die TV-Box zeigt (die eingebaute Ansicht lag
            // innerhalb des ausgeblendeten App-Rahmens und blieb deshalb leer)
            window.open('/welcome.html', '_blank');
        });
    }



    // =======================
    // Heute-Übersicht, Buchungen, Status
    // =======================
    const fmtDE = ymd => ymd ? ymd.split('-').reverse().join('.').slice(0, 6) : '';
    const fmtDEfull = ymd => ymd ? ymd.split('-').reverse().join('.') : '';
    const weekdayDE = ymd => ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(ymd + 'T12:00:00').getDay()];
    const srcClass = s => /airbnb/i.test(s) ? 'airbnb' : (s === 'manual' ? 'manual' : s === 'Direkt' ? 'direct' : 'booking');
    const srcLabel = s => s === 'manual' ? 'Manuell' : s;

    async function apiJson(url, opts) {
        const res = await fetch(url, opts);
        return res.json();
    }

    async function loadOverview() {
        const sec = $('#today-section');
        if (!sec) return;
        try {
            const d = await apiJson('/api/overview');
            if (!d.success) return;
            $('#today-date').textContent = `${weekdayDE(d.today)}, ${fmtDEfull(d.today)}`;

            const inh = $('#today-inhouse');
            inh.innerHTML = d.inHouse.length ? d.inHouse.map(b => `
                <div class="today-row"><span>${escapeHtml(b.name || (b.source + '-Buchung'))}<span class="tag">${escapeHtml(srcLabel(b.source))}</span></span>
                <small>bis ${fmtDE(b.checkout)}${b.state === 'departing' ? ' · heute' : ''}</small></div>`).join('')
                : '<div class="today-empty">Aktuell ist niemand im Haus.</div>';

            const ev = $('#today-events');
            ev.innerHTML = d.events.length ? d.events.map(e => `
                <div class="today-row"><span>${e.type === 'arrival' ? '<span class="tag arr">Anreise</span>' : '<span class="tag dep">Abreise</span>'} ${escapeHtml(e.booking.name || (e.booking.source + '-Buchung'))}</span>
                <small>${e.date === d.today ? 'heute' : weekdayDE(e.date) + ' ' + fmtDE(e.date)}</small></div>`).join('')
                : '<div class="today-empty">In den nächsten 14 Tagen keine Anreisen oder Abreisen.</div>';

            const todo = [];
            if (d.namesMissing > 0) todo.push(`<div class="today-warn">❓ ${d.namesMissing} Buchung${d.namesMissing === 1 ? '' : 'en'} ohne Namen – <button class="today-link" data-goto="noname">jetzt eintragen</button></div>`);
            if (d.openInvoices.count > 0) todo.push(`<div>🧾 ${d.openInvoices.count} offene Rechnung${d.openInvoices.count === 1 ? '' : 'en'} (${formatCurrency(d.openInvoices.total)})</div>`);
            d.warnings.forEach(w => {
                const bad = w.type === 'overlap' || w.type === 'sync' || w.bad;
                const icon = w.type === 'lock' ? '🔋' : '⚠️';
                const ack = w.type === 'overlap' && w.key ? ` <button class="today-link" data-ack="${escapeHtml(w.key)}">ist in Ordnung</button>` : '';
                todo.push(`<div class="${bad ? 'today-bad' : 'today-warn'}">${icon} ${escapeHtml(w.text)}${ack}</div>`);
            });
            $('#today-todo').innerHTML = todo.length ? todo.join('') : '<div class="today-empty">✅ Alles erledigt – nichts offen.</div>';
            $('#today-todo').querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => {
                bookingsFilter = 'noname';
                switchView('bookings');
            }));
            $('#today-todo').querySelectorAll('[data-ack]').forEach(b => b.addEventListener('click', async () => {
                if (!confirm('Überschneidung geprüft und in Ordnung? Danach kommt dazu keine Erinnerung mehr.')) return;
                try {
                    await apiJson('/api/overlaps/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: b.dataset.ack }) });
                } catch (e) { showToast('Speichern fehlgeschlagen', 'error'); }
                loadOverview();
            }));

            const st = $('#today-status');
            if (d.sync && d.sync.at) {
                const mins = Math.max(0, Math.round((Date.now() - new Date(d.sync.at).getTime()) / 60000));
                const failed = (d.sync.feeds || []).filter(f => !f.ok).length;
                st.textContent = `Kalender zuletzt abgefragt: ${mins < 1 ? 'gerade eben' : mins < 90 ? `vor ${mins} Min.` : new Date(d.sync.at).toLocaleString('de-DE')}${failed ? ' · ⚠️ Fehler' : ''}`;
            } else {
                st.textContent = 'Kalender noch nicht abgefragt';
            }
        } catch (e) { /* keep last state */ }
    }

    const overviewSyncBtn = $('#btn-overview-sync');
    if (overviewSyncBtn) {
        overviewSyncBtn.addEventListener('click', async () => {
            overviewSyncBtn.disabled = true;
            const old = overviewSyncBtn.textContent;
            overviewSyncBtn.textContent = 'Frage ab …';
            try {
                const d = await apiJson('/api/ical/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                if (d.success) showToast('Kalender abgefragt' + (d.newCount ? ` – ${d.newCount} neue Buchung(en)` : ''), 'success');
                else showToast(d.error || 'Abfrage fehlgeschlagen', 'error');
            } catch (e) { showToast('Abfrage fehlgeschlagen', 'error'); }
            overviewSyncBtn.disabled = false;
            overviewSyncBtn.textContent = old;
            loadOverview();
        });
    }

    // ---- Buchungen
    let bookingsFilter = 'upcoming';
    let bookingsQuery = '';
    let bookingsData = [];

    // ---- Belegungskalender
    let bookingsMode = 'list';
    let calMonth = null; // 'YYYY-MM', null = current month
    const ymdAdd = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
    const monthShift = (ym, n) => ymdAdd(`${ym}-15`, n * 30).slice(0, 7);
    const nightsTxt = n => `${n} ${n === 1 ? 'Nacht' : 'Nächte'}`;

    function setBookingsMode(mode) {
        bookingsMode = mode;
        $$('#bookings-mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        const cal = mode === 'calendar';
        $('#bookings-calendar').style.display = cal ? 'block' : 'none';
        $('#bookings-list').style.display = cal ? 'none' : '';
        $('#view-bookings .bookings-toolbar').style.display = cal ? 'none' : '';
        loadBookings();
    }

    async function loadCalendar() {
        const grid = $('#occ-grid');
        try {
            const d = await apiJson('/api/calendar' + (calMonth ? `?month=${calMonth}` : ''));
            if (!d.success) { grid.innerHTML = '<div class="bookings-empty">Kalender konnte nicht geladen werden.</div>'; return; }
            calMonth = d.month;
            renderCalendar(d);
        } catch (e) {
            grid.innerHTML = '<div class="bookings-empty">Keine Verbindung zum Server.</div>';
        }
    }

    function renderCalendar(d) {
        const [y, m] = d.month.split('-').map(Number);
        $('#occ-title').textContent = new Date(y, m - 1, 1).toLocaleString('de-DE', { month: 'long', year: 'numeric' });
        $('#occ-rate').textContent = `Auslastung ${d.occupancy.rate} % · ${d.occupancy.nights} von ${d.occupancy.days} Nächten`;

        const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // Monday first
        const cells = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map(w => `<div class="occ-wd">${w}</div>`);
        for (let i = 0; i < lead; i++) cells.push('<div class="occ-day blank"></div>');
        for (let i = 0; i < d.daysInMonth; i++) {
            const day = ymdAdd(d.first, i);
            const nights = d.bookings.filter(b => b.checkin <= day && day < b.checkout);
            const departs = d.bookings.filter(b => b.checkout === day);
            const cls = ['occ-day'];
            if (day === d.today) cls.push('today');
            if (day < d.today) cls.push('past');
            if (nights.length > 1) cls.push('conflict');
            const weekStart = (lead + i) % 7 === 0;
            const bars = nights.map(b => {
                const start = b.checkin === day;
                const label = start || weekStart || i === 0;
                const name = b.name || `${srcLabel(b.source)}-Buchung`;
                const tip = `${name} · ${fmtDEfull(b.checkin)} – ${fmtDEfull(b.checkout)} · ${nightsTxt(b.nights)}`;
                return `<div class="occ-bar ${srcClass(b.source)}${start ? ' start' : ''}${ymdAdd(day, 1) === b.checkout ? ' end' : ''}" title="${escapeHtml(tip)}">${label ? escapeHtml(name) : '&nbsp;'}</div>`;
            }).join('');
            const out = departs.length && !nights.length ? '<div class="occ-out">Abreise</div>' : '';
            cells.push(`<div class="${cls.join(' ')}"><span class="occ-num">${i + 1}</span>${bars}${out}</div>`);
        }
        $('#occ-grid').innerHTML = cells.join('');

        $('#occ-gaps').innerHTML = d.gaps.length ? d.gaps.map(g => `
            <div class="today-row"><span>${weekdayDE(g.from)} ${fmtDEfull(g.from)} – ${g.open ? 'offen' : weekdayDE(g.to) + ' ' + fmtDEfull(g.to)}${!g.open && g.nights <= 2 ? '<span class="tag dep">kurz</span>' : ''}</span>
            <small>${g.open ? 'ab hier frei' : nightsTxt(g.nights)}</small></div>`).join('')
            : '<div class="today-empty">Keine freien Nächte in den nächsten 120 Tagen.</div>';
    }

    $$('#bookings-mode button').forEach(btn => btn.addEventListener('click', () => setBookingsMode(btn.dataset.mode)));
    const occNav = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', () => { fn(); loadCalendar(); }); };
    occNav('#occ-prev', () => { calMonth = monthShift(calMonth, -1); });
    occNav('#occ-next', () => { calMonth = monthShift(calMonth, 1); });
    occNav('#occ-today', () => { calMonth = null; });

    async function loadBookings() {
        if (bookingsMode === 'calendar') return loadCalendar();
        const list = $('#bookings-list');
        if (!list) return;
        $$('#bookings-filter button').forEach(b => b.classList.toggle('active', b.dataset.filter === bookingsFilter));
        try {
            const d = await apiJson(`/api/bookings?filter=${encodeURIComponent(bookingsFilter)}&q=${encodeURIComponent(bookingsQuery)}`);
            if (!d.success) { list.innerHTML = '<div class="bookings-empty">Buchungen konnten nicht geladen werden.</div>'; return; }
            bookingsData = d.bookings;
            renderBookings();
        } catch (e) {
            list.innerHTML = '<div class="bookings-empty">Keine Verbindung zum Server.</div>';
        }
    }

    function renderBookings() {
        const list = $('#bookings-list');
        if (!bookingsData.length) { list.innerHTML = '<div class="bookings-empty">Keine Buchungen gefunden.</div>'; return; }
        list.innerHTML = bookingsData.map(b => {
            const stateTxt = b.state === 'inhouse' ? 'Im Haus' : b.state === 'departing' ? 'Reist heute ab' : b.state === 'past' ? 'Beendet' : '';
            const code = b.hasCode ? (b.arrivedAt ? '🔑 Code genutzt' : '🔑 Code angelegt') : '— kein Code';
            return `<div class="card booking-card" data-id="${b.id}">
                <div>
                    <div class="booking-name">${b.needsName ? '<span class="booking-noname">❓ Name fehlt</span>' : escapeHtml(b.name)}<span class="src ${srcClass(b.source)}">${escapeHtml(srcLabel(b.source))}</span></div>
                    <div class="booking-sub">${stateTxt}</div>
                </div>
                <div><div>${fmtDEfull(b.checkin)} – ${fmtDEfull(b.checkout)}</div><div class="booking-sub">${nightsTxt(b.nights)}</div></div>
                <div class="booking-sub">${code}${b.guestCode ? `<br>Gastcode ${escapeHtml(b.guestCode)}` : ''}</div>
                <div class="booking-actions">
                    <button class="btn-mini" data-act="name">${b.needsName ? 'Namen eintragen' : 'Name ändern'}</button>
                    ${b.state !== 'past' && b.guestCode ? '<button class="btn-mini" data-act="guestlink" title="Nachricht mit Link und Buchungscode für den Gast kopieren">Gastlink</button>' : ''}
                    <button class="btn-mini" data-act="invoice">Rechnung erstellen</button>
                </div>
            </div>`;
        }).join('');
    }

    function startNameEdit(card, b) {
        const nameBox = card.querySelector('.booking-name');
        nameBox.innerHTML = `<input type="text" maxlength="80" placeholder="Vor- und Nachname" value="${escapeHtml(b.name || '').replace(/"/g, '&quot;')}">`;
        const input = nameBox.querySelector('input');
        input.focus();
        let busy = false;
        const save = async () => {
            if (busy) return;
            const name = input.value.trim();
            if (name.length < 2) { renderBookings(); return; }
            busy = true;
            try {
                const d = await apiJson(`/api/bookings/${b.id}/guest`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
                if (d.success) showToast('Name gespeichert' + (d.nukiRenamed ? ' – Türcode umbenannt' : ''), 'success');
                else showToast(d.error || 'Speichern fehlgeschlagen', 'error');
            } catch (e) { showToast('Speichern fehlgeschlagen', 'error'); }
            loadBookings();
        };
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') renderBookings();
        });
        input.addEventListener('blur', save);
    }

    function invoiceFromBooking(b) {
        switchView('invoice');
        const set = (sel, val) => { const el = $(sel); if (el && val) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } };
        set('#g-name', b.name);
        set('#g-email', b.guestEmail);
        set('#a-anreise', b.checkin);
        set('#a-abreise', b.checkout);
        if (!b.name) showToast('Bitte noch den Gastnamen eintragen', 'info');
    }

    const bookingsListEl = $('#bookings-list');
    if (bookingsListEl) {
        bookingsListEl.addEventListener('mousedown', e => { /* keep blur-save from swallowing button clicks */ });
        bookingsListEl.addEventListener('click', e => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const card = btn.closest('.booking-card');
            const b = bookingsData.find(x => String(x.id) === card.dataset.id);
            if (!b) return;
            if (btn.dataset.act === 'name') startNameEdit(card, b);
            else if (btn.dataset.act === 'guestlink') copyGuestMessage(b);
            else invoiceFromBooking(b);
        });
        $$('#bookings-filter button').forEach(btn => btn.addEventListener('click', () => { bookingsFilter = btn.dataset.filter; loadBookings(); }));
        let searchTimer = null;
        const searchEl = $('#bookings-search');
        if (searchEl) searchEl.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { bookingsQuery = searchEl.value.trim(); loadBookings(); }, 250); });
    }

    // =======================
    // Kalender-Startseite (Zeitleiste, bevorstehende Buchungen, Aktivitätsfeed)
    // =======================
    const TL_DAYS = 56;
    const berlinYmd = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
    const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    const pfKey = s => /airbnb/i.test(s || '') ? 'airbnb' : s === 'manual' ? 'manual' : s === 'Direkt' ? 'direct' : s === 'request' ? 'request' : 'booking';
    const pfLetter = { booking: 'B', airbnb: 'A', direct: 'D', manual: 'M', request: '?' };
    const pfBadge = s => { const k = pfKey(s); return `<i class="pf pf-${k}" title="${escapeHtml(k === 'request' ? 'Anfrage' : srcLabel(s))}">${pfLetter[k]}</i>`; };
    const dateLong = ymd => `${weekdayDE(ymd)} ${fmtDEfull(ymd)}`;
    const ICON = {
        person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>',
        moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>',
        clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
        inn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M3 12h11M10 8l4 4-4 4"/></svg>',
        out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5M21 12H10M17 8l4 4-4 4"/></svg>',
        euro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/></svg>',
        home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>'
    };

    let tlStart = null;
    let calHome = { bookings: [], requests: [], activity: [], overview: null, site: null, today: berlinYmd() };

    function relTime(iso) {
        if (!iso) return '';
        const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
        if (isNaN(mins)) return '';
        if (mins < 1) return 'gerade eben';
        if (mins < 60) return `vor ${mins} Min.`;
        const h = Math.round(mins / 60);
        if (h < 24) return h === 1 ? 'vor einer Stunde' : `vor ${h} Stunden`;
        const d = Math.round(h / 24);
        if (d < 30) return d === 1 ? 'vor einem Tag' : `vor ${d} Tagen`;
        return new Date(iso).toLocaleDateString('de-DE');
    }

    async function loadCalendarHome() {
        if (!viewCalendar) return;
        calHome.today = berlinYmd();
        if (!tlStart) tlStart = ymdAdd(calHome.today, -3);
        const get = url => apiJson(url).catch(() => null);
        const [b, r, a, o, s] = await Promise.all([
            get('/api/bookings?filter=all'), get('/api/site/requests'), get('/api/activity'), get('/api/overview'),
            calHome.site ? Promise.resolve(null) : get('/api/site/settings')
        ]);
        if (b && b.success) calHome.bookings = b.bookings;
        if (r && r.success) calHome.requests = r.requests.filter(x => x.status === 'pending');
        if (a && a.success) calHome.activity = a.items;
        if (o && o.success) { calHome.overview = o; calHome.today = o.today || calHome.today; }
        if (s && s.success) calHome.site = s.site;
        renderTimeline();
        renderUpcoming();
        renderActivity();
        renderCalAlerts();
    }

    function renderTimeline() {
        const today = calHome.today;
        const days = Array.from({ length: TL_DAYS }, (_, i) => ymdAdd(tlStart, i));
        const end = ymdAdd(tlStart, TL_DAYS);
        const idx = ymd => nightsBetweenYmd(tlStart, ymd);
        const mid = ymdAdd(tlStart, 3);
        const [my, mm] = mid.split('-').map(Number);
        $('#tl-label').textContent = `${MONTHS_DE[mm - 1]} ${my}`;
        $('#tl-month').value = mid.slice(0, 7);

        // Auslastung des angezeigten Monats
        const mFirst = `${mid.slice(0, 7)}-01`;
        const mNext = ymdAdd(mFirst, 32).slice(0, 7) + '-01';
        const mDays = nightsBetweenYmd(mFirst, mNext);
        const booked = new Set();
        calHome.bookings.forEach(bk => { for (let d = bk.checkin < mFirst ? mFirst : bk.checkin; d < bk.checkout && d < mNext; d = ymdAdd(d, 1)) booked.add(d); });
        $('#tl-rate').textContent = `Auslastung ${MONTHS_DE[mm - 1]}: ${Math.round(booked.size / mDays * 100)} % (${booked.size}/${mDays} Nächte)`;

        // Kopf: Monate und Tage
        const months = [];
        days.forEach((d, i) => {
            const key = d.slice(0, 7);
            if (!months.length || months[months.length - 1].key !== key) months.push({ key, from: i, n: 0 });
            months[months.length - 1].n++;
        });
        const head = `<div class="tl-months">${months.map(m => `<div class="tl-month" style="left:calc(var(--tl-day) * ${m.from});width:calc(var(--tl-day) * ${m.n})"><span>${MONTHS_DE[Number(m.key.slice(5)) - 1]}${m.key.slice(0, 4) !== today.slice(0, 4) ? ' ' + m.key.slice(0, 4) : ''}</span></div>`).join('')}</div>
            <div class="tl-days">${days.map(d => {
                const wd = new Date(d + 'T12:00:00').getDay();
                return `<div class="tl-day${wd === 0 || wd === 6 ? ' we' : ''}${d === today ? ' today' : ''}"><span class="tl-wd">${weekdayDE(d)}</span><span class="tl-dn">${Number(d.slice(8))}</span></div>`;
            }).join('')}</div>`;

        const cells = days.map(d => {
            const wd = new Date(d + 'T12:00:00').getDay();
            return `<div class="tl-cell${wd === 0 || wd === 6 ? ' we' : ''}${d < today ? ' past' : ''}" data-day="${d}"></div>`;
        }).join('');

        const bar = (item, key, label, attrs) => {
            const a = Math.max(idx(item.checkin) + 0.5, 0);
            const z = Math.min(idx(item.checkout) + 0.5, TL_DAYS);
            if (z <= 0 || a >= TL_DAYS || z - a <= 0) return '';
            const cls = ['tl-bar', `pf-bg-${key}`];
            if (idx(item.checkin) + 0.5 < 0) cls.push('cut-l');
            if (idx(item.checkout) + 0.5 > TL_DAYS) cls.push('cut-r');
            if (item.checkout <= today) cls.push('done');
            const tip = `${label} · ${fmtDEfull(item.checkin)} – ${fmtDEfull(item.checkout)} · ${nightsTxt(item.nights)}`;
            return `<button type="button" class="${cls.join(' ')}" style="left:calc(var(--tl-day) * ${a} + 2px);width:calc(var(--tl-day) * ${z - a} - 4px)" title="${escapeHtml(tip)}" ${attrs}><i class="pf pf-${key}">${pfLetter[key]}</i><span>${escapeHtml(label)}</span></button>`;
        };
        const inRange = x => x.checkin < end && x.checkout > tlStart;
        const bookingBars = calHome.bookings.filter(inRange).map(bk => bar(bk, pfKey(bk.source), bk.name || `${srcLabel(bk.source)}-Gast`, `data-bid="${bk.id}"`)).join('');
        const requestBars = calHome.requests.filter(inRange).map(rq => bar({ ...rq, nights: rq.nights }, 'request', rq.name, `data-rid="${rq.id}"`)).join('');
        const todayLine = today >= tlStart && today < end ? `<div class="tl-now" style="left:calc(var(--tl-day) * ${idx(today) + 0.5})"></div>` : '';

        const unit = (calHome.site && calHome.site.title) || 'Ferienwohnung';
        $('#tl-side').innerHTML = `<div class="tl-side-head"></div>
            <div class="tl-side-row" title="${escapeHtml(unit)}">${escapeHtml(unit)}</div>
            <div class="tl-side-row tl-side-sub">Offene Anfragen${calHome.requests.length ? ` <b>${calHome.requests.length}</b>` : ''}</div>`;
        $('#tl-inner').style.setProperty('--tl-n', TL_DAYS);
        $('#tl-inner').innerHTML = `<div class="tl-head">${head}</div>
            <div class="tl-row" data-row="unit">${cells}${bookingBars}${todayLine}</div>
            <div class="tl-row tl-row-sub" data-row="requests">${cells}${requestBars}${todayLine}</div>`;
    }

    function nightsBetweenYmd(a, b) {
        return Math.round((Date.UTC(...b.split('-').map((x, i) => i === 1 ? x - 1 : +x)) - Date.UTC(...a.split('-').map((x, i) => i === 1 ? x - 1 : +x))) / 86400000);
    }

    function renderUpcoming() {
        const today = calHome.today;
        const site = calHome.site || {};
        const evs = [];
        calHome.bookings.filter(bk => bk.checkout >= today).forEach(bk => {
            if (bk.checkin >= today) evs.push({ type: 'in', date: bk.checkin, b: bk });
            evs.push({ type: 'out', date: bk.checkout, b: bk });
        });
        evs.sort((x, y) => x.date.localeCompare(y.date) || (x.type === 'out' ? -1 : 1));
        const box = $('#cal-upcoming');
        if (!evs.length) { box.innerHTML = '<div class="panel-empty">Keine bevorstehenden An- oder Abreisen.</div>'; return; }
        box.innerHTML = evs.slice(0, 10).map(e => {
            const when = e.date === today ? 'Heute' : e.date === ymdAdd(today, 1) ? 'Morgen' : weekdayDE(e.date);
            const time = e.type === 'in' ? (site.checkin_time || '') : (site.checkout_time || '');
            return `<button type="button" class="up-card" data-bid="${e.b.id}">
                <div class="up-line">
                    <span class="chip ${e.type === 'in' ? 'chip-in' : 'chip-out'}">${e.type === 'in' ? 'Check-in' : 'Check-out'}</span>
                    <span class="meta">${e.type === 'in' ? ICON.inn : ICON.out}<b>${when}</b> ${fmtDEfull(e.date)}</span>
                    ${time ? `<span class="meta">${ICON.clock}${escapeHtml(time)}</span>` : ''}
                    <span class="meta push">${ICON.moon}${e.b.nights}</span>
                </div>
                <div class="up-line">
                    <span class="meta">${ICON.person}${e.b.name ? escapeHtml(e.b.name) : '<em>Name fehlt</em>'}</span>
                    <span class="meta">${pfBadge(e.b.source)}${escapeHtml(srcLabel(e.b.source))}</span>
                    ${e.b.hasCode ? '<span class="meta push ok">Türcode ✓</span>' : (e.type === 'in' ? '<span class="meta push warn">kein Türcode</span>' : '')}
                </div>
            </button>`;
        }).join('');
    }

    function renderActivity() {
        const box = $('#cal-activity');
        const items = calHome.activity;
        if (!items.length) { box.innerHTML = '<div class="panel-empty">Noch keine Aktivitäten.</div>'; return; }
        const label = it => {
            if (it.type === 'booking') return ['chip-new', 'Neue Buchung'];
            if (it.type === 'manual') return ['chip-new', 'Eingetragen'];
            if (it.type === 'arrival') return ['chip-gray', 'Angereist'];
            if (it.type === 'invoice') return ['chip-blue', `Rechnung ${it.number || ''}`.trim()];
            if (it.status === 'confirmed') return ['chip-new', 'Anfrage bestätigt'];
            if (it.status === 'declined' || it.status === 'cancelled') return ['chip-gray', 'Anfrage abgelehnt'];
            return ['chip-warn', 'Neue Anfrage'];
        };
        box.innerHTML = items.map(it => {
            const [cls, txt] = label(it);
            const src = it.type === 'invoice' ? 'invoice' : it.type === 'request' ? 'request' : it.source;
            const badge = src === 'invoice' ? '<i class="pf pf-invoice">€</i>' : pfBadge(src);
            const right1 = [
                it.amount ? `<span class="meta">${ICON.euro}${formatCurrency(it.amount)}</span>` : '',
                it.nights ? `<span class="meta">${ICON.moon}${it.nights}</span>` : ''
            ].join('');
            const attrs = it.bookingId ? `data-bid="${it.bookingId}"` : it.type === 'request' ? 'data-goto="requests"' : it.type === 'invoice' ? 'data-goto="invoice"' : '';
            return `<button type="button" class="act-card" ${attrs}>
                <div class="up-line">${badge}<span class="chip ${cls}">${escapeHtml(txt)}</span>${it.type === 'invoice' && it.paid ? '<span class="chip chip-new">bezahlt</span>' : ''}<span class="push">${right1}</span></div>
                <div class="up-line"><span class="meta">${ICON.person}${it.name ? escapeHtml(it.name) : '<em>Name fehlt</em>'}</span>${it.checkin ? `<span class="meta push">${ICON.inn}${dateLong(it.checkin)}</span>` : ''}</div>
                <div class="up-line"><span class="meta muted">${ICON.home}${escapeHtml(it.type === 'invoice' ? 'Rechnung' : it.type === 'request' ? 'Webseite' : srcLabel(it.source || ''))}</span><span class="meta push muted">${relTime(it.at)}</span></div>
            </button>`;
        }).join('');
    }

    function renderCalAlerts() {
        const o = calHome.overview;
        const box = $('#cal-alerts');
        const sync = $('#cal-sync');
        if (!o) { box.innerHTML = ''; return; }
        const list = [];
        if (o.namesMissing > 0) list.push(`<button type="button" class="alert warn" data-goto="noname">${o.namesMissing} Buchung${o.namesMissing === 1 ? '' : 'en'} ohne Namen – jetzt eintragen</button>`);
        if (calHome.requests.length) list.push(`<button type="button" class="alert info" data-goto="requests">${calHome.requests.length} offene Anfrage${calHome.requests.length === 1 ? '' : 'n'} von der Webseite</button>`);
        if (o.openInvoices && o.openInvoices.count > 0) list.push(`<span class="alert">${o.openInvoices.count} offene Rechnung${o.openInvoices.count === 1 ? '' : 'en'} (${formatCurrency(o.openInvoices.total)})</span>`);
        (o.warnings || []).forEach(w => list.push(`<span class="alert ${w.type === 'overlap' || w.type === 'sync' ? 'bad' : 'warn'}">${escapeHtml(w.text)}</span>`));
        box.innerHTML = list.join('');
        if (o.sync && o.sync.at) {
            const mins = Math.max(0, Math.round((Date.now() - new Date(o.sync.at).getTime()) / 60000));
            const failed = (o.sync.feeds || []).filter(f => !f.ok).length;
            sync.textContent = `Portale abgefragt ${mins < 1 ? 'gerade eben' : mins < 90 ? `vor ${mins} Min.` : new Date(o.sync.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}${failed ? ' · Fehler' : ''}`;
        } else sync.textContent = 'Portale noch nicht abgefragt';
    }

    // ---- Details-Fenster zu einem Balken
    const tlPop = $('#tl-pop');
    function hideTlPop() { if (tlPop) { tlPop.hidden = true; tlPop.innerHTML = ''; } }

    function placePop(anchor) {
        tlPop.hidden = false;
        const r = anchor.getBoundingClientRect();
        const w = tlPop.offsetWidth, h = tlPop.offsetHeight;
        let left = Math.min(Math.max(8, r.left + Math.min(r.width, 240) / 2 - w / 2), window.innerWidth - w - 8);
        let top = r.bottom + 8;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
        tlPop.style.left = `${left}px`;
        tlPop.style.top = `${top}px`;
    }

    function showBookingPop(bk, anchor) {
        const today = calHome.today;
        const state = bk.state === 'inhouse' ? 'Im Haus' : bk.state === 'departing' ? 'Reist heute ab' : bk.state === 'past' ? 'Beendet' : bk.checkin === today ? 'Reist heute an' : 'Bevorstehend';
        tlPop.innerHTML = `
            <div class="pop-head">${pfBadge(bk.source)}<strong class="pop-name">${bk.name ? escapeHtml(bk.name) : '<em>Name fehlt</em>'}</strong><button type="button" class="pop-x" data-pop="close" aria-label="Schließen">✕</button></div>
            <dl class="pop-dl">
                <dt>Zeitraum</dt><dd>${dateLong(bk.checkin)} – ${dateLong(bk.checkout)}</dd>
                <dt>Dauer</dt><dd>${nightsTxt(bk.nights)}</dd>
                <dt>Quelle</dt><dd>${escapeHtml(srcLabel(bk.source))}${bk.manualEntry ? ' · selbst eingetragen' : ''}</dd>
                <dt>Status</dt><dd>${state}</dd>
                <dt>Türcode</dt><dd>${bk.hasCode ? (bk.pin ? `<code>${escapeHtml(bk.pin)}</code>` : 'angelegt') + (bk.arrivedAt ? ' · genutzt' : '') : 'kein Code'}</dd>
                ${bk.guestCode ? `<dt>Gastcode</dt><dd><code>${escapeHtml(bk.guestCode)}</code></dd>` : ''}
                ${bk.guestEmail ? `<dt>E-Mail</dt><dd>${escapeHtml(bk.guestEmail)}</dd>` : ''}
                <dt>Meldeschein</dt><dd>${bk.meldescheinId ? 'ausgefüllt ✓' : bk.state === 'past' ? '–' : 'fehlt noch'}</dd>
            </dl>
            <div class="pop-actions">
                <button type="button" class="pill" data-pop="name">${bk.needsName ? 'Namen eintragen' : 'Name ändern'}</button>
                <button type="button" class="pill" data-pop="invoice">Rechnung erstellen</button>
                ${bk.meldescheinId ? '<button type="button" class="pill" data-pop="meldeschein">Meldeschein</button>' : ''}
                ${bk.state !== 'past' ? `<button type="button" class="pill" data-pop="doorcode">${bk.hasCode ? 'Türcode bearbeiten' : 'Türcode anlegen'}</button>` : ''}
                ${bk.state !== 'past' && bk.guestCode ? '<button type="button" class="pill" data-pop="guestlink">Gastlink kopieren</button>' : ''}
                ${bk.manualEntry ? '<button type="button" class="pill pill-danger" data-pop="delete">Löschen</button>' : ''}
            </div>`;
        tlPop.dataset.bid = bk.id;
        delete tlPop.dataset.rid;
        placePop(anchor);
    }

    function showRequestPop(rq, anchor) {
        tlPop.innerHTML = `
            <div class="pop-head">${pfBadge('request')}<strong class="pop-name">${escapeHtml(rq.name)}</strong><button type="button" class="pop-x" data-pop="close" aria-label="Schließen">✕</button></div>
            <dl class="pop-dl">
                <dt>Zeitraum</dt><dd>${dateLong(rq.checkin)} – ${dateLong(rq.checkout)}</dd>
                <dt>Dauer</dt><dd>${nightsTxt(rq.nights)}</dd>
                <dt>Gäste</dt><dd>${rq.adults || 1} Erw.${rq.children ? ` · ${rq.children} Kinder` : ''}</dd>
                ${rq.price_total ? `<dt>Preis</dt><dd>${formatCurrency(rq.price_total)}</dd>` : ''}
                ${rq.conflict ? `<dt>Achtung</dt><dd class="bad">überschneidet sich mit ${escapeHtml(rq.conflict.source)}</dd>` : ''}
            </dl>
            <div class="pop-actions"><button type="button" class="pill pill-primary" data-pop="request">Anfrage bearbeiten</button></div>`;
        tlPop.dataset.rid = rq.id;
        delete tlPop.dataset.bid;
        placePop(anchor);
    }

    function openRequests() {
        switchView('website');
        setSiteTab('requests');
    }

    if (viewCalendar) {
        viewCalendar.addEventListener('click', e => {
            const goto = e.target.closest('[data-goto]');
            if (goto) {
                const g = goto.dataset.goto;
                if (g === 'requests') return openRequests();
                if (g === 'invoice') return switchView('invoice');
                if (g === 'noname') { bookingsFilter = 'noname'; return switchView('bookings'); }
            }
            const bEl = e.target.closest('[data-bid]');
            if (bEl) {
                const bk = calHome.bookings.find(x => String(x.id) === bEl.dataset.bid);
                if (bk) { e.stopPropagation(); return showBookingPop(bk, bEl); }
            }
            const rEl = e.target.closest('[data-rid]');
            if (rEl) {
                const rq = calHome.requests.find(x => String(x.id) === rEl.dataset.rid);
                if (rq) { e.stopPropagation(); return showRequestPop(rq, rEl); }
            }
            const cell = e.target.closest('.tl-row[data-row="unit"] .tl-cell');
            if (cell && cell.dataset.day >= calHome.today) { e.stopPropagation(); openNewBooking(cell.dataset.day); return; }
            const tog = e.target.closest('.panel-toggle');
            if (tog) tog.closest('.panel').classList.toggle('collapsed');
        });

        tlPop.addEventListener('click', async e => {
            const btn = e.target.closest('[data-pop]');
            if (!btn) return;
            e.stopPropagation();
            const act = btn.dataset.pop;
            if (act === 'close') return hideTlPop();
            if (act === 'request') { hideTlPop(); return openRequests(); }
            const bk = calHome.bookings.find(x => String(x.id) === tlPop.dataset.bid);
            if (!bk) return hideTlPop();
            if (act === 'invoice') { hideTlPop(); return invoiceFromBooking(bk); }
            if (act === 'guestlink') return copyGuestMessage(bk);
            if (act === 'meldeschein') { hideTlPop(); return window.open(`/api/meldescheine/${bk.meldescheinId}/druck`, '_blank', 'noopener'); }
            if (act === 'doorcode') { hideTlPop(); return openDoorCode(bk); }
            if (act === 'delete') {
                if (!confirm(`Buchung von ${bk.name || 'diesem Gast'} (${fmtDEfull(bk.checkin)} – ${fmtDEfull(bk.checkout)}) löschen?${bk.hasCode ? ' Der Türcode wird ebenfalls gelöscht.' : ''}`)) return;
                const d = await apiJson(`/api/bookings/${bk.id}`, { method: 'DELETE' }).catch(() => null);
                if (d && d.success) { showToast('Buchung gelöscht', 'success'); hideTlPop(); loadCalendarHome(); }
                else showToast((d && d.error) || 'Löschen fehlgeschlagen', 'error');
                return;
            }
            if (act === 'name') {
                const nameEl = tlPop.querySelector('.pop-name');
                nameEl.innerHTML = `<input type="text" maxlength="80" placeholder="Vor- und Nachname" value="${escapeHtml(bk.name || '').replace(/"/g, '&quot;')}">`;
                const input = nameEl.querySelector('input');
                input.focus();
                input.addEventListener('keydown', async ev => {
                    if (ev.key === 'Escape') return showBookingPop(bk, btn);
                    if (ev.key !== 'Enter') return;
                    const name = input.value.trim();
                    if (name.length < 2) return;
                    const d = await apiJson(`/api/bookings/${bk.id}/guest`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => null);
                    if (d && d.success) { showToast('Name gespeichert' + (d.nukiRenamed ? ' – Türcode umbenannt' : ''), 'success'); hideTlPop(); loadCalendarHome(); }
                    else showToast((d && d.error) || 'Speichern fehlgeschlagen', 'error');
                });
            }
        });
        document.addEventListener('click', e => { if (!tlPop.hidden && !tlPop.contains(e.target)) hideTlPop(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTlPop(); });
        $('#tl-scroll').addEventListener('scroll', hideTlPop, { passive: true });

        const tlGo = fn => { fn(); hideTlPop(); renderTimeline(); };
        $('#tl-prev').addEventListener('click', () => tlGo(() => { tlStart = ymdAdd(tlStart, -14); }));
        $('#tl-next').addEventListener('click', () => tlGo(() => { tlStart = ymdAdd(tlStart, 14); }));
        $('#tl-today').addEventListener('click', () => tlGo(() => { tlStart = ymdAdd(calHome.today, -3); $('#tl-scroll').scrollLeft = 0; }));
        $('#tl-month').addEventListener('change', e => { if (e.target.value) tlGo(() => { tlStart = `${e.target.value}-01`; $('#tl-scroll').scrollLeft = 0; }); });

        $('#cal-sync-btn').addEventListener('click', async e => {
            const btn = e.currentTarget;
            btn.disabled = true;
            const old = btn.textContent;
            btn.textContent = 'Frage ab …';
            try {
                const d = await apiJson('/api/ical/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                if (d.success) showToast('Kalender abgefragt' + (d.newCount ? ` – ${d.newCount} neue Buchung(en)` : ''), 'success');
                else showToast(d.error || 'Abfrage fehlgeschlagen', 'error');
            } catch (err) { showToast('Abfrage fehlgeschlagen', 'error'); }
            btn.disabled = false;
            btn.textContent = old;
            loadCalendarHome();
        });
    }

    // ---- Buchung eintragen
    const modalNewBooking = $('#modal-new-booking');
    let nbForce = false;

    function nbUpdateNights() {
        const a = $('#nb-checkin').value, b = $('#nb-checkout').value;
        const n = a && b ? nightsBetweenYmd(a, b) : 0;
        $('#nb-nights').textContent = n > 0 ? nightsTxt(n) : '';
    }

    function openNewBooking(day) {
        if (!modalNewBooking) return;
        hideTlPop();
        $('#nb-form').reset();
        $('#nb-pin').checked = true;
        const from = day || calHome.today || berlinYmd();
        $('#nb-checkin').value = from;
        $('#nb-checkout').value = ymdAdd(from, 1);
        $('#nb-msg').hidden = true;
        nbForce = false;
        $('#btn-save-new-booking').textContent = 'Buchung speichern';
        nbUpdateNights();
        modalNewBooking.style.display = 'flex';
        setTimeout(() => $('#nb-name').focus(), 50);
    }
    const closeNewBooking = () => { modalNewBooking.style.display = 'none'; };

    if (modalNewBooking) {
        $('#btn-new-booking').addEventListener('click', () => openNewBooking());
        $('#btn-close-new-booking').addEventListener('click', closeNewBooking);
        $('#btn-cancel-new-booking').addEventListener('click', closeNewBooking);
        modalNewBooking.addEventListener('click', e => { if (e.target === modalNewBooking) closeNewBooking(); });
        ['#nb-checkin', '#nb-checkout'].forEach(sel => $(sel).addEventListener('change', () => {
            if (sel === '#nb-checkin' && $('#nb-checkout').value <= $('#nb-checkin').value) $('#nb-checkout').value = ymdAdd($('#nb-checkin').value, 1);
            nbForce = false;
            $('#btn-save-new-booking').textContent = 'Buchung speichern';
            nbUpdateNights();
        }));
        $('#nb-form').addEventListener('submit', async e => {
            e.preventDefault();
            const msg = $('#nb-msg');
            const btn = $('#btn-save-new-booking');
            const body = {
                name: $('#nb-name').value.trim(), email: $('#nb-email').value.trim(), phone: $('#nb-phone').value.trim(),
                checkin: $('#nb-checkin').value, checkout: $('#nb-checkout').value, note: $('#nb-note').value.trim(),
                createPin: $('#nb-pin').checked, force: nbForce
            };
            btn.disabled = true;
            try {
                const res = await fetch('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                const d = await res.json();
                if (d.success) {
                    closeNewBooking();
                    showToast(`Buchung gespeichert${d.pin ? ` – Türcode ${d.pin}` : ''}`, 'success', 5000);
                    if (d.pinError) showToast(`Türcode nicht angelegt: ${d.pinError}`, 'error', 6000);
                    tlStart = ymdAdd(body.checkin, -3);
                    if (currentView === 'calendar') loadCalendarHome(); else switchView('calendar');
                } else {
                    msg.hidden = false;
                    msg.textContent = d.error || 'Speichern fehlgeschlagen';
                    if (d.conflict) { nbForce = true; btn.textContent = 'Trotzdem speichern'; }
                }
            } catch (err) {
                msg.hidden = false;
                msg.textContent = 'Keine Verbindung zum Server.';
            }
            btn.disabled = false;
        });
    }

    // ---- Türcode einer Buchung bearbeiten (Name + Gültigkeit direkt im Nuki-Schloss)
    const modalDoorCode = $('#modal-door-code');
    let dcBooking = null, dcCreate = false;
    const closeDoorCode = () => { if (modalDoorCode) modalDoorCode.style.display = 'none'; };
    async function openDoorCode(bk) {
        if (!modalDoorCode) return;
        dcBooking = bk;
        const msg = $('#dc-msg');
        msg.hidden = true;
        $('#dc-pin').textContent = 'Lade Türcode aus dem Nuki-Schloss …';
        $('#dc-name').value = '';
        $('#dc-from').value = bk.checkin;
        $('#dc-until').value = bk.checkout;
        $('#btn-save-door-code').disabled = true;
        $('#btn-save-door-code').textContent = 'Speichern';
        modalDoorCode.style.display = 'flex';
        const d = await apiJson(`/api/bookings/${bk.id}/nuki`).catch(e => ({ success: false, error: e.message }));
        if (!d || !d.success) {
            $('#dc-pin').textContent = '';
            msg.hidden = false;
            msg.textContent = (d && d.error) || 'Türcode konnte nicht geladen werden.';
            return;
        }
        dcCreate = !d.hasCode;
        $('#dc-title').textContent = dcCreate ? 'Türcode anlegen' : 'Türcode bearbeiten';
        $('#dc-hint').textContent = dcCreate
            ? (d.lost ? `Der bisherige Code ${d.pin || ''} ist nicht mehr im Schloss. Es wird ein neuer Code angelegt.` : 'Für diese Buchung gibt es noch keinen Türcode. Es wird ein neuer Code angelegt.')
            : 'Der vorhandene Code wird direkt im Nuki-Schloss geändert. Die Ziffern bleiben gleich, es entsteht kein zweiter Code.';
        $('#dc-pin').innerHTML = d.hasCode ? `Code: <code>${escapeHtml(d.pin)}</code>${d.enabled === false ? ' · <span class="bad">deaktiviert</span>' : ''}` : '';
        $('#dc-name').value = d.hasCode ? (d.name || d.suggestedName) : d.suggestedName;
        $('#dc-from').value = (d.hasCode && d.from) || d.checkin;
        $('#dc-until').value = (d.hasCode && d.until) || d.checkout;
        $('#dc-also-wrap').hidden = !d.editableBooking;
        $('#dc-also').checked = true;
        $('#btn-save-door-code').disabled = false;
        setTimeout(() => $('#dc-name').focus(), 50);
    }
    if (modalDoorCode) {
        $('#btn-close-door-code').addEventListener('click', closeDoorCode);
        $('#btn-cancel-door-code').addEventListener('click', closeDoorCode);
        modalDoorCode.addEventListener('click', e => { if (e.target === modalDoorCode) closeDoorCode(); });
        $('#dc-from').addEventListener('change', () => {
            if ($('#dc-until').value <= $('#dc-from').value) $('#dc-until').value = ymdAdd($('#dc-from').value, 1);
        });
        $('#dc-form').addEventListener('submit', async e => {
            e.preventDefault();
            if (!dcBooking) return;
            const msg = $('#dc-msg');
            const btn = $('#btn-save-door-code');
            const body = {
                name: $('#dc-name').value.trim(), from: $('#dc-from').value, until: $('#dc-until').value,
                alsoBooking: !$('#dc-also-wrap').hidden && $('#dc-also').checked, createIfMissing: dcCreate
            };
            btn.disabled = true;
            msg.hidden = true;
            try {
                const res = await fetch(`/api/bookings/${dcBooking.id}/nuki`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                const d = await res.json();
                if (d.success) {
                    closeDoorCode();
                    showToast(d.created ? `Türcode ${d.pin} angelegt` : `Türcode ${d.pin} geändert`, 'success', 5000);
                    if (currentView === 'calendar') loadCalendarHome();
                } else {
                    msg.hidden = false;
                    msg.textContent = d.error || 'Speichern fehlgeschlagen';
                    if (d.missing) { dcCreate = true; btn.textContent = 'Neuen Code anlegen'; }
                }
            } catch (err) {
                msg.hidden = false;
                msg.textContent = 'Keine Verbindung zum Server.';
            }
            btn.disabled = false;
        });
    }

    // ---- Suche in der Kopfzeile
    const topSearch = $('#topbar-search');
    if (topSearch) {
        let tsTimer = null;
        const runSearch = () => {
            const q = topSearch.value.trim();
            if (!q && currentView !== 'bookings') return;
            bookingsQuery = q;
            bookingsFilter = q ? 'all' : 'upcoming';
            const inner = $('#bookings-search');
            if (inner) inner.value = q;
            if (bookingsMode === 'calendar') setBookingsMode('list');
            if (currentView !== 'bookings') switchView('bookings'); else loadBookings();
        };
        topSearch.addEventListener('input', () => { clearTimeout(tsTimer); tsTimer = setTimeout(runSearch, 300); });
        topSearch.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(tsTimer); runSearch(); } });
    }

    // ---- Seitenleiste: Gruppen und Einklappen
    function syncNavGroups() {
        $$('.nav-group').forEach(g => {
            const hasActive = !!g.querySelector('.sidebar-item.active');
            if (hasActive) g.classList.add('open');
            g.classList.toggle('has-active', hasActive);
            g.querySelector('.nav-group-toggle').setAttribute('aria-expanded', g.classList.contains('open'));
        });
    }
    $$('.nav-group-toggle').forEach(t => t.addEventListener('click', () => {
        const g = t.closest('.nav-group');
        if (appWrapper.classList.contains('nav-collapsed')) appWrapper.classList.remove('nav-collapsed');
        g.classList.toggle('open');
        t.setAttribute('aria-expanded', g.classList.contains('open'));
    }));
    const navCollapseBtn = $('#btn-nav-collapse');
    try { if (localStorage.getItem('navCollapsed') === '1' && window.innerWidth > 768) appWrapper.classList.add('nav-collapsed'); } catch (e) { /* ignore */ }
    if (navCollapseBtn) navCollapseBtn.addEventListener('click', () => {
        const on = appWrapper.classList.toggle('nav-collapsed');
        try { localStorage.setItem('navCollapsed', on ? '1' : '0'); } catch (e) { /* ignore */ }
    });

    // ---- Benutzername oben rechts
    async function loadTopbarUser() {
        try {
            const d = await apiJson('/api/me');
            const u = d && d.user;
            const name = typeof u === 'string' ? u : (u && (u.username || u.name)) || '';
            const el = $('#topbar-user');
            if (el) el.textContent = name;
        } catch (e) { /* ignore */ }
    }

    // =======================
    // Gäste-Webseite (Anfragen, Inhalte, Einrichtung)
    // =======================
    let siteTab = 'requests';
    let siteData = null;
    let siteRequests = [];

    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); return true; } catch (e) {
            const ta = document.createElement('textarea');
            ta.value = text; document.body.appendChild(ta); ta.select();
            const ok = document.execCommand('copy'); ta.remove(); return ok;
        }
    }

    async function copyGuestMessage(b) {
        try {
            const d = await apiJson(`/api/site/guest-message/${b.id}`);
            if (!d.success) return showToast('Gastlink nicht verfügbar', 'error');
            if (await copyText(d.text)) showToast(`Nachricht mit Code ${d.code} kopiert – im Portal-Chat einfügen`, 'success', 5000);
            else window.prompt('Nachricht kopieren:', d.text);
        } catch (e) { showToast('Gastlink nicht verfügbar', 'error'); }
    }

    async function refreshSiteBadge() {
        try {
            const d = await apiJson('/api/site/requests');
            const badge = $('#website-badge');
            if (!badge || !d.success) return;
            badge.textContent = d.pending;
            badge.hidden = !d.pending;
            siteRequests = d.requests;
        } catch (e) { /* badge stays */ }
    }
    setInterval(() => { if (!document.hidden && appWrapper.classList.contains('authenticated')) refreshSiteBadge(); }, 60000);

    function setSiteTab(tab) {
        siteTab = tab;
        $$('#website-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        $$('#view-website .site-pane').forEach(p => { p.style.display = p.dataset.pane === tab ? 'flex' : 'none'; });
        if (tab === 'meldescheine') loadMeldescheine();
    }
    $$('#website-tabs button').forEach(b => b.addEventListener('click', () => setSiteTab(b.dataset.tab)));

    async function loadWebsite() {
        setSiteTab(siteTab);
        loadSiteRequests();
        loadDoorCard();
        try {
            const d = await apiJson('/api/site/settings');
            if (!d.success) return;
            siteData = d.site;
            fillSiteForm(d);
        } catch (e) { showToast('Webseiten-Einstellungen konnten nicht geladen werden', 'error'); }
    }

    const SITE_FIELDS = {
        title: '#site-title', tagline: '#site-tagline', description: '#site-description', features: '#site-features',
        location: '#site-location', house_rules: '#site-house-rules', arrival_info: '#site-arrival-info',
        imprint: '#site-imprint', privacy: '#site-privacy', public_url: '#site-public-url',
        max_guests: '#site-max-guests', min_nights: '#site-min-nights', lead_days: '#site-lead-days',
        checkin_time: '#site-checkin', checkout_time: '#site-checkout', pin_days: '#site-pin-days', payment_info: '#site-payment-info',
        testimonials: '#site-testimonials', bedrooms: '#site-bedrooms', size_sqm: '#site-size',
        wifi_name: '#site-wifi-name', wifi_password: '#site-wifi-password', parking: '#site-parking', guide: '#site-guide',
        guest_invoice: '#site-guest-invoice', meldeschein: '#site-meldeschein'
    };
    const SITE_CHECKS = { enabled: '#site-enabled', show_bank: '#site-show-bank', show_contact: '#site-show-contact' };

    function fillSiteForm(d) {
        const s = d.site;
        Object.entries(SITE_FIELDS).forEach(([k, sel]) => { const el = $(sel); if (el) el.value = s[k] == null ? '' : s[k]; });
        Object.entries(SITE_CHECKS).forEach(([k, sel]) => { const el = $(sel); if (el) el.checked = !!s[k]; });
        const base = s.public_url ? s.public_url.replace(/\/gast$/, '') : location.origin;
        $('#site-ical-url').value = base + d.icalPath;
        $('#site-link').href = s.public_url ? s.public_url + '/' : '/gast/';
        $('#site-smtp-hint').textContent = d.smtpReady
            ? 'E-Mails an Gäste (Eingangsbestätigung, Zusage, Absage) werden über dein SMTP-Konto verschickt.'
            : 'Hinweis: Ohne E-Mail-Einstellungen (SMTP) bekommen Gäste keine E-Mails. Sie sehen den Stand dann nur auf der Webseite.';
        renderSitePhotos();
        fillSiteExtras(s);
    }

    function renderSitePhotos() {
        const photos = (siteData && siteData.photos) || [];
        $('#site-photos').innerHTML = photos.length ? photos.map((f, i) => `
            <div class="site-photo${i === 0 ? ' cover' : ''}" data-file="${escapeHtml(f)}">
                <img src="/api/site/photo/${encodeURIComponent(f)}" alt="">
                <div class="site-photo-actions">
                    ${i > 0 ? '<button type="button" class="btn-mini" data-ph="up" title="Nach vorne">◀</button>' : '<span></span>'}
                    <button type="button" class="btn-mini" data-ph="del" title="Löschen">✕</button>
                </div>
            </div>`).join('') : '<div class="text-muted" style="font-size:.85rem">Noch keine Bilder.</div>';
    }

    $('#site-photos').addEventListener('click', async e => {
        const btn = e.target.closest('[data-ph]');
        if (!btn) return;
        const file = btn.closest('.site-photo').dataset.file;
        let d;
        if (btn.dataset.ph === 'del') {
            if (!confirm('Bild löschen?')) return;
            d = await apiJson(`/api/site/photos/${encodeURIComponent(file)}`, { method: 'DELETE' });
        } else {
            const order = siteData.photos.slice();
            const i = order.indexOf(file);
            [order[i - 1], order[i]] = [order[i], order[i - 1]];
            d = await apiJson('/api/site/photos/order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photos: order }) });
        }
        if (d && d.success) { siteData.photos = d.photos; renderSitePhotos(); }
        else showToast('Aktion fehlgeschlagen', 'error');
    });

    $('#site-photo-input').addEventListener('change', async e => {
        for (const file of Array.from(e.target.files || [])) {
            const fd = new FormData();
            fd.append('photo', file);
            try {
                const d = await apiJson('/api/site/photos', { method: 'POST', body: fd });
                if (d.success) { siteData.photos = d.photos; renderSitePhotos(); }
                else showToast(d.error || 'Upload fehlgeschlagen', 'error');
            } catch (x) { showToast('Upload fehlgeschlagen', 'error'); }
        }
        e.target.value = '';
    });

    // Floor plan, reviews, location and excursion tips
    function renderFloorplan() {
        const f = siteData && siteData.floorplan;
        $('#site-floorplan').innerHTML = f
            ? `<div class="site-photo plan"><img src="/api/site/photo/${encodeURIComponent(f)}" alt="Grundriss"></div>`
            : '<div class="text-muted" style="font-size:.85rem">Noch kein Grundriss.</div>';
        $('#site-floorplan-del').hidden = !f;
    }

    $('#site-floorplan-input').addEventListener('change', async e => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        const fd = new FormData();
        fd.append('photo', file);
        try {
            const d = await apiJson('/api/site/floorplan', { method: 'POST', body: fd });
            if (d.success) { siteData.floorplan = d.floorplan; renderFloorplan(); }
            else showToast(d.error || 'Upload fehlgeschlagen', 'error');
        } catch (x) { showToast('Upload fehlgeschlagen', 'error'); }
    });

    $('#site-floorplan-del').addEventListener('click', async () => {
        if (!confirm('Grundriss entfernen?')) return;
        const d = await apiJson('/api/site/floorplan', { method: 'DELETE' });
        if (d && d.success) { siteData.floorplan = ''; renderFloorplan(); }
        else showToast('Aktion fehlgeschlagen', 'error');
    });

    const REVIEW_PLATFORMS = { booking: 'Booking.com', airbnb: 'Airbnb', google: 'Google', direct: 'Direkt' };
    const decDE = n => (n ? String(n).replace('.', ',') : '');

    function reviewRow(r = {}) {
        const opt = (val, label, cur) => `<option value="${val}"${String(cur) === String(val) ? ' selected' : ''}>${label}</option>`;
        const starOpts = ['', 5, 4.5, 4, 3.5, 3, 2, 1].map(v => opt(v, v ? `${decDE(v)} ★` : 'keine', r.rating || '')).join('');
        return `<div class="list-item" data-kind="review">
            <div><label>Name</label><input type="text" data-f="name" maxlength="80" value="${escapeHtml(r.name || '')}" placeholder="z. B. Familie M."></div>
            <div><label>Plattform</label><select data-f="platform">${Object.entries(REVIEW_PLATFORMS).map(([k, v]) => opt(k, v, r.platform || 'booking')).join('')}</select></div>
            <div><label>Sterne</label><select data-f="rating">${starOpts}</select></div>
            <div><label>Monat</label><input type="month" data-f="date" value="${escapeHtml(r.date || '')}"></div>
            <div class="li-wide"><label>Text</label><textarea data-f="text" rows="3" maxlength="1500">${escapeHtml(r.text || '')}</textarea></div>
            <div class="li-actions"><button type="button" class="btn-mini" data-li="up" title="Nach oben">▲</button><button type="button" class="btn-mini" data-li="del">Entfernen</button></div>
        </div>`;
    }

    function tipRow(t = {}) {
        return `<div class="list-item" data-kind="tip">
            <div style="grid-column:span 2"><label>Name</label><input type="text" data-f="name" maxlength="100" value="${escapeHtml(t.name || '')}" placeholder="z. B. Burg Altena"></div>
            <div><label>Entfernung</label><input type="text" data-f="distance" maxlength="40" value="${escapeHtml(t.distance || '')}" placeholder="z. B. 15 Min. mit dem Auto"></div>
            <div><label>Link <small>(optional)</small></label><input type="url" data-f="url" maxlength="500" value="${escapeHtml(t.url || '')}" placeholder="https://…"></div>
            <div class="li-wide"><label>Beschreibung</label><textarea data-f="text" rows="2" maxlength="800">${escapeHtml(t.text || '')}</textarea></div>
            <div class="li-actions"><button type="button" class="btn-mini" data-li="up" title="Nach oben">▲</button><button type="button" class="btn-mini" data-li="del">Entfernen</button></div>
        </div>`;
    }

    function fillSiteExtras(s) {
        renderFloorplan();
        $$('#view-website .rating-row').forEach(row => {
            const r = (s.ratings || {})[row.dataset.platform] || {};
            row.querySelector('[data-r="score"]').value = decDE(r.score);
            row.querySelector('[data-r="count"]').value = r.count || '';
            row.querySelector('[data-r="url"]').value = r.url || '';
        });
        $('#site-reviews').innerHTML = (s.reviews || []).map(reviewRow).join('');
        $('#site-tips').innerHTML = (s.tips || []).map(tipRow).join('');
        $('#site-address').value = s.address || '';
        $('#site-show-map').checked = s.show_map !== false;
        $('#site-directions').value = s.directions || '';
    }

    function collectSiteExtras() {
        const ratings = {};
        $$('#view-website .rating-row').forEach(row => {
            ratings[row.dataset.platform] = {
                score: row.querySelector('[data-r="score"]').value,
                count: row.querySelector('[data-r="count"]').value,
                url: row.querySelector('[data-r="url"]').value
            };
        });
        const rows = sel => Array.from($$(`${sel} .list-item`)).map(item => {
            const o = {};
            item.querySelectorAll('[data-f]').forEach(el => { o[el.dataset.f] = el.value; });
            return o;
        });
        return {
            ratings, reviews: rows('#site-reviews'), tips: rows('#site-tips'),
            address: $('#site-address').value, show_map: $('#site-show-map').checked, directions: $('#site-directions').value
        };
    }

    $('#site-review-add').addEventListener('click', () => {
        $('#site-reviews').insertAdjacentHTML('beforeend', reviewRow());
        $('#site-reviews').lastElementChild.querySelector('textarea').focus();
    });
    $('#site-tip-add').addEventListener('click', () => {
        $('#site-tips').insertAdjacentHTML('beforeend', tipRow());
        $('#site-tips').lastElementChild.querySelector('input').focus();
    });
    ['#site-reviews', '#site-tips'].forEach(sel => $(sel).addEventListener('click', e => {
        const btn = e.target.closest('[data-li]');
        if (!btn) return;
        const item = btn.closest('.list-item');
        if (btn.dataset.li === 'del') item.remove();
        else if (item.previousElementSibling) item.parentNode.insertBefore(item, item.previousElementSibling);
    }));

    $$('#view-website .site-save').forEach(btn => btn.addEventListener('click', async () => {
        const site = {};
        Object.entries(SITE_FIELDS).forEach(([k, sel]) => { site[k] = $(sel).value; });
        Object.entries(SITE_CHECKS).forEach(([k, sel]) => { site[k] = $(sel).checked; });
        Object.assign(site, collectSiteExtras());
        try {
            const d = await apiJson('/api/site/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site }) });
            if (d.success) { siteData = d.site; showToast('Webseite gespeichert', 'success'); loadWebsite(); }
            else showToast(d.error || 'Speichern fehlgeschlagen', 'error');
        } catch (e) { showToast('Speichern fehlgeschlagen', 'error'); }
    }));

    // Emergency door opening (QR code at the door)
    const DOOR_RESULTS = { opened: 'geöffnet', denied: 'abgelehnt', error: 'Fehler' };
    const DOOR_REASONS = { early: 'zu früh', late: 'Aufenthalt vorbei', limit: 'Limit erreicht', disabled: 'ausgeschaltet', key: 'falscher QR-Code', login: 'nicht angemeldet' };
    async function loadDoorCard() {
        try {
            const d = await apiJson('/api/notfall/settings');
            if (!d.success) return;
            $('#door-enabled').checked = d.enabled;
            $('#door-hint').textContent = d.hasPublicUrl
                ? 'Nach „Neuen QR-Code erzeugen“ funktioniert der alte Aushang nicht mehr. Dann bitte neu drucken.'
                : 'Hinweis: Bitte zuerst oben die öffentliche Adresse der Webseite eintragen, sonst zeigt der QR-Code auf die interne Adresse.';
            $('#door-log').innerHTML = d.log.length
                ? '<div class="today-title" style="margin-top:.5rem">Protokoll</div>' + d.log.map(l => {
                    const t = new Date(l.created_at.replace(' ', 'T') + 'Z').toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
                    const why = l.result === 'denied' ? ` (${DOOR_REASONS[l.detail] || l.detail})` : l.result === 'error' ? ` (${l.detail || ''})` : '';
                    return `<div>${escapeHtml(t)} · ${escapeHtml(l.guest_code || '–')} · <b>${escapeHtml(DOOR_RESULTS[l.result] || l.result)}</b>${escapeHtml(why)}</div>`;
                }).join('')
                : '';
        } catch (e) { /* card stays */ }
    }
    $('#door-enabled').addEventListener('change', async e => {
        try {
            const d = await apiJson('/api/notfall/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: e.target.checked }) });
            if (d.success) showToast(d.enabled ? 'Notfall-Öffnen eingeschaltet' : 'Notfall-Öffnen ausgeschaltet', 'success');
        } catch (err) { showToast('Speichern fehlgeschlagen', 'error'); }
    });
    $('#door-new-key').addEventListener('click', async () => {
        if (!confirm('Neuen QR-Code erzeugen? Der aufgehängte Aushang funktioniert danach nicht mehr und muss neu gedruckt werden.')) return;
        try {
            const d = await apiJson('/api/notfall/new-key', { method: 'POST' });
            if (d.success) showToast('Neuer QR-Code erzeugt. Bitte Aushang neu drucken.', 'success');
        } catch (e) { showToast('Fehlgeschlagen', 'error'); }
    });

    $('#site-ical-copy').addEventListener('click', async () => {
        if (await copyText($('#site-ical-url').value)) showToast('Kalender-Link kopiert', 'success');
    });

    async function loadSiteRequests() {
        const list = $('#site-requests');
        try {
            const d = await apiJson('/api/site/requests');
            if (!d.success) { list.innerHTML = '<div class="bookings-empty">Anfragen konnten nicht geladen werden.</div>'; return; }
            siteRequests = d.requests;
            const badge = $('#website-badge');
            if (badge) { badge.textContent = d.pending; badge.hidden = !d.pending; }
            renderSiteRequests();
        } catch (e) { list.innerHTML = '<div class="bookings-empty">Keine Verbindung zum Server.</div>'; }
    }

    const REQ_STATUS = { pending: 'Offen', confirmed: 'Bestätigt', declined: 'Abgelehnt', cancelled: 'Storniert' };

    function renderSiteRequests() {
        const list = $('#site-requests');
        if (!siteRequests.length) {
            list.innerHTML = '<div class="bookings-empty">Noch keine Anfragen über die Webseite.</div>';
            return;
        }
        list.innerHTML = siteRequests.map(r => {
            const guests = `${r.adults} Erw.${r.children ? ` + ${r.children} Kind${r.children === 1 ? '' : 'er'}` : ''}`;
            const actions = r.status === 'pending'
                ? `<button class="btn-mini" data-req="confirm">Bestätigen</button><button class="btn-mini" data-req="decline">Ablehnen</button>`
                : r.status === 'confirmed' ? `<button class="btn-mini" data-req="cancel">Stornieren</button>` : '';
            return `<div class="card req-card" data-id="${r.id}">
                <div>
                    <div class="booking-name">${escapeHtml(r.name)}<span class="req-status ${r.status}">${REQ_STATUS[r.status] || r.status}</span></div>
                    <div class="booking-sub">${escapeHtml(r.email)}${r.phone ? ' · ' + escapeHtml(r.phone) : ''}</div>
                    <div class="booking-sub">Code ${escapeHtml(r.code)} · angefragt ${new Date(r.created_at.replace(' ', 'T') + 'Z').toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</div>
                </div>
                <div>
                    <div>${fmtDEfull(r.checkin)} – ${fmtDEfull(r.checkout)}</div>
                    <div class="booking-sub">${nightsTxt(r.nights)} · ${guests}${r.price_total ? ' · ' + formatCurrency(r.price_total) : ''}</div>
                    ${r.conflict ? `<div class="req-conflict">⚠️ Belegt durch ${escapeHtml(r.conflict.source)} (${fmtDEfull(r.conflict.checkin)} – ${fmtDEfull(r.conflict.checkout)})</div>` : ''}
                </div>
                <div class="booking-actions">${actions}</div>
                ${r.message ? `<div class="req-msg">💬 ${escapeHtml(r.message)}</div>` : ''}
                ${r.host_note ? `<div class="req-msg">↪ ${escapeHtml(r.host_note)}</div>` : ''}
            </div>`;
        }).join('');
    }

    $('#site-requests').addEventListener('click', async e => {
        const btn = e.target.closest('[data-req]');
        if (!btn) return;
        const r = siteRequests.find(x => String(x.id) === btn.closest('.req-card').dataset.id);
        if (!r) return;
        const act = btn.dataset.req;
        const body = {};
        if (act === 'confirm') {
            const price = prompt(`Buchung von ${r.name} bestätigen.\n\nGesamtpreis in € (leer lassen = ${r.price_total ? formatCurrency(r.price_total) : 'kein Preis'}):`, '');
            if (price === null) return;
            if (price.trim()) body.price = parseFloat(price.replace(',', '.'));
            const note = prompt('Optionale Nachricht an den Gast (erscheint in der E-Mail und auf der Webseite):', '');
            if (note === null) return;
            body.note = note;
        } else if (act === 'decline') {
            const note = prompt(`Anfrage von ${r.name} ablehnen.\n\nOptionale Nachricht an den Gast:`, '');
            if (note === null) return;
            body.note = note;
        } else if (act === 'cancel') {
            if (!confirm(`Direktbuchung von ${r.name} (${fmtDEfull(r.checkin)} – ${fmtDEfull(r.checkout)}) stornieren?\nDer Zeitraum wird wieder frei und der Türcode gelöscht. Der Gast bekommt keine automatische E-Mail.`)) return;
        }
        btn.disabled = true;
        try {
            const d = await apiJson(`/api/site/requests/${r.id}/${act}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (d.success) {
                const msg = act === 'confirm' ? `Buchung bestätigt${d.pin ? ` – Türcode ${d.pin}` : ''}${d.mailed ? ' – E-Mail an Gast gesendet' : ''}`
                    : act === 'decline' ? `Anfrage abgelehnt${d.mailed ? ' – E-Mail an Gast gesendet' : ''}` : 'Buchung storniert';
                showToast(msg, 'success', 5000);
            } else showToast(d.error || 'Aktion fehlgeschlagen', 'error', 6000);
        } catch (x) { showToast('Aktion fehlgeschlagen', 'error'); }
        loadSiteRequests();
    });

    // ---- Meldescheine (online ausgefüllt auf „Meine Buchung“)
    let msLoaded = false;
    function msQuery() {
        const y = $('#ms-year').value, m = $('#ms-month').value;
        return new URLSearchParams({ ...(y ? { year: y } : {}), ...(y && m ? { month: m } : {}) }).toString();
    }
    async function loadMeldescheine() {
        const list = $('#ms-list');
        if (!msLoaded) {
            const now = new Date().getFullYear();
            $('#ms-year').innerHTML = `<option value="">Alle Jahre</option>` + [now + 1, now, now - 1].map(y => `<option value="${y}"${y === now ? ' selected' : ''}>${y}</option>`).join('');
            msLoaded = true;
        }
        try {
            const d = await apiJson(`/api/meldescheine?${msQuery()}`);
            if (!d.success) throw new Error();
            const miss = $('#ms-missing');
            miss.innerHTML = !d.enabled ? '<div class="card ms-note">Der Online-Meldeschein ist ausgeschaltet (Einrichtung → Online-Meldeschein).</div>'
                : d.missing.length ? `<div class="card ms-note"><strong>Noch offen (nächste 30 Tage):</strong> ${d.missing.map(b =>
                    `<span class="ms-chip">${escapeHtml(b.name || srcLabel(b.source) || 'Gast')} · ${fmtDEfull(b.checkin)}</span>`).join('')}</div>` : '';
            list.innerHTML = d.forms.length ? d.forms.map(f => `<div class="card req-card ms-card" data-id="${f.id}">
                <div>
                    <div class="booking-name">${escapeHtml(f.name)}</div>
                    <div class="booking-sub">${escapeHtml(f.nationality)} · geb. ${fmtDEfull(f.birthDate)} · ${escapeHtml(f.city)}${f.country && !/^deutschland$/i.test(f.country) ? ', ' + escapeHtml(f.country) : ''}</div>
                    <div class="booking-sub">Code ${escapeHtml(f.code || '–')} · erfasst ${new Date(f.submittedAt.replace(' ', 'T') + 'Z').toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</div>
                </div>
                <div>
                    <div>${fmtDEfull(f.checkin)} – ${fmtDEfull(f.checkout)}</div>
                    <div class="booking-sub">${f.companions + 1} ${f.companions ? 'Personen, alle erfasst' : 'Person'}</div>
                </div>
                <div class="booking-actions"><button class="btn-mini" data-ms="print">Drucken</button><button class="btn-mini" data-ms="delete">Löschen</button></div>
            </div>`).join('') : '<div class="bookings-empty">Für diesen Zeitraum gibt es noch keine Meldescheine.</div>';
        } catch (e) { list.innerHTML = '<div class="bookings-empty">Meldescheine konnten nicht geladen werden.</div>'; }
    }
    ['#ms-year', '#ms-month'].forEach(sel => $(sel).addEventListener('change', loadMeldescheine));
    $('#ms-print-all').addEventListener('click', () => window.open(`/api/meldescheine/druck?${msQuery()}`, '_blank', 'noopener'));
    $('#ms-csv').addEventListener('click', () => { location.href = `/api/meldescheine/export.csv?${msQuery()}`; });
    $('#ms-list').addEventListener('click', async e => {
        const btn = e.target.closest('[data-ms]');
        if (!btn) return;
        const id = btn.closest('.ms-card').dataset.id;
        if (btn.dataset.ms === 'print') return window.open(`/api/meldescheine/${id}/druck`, '_blank', 'noopener');
        if (!confirm('Diesen Meldeschein endgültig löschen?')) return;
        const d = await apiJson(`/api/meldescheine/${id}`, { method: 'DELETE' }).catch(() => null);
        showToast(d && d.success ? 'Meldeschein gelöscht' : 'Löschen fehlgeschlagen', d && d.success ? 'success' : 'error');
        loadMeldescheine();
    });

    // ---- Verbindungsstatus (Punkte in den Einstellungen)
    async function loadStatusDots(refresh) {
        try {
            const d = await apiJson('/api/status' + (refresh ? '?refresh=1' : ''));
            if (!d.success) return;
            const set = (key, cls, title) => {
                $$(`.status-dot[data-status="${key}"]`).forEach(el => { el.className = 'status-dot ' + cls; el.title = title; });
            };
            set('telegram', !d.telegram.configured ? '' : d.telegram.running ? 'ok' : 'bad', !d.telegram.configured ? 'Nicht eingerichtet' : d.telegram.running ? 'Bot läuft' : 'Bot gestoppt');
            set('nuki', !d.nuki.configured ? '' : d.nuki.ok ? 'ok' : 'bad', !d.nuki.configured ? 'Nicht eingerichtet' : d.nuki.ok ? `Verbunden (${d.nuki.codes} Codes)` : 'Fehler: ' + (d.nuki.error || ''));
            const feeds = d.calendars.feeds || [];
            const calCls = !d.calendars.configured.length ? '' : (!feeds.length ? 'warn' : feeds.every(f => f.ok) ? 'ok' : 'bad');
            set('calendars', calCls, !d.calendars.configured.length ? 'Kein Kalender eingerichtet' : calCls === 'ok' ? 'Letzte Abfrage erfolgreich' : calCls === 'bad' ? 'Letzte Abfrage mit Fehler' : 'Noch nicht abgefragt');
        } catch (e) { /* dots stay neutral */ }
    }
    const settingsBtn = $('#btn-settings');
    if (settingsBtn) settingsBtn.addEventListener('click', () => loadStatusDots(false));

    // =======================
    // Dashboard Module
    // =======================
    let revenueChart = null;

    async function loadDashboard() {
        loadOverview();
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

        // Chart.js refuses to draw on a canvas that is still in use, so the old chart has to go first
        if (window.myRevenueChart) window.myRevenueChart.destroy();
        // Schrift und Linien wie im restlichen Design
        Chart.defaults.font.family = "'Hanken Grotesk', 'Helvetica Neue', Arial, sans-serif";
        Chart.defaults.color = '#675e52';
        Chart.defaults.borderColor = '#e4dccf';
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
                        backgroundColor: '#2b62e3',
                        borderRadius: 1
                    },
                    {
                        label: 'Ausgaben',
                        data: expValues,
                        backgroundColor: '#c4b8a5',
                        borderRadius: 1
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
    // Jahresrückblick
    // =======================
    const MONTHS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
    const MONTHS_LONG = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    let reviewYear = null;
    let reviewMap = null;
    let reviewMarkers = null;
    let reviewGeoRun = 0;
    const numDE = (n, d = 0) => Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

    async function loadReview(year) {
        const sec = $('#review-section');
        if (!sec) return;
        try {
            const d = await apiJson('/api/review' + (year ? `?year=${year}` : ''));
            if (!d.success) { $('#review-note').textContent = d.error || 'Rückblick konnte nicht geladen werden'; return; }
            renderReview(d.review);
        } catch (e) {
            $('#review-note').textContent = 'Keine Verbindung zum Server.';
        }
    }

    function renderReview(r) {
        reviewYear = r.year;
        const sel = $('#review-year');
        sel.innerHTML = r.years.map(y => `<option value="${y}"${y === r.year ? ' selected' : ''}>${y}</option>`).join('');
        const running = r.today.slice(0, 4) === String(r.year);
        $('#review-note').textContent = running ? `Stand heute – bereits gebuchte Nächte bis Jahresende zählen mit.` : '';
        const exp = $('#review-export');
        if (exp) exp.href = `/api/review/export.xlsx?year=${r.year}`;

        const p = r.previous;
        const delta = (cur, prev, pts) => {
            if (!p || prev == null || (!pts && !prev)) return '';
            const v = pts ? Math.round((cur - prev) * 10) / 10 : Math.round((cur - prev) / prev * 100);
            if (!v) return `<span class="review-delta">wie ${r.year - 1}</span>`;
            return `<span class="review-delta ${v > 0 ? 'up' : 'down'}">${v > 0 ? '▲ +' : '▼ '}${numDE(v, pts ? 1 : 0)}${pts ? ' Pkt.' : ' %'} ggü. ${r.year - 1}</span>`;
        };
        const tile = (label, value, sub, d) => `
            <div class="card stat-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>
            ${sub ? `<div class="review-sub">${sub}</div>` : ''}${d || ''}</div>`;
        $('#review-kpis').innerHTML = [
            tile('Auslastung', `${numDE(r.occupancy, 1)} %`, `${r.nights} von ${r.days} Nächten`, delta(r.occupancy, p && p.occupancy, true)),
            tile('Aufenthalte', r.stays, `Ø ${numDE(r.avgStay, 1)} Nächte · längster ${r.longestStay}`, delta(r.stays, p && p.stays)),
            tile('Umsatz', formatCurrency(r.revenue), r.openRevenue ? `davon offen ${formatCurrency(r.openRevenue)}` : `${r.invoices} Rechnung${r.invoices === 1 ? '' : 'en'}`, delta(r.revenue, p && p.revenue)),
            tile('Pro belegter Nacht', r.perNight ? formatCurrency(r.perNight) : '–', 'Umsatz ÷ Nächte', delta(r.perNight, p && p.perNight)),
            tile('Ergebnis', formatCurrency(r.result), `Ausgaben ${formatCurrency(r.expenses)}`, delta(r.result, p && p.result)),
            tile('Gäste', r.guests, r.guests ? `davon ${r.returning} ${r.returning === 1 ? 'Stammgast' : 'Stammgäste'}` : 'mit Namen erfasst', '')
        ].join('');

        renderReviewMonths(r);

        const maxN = Math.max(1, ...r.channels.map(c => c.nights));
        $('#review-channels').innerHTML = r.channels.length ? r.channels.map(c => `
            <div class="review-bar">
                <div class="review-bar-head"><span>${escapeHtml(c.label)}</span><small>${c.stays}× · ${c.nights} Nächte${c.revenue ? ' · ' + formatCurrency(c.revenue) : ''}</small></div>
                <div class="review-bar-track"><div class="review-bar-fill" style="width:${Math.round(c.nights / maxN * 100)}%"></div></div>
            </div>`).join('') + (r.busiestMonth ? `<p class="review-hint">Stärkster Monat: ${MONTHS_LONG[r.busiestMonth - 1]} (${r.months[r.busiestMonth - 1]} Nächte)</p>` : '')
            : '<div class="today-empty">Keine Aufenthalte in diesem Jahr.</div>';

        renderReviewRevenue(r);
        renderReviewDayMap(r);
        renderReviewTables(r);
        renderReviewOrigins(r.origins);
        if (r.origins.pending) geocodeReview(r.year);
    }

    function renderReviewRevenue(r) {
        const canvas = $('#reviewRevenueChart');
        if (!canvas || typeof Chart === 'undefined') return;
        if (window.myReviewRevenueChart) window.myReviewRevenueChart.destroy();
        const datasets = [{ label: String(r.year), data: r.revenueByMonth, backgroundColor: '#2b62e3', borderRadius: 1 }];
        if (r.previous && r.previous.revenueByMonth) datasets.push({ label: String(r.year - 1), data: r.previous.revenueByMonth, backgroundColor: '#c4b8a5', borderRadius: 1 });
        window.myReviewRevenueChart = new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: { labels: MONTHS_SHORT, datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { y: { beginAtZero: true, ticks: { callback: v => numDE(v) + ' €' } } },
                plugins: {
                    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 6 } },
                    tooltip: { callbacks: { label: c => `${c.dataset.label}: ${formatCurrency(c.parsed.y || 0)}` } }
                }
            }
        });
    }

    // 12 rows (months) x up to 31 days, filled = booked night
    function renderReviewDayMap(r) {
        const el = $('#review-daymap');
        if (!el) return;
        const today = r.today;
        const head = '<div class="daymap-row daymap-head"><span></span>' + Array.from({ length: 31 }, (_, i) => `<i>${(i + 1) % 5 === 0 || i === 0 ? i + 1 : ''}</i>`).join('') + '</div>';
        el.innerHTML = '<div class="daymap">' + head + (r.dayMap || []).map((str, m) => {
            const cells = [...str].map((c, d) => {
                const ymd = `${r.year}-${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`;
                const cls = c === '1' ? 'on' : (ymd > today ? 'future' : '');
                return `<b class="${cls}" title="${fmtDEfull(ymd)}${c === '1' ? ' · belegt' : ' · frei'}"></b>`;
            }).join('');
            const n = (str.match(/1/g) || []).length;
            return `<div class="daymap-row"><span>${MONTHS_SHORT[m]}</span>${cells}<em>${Math.round(n / str.length * 100)} %</em></div>`;
        }).join('') + '</div><p class="review-hint">Blau = belegte Nacht. Hell = noch frei, gestrichelt = Zukunft.</p>';
    }

    function renderReviewTables(r) {
        const t = $('#review-months-table');
        if (t) {
            const prev = r.previous;
            const rows = r.months.map((n, i) => {
                const days = new Date(r.year, i + 1, 0).getDate();
                const occ = n / days * 100;
                const rev = r.revenueByMonth[i] || 0;
                return `<tr><td>${MONTHS_LONG[i]}</td><td class="num">${n}</td>
                    <td class="num"><span class="occ-cell"><span class="occ-mini"><span style="width:${Math.min(100, occ).toFixed(0)}%"></span></span>${numDE(occ, 0)} %</span></td>
                    <td class="num">${r.arrivals ? r.arrivals[i] : ''}</td><td class="num">${rev ? formatCurrency(rev) : '–'}</td>
                    <td class="num">${n && rev ? formatCurrency(rev / n) : '–'}</td>
                    ${prev ? `<td class="num muted">${prev.months[i]}</td><td class="num muted">${prev.revenueByMonth && prev.revenueByMonth[i] ? formatCurrency(prev.revenueByMonth[i]) : '–'}</td>` : ''}</tr>`;
            }).join('');
            const arr = (r.arrivals || []).reduce((a, b) => a + b, 0);
            t.innerHTML = `<thead><tr><th>Monat</th><th class="num">Nächte</th><th class="num">Auslastung</th><th class="num">Anreisen</th><th class="num">Umsatz</th><th class="num">pro Nacht</th>
                ${prev ? `<th class="num">Nächte ${r.year - 1}</th><th class="num">Umsatz ${r.year - 1}</th>` : ''}</tr></thead><tbody>${rows}</tbody>
                <tfoot><tr><td>Jahr</td><td class="num">${r.nights}</td><td class="num">${numDE(r.occupancy, 1)} %</td><td class="num">${arr}</td><td class="num">${formatCurrency(r.revenue)}</td>
                <td class="num">${r.perNight ? formatCurrency(r.perNight) : '–'}</td>${prev ? `<td class="num">${prev.nights}</td><td class="num">${formatCurrency(prev.revenue)}</td>` : ''}</tr></tfoot>`;
        }
        const h = $('#review-history-table');
        if (h) {
            const hist = (r.history || []).slice().reverse();
            const maxRev = Math.max(1, ...hist.map(x => x.revenue));
            h.innerHTML = hist.length ? `<thead><tr><th>Jahr</th><th class="num">Aufenthalte</th><th class="num">Nächte</th><th class="num">Auslastung</th><th class="num">Ø Nächte</th>
                <th>Umsatz</th><th class="num">pro Nacht</th><th class="num">Ausgaben</th><th class="num">Ergebnis</th><th class="num">Gäste</th></tr></thead><tbody>` +
                hist.map(x => `<tr class="${x.year === r.year ? 'is-current' : ''}" data-year="${x.year}"><td><button type="button" class="link-btn" data-year="${x.year}">${x.year}</button></td>
                    <td class="num">${x.stays}</td><td class="num">${x.nights}</td><td class="num">${numDE(x.occupancy, 1)} %</td><td class="num">${numDE(x.avgStay, 1)}</td>
                    <td><span class="occ-cell"><span class="occ-mini wide"><span style="width:${(x.revenue / maxRev * 100).toFixed(0)}%"></span></span>${formatCurrency(x.revenue)}</span></td>
                    <td class="num">${x.perNight ? formatCurrency(x.perNight) : '–'}</td><td class="num">${formatCurrency(x.expenses)}</td>
                    <td class="num ${x.result < 0 ? 'neg' : ''}">${formatCurrency(x.result)}</td><td class="num">${x.guests}${x.returning ? ` <small class="muted">(${x.returning} Stamm)</small>` : ''}</td></tr>`).join('') + '</tbody>'
                : '<tbody><tr><td class="muted">Noch keine Daten.</td></tr></tbody>';
        }
    }
    const histTable = $('#review-history-table');
    if (histTable) histTable.addEventListener('click', e => {
        const b = e.target.closest('[data-year]');
        if (b && b.tagName === 'BUTTON') loadReview(parseInt(b.dataset.year, 10));
    });

    function renderReviewMonths(r) {
        const canvas = $('#reviewMonthsChart');
        if (!canvas || typeof Chart === 'undefined') return;
        if (window.myReviewChart) window.myReviewChart.destroy();
        const datasets = [{ label: String(r.year), data: r.months, backgroundColor: '#2b62e3', borderRadius: 1 }];
        if (r.previous) datasets.push({ label: String(r.year - 1), data: r.previous.months, backgroundColor: '#c4b8a5', borderRadius: 1 });
        window.myReviewChart = new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: { labels: MONTHS_SHORT, datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: { y: { beginAtZero: true, suggestedMax: 31, ticks: { precision: 0 } } },
                plugins: {
                    legend: { position: 'top', labels: { usePointStyle: true, boxWidth: 6 } },
                    tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y} Nächte` } }
                }
            }
        });
    }

    function renderReviewOrigins(o) {
        const list = (title, rows) => rows.length ? `<h4>${title}</h4><ul>${rows.join('')}</ul>` : '';
        $('#review-countries').innerHTML = list('Länder', o.countries.map(c =>
            `<li><span>${c.flag ? c.flag + ' ' : ''}${escapeHtml(c.name)}</span><span>${c.stays}</span></li>`));
        $('#review-places').innerHTML = list('Orte', o.places.filter(p => p.city).slice(0, 8).map(p =>
            `<li><span>${escapeHtml(p.city)}${p.cc && p.cc !== 'DE' ? ` <small>(${escapeHtml(p.country)})</small>` : ''}</span><span>${p.stays}</span></li>`));
        const notes = [];
        if (o.known) notes.push(`${o.known} Aufenthalt${o.known === 1 ? '' : 'e'} mit Adresse`);
        if (o.unknown) notes.push(`${o.unknown} ohne Adresse (z. B. Booking.com/Airbnb ohne Rechnung)`);
        if (o.pending) notes.push(`${o.pending} Ort${o.pending === 1 ? ' wird' : 'e werden'} noch auf der Karte gesucht …`);
        $('#review-origin-note').textContent = notes.join(' · ');
        drawReviewMap(o.places.filter(p => p.lat != null && p.lon != null));
    }

    let leafletLoading = null;
    function loadLeaflet() {
        if (window.L) return Promise.resolve();
        if (leafletLoading) return leafletLoading;
        leafletLoading = new Promise((resolve, reject) => {
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
            document.head.appendChild(css);
            const js = document.createElement('script');
            js.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
            js.onload = resolve;
            js.onerror = () => { leafletLoading = null; reject(new Error('Karte konnte nicht geladen werden')); };
            document.head.appendChild(js);
        });
        return leafletLoading;
    }

    async function drawReviewMap(points) {
        const el = $('#review-map');
        if (!points.length) {
            if (reviewMap) { reviewMap.remove(); reviewMap = null; }
            el.innerHTML = '<div class="review-map-empty">Noch keine Herkunftsorte. Sie kommen aus den Adressen der Gäste und Rechnungen.</div>';
            return;
        }
        try { await loadLeaflet(); } catch (e) {
            el.innerHTML = `<div class="review-map-empty">${escapeHtml(e.message)}</div>`;
            return;
        }
        if (!reviewMap) {
            el.innerHTML = '';
            reviewMap = L.map(el, { scrollWheelZoom: false, worldCopyJump: true });
            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 12, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
            }).addTo(reviewMap);
            reviewMarkers = L.layerGroup().addTo(reviewMap);
        }
        reviewMarkers.clearLayers();
        const max = Math.max(...points.map(p => p.stays));
        points.forEach(p => {
            const label = p.city ? `${p.zip ? p.zip + ' ' : ''}${p.city}${p.country && p.cc !== 'DE' ? ', ' + p.country : ''}` : `${p.country} (Ort unbekannt)`;
            L.circleMarker([p.lat, p.lon], {
                radius: 6 + Math.round(10 * Math.sqrt(p.stays / max)),
                color: '#ffffff', weight: 2, fillColor: p.city ? '#2b62e3' : '#6b7385', fillOpacity: .85
            }).bindTooltip(`${escapeHtml(label)}: ${p.stays} Aufenthalt${p.stays === 1 ? '' : 'e'}`).addTo(reviewMarkers);
        });
        const bounds = L.latLngBounds(points.map(p => [p.lat, p.lon]));
        reviewMap.invalidateSize();
        reviewMap.fitBounds(bounds.pad(0.25), { maxZoom: 8 });
    }

    // Looks up the remaining places step by step (the server asks OpenStreetMap at most once per second)
    async function geocodeReview(year) {
        const run = ++reviewGeoRun;
        for (let i = 0; i < 15; i++) {
            let d;
            try {
                d = await apiJson('/api/review/geo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ year }) });
            } catch (e) { return; }
            if (run !== reviewGeoRun || reviewYear !== year || !d.success) return;
            if (d.busy) { await new Promise(r => setTimeout(r, 3000)); continue; }
            renderReviewOrigins(d.origins);
            if (!d.remaining || !d.looked) return;
        }
    }

    const reviewYearSel = $('#review-year');
    if (reviewYearSel) reviewYearSel.addEventListener('change', () => loadReview(parseInt(reviewYearSel.value, 10)));

    // =======================
    // Finanz-Auswertung
    // =======================
    const fin = { mode: 'year', year: new Date().getFullYear(), quarter: Math.floor(new Date().getMonth() / 3) + 1, month: new Date().getMonth() + 1, from: '', to: '', basis: 'invoice', orphans: true, loaded: false };
    const pad2 = n => String(n).padStart(2, '0');
    const lastDay = (y, m) => new Date(y, m, 0).getDate();

    function finPeriod() {
        const y = fin.year;
        if (fin.mode === 'quarter') { const m0 = (fin.quarter - 1) * 3 + 1; return { from: `${y}-${pad2(m0)}-01`, to: `${y}-${pad2(m0 + 2)}-${lastDay(y, m0 + 2)}` }; }
        if (fin.mode === 'month') return { from: `${y}-${pad2(fin.month)}-01`, to: `${y}-${pad2(fin.month)}-${lastDay(y, fin.month)}` };
        if (fin.mode === 'custom' && fin.from && fin.to) return { from: fin.from, to: fin.to };
        return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
    function finQuery() {
        const p = finPeriod();
        return new URLSearchParams({ from: p.from, to: p.to, basis: fin.basis, orphans: fin.orphans ? '1' : '0' }).toString();
    }

    function syncFinControls() {
        $$('#fin-mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === fin.mode));
        $('#fin-year').hidden = fin.mode === 'custom';
        $('#fin-quarter').hidden = fin.mode !== 'quarter';
        $('#fin-month').hidden = fin.mode !== 'month';
        $('#fin-custom').hidden = fin.mode !== 'custom';
        const q = finQuery();
        $$('#view-finance .fin-dl').forEach(a => {
            const base = a.dataset.href;
            a.href = base + (base.includes('?') ? '&' : '?') + q;
            a.setAttribute('download', '');
        });
    }

    async function loadFinance() {
        if (!viewFinance) return;
        if (!fin.loaded) {
            $('#fin-month').innerHTML = MONTHS_LONG.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
            fin.loaded = true;
        }
        $('#fin-quarter').value = fin.quarter;
        $('#fin-month').value = fin.month;
        if (fin.mode === 'custom' && !fin.from) { const p = { from: `${fin.year}-01-01`, to: `${fin.year}-12-31` }; fin.from = p.from; fin.to = p.to; }
        $('#fin-from').value = fin.from;
        $('#fin-to').value = fin.to;
        syncFinControls();
        try {
            const d = await apiJson('/api/finance?' + finQuery());
            if (!d.success) { showToast(d.error || 'Auswertung fehlgeschlagen', 'error'); return; }
            const ys = d.years.includes(fin.year) ? d.years : [...d.years, fin.year].sort((a, b) => b - a);
            $('#fin-year').innerHTML = ys.map(y => `<option value="${y}"${y === fin.year ? ' selected' : ''}>${y}</option>`).join('');
            renderFinance(d.report);
        } catch (e) {
            showToast('Keine Verbindung zum Server', 'error');
        }
    }

    function renderFinance(r) {
        const t = r.totals;
        const money = v => formatCurrency(v || 0);
        $('#fin-label').textContent = `${r.label} · ${r.basis === 'payment' ? 'bezahlte Rechnungen nach Zahlungsdatum' : 'Rechnungen nach Rechnungsdatum'}`;
        $('#fin-orphans-label').textContent = `Rechnungen gelöschter Gäste einbeziehen${r.orphanCount ? ` (${r.orphanCount})` : ''}`;
        const tile = (label, value, sub, cls = '') => `<div class="card stat-card ${cls}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${sub ? `<div class="review-sub">${sub}</div>` : ''}</div>`;
        $('#fin-kpis').innerHTML = [
            tile('Einnahmen brutto', money(t.brutto), `${t.invoices} Rechnung${t.invoices === 1 ? '' : 'en'}`, 'stat-card-total'),
            tile('Einnahmen netto', money(t.netto), `Umsatzsteuer ${money(t.ust)}`),
            tile('Kurtaxe', money(t.kurtaxe), 'aus den Rechnungspositionen'),
            tile('Ausgaben', money(t.expenses), `${t.expenseCount} Beleg${t.expenseCount === 1 ? '' : 'e'}`),
            tile('Ergebnis', money(t.result), `netto ${money(t.resultNet)}`),
            tile('Offen', money(t.open), t.open ? 'noch nicht bezahlt' : 'alles bezahlt')
        ].join('');

        const num = v => `<td class="num">${v}</td>`;
        $('#fin-months').innerHTML = `<thead><tr><th>Monat</th><th class="num">Rechn.</th><th class="num">Netto</th><th class="num">USt</th><th class="num">Brutto</th><th class="num">Kurtaxe</th><th class="num">Offen</th><th class="num">Ausgaben</th><th class="num">Ergebnis</th></tr></thead><tbody>` +
            r.months.map(m => `<tr class="${!m.count && !m.expenses ? 'muted' : ''}"><td>${m.label}</td>${num(m.count)}${num(money(m.netto))}${num(money(m.ust))}${num(money(m.brutto))}${num(m.kurtaxe ? money(m.kurtaxe) : '–')}${num(m.open ? money(m.open) : '–')}${num(money(m.expenses))}<td class="num ${m.result < 0 ? 'neg' : ''}">${money(m.result)}</td></tr>`).join('') +
            `</tbody><tfoot><tr><td>Summe</td>${num(t.invoices)}${num(money(t.netto))}${num(money(t.ust))}${num(money(t.brutto))}${num(money(t.kurtaxe))}${num(money(t.open))}${num(money(t.expenses))}<td class="num ${t.result < 0 ? 'neg' : ''}">${money(t.result)}</td></tr></tfoot>`;

        $('#fin-vat').innerHTML = r.vat.length ? `<thead><tr><th>Steuersatz</th><th class="num">Rechn.</th><th class="num">Netto</th><th class="num">USt</th><th class="num">Brutto</th></tr></thead><tbody>` +
            r.vat.map(v => `<tr><td>${escapeHtml(v.label)}</td>${num(v.count)}${num(money(v.netto))}${num(money(v.ust))}${num(money(v.brutto))}</tr>`).join('') +
            `</tbody><tfoot><tr><td>Summe</td>${num(t.invoices)}${num(money(t.netto))}${num(money(t.ust))}${num(money(t.brutto))}</tr></tfoot>`
            : '<tbody><tr><td class="muted">Keine Rechnungen im Zeitraum.</td></tr></tbody>';
        const kinds = [['Übernachtung', t.stay], ['Reinigung', t.cleaning], ['Kurtaxe', t.kurtaxe], ['Sonstiges', t.other]].filter(k => k[1]);
        $('#fin-kinds').innerHTML = kinds.length ? '<tbody>' + kinds.map(([k, v]) => `<tr><td>${k}</td>${num(money(v))}</tr>`).join('') + '</tbody>' : '<tbody><tr><td class="muted">–</td></tr></tbody>';

        $('#fin-categories').innerHTML = r.expenseCategories.length ? `<thead><tr><th>Kategorie</th><th class="num">Belege</th><th class="num">Betrag</th></tr></thead><tbody>` +
            r.expenseCategories.map(c => `<tr><td>${escapeHtml(c.category)}</td>${num(c.count)}${num(money(c.amount))}</tr>`).join('') +
            `</tbody><tfoot><tr><td>Summe</td>${num(t.expenseCount)}${num(money(t.expenses))}</tr></tfoot>`
            : '<tbody><tr><td class="muted">Keine Ausgaben im Zeitraum.</td></tr></tbody>';

        $('#fin-invoices').innerHTML = r.invoices.length ? `<thead><tr><th>Nr.</th><th>Datum</th><th>Gast</th><th>Aufenthalt</th><th>Kanal</th><th class="num">Netto</th><th class="num">USt</th><th class="num">Brutto</th><th>Bezahlt</th></tr></thead><tbody>` +
            r.invoices.map(i => `<tr><td>${escapeHtml(i.number)}</td><td>${fmtDEfull(i.date)}</td><td>${escapeHtml(i.guest)}${i.note ? `<br><small class="muted">${escapeHtml(i.note)}</small>` : ''}</td>
                <td>${i.arrival ? `${fmtDE(i.arrival)}–${fmtDEfull(i.departure)}` : '–'}${i.nights ? ` <small class="muted">(${i.nights} N.)</small>` : ''}</td><td>${escapeHtml(i.channel)}</td>
                ${num(money(i.netto))}${num(money(i.ust))}${num(money(i.brutto))}<td>${i.paid === 'ja' ? `<span class="fin-paid">bezahlt</span>${i.paymentDate ? ` <small class="muted">${fmtDEfull(i.paymentDate)}</small>` : ''}` : '<span class="fin-open">offen</span>'}</td></tr>`).join('') + '</tbody>'
            : '<tbody><tr><td class="muted">Keine Rechnungen im Zeitraum.</td></tr></tbody>';
        $('#fin-stays-note').textContent = t.staysWithoutInvoice
            ? `${t.staysWithoutInvoice} von ${t.stays} Aufenthalten im Zeitraum haben keine Rechnung hier (z. B. Booking.com/Airbnb, die über das Portal abrechnen). Sie stehen im Export im Blatt „Belegung“.`
            : (t.stays ? `Alle ${t.stays} Aufenthalte im Zeitraum haben eine Rechnung.` : '');
        $('#fin-pdfs').disabled = !t.invoices;
    }

    if (viewFinance) {
        $('#fin-mode').addEventListener('click', e => {
            const b = e.target.closest('button[data-mode]');
            if (!b) return;
            if (b.dataset.mode === 'custom' && !fin.from) { const p = finPeriod(); fin.from = p.from; fin.to = p.to; }
            fin.mode = b.dataset.mode;
            loadFinance();
        });
        $('#fin-year').addEventListener('change', e => { fin.year = parseInt(e.target.value, 10); loadFinance(); });
        $('#fin-quarter').addEventListener('change', e => { fin.quarter = parseInt(e.target.value, 10); loadFinance(); });
        $('#fin-month').addEventListener('change', e => { fin.month = parseInt(e.target.value, 10); loadFinance(); });
        ['#fin-from', '#fin-to'].forEach(sel => $(sel).addEventListener('change', () => {
            if ($('#fin-from').value && $('#fin-to').value) { fin.from = $('#fin-from').value; fin.to = $('#fin-to').value; loadFinance(); }
        }));
        $('#fin-basis').addEventListener('change', e => { fin.basis = e.target.value; loadFinance(); });
        $('#fin-orphans').addEventListener('change', e => { fin.orphans = e.target.checked; loadFinance(); });

        // Invoice PDFs: made on the server one by one, so show progress and errors instead of a blank download
        $('#fin-pdfs').addEventListener('click', async () => {
            const btn = $('#fin-pdfs');
            const note = $('#fin-pdf-note');
            btn.disabled = true;
            const old = btn.textContent;
            btn.textContent = 'PDFs werden erstellt …';
            note.textContent = 'Das dauert ein paar Sekunden pro Rechnung. Bitte die Seite offen lassen.';
            try {
                const res = await fetch('/api/finance/invoices.zip?' + finQuery());
                if (!res.ok) {
                    let msg = 'PDF-Export fehlgeschlagen';
                    try { msg = (await res.json()).error || msg; } catch (e) { /* not JSON */ }
                    throw new Error(msg);
                }
                const blob = await res.blob();
                const name = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || 'Rechnungen.zip';
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = name;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 10000);
                note.textContent = `Fertig: ${name}`;
            } catch (e) {
                note.textContent = '';
                showToast(e.message, 'error');
            } finally {
                btn.textContent = old;
                btn.disabled = false;
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
        item.addEventListener('click', async (e) => {
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

                if (targetId === 'settings-push') loadPushSettings();

                // Toggle larger modal for designer
                if (targetId === 'settings-invoice-designer') {
                    settingsModal.classList.add('designer-active');
                    await loadTemplateConfig();
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
                showToast(data.updated ? 'Vorhandenen Türcode auf den Zeitraum angepasst 🔑' : 'Keypad-PIN erfolgreich generiert! 🔑', 'success');
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
            // Use server-side proxy to test connection (supports custom certificates)
            const response = await fetch('/api/settings/paperless/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, token })
            });

            const result = await response.json();

            if (result.success) {
                showToast('Paperless-Verbindung erfolgreich! ✓', 'success');
            } else {
                showToast(`Paperless-Fehler: ${result.error}`, 'error');
            }
        } catch (err) {
            showToast(`Verbindungsfehler: ${err.message}`, 'error');
        } finally {
            btnTestConnection.disabled = false;
            btnTestConnection.textContent = 'Paperless testen';
        }
    });

    // Certificate Upload
    $('#btn-upload-cert')?.addEventListener('click', async () => {
        const fileInput = $('#paperless-cert-file');
        if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
            showToast('Bitte wähle eine Zertifikatsdatei aus', 'error');
            return;
        }

        const formData = new FormData();
        formData.append('certificate', fileInput.files[0]);

        try {
            const res = await fetch('/api/settings/paperless/upload-cert', {
                method: 'POST',
                body: formData
            });
            const result = await res.json();
            if (result.success) {
                showToast('Zertifikat erfolgreich hochgeladen! 🔒', 'success');
                fileInput.value = '';
                loadCertStatus();
            } else {
                showToast(result.error || 'Upload fehlgeschlagen', 'error');
            }
        } catch (err) {
            showToast('Upload-Fehler: ' + err.message, 'error');
        }
    });

    // Delete Certificate
    $('#btn-delete-cert')?.addEventListener('click', async () => {
        if (!confirm('Möchtest du das Zertifikat wirklich löschen?')) return;

        try {
            const res = await fetch('/api/settings/paperless/cert', { method: 'DELETE' });
            const result = await res.json();
            if (result.success) {
                showToast('Zertifikat gelöscht', 'success');
                loadCertStatus();
            } else {
                showToast(result.error || 'Löschen fehlgeschlagen', 'error');
            }
        } catch (err) {
            showToast('Fehler beim Löschen: ' + err.message, 'error');
        }
    });

    // Load Certificate Status
    async function loadCertStatus() {
        try {
            const res = await fetch('/api/settings/paperless/cert-status');
            const result = await res.json();
            if (result.success && result.certificate.exists) {
                $('#cert-status-display').style.display = 'block';
                const date = new Date(result.certificate.uploadedAt);
                $('#cert-upload-date').textContent = date.toLocaleDateString('de-DE') + ' ' + date.toLocaleTimeString('de-DE');
            } else {
                $('#cert-status-display').style.display = 'none';
            }
        } catch (err) {
            console.error('Cert Status Error:', err);
        }
    }

    // Load cert status on settings open
    const settingsPaperlessTab = document.querySelector('.nav-item[data-target="settings-paperless"]');
    if (settingsPaperlessTab) {
        settingsPaperlessTab.addEventListener('click', loadCertStatus);
    }

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
    // Manual calendar sync (Booking.com + Airbnb)
    // =======================
    const btnIcalSync = $('#btn-ical-sync');
    if (btnIcalSync) {
        btnIcalSync.addEventListener('click', async () => {
            const status = $('#ical-sync-status');
            btnIcalSync.disabled = true;
            btnIcalSync.textContent = '🔄 Frage ab …';
            if (status) status.textContent = '';
            try {
                // Send the URLs along so a freshly pasted link is saved and used right away
                const bUrl = ($('#booking-ical-url')?.value || '').trim();
                const aUrl = ($('#airbnb-ical-url')?.value || '').trim();
                const response = await fetch('/api/ical/sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ booking_ical: bUrl, airbnb_ical: aUrl })
                });
                const data = await response.json();
                if (!response.ok || !data.success) {
                    showToast(data.error || 'Abfrage fehlgeschlagen', 'error');
                    if (status) status.textContent = '❌ ' + (data.error || 'Fehler');
                    return;
                }
                const parts = data.feeds.map(f => f.ok
                    ? `${f.source}: ${f.events} Einträge, ${f.newCount} neu${f.cancelled ? ', ' + f.cancelled + ' storniert' : ''}`
                    : `${f.source}: Fehler (${f.error})`);
                const anyError = data.feeds.some(f => !f.ok);
                if (status) status.textContent = (anyError ? '⚠️ ' : '✅ ') + parts.join(' · ');
                showToast(
                    data.newCount > 0 ? `${data.newCount} neue Buchung(en) erkannt – Tür-Code angelegt` : 'Abfrage abgeschlossen – keine neuen Buchungen',
                    anyError ? 'error' : 'success'
                );
            } catch (err) {
                showToast('Abfrage fehlgeschlagen: ' + err.message, 'error');
            } finally {
                btnIcalSync.disabled = false;
                btnIcalSync.textContent = '🔄 Kalender jetzt abfragen';
            }
        });
    }

    // =======================
    // Print
    // =======================
    btnPrint.addEventListener('click', () => {
        archiveInvoice();
        window.print();
    });

    if (btnSaveInvoice) {
        btnSaveInvoice.addEventListener('click', () => {
            archiveInvoice();
        });
    }

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

        // The server uses the SMTP access from the settings; an old browser-saved one is only a fallback
        const smtpRaw = localStorage.getItem(STORAGE_KEYS.smtp);
        const smtpConfig = smtpRaw ? JSON.parse(smtpRaw) : undefined;

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
                        ${[...(release.features || []), ...(release.fixes || [])].map(f => `<li style="margin-bottom: 0.2rem;">${f}</li>`).join('')}
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
            const originalContent = btn.innerHTML;
            btn.disabled = true;

            // Show Overlay
            updateOverlay.style.display = 'flex';
            updateStatusText.textContent = 'Update wird geprüft...';

            // Erst prüfen, ob es überhaupt etwas Neues gibt
            let check;
            try {
                const checkRes = await fetch('/api/update/check');
                check = await checkRes.json();
            } catch (err) {
                check = { success: false, message: 'Server nicht erreichbar' };
            }
            if (!check.success) {
                updateStatusText.textContent = `Fehler: ${check.message || 'Prüfung fehlgeschlagen'}`;
                showToast(`Update-Prüfung fehlgeschlagen: ${check.message || ''}`, 'error', 10000);
                setTimeout(() => { updateOverlay.style.display = 'none'; btn.disabled = false; }, 4000);
                return;
            }
            if (!check.updateAvailable) {
                updateStatusText.textContent = `Keine Updates verfügbar (Version ${check.currentVersion}).`;
                showToast(`Du hast bereits die neueste Version ${check.currentVersion}.`, 'info');
                setTimeout(() => { updateOverlay.style.display = 'none'; btn.disabled = false; }, 2500);
                return;
            }
            updateOverlay.style.display = 'none';
            if (!confirm(`Update verfügbar: ${check.currentVersion} → ${check.remoteVersion}\n\nJetzt installieren? Der Server startet dabei kurz neu.`)) {
                btn.disabled = false;
                return;
            }
            updateOverlay.style.display = 'flex';
            updateStatusText.textContent = 'Update wird installiert...';

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
                        ? `<span style="background:var(--ok-soft);color:var(--ok);padding:2px 8px;border-radius:12px;font-size:11px;">Aktiv</span>`
                        : `<span style="background:var(--bad-soft);color:var(--bad);padding:2px 8px;border-radius:12px;font-size:11px;">Abgelehnt</span>`;
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

        // Default to the calendar (Smoobu-style home); a tapped push notification opens /?view=bookings
        const startView = new URLSearchParams(location.search).get('view');
        switchView(['bookings', 'expenses', 'invoice', 'dashboard', 'occupancy', 'finance'].includes(startView) ? startView : 'calendar');
        if (startView) history.replaceState(null, '', '/');

        registerServiceWorker();
    }

    // =======================
    // Web app & push notifications
    // =======================
    const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
    const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

    async function registerServiceWorker() {
        if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
        try {
            return await navigator.serviceWorker.register('/sw.js');
        } catch (e) {
            console.warn('Service Worker:', e.message);
            return null;
        }
    }

    async function currentPushSubscription() {
        if (!pushSupported()) return null;
        const reg = await navigator.serviceWorker.getRegistration('/');
        return reg ? reg.pushManager.getSubscription() : null;
    }

    async function sha256Hex(text) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function deviceLabel() {
        const ua = navigator.userAgent;
        const os = /iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) || (isIos() && !/iphone/i.test(ua)) ? 'iPad'
            : /android/i.test(ua) ? 'Android' : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Linux' : 'Gerät';
        const browser = /edg\//i.test(ua) ? 'Edge' : /firefox|fxios/i.test(ua) ? 'Firefox' : /chrome|crios/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : '';
        return `${os}${browser ? ' · ' + browser : ''}${isStandalone() ? ' (App)' : ''}`;
    }

    async function loadPushSettings() {
        const status = $('#push-status');
        const btnOn = $('#btn-push-enable');
        const btnOff = $('#btn-push-disable');
        const modeSel = $('#push-mode');
        if (!status) return;

        let mySub = null;
        if (!window.isSecureContext) {
            status.textContent = '⚠️ Die Seite ist nicht über https:// geöffnet. Browser erlauben Push-Meldungen nur über eine sichere Verbindung.';
            btnOn.disabled = true;
        } else if (isIos() && !isStandalone()) {
            status.textContent = '📱 Auf dem iPhone/iPad funktionieren Benachrichtigungen nur in der installierten App: Teilen → „Zum Home-Bildschirm“, dann die App von dort öffnen.';
            btnOn.disabled = true;
        } else if (!pushSupported()) {
            status.textContent = '⚠️ Dieser Browser unterstützt keine Push-Benachrichtigungen.';
            btnOn.disabled = true;
        } else if (Notification.permission === 'denied') {
            status.textContent = '🔕 Benachrichtigungen sind für diese Seite blockiert. Bitte in den Browser-/Systemeinstellungen erlauben.';
            btnOn.disabled = true;
        } else {
            btnOn.disabled = false;
            mySub = await currentPushSubscription();
            status.textContent = mySub ? '✅ Dieses Gerät erhält Benachrichtigungen.' : 'Dieses Gerät erhält noch keine Benachrichtigungen.';
        }
        btnOn.style.display = mySub ? 'none' : '';
        btnOff.style.display = mySub ? '' : 'none';

        let devices = [];
        try {
            const d = await apiJson('/api/push/devices');
            devices = d.success ? d.devices : [];
        } catch (e) { /* list stays empty */ }
        const myHash = mySub ? (await sha256Hex(mySub.endpoint)).slice(0, 16) : null;
        const mine = devices.find(d => d.endpointHash === myHash);
        if (mine) modeSel.value = mine.mode;
        // Subscribed in the browser but unknown to the server (e.g. removed in the list) -> offer to activate again
        if (mySub && !mine) {
            status.textContent = 'Dieses Gerät ist am Server nicht mehr registriert.';
            btnOn.style.display = '';
            btnOff.style.display = 'none';
        }

        const list = $('#push-devices');
        list.innerHTML = devices.length ? devices.map(d => `
            <div class="info-row" style="flex-wrap: wrap; gap: 0.5rem; align-items: center;">
                <span style="flex: 1 1 12rem;">
                    <strong>${escapeHtml(d.label || 'Gerät')}</strong>${d.endpointHash === myHash ? ' <span class="badge">dieses Gerät</span>' : ''}<br>
                    <small class="text-muted">${escapeHtml(d.username || '')} · seit ${escapeHtml(fmtDEfull(String(d.createdAt || '').slice(0, 10)))} · ${d.mode === 'all' ? 'alle Meldungen' : 'nur Wichtiges'}</small>
                </span>
                <button type="button" class="btn btn-ghost btn-sm" data-push-test="${d.id}">Test senden</button>
                <button type="button" class="btn btn-ghost btn-sm" data-push-remove="${d.id}">Entfernen</button>
            </div>`).join('') : '<p class="text-muted">Noch kein Gerät.</p>';
        modeSel.dataset.deviceId = mine ? mine.id : '';
    }

    function urlBase64ToUint8Array(base64) {
        const raw = atob(base64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - base64.length % 4) % 4));
        return Uint8Array.from(raw, c => c.charCodeAt(0));
    }

    async function enablePush() {
        try {
            // iOS only allows the permission prompt directly inside the tap handler
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                showToast('Benachrichtigungen wurden nicht erlaubt', 'error');
                return loadPushSettings();
            }
            const reg = (await navigator.serviceWorker.getRegistration('/')) || await registerServiceWorker();
            if (!reg) throw new Error('Service Worker nicht verfügbar');
            await navigator.serviceWorker.ready;
            const { publicKey } = await apiJson('/api/push/key');
            let sub = await reg.pushManager.getSubscription();
            if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
            const d = await apiJson('/api/push/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscription: sub.toJSON(), label: deviceLabel(), mode: $('#push-mode').value })
            });
            if (!d.success) throw new Error(d.error || 'Server hat das Gerät abgelehnt');
            showToast('Benachrichtigungen aktiviert 🔔', 'success');
            await apiJson('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: d.id }) });
        } catch (e) {
            showToast('Aktivieren fehlgeschlagen: ' + e.message, 'error');
        }
        loadPushSettings();
    }

    async function disablePush() {
        try {
            const sub = await currentPushSubscription();
            if (sub) {
                await apiJson('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
                await sub.unsubscribe();
            }
            showToast('Benachrichtigungen auf diesem Gerät aus', 'success');
        } catch (e) {
            showToast('Fehler: ' + e.message, 'error');
        }
        loadPushSettings();
    }

    $('#btn-push-enable')?.addEventListener('click', enablePush);
    $('#btn-push-disable')?.addEventListener('click', disablePush);
    $('#push-mode')?.addEventListener('change', async e => {
        const id = e.target.dataset.deviceId;
        if (!id) return; // not registered yet: the choice is sent on activation
        const d = await apiJson(`/api/push/devices/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: e.target.value }) });
        showToast(d.success ? 'Gespeichert' : 'Speichern fehlgeschlagen', d.success ? 'success' : 'error');
        loadPushSettings();
    });
    $('#push-devices')?.addEventListener('click', async e => {
        const testId = e.target.dataset.pushTest;
        const removeId = e.target.dataset.pushRemove;
        if (testId) {
            const d = await apiJson('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: testId }) });
            showToast(d.success ? 'Test gesendet' : (d.error || 'Test fehlgeschlagen'), d.success ? 'success' : 'error');
        } else if (removeId) {
            await apiJson(`/api/push/devices/${removeId}`, { method: 'DELETE' });
            loadPushSettings();
        }
    });

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
                        ? `<span style="background:var(--ok-soft);color:var(--ok);padding:1px 6px;border-radius:10px;font-size:10px;">Bezahlt</span>`
                        : `<span style="background:var(--warn-soft);color:var(--warn);padding:1px 6px;border-radius:10px;font-size:10px;">Offen</span>`;
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
                            ? `<span style="background:var(--bad-soft);color:var(--bad);padding:1px 7px;border-radius:12px;font-size:11px;">Abgelaufen</span>`
                            : `<span style="background:var(--ok-soft);color:var(--ok);padding:1px 7px;border-radius:12px;font-size:11px;">Aktiv</span>`;
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
            if (data.success && data.branding) {
                // Load logo
                if (data.branding.logo_base64) {
                    currentLogoBase64 = data.branding.logo_base64;
                    logoPreview.src = currentLogoBase64;
                    logoPreview.style.display = 'block';
                    btnRemoveLogo.style.display = 'inline-flex';
                }
                // Load template config
                if (data.branding.template_config) {
                    currentTemplateConfig = { ...defaultTemplateConfig, ...data.branding.template_config };
                    applyTemplateStyles();
                }
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
        name: 'Mein Template',
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

            let loadedConfig = { ...defaultTemplateConfig };
            if (data.success && data.branding && data.branding.template_config) {
                if (Object.keys(data.branding.template_config).length > 0) {
                    loadedConfig = { ...defaultTemplateConfig, ...data.branding.template_config };
                }
            }

            // Restore from unsaved local session if available
            const localBackup = localStorage.getItem('invoice_template_backup');
            if (localBackup) {
                try {
                    const parsed = JSON.parse(localBackup);
                    if (confirm('Es gibt ungespeicherte Template-Änderungen aus deiner letzten Sitzung. Möchtest du diese wiederherstellen?')) {
                        loadedConfig = { ...defaultTemplateConfig, ...parsed };
                        setTimeout(() => triggerTemplateAutoSave(), 1000);
                    } else {
                        localStorage.removeItem('invoice_template_backup');
                    }
                } catch (e) {
                    localStorage.removeItem('invoice_template_backup');
                }
            }

            currentTemplateConfig = loadedConfig;

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
        $('#tpl-name').value = currentTemplateConfig.name || 'Mein Template';
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

    // Auto-Save Logic for Template
    let templateSaveTimeout = null;
    function triggerTemplateAutoSave() {
        // Save locally immediately to prevent data loss on reload
        localStorage.setItem('invoice_template_backup', JSON.stringify(currentTemplateConfig));

        // Debounce server save (auto-save to DB after 2 seconds of inactivity)
        if (templateSaveTimeout) clearTimeout(templateSaveTimeout);
        templateSaveTimeout = setTimeout(async () => {
            try {
                const btn = $('#btn-save-template');
                if (btn) btn.textContent = 'Speichert...';

                const res = await fetch('/api/branding/template', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ template_config: currentTemplateConfig })
                });
                const data = await res.json();

                if (data.success) {
                    localStorage.removeItem('invoice_template_backup');
                }
            } catch (e) {
                console.error('Auto-save error:', e);
            } finally {
                const btn = $('#btn-save-template');
                if (btn) btn.textContent = 'Template speichern';
            }
        }, 2000);
    }

    // Live preview update on input
    const templateInputs = [
        '#tpl-name', '#tpl-logo-text', '#tpl-greeting', '#tpl-intro', '#tpl-footer-text',
        '#tpl-color-primary', '#tpl-color-table-bg', '#tpl-color-table-header', '#tpl-color-text',
        '#tpl-font-logo', '#tpl-font-body',
        '#tpl-show-logo', '#tpl-show-tax', '#tpl-show-date-header', '#tpl-show-fold-marks'
    ];

    templateInputs.forEach(selector => {
        const el = $(selector);
        if (el) {
            el.addEventListener('input', () => {
                // Update config from form
                currentTemplateConfig.name = $('#tpl-name').value;
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
                triggerTemplateAutoSave();
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
                    localStorage.removeItem('invoice_template_backup');
                    showToast('Template gespeichert! ✓', 'success');
                    // Apply to main invoice preview as well
                    applyTemplateStyles();
                    if (typeof updatePreview === 'function') {
                        updatePreview();
                    }
                } else {
                    showToast('Fehler beim Speichern', 'error');
                }
            } catch (e) {
                console.error('Template save error:', e);
                showToast('Fehler beim Speichern', 'error');
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
                applyTemplateStyles();
                updateTemplatePreview();
                triggerTemplateAutoSave();
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
                    triggerTemplateAutoSave();
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
                showToast('Bitte wähle eine Bilddatei', 'error');
                return;
            }

            // Validate file size (max 2MB)
            if (file.size > 2 * 1024 * 1024) {
                showToast('Bild ist zu groß (max 2MB)', 'error');
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
                triggerTemplateAutoSave();
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
            triggerTemplateAutoSave();
        });
    }

    // =======================
    // WELCOME SCREEN (Google TV Kiosk)
    // =======================
    const viewWelcome = $('#view-welcome');
    
    function showWelcomeScreen(guestName) {
        console.log('showWelcomeScreen called with:', guestName);

        // Get fresh reference to welcome view (in case DOM wasn't ready before)
        const welcomeView = document.querySelector('#view-welcome');

        // Hide all other views
        const viewDash = document.querySelector('#view-dashboard');
        const viewInv = document.querySelector('#view-invoice-form');
        const viewExp = document.querySelector('#view-expenses');
        const wrapper = document.querySelector('#app-wrapper');
        const login = document.querySelector('#login-screen');

        if (viewDash) viewDash.style.display = 'none';
        if (viewInv) viewInv.style.display = 'none';
        if (viewExp) viewExp.style.display = 'none';
        if (wrapper) wrapper.style.display = 'none';
        if (login) login.style.display = 'none';

        // Show welcome screen
        if (welcomeView) {
            console.log('Welcome view found, showing it');
            welcomeView.style.display = 'block';

            // Debug: Check computed styles
            setTimeout(() => {
                const computedStyle = window.getComputedStyle(welcomeView);
                console.log('Welcome view display:', computedStyle.display);
                console.log('Welcome view visibility:', computedStyle.visibility);
                console.log('Welcome view z-index:', computedStyle.zIndex);
                console.log('Welcome view position:', computedStyle.position);
            }, 100);

            // Set guest name
            const guestNameEl = document.querySelector('#welcome-guest-name');
            if (guestNameEl && guestName) {
                guestNameEl.textContent = guestName;
                console.log('Guest name set to:', guestName);
            }

            // Update time and date
            updateWelcomeTime();
            setInterval(updateWelcomeTime, 1000);

            // Load settings for WLAN, phone, etc.
            loadWelcomeSettings();
        } else {
            console.error('Welcome view not found! Element #view-welcome does not exist.');
        }
    }
    
    function updateWelcomeTime() {
        const now = new Date();
        const timeEl = $('#welcome-time');
        const dateEl = $('#welcome-date');
        
        if (timeEl) {
            timeEl.textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        }
        
        if (dateEl) {
            const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
            dateEl.textContent = now.toLocaleDateString('de-DE', options);
        }
    }
    
    async function loadWelcomeSettings() {
        try {
            // Check URL parameters first (from Android app)
            const urlParams = new URLSearchParams(window.location.search);

            // WLAN Info
            const wifiName = urlParams.get('wifi');
            const wifiPass = urlParams.get('wifi_pass');
            if (wifiName && wifiName.trim()) {
                const wifiNameEl = $('#welcome-wifi-name');
                if (wifiNameEl) wifiNameEl.textContent = decodeURIComponent(wifiName);
            }
            if (wifiPass && wifiPass.trim()) {
                const wifiPassEl = $('#welcome-wifi-pass');
                if (wifiPassEl) wifiPassEl.textContent = 'Passwort: ' + decodeURIComponent(wifiPass);
            }

            // Check-In/Out Times
            const checkinTime = urlParams.get('checkin');
            const checkoutTime = urlParams.get('checkout');
            if (checkinTime && checkinTime.trim()) {
                const checkinEl = $('#welcome-checkin');
                if (checkinEl) checkinEl.textContent = decodeURIComponent(checkinTime);
            }
            if (checkoutTime && checkoutTime.trim()) {
                const checkoutEl = $('#welcome-checkout');
                if (checkoutEl) checkoutEl.textContent = decodeURIComponent(checkoutTime);
            }

            // Phone
            const phone = urlParams.get('phone');
            if (phone && phone.trim()) {
                const phoneEl = $('#welcome-phone');
                if (phoneEl) phoneEl.textContent = decodeURIComponent(phone);
            }

            // If no URL params, load from server (fallback)
            if (!phone || !wifiName) {
                // Load vermieter data for phone and logo
                const res = await fetch('/api/settings');
                const data = await res.json();

                if (data.success && data.settings) {
                    const vermieter = data.settings.vermieter || {};

                    // Set phone (only if not in URL)
                    if (!phone) {
                        const phoneEl = $('#welcome-phone');
                        if (phoneEl && vermieter.telefon) {
                            phoneEl.textContent = vermieter.telefon;
                        }
                    }

                    // Set logo text
                    const logoEl = $('#welcome-logo');
                    if (logoEl && vermieter.name) {
                        logoEl.textContent = vermieter.name;
                    }
                }
            }

            // Load branding for logo
            const brandingRes = await fetch('/api/branding');
            const brandingData = await brandingRes.json();

            if (brandingData.success && brandingData.branding) {
                const logoEl = $('#welcome-logo');
                if (logoEl && brandingData.branding.template_config?.logoText) {
                    logoEl.textContent = brandingData.branding.template_config.logoText;
                }
            }
        } catch (e) {
            console.error('Load welcome settings error:', e);
        }
    }
    
    // App launch buttons
    const btnLaunchWaipu = $('#btn-launch-waipu');
    const btnLaunchNetflix = $('#btn-launch-netflix');
    const btnLaunchYoutube = $('#btn-launch-youtube');
    const btnLaunchPrime = $('#btn-launch-prime');
    
    if (btnLaunchWaipu) {
        btnLaunchWaipu.addEventListener('click', () => {
            // On Android TV, this will try to launch the app
            window.location.href = 'intent://de.exaring.waiputv#Intent;scheme=app;package=de.exaring.waiputv;end';
        });
    }
    
    if (btnLaunchNetflix) {
        btnLaunchNetflix.addEventListener('click', () => {
            window.location.href = 'intent://com.netflix.mediaclient#Intent;scheme=app;package=com.netflix.mediaclient;end';
        });
    }
    
    if (btnLaunchYoutube) {
        btnLaunchYoutube.addEventListener('click', () => {
            window.location.href = 'intent://com.google.android.youtube.tv#Intent;scheme=app;package=com.google.android.youtube.tv;end';
        });
    }
    
    if (btnLaunchPrime) {
        btnLaunchPrime.addEventListener('click', () => {
            window.location.href = 'intent://com.amazon.avod.thirdpartyclient#Intent;scheme=app;package=com.amazon.avod.thirdpartyclient;end';
        });
    }
    
    // Check URL for welcome screen parameter
    const urlParams = new URLSearchParams(window.location.search);
    const welcomeGuest = urlParams.get('welcome');

    if (welcomeGuest) {
        // Show welcome screen with guest name
        showWelcomeScreen(decodeURIComponent(welcomeGuest));
    }

    // =======================
    // ESTATE MANAGEMENT FUNCTIONS
    // =======================

    // Estate Tabs
    $$('.estate-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            $$('.estate-tab').forEach(t => t.classList.remove('active'));
            $$('.estate-tab-content').forEach(c => c.style.display = 'none');
            tab.classList.add('active');
            $(`#estate-tab-${tabName}`).style.display = 'block';
        });
    });

    // Mileage Form
    $('#form-mileage')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const editId = form.dataset.editId;

        const data = {
            date: $('#mileage-date').value,
            from_location: $('#mileage-from').value,
            to_location: $('#mileage-to').value,
            purpose: $('#mileage-purpose').value,
            distance_km: parseFloat($('#mileage-distance').value),
            rate_per_km: parseFloat($('#mileage-rate').value) || 0.30,
            notes: $('#mileage-notes').value
        };

        try {
            const url = editId ? `/api/estate/mileage/${editId}` : '/api/estate/mileage';
            const method = editId ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const result = await res.json();
            if (result.success) {
                showToast(editId ? 'Fahrtkosten aktualisiert' : 'Fahrtkosten gespeichert', 'success');
                form.reset();
                delete form.dataset.editId;
                const submitBtn = form.querySelector('button[type="submit"]');
                submitBtn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Fahrtkosten speichern`;
                loadEstateMileage();
                loadEstateStats();
            } else {
                showToast(result.error || 'Fehler beim Speichern', 'error');
            }
        } catch (err) {
            showToast('Server-Fehler', 'error');
        }
    });

    // Estate Expense Form
    $('#form-estate-expense')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const editId = form.dataset.editId;

        // Handle file upload if present
        const fileInput = $('#expense-file');
        let filePath = null;
        if (fileInput && fileInput.files.length > 0) {
            filePath = await uploadEstateFile(fileInput);
        }

        const data = {
            date: $('#expense-date').value,
            category: $('#expense-category').value,
            description: $('#expense-description').value,
            amount: parseFloat($('#expense-amount').value),
            notes: $('#expense-notes').value,
            receipt_file: filePath
        };
        try {
            const url = editId ? `/api/estate/expenses/${editId}` : '/api/estate/expenses';
            const method = editId ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const result = await res.json();
            if (result.success) {
                showToast(editId ? 'Aufwendung aktualisiert' : 'Aufwendung gespeichert', 'success');
                form.reset();
                delete form.dataset.editId;
                const submitBtn = form.querySelector('button[type="submit"]');
                submitBtn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Aufwendung speichern`;
                loadEstateExpenses();
                loadEstateStats();
            } else {
                showToast(result.error || 'Fehler beim Speichern', 'error');
            }
        } catch (err) {
            showToast('Server-Fehler', 'error');
        }
    });

    // Estate Invoice Form
    $('#form-estate-invoice')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const editId = form.dataset.editId;

        // Handle file upload if present
        const fileInput = $('#invoice-file');
        let filePath = null;
        if (fileInput && fileInput.files.length > 0) {
            filePath = await uploadEstateFile(fileInput);
        }

        const data = {
            date: $('#invoice-date').value,
            vendor: $('#invoice-vendor').value,
            invoice_number: $('#invoice-number').value,
            description: $('#invoice-description').value,
            amount: parseFloat($('#invoice-amount').value),
            notes: $('#invoice-notes').value,
            file_path: filePath
        };
        try {
            const url = editId ? `/api/estate/invoices/${editId}` : '/api/estate/invoices';
            const method = editId ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method: method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const result = await res.json();
            if (result.success) {
                showToast(editId ? 'Rechnung aktualisiert' : 'Rechnung gespeichert', 'success');
                form.reset();
                delete form.dataset.editId;
                const submitBtn = form.querySelector('button[type="submit"]');
                submitBtn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Rechnung speichern`;
                loadEstateInvoices();
                loadEstateStats();
            } else {
                showToast(result.error || 'Fehler beim Speichern', 'error');
            }
        } catch (err) {
            showToast('Server-Fehler', 'error');
        }
    });

    // PDF Report Generation
    $('#btn-estate-report')?.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/estate/generate-report', { method: 'POST' });
            if (!res.ok) throw new Error('PDF-Generierung fehlgeschlagen');
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Erbverwaltung-Abrechnung-${new Date().toISOString().split('T')[0]}.pdf`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            showToast('PDF-Abrechnung erfolgreich erstellt', 'success');
        } catch (err) {
            showToast('Fehler bei PDF-Generierung: ' + err.message, 'error');
        }
    });

    // Load Functions
    async function loadEstateData() {
        await Promise.all([
            loadEstateMileage(),
            loadEstateExpenses(),
            loadEstateInvoices(),
            loadEstateStats()
        ]);
    }

    async function loadEstateMileage() {
        try {
            const res = await fetch('/api/estate/mileage');
            const data = await res.json();
            if (data.success) {
                renderEstateMileage(data.mileage);
            }
        } catch (err) {
            console.error('Load mileage error:', err);
        }
    }

    function renderEstateMileage(mileage) {
        const list = $('#mileage-list');
        list.innerHTML = '';
        if (mileage.length === 0) {
            list.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Keine Fahrtkostenabrechnung vorhanden</td></tr>';
            return;
        }
        mileage.forEach(m => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${formatDate(m.date)}</td>
                <td>${escapeHtml(m.from_location)} → ${escapeHtml(m.to_location)}</td>
                <td>${escapeHtml(m.purpose)}</td>
                <td class="text-right">${m.distance_km.toFixed(1)} km</td>
                <td class="text-right">${formatCurrency(m.total_amount)}</td>
                <td class="text-right">
                    <button class="btn btn-ghost btn-icon btn-edit-mileage" data-id="${m.id}" title="Bearbeiten">
                        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    </button>
                    <button class="btn btn-ghost btn-icon btn-danger btn-delete-mileage" data-id="${m.id}" title="Löschen">
                        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </td>
            `;
            list.appendChild(tr);
        });

        $$('.btn-edit-mileage').forEach(btn => {
            btn.addEventListener('click', () => {
                const m = mileage.find(item => item.id === parseInt(btn.dataset.id));
                if (m) editEstateMileage(m);
            });
        });

        $$('.btn-delete-mileage').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Fahrtkosten wirklich löschen?')) return;
                try {
                    const res = await fetch(`/api/estate/mileage/${btn.dataset.id}`, { method: 'DELETE' });
                    const result = await res.json();
                    if (result.success) {
                        showToast('Fahrtkosten gelöscht', 'success');
                        loadEstateMileage();
                        loadEstateStats();
                    }
                } catch (err) {
                    showToast('Fehler beim Löschen', 'error');
                }
            });
        });
    }

    function editEstateMileage(m) {
        $('#mileage-date').value = m.date;
        $('#mileage-from').value = m.from_location;
        $('#mileage-to').value = m.to_location;
        $('#mileage-purpose').value = m.purpose;
        $('#mileage-distance').value = m.distance_km;
        $('#mileage-rate').value = m.rate_per_km;
        $('#mileage-notes').value = m.notes || '';

        const form = $('#form-mileage');
        form.dataset.editId = m.id;

        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg> Aktualisieren`;

        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function loadEstateExpenses() {
        try {
            const res = await fetch('/api/estate/expenses');
            const data = await res.json();
            if (data.success) {
                renderEstateExpenses(data.expenses);
            }
        } catch (err) {
            console.error('Load estate expenses error:', err);
        }
    }

    function renderEstateExpenses(expenses) {
        const list = $('#estate-expenses-list');
        list.innerHTML = '';
        if (expenses.length === 0) {
            list.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Keine Aufwendungen vorhanden</td></tr>';
            return;
        }
        expenses.forEach(e => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${formatDate(e.date)}</td>
                <td><span class="category-badge">${escapeHtml(e.category)}</span></td>
                <td>${escapeHtml(e.description)}</td>
                <td class="text-right">${formatCurrency(e.amount)}</td>
                <td class="text-right">
                    <button class="btn btn-ghost btn-icon btn-edit-estate-expense" data-id="${e.id}" title="Bearbeiten">
                        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    </button>
                    <button class="btn btn-ghost btn-icon btn-danger btn-delete-estate-expense" data-id="${e.id}" title="Löschen">
                        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </td>
            `;
            list.appendChild(tr);
        });

        $$('.btn-edit-estate-expense').forEach(btn => {
            btn.addEventListener('click', () => {
                const expense = expenses.find(item => item.id === parseInt(btn.dataset.id));
                if (expense) editEstateExpense(expense);
            });
        });

        $$('.btn-delete-estate-expense').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Aufwendung wirklich löschen?')) return;
                try {
                    const res = await fetch(`/api/estate/expenses/${btn.dataset.id}`, { method: 'DELETE' });
                    const result = await res.json();
                    if (result.success) {
                        showToast('Aufwendung gelöscht', 'success');
                        loadEstateExpenses();
                        loadEstateStats();
                    }
                } catch (err) {
                    showToast('Fehler beim Löschen', 'error');
                }
            });
        });
    }

    function editEstateExpense(e) {
        $('#expense-date').value = e.date;
        $('#expense-category').value = e.category;
        $('#expense-description').value = e.description;
        $('#expense-amount').value = e.amount;
        $('#expense-notes').value = e.notes || '';

        const form = $('#form-estate-expense');
        form.dataset.editId = e.id;

        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg> Aktualisieren`;

        // Switch to expenses tab
        $$('.estate-tab').forEach(t => t.classList.remove('active'));
        $$('.estate-tab-content').forEach(c => c.style.display = 'none');
        document.querySelector('.estate-tab[data-tab="expenses"]').classList.add('active');
        $('#estate-tab-expenses').style.display = 'block';

        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function loadEstateInvoices() {
        try {
            const res = await fetch('/api/estate/invoices');
            const data = await res.json();
            if (data.success) {
                renderEstateInvoices(data.invoices);
            }
        } catch (err) {
            console.error('Load estate invoices error:', err);
        }
    }

    function renderEstateInvoices(invoices) {
        const list = $('#estate-invoices-list');
        list.innerHTML = '';
        if (invoices.length === 0) {
            list.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Keine Rechnungen vorhanden</td></tr>';
            return;
        }
        invoices.forEach(inv => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${formatDate(inv.date)}</td>
                <td>${escapeHtml(inv.vendor)}</td>
                <td>${escapeHtml(inv.invoice_number || '—')}</td>
                <td>${escapeHtml(inv.description)}</td>
                <td class="text-right">${formatCurrency(inv.amount)}</td>
                <td class="text-right">
                    <button class="btn btn-ghost btn-icon btn-edit-estate-invoice" data-id="${inv.id}" title="Bearbeiten">
                        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    </button>
                    <button class="btn btn-ghost btn-icon btn-danger btn-delete-estate-invoice" data-id="${inv.id}" title="Löschen">
                        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </td>
            `;
            list.appendChild(tr);
        });

        $$('.btn-edit-estate-invoice').forEach(btn => {
            btn.addEventListener('click', () => {
                const invoice = invoices.find(item => item.id === parseInt(btn.dataset.id));
                if (invoice) editEstateInvoice(invoice);
            });
        });

        $$('.btn-delete-estate-invoice').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Rechnung wirklich löschen?')) return;
                try {
                    const res = await fetch(`/api/estate/invoices/${btn.dataset.id}`, { method: 'DELETE' });
                    const result = await res.json();
                    if (result.success) {
                        showToast('Rechnung gelöscht', 'success');
                        loadEstateInvoices();
                        loadEstateStats();
                    }
                } catch (err) {
                    showToast('Fehler beim Löschen', 'error');
                }
            });
        });
    }

    function editEstateInvoice(inv) {
        $('#invoice-date').value = inv.date;
        $('#invoice-vendor').value = inv.vendor;
        $('#invoice-number').value = inv.invoice_number || '';
        $('#invoice-description').value = inv.description;
        $('#invoice-amount').value = inv.amount;
        $('#invoice-notes').value = inv.notes || '';

        const form = $('#form-estate-invoice');
        form.dataset.editId = inv.id;

        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg> Aktualisieren`;

        // Switch to invoices tab
        $$('.estate-tab').forEach(t => t.classList.remove('active'));
        $$('.estate-tab-content').forEach(c => c.style.display = 'none');
        document.querySelector('.estate-tab[data-tab="invoices"]').classList.add('active');
        $('#estate-tab-invoices').style.display = 'block';

        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function loadEstateStats() {
        try {
            const res = await fetch('/api/estate/stats');
            const data = await res.json();
            if (data.success) {
                $('#stat-mileage').textContent = formatCurrency(data.stats.totals.mileage);
                $('#stat-expenses').textContent = formatCurrency(data.stats.totals.expenses);
                $('#stat-invoices').textContent = formatCurrency(data.stats.totals.invoices);
                $('#stat-total').textContent = formatCurrency(data.stats.totals.grand_total);
            }
        } catch (err) {
            console.error('Load estate stats error:', err);
        }
    }

    // File Upload Handler
    async function uploadEstateFile(fileInput) {
        const file = fileInput.files[0];
        if (!file) return null;

        const formData = new FormData();
        formData.append('file', file);

        try {
            const res = await fetch('/api/estate/upload', {
                method: 'POST',
                body: formData
            });
            const result = await res.json();
            if (result.success) {
                showToast('Datei hochgeladen: ' + result.filename, 'success');
                return result.filePath;
            } else {
                showToast('Upload fehlgeschlagen', 'error');
                return null;
            }
        } catch (err) {
            showToast('Upload-Fehler', 'error');
            return null;
        }
    }

    // Paperless Sync Handler
    async function syncPaperlessEstateInvoices() {
        try {
            showToast('Synchronisierung gestartet...', 'info');
            const res = await fetch('/api/estate/paperless-sync', { method: 'POST' });
            const result = await res.json();
            if (result.success) {
                showToast(result.message, 'success');
                loadEstateInvoices();
                loadEstateStats();
            } else {
                showToast(result.error || 'Sync fehlgeschlagen', 'error');
            }
        } catch (err) {
            showToast('Sync-Fehler: ' + err.message, 'error');
        }
    }
})();
// Version 3.0 - SQLite Database Migration
