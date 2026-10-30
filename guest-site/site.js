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
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
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

        observeReveals();

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
        q.classList.remove('q-in'); void q.offsetWidth; q.classList.add('q-in');
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
            // The request logged the guest in: continue on the booking page
            location.href = `meine-buchung?neu=${encodeURIComponent(d.code)}`;
        } catch (x) {
            showError(err, 'Keine Verbindung. Bitte später erneut versuchen.');
        } finally {
            btn.textContent = 'Unverbindlich anfragen';
            btn.disabled = !selOut;
        }
    });

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
        if (h === 'status') { location.replace('meine-buchung'); return; } // old links from e-mails
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
        const img = $('#lightbox-img');
        if (img.getAttribute('src') && !reduceMotion) {
            img.classList.add('swap');
            setTimeout(() => { img.src = photos[lbIndex]; }, 180);
        } else img.src = photos[lbIndex];
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

    $('#lightbox-img').addEventListener('load', e => e.target.classList.remove('swap'));

    // Photos open like a curtain the first time they scroll into view
    function observeReveals() {
        if (reduceMotion || !('IntersectionObserver' in window)) return;
        const io = new IntersectionObserver(entries => entries.forEach(e => {
            if (!e.isIntersecting) return;
            e.target.classList.remove('pending');
            io.unobserve(e.target);
        }), { rootMargin: '0px 0px -12% 0px' });
        document.querySelectorAll('#gallery button, #strip button').forEach((el, i) => {
            const r = el.getBoundingClientRect();
            if (r.top < innerHeight) return; // already on screen: no wipe
            el.classList.add('reveal', 'pending');
            el.style.transitionDelay = `${(i % 3) * 90}ms`;
            io.observe(el);
        });
    }

    // Cover drifts a little slower than the page
    const coverMedia = $('#hero-media');
    if (!reduceMotion) {
        let ticking = false;
        addEventListener('scroll', () => {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(() => {
                const y = Math.min(scrollY, innerHeight);
                coverMedia.style.transform = `translate3d(0, ${y * 0.25}px, 0)`;
                ticking = false;
            });
        }, { passive: true });
    }

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
        onHash();
    })();
})();
