/* Ferienwohnung – Gäste-Webseite · Meine Buchung (Login + Status) */
(() => {
    'use strict';

    const $ = s => document.querySelector(s);
    const $$ = s => [...document.querySelectorAll(s)];
    const api = (url, body) => fetch(`api/${url}`, body === undefined ? { credentials: 'same-origin' } : {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const I18N = window.GI18N;
    const T = I18N.T, TX = I18N.TX;
    const L = () => I18N.locale();
    const fmt = ymd => ymd ? new Date(ymd + 'T12:00:00').toLocaleDateString(L(), { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '–';
    const money = n => Number(n).toLocaleString(L(), { style: 'currency', currency: 'EUR' });
    const nightsTxt = n => `${n} ${n === 1 ? T('Nacht') : T('Nächte')}`;
    // "ab 15:00 Uhr" in the guest's language ("from 15:00")
    const at = (key, t) => T(key, { t }).replace(/\s+$/, '');
    const showError = (el, msg) => { el.textContent = msg; el.hidden = !msg; };

    let info = null;
    // Code of a request that was just sent from the start page
    const newCodeParam = new URLSearchParams(location.search).get('neu');

    async function loadInfo() {
        const d = await api('info');
        if (!d.success) return;
        info = d;
        document.title = `${T('Meine Buchung')} · ${d.title}`;
        ['#brand', '#footer-title'].forEach(s => { $(s).textContent = d.title; });
        if (d.photos.length) {
            $('#account-media').innerHTML = `<img src="${esc(d.photos[0])}" alt="">`;
            $('#app-hero-media').innerHTML = `<img src="${esc(d.photos[0])}" alt="">`;
        }
        $('#app-brand').textContent = d.title;
        $('#app-menu-title').textContent = d.title;
        if (d.contact && (d.contact.phone || d.contact.email)) {
            $('#footer-contact').innerHTML = [
                d.contact.name ? esc(d.contact.name) : '',
                d.contact.phone ? `<a href="tel:${esc(d.contact.phone.replace(/\s+/g, ''))}">${esc(d.contact.phone)}</a>` : '',
                d.contact.email ? `<a href="mailto:${esc(d.contact.email)}">${esc(d.contact.email)}</a>` : ''
            ].filter(Boolean).join(' · ');
            if (d.contact.phone) $('#app-menu-contact').innerHTML = `<a href="tel:${esc(d.contact.phone.replace(/\s+/g, ''))}">${esc(T('Anrufen: {phone}', { phone: d.contact.phone }))}</a>`;
        }
    }

    // ------------------------------------------------------------------
    // Guest login & status
    // ------------------------------------------------------------------
    $('#mast-logout').addEventListener('click', logout);
    $('#app-logout').addEventListener('click', logout);
    $('#app-menu-btn').addEventListener('click', () => $('#app-menu').showModal());
    $('#app-menu').addEventListener('click', e => { if (e.target === e.currentTarget || e.target.closest('[data-close]') || e.target.closest('a')) e.currentTarget.close(); });

    $('#login-form').addEventListener('submit', async e => {
        e.preventDefault();
        const f = e.target;
        const err = $('#login-error');
        const d = await api('login', { code: f.code.value.trim(), arrival: f.arrival.value });
        if (!d.success) return showError(err, TX(d.error) || T('Anmeldung fehlgeschlagen.'));
        showError(err, '');
        f.reset();
        loadMe();
    });

    // ------------------------------------------------------------------
    // Guest app (after login): hero, cards, tab bar
    // ------------------------------------------------------------------
    const STATUS = {
        pending: ['pending', 'Anfrage wird geprüft'],
        confirmed: ['confirmed', 'Bestätigt'],
        declined: ['declined', 'Leider abgelehnt'],
        cancelled: ['cancelled', 'Storniert'],
        gone: ['gone', 'Nicht mehr vorhanden']
        // labels go through T() where they are shown
    };
    const ICON = {
        home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="m9 14 2 2 4-4"/></svg>',
        prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>',
        next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
        chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
        tick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
        plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
        key: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2"/></svg>'
    };
    const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>';

    let me = null;       // booking status
    let live = null;     // Live-Tipps: weather, opening hours, events (api/live)
    let liveFor = '';
    let ms = null;       // Meldeschein state
    let msEditing = false;
    let newCodeShown = null;
    const tabParam = new URLSearchParams(location.search).get('tab');
    let tab = tabParam === 'meldeschein' ? 'guests' : tabParam === 'ankunft' ? 'arrival' : (() => { try { return sessionStorage.getItem('gapp-tab') || 'stay'; } catch (e) { return 'stay'; } })();

    const isStay = s => s && s.kind === 'booking' && s.status === 'confirmed';
    const tabsFor = s => {
        const t = ['stay'];
        if (isStay(s) && s.state !== 'past') t.unshift('guests');
        if (isStay(s) && s.state !== 'past' && s.arrival) t.push('arrival');
        if (s.status === 'confirmed' && s.state !== 'past') t.push('az');
        if ((info && (info.tips.length || info.address || info.directions || info.location)) || liveHas()) t.push('area');
        return t;
    };

    async function logout() {
        await api('logout', {});
        try { sessionStorage.removeItem('gapp-tab'); } catch (e) { /* ignore */ }
        if ($('#app-menu').open) $('#app-menu').close();
        loadMe();
    }

    async function loadMe(newCode) {
        const d = await api('me');
        const signed = !!d.success;
        document.body.classList.toggle('signed-in', signed);
        $('#app').hidden = !signed;
        $('#mast-home').hidden = signed;
        $('#mast-logout').hidden = !signed;
        if (!signed) {
            $('#login-box').hidden = false;
            return;
        }
        $('#login-box').hidden = true;
        me = d.status;
        // Language of the booking (host's choice, guest's choice or guessed) unless the guest picked one on this device
        if (I18N.choose(me.lang)) translateStatic();
        if (newCode) newCodeShown = newCode;
        ms = null;
        if (isStay(me) && me.state !== 'past') {
            const m = await api('me/meldeschein').catch(() => null);
            if (m && m.success && m.enabled) ms = m;
        }
        renderApp();
        loadLive(me);
    }

    // Live-Tipps load after the app is shown; only the Umgebung tab is redrawn (forms elsewhere keep their input)
    const liveHas = () => !!(live && (live.weather || live.places.length || live.events.length));
    async function loadLive(s) {
        const q = s && s.checkin && s.checkout && s.state !== 'past' ? `&from=${encodeURIComponent(s.checkin)}&to=${encodeURIComponent(s.checkout)}` : '';
        liveFor = q;
        const d = await api(`live?for=app${q}`).catch(() => null);
        if (liveFor !== q) return;
        live = d && d.success && d.enabled ? d : null;
        if (!me || !document.body.classList.contains('signed-in')) return;
        const avail = tabsFor(me);
        $$('#app-tabs [data-tab]').forEach(b => { b.hidden = !avail.includes(b.dataset.tab); });
        $('[data-pane="area"]').innerHTML = avail.includes('area') ? renderArea(me) : '';
    }

    function stateLine(s) {
        if (s.status === 'pending') return T('Wir prüfen Ihre Anfrage und melden uns.');
        if (s.status !== 'confirmed') return '';
        if (s.state === 'inhouse') return T('Schön, dass Sie da sind!');
        if (s.state === 'departing') return T('Heute ist Ihr Abreisetag. Gute Heimreise!');
        if (s.state === 'past') return T('Danke für Ihren Besuch!');
        if (s.daysUntil === 0) return T('Heute ist Ihr Anreisetag.');
        return s.daysUntil === 1 ? T('Morgen geht es los!') : T('Noch {n} Tage bis zur Anreise.', { n: s.daysUntil });
    }

    function renderApp() {
        const s = me;
        const first = (s.name || '').split(/\s+/)[0];
        $('#app-hello').textContent = first ? T('Willkommen, {name}', { name: first }) : T('Willkommen');
        $('#app-state').textContent = s.status === 'gone' ? '' : `${fmtShort(s.checkin)} – ${fmtShort(s.checkout)} · ${stateLine(s)}`.replace(/ · $/, '');
        const avail = tabsFor(s);
        if (!avail.includes(tab)) tab = 'stay';
        $$('#app-tabs [data-tab]').forEach(b => { b.hidden = !avail.includes(b.dataset.tab); });
        $('#tab-guests-dot').hidden = !(ms && !ms.form);
        $('[data-pane="stay"]').innerHTML = renderStay(s);
        if (s.chat && s.chat.url && !$('#app-menu-wa')) {
            const a = document.createElement('a');
            a.id = 'app-menu-wa'; a.href = s.chat.url; a.target = '_blank'; a.rel = 'noopener';
            a.dataset.t = '';
            a.textContent = 'Per WhatsApp schreiben';
            $('#app-menu-contact').after(a);
            I18N.apply(a.parentNode);
        }
        $('[data-pane="guests"]').innerHTML = avail.includes('guests') ? renderGuests(s) : '';
        $('[data-pane="arrival"]').innerHTML = avail.includes('arrival') ? renderArrival(s) : '';
        $('[data-pane="az"]').innerHTML = avail.includes('az') ? renderAZ(s) : '';
        $('[data-pane="area"]').innerHTML = avail.includes('area') ? renderArea(s) : '';
        bindApp();
        showTab(tab, false);
    }

    function showTab(t, scroll = true) {
        tab = t;
        try { sessionStorage.setItem('gapp-tab', t); } catch (e) { /* ignore */ }
        $$('#app-tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
        $$('.gapp-pane').forEach(p => { p.hidden = p.dataset.pane !== t; });
        if (scroll) {
            const top = $('#app-tabs').getBoundingClientRect().top + scrollY;
            const target = matchMedia('(min-width: 900px)').matches ? top : $('.gapp-main').getBoundingClientRect().top + scrollY - 12;
            if (scrollY > target) scrollTo({ top: target, behavior: 'smooth' });
        }
    }
    $$('#app-tabs [data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

    // ---- Aufenthalt -------------------------------------------------------
    const fmtShort = ymd => ymd ? new Date(ymd + 'T12:00:00').toLocaleDateString(L(), { day: 'numeric', month: 'short' }) : '';

    function carouselHtml(photos) {
        if (!photos.length) return '';
        return `<div class="gcarousel" data-carousel>
            <div class="gcarousel-track">${photos.map((p, i) => `<img src="${esc(p)}" alt="${esc(T('Foto {n} der Wohnung', { n: i + 1 }))}" loading="${i ? 'lazy' : 'eager'}">`).join('')}</div>
            ${photos.length > 1 ? `<button type="button" class="gcarousel-btn prev" aria-label="${esc(T('Vorheriges Foto'))}" disabled>${ICON.prev}</button>
            <button type="button" class="gcarousel-btn next" aria-label="${esc(T('Nächstes Foto'))}">${ICON.next}</button>
            <span class="gcarousel-count">1 / ${photos.length}</span>` : ''}
        </div>`;
    }


    // ---- WLAN card (own password per stay via the FRITZ!Box, or the fixed one) ----
    function wifiCard(s) {
        const w = s.wifi;
        if (!w || !w.name) return '';
        if (w.later) {
            return `<div class="gcard gwifi"><h3>${T('WLAN')}</h3><p class="gwifi-note">${esc(T('Ihr persönliches WLAN-Passwort erscheint hier am Anreisetag ({d}) und gilt ab {t} Uhr.', { d: fmt(w.from), t: w.switchTime || s.checkoutTime }))}</p></div>`;
        }
        if (w.portal) {
            if (w.later) return `<div class="gcard gwifi"><h3>${T('WLAN')}</h3><p class="gwifi-note">${esc(T('Ihr persönlicher WLAN-Zugangscode erscheint hier am Anreisetag ({d}).', { d: fmt(w.from) }))}</p></div>`;
            return `<div class="gcard gwifi"><h3>${T('WLAN')}</h3>
            <div class="gwifi-body">
                ${w.qr ? `<div class="gwifi-qr" role="img" aria-label="${esc(T('QR-Code: mit der Handykamera scannen, um sich mit dem WLAN zu verbinden'))}">${w.qr}</div>` : ''}
                <dl class="guide-dl">
                    <div><dt>${T('Netzwerk')}</dt><dd>${esc(w.name)}</dd></div>
                    ${w.password ? `<div><dt>${T('Passwort')}</dt><dd><span class="mono-ish">${esc(w.password)}</span>
                        <button type="button" class="copy-btn" data-copy="${esc(w.password)}">${COPY_ICON}<span>${T('Kopieren')}</span></button></dd></div>` : ''}
                    ${w.code ? `<div><dt>${T('Zugangscode')}</dt><dd><span class="gwifi-code">${esc(w.code)}</span>
                        <button type="button" class="copy-btn" data-copy="${esc(w.code)}">${COPY_ICON}<span>${T('Kopieren')}</span></button></dd></div>` : ''}
                </dl>
            </div>
            <p class="gwifi-note">${esc(T(w.qr ? 'QR-Code scannen oder mit dem WLAN verbinden, dann öffnet sich die Anmeldeseite: dort den Zugangscode eingeben. Gilt für bis zu {n} Geräte bis zum Check-out am Abreisetag.' : 'Mit dem WLAN verbinden, dann öffnet sich die Anmeldeseite: dort den Zugangscode eingeben. Gilt für bis zu {n} Geräte bis zum Check-out am Abreisetag.', { n: w.maxDevices || 5 }))}</p></div>`;
        }
        const until = w.personal && w.until ? `<p class="gwifi-note">${esc(T('Gilt nur für Ihren Aufenthalt, ab Anreisetag {t} Uhr bis Abreisetag {t} Uhr.', { t: w.switchTime }))}</p>` : '';
        return `<div class="gcard gwifi"><h3>${T('WLAN')}</h3>
            <div class="gwifi-body">
                ${w.qr ? `<div class="gwifi-qr" role="img" aria-label="${esc(T('QR-Code: mit der Handykamera scannen, um sich mit dem WLAN zu verbinden'))}">${w.qr}</div>` : ''}
                <dl class="guide-dl">
                    <div><dt>${T('Netzwerk')}</dt><dd>${esc(w.name)}</dd></div>
                    ${w.password ? `<div><dt>${T('Passwort')}</dt><dd><span class="mono-ish">${esc(w.password)}</span>
                        <button type="button" class="copy-btn" data-copy="${esc(w.password)}">${COPY_ICON}<span>${T('Kopieren')}</span></button></dd></div>` : ''}
                </dl>
            </div>
            ${w.qr ? `<p class="gwifi-note">${T('QR-Code mit der Handykamera scannen, dann verbindet sich das Handy von selbst.')}</p>` : ''}${until}</div>`;
    }

    function renderStay(s) {
        const [cls, labelDe] = STATUS[s.status] || STATUS.pending;
        const label = T(labelDe);
        if (s.status === 'gone') {
            return `<div class="gapp-cols"><div class="gapp-col"><div class="gcard"><h3>${esc(T('Buchung {code}', { code: s.code || '' }))}</h3><span class="badge ${cls}">${label}</span>
                <p style="margin-top:1rem">${T('Diese Buchung finden wir nicht mehr. Möglicherweise wurde sie über das Buchungsportal storniert. Bei Fragen melden Sie sich gerne bei uns.')}</p></div></div>
                <div class="gapp-col">${contactHtml(s.contact, s.chat)}</div></div>`;
        }
        const guests = s.guests ? `${s.guests.adults} ${T('Erw.')}${s.guests.children ? ` + ${s.guests.children} ${T(s.guests.children === 1 ? 'Kind' : 'Kinder')}` : ''}` : '';
        const left = [];
        const right = [];
        if (newCodeShown) {
            left.push(`<div class="code-box" style="margin:0"><div>${T('Vielen Dank für Ihre Anfrage! Ihr Buchungscode:')}<br><strong>${esc(newCodeShown)}</strong></div>
                <small>${T('Bitte notieren. Damit und mit Ihrem Anreisedatum rufen Sie den Status jederzeit ab.')}</small></div>`);
        }
        left.push(`<div class="gcard-pair">
            <div class="gcard gid"><span>${T('Buchungscode')}</span><strong>${esc(s.code || '–')}</strong></div>
            <div class="gcard gid"><span>${T('Gebucht von')}</span>${s.name ? `<strong>${esc(s.name)}</strong>` : `<strong class="muted">${T('Name fehlt')}</strong>`}
                ${s.status !== 'confirmed' ? `<span class="badge ${cls}">${label}</span>` : ''}</div>
        </div>`);
        left.push(`<div class="gsection">
            <div class="gsection-head"><span class="ic">${ICON.home}</span><h3>${s.status === 'confirmed' ? T('Gebucht') : label}</h3><span></span></div>
            <div class="gsection-body">
                ${carouselHtml((info && info.photos) || [])}
                <p class="gstay-title">${esc((info && info.title) || T('Ferienwohnung'))}</p>
                <div class="stay-grid">
                    <div><span>${T('Anreise')}</span><strong>${fmt(s.checkin)}${s.checkinTime ? `, ${esc(T('ab {t}', { t: s.checkinTime }))}` : ''}</strong></div>
                    <div><span>${T('Abreise')}</span><strong>${fmt(s.checkout)}${s.checkoutTime ? `, ${esc(T('bis {t}', { t: s.checkoutTime }))}` : ''}</strong></div>
                    <div><span>${T('Aufenthalt')}</span><strong>${nightsTxt(s.nights)}${guests ? ` · ${guests}` : ''}</strong></div>
                    <div><span>${T('Gebucht über')}</span><strong>${esc(TX(s.source))}</strong></div>
                    ${s.priceTotal ? `<div><span>${T('Preis')}</span><strong>${money(s.priceTotal)}</strong></div>` : ''}
                    ${s.voucher ? `<div><span>${T('Gutschein')}</span><strong>${esc(s.voucher.code)}${s.voucher.discount ? ` · −${money(s.voucher.discount)}` : ''}</strong></div>` : ''}
                </div>
            </div>
        </div>`);

        if (s.status === 'confirmed' && s.state !== 'past') {
            if (s.pin) {
                right.push(`<div class="gcard gpin"><h3>${T('Ihr Türcode')}</h3><div class="pin">${esc(s.pin)}</div>
                    <p>${esc(T('Gültig ab Anreisetag {from} Uhr bis Abreisetag {until} Uhr. Code eingeben und mit der Taste bestätigen.', { from: s.checkinTime, until: s.checkoutTime }))}</p></div>`);
            } else if (s.pinLater) {
                right.push(`<div class="gcard gpin"><h3>${T('Ihr Türcode')}</h3>
                    <p>${esc(T('Ihr persönlicher Türcode erscheint hier {when} vor der Anreise{date}.', pinWhen(s)))}</p></div>`);
            }
        }
        if (s.status === 'confirmed' && s.state !== 'past' && s.wifi && s.daysUntil <= 1) right.push(wifiCard(s));
        if (isStay(s) && s.arrival && (s.state === 'upcoming' || s.state === 'inhouse') && s.daysUntil >= 0 && s.daysUntil <= 1) {
            right.push(`<div class="gcard gcallout"><h3>${T(s.daysUntil === 0 ? 'Heute ist Anreise' : 'Morgen ist Anreise')}</h3>
                <p>${T('Route, Parken und wie Sie die Haustür öffnen, Schritt für Schritt mit Fotos.')}</p>
                <button type="button" class="btn btn-dark btn-small" data-goto="arrival">${T('So kommen Sie hinein')}</button></div>`);
        }
        if (ms) {
            right.push(ms.form
                ? `<div class="gcard gdone"><span class="tick">${ICON.tick}</span><p><strong>${T('Meldeschein ausgefüllt.')}</strong> ${T('Danke!')} <button type="button" class="link-btn" style="margin:0" data-goto="guests">${T('Ansehen')}</button></p></div>`
                : `<div class="gcard gcallout"><h3>${T('Meldeschein ausfüllen')}</h3>
                    <p>${T('Bitte füllen Sie vor der Anreise kurz den Meldeschein aus, für sich und alle Personen, die mit Ihnen übernachten. Das dauert zwei Minuten.')}</p>
                    <button type="button" class="btn btn-dark btn-small" data-goto="guests">${T('Jetzt ausfüllen')}</button></div>`);
        }
        if (s.status === 'pending') {
            right.push(`<div class="gcard"><p>${T('Wir prüfen Ihre Anfrage und melden uns per E-Mail{to}. Auf dieser Seite sehen Sie den aktuellen Stand.', { to: s.details && s.details.email ? T(' an {email}', { email: `<strong>${esc(s.details.email)}</strong>` }) : '' })}</p></div>`);
        }
        if (s.hostNote) right.push(`<div class="gcard"><div class="info-block"><h4>${T('Nachricht von uns')}</h4><div class="note prose">${esc(s.hostNote)}</div></div></div>`);
        if (s.status === 'confirmed') {
            if (s.payment && s.state !== 'past') {
                right.push(`<div class="gcard"><div class="info-block"><h4>${T('Zahlung')}</h4><div class="prose">${esc(s.payment.text)}</div>
                    ${s.payment.bank ? `<div class="note prose" style="margin-top:.6rem">${esc(s.payment.bank)}\n${T('Verwendungszweck')}: ${esc(s.payment.reference)}</div>` : ''}</div></div>`);
            }
            const inv = invoiceHtml(s);
            if (inv) right.push(`<div class="gcard">${inv}</div>`);
        }
        if (s.status === 'declined') right.push(`<div class="gcard"><p>${T('Für den gewünschten Zeitraum können wir Ihnen leider keine Zusage geben. Schauen Sie gerne nach einem anderen Termin im Kalender.')}</p></div>`);
        if (s.status === 'cancelled') right.push(`<div class="gcard"><p>${T('Diese Buchung wurde storniert. Bei Fragen melden Sie sich gerne bei uns.')}</p></div>`);
        right.push(contactHtml(s.contact, s.chat));
        return `<div class="gapp-cols"><div class="gapp-col">${left.join('')}</div><div class="gapp-col">${right.join('')}</div></div>`;
    }

    // ---- Gäste: Meldeschein + Kontakt ------------------------------------
    const COUNTRIES = ['Deutschland', 'Österreich', 'Schweiz', 'Niederlande', 'Belgien', 'Luxemburg', 'Frankreich', 'Dänemark', 'Polen', 'Tschechien',
        'Italien', 'Spanien', 'Portugal', 'Vereinigtes Königreich', 'Irland', 'Schweden', 'Norwegen', 'Finnland', 'Ungarn', 'Rumänien', 'Bulgarien',
        'Kroatien', 'Slowenien', 'Slowakei', 'Griechenland', 'Türkei', 'Ukraine', 'Russland', 'USA', 'Kanada', 'Australien', 'China', 'Indien', 'Japan'];
    const GERMAN = /^(deutsch(land)?|germany|german|de|d|brd|duitsland|duits|niemcy|niemiecka|niemieckie)$/i;
    // Country names are stored in German (for the host's print-out); the list shows them in the guest's language
    const COUNTRY_CODES = { Deutschland: 'DE', 'Österreich': 'AT', Schweiz: 'CH', Niederlande: 'NL', Belgien: 'BE', Luxemburg: 'LU', Frankreich: 'FR', 'Dänemark': 'DK', Polen: 'PL', Tschechien: 'CZ',
        Italien: 'IT', Spanien: 'ES', Portugal: 'PT', 'Vereinigtes Königreich': 'GB', Irland: 'IE', Schweden: 'SE', Norwegen: 'NO', Finnland: 'FI', Ungarn: 'HU', 'Rumänien': 'RO', Bulgarien: 'BG',
        Kroatien: 'HR', Slowenien: 'SI', Slowakei: 'SK', Griechenland: 'GR', 'Türkei': 'TR', Ukraine: 'UA', Russland: 'RU', USA: 'US', Kanada: 'CA', Australien: 'AU', China: 'CN', Indien: 'IN', Japan: 'JP' };
    const countryLabel = c => {
        if (I18N.lang === 'de' || !COUNTRY_CODES[c]) return c;
        try { return new Intl.DisplayNames([L()], { type: 'region' }).of(COUNTRY_CODES[c]) || c; } catch (e) { return c; }
    };
    // Local name typed or picked by the guest -> German name for the form ("Netherlands" -> "Niederlande")
    const countryValue = v => {
        const t = String(v || '').trim();
        if (!t || I18N.lang === 'de') return t;
        const hit = COUNTRIES.find(c => countryLabel(c).toLowerCase() === t.toLowerCase());
        return hit || t;
    };
    const DEFAULT_COUNTRY = { de: 'Deutschland', nl: 'Niederlande', pl: 'Polen', en: '' };
    const isForeign = n => !!String(n || '').trim() && !GERMAN.test(String(n).trim());

    function companionHtml(c, i) {
        c = c || {};
        return `<div class="ms-companion" data-companion>
            <div class="ms-companion-head"><span>${esc(T('Person {n}', { n: i + 2 }))}</span></div>
            <div class="row">
                <label>${T('Vorname(n)')}<input type="text" name="c_firstName" maxlength="80" value="${esc(c.firstName)}" required></label>
                <label>${T('Familienname')}<input type="text" name="c_lastName" maxlength="80" value="${esc(c.lastName)}" required></label>
            </div>
            <label>${T('Geburtsdatum')}<input type="date" name="c_birthDate" value="${esc(c.birthDate)}" required></label>
        </div>`;
    }

    function msFormHtml(m) {
        const f = m.form || {};
        const p = m.prefill || {};
        const nat = f.nationality || DEFAULT_COUNTRY[I18N.lang] || '';
        const foreign = isForeign(nat);
        const persons = m.form ? (f.companions || []).length + 1 : (m.booked || 0);
        return `<form class="ms-form" id="ms-form" novalidate>
            <datalist id="ms-countries">${COUNTRIES.map(c => `<option value="${esc(countryLabel(c))}">`).join('')}</datalist>
            <div class="ms-dates"><div><span>${T('Tag der Ankunft')}</span><strong>${fmt(m.checkin)}</strong></div><div><span>${T('Voraussichtliche Abreise')}</span><strong>${fmt(m.checkout)}</strong></div></div>
            <fieldset><legend>${T('Ihre Angaben')}</legend>
                <div class="row">
                    <label>${T('Vorname(n)')}<input type="text" name="firstName" maxlength="80" autocomplete="given-name" value="${esc(f.firstName || p.firstName)}" required></label>
                    <label>${T('Familienname')}<input type="text" name="lastName" maxlength="80" autocomplete="family-name" value="${esc(f.lastName || p.lastName)}" required></label>
                </div>
                <div class="row">
                    <label>${T('Geburtsdatum')}<input type="date" name="birthDate" autocomplete="bday" value="${esc(f.birthDate)}" required></label>
                    <label>${T('Staatsangehörigkeit')}<input type="text" name="nationality" maxlength="60" list="ms-countries" value="${esc(countryLabel(nat))}" required></label>
                </div>
                <div class="row" data-foreign ${foreign ? '' : 'hidden'}>
                    <label>${T('Ausweisdokument')}<select name="idType">
                        ${['Reisepass', 'Personalausweis', 'Passersatz'].map(t => `<option value="${t}"${f.idType === t ? ' selected' : ''}>${T(t)}</option>`).join('')}</select></label>
                    <label>${T('Dokumentnummer')}<input type="text" name="idNumber" maxlength="30" autocapitalize="characters" value="${esc(f.idNumber)}"></label>
                </div>
                <p class="ms-hint" data-foreign ${foreign ? '' : 'hidden'}>${T('Für Gäste mit ausländischer Staatsangehörigkeit gesetzlich vorgeschrieben. Bitte bringen Sie das Dokument zur Anreise mit.')}</p>
            </fieldset>
            <fieldset><legend>${T('Wohnanschrift')}</legend>
                <label>${T('Straße und Hausnummer')}<input type="text" name="street" maxlength="120" autocomplete="street-address" value="${esc(f.street || p.street)}" required></label>
                <div class="row3">
                    <label>${T('PLZ')}<input type="text" name="zip" maxlength="12" autocomplete="postal-code" value="${esc(f.zip || p.zip)}" required></label>
                    <label>${T('Ort')}<input type="text" name="city" maxlength="80" autocomplete="address-level2" value="${esc(f.city || p.city)}" required></label>
                </div>
                <div class="row">
                    <label>${T('Land')}<input type="text" name="country" maxlength="60" list="ms-countries" autocomplete="country-name" value="${esc(countryLabel(f.country || p.country || DEFAULT_COUNTRY[I18N.lang] || ''))}"></label>
                    <label>${T('Telefon')} <small>${T('optional')}</small><input type="tel" name="phone" maxlength="40" autocomplete="tel" value="${esc(f.phone || (me.details && me.details.phone) || '')}"></label>
                </div>
                <label>${T('E-Mail')} <small>${T('optional')}</small><input type="email" name="email" maxlength="120" autocomplete="email" value="${esc(f.email || (me.details && me.details.email) || '')}"></label>
            </fieldset>
            <fieldset><legend>${T('Weitere Personen')}</legend>
                <label>${T('Wie viele Personen übernachten insgesamt, Sie eingeschlossen?')}
                    <select name="persons" required>
                        ${persons ? '' : `<option value="">${T('Bitte wählen')}</option>`}
                        ${Array.from({ length: m.maxPersons || 8 }, (_, k) => k + 1).map(n => `<option value="${n}"${n === persons ? ' selected' : ''}>${n} ${T(n === 1 ? 'Person (nur ich)' : 'Personen')}</option>`).join('')}
                    </select></label>
                <p class="ms-hint">${T('Jede weitere Person, auch Kinder, braucht einen eigenen Eintrag mit Vorname, Familienname und Geburtsdatum.')}</p>
                <div id="ms-companions">${(f.companions || []).map(companionHtml).join('')}</div>
            </fieldset>
            <fieldset><legend>${T('Bestätigung')}</legend>
                <label class="check"><input type="checkbox" name="confirm" required> ${T('Ich bestätige, dass meine Angaben richtig und vollständig sind.')}</label>
                <p class="ms-hint" style="margin-top:0">${T('Wir nutzen die Angaben nur für die gesetzliche Meldepflicht (§§ 29, 30 Bundesmeldegesetz) und löschen sie nach Ablauf der Aufbewahrungsfrist von einem Jahr nach Abreise.')}</p>
            </fieldset>
            <div class="form-error" id="ms-error" role="alert" hidden></div>
            <div class="ms-actions">
                <button type="submit" class="btn btn-dark">${T('Meldeschein absenden')}</button>
                ${m.form ? `<button type="button" class="btn btn-ghost" id="ms-cancel">${T('Abbrechen')}</button>` : ''}
            </div>
        </form>`;
    }

    function msSummaryHtml(m) {
        const f = m.form;
        const when = f.updatedAt || f.submittedAt;
        const comp = f.companions || [];
        const idTxt = f.idNumber ? `${f.idType ? esc(T(f.idType)) + ' ' : ''}•••• ${esc(f.idNumber.slice(-4))}` : '';
        return `<div class="ms-summary">
            <div class="gdone" style="margin-bottom:1.1rem"><span class="tick">${ICON.tick}</span><p><strong>${T('Vielen Dank, Ihr Meldeschein ist da.')}</strong><br>${when ? esc(T('Übermittelt am {d}.', { d: new Date(when.replace(' ', 'T') + 'Z').toLocaleString(L(), { dateStyle: 'medium', timeStyle: 'short' }) })) : ''}</p></div>
            <dl>
                <dt>${T('Name')}</dt><dd>${esc(f.firstName)} ${esc(f.lastName)}</dd>
                <dt>${T('Geburtsdatum')}</dt><dd>${fmtDate(f.birthDate)}</dd>
                <dt>${T('Staatsangehörigkeit')}</dt><dd>${esc(countryLabel(f.nationality))}</dd>
                <dt>${T('Anschrift')}</dt><dd>${esc(f.street)}, ${esc(f.zip)} ${esc(f.city)}${f.country && !GERMAN.test(f.country) ? `, ${esc(countryLabel(f.country))}` : ''}</dd>
                ${idTxt ? `<dt>${T('Ausweis')}</dt><dd>${idTxt}</dd>` : ''}
                <dt>${T('Weitere Personen')}</dt><dd>${comp.length ? comp.map(c => `${esc(c.firstName)} ${esc(c.lastName)}${c.birthDate ? `, ${esc(T('geb. {d}', { d: fmtDate(c.birthDate) }))}` : ''}`).join('<br>') : T('keine')}</dd>
            </dl>
            <div class="ms-actions">${m.editable ? `<button type="button" class="btn btn-ghost btn-small" id="ms-edit">${T('Angaben ändern')}</button>` : `<p class="ms-hint" style="margin:0">${T('Änderungen ab dem Anreisetag bitte direkt bei uns.')}</p>`}</div>
        </div>`;
    }

    function renderGuests(s) {
        const parts = [];
        if (ms) {
            parts.push(`<div class="gcard"><h3>${T('Meldeschein')}</h3>
                ${ms.form && !msEditing ? msSummaryHtml(ms) : `<p style="color:var(--ink-soft)">${T('Bitte vor der Anreise ausfüllen. Für Gäste mit ausländischer Staatsangehörigkeit ist der Meldeschein gesetzlich vorgeschrieben (§ 29 Bundesmeldegesetz), wir bitten alle Gäste darum.')}</p>${msFormHtml(ms)}`}
            </div>`);
        }
        const dt = s.details || {};
        const opt = `<small>${T('optional')}</small>`;
        const details = `<div class="gcard"><h3>${esc(T(s.needsDetails ? 'Bitte ergänzen Sie Ihren Namen' : 'Kontakt & Ankunft'))}</h3>
            <p style="color:var(--ink-soft)">${T(s.needsDetails ? 'Das Buchungsportal hat uns Ihren Namen nicht übermittelt. Mit dem Meldeschein tragen Sie ihn automatisch ein.' : 'Damit wir Sie erreichen und rechtzeitig da sind.')}</p>
            <form id="details-form" novalidate>
                <label>${T('Vor- und Nachname')}<input type="text" name="name" maxlength="80" value="${esc(dt.name)}" required></label>
                <div class="row">
                    <label>${T('E-Mail')} ${opt}<input type="email" name="email" maxlength="120" value="${esc(dt.email)}"></label>
                    <label>${T('Telefon')} ${opt}<input type="tel" name="phone" maxlength="40" value="${esc(dt.phone)}"></label>
                </div>
                <div class="row">
                    <label>${T('Ankunft ca.')} ${opt}<input type="text" name="arrivalTime" maxlength="40" placeholder="${esc(T('z. B. 17:30 Uhr'))}"></label>
                    <label>${T('Nachricht')} ${opt}<input type="text" name="note" maxlength="1000"></label>
                </div>
                <div class="form-error" id="details-error" hidden></div>
                <button type="submit" class="btn btn-dark btn-small">${T('Speichern')}</button><span class="saved" id="details-saved" hidden>${T('Gespeichert, danke!')}</span>
            </form></div>`;
        return `<div class="gapp-pane-head"><h2>${T('Gäste')}</h2><p>${T('Meldeschein für alle Personen und wie wir Sie erreichen.')}</p></div>
            <div class="gapp-cols"><div class="gapp-col">${parts.join('') || details}</div><div class="gapp-col">${parts.length ? details : ''}</div></div>`;
    }
    const fmtDate = ymd => ymd ? new Date(ymd + 'T12:00:00').toLocaleDateString(L()) : '–';
    // "{when} vor der Anreise{date}" for the door code that is not shown yet
    const pinWhen = s => ({
        when: s.pinLater === 1 ? T('einen Tag') : T('{n} Tage', { n: s.pinLater }),
        date: s.daysUntil > s.pinLater ? T(', also ab {d}', { d: fmt(addDays(s.checkin, -s.pinLater)) }) : ''
    });

    // ---- Ankunft: Route, Parken, Haustür Schritt für Schritt ----------------
    function renderArrival(s) {
        const a = s.arrival;
        const photo = (src, alt) => src ? `<figure class="arr-fig"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"></figure>` : '';
        const left = [];
        const right = [];
        if (a.address || a.routeNote) {
            left.push(`<div class="gcard arr-card"><span class="arr-kicker">${T('Anfahrt')}</span><h3>${T('Route')}</h3>
                ${a.address ? `<p class="prose">${esc(a.address)}</p>` : ''}${a.routeNote ? `<p class="prose">${esc(a.routeNote)}</p>` : ''}
                ${a.routeUrl ? `<a class="btn btn-dark btn-small" href="${esc(a.routeUrl)}" target="_blank" rel="noopener">${T('Route in Google Maps starten')}</a>` : ''}</div>`);
        }
        if (a.parking || a.parkingPhoto) {
            left.push(`<div class="gcard arr-card"><span class="arr-kicker">${T('Ankommen')}</span><h3>${T('Parken')}</h3>
                ${a.parking ? `<p class="prose">${esc(a.parking)}</p>` : ''}${photo(a.parkingPhoto, T('Parkplatz'))}</div>`);
        }
        if (a.door || a.doorPhoto) {
            left.push(`<div class="gcard arr-card"><span class="arr-kicker">${T('Eingang')}</span><h3>${T('Die Haustür')}</h3>
                ${a.door ? `<p class="prose">${esc(a.door)}</p>` : ''}${photo(a.doorPhoto, T('Haustür'))}</div>`);
        }
        if (s.pin) {
            right.push(`<div class="gcard gpin"><h3>${T('Ihr Türcode')}</h3><div class="pin">${esc(s.pin)}</div>
                <p>${esc(T('Gültig ab Anreisetag {from} Uhr bis Abreisetag {until} Uhr.', { from: s.checkinTime, until: s.checkoutTime }))}</p></div>`);
        } else if (s.pinLater) {
            right.push(`<div class="gcard gpin"><h3>${T('Ihr Türcode')}</h3>
                <p>${esc(T('Erscheint hier {when} vor der Anreise{date}. Am Anreisetag schicken wir ihn Ihnen auch zu.', pinWhen(s)))}</p></div>`);
        }
        if (s.wifi) right.push(wifiCard(s));
        if (a.steps.length) {
            right.push(`<div class="gcard arr-card"><span class="arr-kicker">${T('Tür öffnen')}</span><h3>${T('Schritt für Schritt')}</h3>
                <ol class="arr-steps">${a.steps.map((st, i) => `<li><span class="arr-n">${i + 1}</span><div>${st.text ? `<p>${esc(st.text)}</p>` : ''}${photo(st.photo, T('Schritt {n}', { n: i + 1 }))}</div></li>`).join('')}</ol>
                ${a.emergency ? `<p class="arr-help">${T('Reagiert das Tastenfeld nicht? Scannen Sie den QR-Code an der Tür, damit öffnen Sie während Ihres Aufenthalts die Tür mit dem Handy.')}</p>` : ''}</div>`);
        } else if (a.emergency) {
            right.push(`<div class="gcard"><p class="arr-help" style="margin:0">${T('Reagiert das Tastenfeld nicht? Scannen Sie den QR-Code an der Tür, damit öffnen Sie während Ihres Aufenthalts die Tür mit dem Handy.')}</p></div>`);
        }
        right.push(contactHtml(s.contact, s.chat));
        const when = s.daysUntil === 0 ? T('Heute ist Ihr Anreisetag.') : s.state === 'upcoming' ? esc(T('Anreise am {d}{t}.', { d: fmt(s.checkin), t: s.checkinTime ? T(' ab {t} Uhr', { t: s.checkinTime }) : '' })) : T('Zum Nachschlagen während Ihres Aufenthalts.');
        return `<div class="gapp-pane-head"><h2>${T('Ihre Ankunft')}</h2><p>${when} ${T('So finden Sie zu uns und kommen ins Haus.')}</p></div>
            <div class="gapp-cols"><div class="gapp-col">${left.join('')}</div><div class="gapp-col">${right.join('')}</div></div>`;
    }

    // ---- A – Z Gästemappe --------------------------------------------------
    function renderAZ(s) {
        const items = [];
        const add = (title, html) => { if (html) items.push({ title, html }); };
        if (s.pin) add(T('Türcode'), `<div class="pin" style="font-size:2.4rem">${esc(s.pin)}</div><p class="guide-fine">${esc(T('Gültig ab Anreisetag {from} Uhr bis Abreisetag {until} Uhr.', { from: s.checkinTime, until: s.checkoutTime }))}</p>`);
        else if (s.pinLater) add(T('Türcode'), `<p>${esc(T('Erscheint {when} vor der Anreise unter „Aufenthalt“.', pinWhen(s)))}</p>`);
        if (s.wifi) add(T('WLAN'), wifiCard(s).replace(/^<div class="gcard gwifi"><h3>[^<]*<\/h3>/, '<div class="gwifi">'));
        add(T('An- & Abreise'), `<dl class="guide-dl"><div><dt>${T('Anreise')}</dt><dd>${esc(T('{d}, ab {t} Uhr', { d: fmt(s.checkin), t: s.checkinTime }))}</dd></div>
            <div><dt>${T('Abreise')}</dt><dd>${esc(T('{d}, bis {t} Uhr', { d: fmt(s.checkout), t: s.checkoutTime }))}</dd></div></dl>
            ${s.arrivalInfo ? `<div class="prose">${esc(s.arrivalInfo)}</div>` : ''}`);
        const addr = (info && info.address) || '';
        if (addr) add(T('Adresse'), `<div class="prose">${esc(addr)}</div><a class="text-link" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}" target="_blank" rel="noopener">${T('Route in Google Maps')}</a>`);
        if (s.parking) add(T('Parken'), `<div class="prose">${esc(s.parking)}</div>`);
        if (s.houseRules) add(T('Hausregeln'), `<div class="prose">${esc(s.houseRules)}</div>`);
        const c = s.contact;
        if ((c && (c.phone || c.email)) || (s.chat && s.chat.url)) add(T('Kontakt & Notfall'), `${c && (c.phone || c.email) ? `<p>${c.name ? esc(c.name) + '<br>' : ''}${c.phone ? `<a href="tel:${esc(c.phone.replace(/\s+/g, ''))}">${esc(c.phone)}</a>` : ''}${c.phone && c.email ? '<br>' : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</p>` : ''}${waButton(s.chat)}`);
        (s.guide || []).forEach(g => add(g.title, `<div class="prose">${esc(g.text)}</div>`));

        const key = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
        items.sort((a, b) => key(a.title).localeCompare(key(b.title), I18N.lang));
        const groups = [];
        items.forEach(it => {
            const L = /[A-Z]/.test(key(it.title)[0]) ? key(it.title)[0] : '#';
            if (!groups.length || groups[groups.length - 1].letter !== L) groups.push({ letter: L, items: [] });
            groups[groups.length - 1].items.push(it);
        });
        return `<div class="gapp-pane-head"><h2>${T('Gästemappe A – Z')}</h2><p>${T('Alles für Ihren Aufenthalt, von WLAN bis Hausregeln.')}</p></div>
            <div class="az-cols">${groups.map(g => `<div class="az-group"><div class="az-letter"><b>${g.letter}</b></div>
                ${g.items.map(it => `<details class="az-item"><summary>${esc(it.title)}${ICON.chev}</summary><div class="az-body">${it.html}</div></details>`).join('')}</div>`).join('')}</div>`;
    }

    // ---- Umgebung ---------------------------------------------------------
    const wxIcon = k => (window.liveWeatherIcon ? window.liveWeatherIcon(k, 'wx') : '');
    const dayName = (ymd, today) => ymd === today ? T('Heute') : ymd === addDays(today, 1) ? T('Morgen')
        : new Date(ymd + 'T12:00:00').toLocaleDateString(L(), { weekday: 'short' }).replace('.', '');

    function liveHtml(s) {
        if (!liveHas()) return '';
        const out = [];
        const w = live.weather;
        if (w) {
            const t = w.days[0];
            out.push(`<div class="gcard live-wx"><span class="dist">${esc(live.place ? T('Wetter in {place} · jetzt', { place: live.place }) : T('Wetter · jetzt'))}</span>
                <div class="wx-now">${wxIcon(w.now.icon)}<div><strong>${esc(w.now.temp)}°</strong><span>${esc(TX(w.now.label))}</span></div></div>
                <p class="wx-line">${esc([T('Heute {min}° bis {max}°', { min: t.min, max: t.max }), t.rain != null ? T('Regenrisiko {n} %', { n: t.rain }) : '', w.now.wind != null ? T('Wind {n} km/h', { n: w.now.wind }) : '', t.sunset ? T('Sonnenuntergang {t}', { t: t.sunset }) : ''].filter(Boolean).join(' · '))}</p>
                <div class="wx-days">${w.days.slice(1, 5).map(x => `<div><span>${esc(dayName(x.date, live.today))}</span>${wxIcon(x.icon)}<b>${esc(x.max)}°</b> <small>${esc(x.min)}°</small>${x.rain >= 30 ? `<em>${esc(x.rain)} %</em>` : ''}</div>`).join('')}</div></div>`);
        }
        if (live.places.length) {
            out.push(`<div class="gcard live-places"><span class="dist">${T('Öffnungszeiten · jetzt')}</span><h3>${esc(T('Einkaufen & Essen'))}</h3>
                <ul>${live.places.map(p => {
                    const cls = p.open === true ? (p.soon ? 'soon' : 'open') : p.open === false ? 'closed' : '';
                    const meta = [TX(p.kind), p.distance].filter(Boolean).map(esc).join(' · ');
                    const week = p.week ? `<details><summary>${T('Alle Zeiten')}</summary><dl>${p.week.map(d => `<dt>${esc(TX(d.day))}</dt><dd>${esc(TX(d.hours))}</dd>`).join('')}</dl></details>` : '';
                    return `<li><div class="lp-head"><strong>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}</strong>${meta ? `<small>${meta}</small>` : ''}</div>
                        <div class="lp-state ${cls}"><i></i>${esc(TX(p.state) || p.hours || '')}${p.today && p.open !== null ? `<small>${esc(T('Heute {t}', { t: TX(p.today) }))}</small>` : ''}</div>${week}</li>`;
                }).join('')}</ul></div>`);
        }
        const during = s && s.status === 'confirmed' && s.state !== 'past' && live.range && live.range.to === s.checkout;
        out.push(`<div class="gcard live-events"><span class="dist">${T(during ? 'Während Ihres Aufenthalts' : 'In den nächsten Tagen')}</span><h3>${T('Veranstaltungen')}</h3>
            ${live.events.length ? `<ul>${live.events.map(e => {
                const ongoing = e.end && e.date < live.today;
                const when = ongoing ? T('bis {d}', { d: fmtShort(e.end) }) : `${dayName(e.date, live.today)}${e.date !== live.today && e.date !== addDays(live.today, 1) ? `, ${fmtShort(e.date)}` : ''}${e.end ? ` – ${fmtShort(e.end)}` : ''}${e.time ? ` · ${e.time}${I18N.lang === 'de' ? ' Uhr' : ''}` : ''}`;
                return `<li><span class="ev-when">${esc(when)}</span><strong>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}</strong>${e.place ? `<small>${esc(e.place)}</small>` : ''}</li>`;
            }).join('')}</ul>` : `<p class="area-empty">${T('Uns sind für diese Tage keine Veranstaltungen bekannt. Fragen Sie uns gerne nach Tipps.')}</p>`}</div>`);
        return `<div class="live-grid">${out.join('')}</div>`;
    }

    function renderArea(s) {
        const cards = [];
        if (info && (info.address || info.directions)) {
            cards.push(`<div class="gcard tip"><span class="dist">${T('So finden Sie uns')}</span><h3>${T('Anfahrt')}</h3>
                ${info.address ? `<p class="prose">${esc(info.address)}</p>` : ''}${info.directions ? `<p class="prose">${esc(info.directions)}</p>` : ''}
                ${info.address ? `<a class="text-link" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(info.address)}" target="_blank" rel="noopener">${T('Route planen')}</a>` : ''}</div>`);
        }
        (info ? info.tips : []).forEach(t => cards.push(`<div class="gcard tip">${t.distance ? `<span class="dist">${esc(t.distance)}</span>` : ''}<h3>${esc(t.name)}</h3>
            ${t.text ? `<p class="prose">${esc(t.text)}</p>` : ''}${t.url ? `<a class="text-link" href="${esc(t.url)}" target="_blank" rel="noopener">${T('Mehr erfahren')}</a>` : ''}</div>`));
        const lv = liveHtml(s);
        return `<div class="gapp-pane-head"><h2>${esc(T('Umgebung & Highlights'))}</h2>${info && info.location ? `<p class="prose">${esc(info.location)}</p>` : `<p>${T('Unsere Tipps für Ausflüge und den Alltag vor Ort.')}</p>`}</div>
            ${lv}${lv && cards.length ? `<h3 class="area-sub">${T('Unsere Ausflugstipps')}</h3>` : ''}
            ${cards.length ? `<div class="area-grid">${cards.join('')}</div>` : lv ? '' : `<p class="area-empty">${T('Unsere Tipps folgen in Kürze.')}</p>`}`;
    }

    const WA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2A9.8 9.8 0 0 0 3.6 17l-1.4 4.8 5-1.3A9.8 9.8 0 1 0 12 2.2zm0 17.9a8.1 8.1 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.1 8.1 0 1 1 12 20.1zm4.5-6c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.4-.3z"/></svg>';
    const waButton = chat => chat && chat.url ? `<a class="wa-btn" href="${esc(chat.url)}" target="_blank" rel="noopener">${WA_ICON}<span>${T('Per WhatsApp schreiben')}</span></a>` : '';

    function contactHtml(c, chat) {
        const hasContact = c && (c.phone || c.email);
        if (!hasContact && !(chat && chat.url)) return '';
        const lines = hasContact ? `<p>${c.name ? esc(c.name) + '<br>' : ''}${c.phone ? `<a href="tel:${esc(c.phone.replace(/\s+/g, ''))}">${esc(c.phone)}</a>` : ''}${c.phone && c.email ? ' · ' : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</p>` : '';
        return `<div class="gcard"><div class="info-block"><h4>${T('Kontakt')}</h4>${lines}${chat && chat.url ? `<p class="wa-note">${T('Fragen zum Aufenthalt? Schreiben Sie uns einfach, wir antworten so schnell wie möglich.')}</p>${waButton(chat)}` : ''}</div></div>`;
    }

    // Existing invoice: download + correction request. Otherwise the guest can create it once.
    function invoiceHtml(s) {
        const inv = s.invoice;
        if (inv) {
            return `<div class="info-block"><div class="invoice-row">
                <div><h4>${T('Rechnung')}</h4><p>${esc(T('Nr. {n}', { n: inv.number }))}${inv.date ? esc(T(' vom {d}', { d: new Date(inv.date + 'T12:00:00').toLocaleDateString(L()) })) : ''} · ${T(inv.paid ? 'bezahlt' : 'offen')}</p></div>
                <div class="invoice-action"><button type="button" class="btn btn-ghost btn-small" data-invoice>${T('Als PDF herunterladen')}</button>
                <div class="form-error" id="invoice-error" hidden></div></div></div>
                <button type="button" class="link-btn" data-toggle="invoice-fix-form">${T('Etwas stimmt nicht? Korrektur anfragen')}</button>
                <form id="invoice-fix-form" class="invoice-form" novalidate hidden>
                    <p class="guide-fine">${T('Eine erstellte Rechnung können Sie nicht mehr selbst ändern. Schreiben Sie uns, was falsch ist. Wir korrigieren die Rechnung und melden uns.')}</p>
                    <label>${T('Was soll geändert werden?')}<textarea name="text" rows="3" maxlength="1000" required></textarea></label>
                    <div class="form-error" id="invoice-fix-error" hidden></div>
                    <button type="submit" class="btn btn-ghost btn-small">${T('Anfrage senden')}</button><span class="saved" id="invoice-fix-saved" hidden>${T('Gesendet, wir melden uns.')}</span>
                </form></div>`;
        }
        const o = s.invoiceOffer;
        if (!o) return '';
        const desc = d => esc(TX(d)).replace(/\((\d+) (Nacht|Nächte) inkl\. Endreinigung/, (m, n, w) => `(${n} ${T(w)} + ${T('Endreinigung')}`);
        const lines = o.positions.map(p => `<div><span>${p.qty > 1 ? `${p.qty} × ` : ''}${desc(p.desc)}${p.qty > 1 ? ` à ${money(p.price)}` : ''}</span><span>${money(p.qty * p.price)}</span></div>`).join('');
        const a = o.address || {};
        return `<div class="info-block"><h4>${T('Rechnung')}</h4>
            <p>${T('Sie brauchen eine Rechnung? Ergänzen Sie Ihre Rechnungsdaten. Danach können Sie die Rechnung sofort als PDF herunterladen.')}</p>
            <button type="button" class="btn btn-dark btn-small" data-toggle="invoice-form">${T('Rechnungsdaten eingeben')}</button>
            <form id="invoice-form" class="invoice-form" novalidate hidden>
                <label>${T('Vor- und Nachname')}<input type="text" name="name" maxlength="80" autocomplete="name" value="${esc(o.name)}" required></label>
                <label>${T('Firma')} <small>${T('optional, nur für Firmenrechnungen')}</small><input type="text" name="company" maxlength="120" autocomplete="organization"></label>
                <label>${T('Straße und Hausnummer')}<input type="text" name="street" maxlength="120" autocomplete="street-address" value="${esc(a.street)}" required></label>
                <div class="row">
                    <label>${T('PLZ')}<input type="text" name="zip" maxlength="10" autocomplete="postal-code" value="${esc(a.zip)}" required></label>
                    <label>${T('Ort')}<input type="text" name="city" maxlength="80" autocomplete="address-level2" value="${esc(a.city)}" required></label>
                </div>
                <div class="row">
                    <label>${T('Land')}<input type="text" name="country" maxlength="60" autocomplete="country-name" value="${esc(a.country || DEFAULT_COUNTRY[I18N.lang] || 'Deutschland')}"></label>
                    <label>${T('USt-IdNr.')} <small>${T('optional')}</small><input type="text" name="vatId" maxlength="20" placeholder="${esc(T('z. B. DE123456789'))}"></label>
                </div>
                <div class="invoice-sum">${lines}
                    <div class="invoice-total"><span>${T('Gesamtbetrag')}${o.mwstRate ? esc(T(' inkl. {n} % MwSt.', { n: o.mwstRate })) : ''}</span><span>${money(o.total)}</span></div>
                    <p>${o.paid ? esc(T('Bereits bezahlt über {s}.', { s: s.source })) : T('Zahlung per Überweisung, die Bankverbindung steht auf der Rechnung.')}</p>
                </div>
                <label class="check"><input type="checkbox" name="confirm" required> ${T('Meine Angaben stimmen. Danach kann ich die Rechnung nicht mehr selbst ändern.')}</label>
                <div class="form-error" id="invoice-form-error" hidden></div>
                <button type="submit" class="btn btn-dark btn-small">${T('Rechnung erstellen')}</button>
            </form></div>`;
    }


    function addDays(ymd, n) {
        const d = new Date(ymd + 'T12:00:00');
        d.setDate(d.getDate() + n);
        return d.toISOString().slice(0, 10);
    }

    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fallback below */ }
        const t = document.createElement('textarea');
        t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
        document.body.appendChild(t); t.select();
        const ok = document.execCommand('copy');
        t.remove();
        return ok;
    }

    async function downloadInvoice(btn) {
        const err = $('#invoice-error');
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = T('Wird erstellt …');
        showError(err, '');
        try {
            const r = await fetch('api/me/rechnung', { credentials: 'same-origin' });
            if (!r.ok) throw new Error(TX(await r.text().catch(() => '')) || T('Download fehlgeschlagen.'));
            const blob = await r.blob();
            const name = (/filename="?([^";]+)"?/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || 'Rechnung.pdf';
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        } catch (e) {
            showError(err, e.message.length < 200 ? e.message : T('Download fehlgeschlagen.'));
        } finally {
            btn.disabled = false;
            btn.textContent = label;
        }
    }

    function bindInvoiceForms(root) {
        const invForm = root.querySelector('#invoice-form');
        if (invForm) {
            invForm.addEventListener('submit', async e => {
                e.preventDefault();
                const err = $('#invoice-form-error');
                const btn = invForm.querySelector('[type=submit]');
                const body = Object.fromEntries(new FormData(invForm).entries());
                body.confirm = invForm.elements.confirm.checked;
                body.country = countryValue(body.country);
                btn.disabled = true;
                btn.textContent = T('Wird erstellt …');
                const d = await api('me/rechnung', body).catch(() => ({}));
                if (!d.success) {
                    btn.disabled = false;
                    btn.textContent = T('Rechnung erstellen');
                    return showError(err, TX(d.error) || T('Das hat nicht geklappt. Bitte erneut versuchen.'));
                }
                await loadMe();
                const dl = $('#app [data-invoice]');
                if (dl) downloadInvoice(dl);
            });
        }
        const fixForm = root.querySelector('#invoice-fix-form');
        if (fixForm) {
            fixForm.addEventListener('submit', async e => {
                e.preventDefault();
                const d = await api('me/rechnung/korrektur', { text: fixForm.elements.text.value }).catch(() => ({}));
                showError($('#invoice-fix-error'), d.success ? '' : (TX(d.error) || T('Senden fehlgeschlagen.')));
                if (d.success) { fixForm.elements.text.value = ''; $('#invoice-fix-saved').hidden = false; }
            });
        }
    }


    // ---- Bindings ---------------------------------------------------------
    function bindApp() {
        const root = $('#app');
        root.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.goto)));
        root.querySelectorAll('[data-carousel]').forEach(car => {
            const track = car.querySelector('.gcarousel-track');
            const prev = car.querySelector('.prev'), next = car.querySelector('.next'), count = car.querySelector('.gcarousel-count');
            if (!prev) return;
            const n = track.children.length;
            const idx = () => Math.round(track.scrollLeft / track.clientWidth);
            const update = () => { const i = idx(); prev.disabled = i <= 0; next.disabled = i >= n - 1; count.textContent = `${i + 1} / ${n}`; };
            prev.addEventListener('click', () => track.scrollBy({ left: -track.clientWidth }));
            next.addEventListener('click', () => track.scrollBy({ left: track.clientWidth }));
            track.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
        });
        root.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
            const span = b.querySelector('span');
            span.textContent = (await copyText(b.dataset.copy)) ? T('Kopiert') : T('Bitte manuell kopieren');
            b.classList.add('done');
            setTimeout(() => { span.textContent = T('Kopieren'); b.classList.remove('done'); }, 2000);
        }));
        const inv = root.querySelector('[data-invoice]');
        if (inv) inv.addEventListener('click', () => downloadInvoice(inv));
        root.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
            const f = document.getElementById(b.dataset.toggle);
            f.hidden = !f.hidden;
            if (!f.hidden) { const first = f.querySelector('input:not([value]), input[value=""], textarea'); if (first) first.focus(); }
        }));
        bindInvoiceForms(root);
        bindMeldeschein(root);
        const form = root.querySelector('#details-form');
        if (form) {
            form.addEventListener('submit', async e => {
                e.preventDefault();
                const err = $('#details-error');
                const d = await api('me/details', Object.fromEntries(new FormData(form).entries()));
                if (!d.success) return showError(err, TX(d.error) || T('Speichern fehlgeschlagen.'));
                showError(err, '');
                await loadMe();
                const saved = $('#details-saved');
                if (saved) saved.hidden = false;
            });
        }
    }

    function bindMeldeschein(root) {
        const edit = root.querySelector('#ms-edit');
        if (edit) edit.addEventListener('click', () => { msEditing = true; renderApp(); });
        const form = root.querySelector('#ms-form');
        if (!form) return;
        const cancel = form.querySelector('#ms-cancel');
        if (cancel) cancel.addEventListener('click', () => { msEditing = false; renderApp(); });
        const list = form.querySelector('#ms-companions');
        // One row per further person, values are kept when the number changes
        form.elements.persons.addEventListener('change', () => {
            const want = Math.max(0, (parseInt(form.elements.persons.value, 10) || 1) - 1);
            while (list.children.length > want) list.lastElementChild.remove();
            while (list.children.length < want) list.insertAdjacentHTML('beforeend', companionHtml({ lastName: form.elements.lastName.value }, list.children.length));
        });
        form.elements.nationality.addEventListener('input', () => {
            const foreign = isForeign(countryValue(form.elements.nationality.value));
            form.querySelectorAll('[data-foreign]').forEach(el => { el.hidden = !foreign; });
        });
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const err = $('#ms-error');
            const el = form.elements;
            const companions = [...list.querySelectorAll('[data-companion]')].map(c => ({
                firstName: c.querySelector('[name=c_firstName]').value, lastName: c.querySelector('[name=c_lastName]').value,
                birthDate: c.querySelector('[name=c_birthDate]').value
            }));
            if (!el.persons.value) return showError(err, T('Bitte angeben, wie viele Personen übernachten.'));
            const missing = companions.findIndex(c => !c.firstName.trim() || !c.lastName.trim() || !c.birthDate);
            if (missing >= 0) return showError(err, T('Bitte bei Person {n} Vorname, Familienname und Geburtsdatum eintragen.', { n: missing + 2 }));
            if (!el.confirm.checked) return showError(err, T('Bitte bestätigen Sie, dass Ihre Angaben stimmen.'));
            const nationality = countryValue(el.nationality.value);
            const foreign = isForeign(nationality);
            const body = {
                firstName: el.firstName.value, lastName: el.lastName.value, birthDate: el.birthDate.value, nationality,
                idType: foreign ? el.idType.value : '', idNumber: foreign ? el.idNumber.value : '',
                street: el.street.value, zip: el.zip.value, city: el.city.value, country: countryValue(el.country.value),
                phone: el.phone.value, email: el.email.value, persons: parseInt(el.persons.value, 10), companions, confirm: true
            };
            const btn = form.querySelector('[type=submit]');
            btn.disabled = true;
            btn.textContent = T('Wird gesendet …');
            const d = await api('me/meldeschein', body).catch(() => ({}));
            if (!d.success) {
                btn.disabled = false;
                btn.textContent = T('Meldeschein absenden');
                return showError(err, TX(d.error) || T('Das hat nicht geklappt. Bitte erneut versuchen.'));
            }
            msEditing = false;
            await loadMe();
            showTab('guests');
        });
    }

    // ------------------------------------------------------------------
    // Legal dialogs
    // ------------------------------------------------------------------
    function openLegal(kind) {
        const imprint = kind === 'impressum';
        $('#legal-title').textContent = T(imprint ? 'Impressum' : 'Datenschutz');
        const text = info ? (imprint ? info.imprint : info.privacy) : '';
        $('#legal-body').textContent = text || T('Dieser Text wird gerade vorbereitet.');
        if (!$('#legal-overlay').open) $('#legal-overlay').showModal();
    }
    function onHash() {
        const h = location.hash.slice(1);
        if (h === 'impressum' || h === 'datenschutz') openLegal(h);
    }
    window.addEventListener('hashchange', onHash);
    $('#legal-overlay').addEventListener('close', () => {
        if (/^#(impressum|datenschutz)$/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
    });
    $('#legal-close').addEventListener('click', () => $('#legal-overlay').close());
    $('#legal-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

    // ------------------------------------------------------------------
    // Language: static texts (data-t), switcher on the login page and in the menu
    // ------------------------------------------------------------------
    function translateStatic() {
        I18N.apply();
        document.querySelectorAll('.lang-pick').forEach(p => p.redraw());
        if (info) document.title = `${T('Meine Buchung')} · ${info.title}`;
        if (info && info.contact && info.contact.phone) $('#app-menu-contact').innerHTML = `<a href="tel:${esc(info.contact.phone.replace(/\s+/g, ''))}">${esc(T('Anrufen: {phone}', { phone: info.contact.phone }))}</a>`;
    }
    function onLang(l) {
        translateStatic();
        if (me && document.body.classList.contains('signed-in')) {
            api('me/lang', { lang: l }).catch(() => null);
            renderApp();
            const area = $('[data-pane="area"]');
            if (area && tabsFor(me).includes('area')) area.innerHTML = renderArea(me);
        }
        if ($('#legal-overlay').open) onHash();
    }
    $('#login-box').prepend(I18N.picker(onLang, 'lang-pick-login'));
    $('#app-menu-links').before(I18N.picker(onLang, 'lang-pick-menu'));
    $('.gapp-bar').insertBefore(I18N.picker(onLang, 'lang-pick-hero'), $('#app-menu-btn'));
    translateStatic();

    (async () => {
        try { await loadInfo(); } catch (e) { /* page still usable */ }
        await loadMe(newCodeParam).catch(() => { $('#login-box').hidden = false; });
        if (newCodeParam || tabParam) history.replaceState(null, '', location.pathname);
        document.body.classList.add('ready');
        onHash();
    })();
})();
