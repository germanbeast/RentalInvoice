/* Hintergrund-Video der Ferienwohnung (stumm, Endlosschleife, leicht unscharf), siehe site-video.js.
   bgVideo(box, info): legt das Video in box (über ein vorhandenes Titelbild) und blendet es ein, sobald es läuft.
   Sparsam: lädt erst, wenn box sichtbar ist, pausiert außerhalb des Bildschirms und im Hintergrund-Tab;
   kein Video bei „Bewegung reduzieren“, Datensparmodus, langsamer Verbindung oder (falls abgeschaltet) auf Handys.
   Dann bleibt das Standbild bzw. das Titelbild stehen. */
(function () {
    const css = `.bgv { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.bgv img, .bgv video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.bgv video { opacity: 0; transition: opacity 1.2s ease; }
.bgv video.on { opacity: 1; }
.bgv.css-blur img, .bgv.css-blur video { transform: scale(1.08); }`;

    function addStyle() {
        if (document.getElementById('bgv-style')) return;
        const st = document.createElement('style');
        st.id = 'bgv-style';
        st.textContent = css;
        document.head.appendChild(st);
    }

    function allowed(info) {
        try {
            if (matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
            const c = navigator.connection || {};
            if (c.saveData || /(^|-)2g$|^3g$/.test(c.effectiveType || '')) return false;
            const phone = matchMedia('(max-width: 760px)').matches || (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600);
            if (phone && !info.phones) return false;
            // Mobilfunk erkennbar (nur Android/Chrome): nur mit Erlaubnis für Handys
            if (c.type === 'cellular' && !info.phones) return false;
        } catch (e) { /* alte Browser: Video versuchen */ }
        return true;
    }

    window.bgVideo = function (box, info, opts) {
        if (!box || !info || !info.url) return null;
        opts = opts || {};
        addStyle();
        const layer = document.createElement('div');
        layer.className = 'bgv';
        layer.setAttribute('aria-hidden', 'true');
        if (info.blur) {
            layer.classList.add('css-blur');
            layer.style.filter = `blur(${Number(info.blur) || 0}px)`;
        }
        // Standbild sofort; ein vorhandenes Titelbild bleibt darunter liegen, bis das Video läuft
        if (info.poster && opts.poster !== false) {
            const img = document.createElement('img');
            img.src = info.poster;
            img.alt = '';
            img.decoding = 'async';
            layer.appendChild(img);
        }
        box.appendChild(layer);
        if (!allowed(info)) return layer;

        let video = null;
        let visible = false;
        function start() {
            if (video) return;
            video = document.createElement('video');
            video.muted = true;
            video.defaultMuted = true;
            video.loop = true;
            video.playsInline = true;
            video.autoplay = true;
            video.preload = 'auto';
            ['muted', 'playsinline', 'webkit-playsinline', 'disablepictureinpicture', 'disableremoteplayback'].forEach(a => video.setAttribute(a, ''));
            if (info.poster) video.poster = info.poster;
            video.addEventListener('playing', () => video.classList.add('on'));
            video.addEventListener('error', () => { video.remove(); });
            video.src = info.url;
            layer.appendChild(video);
            play();
        }
        function play() {
            if (!video || document.hidden || !visible) return;
            const p = video.play();
            if (p && p.catch) p.catch(() => { /* Autoplay verboten: Standbild bleibt */ });
        }
        function pause() { if (video && !video.paused) video.pause(); }

        const io = 'IntersectionObserver' in window ? new IntersectionObserver(([e]) => {
            visible = e.isIntersecting;
            if (visible) { start(); play(); } else pause();
        }, { threshold: 0.01 }) : null;
        if (io) io.observe(box); else { visible = true; start(); }
        document.addEventListener('visibilitychange', () => (document.hidden ? pause() : play()));
        return layer;
    };
})();
