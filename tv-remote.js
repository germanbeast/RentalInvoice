// TV-Box Fernwartung: live picture + control of the Android box in the browser (ws-scrcpy) over ADB.
//
// The box sits behind the FRITZ!Box in the apartment, the server in a container on the Proxmox host, so the
// server cannot reach the box's ADB port directly. Instead the TV app opens an outgoing WebSocket to
// /api/tv-box/adb-tunnel (through Cloudflare, authenticated with the box's own key) and relays it to its own
// adbd on 127.0.0.1:5555. Here the tunnel is offered as a plain TCP port on 127.0.0.1 only
// (TV_ADB_PORT, default 15555), and the server runs `adb connect 127.0.0.1:15555`. ws-scrcpy (separate PM2
// process, see tools/tv-fernwartung.sh) listens on 127.0.0.1:8000 only and is reachable solely through the
// admin app: /tv-fernwartung/ (HTTP) and its WebSockets on "/?action=…", both after the admin login with the
// right "Einstellungen & Integrationen: Bearbeiten".
//
// Tunnel protocol (one WebSocket, several TCP connections):
//   text   {"t":"hello","adbLocal":true}     box → server, adbLocal = port 5555 on the box answers
//   text   {"t":"open","id":7}               server → box: connect to 127.0.0.1:5555 for connection 7
//   text   {"t":"opened","id":7} / {"t":"error","id":7,"msg":"…"}
//   text   {"t":"close","id":7}              both ways
//   binary [4 bytes id, big endian][data]    both ways

const net = require('net');
const http = require('http');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');

const TUNNEL_PATH = '/api/tv-box/adb-tunnel';
const MOUNT = '/tv-fernwartung';

module.exports = function createTvRemote({ db, permissions, sessionMiddleware, deviceAuthorized, isAdminHost }) {
    const ADB_PORT = parseInt(process.env.TV_ADB_PORT, 10) || 15555;
    const ADB_SERIAL = `127.0.0.1:${ADB_PORT}`;
    const ADB_BIN = process.env.ADB_PATH || 'adb';
    const scrcpyUrl = new URL(process.env.WS_SCRCPY_URL || 'http://127.0.0.1:8000');

    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
    let box = null;          // WebSocket of the box
    let boxInfo = null;      // { since, adbLocal, ip }
    let nextId = 1;
    const conns = new Map(); // id -> net.Socket (adb server side)
    let tcpServer = null;
    let adbState = { state: 'unbekannt', at: 0, error: '' };
    let adbTimer = null;

    function settings() {
        return { enabled: false, ...(db.getSetting('tvbox_remote') || {}) };
    }
    function enabled() { return !!settings().enabled; }

    // ---------------------------------------------------------------- adb on this server
    function adb(args, timeout = 15000) {
        return new Promise((resolve) => {
            execFile(ADB_BIN, args, { timeout }, (err, stdout, stderr) => {
                resolve({ ok: !err, out: String(stdout || '') + String(stderr || ''), missing: err && err.code === 'ENOENT' });
            });
        });
    }

    async function checkAdb(connect) {
        const list = await adb(['devices']);
        if (list.missing) { adbState = { state: 'kein adb', at: Date.now(), error: 'adb ist auf dem Server nicht installiert (tools/tv-fernwartung.sh)' }; return; }
        const line = list.out.split('\n').find(l => l.startsWith(ADB_SERIAL + '\t'));
        let state = line ? line.split('\t')[1].trim() : 'getrennt';
        if (state !== 'device' && state !== 'unauthorized' && connect && box) {
            const r = await adb(['connect', ADB_SERIAL]);
            const again = await adb(['devices']);
            const l2 = again.out.split('\n').find(l => l.startsWith(ADB_SERIAL + '\t'));
            state = l2 ? l2.split('\t')[1].trim() : 'getrennt';
            adbState = { state, at: Date.now(), error: state === 'device' || state === 'unauthorized' ? '' : r.out.trim().slice(0, 200) };
            return;
        }
        adbState = { state, at: Date.now(), error: '' };
    }

    function scheduleAdbCheck() {
        if (adbTimer) return;
        adbTimer = setInterval(() => {
            if (!box) { clearInterval(adbTimer); adbTimer = null; return; }
            checkAdb(true).catch(() => {});
        }, 60 * 1000);
        setTimeout(() => checkAdb(true).catch(() => {}), 1500);
    }

    // ---------------------------------------------------------------- local TCP port for adb
    function ensureTcpServer() {
        if (tcpServer) return;
        tcpServer = net.createServer((sock) => {
            if (!box || box.readyState !== 1) return sock.destroy();
            const id = nextId++;
            if (nextId > 0x7fffffff) nextId = 1;
            conns.set(id, sock);
            sock.setNoDelay(true);
            sock.pause(); // until the box has its own connection to adbd
            send({ t: 'open', id });
            sock.on('data', (chunk) => {
                if (!box || box.readyState !== 1) return sock.destroy();
                const head = Buffer.alloc(4);
                head.writeUInt32BE(id, 0);
                box.send(Buffer.concat([head, chunk]));
                if (box.bufferedAmount > 4 * 1024 * 1024) { // box too slow: wait
                    sock.pause();
                    const t = setInterval(() => {
                        if (!box || box.readyState !== 1 || sock.destroyed) { clearInterval(t); return; }
                        if (box.bufferedAmount < 1024 * 1024) { clearInterval(t); sock.resume(); }
                    }, 50);
                }
            });
            sock.on('close', () => {
                if (conns.get(id) === sock) { conns.delete(id); send({ t: 'close', id }); }
            });
            sock.on('error', () => {});
        });
        tcpServer.on('error', (e) => {
            console.error(`TV-Fernwartung: Port ${ADB_SERIAL} nicht verfügbar:`, e.message);
            tcpServer = null;
        });
        tcpServer.listen(ADB_PORT, '127.0.0.1');
    }

    function send(obj) {
        try { if (box && box.readyState === 1) box.send(JSON.stringify(obj)); } catch (e) { /* closed */ }
    }

    function closeAllConns() {
        for (const s of conns.values()) s.destroy();
        conns.clear();
    }

    function dropBox(reason) {
        if (box) { try { box.close(1000, reason || 'aus'); } catch (e) { /* */ } }
    }

    function onBoxConnection(ws, req) {
        if (box && box !== ws) { try { box.close(4000, 'neue Verbindung'); } catch (e) { /* */ } closeAllConns(); }
        box = ws;
        boxInfo = { since: Date.now(), adbLocal: null, ip: req.headers['cf-connecting-ip'] || req.socket.remoteAddress };
        ensureTcpServer();
        const ping = setInterval(() => { try { ws.ping(); } catch (e) { /* */ } }, 25 * 1000); // Cloudflare closes idle sockets after 100 s
        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
                if (buf.length < 4) return;
                const s = conns.get(buf.readUInt32BE(0));
                if (s && !s.destroyed) s.write(buf.subarray(4));
                return;
            }
            let m;
            try { m = JSON.parse(String(data)); } catch (e) { return; }
            if (!m || typeof m !== 'object') return;
            const s = conns.get(Number(m.id));
            if (m.t === 'hello') {
                boxInfo.adbLocal = !!m.adbLocal;
                if (boxInfo.adbLocal) scheduleAdbCheck();
            } else if (m.t === 'opened' && s) {
                s.resume();
            } else if ((m.t === 'close' || m.t === 'error') && s) {
                conns.delete(Number(m.id));
                s.destroy();
            }
        });
        ws.on('close', () => {
            clearInterval(ping);
            if (box === ws) {
                box = null;
                closeAllConns();
                adb(['disconnect', ADB_SERIAL]).then(() => { adbState = { state: 'getrennt', at: Date.now(), error: '' }; });
            }
        });
        ws.on('error', () => {});
    }
    wss.on('connection', onBoxConnection);

    // ---------------------------------------------------------------- admin login check (HTTP + WebSocket)
    function adminAllowed(req) {
        const su = req.session && req.session.user;
        if (!su) return false;
        const user = su.id ? db.getUserById(su.id) : db.getUser(su.username);
        return !!user && permissions.can(permissions.forUser(user), 'settings', 'edit');
    }

    function sameOrigin(req) {
        const origin = req.headers.origin;
        if (!origin) return true;
        try { return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch (e) { return false; }
    }

    function reject(socket, code, text) {
        try { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (e) { /* */ }
    }

    /** http server 'upgrade' handler: tunnel of the box, or ws-scrcpy's WebSockets for a logged-in admin. */
    function handleUpgrade(req, socket, head) {
        socket.on('error', () => {});
        try { routeUpgrade(req, socket, head); } catch (e) {
            console.error('TV-Fernwartung (WebSocket):', e.message);
            reject(socket, 500, 'Internal Server Error');
        }
    }

    function routeUpgrade(req, socket, head) {
        let url;
        try { url = new URL(req.url, 'http://x'); } catch (e) { return reject(socket, 400, 'Bad Request'); }

        if (url.pathname === TUNNEL_PATH) {
            if (!enabled()) return reject(socket, 403, 'Forbidden');
            // raw upgrade request: no express helpers, the box sends its key in the x-tvbox-auth header
            if (!req.get) req.get = (h) => req.headers[String(h).toLowerCase()];
            if (!req.cookies) req.cookies = {};
            let ok = false;
            try { ok = deviceAuthorized(req); } catch (e) { ok = false; }
            if (!ok) return reject(socket, 401, 'Unauthorized');
            return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
        }

        // ws-scrcpy opens its sockets on the page's host at "/?action=…"
        if (url.pathname === '/' && url.searchParams.has('action') && isAdminHost(req)) {
            if (!sameOrigin(req)) return reject(socket, 403, 'Forbidden');
            return sessionMiddleware(req, {}, () => {
                try {
                    if (!adminAllowed(req)) return reject(socket, 403, 'Forbidden');
                    proxyUpgrade(req, socket, head);
                } catch (e) { reject(socket, 500, 'Internal Server Error'); }
            });
        }
        reject(socket, 404, 'Not Found');
    }

    function proxyUpgrade(req, socket, head) {
        const up = net.connect(Number(scrcpyUrl.port) || 80, scrcpyUrl.hostname, () => {
            const lines = [`${req.method} ${req.url} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const k = req.rawHeaders[i];
                if (/^(cookie|host|cf-access-jwt-assertion)$/i.test(k)) continue; // session cookie stays here
                lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
            }
            lines.push(`Host: ${scrcpyUrl.host}`);
            up.write(lines.join('\r\n') + '\r\n\r\n');
            if (head && head.length) up.write(head);
            up.pipe(socket);
            socket.pipe(up);
        });
        up.on('error', () => reject(socket, 502, 'Bad Gateway'));
        socket.on('close', () => up.destroy());
        up.on('close', () => socket.destroy());
    }

    // ---------------------------------------------------------------- HTTP proxy for the ws-scrcpy page
    const CSP = "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; "
        + "connect-src 'self' ws: wss: blob:; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; "
        + "style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; frame-ancestors 'self'; base-uri 'self'";

    function httpProxy(req, res) {
        if (!isAdminHost(req)) return res.status(404).send('Not Found');
        if (!adminAllowed(req)) return res.status(403).send('Keine Berechtigung: Einstellungen & Integrationen (Bearbeiten)');
        if (req.originalUrl === MOUNT) return res.redirect(302, MOUNT + '/');
        if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).end();
        const target = req.url || '/';
        const headers = { ...req.headers, host: scrcpyUrl.host };
        delete headers.cookie;
        delete headers['cf-access-jwt-assertion'];
        const up = http.request({ hostname: scrcpyUrl.hostname, port: Number(scrcpyUrl.port) || 80, path: target, method: req.method, headers }, (r) => {
            for (const h of ['content-security-policy', 'x-frame-options', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'origin-agent-cluster']) res.removeHeader(h);
            res.status(r.statusCode);
            for (const [k, v] of Object.entries(r.headers)) {
                if (/^(connection|keep-alive|transfer-encoding|content-security-policy|set-cookie)$/i.test(k)) continue;
                res.setHeader(k, v);
            }
            res.setHeader('Content-Security-Policy', CSP);
            res.setHeader('Cache-Control', 'no-store');
            r.pipe(res);
        });
        up.on('error', () => {
            if (res.headersSent) return res.end();
            res.status(502).type('html').send('<!doctype html><meta charset="utf-8"><title>TV-Fernwartung</title>'
                + '<body style="font-family:sans-serif;padding:2rem;max-width:40rem">'
                + '<h2>Fernwartung ist auf dem Server nicht eingerichtet</h2>'
                + '<p>ws-scrcpy antwortet nicht. Im Container einmal <code>tools/tv-fernwartung.sh</code> ausführen '
                + '(Anleitung im Admin unter Einstellungen → TV-Box → Fernwartung), oder mit <code>pm2 status</code> prüfen, ob „ws-scrcpy“ läuft.</p></body>');
        });
        req.on('aborted', () => up.destroy());
        up.end();
    }

    function scrcpyRunning() {
        return new Promise((resolve) => {
            const r = http.get({ hostname: scrcpyUrl.hostname, port: Number(scrcpyUrl.port) || 80, path: '/', timeout: 2000 }, (res) => {
                res.resume();
                resolve(res.statusCode === 200);
            });
            r.on('timeout', () => { r.destroy(); resolve(false); });
            r.on('error', () => resolve(false));
        });
    }

    // ---------------------------------------------------------------- admin API
    async function status() {
        if (box) await checkAdb(false).catch(() => {});
        else {
            const v = await adb(['version'], 5000);
            if (v.missing) adbState = { state: 'kein adb', at: Date.now(), error: 'adb ist auf dem Server nicht installiert' };
        }
        return {
            enabled: enabled(),
            tunnel: box ? { since: boxInfo.since, adbLocal: boxInfo.adbLocal } : null,
            adb: adbState,
            serial: ADB_SERIAL,
            scrcpy: await scrcpyRunning(),
            url: MOUNT + '/'
        };
    }

    function registerAdminRoutes(app, { limiter }) {
        app.get('/api/settings/tvbox/remote', limiter, async (req, res) => {
            res.json({ success: true, ...(await status()) });
        });
        app.put('/api/settings/tvbox/remote', limiter, async (req, res) => {
            const on = !!(req.body || {}).enabled;
            db.setSetting('tvbox_remote', { ...settings(), enabled: on, updatedAt: Date.now() });
            if (!on) dropBox('Fernwartung ausgeschaltet');
            res.json({ success: true, ...(await status()) });
        });
        app.post('/api/settings/tvbox/remote/reconnect', limiter, async (req, res) => {
            if (box) {
                await adb(['disconnect', ADB_SERIAL]);
                await checkAdb(true).catch(() => {});
            }
            res.json({ success: true, ...(await status()) });
        });
        app.use(MOUNT, httpProxy);
    }

    /** Field for the box's sync answer: should the app keep the tunnel open? */
    function syncInfo() {
        return { adbTunnel: enabled() };
    }

    return { handleUpgrade, registerAdminRoutes, syncInfo, TUNNEL_PATH, MOUNT };
};
