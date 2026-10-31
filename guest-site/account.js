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
    const fmt = ymd => ymd ? new Date(ymd + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '–';
    const money = n => Number(n).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    const nightsTxt = n => `${n} ${n === 1 ? 'Nacht' : 'Nächte'}`;
    const showError = (el, msg) => { el.textContent = msg; el.hidden = !msg; };

    let info = null;
    // Code of a request that was just sent from the start page
    const newCodeParam = new URLSearchParams(location.search).get('neu');

    async function loadInfo() {
        const d = await api('info');
        if (!d.success) return;
        info = d;
        document.title = `Meine Buchung · ${d.title}`;
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
            if (d.contact.phone) $('#app-menu-contact').innerHTML = `<a href="tel:${esc(d.contact.phone.replace(/\s+/g, ''))}">Anrufen: ${esc(d.contact.phone)}</a>`;
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
        if (!d.success) return showError(err, d.error || 'Anmeldung fehlgeschlagen.');
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
    let ms = null;       // Meldeschein state
    let msEditing = false;
    let newCodeShown = null;
    const tabParam = new URLSearchParams(location.search).get('tab');
    let tab = tabParam === 'meldeschein' ? 'guests' : (() => { try { return sessionStorage.getItem('gapp-tab') || 'stay'; } catch (e) { return 'stay'; } })();

    const isStay = s => s && s.kind === 'booking' && s.status === 'confirmed';
    const tabsFor = s => {
        const t = ['stay'];
        if (isStay(s) && s.state !== 'past') t.unshift('guests');
        if (s.status === 'confirmed' && s.state !== 'past') t.push('az');
        if (info && (info.tips.length || info.address || info.directions || info.location)) t.push('area');
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
        if (newCode) newCodeShown = newCode;
        ms = null;
        if (isStay(me) && me.state !== 'past') {
            const m = await api('me/meldeschein').catch(() => null);
            if (m && m.success && m.enabled) ms = m;
        }
        renderApp();
    }

    function stateLine(s) {
        if (s.status === 'pending') return 'Wir prüfen Ihre Anfrage und melden uns.';
        if (s.status !== 'confirmed') return '';
        if (s.state === 'inhouse') return 'Schön, dass Sie da sind!';
        if (s.state === 'departing') return 'Heute ist Ihr Abreisetag. Gute Heimreise!';
        if (s.state === 'past') return 'Danke für Ihren Besuch!';
        if (s.daysUntil === 0) return 'Heute ist Ihr Anreisetag.';
        return s.daysUntil === 1 ? 'Morgen geht es los!' : `Noch ${s.daysUntil} Tage bis zur Anreise.`;
    }

    function renderApp() {
        const s = me;
        const first = (s.name || '').split(/\s+/)[0];
        $('#app-hello').textContent = first ? `Willkommen, ${first}` : 'Willkommen';
        $('#app-state').textContent = s.status === 'gone' ? '' : `${fmtShort(s.checkin)} – ${fmtShort(s.checkout)} · ${stateLine(s)}`.replace(/ · $/, '');
        const avail = tabsFor(s);
        if (!avail.includes(tab)) tab = 'stay';
        $$('#app-tabs [data-tab]').forEach(b => { b.hidden = !avail.includes(b.dataset.tab); });
        $('#tab-guests-dot').hidden = !(ms && !ms.form);
        $('[data-pane="stay"]').innerHTML = renderStay(s);
        if (s.chat && s.chat.url && !$('#app-menu-wa')) {
            const a = document.createElement('a');
            a.id = 'app-menu-wa'; a.href = s.chat.url; a.target = '_blank'; a.rel = 'noopener';
            a.textContent = 'Per WhatsApp schreiben';
            $('#app-menu-contact').after(a);
        }
        $('[data-pane="guests"]').innerHTML = avail.includes('guests') ? renderGuests(s) : '';
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
    const fmtShort = ymd => ymd ? new Date(ymd + 'T12:00:00').toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }) : '';

    function carouselHtml(photos) {
        if (!photos.length) return '';
        return `<div class="gcarousel" data-carousel>
            <div class="gcarousel-track">${photos.map((p, i) => `<img src="${esc(p)}" alt="Foto ${i + 1} der Wohnung" loading="${i ? 'lazy' : 'eager'}">`).join('')}</div>
            ${photos.length > 1 ? `<button type="button" class="gcarousel-btn prev" aria-label="Vorheriges Foto" disabled>${ICON.prev}</button>
            <button type="button" class="gcarousel-btn next" aria-label="Nächstes Foto">${ICON.next}</button>
            <span class="gcarousel-count">1 / ${photos.length}</span>` : ''}
        </div>`;
    }

    function renderStay(s) {
        const [cls, label] = STATUS[s.status] || STATUS.pending;
        if (s.status === 'gone') {
            return `<div class="gapp-cols"><div class="gapp-col"><div class="gcard"><h3>Buchung ${esc(s.code || '')}</h3><span class="badge ${cls}">${label}</span>
                <p style="margin-top:1rem">Diese Buchung finden wir nicht mehr. Möglicherweise wurde sie über das Buchungsportal storniert. Bei Fragen melden Sie sich gerne bei uns.</p></div></div>
                <div class="gapp-col">${contactHtml(s.contact, s.chat)}</div></div>`;
        }
        const guests = s.guests ? `${s.guests.adults} Erw.${s.guests.children ? ` + ${s.guests.children} Kind${s.guests.children === 1 ? '' : 'er'}` : ''}` : '';
        const left = [];
        const right = [];
        if (newCodeShown) {
            left.push(`<div class="code-box" style="margin:0"><div>Vielen Dank für Ihre Anfrage! Ihr Buchungscode:<br><strong>${esc(newCodeShown)}</strong></div>
                <small>Bitte notieren. Damit und mit Ihrem Anreisedatum rufen Sie den Status jederzeit ab.</small></div>`);
        }
        left.push(`<div class="gcard-pair">
            <div class="gcard gid"><span>Buchungscode</span><strong>${esc(s.code || '–')}</strong></div>
            <div class="gcard gid"><span>Gebucht von</span>${s.name ? `<strong>${esc(s.name)}</strong>` : '<strong class="muted">Name fehlt</strong>'}
                ${s.status !== 'confirmed' ? `<span class="badge ${cls}">${label}</span>` : ''}</div>
        </div>`);
        left.push(`<div class="gsection">
            <div class="gsection-head"><span class="ic">${ICON.home}</span><h3>${s.status === 'confirmed' ? 'Gebucht' : label}</h3><span></span></div>
            <div class="gsection-body">
                ${carouselHtml((info && info.photos) || [])}
                <p class="gstay-title">${esc((info && info.title) || 'Ferienwohnung')}</p>
                <div class="stay-grid">
                    <div><span>Anreise</span><strong>${fmt(s.checkin)}${s.checkinTime ? `, ab ${esc(s.checkinTime)}` : ''}</strong></div>
                    <div><span>Abreise</span><strong>${fmt(s.checkout)}${s.checkoutTime ? `, bis ${esc(s.checkoutTime)}` : ''}</strong></div>
                    <div><span>Aufenthalt</span><strong>${nightsTxt(s.nights)}${guests ? ` · ${guests}` : ''}</strong></div>
                    <div><span>Gebucht über</span><strong>${esc(s.source)}</strong></div>
                    ${s.priceTotal ? `<div><span>Preis</span><strong>${money(s.priceTotal)}</strong></div>` : ''}
                </div>
            </div>
        </div>`);

        if (s.status === 'confirmed' && s.state !== 'past') {
            if (s.pin) {
                right.push(`<div class="gcard gpin"><h3>Ihr Türcode</h3><div class="pin">${esc(s.pin)}</div>
                    <p>Gültig ab Anreisetag ${esc(s.checkinTime)} Uhr bis Abreisetag ${esc(s.checkoutTime)} Uhr. Code eingeben und mit der Taste bestätigen.</p></div>`);
            } else if (s.pinLater) {
                right.push(`<div class="gcard gpin"><h3>Ihr Türcode</h3>
                    <p>Ihr persönlicher Türcode erscheint hier ${s.pinLater === 1 ? 'einen Tag' : `${s.pinLater} Tage`} vor der Anreise${s.daysUntil > s.pinLater ? `, also ab ${fmt(addDays(s.checkin, -s.pinLater))}` : ''}.</p></div>`);
            }
        }
        if (ms) {
            right.push(ms.form
                ? `<div class="gcard gdone"><span class="tick">${ICON.tick}</span><p><strong>Meldeschein ausgefüllt.</strong> Danke! <button type="button" class="link-btn" style="margin:0" data-goto="guests">Ansehen</button></p></div>`
                : `<div class="gcard gcallout"><h3>Meldeschein ausfüllen</h3>
                    <p>Bitte füllen Sie vor der Anreise kurz den Meldeschein aus, für sich und alle Personen, die mit Ihnen übernachten. Das dauert zwei Minuten.</p>
                    <button type="button" class="btn btn-dark btn-small" data-goto="guests">Jetzt ausfüllen</button></div>`);
        }
        if (s.status === 'pending') {
            right.push(`<div class="gcard"><p>Wir prüfen Ihre Anfrage und melden uns per E-Mail${s.details && s.details.email ? ` an <strong>${esc(s.details.email)}</strong>` : ''}. Auf dieser Seite sehen Sie den aktuellen Stand.</p></div>`);
        }
        if (s.hostNote) right.push(`<div class="gcard"><div class="info-block"><h4>Nachricht von uns</h4><div class="note prose">${esc(s.hostNote)}</div></div></div>`);
        if (s.status === 'confirmed') {
            if (s.payment && s.state !== 'past') {
                right.push(`<div class="gcard"><div class="info-block"><h4>Zahlung</h4><div class="prose">${esc(s.payment.text)}</div>
                    ${s.payment.bank ? `<div class="note prose" style="margin-top:.6rem">${esc(s.payment.bank)}\nVerwendungszweck: ${esc(s.payment.reference)}</div>` : ''}</div></div>`);
            }
            const inv = invoiceHtml(s);
            if (inv) right.push(`<div class="gcard">${inv}</div>`);
        }
        if (s.status === 'declined') right.push('<div class="gcard"><p>Für den gewünschten Zeitraum können wir Ihnen leider keine Zusage geben. Schauen Sie gerne nach einem anderen Termin im Kalender.</p></div>');
        if (s.status === 'cancelled') right.push('<div class="gcard"><p>Diese Buchung wurde storniert. Bei Fragen melden Sie sich gerne bei uns.</p></div>');
        right.push(contactHtml(s.contact, s.chat));
        return `<div class="gapp-cols"><div class="gapp-col">${left.join('')}</div><div class="gapp-col">${right.join('')}</div></div>`;
    }

    // ---- Gäste: Meldeschein + Kontakt ------------------------------------
    const COUNTRIES = ['Deutschland', 'Österreich', 'Schweiz', 'Niederlande', 'Belgien', 'Luxemburg', 'Frankreich', 'Dänemark', 'Polen', 'Tschechien',
        'Italien', 'Spanien', 'Portugal', 'Vereinigtes Königreich', 'Irland', 'Schweden', 'Norwegen', 'Finnland', 'Ungarn', 'Rumänien', 'Bulgarien',
        'Kroatien', 'Slowenien', 'Slowakei', 'Griechenland', 'Türkei', 'Ukraine', 'Russland', 'USA', 'Kanada', 'Australien', 'China', 'Indien', 'Japan'];
    const GERMAN = /^(deutsch(land)?|germany|german|de|d|brd)$/i;
    const isForeign = n => !!String(n || '').trim() && !GERMAN.test(String(n).trim());

    function companionHtml(c, i) {
        c = c || {};
        return `<div class="ms-companion" data-companion>
            <div class="ms-companion-head"><span>Person ${i + 2}</span></div>
            <div class="row">
                <label>Vorname(n)<input type="text" name="c_firstName" maxlength="80" value="${esc(c.firstName)}" required></label>
                <label>Familienname<input type="text" name="c_lastName" maxlength="80" value="${esc(c.lastName)}" required></label>
            </div>
            <label>Geburtsdatum<input type="date" name="c_birthDate" value="${esc(c.birthDate)}" required></label>
        </div>`;
    }

    function msFormHtml(m) {
        const f = m.form || {};
        const p = m.prefill || {};
        const nat = f.nationality || 'Deutschland';
        const foreign = isForeign(nat);
        const persons = m.form ? (f.companions || []).length + 1 : (m.booked || 0);
        return `<form class="ms-form" id="ms-form" novalidate>
            <datalist id="ms-countries">${COUNTRIES.map(c => `<option value="${c}">`).join('')}</datalist>
            <div class="ms-dates"><div><span>Tag der Ankunft</span><strong>${fmt(m.checkin)}</strong></div><div><span>Voraussichtliche Abreise</span><strong>${fmt(m.checkout)}</strong></div></div>
            <fieldset><legend>Ihre Angaben</legend>
                <div class="row">
                    <label>Vorname(n)<input type="text" name="firstName" maxlength="80" autocomplete="given-name" value="${esc(f.firstName || p.firstName)}" required></label>
                    <label>Familienname<input type="text" name="lastName" maxlength="80" autocomplete="family-name" value="${esc(f.lastName || p.lastName)}" required></label>
                </div>
                <div class="row">
                    <label>Geburtsdatum<input type="date" name="birthDate" autocomplete="bday" value="${esc(f.birthDate)}" required></label>
                    <label>Staatsangehörigkeit<input type="text" name="nationality" maxlength="60" list="ms-countries" value="${esc(nat)}" required></label>
                </div>
                <div class="row" data-foreign ${foreign ? '' : 'hidden'}>
                    <label>Ausweisdokument<select name="idType">
                        ${['Reisepass', 'Personalausweis', 'Passersatz'].map(t => `<option${f.idType === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
                    <label>Dokumentnummer<input type="text" name="idNumber" maxlength="30" autocapitalize="characters" value="${esc(f.idNumber)}"></label>
                </div>
                <p class="ms-hint" data-foreign ${foreign ? '' : 'hidden'}>Für Gäste mit ausländischer Staatsangehörigkeit gesetzlich vorgeschrieben. Bitte bringen Sie das Dokument zur Anreise mit.</p>
            </fieldset>
            <fieldset><legend>Wohnanschrift</legend>
                <label>Straße und Hausnummer<input type="text" name="street" maxlength="120" autocomplete="street-address" value="${esc(f.street)}" required></label>
                <div class="row3">
                    <label>PLZ<input type="text" name="zip" maxlength="12" autocomplete="postal-code" value="${esc(f.zip)}" required></label>
                    <label>Ort<input type="text" name="city" maxlength="80" autocomplete="address-level2" value="${esc(f.city)}" required></label>
                </div>
                <div class="row">
                    <label>Land<input type="text" name="country" maxlength="60" list="ms-countries" autocomplete="country-name" value="${esc(f.country || 'Deutschland')}"></label>
                    <label>Telefon <small>optional</small><input type="tel" name="phone" maxlength="40" autocomplete="tel" value="${esc(f.phone || (me.details && me.details.phone) || '')}"></label>
                </div>
                <label>E-Mail <small>optional</small><input type="email" name="email" maxlength="120" autocomplete="email" value="${esc(f.email || (me.details && me.details.email) || '')}"></label>
            </fieldset>
            <fieldset><legend>Weitere Personen</legend>
                <label>Wie viele Personen übernachten insgesamt, Sie eingeschlossen?
                    <select name="persons" required>
                        ${persons ? '' : '<option value="">Bitte wählen</option>'}
                        ${Array.from({ length: m.maxPersons || 8 }, (_, k) => k + 1).map(n => `<option value="${n}"${n === persons ? ' selected' : ''}>${n} ${n === 1 ? 'Person (nur ich)' : 'Personen'}</option>`).join('')}
                    </select></label>
                <p class="ms-hint">Jede weitere Person, auch Kinder, braucht einen eigenen Eintrag mit Vorname, Familienname und Geburtsdatum.</p>
                <div id="ms-companions">${(f.companions || []).map(companionHtml).join('')}</div>
            </fieldset>
            <fieldset><legend>Bestätigung</legend>
                <label class="check"><input type="checkbox" name="confirm" required> Ich bestätige, dass meine Angaben richtig und vollständig sind.</label>
                <p class="ms-hint" style="margin-top:0">Wir nutzen die Angaben nur für die gesetzliche Meldepflicht (§§ 29, 30 Bundesmeldegesetz) und löschen sie nach Ablauf der Aufbewahrungsfrist von einem Jahr nach Abreise.</p>
            </fieldset>
            <div class="form-error" id="ms-error" role="alert" hidden></div>
            <div class="ms-actions">
                <button type="submit" class="btn btn-dark">Meldeschein absenden</button>
                ${m.form ? '<button type="button" class="btn btn-ghost" id="ms-cancel">Abbrechen</button>' : ''}
            </div>
        </form>`;
    }

    function msSummaryHtml(m) {
        const f = m.form;
        const when = f.updatedAt || f.submittedAt;
        const comp = f.companions || [];
        const idTxt = f.idNumber ? `${f.idType ? f.idType + ' ' : ''}•••• ${esc(f.idNumber.slice(-4))}` : '';
        return `<div class="ms-summary">
            <div class="gdone" style="margin-bottom:1.1rem"><span class="tick">${ICON.tick}</span><p><strong>Vielen Dank, Ihr Meldeschein ist da.</strong><br>${when ? `Übermittelt am ${new Date(when.replace(' ', 'T') + 'Z').toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}.` : ''}</p></div>
            <dl>
                <dt>Name</dt><dd>${esc(f.firstName)} ${esc(f.lastName)}</dd>
                <dt>Geburtsdatum</dt><dd>${fmtDate(f.birthDate)}</dd>
                <dt>Staatsangehörigkeit</dt><dd>${esc(f.nationality)}</dd>
                <dt>Anschrift</dt><dd>${esc(f.street)}, ${esc(f.zip)} ${esc(f.city)}${f.country && !GERMAN.test(f.country) ? `, ${esc(f.country)}` : ''}</dd>
                ${idTxt ? `<dt>Ausweis</dt><dd>${idTxt}</dd>` : ''}
                <dt>Weitere Personen</dt><dd>${comp.length ? comp.map(c => `${esc(c.firstName)} ${esc(c.lastName)}${c.birthDate ? `, geb. ${fmtDate(c.birthDate)}` : ''}`).join('<br>') : 'keine'}</dd>
            </dl>
            <div class="ms-actions">${m.editable ? '<button type="button" class="btn btn-ghost btn-small" id="ms-edit">Angaben ändern</button>' : '<p class="ms-hint" style="margin:0">Änderungen ab dem Anreisetag bitte direkt bei uns.</p>'}</div>
        </div>`;
    }

    function renderGuests(s) {
        const parts = [];
        if (ms) {
            parts.push(`<div class="gcard"><h3>Meldeschein</h3>
                ${ms.form && !msEditing ? msSummaryHtml(ms) : `<p style="color:var(--ink-soft)">Bitte vor der Anreise ausfüllen. Für Gäste mit ausländischer Staatsangehörigkeit ist der Meldeschein gesetzlich vorgeschrieben (§ 29 Bundesmeldegesetz), wir bitten alle Gäste darum.</p>${msFormHtml(ms)}`}
            </div>`);
        }
        const dt = s.details || {};
        const details = `<div class="gcard"><h3>${s.needsDetails ? 'Bitte ergänzen Sie Ihren Namen' : 'Kontakt &amp; Ankunft'}</h3>
            ${s.needsDetails ? '<p style="color:var(--ink-soft)">Das Buchungsportal hat uns Ihren Namen nicht übermittelt. Mit dem Meldeschein tragen Sie ihn automatisch ein.</p>' : '<p style="color:var(--ink-soft)">Damit wir Sie erreichen und rechtzeitig da sind.</p>'}
            <form id="details-form" novalidate>
                <label>Vor- und Nachname<input type="text" name="name" maxlength="80" value="${esc(dt.name)}" required></label>
                <div class="row">
                    <label>E-Mail <small>optional</small><input type="email" name="email" maxlength="120" value="${esc(dt.email)}"></label>
                    <label>Telefon <small>optional</small><input type="tel" name="phone" maxlength="40" value="${esc(dt.phone)}"></label>
                </div>
                <div class="row">
                    <label>Ankunft ca. <small>optional</small><input type="text" name="arrivalTime" maxlength="40" placeholder="z. B. 17:30 Uhr"></label>
                    <label>Nachricht <small>optional</small><input type="text" name="note" maxlength="1000"></label>
                </div>
                <div class="form-error" id="details-error" hidden></div>
                <button type="submit" class="btn btn-dark btn-small">Speichern</button><span class="saved" id="details-saved" hidden>Gespeichert, danke!</span>
            </form></div>`;
        return `<div class="gapp-pane-head"><h2>Gäste</h2><p>Meldeschein für alle Personen und wie wir Sie erreichen.</p></div>
            <div class="gapp-cols"><div class="gapp-col">${parts.join('') || details}</div><div class="gapp-col">${parts.length ? details : ''}</div></div>`;
    }
    const fmtDate = ymd => ymd ? new Date(ymd + 'T12:00:00').toLocaleDateString('de-DE') : '–';

    // ---- A – Z Gästemappe --------------------------------------------------
    function renderAZ(s) {
        const items = [];
        const add = (title, html) => { if (html) items.push({ title, html }); };
        if (s.pin) add('Türcode', `<div class="pin" style="font-size:2.4rem">${esc(s.pin)}</div><p class="guide-fine">Gültig ab Anreisetag ${esc(s.checkinTime)} Uhr bis Abreisetag ${esc(s.checkoutTime)} Uhr.</p>`);
        else if (s.pinLater) add('Türcode', `<p>Erscheint ${s.pinLater === 1 ? 'einen Tag' : `${s.pinLater} Tage`} vor der Anreise unter „Aufenthalt“.</p>`);
        if (s.wifi) {
            add('WLAN', `<dl class="guide-dl"><div><dt>Netzwerk</dt><dd>${esc(s.wifi.name)}</dd></div>
                ${s.wifi.password ? `<div><dt>Passwort</dt><dd><span class="mono-ish">${esc(s.wifi.password)}</span>
                <button type="button" class="copy-btn" data-copy="${esc(s.wifi.password)}">${COPY_ICON}<span>Kopieren</span></button></dd></div>` : ''}</dl>`);
        }
        add('An- & Abreise', `<dl class="guide-dl"><div><dt>Anreise</dt><dd>${fmt(s.checkin)}, ab ${esc(s.checkinTime)} Uhr</dd></div>
            <div><dt>Abreise</dt><dd>${fmt(s.checkout)}, bis ${esc(s.checkoutTime)} Uhr</dd></div></dl>
            ${s.arrivalInfo ? `<div class="prose">${esc(s.arrivalInfo)}</div>` : ''}`);
        const addr = (info && info.address) || '';
        if (addr) add('Adresse', `<div class="prose">${esc(addr)}</div><a class="text-link" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}" target="_blank" rel="noopener">Route in Google Maps</a>`);
        if (s.parking) add('Parken', `<div class="prose">${esc(s.parking)}</div>`);
        if (s.houseRules) add('Hausregeln', `<div class="prose">${esc(s.houseRules)}</div>`);
        const c = s.contact;
        if ((c && (c.phone || c.email)) || (s.chat && s.chat.url)) add('Kontakt & Notfall', `${c && (c.phone || c.email) ? `<p>${c.name ? esc(c.name) + '<br>' : ''}${c.phone ? `<a href="tel:${esc(c.phone.replace(/\s+/g, ''))}">${esc(c.phone)}</a>` : ''}${c.phone && c.email ? '<br>' : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</p>` : ''}${waButton(s.chat)}`);
        (s.guide || []).forEach(g => add(g.title, `<div class="prose">${esc(g.text)}</div>`));

        const key = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
        items.sort((a, b) => key(a.title).localeCompare(key(b.title), 'de'));
        const groups = [];
        items.forEach(it => {
            const L = /[A-Z]/.test(key(it.title)[0]) ? key(it.title)[0] : '#';
            if (!groups.length || groups[groups.length - 1].letter !== L) groups.push({ letter: L, items: [] });
            groups[groups.length - 1].items.push(it);
        });
        return `<div class="gapp-pane-head"><h2>Gästemappe A – Z</h2><p>Alles für Ihren Aufenthalt, von WLAN bis Hausregeln.</p></div>
            <div class="az-cols">${groups.map(g => `<div class="az-group"><div class="az-letter"><b>${g.letter}</b></div>
                ${g.items.map(it => `<details class="az-item"><summary>${esc(it.title)}${ICON.chev}</summary><div class="az-body">${it.html}</div></details>`).join('')}</div>`).join('')}</div>`;
    }

    // ---- Umgebung ---------------------------------------------------------
    function renderArea() {
        const cards = [];
        if (info.address || info.directions) {
            cards.push(`<div class="gcard tip"><span class="dist">So finden Sie uns</span><h3>Anfahrt</h3>
                ${info.address ? `<p class="prose">${esc(info.address)}</p>` : ''}${info.directions ? `<p class="prose">${esc(info.directions)}</p>` : ''}
                ${info.address ? `<a class="text-link" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(info.address)}" target="_blank" rel="noopener">Route planen</a>` : ''}</div>`);
        }
        info.tips.forEach(t => cards.push(`<div class="gcard tip">${t.distance ? `<span class="dist">${esc(t.distance)}</span>` : ''}<h3>${esc(t.name)}</h3>
            ${t.text ? `<p class="prose">${esc(t.text)}</p>` : ''}${t.url ? `<a class="text-link" href="${esc(t.url)}" target="_blank" rel="noopener">Mehr erfahren</a>` : ''}</div>`));
        return `<div class="gapp-pane-head"><h2>Umgebung &amp; Highlights</h2>${info.location ? `<p class="prose">${esc(info.location)}</p>` : '<p>Unsere Tipps für Ausflüge und den Alltag vor Ort.</p>'}</div>
            ${cards.length ? `<div class="area-grid">${cards.join('')}</div>` : '<p class="area-empty">Unsere Tipps folgen in Kürze.</p>'}`;
    }

    const WA_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.2A9.8 9.8 0 0 0 3.6 17l-1.4 4.8 5-1.3A9.8 9.8 0 1 0 12 2.2zm0 17.9a8.1 8.1 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.1 8.1 0 1 1 12 20.1zm4.5-6c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.4-.3z"/></svg>';
    const waButton = chat => chat && chat.url ? `<a class="wa-btn" href="${esc(chat.url)}" target="_blank" rel="noopener">${WA_ICON}<span>Per WhatsApp schreiben</span></a>` : '';

    function contactHtml(c, chat) {
        const hasContact = c && (c.phone || c.email);
        if (!hasContact && !(chat && chat.url)) return '';
        const lines = hasContact ? `<p>${c.name ? esc(c.name) + '<br>' : ''}${c.phone ? `<a href="tel:${esc(c.phone.replace(/\s+/g, ''))}">${esc(c.phone)}</a>` : ''}${c.phone && c.email ? ' · ' : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</p>` : '';
        return `<div class="gcard"><div class="info-block"><h4>Kontakt</h4>${lines}${chat && chat.url ? `<p class="wa-note">Fragen zum Aufenthalt? Schreiben Sie uns einfach, wir antworten so schnell wie möglich.</p>${waButton(chat)}` : ''}</div></div>`;
    }

    // Existing invoice: download + correction request. Otherwise the guest can create it once.
    function invoiceHtml(s) {
        const inv = s.invoice;
        if (inv) {
            return `<div class="info-block"><div class="invoice-row">
                <div><h4>Rechnung</h4><p>Nr. ${esc(inv.number)}${inv.date ? ` vom ${new Date(inv.date + 'T12:00:00').toLocaleDateString('de-DE')}` : ''} · ${inv.paid ? 'bezahlt' : 'offen'}</p></div>
                <div class="invoice-action"><button type="button" class="btn btn-ghost btn-small" data-invoice>Als PDF herunterladen</button>
                <div class="form-error" id="invoice-error" hidden></div></div></div>
                <button type="button" class="link-btn" data-toggle="invoice-fix-form">Etwas stimmt nicht? Korrektur anfragen</button>
                <form id="invoice-fix-form" class="invoice-form" novalidate hidden>
                    <p class="guide-fine">Eine erstellte Rechnung können Sie nicht mehr selbst ändern. Schreiben Sie uns, was falsch ist. Wir korrigieren die Rechnung und melden uns.</p>
                    <label>Was soll geändert werden?<textarea name="text" rows="3" maxlength="1000" required></textarea></label>
                    <div class="form-error" id="invoice-fix-error" hidden></div>
                    <button type="submit" class="btn btn-ghost btn-small">Anfrage senden</button><span class="saved" id="invoice-fix-saved" hidden>Gesendet, wir melden uns.</span>
                </form></div>`;
        }
        const o = s.invoiceOffer;
        if (!o) return '';
        const lines = o.positions.map(p => `<div><span>${p.qty > 1 ? `${p.qty} × ` : ''}${esc(p.desc)}${p.qty > 1 ? ` à ${money(p.price)}` : ''}</span><span>${money(p.qty * p.price)}</span></div>`).join('');
        return `<div class="info-block"><h4>Rechnung</h4>
            <p>Sie brauchen eine Rechnung? Ergänzen Sie Ihre Rechnungsdaten. Danach können Sie die Rechnung sofort als PDF herunterladen.</p>
            <button type="button" class="btn btn-dark btn-small" data-toggle="invoice-form">Rechnungsdaten eingeben</button>
            <form id="invoice-form" class="invoice-form" novalidate hidden>
                <label>Vor- und Nachname<input type="text" name="name" maxlength="80" autocomplete="name" value="${esc(o.name)}" required></label>
                <label>Firma <small>optional, nur für Firmenrechnungen</small><input type="text" name="company" maxlength="120" autocomplete="organization"></label>
                <label>Straße und Hausnummer<input type="text" name="street" maxlength="120" autocomplete="street-address" required></label>
                <div class="row">
                    <label>PLZ<input type="text" name="zip" maxlength="10" autocomplete="postal-code" required></label>
                    <label>Ort<input type="text" name="city" maxlength="80" autocomplete="address-level2" required></label>
                </div>
                <div class="row">
                    <label>Land<input type="text" name="country" maxlength="60" autocomplete="country-name" value="Deutschland"></label>
                    <label>USt-IdNr. <small>optional</small><input type="text" name="vatId" maxlength="20" placeholder="z. B. DE123456789"></label>
                </div>
                <div class="invoice-sum">${lines}
                    <div class="invoice-total"><span>Gesamtbetrag${o.mwstRate ? ` inkl. ${o.mwstRate} % MwSt.` : ''}</span><span>${money(o.total)}</span></div>
                    <p>${o.paid ? `Bereits bezahlt über ${esc(s.source)}.` : 'Zahlung per Überweisung, die Bankverbindung steht auf der Rechnung.'}</p>
                </div>
                <label class="check"><input type="checkbox" name="confirm" required> Meine Angaben stimmen. Danach kann ich die Rechnung nicht mehr selbst ändern.</label>
                <div class="form-error" id="invoice-form-error" hidden></div>
                <button type="submit" class="btn btn-dark btn-small">Rechnung erstellen</button>
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
        btn.textContent = 'Wird erstellt …';
        showError(err, '');
        try {
            const r = await fetch('api/me/rechnung', { credentials: 'same-origin' });
            if (!r.ok) throw new Error(await r.text().catch(() => '') || 'Download fehlgeschlagen.');
            const blob = await r.blob();
            const name = (/filename="?([^";]+)"?/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || 'Rechnung.pdf';
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        } catch (e) {
            showError(err, e.message.length < 200 ? e.message : 'Download fehlgeschlagen.');
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
                btn.disabled = true;
                btn.textContent = 'Wird erstellt …';
                const d = await api('me/rechnung', body).catch(() => ({}));
                if (!d.success) {
                    btn.disabled = false;
                    btn.textContent = 'Rechnung erstellen';
                    return showError(err, d.error || 'Das hat nicht geklappt. Bitte erneut versuchen.');
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
                showError($('#invoice-fix-error'), d.success ? '' : (d.error || 'Senden fehlgeschlagen.'));
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
            span.textContent = (await copyText(b.dataset.copy)) ? 'Kopiert' : 'Bitte manuell kopieren';
            b.classList.add('done');
            setTimeout(() => { span.textContent = 'Kopieren'; b.classList.remove('done'); }, 2000);
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
                if (!d.success) return showError(err, d.error || 'Speichern fehlgeschlagen.');
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
            const foreign = isForeign(form.elements.nationality.value);
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
            if (!el.persons.value) return showError(err, 'Bitte angeben, wie viele Personen übernachten.');
            const missing = companions.findIndex(c => !c.firstName.trim() || !c.lastName.trim() || !c.birthDate);
            if (missing >= 0) return showError(err, `Bitte bei Person ${missing + 2} Vorname, Familienname und Geburtsdatum eintragen.`);
            if (!el.confirm.checked) return showError(err, 'Bitte bestätigen Sie, dass Ihre Angaben stimmen.');
            const foreign = isForeign(el.nationality.value);
            const body = {
                firstName: el.firstName.value, lastName: el.lastName.value, birthDate: el.birthDate.value, nationality: el.nationality.value,
                idType: foreign ? el.idType.value : '', idNumber: foreign ? el.idNumber.value : '',
                street: el.street.value, zip: el.zip.value, city: el.city.value, country: el.country.value,
                phone: el.phone.value, email: el.email.value, persons: parseInt(el.persons.value, 10), companions, confirm: true
            };
            const btn = form.querySelector('[type=submit]');
            btn.disabled = true;
            btn.textContent = 'Wird gesendet …';
            const d = await api('me/meldeschein', body).catch(() => ({}));
            if (!d.success) {
                btn.disabled = false;
                btn.textContent = 'Meldeschein absenden';
                return showError(err, d.error || 'Das hat nicht geklappt. Bitte erneut versuchen.');
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
        $('#legal-title').textContent = imprint ? 'Impressum' : 'Datenschutz';
        const text = info ? (imprint ? info.imprint : info.privacy) : '';
        $('#legal-body').textContent = text || 'Dieser Text wird gerade vorbereitet.';
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
    (async () => {
        try { await loadInfo(); } catch (e) { /* page still usable */ }
        await loadMe(newCodeParam).catch(() => { $('#login-box').hidden = false; });
        if (newCodeParam || tabParam) history.replaceState(null, '', location.pathname);
        document.body.classList.add('ready');
        onHash();
    })();
})();
