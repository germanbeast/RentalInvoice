# Umzug Netcup → Proxmox-Container

Zieht die App unverändert (gleicher Commit, gleiche Daten, gleicher Pfad, gleiche Node-Hauptversion) von Netcup in einen LXC-Container auf dem Proxmox-Host. Am Netcup-Server wird nur gelesen. Der Mailserver bleibt auf Netcup.

## Ablauf

| # | Wo | Befehl | Was passiert |
|---|----|--------|--------------|
| 1 | Proxmox-Host | `curl -fsSLO https://raw.githubusercontent.com/germanbeast/RentalInvoice/main/migration/proxmox-create-lxc.sh && bash proxmox-create-lxc.sh` | Ubuntu-24.04-Container (unprivilegiert, nesting, 2 Kerne, 4 GB, 32 GB, Autostart, Europe/Berlin), legt `/root/migrate.sh` hinein |
| 2 | Container (`pct enter <ID>`) | `./migrate.sh probe root@89.58.60.144` | Bestandsaufnahme Netcup: App-Pfad, Version, Node, PM2, Cron, Dienste, Ports, Mail, Datenmengen. Nur lesen |
| 3 | Container | `./migrate.sh install` | Pakete, Chromium-Bibliotheken, ffmpeg, sqlite3, Node gleiche Hauptversion, PM2 |
| 4 | Container | `./migrate.sh copy` | Probe-Kopie per rsync, Netcup läuft weiter. Danach `npm ci` |
| 5 | Container | `./migrate.sh selftest` | Datenbank lesbar, Chromium erzeugt PDF, ffmpeg, OCR. Startet die App **nicht** |
| 6 | Netcup | `pm2 stop invoice-app && pm2 save` | Ab hier ist die App kurz offline |
| 7 | Container | `./migrate.sh copy --final` | Bricht ab, solange die App auf Netcup noch läuft. Kopiert nur die Änderungen seit Schritt 4, vergleicht die DB-Prüfsumme mit Netcup |
| 8 | Container | `./migrate.sh start` | PM2 `invoice-app`, Autostart, bei Bedarf `LISTEN_HOST` auf die Container-IP |
| 9 | Cloudflare | Hostnamen umstellen (siehe unten) | |
| 10 | Container | `./migrate.sh verify` | Prüfliste lokal + öffentlich |
| 11 | Netcup | `pm2 delete invoice-app && pm2 save` | Erst wenn alles läuft. Mailserver bleibt an |

Warum die App nie auf beiden Servern gleichzeitig laufen darf: Telegram-Bot (409 Conflict), WhatsApp-Sitzung, Nuki-Codes, FRITZ!Box-WLAN, Cron-Nachrichten an Gäste würden doppelt oder gegeneinander laufen. Deshalb startet `selftest` die App nicht, und `start` bricht ab, wenn Netcup noch läuft.

## Cloudflare umstellen

Zero Trust → Networks → Tunnels:

1. Tunnel **Beckhome_Netcup** → Public Hostnames: `beckhome.cloud`, `admin.beckhome.cloud`, `www.beckhome.cloud` löschen. Dabei verschwinden auch die DNS-Einträge.
2. Proxmox-Tunnel → Public Hostname hinzufügen, je Hostname: Service `HTTP`, URL `<Container-IP>:3000`, Pfad leer.
3. Cloudflare Access (admin), Redirect-Regel www → root und die abgeschalteten Bot-Prüfungen (für den WLAN-Router) hängen am Hostnamen bzw. an der Zone und bleiben.
4. Am PC bei „Name not resolved“: `ipconfig /flushdns`.

Läuft cloudflared des Proxmox-Tunnels auf dem Host oder in einem anderen Container, muss die App auf der Container-IP lauschen (`LISTEN_HOST=<Container-IP>`, `start` fragt danach). Hat der Container eine öffentliche IP, Port 3000 in der Proxmox-Firewall sperren.

## Was danach zu prüfen ist

- Admin-Login, Kalender, eine Rechnung als PDF
- Telegram: `/start` an den Bot
- WhatsApp: Einstellungen → WhatsApp. Steht dort „QR-Code“, einmal neu koppeln (die Sitzung wird mitkopiert, klappt aber nicht immer)
- TV-Box, WLAN-Router, iCal bei Booking/Airbnb, SMS-Gateway: nutzen `beckhome.cloud`, also keine Änderung
- Hintergrund-Video hochladen geht jetzt (ffmpeg ist installiert)
- Kartenabgleich: Nominatim sperrt oft Rechenzentrums-IPs, auch OVH. PR #62 (Photon als Ersatz) hilft
