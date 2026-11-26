/* Ferienwohnung – Gäste-Webseite · Notfall-Öffnen (QR-Code an der Tür) */
(() => {
    'use strict';

    const $ = s => document.querySelector(s);
    const api = (url, body) => fetch(`api/${url}`, body === undefined ? { credentials: 'same-origin' } : {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const I18N = window.GI18N;
    const T = I18N.T, TX = I18N.TX;
    // "YYYY-MM-DD HH:MM" -> "Fr., 31.10.2026, 15:00 Uhr"
    const when = s => {
        const [d, t] = String(s || '').split(' ');
        const day = new Date(d + 'T12:00:00').toLocaleDateString(I18N.locale(), { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
        return `${day}, ${t}${I18N.lang === 'de' ? ' Uhr' : ''}`;
    };
    let phone = '';
    let last = null; // last status for redrawing in another language

    // The key from the QR code is kept for this tab only and removed from the address bar
    const STORE = 'beckhome-door-key';
    let key = new URLSearchParams(location.search).get('k') || '';
    try {
        if (key) sessionStorage.setItem(STORE, key);
        else key = sessionStorage.getItem(STORE) || '';
    } catch (e) { /* private mode: key stays in memory */ }
    if (location.search) history.replaceState(null, '', location.pathname);

    const box = $('#door-box');
    const show = html => { box.innerHTML = html; };

    const REASONS = {
        disabled: 'Das Öffnen über die Webseite ist gerade nicht freigeschaltet. Bitte rufen Sie uns an.',
        key: 'Bitte scannen Sie den QR-Code an der Tür noch einmal mit der Handy-Kamera.',
        late: 'Ihr Aufenthalt ist beendet. Das Öffnen ist nicht mehr möglich.',
        limit: 'Die Tür wurde in der letzten Stunde schon mehrfach geöffnet. Bitte rufen Sie uns an.'
    };

    function signedIn(code) {
        $('#mast-logout').hidden = !code;
        $('#door-who').hidden = !code;
        $('#door-who').innerHTML = code ? `${esc(T('Angemeldet mit Buchung {code}', { code }))} · <button type="button" data-logout>${T('Abmelden')}</button>` : '';
    }
    async function logout() {
        await api('logout', {});
        refresh();
    }
    $('#mast-logout').addEventListener('click', logout);
    $('#door-who').addEventListener('click', e => { if (e.target.closest('[data-logout]')) logout(); });

    async function refresh() {
        $('#login-box').hidden = true;
        const d = await api('notfall/status', { key });
        if (d.lang && !I18N.hasOwnChoice() && I18N.choose(d.lang)) relabel();
        draw(d);
    }

    function draw(d) {
        last = d;
        signedIn(d.success && d.code ? d.code : null);
        if (d.status === 429) return show(`<p class="door-msg">${esc(TX(d.error) || T('Zu viele Versuche. Bitte später erneut versuchen.'))}</p>`);
        if (!d.success) return show(`<p class="door-msg">${T('Gerade nicht erreichbar. Bitte rufen Sie uns an.')}</p>`);
        if (d.allowed) return showOpen();
        if (d.reason === 'login') {
            show('');
            $('#login-box').hidden = false;
            return;
        }
        if (d.reason === 'early') {
            return show(`<p class="door-msg">${T('Das Öffnen ist ab Ihrem Anreisetag zur Check-in-Zeit möglich:')} <strong>${esc(when(d.from))}</strong>.</p>`);
        }
        show(`<p class="door-msg">${esc(T(REASONS[d.reason] || REASONS.disabled))}</p>`);
    }

    function showOpen() {
        show(`<p>${T('Ist das Tastenfeld an der Tür ausgefallen? Dann können Sie die Tür hier öffnen.')}</p>
            <button type="button" class="btn btn-dark door-open" id="door-open">${T('Tür öffnen')}</button>`);
        $('#door-open').addEventListener('click', () => {
            show(`<p><strong>${T('Tür wirklich öffnen?')}</strong> ${T('Stellen Sie sich direkt vor die Tür. Sie springt nach wenigen Sekunden auf.')}</p>
                <div class="door-confirm">
                    <button type="button" class="btn btn-dark door-open" id="door-yes">${T('Ja, jetzt öffnen')}</button>
                    <button type="button" class="btn btn-ghost" id="door-no">${T('Abbrechen')}</button>
                </div>`);
            $('#door-no').addEventListener('click', showOpen);
            $('#door-yes').addEventListener('click', openDoor);
        });
    }

    async function openDoor() {
        show(`<p>${T('Die Tür wird geöffnet …')}</p>`);
        const d = await api('notfall/open', { key });
        if (d.success) {
            show(`<p class="door-ok">${T('Die Tür wird jetzt geöffnet. Drücken Sie gegen die Tür. Falls sie nicht aufgeht, warten Sie bitte eine Minute und versuchen es erneut.')}</p>
                <button type="button" class="btn btn-ghost btn-block" id="door-again" style="margin-top:1rem">${T('Zurück')}</button>`);
            $('#door-again').addEventListener('click', refresh);
            return;
        }
        if (d.reason) return refresh();
        show(`<p class="door-msg">${esc(TX(d.error) || T('Das hat nicht geklappt. Bitte rufen Sie uns an.'))}</p>`);
    }

    // Static texts and the phone line in the current language
    function relabel() {
        I18N.apply();
        pick.redraw();
        if (phone) {
            $('#door-contact').innerHTML = `${T('Probleme? Rufen Sie uns an:')} <a href="tel:${esc(phone.replace(/\s+/g, ''))}">${esc(phone)}</a>`;
            $('#door-contact').hidden = false;
        }
    }
    const pick = I18N.picker(() => {
        relabel();
        if (last && !$('#door-yes')) draw(last);
    });
    $('.mast-nav').prepend(pick);
    I18N.apply();

    $('#login-form').addEventListener('submit', async e => {
        e.preventDefault();
        const f = e.target;
        const err = $('#login-error');
        const d = await api('login', { code: f.code.value.trim(), arrival: f.arrival.value });
        if (!d.success) { err.textContent = TX(d.error) || T('Anmeldung fehlgeschlagen.'); err.hidden = false; return; }
        err.hidden = true;
        f.reset();
        refresh();
    });

    (async () => {
        try {
            const info = await api('info');
            if (info.success) {
                $('#brand').textContent = info.title;
                const c = info.contact;
                if (c && c.phone) { phone = c.phone; relabel(); }
            }
        } catch (e) { /* page still usable */ }
        refresh().catch(() => show(`<p class="door-msg">${T('Gerade nicht erreichbar. Bitte rufen Sie uns an.')}</p>`));
    })();
})();
