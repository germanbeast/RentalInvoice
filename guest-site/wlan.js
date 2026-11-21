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
    const I18N = window.GI18N;
    const T = I18N.T, TX = I18N.TX, L = () => I18N.locale();
    // The page is redrawn in the new language with the last view
    let view = null;
    const remember = (fn, arg) => { view = [fn, arg]; };

    const ICON_OK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7"/></svg>';
    const untilText = iso => {
        if (!iso) return '';
        const d = new Date(iso);
        return `${d.toLocaleDateString(L(), { weekday: 'short', day: '2-digit', month: '2-digit' })}, ${d.toLocaleTimeString(L(), { hour: '2-digit', minute: '2-digit' })}${I18N.lang === 'de' ? ' Uhr' : ''}`;
    };

    function contact() {
        const c = $('#contact');
        if (!site.phone) { c.hidden = true; return; }
        const tel = site.phone.replace(/[^\d+]/g, '');
        c.innerHTML = `${T('Fragen oder kein Code zur Hand? Rufen Sie uns an:')} <a href="tel:${esc(tel)}">${esc(site.phone)}</a>`;
        c.hidden = false;
    }

    function form({ session, error } = {}) {
        remember(form, { session, error });
        $('#kicker').textContent = T('Gäste-WLAN');
        show(`
            <h1>${T('Willkommen im <em>WLAN</em>')}</h1>
            <p class="wl-lead">${T('Schön, dass Sie da sind. Mit Ihrem persönlichen Zugangscode sind Sie in wenigen Sekunden online.')}</p>
            <div class="wl-card">
                ${error ? `<div class="wl-msg" role="alert">${esc(TX(error))}</div>` : ''}
                ${session ? `<button type="button" class="btn btn-dark wl-go" id="as-session">${esc(T('Als {name} verbinden', { name: session.name }))}</button>
                    <div class="wl-or">${T('oder mit Code')}</div>` : ''}
                <form id="code-form" novalidate>
                    <label>${T('Zugangscode')}
                        <input class="wl-code" id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="9"
                            autocomplete="one-time-code" placeholder="000000" aria-describedby="where" required>
                    </label>
                    <button type="submit" class="btn ${session ? 'btn-ghost' : 'btn-dark'} wl-go">${T('Verbinden')}</button>
                </form>
                <div class="wl-where" id="where">${T('Ihren 6-stelligen Code finden Sie')}
                    <ul><li>${T('auf „Meine Buchung“ unter WLAN,')}</li><li>${T('in Ihrer Nachricht zum Anreisetag,')}</li><li>${T('auf dem Fernseher in der Wohnung.')}</li></ul>
                </div>
            </div>
            <details class="wl-terms"><summary>${T('Hinweise zur Nutzung')}</summary>
                <ul>
                    <li>${esc(T('Das WLAN ist für die Gäste dieser Buchung, höchstens {n} Geräte.', { n: site.maxDevices }))}</li>
                    <li>${T('Bitte nutzen Sie es nur im Rahmen der Gesetze: keine Tauschbörsen für urheberrechtlich geschützte Inhalte, keine strafbaren Inhalte.')}</li>
                    <li>${T('Die Verbindung ins Internet ist verschlüsselt wie zu Hause; Ihre Geräte sind vom Heimnetz des Gastgebers getrennt.')}</li>
                    <li>${T('Der Zugang endet automatisch am Abreisetag nach dem Check-out.')}</li>
                </ul>
            </details>`);
        const input = $('#code');
        // 6 digits per booking, 8 for the host's own code (narrower spacing so it fits)
        input.addEventListener('input', () => {
            input.value = input.value.replace(/\D/g, '').slice(0, 8);
            input.classList.toggle('long', input.value.length > 6);
        });
        $('#code-form').addEventListener('submit', e => {
            e.preventDefault();
            const code = input.value.replace(/\D/g, '');
            if (code.length !== 6 && code.length !== 8) { input.focus(); input.setAttribute('aria-invalid', 'true'); return; }
            login({ code });
        });
        const s = $('#as-session');
        if (s) s.addEventListener('click', () => login({ useSession: true }));
        else setTimeout(() => input.focus(), 50);
    }

    function waiting(text) {
        show(`<div class="wl-wait"><div class="wl-spin" aria-hidden="true"></div>
            <h1 style="font-size:2.4rem">${esc(text || T('Sie werden verbunden …'))}</h1>
            <p class="wl-lead" id="wait-note">${T('Das dauert meist nur ein paar Sekunden.')}</p></div>`);
    }

    const dateText = ymd => new Date(ymd + 'T12:00:00').toLocaleDateString(L(), { weekday: 'short', day: '2-digit', month: '2-digit' });
    const ICON_WA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.6a8.2 8.2 0 0 1-12.1 7.2L4 20l1.3-3.8A8.2 8.2 0 1 1 20 11.6z"/><path d="M9.2 8.6c.2-.4.5-.4.7-.4h.5c.2 0 .4.1.5.4l.6 1.4c.1.2 0 .4-.1.6l-.4.5c-.1.1-.1.3 0 .5.5.9 1.3 1.6 2.2 2.1.2.1.4.1.5 0l.5-.5c.2-.2.4-.2.6-.1l1.4.6c.3.1.4.3.4.5v.5c0 .3-.1.6-.4.7-.6.4-1.4.5-2.1.3-2.4-.7-4.3-2.6-5-5-.2-.7-.1-1.5.3-2.1z"/></svg>';
    const ICON_PHONE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h3.5l1.5 4-2 1.3a10 10 0 0 0 4.7 4.7L14 12l4 1.5V17a2 2 0 0 1-2 2A13 13 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>';

    function online(info = {}) {
        const { name, until, owner, welcome } = info;
        remember(online, info);
        $('#kicker').textContent = T('Verbunden');
        const w = welcome || null;
        const tel = w && w.phone ? w.phone.replace(/[^\d+]/g, '') : '';
        show(`<div class="wl-ok">${ICON_OK}</div>
            <h1>${name ? T('Viel Spaß, <em>{name}</em>!', { name: esc(name) }) : T('Sie sind <em>online</em>.')}</h1>
            <p class="wl-lead">${T(owner ? 'Gastgeber-Zugang für eine Woche.' : 'Sie sind jetzt mit dem Internet verbunden. Hier noch das Wichtigste für Ihren Aufenthalt.')}</p>
            <div class="wl-facts${w && w.checkout ? ' three' : ''}">
                <div><span>${T('Netzwerk')}</span><strong>${esc(site.ssid)}</strong></div>
                <div><span>${T('Online bis')}</span><strong>${esc(untilText(until) || T('Abreise'))}</strong></div>
                ${w && w.checkout ? `<div><span>${T('Check-out')}</span><strong>${esc(dateText(w.checkout))}${w.checkoutTime ? `, ${esc(w.checkoutTime)}${I18N.lang === 'de' ? ' Uhr' : ''}` : ''}</strong></div>` : ''}
            </div>
            ${w && (w.whatsapp || tel) ? `<div class="wl-talk">
                ${w.whatsapp ? `<a class="btn btn-dark" href="${esc(w.whatsapp)}" target="_blank" rel="noopener">${ICON_WA}${T('WhatsApp an uns')}</a>` : ''}
                ${tel ? `<a class="btn btn-ghost" href="tel:${esc(tel)}">${ICON_PHONE}${esc(w.phone)}</a>` : ''}
            </div>` : ''}
            <div id="wl-live"></div>
            ${w && w.rules ? `<details class="wl-rules"><summary>${T('Hausregeln')}</summary><div class="prose">${esc(w.rules)}</div></details>` : ''}
            <div class="wl-actions">
                <a class="btn btn-dark wl-go" href="meine-buchung">${T('Zu Meine Buchung')}</a>
                <a class="btn btn-ghost wl-go" href="./">${T('Zur Webseite der Ferienwohnung')}</a>
            </div>`);
        if (w) {
            $('#contact').hidden = true;
            loadLive();
        }
    }

    // Live tips (weather, open now, events), like on "Meine Buchung", in short
    async function loadLive() {
        let d = null;
        try { d = await fetch('api/live?for=app', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.json()); } catch (e) { d = null; }
        const box = $('#wl-live');
        if (!box || !d || !d.success || !d.enabled) return;
        const icon = k => (window.liveWeatherIcon ? window.liveWeatherIcon(k, 'wx') : '');
        const parts = [];
        if (d.weather && d.weather.now) {
            const n = d.weather.now, t = d.weather.days && d.weather.days[0];
            parts.push(`<div class="wl-live-wx">${icon(n.icon)}<div><strong>${esc(n.temp)}°</strong> ${esc(TX(n.label))}${d.place ? esc(T(' in {place}', { place: d.place })) : ''}
                ${t ? `<small>${esc(T('Heute {min}° bis {max}°', { min: t.min, max: t.max }))}${t.rain != null ? ` · ${esc(T('Regenrisiko {n} %', { n: t.rain }))}` : ''}</small>` : ''}</div></div>`);
        }
        const places = (d.places || []).filter(p => p.open !== null).sort((a, b) => (b.open === true) - (a.open === true)).slice(0, 4);
        if (places.length) {
            parts.push(`<h3>${T('Jetzt geöffnet?')}</h3><ul class="wl-live-list">${places.map(p => `<li><span>${esc(p.name)}${p.distance ? ` <small>${esc(p.distance)}</small>` : ''}</span>
                <em class="${p.open ? (p.soon ? 'soon' : 'open') : 'closed'}">${esc(TX(p.state) || T(p.open ? 'geöffnet' : 'geschlossen'))}</em></li>`).join('')}</ul>`);
        }
        const ev = (d.events || []).slice(0, 3);
        if (ev.length) {
            parts.push(`<h3>${T('Veranstaltungen')}</h3><ul class="wl-live-list">${ev.map(e => `<li><span>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}</span>
                <small>${esc(dateText(e.date))}${e.time ? `, ${esc(e.time)}${I18N.lang === 'de' ? ' Uhr' : ''}` : ''}</small></li>`).join('')}</ul>`);
        }
        if (parts.length) box.innerHTML = `<section class="wl-live"><span class="wl-live-kicker">${T('Live-Tipps')}</span>${parts.join('')}<a class="wl-more" href="meine-buchung">${T('Mehr auf Meine Buchung')}</a></section>`;
    }

    // title/text are German keys (may contain markup), vars are escaped
    function message(title, text, vars) {
        remember(() => message(title, text, vars));
        show(`<h1>${T(title)}</h1><p class="wl-lead">${T(text, vars)}</p>`);
    }

    async function waitFor(wait, info) {
        if (info.lang && !I18N.hasOwnChoice()) { I18N.choose(info.lang); drawPicker(); }
        waiting(info.auto ? (info.name ? T('Willkommen zurück, {name} …', { name: info.name }) : T('Willkommen zurück …')) : '');
        const started = Date.now();
        for (;;) {
            await new Promise(r => setTimeout(r, 1000));
            const d = await api('status', { wait });
            if (d.online) return online(info);
            const secs = (Date.now() - started) / 1000;
            const note = $('#wait-note');
            if (note && secs > 12) note.textContent = T('Der Router übernimmt die Anmeldung, einen Moment noch …');
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
        document.title = `${T('WLAN')} · ${site.title}`;
        if (d.session && d.session.lang && !I18N.hasOwnChoice()) { I18N.choose(d.session.lang); drawPicker(); }
        contact();
        if (preview) { $('#preview').hidden = false; return form({ session: null }); }
        if (!d.success) return message('Kurz <em>warten</em>', 'Der Server ist gerade nicht erreichbar. Bitte laden Sie die Seite in einer Minute neu.');
        if (status || d.online) return online({});
        if (d.invalid) {
            return message('Gäste-<em>WLAN</em>', 'Diese Seite öffnet sich von selbst, wenn Sie sich mit dem WLAN <b>{ssid}</b> verbinden. Erscheint sie nicht, öffnen Sie im Browser einfach <b>http://neverssl.com</b>.', { ssid: esc(site.ssid) });
        }
        if (!d.enabled) return message('Gerade <em>ausgeschaltet</em>', 'Die WLAN-Anmeldung ist im Moment nicht aktiv. Bitte melden Sie sich bei uns.');
        if (d.auto && d.wait) return waitFor(d.wait, d);
        form({ session: d.session });
    }

    // Language switcher in the header: redraws the current view
    const pick = I18N.picker(() => {
        I18N.apply();
        document.title = `${T('WLAN')} · ${site.title}`;
        contact();
        if (view) view[0](view[1]);
    });
    function drawPicker() { pick.redraw(); I18N.apply(); }
    $('.masthead').appendChild(pick);
    I18N.apply();

    start();
})();
