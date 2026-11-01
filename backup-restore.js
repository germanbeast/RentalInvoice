#!/usr/bin/env node
/* Datensicherung wiederherstellen (siehe BACKUP.md)

   Entpacken und prüfen (ändert nichts an der laufenden App):
     node backup-restore.js backups/beckhome-backup-2026-11-02_0330.tar.gz.enc
     -> Ordner restore-2026-11-02_0330/ mit rental.db, .env, uploads/ ...

   Direkt in die App zurückspielen (vorher: pm2 stop invoice-app):
     node backup-restore.js <datei> --apply
     -> aktuelle rental.db, .env, users.json, uploads/ werden vorher nach pre-restore-<zeit>/ verschoben

   Passwort: wird abgefragt, oder per Umgebungsvariable BACKUP_PASSWORD. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream/promises');
const { Writable } = require('stream');
const { decryptStream, PBKDF2_ITER } = require('./backup');

const APP_DIR = __dirname;

function ask(question, hidden) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        if (hidden) {
            rl._writeToOutput = s => { if (s.includes(question)) process.stdout.write(s); };
        }
        rl.question(question, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
    });
}

/** Minimal tar reader: writes regular files below `dest`, refuses paths that leave it. */
function tarExtractor(dest, written) {
    let buf = Buffer.alloc(0);
    let cur = null; // { name, remaining, pad, chunks }
    let done = false;
    const safe = name => {
        const p = path.resolve(dest, name);
        if (!p.startsWith(path.resolve(dest) + path.sep)) throw new Error('Unsicherer Pfad im Archiv: ' + name);
        return p;
    };
    const finishFile = async () => {
        const data = Buffer.concat(cur.chunks);
        const p = safe(cur.name);
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await fsp.writeFile(p, data, { mode: 0o600 });
        written.push({ name: cur.name, sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length });
    };
    return new Writable({
        async write(chunk, enc, cb) {
            try {
                buf = Buffer.concat([buf, chunk]);
                while (!done) {
                    if (cur) {
                        if (cur.remaining > 0) {
                            if (!buf.length) break;
                            const take = Math.min(cur.remaining, buf.length);
                            cur.chunks.push(buf.subarray(0, take));
                            buf = buf.subarray(take);
                            cur.remaining -= take;
                            if (cur.remaining > 0) break;
                        }
                        if (buf.length < cur.pad) break;
                        buf = buf.subarray(cur.pad);
                        if (cur.type === '0' || cur.type === '\0') await finishFile();
                        cur = null;
                        continue;
                    }
                    if (buf.length < 512) break;
                    const h = buf.subarray(0, 512);
                    buf = buf.subarray(512);
                    if (h.every(b => b === 0)) { done = true; break; }
                    const field = (o, l) => h.subarray(o, o + l).toString('utf8').replace(/\0.*$/s, '');
                    const prefix = field(345, 155);
                    const name = (prefix ? prefix + '/' : '') + field(0, 100);
                    const size = parseInt(field(124, 12).trim() || '0', 8);
                    cur = { name, type: field(156, 1) || '0', remaining: size, pad: (512 - (size % 512)) % 512, chunks: [] };
                }
                cb();
            } catch (e) { cb(e); }
        }
    });
}

async function main() {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const file = args.find(a => !a.startsWith('--'));
    if (!file) {
        console.log('Aufruf: node backup-restore.js <backup-datei.tar.gz.enc> [--apply]');
        process.exit(1);
    }
    if (!fs.existsSync(file)) { console.error('❌ Datei nicht gefunden: ' + file); process.exit(1); }

    const password = process.env.BACKUP_PASSWORD || await ask('Backup-Passwort: ', true);
    const m = path.basename(file).match(/(\d{4}-\d{2}-\d{2}_\d{4})/);
    let dest = path.join(APP_DIR, `restore-${m ? m[1] : Date.now()}`);
    if (fs.existsSync(dest)) dest += '-' + Date.now();
    await fsp.mkdir(dest, { recursive: true });

    console.log('🔓 Entschlüssele und entpacke nach ' + dest + ' ...');
    const written = [];
    try {
        await pipeline(fs.createReadStream(file), decryptStream(password, PBKDF2_ITER), zlib.createGunzip(), tarExtractor(dest, written));
    } catch (e) {
        await fsp.rm(dest, { recursive: true, force: true });
        if (/header check|bad decrypt|Falsches Passwort|invalid|unexpected end/i.test(e.message)) throw new Error('Falsches Passwort oder beschädigte Datei');
        throw e;
    }

    // Check every file against the manifest
    const manifest = JSON.parse(await fsp.readFile(path.join(dest, 'MANIFEST.json'), 'utf8'));
    const got = new Map(written.map(w => [w.name, w.sha256]));
    const bad = manifest.files.filter(f => got.get(f.name) !== f.sha256);
    if (bad.length) {
        console.error('❌ Prüfsumme falsch bei: ' + bad.map(b => b.name).join(', '));
        process.exit(2);
    }
    console.log(`✅ ${manifest.files.length} Dateien geprüft (Backup vom ${manifest.createdAt}, App-Version ${manifest.version || '?'})`);

    if (!apply) {
        console.log('\nNichts an der App geändert. Zum Zurückspielen: pm2 stop invoice-app, dann');
        console.log(`  node backup-restore.js ${file} --apply`);
        return;
    }

    const answer = await ask('Aktuelle Daten werden ersetzt. Ist die App gestoppt (pm2 stop invoice-app)? [ja/nein] ');
    if (!/^j(a)?$/i.test(answer.trim())) { console.log('Abgebrochen. Entpackte Dateien liegen in ' + dest); return; }

    const keep = path.join(APP_DIR, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await fsp.mkdir(keep, { recursive: true });
    const tops = [...new Set(manifest.files.map(f => f.name.split('/')[0]))];
    for (const t of [...tops, 'rental.db-wal', 'rental.db-shm']) {
        const cur = path.join(APP_DIR, t);
        if (fs.existsSync(cur)) await fsp.rename(cur, path.join(keep, t));
    }
    for (const t of tops) await fsp.cp(path.join(dest, t), path.join(APP_DIR, t), { recursive: true });
    console.log(`✅ Zurückgespielt: ${tops.join(', ')}`);
    console.log(`   Bisherige Daten liegen in ${keep}`);
    console.log('   Jetzt: pm2 start invoice-app');
}

main().catch(e => { console.error('❌ ' + e.message); process.exit(1); });
