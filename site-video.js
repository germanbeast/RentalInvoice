/**
 * Hintergrund-Video der Ferienwohnung (stumm, Endlosschleife, leicht unscharf)
 *
 *  - Upload im Admin (Webseite → Bilder) in Stücken von 8 MB: Cloudflare lässt nur 100 MB pro Anfrage durch,
 *    Handy-Videos sind oft größer.
 *  - ffmpeg des Servers (sudo apt install ffmpeg, setup.sh installiert es mit) macht daraus:
 *      master  1280 px, H.264, ohne Ton, höchstens 60 s (bleibt liegen, damit eine neue Unschärfe ohne neuen Upload geht)
 *      video   960 px mit eingerechneter Unschärfe (gblur): klein, und schwache TV-Boxen/Handys müssen nichts weichzeichnen
 *      poster  Standbild daraus, wird sofort gezeigt und bleibt, wenn das Video nicht laufen darf
 *    Ohne ffmpeg wird eine MP4/WebM-Datei unverändert übernommen und die Unschärfe per CSS gemacht.
 *  - Öffentlich unter /hintergrund-video/<datei> (vor der Gäste-Domain-Umleitung, damit die TV-Box es auch bekommt).
 *  - Wo es läuft: Startseite, Meine Buchung, TV, jeweils abschaltbar; auf Handys optional.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const VIDEO_DIR = path.join(__dirname, 'uploads', 'site-video');
const TMP_DIR = path.join(VIDEO_DIR, 'tmp');
const CHUNK_MAX = 8 * 1024 * 1024;
const UPLOAD_MAX = 2 * 1024 * 1024 * 1024; // 2 GB Rohvideo
const MAX_SECONDS = 60;
const RAW_MAX = 60 * 1024 * 1024; // ohne ffmpeg wird die Datei unverändert ausgeliefert
const DEFAULTS = { file: '', poster: '', master: '', baked: false, blur: 6, on_site: true, on_account: true, on_tv: true, phones: true, duration: 0, width: 0, height: 0, size: 0, updated: '' };

let ffmpegPath = null;
function findFfmpeg() {
    if (ffmpegPath !== null) return ffmpegPath;
    const candidates = [process.env.FFMPEG_PATH, 'ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].filter(Boolean);
    for (const c of candidates) {
        try {
            const r = spawnSync(c, ['-version'], { timeout: 8000 });
            if (r.status === 0) { ffmpegPath = c; return c; }
        } catch (e) { /* next */ }
    }
    ffmpegPath = '';
    return '';
}

function createSiteVideo({ db, express }) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    // Reste abgebrochener Uploads vom letzten Lauf
    try { fs.readdirSync(TMP_DIR).forEach(f => fs.unlink(path.join(TMP_DIR, f), () => { })); } catch (e) { /* ignore */ }

    const uploads = new Map(); // id -> { path, size, total, name, started }
    let job = null;            // { state: 'processing'|'error', step, progress, error }

    function get() {
        const v = db.getAllSettings().site_video;
        return { ...DEFAULTS, ...(v && typeof v === 'object' ? v : {}) };
    }
    function set(v) { db.setSetting('site_video', v); }

    const blurSigma = b => Math.max(0, Math.min(20, Number(b) || 0));
    const fileUrl = f => `/hintergrund-video/${encodeURIComponent(f)}`;

    /** Für Gästeseiten und TV: null, wenn es dort kein Video gibt */
    function publicInfo(where) {
        const v = get();
        if (!v.file) return null;
        if (where === 'site' && !v.on_site) return null;
        if (where === 'account' && !v.on_account) return null;
        if (where === 'tv' && !v.on_tv) return null;
        return {
            url: fileUrl(v.file),
            poster: v.poster ? fileUrl(v.poster) : '',
            blur: v.baked ? 0 : blurSigma(v.blur), // schon eingerechnet → nichts mehr per CSS
            phones: where === 'tv' ? true : !!v.phones
        };
    }

    function serveFile(req, res) {
        const file = path.basename(String(req.params.file || ''));
        const v = get();
        if (!file || ![v.file, v.poster].includes(file)) return res.status(404).end();
        res.set('Cache-Control', 'public, max-age=604800, immutable'); // jeder Durchlauf bekommt neue Dateinamen
        res.sendFile(path.join(VIDEO_DIR, file));
    }

    // ---------------------------------------------------------------- ffmpeg
    function run(args, durationHint, step) {
        return new Promise((resolve, reject) => {
            const p = spawn(findFfmpeg(), ['-hide_banner', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
            let err = '';
            p.stderr.on('data', d => {
                const s = d.toString();
                err = (err + s).slice(-4000);
                const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
                if (m && durationHint && job) {
                    const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
                    job.step = step;
                    job.progress = Math.min(99, Math.round(t / durationHint * 100));
                }
            });
            p.on('error', reject);
            p.on('close', code => code === 0 ? resolve(err) : reject(new Error(lastLine(err) || `ffmpeg Fehler ${code}`)));
        });
    }
    const lastLine = s => String(s || '').trim().split('\n').filter(l => !/^\s*(frame|size)=/.test(l)).slice(-1)[0] || '';

    function probe(file) {
        // ffmpeg -i schreibt die Eckdaten nach stderr und endet mit Fehler (keine Ausgabe), das ist gewollt
        const r = spawnSync(findFfmpeg(), ['-hide_banner', '-i', file], { timeout: 30000 });
        const s = String(r.stderr || '');
        const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
        const v = /Stream #.*Video:.*?(\d{2,5})x(\d{2,5})/.exec(s);
        const rot = /rotate\s*:\s*(-?\d+)|rotation of (-?\d+(?:\.\d+)?)/.exec(s);
        return {
            hasVideo: !!v,
            duration: d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0,
            width: v ? +v[1] : 0, height: v ? +v[2] : 0,
            rotated: rot ? Math.abs(Math.round(parseFloat(rot[1] || rot[2]))) % 180 === 90 : false
        };
    }

    const stamp = () => `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

    /** Aus dem Master das unscharfe Video + Standbild machen */
    async function renderBlurred(masterFile, blur, duration) {
        const sigma = blurSigma(blur);
        const id = stamp();
        const out = `bg-${id}.mp4`;
        const poster = `bg-${id}.jpg`;
        const vf = ["scale='if(gt(iw,ih),min(960,iw),-2)':'if(gt(iw,ih),-2,min(960,ih))'", sigma ? `gblur=sigma=${sigma * 1.6}:steps=2` : null, 'format=yuv420p'].filter(Boolean).join(',');
        await run(['-i', path.join(VIDEO_DIR, masterFile), '-an', '-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', sigma ? '30' : '26',
            '-profile:v', 'main', '-movflags', '+faststart', '-threads', '2', path.join(VIDEO_DIR, out)], duration, 'blur');
        await run(['-ss', String(Math.min(1, Math.max(0, duration / 3))), '-i', path.join(VIDEO_DIR, out), '-frames:v', '1', '-q:v', '4', path.join(VIDEO_DIR, poster)], 0, 'poster');
        return { file: out, poster };
    }

    function removeFiles(...files) {
        files.filter(Boolean).forEach(f => fs.unlink(path.join(VIDEO_DIR, path.basename(f)), () => { }));
    }

    async function processUpload(src, origName) {
        job = { state: 'processing', step: 'master', progress: 0, error: '' };
        const old = get();
        try {
            if (!findFfmpeg()) {
                // Ohne ffmpeg: nur abspielbare Formate, Unschärfe macht der Browser
                if (!/\.(mp4|m4v|webm)$/i.test(origName)) throw new Error('Auf dem Server fehlt ffmpeg (sudo apt install ffmpeg). Ohne ffmpeg geht nur eine MP4- oder WebM-Datei.');
                if (fs.statSync(src).size > RAW_MAX) throw new Error('Auf dem Server fehlt ffmpeg (sudo apt install ffmpeg). Ohne ffmpeg darf das Video höchstens 60 MB groß sein.');
                const file = `bg-${stamp()}${path.extname(origName).toLowerCase().replace('.m4v', '.mp4')}`;
                fs.renameSync(src, path.join(VIDEO_DIR, file));
                set({ ...old, file, poster: '', master: '', baked: false, duration: 0, width: 0, height: 0, size: fs.statSync(path.join(VIDEO_DIR, file)).size, updated: new Date().toISOString() });
                removeFiles(old.file, old.poster, old.master);
                job = null;
                return;
            }
            const info = probe(src);
            if (!info.hasVideo) throw new Error('Die Datei enthält kein Video, das der Server lesen kann.');
            const duration = Math.min(MAX_SECONDS, info.duration || MAX_SECONDS);
            const master = `master-${stamp()}.mp4`;
            // Längere Seite höchstens 1280 px, 30 Bilder/s; die Drehung aus dem Handy wendet ffmpeg selbst an
            await run(['-i', src, '-t', String(MAX_SECONDS), '-an', '-vf', "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))',fps=30,format=yuv420p",
                '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-movflags', '+faststart', '-threads', '2', path.join(VIDEO_DIR, master)], duration, 'master');
            fs.unlink(src, () => { });
            const m = probe(path.join(VIDEO_DIR, master));
            const out = await renderBlurred(master, old.blur, duration);
            set({ ...old, ...out, master, baked: true, duration: Math.round(m.duration || duration), width: m.width, height: m.height,
                size: fs.statSync(path.join(VIDEO_DIR, out.file)).size, updated: new Date().toISOString() });
            removeFiles(old.file, old.poster, old.master);
            job = null;
        } catch (e) {
            fs.unlink(src, () => { });
            console.error('Hintergrund-Video:', e.message);
            job = { state: 'error', step: '', progress: 0, error: e.message };
        }
    }

    async function reblur(blur) {
        const v = get();
        job = { state: 'processing', step: 'blur', progress: 0, error: '' };
        try {
            const out = await renderBlurred(v.master, blur, v.duration || MAX_SECONDS);
            const cur = get();
            set({ ...cur, ...out, blur: blurSigma(blur), baked: true, size: fs.statSync(path.join(VIDEO_DIR, out.file)).size, updated: new Date().toISOString() });
            removeFiles(cur.file, cur.poster);
            job = null;
        } catch (e) {
            console.error('Hintergrund-Video (Unschärfe):', e.message);
            job = { state: 'error', step: '', progress: 0, error: e.message };
        }
    }

    function status() {
        const v = get();
        return {
            success: true,
            video: { ...v, url: v.file ? fileUrl(v.file) : '', posterUrl: v.poster ? fileUrl(v.poster) : '' },
            job: job ? { ...job } : null,
            ffmpeg: !!findFfmpeg(),
            chunkSize: CHUNK_MAX
        };
    }

    // ---------------------------------------------------------------- Admin
    function registerAdminRoutes(app, apiLimiter) {
        // Uploads in Stücken laufen schneller als das allgemeine Limit (120/min), darum ein eigenes
        const chunkBody = express.raw({ type: 'application/octet-stream', limit: CHUNK_MAX + 1024 });

        app.get('/api/site/video', apiLimiter, (req, res) => { if (!ffmpegPath) ffmpegPath = null; res.json(status()); });

        app.post('/api/site/video/start', apiLimiter, (req, res) => {
            const b = req.body || {};
            const size = Number(b.size) || 0;
            const name = path.basename(String(b.name || 'video')).slice(0, 120);
            if (job && job.state === 'processing') return res.status(409).json({ success: false, error: 'Es wird gerade noch ein Video verarbeitet.' });
            if (!size || size > UPLOAD_MAX) return res.status(400).json({ success: false, error: 'Das Video darf höchstens 2 GB groß sein.' });
            if (!/\.(mp4|m4v|mov|webm|mkv|avi|3gp|mts)$/i.test(name)) return res.status(400).json({ success: false, error: 'Bitte eine Videodatei wählen (MP4, MOV, WebM …).' });
            // Nur ein Upload gleichzeitig
            uploads.forEach(u => fs.unlink(u.path, () => { }));
            uploads.clear();
            const id = crypto.randomBytes(12).toString('hex');
            const p = path.join(TMP_DIR, `${id}${path.extname(name).toLowerCase()}`);
            fs.writeFileSync(p, Buffer.alloc(0));
            uploads.set(id, { path: p, size: 0, total: size, name, started: Date.now() });
            res.json({ success: true, id, chunkSize: CHUNK_MAX });
        });

        app.post('/api/site/video/chunk/:id', chunkBody, (req, res) => {
            const u = uploads.get(String(req.params.id));
            if (!u) return res.status(404).json({ success: false, error: 'Upload abgelaufen. Bitte neu starten.' });
            const offset = Number(req.query.offset);
            if (offset !== u.size) return res.status(409).json({ success: false, error: 'Falsche Reihenfolge', size: u.size });
            const buf = Buffer.isBuffer(req.body) ? req.body : null;
            if (!buf || !buf.length) return res.status(400).json({ success: false, error: 'Leeres Stück' });
            if (u.size + buf.length > u.total) return res.status(400).json({ success: false, error: 'Mehr Daten als angekündigt' });
            fs.appendFile(u.path, buf, err => {
                if (err) return res.status(500).json({ success: false, error: 'Speichern fehlgeschlagen (Speicherplatz?)' });
                u.size += buf.length;
                res.json({ success: true, size: u.size });
            });
        });

        app.post('/api/site/video/finish/:id', apiLimiter, (req, res) => {
            const id = String(req.params.id);
            const u = uploads.get(id);
            if (!u) return res.status(404).json({ success: false, error: 'Upload abgelaufen. Bitte neu starten.' });
            if (u.size !== u.total) return res.status(400).json({ success: false, error: 'Upload unvollständig' });
            uploads.delete(id);
            processUpload(u.path, u.name);
            res.json(status());
        });

        app.put('/api/site/video', apiLimiter, (req, res) => {
            const b = req.body || {};
            const v = get();
            const blur = b.blur == null ? v.blur : blurSigma(Math.round(Number(b.blur)));
            const next = { ...v, on_site: b.on_site !== false, on_account: b.on_account !== false, on_tv: b.on_tv !== false, phones: b.phones !== false };
            const needReblur = blur !== v.blur && v.master && findFfmpeg();
            if (needReblur && job && job.state === 'processing') return res.status(409).json({ success: false, error: 'Es wird gerade noch ein Video verarbeitet.' });
            if (!needReblur) next.blur = blur;
            set(next);
            if (needReblur) reblur(blur);
            res.json(status());
        });

        app.delete('/api/site/video', apiLimiter, (req, res) => {
            if (job && job.state === 'processing') return res.status(409).json({ success: false, error: 'Bitte warten, bis die Verarbeitung fertig ist.' });
            const v = get();
            removeFiles(v.file, v.poster, v.master);
            set({ ...v, file: '', poster: '', master: '', baked: false, duration: 0, width: 0, height: 0, size: 0, updated: new Date().toISOString() });
            job = null;
            res.json(status());
        });
    }

    // Alte Upload-Reste nach 2 Stunden wegräumen
    setInterval(() => {
        const limit = Date.now() - 2 * 3600 * 1000;
        uploads.forEach((u, id) => { if (u.started < limit) { fs.unlink(u.path, () => { }); uploads.delete(id); } });
    }, 15 * 60 * 1000).unref();

    return { publicInfo, serveFile, registerAdminRoutes, status };
}

module.exports = createSiteVideo;
