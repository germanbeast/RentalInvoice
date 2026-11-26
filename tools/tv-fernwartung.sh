#!/bin/bash
# TV-Box Fernwartung: ws-scrcpy + adb im Ferienwohnung-Container (Proxmox LXC, Ubuntu 24.04) einrichten.
#
#   bash tv-fernwartung.sh            einrichten oder aktualisieren (kann beliebig oft laufen)
#   bash tv-fernwartung.sh status     nur prüfen
#
# Was passiert:
#   - installiert adb (Ubuntu-Paket) und baut ws-scrcpy (github.com/NetrisTV/ws-scrcpy, fest v0.8.1) nach /opt/ws-scrcpy
#   - ws-scrcpy lauscht NUR auf 127.0.0.1:8000. Von außen ist es nicht erreichbar, nur über den Admin:
#     https://admin.beckhome.cloud/tv-fernwartung/ (Login + Recht „Einstellungen & Integrationen: Bearbeiten“)
#   - startet ws-scrcpy unter PM2 (Name ws-scrcpy) als derselbe Benutzer wie die App, mit Autostart
#   - Die Box verbindet sich selbst über die App mit dem Server (TV-App 1.12, „Fernwartung erlauben“ im Admin)
set -uo pipefail

WS_VERSION=v0.8.1
SRC=/opt/ws-scrcpy-src
DEST=/opt/ws-scrcpy
PORT=8000

c_ok()   { echo -e "  \e[32m✔\e[0m $*"; }
c_warn() { echo -e "  \e[33m⚠\e[0m $*"; WARN=$((${WARN:-0}+1)); }
c_bad()  { echo -e "  \e[31m✘\e[0m $*"; BAD=$((${BAD:-0}+1)); }
die()    { echo -e "\e[31m❌ $*\e[0m"; exit 1; }
step()   { echo; echo -e "\e[1m▶ $*\e[0m"; }

[ "$(id -u)" = 0 ] || die "Bitte als root im Container ausführen (pct enter <ID>)."

# ---------------------------------------------------------------- App finden (Ordner + Benutzer)
find_app() {
    APP_DIR=""; APP_OWNER=""
    # 1. Vom Umzug gemerkt (migration/migrate.sh)
    if [ -f /root/beckhome-migration/remote.env ]; then
        # shellcheck disable=SC1091
        . /root/beckhome-migration/remote.env
    fi
    # 2. Laufender PM2-Prozess invoice-app (root oder ein anderer Benutzer)
    if [ -z "$APP_DIR" ] || [ ! -f "$APP_DIR/server.js" ]; then
        local u home d j
        for u in root $(awk -F: '$3>=1000 && $3<60000 {print $1}' /etc/passwd); do
            home="$(getent passwd "$u" | cut -d: -f6)"
            [ -f "$home/.pm2/dump.pm2" ] || continue
            if [ "$u" = root ]; then j="$(pm2 jlist 2>/dev/null)"; else j="$(sudo -u "$u" -H env PATH="$PATH" pm2 jlist 2>/dev/null)"; fi
            d="$(echo "$j" | jq -r '.[] | select(.name=="invoice-app") | .pm2_env.pm_cwd' 2>/dev/null | head -1)"
            if [ -n "$d" ] && [ -f "$d/server.js" ]; then APP_DIR="$d"; APP_OWNER="$u"; break; fi
        done
    fi
    [ -n "$APP_DIR" ] && [ -f "$APP_DIR/server.js" ] || die "App-Ordner nicht gefunden (kein PM2-Prozess invoice-app). Läuft die App in diesem Container?"
    APP_OWNER="${APP_OWNER:-$(stat -c %U "$APP_DIR/server.js")}"
    AS=(); [ "$APP_OWNER" != root ] && AS=(sudo -u "$APP_OWNER" -H env PATH="$PATH")
    OWNER_HOME="$(getent passwd "$APP_OWNER" | cut -d: -f6)"
}

cmd_install() {
    export DEBIAN_FRONTEND=noninteractive
    find_app
    step "App gefunden"
    c_ok "$APP_DIR (Benutzer $APP_OWNER, Version $(cd "$APP_DIR" && node -p "require('./package.json').version" 2>/dev/null))"
    if [ -f "$APP_DIR/tv-remote.js" ]; then
        c_ok "App kennt die Fernwartung (tv-remote.js)"
    else
        c_warn "Die App ist noch älter als v1.58.0. Danach einmal im App-Ordner ./update.sh ausführen (oder Admin → Einstellungen → Update)."
    fi

    step "Pakete: adb, git, Build-Werkzeuge (für ws-scrcpy)"
    apt-get update -qq || c_warn "apt-get update meldet Fehler (siehe oben)"
    apt-get install -y -qq adb git build-essential python3 curl jq rsync iproute2 ca-certificates >/dev/null || die "apt install fehlgeschlagen"
    c_ok "$(adb version | head -1), $(git --version)"
    command -v node >/dev/null || die "node fehlt. Die App braucht es auch, läuft sie wirklich hier?"
    c_ok "node $(node -v), npm $(npm -v)"
    command -v pm2 >/dev/null || die "pm2 fehlt"

    step "ws-scrcpy $WS_VERSION holen"
    if [ -d "$SRC/.git" ]; then
        git -C "$SRC" fetch -q --depth 1 origin tag "$WS_VERSION" && git -C "$SRC" -c advice.detachedHead=false checkout -q -f "$WS_VERSION" || die "git fetch fehlgeschlagen"
    else
        rm -rf "$SRC"
        git -c advice.detachedHead=false clone -q --depth 1 --branch "$WS_VERSION" https://github.com/NetrisTV/ws-scrcpy.git "$SRC" || die "git clone fehlgeschlagen"
    fi
    c_ok "$SRC ($(git -C "$SRC" describe --tags 2>/dev/null))"

    step "Nur auf 127.0.0.1 lauschen (Schutz: von außen nicht erreichbar)"
    local f="$SRC/src/server/services/HttpServer.ts"
    if grep -q "server.listen(port, () => {" "$f"; then
        sed -i "s/server.listen(port, () => {/server.listen(port, process.env.WS_SCRCPY_HOST || '127.0.0.1', () => {/" "$f"
    fi
    grep -q "WS_SCRCPY_HOST || '127.0.0.1'" "$f" || die "Anpassung in $f hat nicht geklappt. ws-scrcpy wird NICHT gestartet."
    c_ok "server.listen(port, '127.0.0.1')"

    step "ws-scrcpy bauen (dauert 1–3 Minuten)"
    (cd "$SRC" && npm ci --no-audit --no-fund --loglevel=error >/tmp/ws-scrcpy-build.log 2>&1 && npm run dist >>/tmp/ws-scrcpy-build.log 2>&1) \
        || { tail -30 /tmp/ws-scrcpy-build.log; die "Bauen fehlgeschlagen (Log: /tmp/ws-scrcpy-build.log)"; }
    c_ok "gebaut"
    mkdir -p "$DEST"
    rsync -a --delete --exclude node_modules --exclude config.yaml "$SRC/dist/" "$DEST/" 2>/dev/null || { rm -rf "${DEST:?}"/*; cp -a "$SRC/dist/." "$DEST/"; }
    (cd "$DEST" && npm install --omit=dev --no-audit --no-fund --loglevel=error >>/tmp/ws-scrcpy-build.log 2>&1) || { tail -30 /tmp/ws-scrcpy-build.log; die "npm install in $DEST fehlgeschlagen"; }
    cat > "$DEST/config.yaml" <<EOF
# Von tools/tv-fernwartung.sh geschrieben. Nur HTTP auf 127.0.0.1:$PORT, der Admin leitet weiter.
runGoogTracker: true
runApplTracker: false
server:
  - secure: false
    port: $PORT
EOF
    chown -R "$APP_OWNER": "$DEST"
    c_ok "$DEST"

    step "adb-Server als $APP_OWNER (der Schlüssel liegt in $OWNER_HOME/.android)"
    "${AS[@]}" adb start-server >/dev/null 2>&1 && c_ok "adb läuft" || c_warn "adb start-server meldet einen Fehler"
    [ -f "$OWNER_HOME/.android/adbkey.pub" ] && c_ok "Schlüssel: $OWNER_HOME/.android/adbkey.pub (diesen erlaubt der Fernseher beim ersten Mal)"

    step "ws-scrcpy unter PM2 starten (Autostart)"
    # immer neu anlegen: pm2 restart würde die Umgebungsvariablen (Konfiguration, 127.0.0.1) verlieren
    "${AS[@]}" pm2 delete ws-scrcpy >/dev/null 2>&1
    (cd "$DEST" && "${AS[@]}" env WS_SCRCPY_CONFIG="$DEST/config.yaml" WS_SCRCPY_HOST=127.0.0.1 \
        pm2 start "$DEST/index.js" --name ws-scrcpy --cwd "$DEST" >/dev/null) || die "pm2 start ws-scrcpy fehlgeschlagen"
    "${AS[@]}" pm2 save >/dev/null
    c_ok "pm2: ws-scrcpy"
    sleep 4

    step "App neu starten (damit sie den Tunnel-Port öffnet)"
    if [ -f "$APP_DIR/tv-remote.js" ]; then
        "${AS[@]}" pm2 restart invoice-app >/dev/null && c_ok "invoice-app neu gestartet"
        sleep 6
    else
        c_warn "Übersprungen, erst ./update.sh im App-Ordner"
    fi
    cmd_status
}

cmd_status() {
    WARN=0; BAD=0
    [ -n "${APP_DIR:-}" ] || find_app
    step "Prüfung"
    "${AS[@]}" pm2 jlist 2>/dev/null | jq -r '.[] | select(.name=="ws-scrcpy" or .name=="invoice-app") | "\(.name) \(.pm2_env.status)"' | while read -r n s; do
        [ "$s" = online ] && echo -e "  \e[32m✔\e[0m pm2 $n $s" || echo -e "  \e[31m✘\e[0m pm2 $n $s"; done
    if curl -fs -m 5 -o /dev/null "http://127.0.0.1:$PORT/"; then c_ok "ws-scrcpy antwortet auf 127.0.0.1:$PORT"; else c_bad "ws-scrcpy antwortet nicht (pm2 logs ws-scrcpy)"; fi
    local ip; ip="$(hostname -I | awk '{print $1}')"
    if [ -n "$ip" ] && curl -fs -m 3 -o /dev/null "http://$ip:$PORT/" 2>/dev/null; then
        c_bad "ws-scrcpy ist auf $ip:$PORT erreichbar! Das darf nicht sein: pm2 delete ws-scrcpy und Skript erneut ausführen"
    else
        c_ok "auf der Container-IP ${ip:-?}:$PORT NICHT erreichbar (richtig so)"
    fi
    if command -v ss >/dev/null; then
        ss -ltn "sport = :15555" | grep -q 127.0.0.1:15555 && c_ok "Tunnel-Port 127.0.0.1:15555 offen (Box ist verbunden)" \
            || echo "  ℹ Tunnel-Port 15555 noch zu: öffnet sich, sobald die Box verbunden ist (Admin → TV-Box → Fernwartung erlauben)"
    fi
    local dev; dev="$("${AS[@]}" adb devices 2>/dev/null | grep '^127.0.0.1:15555' | cut -f2)"
    case "$dev" in
        device)       c_ok "adb: TV-Box verbunden und freigegeben" ;;
        unauthorized) c_warn "adb: Freigabe fehlt. Am Fernseher „USB-Debugging zulassen?“ → Haken „Immer“ → OK" ;;
        "")           echo "  ℹ adb: Box noch nicht verbunden" ;;
        *)            c_warn "adb: $dev" ;;
    esac
    echo
    echo "Ergebnis: ${BAD:-0} Fehler, ${WARN:-0} Hinweise."
    echo
    echo "Weiter:"
    echo "  1. Am PC TV-Box-Fernwartung.bat ausführen (ADB über Netzwerk auf der Box einschalten)"
    echo "  2. Admin → Einstellungen → TV-Box → „Fernwartung erlauben“ anhaken"
    echo "  3. Beim ersten Mal am Fernseher „USB-Debugging zulassen?“ mit „Immer“ bestätigen"
    echo "  4. „Fernwartung öffnen“ → beim Gerät 127.0.0.1:15555 auf „H264 Converter“"
}

case "${1:-install}" in
    install) cmd_install ;;
    status)  cmd_status ;;
    *) sed -n '2,13p' "$0"; exit 1 ;;
esac
