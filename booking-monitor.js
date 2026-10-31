/**
 * Booking monitor
 *
 *  1. checkOverlaps()      - warns when stays from different channels (Booking.com, Airbnb, direct) overlap
 *                            (possible double booking) or a new stay blocks an open website request;
 *                            remindOverlaps() repeats it daily until resolved or marked "in order"
 *  2. processMissing()     - detects cancellations: a future booking that disappeared from its calendar feed
 *                            for several consecutive successful polls -> delete the door code, remove the
 *                            booking, notify. Guarded against empty/broken feeds.
 *  3. checkArrivals()      - reports the first use of a guest's keypad code (Nuki activity log)
 *  4. checkLock()          - battery warnings (lock, keypad, door sensor), lock offline, problems shortly
 *                            before an arrival and "flat empty but not locked"
 */

const MISSING_THRESHOLD = 3;          // consecutive successful polls a booking must be absent (3 x 15 min)
const CANCEL_GUARD_RATIO = 0.5;       // if more than this share of future bookings vanishes at once -> do not act
const CANCEL_GUARD_MIN = 3;           // ... and at least this many bookings vanish
const STALE_ARRIVAL_MS = 36 * 60 * 60 * 1000; // first use older than this is marked silently (no late alert)
const BATTERY_LOW = 25;               // % -> "battery low" warning
const BATTERY_OK = 40;                // % -> warning re-armed (batteries replaced / charged)
const UNLOCKED_ALERT_MS = 30 * 60 * 1000; // flat empty and unlocked at least this long -> warning
const OFFLINE_ALERT_MS = 30 * 60 * 1000;  // lock offline at least this long -> warning (short Wi-Fi hiccups stay silent)
const API_ERROR_ALERT_MS = 2 * 60 * 60 * 1000; // Nuki Web unreachable at least this long -> warning
const CRITICAL_REPEAT_MS = 24 * 60 * 60 * 1000; // "battery almost empty" is repeated daily until replaced
const CHECKIN_HOUR = 15;              // stays count as occupied from 15:00 on arrival day ...
const CHECKOUT_HOUR = 11;             // ... until 11:00 on departure day (same as the door code validity)

function createMonitor({ db, axios, notify, deleteNukiPin, botLogic, formatDateDE }) {
    let nukiLogUnavailable = false;
    let lockStateUnavailable = false;

    const berlinYmd = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(d);
    const berlinTime = d => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(d);
    const sourceOf = row => row.source || (/^airbnb/i.test(row.summary || '') ? 'Airbnb' : 'Booking.com');
    const nameOf = row => {
        if (row.guest_name && !botLogic.isPlaceholderGuestName(row.guest_name)) return row.guest_name;
        const s = String(row.summary || '').split('(')[0].replace(/^(Buchung|Gast|Airbnb):/i, '').trim();
        return botLogic.isPlaceholderGuestName(s) ? `${sourceOf(row)}-Buchung` : s;
    };
    const period = row => `${formatDateDE(row.checkin)} – ${formatDateDE(row.checkout)}`;

    function getState(key) {
        const v = db.getAllSettings()[key];
        return v && typeof v === 'object' ? { ...v } : {};
    }
    function saveState(key, state, before) {
        if (JSON.stringify(state) !== JSON.stringify(before)) db.setSetting(key, state);
    }

    // -----------------------------------------------------------------------
    // 1. Double booking warning
    // -----------------------------------------------------------------------
    /** Current cross-portal overlaps: [[bookingA, bookingB], ...] (same-day turnover is not an overlap). */
    function findOverlaps() {
        const today = berlinYmd();
        const rows = db.getDb().prepare(`
            SELECT b.*, g.name AS guest_name
            FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
            WHERE b.checkout >= ? AND b.checkin IS NOT NULL AND b.checkout IS NOT NULL AND b.uid NOT LIKE 'manual-%'
        `).all(today);

        const found = [];
        for (let i = 0; i < rows.length; i++) {
            for (let j = i + 1; j < rows.length; j++) {
                const a = rows[i], b = rows[j];
                if (sourceOf(a) === sourceOf(b)) continue; // only cross-portal overlaps
                if (a.checkin < b.checkout && b.checkin < a.checkout) found.push([a, b]);
            }
        }
        return found;
    }

    const overlapKey = (a, b) => `${[a.id, b.id].sort((x, y) => x - y).join('-')}:${a.checkin}/${a.checkout}:${b.checkin}/${b.checkout}`;
    const pairOf = key => String(key).split(':')[0];
    // Older versions stored only the timestamp of the first warning
    const overlapEntry = v => (v && typeof v === 'object' ? { ...v } : { ts: Number(v) || Date.now() });

    /** Overlaps that still need attention (not marked as "in order") - for the dashboard. */
    function openOverlaps() {
        const state = getState('overlap_warnings');
        return findOverlaps().map(([a, b]) => ({ a, b, key: overlapKey(a, b), identical: a.checkin === b.checkin && a.checkout === b.checkout }))
            .filter(o => !(state[o.key] && overlapEntry(state[o.key]).ack));
    }

    function overlapMessage(a, b, reminder) {
        const identical = a.checkin === b.checkin && a.checkout === b.checkout;
        const lines = `• ${sourceOf(a)}: ${nameOf(a)} (${period(a)})\n• ${sourceOf(b)}: ${nameOf(b)} (${period(b)})\n`;
        if (reminder) {
            return `⏰ *Erinnerung: Überschneidung noch offen*\n${lines}` +
                `Ist alles geklärt (z. B. eine Buchung storniert oder die Kalender sind verknüpft), tippe auf „Ist in Ordnung“. Dann kommt keine Erinnerung mehr.`;
        }
        return identical
            ? `⚠️ *Gleicher Zeitraum in ${sourceOf(a)} und ${sourceOf(b)}*\n${lines}` +
              `Vermutlich ist ein Kalender mit dem anderen verknüpft (gespiegelte Sperre) – dann ist es *eine* Buchung und es gibt evtl. zwei Türcodes. Bitte prüfen.`
            : `🚨 *Mögliche Doppelbuchung!*\n${lines}` +
              `Die Zeiträume überschneiden sich. Bitte in beiden Portalen prüfen und eine Buchung stornieren.`;
    }
    const overlapKeyboard = (a, b) => ({ inline_keyboard: [[{ text: '✅ Ist in Ordnung', callback_data: `ovl:${pairOf(overlapKey(a, b))}` }]] });

    async function checkOverlaps() {
        const found = findOverlaps();

        const before = getState('overlap_warnings');
        const state = {};
        const fresh = [];
        for (const [a, b] of found) {
            const key = overlapKey(a, b);
            state[key] = before[key] ? overlapEntry(before[key]) : { ts: Date.now() };
            if (!before[key]) fresh.push([a, b]);
        }
        saveState('overlap_warnings', state, before); // pairs that no longer overlap drop out -> can warn again later

        for (const [a, b] of fresh) {
            await notify(overlapMessage(a, b, false), 'overlap_warning', { tgKeyboard: overlapKeyboard(a, b) });
        }
        await checkRequestClashes();
        return fresh.length;
    }

    /** Daily: remind once a day of overlaps that are neither resolved nor marked as "in order". */
    async function remindOverlaps() {
        const today = berlinYmd();
        const before = getState('overlap_warnings');
        const state = { ...before };
        let sent = 0;
        for (const [a, b] of findOverlaps()) {
            const key = overlapKey(a, b);
            if (!state[key]) continue; // not warned yet -> the next calendar check does that
            const e = overlapEntry(state[key]);
            if (e.ack || e.remindedOn === today || berlinYmd(new Date(e.ts)) === today) continue;
            e.remindedOn = today;
            state[key] = e;
            await notify(overlapMessage(a, b, true), 'overlap_warning', { tgKeyboard: overlapKeyboard(a, b) });
            sent++;
        }
        saveState('overlap_warnings', state, before);
        return sent;
    }

    /** Marks an overlap as "in order" (pair "12-34" or a full key): no more reminders, hidden on the dashboard. */
    function ackOverlap(keyOrPair) {
        const pair = pairOf(keyOrPair);
        const before = getState('overlap_warnings');
        const state = { ...before };
        let n = 0;
        for (const k of Object.keys(state)) {
            if (k === keyOrPair || pairOf(k) === pair) { state[k] = { ...overlapEntry(state[k]), ack: Date.now() }; n++; }
        }
        saveState('overlap_warnings', state, before);
        return n;
    }

    /** A new portal booking that overlaps an open booking request from the guest website. */
    async function checkRequestClashes() {
        const today = berlinYmd();
        const requests = db.getDb().prepare(
            "SELECT * FROM booking_requests WHERE status = 'pending' AND checkout > ?"
        ).all(today);
        const before = getState('request_clash_warnings');
        const state = {};
        for (const r of requests) {
            const clash = db.getDb().prepare(`
                SELECT b.*, g.name AS guest_name FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
                WHERE b.checkin < ? AND b.checkout > ? AND b.uid NOT LIKE 'manual-%' ORDER BY b.checkin LIMIT 1
            `).get(r.checkout, r.checkin);
            if (!clash) continue;
            const key = `${r.id}:${clash.id}`;
            state[key] = before[key] || Date.now();
            if (before[key]) continue;
            await notify(
                `⚠️ *Offene Anfrage ist jetzt belegt*\n` +
                `Webseiten-Anfrage von ${r.name} (${period(r)}) überschneidet sich mit\n• ${sourceOf(clash)}: ${nameOf(clash)} (${period(clash)})\n` +
                `Bitte die Anfrage im Admin unter Webseite → Anfragen absagen.`,
                'overlap_warning');
        }
        saveState('request_clash_warnings', state, before);
    }

    // -----------------------------------------------------------------------
    // 2. Cancellation detection
    // -----------------------------------------------------------------------
    /**
     * Call after a *successful* poll of one feed.
     * seenUids: all event UIDs contained in that feed.
     */
    async function processMissing(source, seenUids) {
        const today = berlinYmd();
        const future = db.getDb().prepare(`
            SELECT b.*, g.name AS guest_name
            FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
            WHERE b.source = ? AND b.uid NOT LIKE 'manual-%' AND b.checkin > ?
        `).all(source, today);
        if (future.length === 0) return { cancelled: 0 };

        const missing = future.filter(b => !seenUids.has(b.uid));
        if (missing.length === 0) return { cancelled: 0 };

        // Safety net: many bookings vanishing at once looks like a broken/partial feed, not real cancellations
        if (missing.length >= CANCEL_GUARD_MIN && missing.length / future.length > CANCEL_GUARD_RATIO) {
            const before = getState('cancel_guard_alert');
            const state = { ...before };
            if (state[source] !== today) {
                state[source] = today;
                saveState('cancel_guard_alert', state, before);
                await notify(
                    `⚠️ *${source}: Kalender liefert auffallend weniger Buchungen*\n` +
                    `${missing.length} von ${future.length} kommenden Buchungen fehlen plötzlich. ` +
                    `Stornierungen werden deshalb *nicht* automatisch verarbeitet. Bitte den Kalender-Link prüfen.`,
                    'cancel_guard');
            }
            return { cancelled: 0, guarded: true };
        }

        let cancelled = 0;
        for (const b of missing) {
            const count = (b.missing_count || 0) + 1;
            db.getDb().prepare('UPDATE bookings SET missing_count = ? WHERE id = ?').run(count, b.id);
            if (count >= MISSING_THRESHOLD) {
                if (await cancelBooking(b)) cancelled++;
            }
        }
        return { cancelled };
    }

    async function cancelBooking(b) {
        let codeInfo = 'Kein Türcode vorhanden.';
        if (b.nuki_auth_id) {
            try {
                await deleteNukiPin(b.nuki_auth_id);
                codeInfo = '🔑 Der Türcode wird gelöscht (Nuki entfernt ihn, sobald das Schloss synchronisiert hat).';
            } catch (e) {
                if (e.response && e.response.status === 404) {
                    codeInfo = '🔑 Der Türcode war bereits entfernt.';
                } else {
                    console.warn(`⚠️ Storno Buchung ${b.id}: Code konnte nicht gelöscht werden (neuer Versuch beim nächsten Abgleich):`, e.message);
                    return false; // keep the booking so the next poll retries
                }
            }
        }
        db.getDb().prepare('DELETE FROM bookings WHERE id = ?').run(b.id);
        if (b.guest_id) botLogic.cleanupPlaceholderGuest(b.guest_id);
        console.log(`❌ Buchung ${b.id} (${sourceOf(b)}) storniert und entfernt.`);
        await notify(`❌ *Buchung storniert (${sourceOf(b)})*\n${nameOf(b)}\n📅 ${period(b)}\n${codeInfo}`, 'booking_cancelled');
        return true;
    }

    // -----------------------------------------------------------------------
    // 3. Arrival detection via Nuki activity log
    // -----------------------------------------------------------------------
    async function checkArrivals() {
        if (nukiLogUnavailable) return { checked: 0 };
        const nuki = db.getAllSettings().nuki;
        if (!nuki || !nuki.token || !nuki.lockId) return { checked: 0 };
        const lockId = parseInt(nuki.lockId, 10) || nuki.lockId;
        const today = berlinYmd();

        const rows = db.getDb().prepare(`
            SELECT b.*, g.name AS guest_name
            FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
            WHERE b.nuki_auth_id IS NOT NULL AND b.nuki_auth_id != '' AND b.arrived_at IS NULL
              AND b.checkin <= ? AND b.checkout >= ?
        `).all(today, today);

        let arrivals = 0;
        for (const b of rows) {
            let entries;
            try {
                const res = await axios.get(`https://api.nuki.io/smartlock/${lockId}/log`, {
                    params: { authId: b.nuki_auth_id, limit: 20 },
                    headers: { 'Authorization': `Bearer ${nuki.token}`, 'Accept': 'application/json' },
                    timeout: 15000
                });
                entries = Array.isArray(res.data) ? res.data : [];
            } catch (e) {
                const status = e.response && e.response.status;
                if (status === 401 || status === 403) {
                    nukiLogUnavailable = true;
                    console.warn('⚠️ Nuki-Zutrittsprotokoll nicht verfügbar (Token ohne Berechtigung):', status);
                    await notify('ℹ️ *Anreise-Erkennung nicht möglich*\nDer Nuki-Token darf das Zutrittsprotokoll nicht lesen. Bitte beim Token die Berechtigung für „Protokoll / Logs“ aktivieren (die Meldung kommt nur einmal).', 'arrival_unavailable');
                    return { checked: 0, unavailable: true };
                }
                console.warn(`⚠️ Nuki-Protokoll für Buchung ${b.id}:`, e.message);
                continue;
            }

            // Only entries of this very code count (defensive: ignore everything else the API might return)
            const own = entries.filter(e => String(e.authId) === String(b.nuki_auth_id) && e.date);
            if (own.length === 0) { await sleep(1100); continue; }

            const first = own.map(e => new Date(e.date)).filter(d => !isNaN(d)).sort((x, y) => x - y)[0];
            if (!first) { await sleep(1100); continue; }

            db.getDb().prepare('UPDATE bookings SET arrived_at = ? WHERE id = ?').run(first.toISOString(), b.id);
            if (Date.now() - first.getTime() <= STALE_ARRIVAL_MS) {
                arrivals++;
                const day = berlinYmd(first) === today ? 'heute' : berlinYmd(first).split('-').reverse().join('.');
                await notify(`🚪 *${nameOf(b)} ist angekommen*\nErster Zutritt ${day} um ${berlinTime(first)} Uhr\n📅 ${period(b)} · ${sourceOf(b)}`, 'guest_arrived');
            }
            await sleep(1100); // stay well below the Nuki API rate limit
        }
        return { checked: rows.length, arrivals };
    }

    // -----------------------------------------------------------------------
    // 4. Lock watch: batteries and "flat empty but unlocked"
    // -----------------------------------------------------------------------
    const berlinHour = (d = new Date()) => parseInt(new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(d), 10);

    /** Is a guest expected in the flat right now? (arrival day from 15:00 or after the first door use, until 11:00 on departure day) */
    function isOccupied(now = new Date()) {
        const today = berlinYmd(now);
        const hour = berlinHour(now);
        const rows = db.getDb().prepare(
            'SELECT checkin, checkout, arrived_at FROM bookings WHERE checkin <= ? AND checkout >= ?'
        ).all(today, today);
        return rows.some(b => {
            if (b.checkin === today && hour < CHECKIN_HOUR && !b.arrived_at) return false;
            if (b.checkout === today && hour >= CHECKOUT_HOUR) return false;
            return true;
        });
    }

    /** Arrivals today, tomorrow and the day after (for "fix it before the guest comes" warnings). */
    function arrivalsSoon(now) {
        const today = berlinYmd(now);
        const until = berlinYmd(new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000));
        return db.getDb().prepare(`
            SELECT b.*, g.name AS guest_name FROM bookings b LEFT JOIN guests g ON g.id = b.guest_id
            WHERE b.checkin >= ? AND b.checkin <= ? ORDER BY b.checkin
        `).all(today, until);
    }
    const dayWord = (ymd, now) => {
        const today = berlinYmd(now);
        const tomorrow = berlinYmd(new Date(now.getTime() + 24 * 60 * 60 * 1000));
        return ymd === today ? 'heute' : ymd === tomorrow ? 'morgen' : `am ${formatDateDE(ymd)}`;
    };

    async function checkLock(now = new Date()) {
        if (lockStateUnavailable) return { checked: false };
        const nuki = db.getAllSettings().nuki;
        if (!nuki || !nuki.token || !nuki.lockId) return { checked: false };

        const before = getState('nuki_lock_watch');
        const state = { ...before };
        const sent = [];

        let lock;
        try {
            lock = await botLogic.getNukiLock();
        } catch (e) {
            if (e.permission) {
                lockStateUnavailable = true;
                console.warn('⚠️ Nuki-Schlossstatus nicht verfügbar:', e.message);
                await notify('ℹ️ *Schloss-Überwachung nicht möglich*\n' + e.message + '\n(Batterie-, Offline- und „nicht abgeschlossen“-Warnungen sind aus. Die Meldung kommt nur einmal.)', 'lock_unavailable');
                return { checked: false };
            }
            console.warn('⚠️ Nuki-Schlossstatus:', e.message);
            // Nuki Web not reachable for a longer time -> say so once (status unknown, no other warnings possible)
            if (!state.apiErrorSince) state.apiErrorSince = now.getTime();
            if (!state.apiErrorWarned && now.getTime() - state.apiErrorSince >= API_ERROR_ALERT_MS) {
                state.apiErrorWarned = true;
                await notify(`📡 *Nuki nicht erreichbar*\nSeit über ${Math.round((now.getTime() - state.apiErrorSince) / 3600000)} Stunden bekommt der Server keinen Schloss-Status von Nuki Web (${e.message}). ` +
                    'Batterie- und Offline-Warnungen sind so lange aus. Bitte Internet des Servers und den Nuki-Token prüfen.', 'nuki_offline');
                sent.push('api');
            }
            saveState('nuki_lock_watch', state, before);
            return { checked: false, sent };
        }
        if (state.apiErrorWarned) {
            await notify('✅ *Nuki wieder erreichbar*\nDer Schloss-Status kommt wieder an.', 'nuki_offline');
            sent.push('api_back');
        }
        delete state.apiErrorSince;
        delete state.apiErrorWarned;

        // Offline (bridge / Wi-Fi gone): codes and remote opening cannot reach the lock any more
        if (lock.offline) {
            if (!state.offlineSince) state.offlineSince = now.getTime();
            if (!state.offlineWarned && now.getTime() - state.offlineSince >= OFFLINE_ALERT_MS) {
                state.offlineWarned = true;
                const mins = Math.round((now.getTime() - state.offlineSince) / 60000);
                await notify(
                    `📡 *Nuki-Schloss ist offline*\nSeit mindestens ${mins} Minuten hat Nuki keine Verbindung zum Schloss.\n` +
                    'Bereits gespeicherte Türcodes funktionieren am Keypad weiter. Neue oder geänderte Codes, Fernöffnen und Notfall-Öffnen gehen aber nicht. ' +
                    'Bitte Bridge (Stecker, WLAN) bzw. Internet in der Wohnung prüfen.', 'nuki_offline');
                sent.push('offline');
            }
        } else {
            if (state.offlineWarned) {
                const mins = Math.round((now.getTime() - state.offlineSince) / 60000);
                await notify(`✅ *Nuki-Schloss wieder online*\nNach etwa ${mins >= 120 ? Math.round(mins / 60) + ' Stunden' : mins + ' Minuten'} ist das Schloss wieder verbunden.`, 'nuki_offline');
                sent.push('online');
            }
            delete state.offlineSince;
            delete state.offlineWarned;
        }

        // Battery of the lock: warn when it gets low and again when it becomes critical; re-arm after replacing.
        // An offline lock reports its last known values -> only the offline warning counts then.
        const rank = { ok: 0, low: 1, critical: 2 };
        const level = lock.batteryCritical ? 'critical' : (lock.battery !== null && lock.battery <= BATTERY_LOW ? 'low' : 'ok');
        const pct = lock.battery !== null ? ` (${lock.battery} %)` : '';
        if (!lock.offline) {
            if (rank[level] > rank[state.battery || 'ok']) {
                state.battery = level;
                state.batteryWarnedAt = now.getTime();
                await notify(level === 'critical'
                    ? `🪫 *Nuki-Batterie fast leer*${pct}\nBitte die Batterien des Schlosses bald tauschen – sonst lässt sich die Tür nicht mehr per Code öffnen.`
                    : `🔋 *Nuki-Batterie wird schwach*${pct}\nBitte Ersatzbatterien bereitlegen.`, 'nuki_battery');
                sent.push('battery');
            } else if (level === 'critical' && now.getTime() - (state.batteryWarnedAt || 0) >= CRITICAL_REPEAT_MS) {
                // Still almost empty a day later -> remind once a day until the batteries are replaced
                state.batteryWarnedAt = now.getTime();
                await notify(`🪫 *Erinnerung: Nuki-Batterie fast leer*${pct}\nDie Batterien des Schlosses sind noch nicht getauscht.`, 'nuki_battery');
                sent.push('battery_repeat');
            } else if (level === 'ok' && (lock.battery === null || lock.battery >= BATTERY_OK)) {
                state.battery = 'ok';
                delete state.batteryWarnedAt;
            }
            for (const [key, label] of [['keypadBatteryCritical', 'Keypad'], ['doorsensorBatteryCritical', 'Türsensor']]) {
                if (lock[key] && !state[key]) {
                    await notify(`🪫 *Batterie ${label} fast leer*\nBitte die Batterie ${label === 'Keypad' ? 'des Keypads' : 'des Türsensors'} tauschen.`, 'nuki_battery');
                    sent.push(key);
                }
                state[key] = lock[key];
            }
        }

        // A guest arrives within two days while the lock has a serious problem -> one extra warning per arrival
        // ("battery low" alone is not one: that lasts weeks and would come before every arrival)
        const problems = [];
        if (lock.offline) problems.push('das Schloss ist offline');
        else {
            if (level === 'critical') problems.push(`die Schloss-Batterie ist fast leer${pct}`);
            if (lock.keypadBatteryCritical) problems.push('die Keypad-Batterie ist fast leer');
        }
        const warnedFor = { ...(state.arrivalWarned || {}) };
        const soon = arrivalsSoon(now);
        if (problems.length && (!lock.offline || state.offlineWarned)) {
            for (const b of soon) {
                if (warnedFor[b.id]) continue;
                warnedFor[b.id] = b.checkin;
                await notify(
                    `🔑 *Vor der Anreise prüfen*\n${nameOf(b)} reist ${dayWord(b.checkin, now)} an (${period(b)}), aber ${problems.join(' und ')}. ` +
                    'Bitte vorher erledigen, damit der Türcode sicher funktioniert.', lock.offline ? 'nuki_offline' : 'nuki_battery');
                sent.push('arrival');
            }
        }
        const today = berlinYmd(now);
        for (const id of Object.keys(warnedFor)) if (warnedFor[id] < today) delete warnedFor[id];
        if (Object.keys(warnedFor).length) state.arrivalWarned = warnedFor; else delete state.arrivalWarned;

        // Unlocked while nobody should be in the flat -> one warning per unlocked phase
        if (lock.unlocked && !lock.offline) {
            if (!state.unlockedSince) state.unlockedSince = now.getTime();
            if (!state.unlockedWarned && now.getTime() - state.unlockedSince >= UNLOCKED_ALERT_MS && !isOccupied(now)) {
                state.unlockedWarned = true;
                const mins = Math.round((now.getTime() - state.unlockedSince) / 60000);
                await notify(
                    `🔓 *Wohnung ist nicht abgeschlossen*\nDas Schloss steht seit mindestens ${mins} Minuten auf „${lock.lockText}“` +
                    `${lock.doorText ? ` (${lock.doorText})` : ''}, aber gerade ist kein Gast da.`,
                    'nuki_unlocked',
                    { tgKeyboard: { inline_keyboard: [[{ text: '🔒 Jetzt abschließen', callback_data: 'lock:zu' }]] } });
                sent.push('unlocked');
            }
        } else if (lock.locked) {
            delete state.unlockedSince;
            delete state.unlockedWarned;
        }

        // Last known status for the dashboard (only saved when something relevant changes)
        state.last = {
            battery: lock.battery, level, offline: !!lock.offline,
            keypad: !!lock.keypadBatteryCritical, doorsensor: !!lock.doorsensorBatteryCritical
        };

        saveState('nuki_lock_watch', state, before);
        return { checked: true, lock, sent };
    }

    /** Lock problems for the dashboard, from the last check (no API call). */
    function lockWarnings() {
        const nuki = db.getAllSettings().nuki;
        if (!nuki || !nuki.token || !nuki.lockId) return [];
        const st = getState('nuki_lock_watch');
        const out = [];
        if (st.apiErrorWarned) out.push({ type: 'lock', bad: true, text: 'Nuki Web nicht erreichbar – Schloss-Status unbekannt' });
        const last = st.last;
        if (!last) return out;
        if (last.offline) out.push({ type: 'lock', bad: true, text: 'Nuki-Schloss ist offline (Bridge/WLAN prüfen)' });
        else {
            const pct = last.battery !== null && last.battery !== undefined ? ` (${last.battery} %)` : '';
            if (last.level === 'critical') out.push({ type: 'lock', bad: true, text: `Nuki-Batterie fast leer${pct} – bitte tauschen` });
            else if (last.level === 'low') out.push({ type: 'lock', bad: false, text: `Nuki-Batterie wird schwach${pct}` });
            if (last.keypad) out.push({ type: 'lock', bad: true, text: 'Keypad-Batterie fast leer' });
            if (last.doorsensor) out.push({ type: 'lock', bad: false, text: 'Türsensor-Batterie fast leer' });
        }
        return out;
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    return {
        checkOverlaps, findOverlaps, openOverlaps, remindOverlaps, ackOverlap, processMissing, checkArrivals, checkLock, lockWarnings, isOccupied,
        _internal: { cancelBooking }
    };
}

module.exports = createMonitor;
module.exports.MISSING_THRESHOLD = MISSING_THRESHOLD;
