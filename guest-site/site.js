/* Ferienwohnung – Gäste-Webseite */
(() => {
    'use strict';

    const $ = s => document.querySelector(s);
    const api = (url, body) => fetch(`api/${url}`, body === undefined ? { credentials: 'same-origin' } : {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(async r => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));

    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
    const nights = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
    const fmt = ymd => ymd ? new Date(ymd + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '–';
    const fmtShort = ymd => ymd ? new Date(ymd + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–';
    const money = n => Number(n).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    const nightsTxt = n => `${n} ${n === 1 ? 'Nacht' : 'Nächte'}`;

    let info = null;
    let photos = [];
    let lbIndex = 0;
    let booked = [];
    let today = new Date().toISOString().slice(0, 10);
    let horizon = addDays(today, 540);
    let viewMonth = today.slice(0, 7);
    let selIn = null;
    let selOut = null;

    // ------------------------------------------------------------------
    // Site content
    // ------------------------------------------------------------------
    async function loadInfo() {
        const d = await api('info');
        if (!d.success) return;
        info = d;
        today = d.today;
        document.title = d.title;
        ['#brand', '#site-title', '#footer-title'].forEach(s => { $(s).textContent = d.title; });
        $('#site-tagline').textContent = d.tagline || '';
        // First paragraph becomes the large lede, the rest the body copy
        const paras = String(d.description || '').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
        $('#site-lede').textContent = paras[0] || '';
        $('#site-description').textContent = paras.slice(1).join('\n\n');
        $('#fact-guests').textContent = `bis ${d.maxGuests} Personen`;
        $('#fact-size-wrap').hidden = !d.sizeSqm;
        $('#fact-size').textContent = `${d.sizeSqm} m²`;
        $('#fact-bedrooms-wrap').hidden = !d.bedrooms;
        $('#fact-bedrooms').textContent = d.bedrooms;
        $('#fact-min').textContent = nightsTxt(d.minNights);
        $('#fact-checkin').textContent = `ab ${d.checkinTime} Uhr`;
        $('#fact-checkout').textContent = `bis ${d.checkoutTime} Uhr`;
        $('#site-features').innerHTML = d.features.map(f => `<li>${esc(f)}</li>`).join('');
        $('#amenities').hidden = !d.features.length;
        if (d.pricePerNight) {
            $('#hero-price').textContent = `ab ${money(d.pricePerNight)} pro Nacht`;
        }

        photos = d.photos;
        const thumb = (p, i) => `<button type="button" data-idx="${i}" aria-label="Foto ${i + 1} vergrößern"><img src="${esc(p)}" alt="" loading="lazy"></button>`;
        if (photos.length) $('#hero-media').innerHTML = `<img src="${esc(photos[0])}" alt="">`;
        // Spread: the next three photos (or the cover again when there is only one); the rest go into the strip
        const spread = photos.length > 1 ? photos.slice(1, 4).map((p, i) => thumb(p, i + 1)) : photos.map(thumb);
        $('#gallery').innerHTML = spread.join('');
        $('#spread').classList.toggle('no-photos', !photos.length);
        const rest = photos.slice(4);
        $('#strip').innerHTML = rest.map((p, i) => thumb(p, i + 4)).join('');
        $('#gallery-wrap').hidden = !rest.length;

        $('#voices-list').innerHTML = (d.testimonials || []).map(t => `<figure><blockquote>${esc(t.text)}</blockquote>${t.name ? `<figcaption>${esc(t.name)}</figcaption>` : ''}</figure>`).join('');
        $('#voices').hidden = !(d.testimonials || []).length;

        $('#location-block').hidden = !d.location;
        $('#site-location').textContent = d.location || '';
        $('#rules-block').hidden = !d.houseRules;
        $('#site-rules').textContent = d.houseRules || '';
        $('#lage').hidden = !d.location && !d.houseRules;

        if (d.contact && (d.contact.phone || d.contact.email)) {
            $('#footer-contact').innerHTML = [
                d.contact.name ? esc(d.contact.name) : '',
                d.contact.phone ? `<a href="tel:${esc(d.contact.phone.replace(/\s+/g, ''))}">${esc(d.contact.phone)}</a>` : '',
                d.contact.email ? `<a href="mailto:${esc(d.contact.email)}">${esc(d.contact.email)}</a>` : ''
            ].filter(Boolean).join(' · ');
        }

        const opts = (max, from) => Array.from({ length: max - from + 1 }, (_, i) => `<option value="${i + from}">${i + from}</option>`).join('');
        $('#f-adults').innerHTML = opts(d.maxGuests, 1);
        $('#f-adults').value = String(Math.min(2, d.maxGuests));
        $('#f-children').innerHTML = opts(Math.max(0, d.maxGuests - 1), 0);
    }

    // ------------------------------------------------------------------
    // Availability calendar
    // ------------------------------------------------------------------
    async function loadAvailability() {
        const d = await api('availability');
        if (!d.success) return;
        booked = d.booked;
        today = d.today;
        horizon = d.horizon;
        renderCalendar();
    }

    const takenNight = day => booked.some(r => r.from <= day && day < r.to);
    const minArrival = () => addDays(today, info ? info.leadDays : 1);
    const minNights = () => (info ? info.minNights : 1);

    function canArrive(day) {
        return day >= minArrival() && day <= horizon && !takenNight(day);
    }
    function canDepart(day) {
        if (!selIn || day <= selIn) return false;
        const n = nights(selIn, day);
        if (n < minNights() || n > 60) return false;
        for (let d = selIn; d < day; d = addDays(d, 1)) if (takenNight(d)) return false;
        return true;
    }

    function monthGrid(ym) {
        const [y, m] = ym.split('-').map(Number);
        const first = `${ym}-01`;
        const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
        const choosingOut = selIn && !selOut;
        const cells = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map(w => `<div class="cal-wd">${w}</div>`);
        for (let i = 0; i < lead; i++) cells.push('<div class="cal-blank"></div>');
        for (let i = 0; i < days; i++) {
            const day = addDays(first, i);
            const cls = ['cal-day'];
            const taken = takenNight(day);
            let enabled;
            if (day < today) cls.push('past');
            else if (taken) cls.push(takenNight(addDays(day, -1)) ? 'taken' : 'checkout-only');
            if (day === today) cls.push('today');
            if (choosingOut) enabled = canDepart(day) || canArrive(day);
            else enabled = canArrive(day);
            if (selIn && day === selIn) cls.push('sel-start');
            if (selOut && day === selOut) cls.push('sel-end');
            if (selIn && selOut && day > selIn && day < selOut) cls.push('in-range');
            const label = new Date(day + 'T12:00:00').toLocaleDateString('de-DE', { day: 'numeric', month: 'long' });
            cells.push(`<button type="button" class="${cls.join(' ')}" data-day="${day}" ${enabled ? '' : 'disabled'} aria-label="${label}${taken ? ', belegt' : ''}">${i + 1}</button>`);
        }
        const title = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        return `<div class="cal-month"><h3>${title}</h3><div class="cal-grid">${cells.join('')}</div></div>`;
    }

    const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };

    function renderCalendar() {
        $('#cal-months').innerHTML = monthGrid(viewMonth) + monthGrid(shiftMonth(viewMonth, 1));
        $('#cal-prev').disabled = viewMonth <= today.slice(0, 7);
        $('#cal-next').disabled = shiftMonth(viewMonth, 1) >= horizon.slice(0, 7);
        $('#cal-hint').textContent = !selIn ? 'Anreisetag wählen' : !selOut ? `Abreisetag wählen (mind. ${nightsTxt(minNights())})` : 'Zeitraum gewählt – zum Ändern neu klicken';
        $('#sel-in').textContent = selIn ? fmtShort(selIn) : '–';
        $('#sel-out').textContent = selOut ? fmtShort(selOut) : '–';
        $('#sel-nights').textContent = selIn && selOut ? nights(selIn, selOut) : '–';
    }

    $('#cal-months').addEventListener('click', e => {
        const btn = e.target.closest('[data-day]');
        if (!btn || btn.disabled) return;
        const day = btn.dataset.day;
        if (selIn && !selOut && canDepart(day)) {
            selOut = day;
            updateQuote();
        } else {
            selIn = day;
            selOut = null;
            $('#quote').hidden = true;
            $('#request-submit').disabled = true;
        }
        renderCalendar();
    });
    $('#cal-prev').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, -1); renderCalendar(); });
    $('#cal-next').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, 1); renderCalendar(); });

    async function updateQuote() {
        const q = $('#quote');
        const d = await api('quote', { checkin: selIn, checkout: selOut });
        q.classList.toggle('q-error', !d.success);
        if (!d.success) {
            q.hidden = false;
            q.innerHTML = esc(d.error || 'Zeitraum nicht verfügbar.');
            $('#request-submit').disabled = true;
            return;
        }
        q.hidden = !d.total;
        if (d.total) {
            q.innerHTML = `
                <div class="q-row"><span>${nightsTxt(d.nights)} × ${money(d.night)}</span><span>${money(d.nights * d.night)}</span></div>
                ${d.cleaning ? `<div class="q-row"><span>Endreinigung</span><span>${money(d.cleaning)}</span></div>` : ''}
                <div class="q-row q-total"><span>Voraussichtlich gesamt</span><span>${money(d.total)}</span></div>`;
        }
        $('#request-submit').disabled = false;
    }

    // ------------------------------------------------------------------
    // Booking request
    // ------------------------------------------------------------------
    const showError = (el, msg) => { el.textContent = msg; el.hidden = !msg; };

    $('#request-form').addEventListener('submit', async e => {
        e.preventDefault();
        const f = e.target;
        const err = $('#request-error');
        if (!selIn || !selOut) return showError(err, 'Bitte zuerst den Zeitraum im Kalender wählen.');
        const data = Object.fromEntries(new FormData(f).entries());
        data.privacy = f.privacy.checked;
        data.checkin = selIn;
        data.checkout = selOut;
        const btn = $('#request-submit');
        btn.disabled = true;
        btn.textContent = 'Wird gesendet …';
        try {
            const d = await api('request', data);
            if (!d.success) { showError(err, d.error || 'Die Anfrage konnte nicht gesendet werden.'); return; }
            showError(err, '');
            f.reset();
            selIn = selOut = null;
            $('#quote').hidden = true;
            renderCalendar();
            await loadMe(d.code);
            location.hash = '#status';
            $('#status').scrollIntoView({ behavior: 'smooth' });
        } catch (x) {
            showError(err, 'Keine Verbindung. Bitte später erneut versuchen.');
        } finally {
            btn.textContent = 'Unverbindlich anfragen';
            btn.disabled = !selOut;
        }
    });

    // ------------------------------------------------------------------
    // Guest login & status
    // ------------------------------------------------------------------
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

    const STATUS = {
        pending: ['pending', 'Anfrage wird geprüft'],
        confirmed: ['confirmed', 'Bestätigt'],
        declined: ['declined', 'Leider abgelehnt'],
        cancelled: ['cancelled', 'Storniert'],
        gone: ['gone', 'Nicht mehr vorhanden']
    };

    async function loadMe(newCode) {
        const d = await api('me');
        const box = $('#guest-box');
        if (!d.success) {
            $('#login-box').hidden = false;
            box.hidden = true;
            return;
        }
        $('#login-box').hidden = true;
        box.hidden = false;
        box.innerHTML = renderStatus(d.status, newCode);
        bindStatus(d.status);
    }

    function stateLine(s) {
        if (s.status !== 'confirmed') return '';
        if (s.state === 'inhouse') return 'Schön, dass Sie da sind!';
        if (s.state === 'departing') return 'Heute ist Ihr Abreisetag. Gute Heimreise!';
        if (s.state === 'past') return 'Danke für Ihren Besuch!';
        if (s.daysUntil === 0) return 'Heute ist Ihr Anreisetag.';
        return s.daysUntil === 1 ? 'Morgen geht es los!' : `Noch ${s.daysUntil} Tage bis zur Anreise.`;
    }

    function renderStatus(s, newCode) {
        const [cls, label] = STATUS[s.status] || STATUS.pending;
        if (s.status === 'gone') {
            return `<div class="status-card"><div class="status-head"><h3>Buchung ${esc(s.code || '')}</h3><span class="badge ${cls}">${label}</span></div>
                <p>Diese Buchung finden wir nicht mehr. Möglicherweise wurde sie über das Buchungsportal storniert. Bei Fragen melden Sie sich gerne bei uns.</p>
                ${contactHtml(s.contact)}<div class="guest-actions"><button type="button" class="btn btn-ghost btn-small" data-logout>Abmelden</button></div></div>`;
        }
        const guests = s.guests ? `${s.guests.adults} Erw.${s.guests.children ? ` + ${s.guests.children} Kind${s.guests.children === 1 ? '' : 'er'}` : ''}` : '';
        const parts = [];
        if (newCode) {
            parts.push(`<div class="code-box"><div>Vielen Dank für Ihre Anfrage! Ihr Buchungscode:<br><strong>${esc(newCode)}</strong></div>
                <small>Bitte notieren. Damit und mit Ihrem Anreisedatum rufen Sie den Status jederzeit ab.</small></div>`);
        }
        parts.push(`<div class="status-head"><h3>${s.name ? esc(s.name) : 'Ihre Buchung'}</h3><span class="badge ${cls}">${label}</span></div>`);
        const line = stateLine(s);
        if (line) parts.push(`<p>${esc(line)}</p>`);
        parts.push(`<div class="stay-grid">
            <div><span>Anreise</span><strong>${fmt(s.checkin)}</strong></div>
            <div><span>Abreise</span><strong>${fmt(s.checkout)}</strong></div>
            <div><span>Aufenthalt</span><strong>${nightsTxt(s.nights)}${guests ? ` · ${guests}` : ''}</strong></div>
            <div><span>Gebucht über</span><strong>${esc(s.source)}</strong></div>
            <div><span>Buchungscode</span><strong>${esc(s.code || '–')}</strong></div>
            ${s.priceTotal ? `<div><span>Preis</span><strong>${money(s.priceTotal)}</strong></div>` : ''}
        </div>`);

        if (s.status === 'pending') {
            parts.push(`<p>Wir prüfen Ihre Anfrage und melden uns per E-Mail${s.details && s.details.email ? ` an <strong>${esc(s.details.email)}</strong>` : ''}. Auf dieser Seite sehen Sie den aktuellen Stand.</p>`);
        }
        if (s.hostNote) parts.push(`<div class="info-block"><h4>Nachricht von uns</h4><div class="note prose">${esc(s.hostNote)}</div></div>`);

        if (s.status === 'confirmed') {
            if (s.payment && s.state !== 'past') {
                parts.push(`<div class="info-block"><h4>Zahlung</h4><div class="prose">${esc(s.payment.text)}</div>
                    ${s.payment.bank ? `<div class="note prose" style="margin-top:.6rem">${esc(s.payment.bank)}\nVerwendungszweck: ${esc(s.payment.reference)}</div>` : ''}</div>`);
            }
            if (s.pin) {
                parts.push(`<div class="info-block"><h4>Ihr Türcode</h4><div class="pin">${esc(s.pin)}</div>
                    <p class="fine" style="text-align:left">Gültig ab Anreisetag ${esc(s.checkinTime)} Uhr bis Abreisetag ${esc(s.checkoutTime)} Uhr. Code eingeben und mit der Taste bestätigen.</p></div>`);
            } else if (s.pinLater) {
                parts.push(`<div class="info-block"><h4>Ihr Türcode</h4><p>Ihr persönlicher Türcode erscheint hier ${s.pinLater === 1 ? 'einen Tag' : `${s.pinLater} Tage`} vor der Anreise.</p></div>`);
            }
            if (s.arrivalInfo && s.state !== 'past') parts.push(`<div class="info-block"><h4>Anreise</h4><div class="prose">${esc(s.arrivalInfo)}</div></div>`);
            if (s.location && s.state !== 'past') parts.push(`<div class="info-block"><h4>Adresse &amp; Lage</h4><div class="prose">${esc(s.location)}</div></div>`);
            if (s.houseRules && s.state !== 'past') parts.push(`<div class="info-block"><h4>Hausregeln</h4><div class="prose">${esc(s.houseRules)}</div></div>`);

            if (s.kind === 'booking' && s.state !== 'past') {
                const dt = s.details || {};
                parts.push(`<div class="info-block"><h4>${s.needsDetails ? 'Bitte ergänzen Sie Ihre Daten' : 'Ihre Daten'}</h4>
                    ${s.needsDetails ? '<p>Das Buchungsportal hat uns Ihren Namen nicht übermittelt. Damit wir Sie begrüßen können, tragen Sie ihn bitte kurz ein.</p>' : ''}
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
                    </form></div>`);
            }
        }
        if (s.status === 'declined') parts.push('<p>Für den gewünschten Zeitraum können wir Ihnen leider keine Zusage geben. Schauen Sie gerne nach einem anderen Termin im Kalender.</p>');
        if (s.status === 'cancelled') parts.push('<p>Diese Buchung wurde storniert. Bei Fragen melden Sie sich gerne bei uns.</p>');
        parts.push(contactHtml(s.contact));
        parts.push('<div class="guest-actions"><button type="button" class="btn btn-ghost btn-small" data-logout>Abmelden</button></div>');
        return `<div class="status-card">${parts.join('')}</div>`;
    }

    function contactHtml(c) {
        if (!c || (!c.phone && !c.email)) return '';
        return `<div class="info-block"><h4>Kontakt</h4><p>${c.name ? esc(c.name) + '<br>' : ''}${c.phone ? `<a href="tel:${esc(c.phone.replace(/\s+/g, ''))}">${esc(c.phone)}</a>` : ''}${c.phone && c.email ? ' · ' : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</p></div>`;
    }

    function bindStatus() {
        const box = $('#guest-box');
        const out = box.querySelector('[data-logout]');
        if (out) out.addEventListener('click', async () => { await api('logout', {}); loadMe(); });
        const form = box.querySelector('#details-form');
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

    // ------------------------------------------------------------------
    // Legal overlays & lightbox
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
    document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

    function showPhoto(i) {
        lbIndex = (i + photos.length) % photos.length;
        $('#lightbox-img').src = photos[lbIndex];
        $('#lightbox-count').textContent = `${lbIndex + 1} / ${photos.length}`;
        $('#lightbox-prev').hidden = $('#lightbox-next').hidden = photos.length < 2;
    }
    function openPhoto(e) {
        const b = e.target.closest('[data-idx]');
        if (!b) return;
        showPhoto(Number(b.dataset.idx));
        $('#lightbox').showModal();
    }
    $('#gallery').addEventListener('click', openPhoto);
    $('#strip').addEventListener('click', openPhoto);
    $('#lightbox-close').addEventListener('click', () => $('#lightbox').close());
    $('#lightbox-prev').addEventListener('click', () => showPhoto(lbIndex - 1));
    $('#lightbox-next').addEventListener('click', () => showPhoto(lbIndex + 1));
    $('#lightbox').addEventListener('keydown', e => {
        if (e.key === 'ArrowLeft') showPhoto(lbIndex - 1);
        if (e.key === 'ArrowRight') showPhoto(lbIndex + 1);
    });

    // Masthead turns solid once the cover has scrolled away
    const mast = $('#masthead');
    new IntersectionObserver(([e]) => mast.classList.toggle('solid', !e.isIntersecting), { rootMargin: '-72px 0px 0px 0px' }).observe($('#hero'));

    // ------------------------------------------------------------------
    (async () => {
        try { await loadInfo(); } catch (e) { /* page still usable */ }
        viewMonth = minArrival().slice(0, 7);
        // Phones show one month: skip to the next one when only a few days of this month are left
        if (window.innerWidth <= 600 && nights(minArrival(), addDays(shiftMonth(viewMonth, 1) + '-01', 0)) < 10) viewMonth = shiftMonth(viewMonth, 1);
        loadAvailability().catch(() => { $('#cal-months').innerHTML = '<p>Kalender konnte nicht geladen werden.</p>'; });
        loadMe().catch(() => { });
        onHash();
    })();
})();
