#!/bin/bash
# Umzug der Beckhome-App von Netcup in diesen Container (Proxmox LXC, Ubuntu 24.04).
# Am Netcup-Server wird nur gelesen: ps, cat, git ohne Schreibzugriff, rsync/tar als Quelle.
#
# Reihenfolge (Details: migration/README.md):
#   ./migrate.sh probe root@<netcup-ip>   Bestandsaufnahme Netcup (nur lesen)
#   ./migrate.sh install                  Pakete, Node (gleiche Hauptversion), PM2
#   ./migrate.sh copy                     Probe-Kopie, während Netcup noch läuft
#   ./migrate.sh selftest                 DB, PDF (Chromium), ffmpeg prüfen, ohne die App zu starten
#   --- auf Netcup: pm2 stop invoice-app && pm2 save ---
#   ./migrate.sh copy --final             Endgültige Kopie, nur wenn Netcup-App gestoppt ist
#   ./migrate.sh start                    App unter PM2 starten, Autostart
#   ./migrate.sh verify                   Prüfliste
set -uo pipefail

STATE_DIR=/root/beckhome-migration
STATE="$STATE_DIR/remote.env"
SOCK="$STATE_DIR/ssh-%r@%h"
mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"

c_ok()   { echo -e "  \e[32m✔\e[0m $*"; }
c_warn() { echo -e "  \e[33m⚠\e[0m $*"; WARN=$((${WARN:-0}+1)); }
c_bad()  { echo -e "  \e[31m✘\e[0m $*"; BAD=$((${BAD:-0}+1)); }
die()    { echo -e "\e[31m❌ $*\e[0m"; exit 1; }
step()   { echo; echo -e "\e[1m▶ $*\e[0m"; }

load_state() { [ -f "$STATE" ] || die "Erst ./migrate.sh probe root@<netcup-ip> ausführen."; . "$STATE"; }
r() { ssh -o ControlMaster=auto -o ControlPath="$SOCK" -o ControlPersist=15m -o StrictHostKeyChecking=accept-new "$REMOTE" "$@"; }

# Läuft auf Netcup ein node-Prozess mit server.js aus APP_DIR? (nur ps + /proc lesen)
# Erkennt ihn über das Arbeitsverzeichnis oder den Skriptpfad in der Befehlszeile.
remote_app_pids() {
    r "for p in \$(pgrep -f 'server\.js' 2>/dev/null); do d=\$(readlink /proc/\$p/cwd 2>/dev/null); c=\$(tr '\\0' ' ' </proc/\$p/cmdline 2>/dev/null); case \"\$(readlink /proc/\$p/exe 2>/dev/null)\" in */node|*/nodejs) ;; *) continue;; esac; if [ \"\$d\" = '$1' ] || [[ \"\$c\" == *'$1/server.js'* ]]; then echo \$p; fi; done" 2>/dev/null
}

cmd_probe() {
    REMOTE="${1:-}"; [ -n "$REMOTE" ] || die "Aufruf: ./migrate.sh probe root@<netcup-ip>"
    command -v ssh >/dev/null || { apt-get update -qq && apt-get install -y -qq openssh-client >/dev/null; }
    step "Verbinde mit $REMOTE (Passwort wird einmal abgefragt, die Verbindung bleibt 15 min offen)"
    r true || die "SSH zu $REMOTE klappt nicht."
    local out="$STATE_DIR/probe-$(date +%F-%H%M).txt"

    # App-Verzeichnis über den laufenden Prozess finden, sonst übliche Orte
    local dir
    dir="$(r 'for p in $(pgrep -f "server\.js"); do case "$(readlink /proc/$p/exe)" in */node|*/nodejs) ;; *) continue;; esac; c=$(tr "\0" " " </proc/$p/cmdline); s=$(echo "$c" | grep -o "/[^ ]*/server\.js" | head -1); for d in "${s%/server.js}" "$(readlink /proc/$p/cwd)"; do [ -n "$d" ] && [ -f "$d/bot-logic.js" ] && { echo "$d"; exit 0; }; done; done' 2>/dev/null)"
    if [ -z "$dir" ]; then
        dir="$(r 'for d in /root/RentalInvoice /home/*/RentalInvoice /opt/RentalInvoice /srv/RentalInvoice; do [ -f "$d/bot-logic.js" ] && { echo "$d"; break; }; done' 2>/dev/null)"
    fi
    [ -n "$dir" ] || die "App-Verzeichnis auf Netcup nicht gefunden. Bitte APP_DIR=/pfad ./migrate.sh probe … angeben."
    dir="${APP_DIR_OVERRIDE:-$dir}"

    local owner node_v tz ip
    owner="$(r "stat -c %U '$dir'")"
    node_v="$(r 'node -v 2>/dev/null' || true)"
    tz="$(r 'cat /etc/timezone 2>/dev/null || readlink /etc/localtime | sed s@.*zoneinfo/@@')"
    ip="$(getent ahostsv4 "${REMOTE#*@}" | awk '{print $1; exit}')"

    cat > "$STATE" <<EOF
REMOTE='$REMOTE'
REMOTE_IP='${ip:-${REMOTE#*@}}'
APP_DIR='$dir'
APP_OWNER='$owner'
NODE_MAJOR='$(echo "$node_v" | sed -E 's/^v([0-9]+).*/\1/')'
REMOTE_TZ='$tz'
EOF
    chmod 600 "$STATE"

    step "Bestandsaufnahme (nur lesen) → $out"
    r "bash -s" > "$out" 2>&1 <<EOF
set +e
APP='$dir'
echo "=== System";        hostname; . /etc/os-release; echo "\$PRETTY_NAME"; uptime; echo "TZ: $tz"; df -h / | tail -1
echo "=== Node/PM2";      node -v; npm -v; command -v pm2 >/dev/null && pm2 -v 2>/dev/null | tail -1
echo "=== App";           echo "\$APP (Besitzer: $owner)"; cd "\$APP" && grep '"version"' package.json
echo "--- git";           git --no-optional-locks -C "\$APP" log -1 --format='%H %cd %s'
                          git --no-optional-locks -C "\$APP" status --porcelain | head -30
                          git --no-optional-locks -C "\$APP" stash list | head -5
echo "--- Datenmengen";   du -sh "\$APP"/{rental.db*,users.json*,.env,uploads,.wwebjs_auth,.wwebjs_cache,.ocr-data,backups,temp,.git,node_modules} 2>/dev/null
echo "--- uploads";       du -sh "\$APP"/uploads/* 2>/dev/null
echo "--- .env (nur Namen)"; sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "\$APP/.env" 2>/dev/null
echo "=== Prozesse";      ps -eo pid,user,etime,args | grep -E 'node|pm2|cloudflared|chrom' | grep -v grep | cut -c1-160
echo "--- PM2-Liste (aus dump, ohne Umgebungswerte)"
for f in /root/.pm2/dump.pm2 /home/*/.pm2/dump.pm2; do [ -f "\$f" ] && { echo "\$f"; node -e 'for (const p of require(process.argv[1])) console.log(" ", p.name, "|", p.pm_exec_path, "|", p.pm_cwd, "|", (p.args||[]).join(" "))' "\$f"; }; done
echo "=== Dienste (laufend)"; systemctl list-units --type=service --state=running --no-legend 2>/dev/null | awk '{print \$1}' | grep -vE '^(systemd-|user@|getty|serial-getty|dbus|polkit|rsyslog|cron|ssh|unattended|networkd|ModemManager|multipathd|udisks|snapd|packagekit|accounts-daemon|irqbalance|qemu-guest)'
echo "=== cloudflared";   systemctl is-active cloudflared 2>/dev/null; ls /etc/cloudflared 2>/dev/null
echo "=== Offene Ports";  ss -tlnp 2>/dev/null | awk 'NR>1{print \$4, \$6}' | sed 's/users:((//; s/,pid.*//' | sort -u
echo "=== Mail";          ss -tln 2>/dev/null | grep -E ':(25|465|587|143|993|110|995) ' && echo "→ Auf Netcup läuft ein Mailserver."
                          command -v docker >/dev/null && docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | head -20
echo "=== Cron";          crontab -l 2>/dev/null; ls /etc/cron.d 2>/dev/null; for u in \$(ls /var/spool/cron/crontabs 2>/dev/null); do echo "crontab \$u"; done
echo "=== Werkzeuge";     for t in ffmpeg sqlite3 rsync tesseract chromium chromium-browser google-chrome; do printf '%s: ' \$t; command -v \$t || echo fehlt; done
echo "=== Schriften";     fc-list : family 2>/dev/null | sort -u | head -40
EOF
    cat "$out"
    echo
    echo "Gespeichert: $out"
    echo "Nächster Schritt: ./migrate.sh install"
}

cmd_install() {
    load_state
    export DEBIAN_FRONTEND=noninteractive
    step "Systempakete"
    apt-get update -qq
    apt-get -y -qq upgrade >/dev/null
    apt-get install -y -qq git curl ca-certificates gnupg rsync sqlite3 openssh-client build-essential python3 ffmpeg \
        jq lsof locales tzdata fonts-liberation fonts-dejavu-core fonts-noto-color-emoji fontconfig xdg-utils wget >/dev/null || die "apt install fehlgeschlagen"

    step "Bibliotheken für Chromium (Puppeteer für PDFs und WhatsApp)"
    local pkgs=() p alt
    for p in libasound2t64:libasound2 libatk-bridge2.0-0t64:libatk-bridge2.0-0 libatk1.0-0t64:libatk1.0-0 libcairo2 libcups2t64:libcups2 \
             libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libglib2.0-0t64:libglib2.0-0 libgtk-3-0t64:libgtk-3-0 libnspr4 libnss3 \
             libpango-1.0-0 libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 \
             libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 libxkbcommon0 libdrm2 libu2f-udev; do
        for alt in ${p//:/ }; do
            if apt-cache show "$alt" >/dev/null 2>&1; then pkgs+=("$alt"); break; fi
        done
    done
    apt-get install -y -qq "${pkgs[@]}" >/dev/null || die "Chromium-Bibliotheken fehlgeschlagen"

    step "Zeitzone ${REMOTE_TZ:-Europe/Berlin} und deutsche Locale"
    timedatectl set-timezone "${REMOTE_TZ:-Europe/Berlin}" 2>/dev/null || ln -sf "/usr/share/zoneinfo/${REMOTE_TZ:-Europe/Berlin}" /etc/localtime
    sed -i 's/^# *de_DE.UTF-8/de_DE.UTF-8/' /etc/locale.gen; locale-gen >/dev/null 2>&1 || true

    local major="${NODE_MAJOR:-22}"
    step "Node.js $major (gleiche Hauptversion wie auf Netcup)"
    if ! command -v node >/dev/null || [ "$(node -v | sed -E 's/^v([0-9]+).*/\1/')" != "$major" ]; then
        curl -fsSL "https://deb.nodesource.com/setup_${major}.x" | bash - >/dev/null || die "NodeSource-Setup fehlgeschlagen"
        apt-get install -y -qq nodejs >/dev/null || die "nodejs fehlgeschlagen"
    fi
    c_ok "node $(node -v), npm $(npm -v)"

    step "PM2"
    command -v pm2 >/dev/null || npm install -g pm2 --no-audit --no-fund >/dev/null
    c_ok "pm2 $(pm2 -v | tail -1)"

    if [ "${APP_OWNER:-root}" != root ] && ! id "$APP_OWNER" >/dev/null 2>&1; then
        step "Benutzer $APP_OWNER anlegen (gleicher Besitzer wie auf Netcup)"
        useradd -m -s /bin/bash "$APP_OWNER"
    fi
    echo
    echo "Nächster Schritt: ./migrate.sh copy   (Probe-Kopie, Netcup läuft weiter)"
}

cmd_copy() {
    load_state
    local final=0; [ "${1:-}" = "--final" ] && final=1
    command -v rsync >/dev/null || die "Erst ./migrate.sh install ausführen."

    if [ $final = 1 ]; then
        step "Prüfe, ob die App auf Netcup gestoppt ist"
        local pids; pids="$(remote_app_pids "$APP_DIR")"
        if [ -n "$pids" ]; then
            echo "Auf Netcup läuft die App noch (PID $pids)."
            echo "Bitte dort zuerst stoppen:  pm2 stop invoice-app && pm2 save"
            die "Endgültige Kopie abgebrochen, damit keine Buchung/Nachricht verloren geht."
        fi
        c_ok "App auf Netcup läuft nicht mehr"
        if pgrep -f 'node.*server\.js' >/dev/null; then die "Hier läuft die App schon. Erst hier pm2 stop invoice-app, dann erneut."; fi
    else
        step "Probe-Kopie (Netcup läuft weiter, die Datenbank kann dabei unvollständig sein)"
    fi

    mkdir -p "$APP_DIR"
    local excl=(--exclude=/node_modules/ --exclude=/temp/ --exclude=/.wwebjs_cache/ --exclude='/core*')
    if r 'command -v rsync >/dev/null'; then
        rsync -aH --numeric-ids --delete --info=progress2,stats1 "${excl[@]}" \
            -e "ssh -o ControlMaster=auto -o ControlPath=$SOCK -o ControlPersist=15m" \
            "$REMOTE:$APP_DIR/" "$APP_DIR/" || die "rsync fehlgeschlagen"
    else
        c_warn "rsync fehlt auf Netcup, kopiere per tar (ohne Löschen alter Dateien hier)"
        r "tar -C '$APP_DIR' -cpf - --exclude=./node_modules --exclude=./temp --exclude=./.wwebjs_cache ." | tar -C "$APP_DIR" -xpf - || die "tar-Kopie fehlgeschlagen"
    fi
    if [ "${APP_OWNER:-root}" != root ]; then chown -R "$APP_OWNER:" "$APP_DIR"; fi
    chmod 600 "$APP_DIR/.env" 2>/dev/null || true

    step "Datenbank prüfen"
    local f h1 h2
    for f in rental.db rental.db-wal; do
        [ -f "$APP_DIR/$f" ] || continue
        h1="$(sha256sum "$APP_DIR/$f" | cut -d' ' -f1)"; h2="$(r "sha256sum '$APP_DIR/$f'" | cut -d' ' -f1)"
        if [ "$h1" = "$h2" ]; then c_ok "$f identisch mit Netcup"; else
            if [ $final = 1 ]; then c_bad "$f weicht von Netcup ab"; else c_warn "$f weicht ab (normal, Netcup läuft noch)"; fi
        fi
    done
    # Prüfung auf einer Kopie, damit die kopierte Datei unverändert bleibt
    local tmp; tmp="$(mktemp -d)"; cp "$APP_DIR"/rental.db* "$tmp"/ 2>/dev/null
    local ic; ic="$(sqlite3 "$tmp/rental.db" 'PRAGMA integrity_check;' 2>&1 | head -3)"
    [ "$ic" = ok ] && c_ok "integrity_check: ok" || c_bad "integrity_check: $ic"
    sqlite3 "$tmp/rental.db" "SELECT 'Buchungen: '||(SELECT count(*) FROM bookings)||', Rechnungen: '||(SELECT count(*) FROM invoices)||', Gäste: '||(SELECT count(*) FROM guests);" 2>/dev/null | sed 's/^/  ℹ /'
    rm -rf "$tmp"

    step "Abhängigkeiten neu bauen (node_modules werden nicht kopiert, better-sqlite3 ist nativ)"
    (cd "$APP_DIR" && if [ "${APP_OWNER:-root}" = root ]; then npm ci --no-audit --no-fund; else sudo -u "$APP_OWNER" npm ci --no-audit --no-fund; fi) >/tmp/npm-ci.log 2>&1 \
        && c_ok "npm ci ok ($(cd "$APP_DIR" && node -p "require('./package.json').version"))" \
        || { tail -20 /tmp/npm-ci.log; die "npm ci fehlgeschlagen (Log: /tmp/npm-ci.log)"; }

    [ $final = 1 ] && touch "$STATE_DIR/final-copy-done"
    echo
    if [ $final = 1 ]; then echo "Nächster Schritt: ./migrate.sh start"; else echo "Nächster Schritt: ./migrate.sh selftest"; fi
}

cmd_selftest() {
    load_state
    cd "$APP_DIR" || die "$APP_DIR fehlt. Erst ./migrate.sh copy."
    step "Selbsttest ohne App-Start (keine Telegram-/WhatsApp-/Nuki-Aktionen)"
    command -v ffmpeg >/dev/null && c_ok "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')" || c_bad "ffmpeg fehlt"
    local tmp; tmp="$(mktemp -d)"; cp rental.db* "$tmp"/ 2>/dev/null
    node -e "
        const D = require('better-sqlite3'); const d = new D(process.argv[1], { readonly: true });
        console.log('  ✔ better-sqlite3 lädt, Buchungen:', d.prepare('SELECT count(*) n FROM bookings').get().n);
    " "$tmp/rental.db" || c_bad "better-sqlite3 lädt nicht"
    rm -rf "$tmp"
    node -e "
        (async () => {
          const p = require('puppeteer');
          const b = await p.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
          const pg = await b.newPage(); await pg.setContent('<h1>Beckhome Testrechnung äöü €</h1>');
          const pdf = await pg.pdf({ format: 'A4' }); await b.close();
          require('fs').writeFileSync('/tmp/beckhome-test.pdf', pdf);
          console.log('  ✔ Chromium erzeugt PDF (' + pdf.length + ' Bytes, /tmp/beckhome-test.pdf)');
        })().catch(e => { console.log('  ✘ Chromium/PDF: ' + e.message); process.exit(1); });
    " || c_bad "Chromium startet nicht (Bibliotheken? nesting=1?)"
    node -e "require('tesseract.js'); console.log('  ✔ tesseract.js lädt')" 2>/dev/null || c_warn "tesseract.js lädt nicht"
    echo
    echo "Wenn alles ✔: Termin für die Umstellung wählen (ca. 15 min Ausfall), dann"
    echo "  1. auf Netcup:  pm2 stop invoice-app && pm2 save"
    echo "  2. hier:        ./migrate.sh copy --final && ./migrate.sh start"
}

cmd_start() {
    load_state
    [ -f "$STATE_DIR/final-copy-done" ] || { echo "Es gab noch keine endgültige Kopie (./migrate.sh copy --final)."; read -r -p "Trotzdem starten? [j/N] " a </dev/tty; [ "$a" = j ] || exit 1; }
    [ -z "$(remote_app_pids "$APP_DIR")" ] || die "Auf Netcup läuft die App noch. Zwei Instanzen würden Telegram, WhatsApp und Nuki doppelt bedienen."
    cd "$APP_DIR" || exit 1

    step "Erreichbarkeit für den Cloudflare Tunnel"
    local lh ctip; lh="$(sed -n 's/^LISTEN_HOST=//p' .env | tr -d '"'"'"' ')"; ctip="$(hostname -I | awk '{print $1}')"
    if [ "$lh" = 127.0.0.1 ] || [ "$lh" = localhost ]; then
        if command -v cloudflared >/dev/null; then
            c_ok "LISTEN_HOST=$lh, cloudflared läuft in diesem Container"
        else
            echo "  In .env steht LISTEN_HOST=$lh. Der Tunnel auf dem Proxmox-Host/anderem Container erreicht die App so nicht."
            read -r -p "  LISTEN_HOST auf $ctip setzen (nur diese Container-IP)? [J/n] " a </dev/tty
            if [ "${a:-j}" != n ]; then cp .env "$STATE_DIR/.env.vorher"; sed -i "s/^LISTEN_HOST=.*/LISTEN_HOST=$ctip/" .env; c_ok "LISTEN_HOST=$ctip (alte .env: $STATE_DIR/.env.vorher)"; fi
        fi
    fi
    if [[ ! "$ctip" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]] && ! grep -q '^LISTEN_HOST=127' .env; then
        c_warn "Container-IP $ctip ist öffentlich: Port 3000 ist dann von außen erreichbar. In Proxmox-Firewall sperren oder LISTEN_HOST=127.0.0.1 mit cloudflared im Container."
    fi

    step "App unter PM2 starten (Name wie auf Netcup: invoice-app)"
    local as=(); [ "${APP_OWNER:-root}" != root ] && as=(sudo -u "$APP_OWNER" -H)
    "${as[@]}" pm2 describe invoice-app >/dev/null 2>&1 && "${as[@]}" pm2 restart invoice-app || "${as[@]}" pm2 start server.js --name invoice-app
    # Weitere PM2-Prozesse aus dem Netcup-Verzeichnis (z. B. beckhome-watchdog), falls vorhanden
    for f in watchdog.js; do [ -f "$f" ] && { "${as[@]}" pm2 describe beckhome-watchdog >/dev/null 2>&1 || "${as[@]}" pm2 start "$f" --name beckhome-watchdog; }; done
    "${as[@]}" pm2 save
    env PATH="$PATH" pm2 startup systemd -u "${APP_OWNER:-root}" --hp "$(getent passwd "${APP_OWNER:-root}" | cut -d: -f6)" >/dev/null && c_ok "Autostart nach Neustart eingerichtet"
    sleep 8
    cmd_verify
}

cmd_verify() {
    load_state
    WARN=0; BAD=0
    cd "$APP_DIR" || exit 1
    local port; port="$(sed -n 's/^PORT=//p' .env | tr -d ' "')"; port="${port:-3000}"
    local lh; lh="$(sed -n 's/^LISTEN_HOST=//p' .env | tr -d ' "')"; lh="${lh:-127.0.0.1}"
    local as=(); [ "${APP_OWNER:-root}" != root ] && as=(sudo -u "$APP_OWNER" -H)

    step "Prozesse"
    "${as[@]}" pm2 jlist 2>/dev/null | jq -r '.[] | "\(.name) \(.pm2_env.status) Neustarts:\(.pm2_env.restart_time)"' | while read -r n s rs; do
        [ "$s" = online ] && echo -e "  \e[32m✔\e[0m $n $s $rs" || echo -e "  \e[31m✘\e[0m $n $s $rs"; done
    [ -n "$(remote_app_pids "$APP_DIR")" ] && c_bad "App läuft AUCH NOCH auf Netcup → dort pm2 stop invoice-app && pm2 save" || c_ok "Netcup-App ist aus"
    [ "$(date +%Z)" = "$(TZ="${REMOTE_TZ:-Europe/Berlin}" date +%Z)" ] && c_ok "Zeitzone $(date +%Z) wie Netcup" || c_bad "Zeitzone weicht ab"

    step "App lokal"
    curl -fs -m 5 "http://$lh:$port/api/health" >/dev/null && c_ok "http://$lh:$port/api/health antwortet" || c_bad "/api/health antwortet nicht (pm2 logs invoice-app)"
    curl -fs -m 5 -o /dev/null "http://$lh:$port/admin" && c_ok "Admin-Login-Seite lädt" || c_warn "/admin lädt nicht"

    step "Logs der letzten Minuten"
    local log; log="$("${as[@]}" pm2 logs invoice-app --nostream --lines 300 2>/dev/null)"
    echo "$log" | grep -qiE '409.*conflict|terminated by other getUpdates' && c_bad "Telegram 409: ein anderer Server pollt noch mit demselben Bot" || c_ok "kein Telegram-Konflikt"
    local wa; wa="$(echo "$log" | grep -E 'WhatsApp Web verbunden|WhatsApp QR-Code bereit' | tail -1)"
    if [[ "$wa" == *verbunden* ]]; then c_ok "WhatsApp verbunden (Sitzung von Netcup übernommen)"
    elif [[ "$wa" == *QR* ]]; then c_warn "WhatsApp will einen QR-Code: Admin → Einstellungen → WhatsApp neu koppeln"
    else c_warn "WhatsApp-Status unklar, im Admin unter Einstellungen prüfen"; fi
    echo "$log" | grep -iE 'error|fehler|✘|❌' | grep -viE 'favicon' | tail -8 | sed 's/^/    /'

    step "Einstellungen, die auf Netcup zeigen könnten"
    local tmp; tmp="$(mktemp -d)"; cp rental.db* "$tmp"/ 2>/dev/null
    sqlite3 "$tmp/rental.db" "
      SELECT 'SMTP (Rechnungsversand): '||coalesce(json_extract(value,'\$.host'),'-') FROM settings WHERE key='smtp';
      SELECT 'Gast-Mail IMAP: '||coalesce(json_extract(value,'\$.mail.host'),'-') FROM settings WHERE key='guest_chat';
      SELECT 'Paperless: '||coalesce(json_extract(value,'\$.url'),'-') FROM settings WHERE key='paperless';
      SELECT 'Öffentliche Adresse: '||coalesce(json_extract(value,'\$.public_url'),'-') FROM settings WHERE key='site';
    " 2>/dev/null | while read -r line; do
        if echo "$line" | grep -qiE "localhost|127\.0\.0\.1"; then
            echo -e "  \e[31m✘\e[0m $line  ← zeigt auf den alten Server selbst, hier gibt es diesen Dienst nicht"
        elif echo "$line" | grep -qiE "${REMOTE_IP//./\\.}|mail\.beckhome"; then
            echo -e "  ℹ $line  ← Netcup-Mailserver, Netcup muss dafür an bleiben"
        else echo "  ℹ $line"; fi
    done
    rm -rf "$tmp"

    step "Öffentlich über Cloudflare"
    local pub; pub="$(sqlite3 -readonly rental.db "SELECT json_extract(value,'\$.public_url') FROM settings WHERE key='site'" 2>/dev/null)"; pub="${pub:-https://beckhome.cloud}"
    if curl -fs -m 10 "$pub/api/health" >/dev/null; then
        c_ok "$pub/api/health antwortet"
        [ -z "$(remote_app_pids "$APP_DIR")" ] && c_ok "Netcup-App ist aus, also antwortet dieser Container"
    else
        c_warn "$pub antwortet (noch) nicht. Tunnel-Hostnamen schon auf diesen Container umgestellt?"
    fi
    echo
    echo "Ergebnis: ${BAD:-0} Fehler, ${WARN:-0} Hinweise."
}

case "${1:-}" in
    probe)    shift; cmd_probe "$@" ;;
    install)  cmd_install ;;
    copy)     shift; cmd_copy "$@" ;;
    selftest) cmd_selftest ;;
    start)    cmd_start ;;
    verify)   cmd_verify ;;
    *) sed -n '2,15p' "$0"; exit 1 ;;
esac
