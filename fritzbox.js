/**
 * Small TR-064 client for the FRITZ!Box, only what the guest WLAN needs:
 *  - list the WLANs (WLANConfiguration:1..4 with SSID and on/off), the last one is the guest network
 *  - read and set the WPA password (GetSecurityKeys / SetSecurityKeys) and switch a WLAN on/off (SetEnable)
 *
 * From the internet the box answers on its HTTPS remote port (MyFRITZ! address, e.g. https://abc123.myfritz.net:46xxx)
 * below /tr064, in the home network on http://fritz.box:49000 without prefix. Both are tried, the working one is kept.
 * The box wants HTTP digest authentication (user with right "FRITZ!Box Einstellungen" and access from the internet,
 * plus "Zugriff für Anwendungen zulassen").
 */

const crypto = require('crypto');
const https = require('https');

const NS = 'urn:dslforum-org:service:';
const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const xmlEsc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlUnesc = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function parseDigest(header) {
    const out = {};
    String(header || '').replace(/^Digest\s+/i, '').replace(/(\w+)=("([^"]*)"|[^,\s]*)/g, (m, k, v, q) => { out[k.toLowerCase()] = q != null ? q : v; return ''; });
    return out;
}

function digestHeader({ user, password, method, uri, challenge, nc = 1 }) {
    const realm = challenge.realm || '';
    const nonce = challenge.nonce || '';
    const qop = (challenge.qop || '').split(',').map(s => s.trim()).includes('auth') ? 'auth' : '';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const ncs = String(nc).padStart(8, '0');
    const ha1 = md5(`${user}:${realm}:${password}`);
    const ha2 = md5(`${method}:${uri}`);
    const response = qop ? md5(`${ha1}:${nonce}:${ncs}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
    let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
    if (challenge.opaque) h += `, opaque="${challenge.opaque}"`;
    if (qop) h += `, qop=${qop}, nc=${ncs}, cnonce="${cnonce}"`;
    if (challenge.algorithm) h += `, algorithm=${challenge.algorithm}`;
    return h;
}

/** Values of <NewXxx> elements of a SOAP answer. */
function parseSoap(xml) {
    const out = {};
    String(xml).replace(/<(New[\w-]+)>([\s\S]*?)<\/\1>/g, (m, k, v) => { out[k] = xmlUnesc(v); return ''; });
    String(xml).replace(/<(New[\w-]+)\s*\/>/g, (m, k) => { out[k] = ''; return ''; });
    return out;
}

function soapFault(xml) {
    const code = /<errorCode>(\d+)<\/errorCode>/.exec(xml);
    const desc = /<errorDescription>([^<]*)<\/errorDescription>/.exec(xml);
    if (!code && !desc) return '';
    return `${desc ? desc[1] : 'Fehler'}${code ? ` (${code[1]})` : ''}`;
}

/**
 * cfg: { url, user, password, insecure, prefix? ('' | '/tr064'), index? (WLANConfiguration number) }
 * axios: the app's axios instance (testable).
 */
function createFritzBox(axios, cfg) {
    const base = String(cfg.url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+$/i.test(base)) throw new Error('Adresse der FRITZ!Box fehlt oder ist ungültig (z. B. https://abc123.myfritz.net:46xxx)');
    const local = /:49000$/.test(base) || /^http:/i.test(base);
    const agent = /^https:/i.test(base) ? new https.Agent({ rejectUnauthorized: !cfg.insecure, keepAlive: false }) : undefined;
    let prefix = cfg.prefix != null ? cfg.prefix : null;
    let challenge = null;
    let nc = 0;

    async function rawPost(path, service, action, body) {
        const uri = path;
        const send = (auth) => axios.post(base + uri, body, {
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                SoapAction: `${NS}${service}#${action}`,
                ...(auth ? { Authorization: auth } : {})
            },
            httpsAgent: agent, timeout: 15000, responseType: 'text', transformResponse: r => r,
            validateStatus: () => true, maxRedirects: 0
        });
        let res = challenge ? await send(digestHeader({ user: cfg.user, password: cfg.password, method: 'POST', uri, challenge, nc: ++nc })) : await send(null);
        if (res.status === 401 && res.headers['www-authenticate']) {
            challenge = parseDigest(res.headers['www-authenticate']);
            nc = 1;
            res = await send(digestHeader({ user: cfg.user, password: cfg.password, method: 'POST', uri, challenge, nc }));
        }
        return res;
    }

    async function call(control, service, action, args = {}) {
        const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${NS}${service}">${Object.entries(args).map(([k, v]) => `<${k}>${xmlEsc(v)}</${k}>`).join('')}</u:${action}></s:Body>
</s:Envelope>`;
        const prefixes = prefix != null ? [prefix] : (local ? ['', '/tr064'] : ['/tr064', '']);
        let last = null;
        for (const p of prefixes) {
            let res;
            try {
                res = await rawPost(`${p}${control}`, service, action, body);
            } catch (e) {
                throw new Error(netError(e));
            }
            if (res.status === 404) { last = res; continue; }
            if (res.status === 401) throw Object.assign(new Error('FRITZ!Box: Benutzername oder Passwort falsch, oder dem Benutzer fehlt das Recht „FRITZ!Box Einstellungen“ bzw. der Zugang aus dem Internet'), { auth: true });
            if (res.status >= 300 && res.status < 400) throw new Error(`FRITZ!Box leitet um (${res.status}). Bitte die Adresse mit https:// und dem Port aus MyFRITZ! eintragen.`);
            if (res.status >= 400) {
                const fault = soapFault(res.data);
                throw Object.assign(new Error(`FRITZ!Box: ${fault || `HTTP ${res.status}`}`), { status: res.status, fault });
            }
            prefix = p;
            return parseSoap(res.data);
        }
        throw Object.assign(new Error(`FRITZ!Box antwortet nicht auf TR-064 (HTTP ${last ? last.status : '?'}). Ist „Zugriff für Anwendungen zulassen“ eingeschaltet?`), { status: last ? last.status : 0 });
    }

    function netError(e) {
        const c = e && (e.code || '');
        if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'FRITZ!Box-Adresse nicht gefunden (MyFRITZ!-Adresse prüfen)';
        if (c === 'ECONNREFUSED') return 'FRITZ!Box lehnt die Verbindung ab (Port prüfen, Internetzugriff per HTTPS eingeschaltet?)';
        if (c === 'ECONNABORTED' || c === 'ETIMEDOUT' || /timeout/i.test(e.message || '')) return 'FRITZ!Box antwortet nicht (Zeitüberschreitung). Internetzugriff per HTTPS eingeschaltet, Port richtig?';
        if (/certificate|self.signed|CERT_|unable to verify/i.test(`${c} ${e.message}`)) return 'Zertifikat der FRITZ!Box wird nicht akzeptiert. Mit der MyFRITZ!-Adresse (…myfritz.net) klappt es meist, sonst „Selbstsigniertes Zertifikat erlauben“ anhaken.';
        return `FRITZ!Box nicht erreichbar: ${e.message}`;
    }

    const wlan = i => ({ control: `/upnp/control/wlanconfig${i}`, service: `WLANConfiguration:${i}` });

    /** All WLANs of the box: [{ index, ssid, enabled, status }]. The last one is the guest network. */
    async function listWlans() {
        const out = [];
        for (let i = 1; i <= 4; i++) {
            try {
                const r = await call(wlan(i).control, wlan(i).service, 'GetInfo');
                out.push({ index: i, ssid: r.NewSSID || '', enabled: r.NewEnable === '1', status: r.NewStatus || '' });
            } catch (e) {
                if (e.auth || !e.status || i === 1) throw e; // wrong password, not reachable or no TR-064 at all: stop
                break; // no such WLAN: the list is complete
            }
        }
        if (!out.length) throw new Error('Keine WLAN-Schnittstelle gefunden');
        return out;
    }

    async function getInfo(i = cfg.index) {
        const r = await call(wlan(i).control, wlan(i).service, 'GetInfo');
        return { ssid: r.NewSSID || '', enabled: r.NewEnable === '1', status: r.NewStatus || '' };
    }

    async function getPassword(i = cfg.index) {
        const r = await call(wlan(i).control, wlan(i).service, 'GetSecurityKeys');
        return r.NewKeyPassphrase || '';
    }

    /** Sets the WPA password and checks that the box took it. */
    async function setPassword(password, i = cfg.index) {
        const cur = await call(wlan(i).control, wlan(i).service, 'GetSecurityKeys');
        await call(wlan(i).control, wlan(i).service, 'SetSecurityKeys', {
            NewWEPKey0: cur.NewWEPKey0 || '', NewWEPKey1: cur.NewWEPKey1 || '', NewWEPKey2: cur.NewWEPKey2 || '', NewWEPKey3: cur.NewWEPKey3 || '',
            NewPreSharedKey: '', NewKeyPassphrase: password
        });
        const now = await getPassword(i);
        if (now !== password) throw new Error('FRITZ!Box hat das neue WLAN-Passwort nicht übernommen');
    }

    async function setEnabled(on, i = cfg.index) {
        await call(wlan(i).control, wlan(i).service, 'SetEnable', { NewEnable: on ? '1' : '0' });
    }

    return { call, listWlans, getInfo, getPassword, setPassword, setEnabled, get prefix() { return prefix; } };
}

module.exports = { createFritzBox, _test: { parseDigest, digestHeader, parseSoap, soapFault } };
