/* Ferienwohnung – Gäste-Webseite · Notfall-Öffnen (QR-Code an der Tür) */
(() => {
    'use strict';

    const $ = s => document.querySelector(s);
    const api = (url, body) => fetch(`api/${url}`, body === undefined ? { credentials: 'same-origin' } : {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // "YYYY-MM-DD HH:MM" -> "Fr., 31.10.2026, 15:00 Uhr"
    const when = s => {
        const [d, t] = String(s || '').split(' ');
        const day = new Date(d + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
        return `${day}, ${t} Uhr`;
    };

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

    async function refresh() {
        $('#login-box').hidden = true;
        const d = await api('notfall/status', { key });
        if (d.status === 429) return show(`<p class="door-msg">${esc(d.error || 'Zu viele Versuche. Bitte später erneut versuchen.')}</p>`);
        if (!d.success) return show('<p class="door-msg">Gerade nicht erreichbar. Bitte rufen Sie uns an.</p>');
        if (d.allowed) return showOpen();
        if (d.reason === 'login') {
            show('');
            $('#login-box').hidden = false;
            return;
        }
        if (d.reason === 'early') {
            return show(`<p class="door-msg">Das Öffnen ist ab Ihrem Anreisetag zur Check-in-Zeit möglich: <strong>${esc(when(d.from))}</strong>.</p>`);
        }
        show(`<p class="door-msg">${esc(REASONS[d.reason] || REASONS.disabled)}</p>`);
    }

    function showOpen() {
        show(`<p>Ist das Tastenfeld an der Tür ausgefallen? Dann können Sie die Tür hier öffnen.</p>
            <button type="button" class="btn btn-dark door-open" id="door-open">Tür öffnen</button>`);
        $('#door-open').addEventListener('click', () => {
            show(`<p><strong>Tür wirklich öffnen?</strong> Stellen Sie sich direkt vor die Tür. Sie springt nach wenigen Sekunden auf.</p>
                <div class="door-confirm">
                    <button type="button" class="btn btn-dark door-open" id="door-yes">Ja, jetzt öffnen</button>
                    <button type="button" class="btn btn-ghost" id="door-no">Abbrechen</button>
                </div>`);
            $('#door-no').addEventListener('click', showOpen);
            $('#door-yes').addEventListener('click', openDoor);
        });
    }

    async function openDoor() {
        show('<p>Die Tür wird geöffnet …</p>');
        const d = await api('notfall/open', { key });
        if (d.success) {
            show(`<p class="door-ok">Die Tür wird jetzt geöffnet. Drücken Sie gegen die Tür. Falls sie nicht aufgeht, warten Sie bitte eine Minute und versuchen es erneut.</p>
                <button type="button" class="btn btn-ghost btn-block" id="door-again" style="margin-top:1rem">Zurück</button>`);
            $('#door-again').addEventListener('click', refresh);
            return;
        }
        if (d.reason) return refresh();
        show(`<p class="door-msg">${esc(d.error || 'Das hat nicht geklappt. Bitte rufen Sie uns an.')}</p>`);
    }

    $('#login-form').addEventListener('submit', async e => {
        e.preventDefault();
        const f = e.target;
        const err = $('#login-error');
        const d = await api('login', { code: f.code.value.trim(), arrival: f.arrival.value });
        if (!d.success) { err.textContent = d.error || 'Anmeldung fehlgeschlagen.'; err.hidden = false; return; }
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
                if (c && c.phone) {
                    $('#door-contact').innerHTML = `Probleme? Rufen Sie uns an: <a href="tel:${esc(c.phone.replace(/\s+/g, ''))}">${esc(c.phone)}</a>`;
                    $('#door-contact').hidden = false;
                }
            }
        } catch (e) { /* page still usable */ }
        refresh().catch(() => show('<p class="door-msg">Gerade nicht erreichbar. Bitte rufen Sie uns an.</p>'));
    })();
})();
