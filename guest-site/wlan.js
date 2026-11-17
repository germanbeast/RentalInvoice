/* Ferienwohnung – Gäste-Webseite · WLAN-Anmeldeseite (openNDS auf dem Gäste-Router leitet hierher) */
(() => {
    'use strict';

    const $ = s => document.querySelector(s);
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const api = (url, body) => fetch(`api/wlan/${url}`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    }).then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) })).catch(() => ({ status: 0 }));

    const params = new URLSearchParams(location.search);
    // The router sends "fas" (base64, '+' may arrive as a space); "status" when the device is already online
    const fas = (params.get('fas') || '').replace(/ /g, '+');
    const status = params.has('status');
    const preview = params.has('preview');
    const box = $('#box');
    const show = html => { box.innerHTML = html; };
    let site = { title: 'Ferienwohnung', ssid: 'Gäste-WLAN', maxDevices: 5, phone: '' };

    const ICON_OK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>';
    const untilText = iso => {
        if (!iso) return '';
        const d = new Date(iso);
        return `${d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}, ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`;
    };

    function contact() {
        const c = $('#contact');
        if (!site.phone) { c.hidden = true; return; }
        const tel = site.phone.replace(/[^\d+]/g, '');
        c.innerHTML = `Fragen oder kein Code zur Hand? Rufen Sie uns an: <a href="tel:${esc(tel)}">${esc(site.phone)}</a>`;
        c.hidden = false;
    }

    function form({ session, error } = {}) {
        show(`
            <h1>Willkommen im <em>WLAN</em></h1>
            <p class="wl-lead">Schön, dass Sie da sind. Mit Ihrem persönlichen Zugangscode sind Sie in wenigen Sekunden online.</p>
            <div class="wl-card">
                ${error ? `<div class="wl-msg" role="alert">${esc(error)}</div>` : ''}
                ${session ? `<button type="button" class="btn btn-dark wl-go" id="as-session">Als ${esc(session.name)} verbinden</button>
                    <div class="wl-or">oder mit Code</div>` : ''}
                <form id="code-form" novalidate>
                    <label>Zugangscode
                        <input class="wl-code" id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="7"
                            autocomplete="one-time-code" placeholder="000000" aria-describedby="where" required>
                    </label>
                    <button type="submit" class="btn ${session ? 'btn-ghost' : 'btn-dark'} wl-go">Verbinden</button>
                </form>
                <div class="wl-where" id="where">Ihren 6-stelligen Code finden Sie
                    <ul><li>auf „Meine Buchung“ unter WLAN,</li><li>in Ihrer Nachricht zum Anreisetag,</li><li>auf dem Fernseher in der Wohnung.</li></ul>
                </div>
            </div>
            <details class="wl-terms"><summary>Hinweise zur Nutzung</summary>
                <ul>
                    <li>Das WLAN ist für die Gäste dieser Buchung, höchstens ${esc(site.maxDevices)} Geräte.</li>
                    <li>Bitte nutzen Sie es nur im Rahmen der Gesetze: keine Tauschbörsen für urheberrechtlich geschützte Inhalte, keine strafbaren Inhalte.</li>
                    <li>Die Verbindung ins Internet ist verschlüsselt wie zu Hause; Ihre Geräte sind vom Heimnetz des Gastgebers getrennt.</li>
                    <li>Der Zugang endet automatisch am Abreisetag nach dem Check-out.</li>
                </ul>
            </details>`);
        const input = $('#code');
        input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); });
        $('#code-form').addEventListener('submit', e => {
            e.preventDefault();
            const code = input.value.replace(/\D/g, '');
            if (code.length !== 6) { input.focus(); input.setAttribute('aria-invalid', 'true'); return; }
            login({ code });
        });
        const s = $('#as-session');
        if (s) s.addEventListener('click', () => login({ useSession: true }));
        else setTimeout(() => input.focus(), 50);
    }

    function waiting(text) {
        show(`<div class="wl-wait"><div class="wl-spin" aria-hidden="true"></div>
            <h1 style="font-size:2.4rem">${esc(text || 'Sie werden verbunden …')}</h1>
            <p class="wl-lead" id="wait-note">Das dauert meist nur ein paar Sekunden.</p></div>`);
    }

    function online({ name, until, owner } = {}) {
        $('#kicker').textContent = 'Verbunden';
        show(`<div class="wl-ok">${ICON_OK}</div>
            <h1>${name ? `Viel Spaß, <em>${esc(name)}</em>!` : 'Sie sind <em>online</em>.'}</h1>
            <p class="wl-lead">${owner ? 'Gastgeber-Zugang für eine Woche.' : 'Ihr Gerät ist jetzt mit dem Internet verbunden. Dieses Fenster können Sie schließen.'}</p>
            <div class="wl-facts">
                <div><span>Netzwerk</span><strong>${esc(site.ssid)}</strong></div>
                <div><span>Online bis</span><strong>${esc(untilText(until) || 'Abreise')}</strong></div>
            </div>
            <div class="wl-actions">
                <a class="btn btn-dark wl-go" href="meine-buchung">Zu Meine Buchung</a>
                <a class="btn btn-ghost wl-go" href="./">Zur Webseite der Ferienwohnung</a>
            </div>`);
    }

    function message(title, text) {
        show(`<h1>${title}</h1><p class="wl-lead">${text}</p>`);
    }

    async function waitFor(wait, info) {
        waiting(info.auto ? `Willkommen zurück${info.name ? `, ${info.name}` : ''} …` : '');
        const started = Date.now();
        for (;;) {
            await new Promise(r => setTimeout(r, 1000));
            const d = await api('status', { wait });
            if (d.online) return online(info);
            const secs = (Date.now() - started) / 1000;
            const note = $('#wait-note');
            if (note && secs > 12) note.textContent = 'Der Router übernimmt die Anmeldung, einen Moment noch …';
            if (secs > 60) {
                return form({ error: d.router != null && d.router > 120
                    ? 'Der WLAN-Router antwortet gerade nicht. Bitte versuchen Sie es in ein paar Minuten noch einmal oder rufen Sie uns an.'
                    : 'Die Anmeldung hat zu lange gedauert. Bitte noch einmal versuchen; hilft das nicht, WLAN am Handy kurz aus- und wieder einschalten.' });
            }
        }
    }

    async function login(body) {
        waiting();
        const d = await api('login', { fas, preview, ...body });
        if (d.success && d.preview) { await new Promise(r => setTimeout(r, 1200)); return online(d); }
        if (d.success && d.wait) return waitFor(d.wait, d);
        form({ error: d.error || 'Gerade keine Verbindung zum Server. Bitte noch einmal versuchen.' });
    }

    async function start() {
        const d = await api('hello', { fas, status, preview });
        if (d.site) site = d.site;
        $('#brand').textContent = site.title;
        document.title = `WLAN · ${site.title}`;
        contact();
        if (preview) { $('#preview').hidden = false; return form({ session: null }); }
        if (!d.success) return message('Kurz <em>warten</em>', 'Der Server ist gerade nicht erreichbar. Bitte laden Sie die Seite in einer Minute neu.');
        if (status || d.online) return online({});
        if (d.invalid) {
            return message(`Gäste-<em>WLAN</em>`, `Diese Seite öffnet sich von selbst, wenn Sie sich mit dem WLAN <b>${esc(site.ssid)}</b> verbinden. Erscheint sie nicht, öffnen Sie im Browser einfach <b>http://neverssl.com</b>.`);
        }
        if (!d.enabled) return message('Gerade <em>ausgeschaltet</em>', 'Die WLAN-Anmeldung ist im Moment nicht aktiv. Bitte melden Sie sich bei uns.');
        if (d.auto && d.wait) return waitFor(d.wait, d);
        form({ session: d.session });
    }

    start();
})();
