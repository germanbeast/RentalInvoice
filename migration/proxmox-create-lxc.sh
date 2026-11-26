#!/bin/bash
# Legt auf dem Proxmox-Host einen LXC-Container für die Beckhome-App an und lädt migrate.sh hinein.
# Aufruf auf dem Proxmox-Host als root:
#   bash proxmox-create-lxc.sh
# Werte lassen sich per Umgebungsvariable vorgeben, z. B.:
#   CTID=120 BRIDGE=vmbr1 IP=10.10.10.20/24 GW=10.10.10.1 bash proxmox-create-lxc.sh
# Ohne Vorgabe fragt das Skript nach. Am Netcup-Server ändert es nichts.
set -euo pipefail

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/germanbeast/RentalInvoice/${BRANCH:-main}}"

[ "$(id -u)" = 0 ] || { echo "❌ Bitte als root auf dem Proxmox-Host ausführen."; exit 1; }
command -v pct >/dev/null || { echo "❌ pct nicht gefunden. Läuft das hier wirklich auf dem Proxmox-Host?"; exit 1; }

ask() { # ask VAR "Frage" "Vorgabe"
    local var="$1" q="$2" def="$3" val
    if [ -n "${!var:-}" ]; then return; fi
    read -r -p "$q [$def]: " val </dev/tty || true
    printf -v "$var" '%s' "${val:-$def}"
}

echo "🧭 Vorhandene Container und ihr Netzwerk (zur Orientierung):"
for id in $(pct list 2>/dev/null | awk 'NR>1{print $1}'); do
    printf '   CT %-5s %-20s %s\n' "$id" "$(pct config "$id" | awk -F': ' '/^hostname/{print $2}')" "$(pct config "$id" | awk -F': ' '/^net0/{print $2}')"
done
echo "   Bridges: $(ls /sys/class/net | grep -E '^vmbr' | tr '\n' ' ')"
echo

ask CTID      "Container-ID"                       "$(pvesh get /cluster/nextid)"
ask CTNAME    "Hostname"                           "beckhome-app"
ask BRIDGE    "Netzwerk-Bridge"                    "vmbr0"
ask IP        "IP (dhcp oder z. B. 10.0.0.20/24)"  "dhcp"
if [ "$IP" != "dhcp" ]; then ask GW "Gateway" ""; fi
ask STORAGE   "Storage für die Festplatte"         "$(pvesm status --content rootdir 2>/dev/null | awk 'NR>1 && $3=="active"{print $1; exit}')"
ask DISK      "Festplatte in GB"                   "32"
ask MEMORY    "RAM in MB (2× Chromium + OCR)"      "4096"
ask CORES     "CPU-Kerne"                          "2"

if pct status "$CTID" >/dev/null 2>&1; then echo "❌ CT $CTID existiert bereits."; exit 1; fi

echo "📦 Suche Ubuntu-24.04-Vorlage (wie auf Netcup: Ubuntu)…"
pveam update >/dev/null || true
TEMPLATE_NAME="$(pveam available --section system | awk '{print $2}' | grep -E '^ubuntu-24\.04-standard' | sort -V | tail -1)"
[ -n "$TEMPLATE_NAME" ] || { echo "❌ Keine ubuntu-24.04-standard Vorlage gefunden (pveam available)."; exit 1; }
TPL_STORAGE="$(pvesm status --content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active"{print $1; exit}')"
TPL_STORAGE="${TPL_STORAGE:-local}"
if ! pveam list "$TPL_STORAGE" | grep -q "$TEMPLATE_NAME"; then
    pveam download "$TPL_STORAGE" "$TEMPLATE_NAME"
fi

NET="name=eth0,bridge=$BRIDGE,firewall=1"
if [ "$IP" = "dhcp" ]; then NET="$NET,ip=dhcp"; else NET="$NET,ip=$IP${GW:+,gw=$GW}"; fi

echo "🛠️  Lege CT $CTID ($CTNAME) an…"
pct create "$CTID" "$TPL_STORAGE:vztmpl/$TEMPLATE_NAME" \
    --hostname "$CTNAME" \
    --unprivileged 1 \
    --features nesting=1 \
    --cores "$CORES" --memory "$MEMORY" --swap 1024 \
    --rootfs "$STORAGE:$DISK" \
    --net0 "$NET" \
    --timezone Europe/Berlin \
    --onboot 1 --startup order=50 \
    --description "Beckhome App (RentalInvoice), umgezogen von Netcup"

pct start "$CTID"
echo "⏳ Warte auf Netzwerk im Container…"
for i in $(seq 1 30); do
    if pct exec "$CTID" -- bash -c 'getent hosts github.com >/dev/null' 2>/dev/null; then break; fi
    sleep 2
done

pct exec "$CTID" -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null && \
    curl -fsSL '$REPO_RAW/migration/migrate.sh' -o /root/migrate.sh && chmod +x /root/migrate.sh"

CT_IP="$(pct exec "$CTID" -- bash -c "hostname -I | awk '{print \$1}'")"
echo
echo "✅ Container $CTID läuft, IP: $CT_IP"
echo "   Weiter im Container:"
echo "     pct enter $CTID"
echo "     ./migrate.sh probe root@<Netcup-IP>"
