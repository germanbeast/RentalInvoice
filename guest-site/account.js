/* Ferienwohnung – Gäste-Webseite · Meine Buchung (Login + Status) */
(() => {
    'use strict';

    const $ = s => document.querySelector(s);
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
        if (d.photos.length) $('#account-media').innerHTML = `<img src="${esc(d.photos[0])}" alt="">`;
        if (d.contact && (d.contact.phone || d.contact.email)) {
            $('#footer-contact').innerHTML = [
                d.contact.name ? esc(d.contact.name) : '',
                d.contact.phone ? `<a href="tel:${esc(d.contact.phone.replace(/\s+/g, ''))}">${esc(d.contact.phone)}</a>` : '',
                d.contact.email ? `<a href="mailto:${esc(d.contact.email)}">${esc(d.contact.email)}</a>` : ''
            ].filter(Boolean).join(' · ');
        }
    }

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
        document.body.classList.toggle('signed-in', !!d.success);
        if (!d.success) {
            $('#login-box').hidden = false;
            box.hidden = true;
            return;
        }
        $('#login-box').hidden = true;
        box.hidden = false;
        scrollTo(0, 0);
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
            if (s.state !== 'past') parts.push(guideHtml(s));
            if (s.invoice) parts.push(invoiceHtml(s.invoice));

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

    const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>';

    // Guest folder: everything a guest needs on site, door code first
    function guideHtml(s) {
        const items = [];
        if (s.pin) {
            items.push(`<section class="guide-item guide-pin"><h4>Ihr Türcode</h4><div class="pin">${esc(s.pin)}</div>
                <p class="guide-fine">Gültig ab Anreisetag ${esc(s.checkinTime)} Uhr bis Abreisetag ${esc(s.checkoutTime)} Uhr. Code eingeben und mit der Taste bestätigen.</p></section>`);
        } else if (s.pinLater) {
            items.push(`<section class="guide-item guide-pin"><h4>Ihr Türcode</h4>
                <p>Ihr persönlicher Türcode erscheint hier ${s.pinLater === 1 ? 'einen Tag' : `${s.pinLater} Tage`} vor der Anreise${s.daysUntil > s.pinLater ? `, also ab ${fmt(addDays(s.checkin, -s.pinLater))}` : ''}.</p></section>`);
        }
        if (s.wifi) {
            items.push(`<section class="guide-item"><h4>WLAN</h4>
                <dl class="guide-dl"><div><dt>Netzwerk</dt><dd>${esc(s.wifi.name)}</dd></div>
                ${s.wifi.password ? `<div><dt>Passwort</dt><dd><span class="mono-ish">${esc(s.wifi.password)}</span>
                    <button type="button" class="copy-btn" data-copy="${esc(s.wifi.password)}">${COPY_ICON}<span>Kopieren</span></button></dd></div>` : ''}</dl></section>`);
        }
        items.push(`<section class="guide-item"><h4>An- &amp; Abreise</h4>
            <dl class="guide-dl"><div><dt>Anreise</dt><dd>${fmt(s.checkin)}, ab ${esc(s.checkinTime)} Uhr</dd></div>
            <div><dt>Abreise</dt><dd>${fmt(s.checkout)}, bis ${esc(s.checkoutTime)} Uhr</dd></div></dl>
            ${s.arrivalInfo ? `<div class="prose">${esc(s.arrivalInfo)}</div>` : ''}</section>`);
        if (s.location) {
            const q = encodeURIComponent(s.location.split('\n').slice(0, 3).join(', '));
            items.push(`<section class="guide-item"><h4>Adresse</h4><div class="prose">${esc(s.location)}</div>
                <a class="text-link" href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">In Google Maps öffnen</a></section>`);
        }
        if (s.parking) items.push(`<section class="guide-item"><h4>Parken</h4><div class="prose">${esc(s.parking)}</div></section>`);
        if (s.houseRules) items.push(`<section class="guide-item"><h4>Hausregeln</h4><div class="prose">${esc(s.houseRules)}</div></section>`);
        (s.guide || []).forEach(g => items.push(`<section class="guide-item"><h4>${esc(g.title)}</h4><div class="prose">${esc(g.text)}</div></section>`));
        return `<div class="guide"><div class="guide-head"><h3>Ihre Gästemappe</h3><p>Alles für Ihren Aufenthalt an einem Ort.</p></div>
            <div class="guide-grid">${items.join('')}</div></div>`;
    }

    function invoiceHtml(inv) {
        return `<div class="info-block invoice-row">
            <div><h4>Rechnung</h4><p>Nr. ${esc(inv.number)}${inv.date ? ` vom ${new Date(inv.date + 'T12:00:00').toLocaleDateString('de-DE')}` : ''} · ${inv.paid ? 'bezahlt' : 'offen'}</p></div>
            <div class="invoice-action"><button type="button" class="btn btn-ghost btn-small" data-invoice>Als PDF herunterladen</button>
            <div class="form-error" id="invoice-error" hidden></div></div></div>`;
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

    function contactHtml(c) {
        if (!c || (!c.phone && !c.email)) return '';
        return `<div class="info-block"><h4>Kontakt</h4><p>${c.name ? esc(c.name) + '<br>' : ''}${c.phone ? `<a href="tel:${esc(c.phone.replace(/\s+/g, ''))}">${esc(c.phone)}</a>` : ''}${c.phone && c.email ? ' · ' : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</p></div>`;
    }

    function bindStatus() {
        const box = $('#guest-box');
        const out = box.querySelector('[data-logout]');
        if (out) out.addEventListener('click', async () => { await api('logout', {}); loadMe(); });
        box.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
            const span = b.querySelector('span');
            span.textContent = (await copyText(b.dataset.copy)) ? 'Kopiert' : 'Bitte manuell kopieren';
            b.classList.add('done');
            setTimeout(() => { span.textContent = 'Kopieren'; b.classList.remove('done'); }, 2000);
        }));
        const inv = box.querySelector('[data-invoice]');
        if (inv) inv.addEventListener('click', () => downloadInvoice(inv));
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
        if (newCodeParam) history.replaceState(null, '', location.pathname);
        document.body.classList.add('ready');
        onHash();
    })();
})();
