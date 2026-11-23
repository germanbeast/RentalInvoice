#!/bin/sh
# Gäste-WLAN mit Anmeldeseite (OpenWrt + openNDS), erzeugt von der Ferienwohnungs-App.
# Erstellt: 2026-11-23T17:37:05.429Z
# Darf mehrfach ausgeführt werden, es stellt jedes Mal denselben Zustand her.

SSID='Beckhome Gäste'
WLANKEY=''
FASKEY='k'
FQDN='beckhome.cloud'
FASPATH='/wlan'
GWNAME='Beckhome-x'
MAXCLIENTS='10'
SETUPURL='https://beckhome.cloud/wlan/setup.sh?k=tok'
SETUPVER='cc565ffe3b9f'

say()  { echo ""; echo "==> $*"; }
ok()   { echo "    ok: $*"; }
fail() { echo ""; echo "!!! FEHLER: $*"; echo "!!! Bitte diese Meldung abfotografieren und dem Admin schicken."; exit 1; }

[ -f /etc/openwrt_release ] || fail "Das ist kein OpenWrt-Router."
. /etc/openwrt_release
echo "Gäste-WLAN mit Anmeldeseite wird eingerichtet ($DISTRIB_DESCRIPTION)"

if command -v apk >/dev/null 2>&1; then PM=apk; else PM=opkg; fi
pm_update()  { if [ "$PM" = apk ]; then apk update; else opkg update; fi; }
pm_has()     { if [ "$PM" = apk ]; then apk info -e "$1" >/dev/null 2>&1; else opkg list-installed | grep -q "^$1 "; fi; }
pm_install() { if [ "$PM" = apk ]; then apk add "$@"; else opkg install "$@"; fi; }

# --- 1. Internet ------------------------------------------------------------
say "1/6 Internet prüfen"
FASIP=""
for i in 1 2 3 4 5 6; do
    FASIP=$(nslookup "$FQDN" 2>/dev/null | awk '/^Name/ { n=1 } n && /^Address/ && $NF ~ /^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$/ { print $NF; exit }')
    [ -n "$FASIP" ] && break
    sleep 5
done
[ -n "$FASIP" ] || fail "Der Router kommt nicht ins Internet. Steckt das Kabel von der FRITZ!Box im blauen WAN-Anschluss des Routers?"
ok "$FQDN = $FASIP"

WANIP=$(ubus call network.interface.wan status 2>/dev/null | jsonfilter -e '@["ipv4-address"][0].address' 2>/dev/null)
[ -n "$WANIP" ] && ok "Router-Adresse im FRITZ!Box-Netz: $WANIP"

# Gäste-Netz: 192.168.50.x, außer die FRITZ!Box nutzt das schon
GNET=192.168.50
case "$WANIP" in 192.168.50.*) GNET=192.168.150 ;; esac
LANIP=$(uci -q get network.lan.ipaddr)
case "$WANIP" in 192.168.1.*)
    if [ "$LANIP" = "192.168.1.1" ]; then
        uci set network.lan.ipaddr='192.168.2.1'
        echo "    Hinweis: Die FRITZ!Box nutzt 192.168.1.x, der Router ist am Kabel-Anschluss künftig unter 192.168.2.1 erreichbar."
    fi ;;
esac

# --- 2. Pakete ----------------------------------------------------------------
say "2/6 Programme installieren (openNDS, dnsmasq-full) - dauert 1-2 Minuten"
pm_update >/dev/null 2>&1 || pm_update || fail "Paketliste konnte nicht geladen werden."
pm_has ca-bundle || pm_install ca-bundle >/dev/null 2>&1
pm_has opennds || pm_install opennds || fail "openNDS konnte nicht installiert werden."
ok "openNDS installiert"

if ! pm_has dnsmasq-full; then
    # Erst herunterladen, dann tauschen: ohne dnsmasq hat der Router kurz kein DNS.
    rm -rf /tmp/bh-pkg && mkdir -p /tmp/bh-pkg && cd /tmp/bh-pkg || fail "/tmp nicht beschreibbar"
    if [ "$PM" = apk ]; then apk fetch -o /tmp/bh-pkg dnsmasq-full >/dev/null 2>&1; else opkg download dnsmasq-full >/dev/null 2>&1; fi
    PKG=$(ls /tmp/bh-pkg/dnsmasq-full* 2>/dev/null | head -1)
    [ -n "$PKG" ] || fail "dnsmasq-full konnte nicht geladen werden."
    UP=$(grep nameserver /tmp/resolv.conf.d/resolv.conf.auto 2>/dev/null | head -2)
    [ -n "$UP" ] || UP="nameserver 1.1.1.1"
    rm -f /tmp/resolv.conf; echo "$UP" > /tmp/resolv.conf
    if [ "$PM" = apk ]; then apk del dnsmasq >/dev/null 2>&1; apk add "$PKG" >/dev/null 2>&1 || apk add dnsmasq-full >/dev/null 2>&1
    else opkg remove dnsmasq >/dev/null 2>&1; opkg install "$PKG" >/dev/null 2>&1 || opkg install dnsmasq-full >/dev/null 2>&1; fi
    if ! pm_has dnsmasq-full; then
        pm_install dnsmasq >/dev/null 2>&1
        /etc/init.d/dnsmasq restart
        fail "dnsmasq-full konnte nicht installiert werden (der normale dnsmasq ist wieder drauf)."
    fi
    cd /
    ok "dnsmasq-full installiert"
else
    ok "dnsmasq-full war schon da"
fi

# --- 3. Netz für Gäste --------------------------------------------------------
say "3/6 Gäste-Netz anlegen ($GNET.0/24)"
uci set system.@system[0].hostname='Gaeste-WLAN'
uci set system.@system[0].zonename='Europe/Berlin'
uci set system.@system[0].timezone='CET-1CEST,M3.5.0,M10.5.0/3'

uci set network.gaeste_dev=device
uci set network.gaeste_dev.type='bridge'
uci set network.gaeste_dev.name='br-gaeste'
uci set network.gaeste_dev.bridge_empty='1'
uci set network.gaeste=interface
uci set network.gaeste.proto='static'
uci set network.gaeste.device='br-gaeste'
uci set network.gaeste.ipaddr="$GNET.1"
uci set network.gaeste.netmask='255.255.255.0'

uci set dhcp.gaeste=dhcp
uci set dhcp.gaeste.interface='gaeste'
uci set dhcp.gaeste.start='100'
uci set dhcp.gaeste.limit='150'
uci set dhcp.gaeste.leasetime='12h'

uci set firewall.gaeste_zone=zone
uci set firewall.gaeste_zone.name='gaeste'
uci -q delete firewall.gaeste_zone.network
uci add_list firewall.gaeste_zone.network='gaeste'
uci set firewall.gaeste_zone.input='REJECT'
uci set firewall.gaeste_zone.output='ACCEPT'
uci set firewall.gaeste_zone.forward='REJECT'
uci set firewall.gaeste_fwd=forwarding
uci set firewall.gaeste_fwd.src='gaeste'
uci set firewall.gaeste_fwd.dest='wan'
uci set firewall.gaeste_dns=rule
uci set firewall.gaeste_dns.name='Gaeste DNS+DHCP+Portal'
uci set firewall.gaeste_dns.src='gaeste'
uci -q delete firewall.gaeste_dns.dest_port
uci add_list firewall.gaeste_dns.dest_port='53'
uci add_list firewall.gaeste_dns.dest_port='67'
uci add_list firewall.gaeste_dns.dest_port='68'
uci add_list firewall.gaeste_dns.dest_port='2050'
uci set firewall.gaeste_dns.proto='tcp udp'
uci set firewall.gaeste_dns.target='ACCEPT'
# Gäste kommen nicht ins Heimnetz der FRITZ!Box (und an kein anderes privates Netz)
uci set firewall.gaeste_privat=rule
uci set firewall.gaeste_privat.name='Gaeste nicht ins Heimnetz'
uci set firewall.gaeste_privat.src='gaeste'
uci set firewall.gaeste_privat.dest='wan'
uci -q delete firewall.gaeste_privat.dest_ip
uci add_list firewall.gaeste_privat.dest_ip='10.0.0.0/8'
uci add_list firewall.gaeste_privat.dest_ip='172.16.0.0/12'
uci add_list firewall.gaeste_privat.dest_ip='192.168.0.0/16'
uci add_list firewall.gaeste_privat.dest_ip='169.254.0.0/16'
uci set firewall.gaeste_privat.proto='all'
uci set firewall.gaeste_privat.target='REJECT'
ok "Netz, DHCP und Firewall"

# --- 4. WLAN --------------------------------------------------------------------
say "4/6 WLAN \"$SSID\" einrichten"
RADIOS=$(uci -q show wireless | sed -n "s/^wireless\.\([^.=]*\)=wifi-device$/\1/p")
[ -n "$RADIOS" ] || fail "Kein WLAN-Funkmodul gefunden."
for s in $(uci -q show wireless | sed -n "s/^wireless\.\([^.=]*\)=wifi-iface$/\1/p"); do
    case "$s" in gaeste_*) ;; *) uci set wireless.$s.disabled='1' ;; esac
done
for r in $RADIOS; do
    uci set wireless.$r.disabled='0'
    uci set wireless.$r.country='DE'
    uci set wireless.gaeste_$r=wifi-iface
    uci set wireless.gaeste_$r.device="$r"
    uci set wireless.gaeste_$r.mode='ap'
    uci set wireless.gaeste_$r.network='gaeste'
    uci set wireless.gaeste_$r.ssid="$SSID"
    uci set wireless.gaeste_$r.disabled='0'
    if [ -n "$WLANKEY" ]; then
        uci set wireless.gaeste_$r.encryption='psk2'
        uci set wireless.gaeste_$r.key="$WLANKEY"
    else
        uci set wireless.gaeste_$r.encryption='none'
        uci -q delete wireless.gaeste_$r.key
    fi
done
ok "WLAN auf: $(echo $RADIOS)"

# --- 5. openNDS -----------------------------------------------------------------
say "5/6 Anmeldeseite (openNDS) einstellen"
S=$(uci -q show opennds | sed -n "s/^opennds\.\([^.=]*\)=opennds$/\1/p" | head -1)
[ -n "$S" ] || S=$(uci add opennds opennds)
O="opennds.$S"
uci set $O.enabled='1'
uci set $O.debuglevel='1'
uci set $O.gatewayinterface='br-gaeste'
uci set $O.gatewayname="$GWNAME"
uci set $O.enable_serial_number_suffix='0'
uci set $O.login_option_enabled='0'
uci set $O.fasport='443'
uci set $O.fasremotefqdn="$FQDN"
uci set $O.fasremoteip="$FASIP"
uci set $O.faspath="$FASPATH"
uci set $O.fas_secure_enabled='4'
uci set $O.faskey="$FASKEY"
uci set $O.maxclients="$MAXCLIENTS"
uci set $O.preauthidletimeout='30'
uci set $O.authidletimeout='720'
uci set $O.sessiontimeout='1440'
uci -q delete $O.walledgarden_fqdn_list
uci -q delete $O.walledgarden_port_list
uci add_list $O.walledgarden_fqdn_list="$FQDN fonts.googleapis.com fonts.gstatic.com"
uci add_list $O.walledgarden_port_list='443'
uci -q delete $O.authenticated_users
# Private Netze sperrt schon die Firewall-Zone oben. openNDS 10.x mit nftables verliert bei
# 'block to <Netz>' die Adresse und sperrt dann alles, darum hier nur 'allow all'.
uci add_list $O.authenticated_users='allow all'
ok "openNDS mit $FQDN$FASPATH"

# Alle 2 Minuten: Geräte + Datenvolumen an den Server melden, WLAN nach dessen Antwort an/aus (Leerstand).
# Ohne Antwort bleibt (bzw. geht) das WLAN an, damit Gäste nie ohne Netz dastehen.
cat > /usr/bin/beckhome-wlan-sync <<'SYNC'
#!/bin/sh
CL=$(ndsctl json 2>/dev/null | tr ',{}' '\n\n\n' | awk -F'"' '/"mac":/ { m=$4 } /"state":/ { s=$4 } /"download_this_session":/ { d=$4 } /"upload_this_session":/ { if (s=="Authenticated") printf "%s,%s,%s;", m, d, $4 }')
ON=1
[ "$(uci -q get wireless.gaeste_radio0.disabled)" = "1" ] && ON=0
UP=$(cut -d. -f1 /proc/uptime)
SETUPURL=''; SETUPVER=''
[ -f /etc/beckhome-wlan.conf ] && . /etc/beckhome-wlan.conf
R=$(/usr/lib/opennds/libopennds.sh send_to_fas_custom "stats1 wifi=$ON up=$UP ver=$SETUPVER clients=$CL" 2>/dev/null)
# Neues Einrichtungs-Skript auf dem Server: nachts (3-5 Uhr), sobald kein Gast online ist oder wenn im Admin
# "Jetzt aktualisieren" gedrückt wurde. Pro Version und Tag nur ein Versuch.
NEW=$(echo "$R" | sed -n 's/.*setup=\([0-9a-f]*\).*/\1/p')
if [ -n "$NEW" ] && [ -n "$SETUPURL" ] && [ "$NEW" != "$SETUPVER" ] && [ ! -e /tmp/bh-setup.lock ] \
   && [ "$(cat /tmp/bh-setup.tried 2>/dev/null)" != "$NEW-$(date +%j)" ]; then
    H=$(TZ='CET-1CEST,M3.5.0,M10.5.0/3' date +%H)
    case "$R" in *now=1*) H=03 ;; esac
    if [ -z "$CL" ] || [ "$H" = 03 ] || [ "$H" = 04 ]; then
        echo "$NEW-$(date +%j)" > /tmp/bh-setup.tried
        touch /tmp/bh-setup.lock
        logger -t beckhome "Router-Skript wird aktualisiert ($SETUPVER -> $NEW)"
        ( if wget -qO /tmp/bh-setup.sh "$SETUPURL" && sh /tmp/bh-setup.sh > /tmp/bh-setup.log 2>&1; then
              logger -t beckhome "Router-Skript aktualisiert"
          else
              logger -t beckhome "Router-Skript-Update fehlgeschlagen, siehe /tmp/bh-setup.log"
          fi
          rm -f /tmp/bh-setup.lock ) </dev/null >/dev/null 2>&1 &
        exit 0
    fi
fi
# Im Admin gelöschte Geräte abmelden
for m in $(echo "$R" | sed -n 's/.*kick=\([0-9a-f:,]*\).*/\1/p' | tr ',' ' '); do
    ndsctl deauth "$m" >/dev/null 2>&1 && logger -t beckhome "Gerät $m abgemeldet"
done
WANT=1
case "$R" in *wifi=off*) WANT=0 ;; esac
[ "$WANT" = "$ON" ] && exit 0
for s in $(uci -q show wireless | sed -n "s/^wireless\.\(gaeste_[^.=]*\)=wifi-iface$/\1/p"); do
    uci set wireless.$s.disabled=$((1 - WANT))
done
uci commit wireless
wifi reload
if [ "$WANT" = 1 ]; then logger -t beckhome "Gaeste-WLAN an"; else logger -t beckhome "Gaeste-WLAN aus (Leerstand)"; fi
SYNC
chmod +x /usr/bin/beckhome-wlan-sync
touch /etc/crontabs/root
grep -v beckhome-wlan-sync /etc/crontabs/root > /tmp/bh-cron; echo "*/2 * * * * /usr/bin/beckhome-wlan-sync" >> /tmp/bh-cron
cat /tmp/bh-cron > /etc/crontabs/root; rm -f /tmp/bh-cron
/etc/init.d/cron enable >/dev/null 2>&1
ok "Meldung an den Server alle 2 Minuten (Geräte, Datenvolumen, WLAN an/aus)"

# Für das automatische Update: woher das Skript kommt und welche Version jetzt läuft
( umask 077; printf "SETUPURL='%s'\nSETUPVER='%s'\n" "$SETUPURL" "$SETUPVER" > /etc/beckhome-wlan.conf )
grep -q '^/etc/beckhome-wlan.conf$' /etc/sysupgrade.conf 2>/dev/null || echo /etc/beckhome-wlan.conf >> /etc/sysupgrade.conf
ok "Automatische Updates eingeschaltet (Version $SETUPVER)"

# --- 6. Übernehmen ----------------------------------------------------------------
say "6/6 Einstellungen übernehmen und neu starten"
uci commit
/etc/init.d/system reload >/dev/null 2>&1
/etc/init.d/network reload
sleep 3
wifi reload
/etc/init.d/firewall reload >/dev/null 2>&1
/etc/init.d/dnsmasq restart
sleep 2
/etc/init.d/opennds enable
/etc/init.d/opennds restart
/etc/init.d/cron restart >/dev/null 2>&1
# openNDS prüft beim Start erst Internet und Anmeldeseite, das dauert je nach Leitung bis zu einer Minute
N=0
until ndsctl status >/dev/null 2>&1 || [ $N -ge 18 ]; do sleep 5; N=$((N + 1)); done
if ndsctl status >/dev/null 2>&1; then
    ok "openNDS läuft"
else
    fail "openNDS ist nicht gestartet. Bitte 'logread | grep -i opennds' ausführen und die Ausgabe schicken."
fi

echo ""
echo "============================================================"
echo " FERTIG! WLAN \"$SSID\" ist an."
echo " Mit dem Handy verbinden: die Anmeldeseite öffnet sich."
echo " Im Admin unter Webseite -> WLAN steht in ca. 1 Minute"
echo " \"Router verbunden\"."
echo "============================================================"
