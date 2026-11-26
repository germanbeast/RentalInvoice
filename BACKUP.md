# Datensicherung

Die App sichert sich selbst: täglich zur eingestellten Uhrzeit (Standard 03:30) entsteht eine verschlüsselte Datei
`backups/beckhome-backup-JJJJ-MM-TT_HHMM.tar.gz.enc`. Einstellungen im Admin unter **Einstellungen → Datensicherung**
(nur Inhaber/Admin).

## Was gesichert wird

| Inhalt | Datei |
| --- | --- |
| Buchungen, Rechnungen, Gäste, Meldescheine, Ausgaben, Benutzer, alle Einstellungen | `rental.db` (konsistenter Schnappschuss im laufenden Betrieb) |
| Passwörter/Schlüssel der Server-Konfiguration | `.env` |
| Fotos der Webseite, Chat-Anhänge, Belege, Zertifikate | `uploads/` |
| Alte Benutzerdatei (falls vorhanden) | `users.json` |
| WhatsApp-Anmeldung (optional, Schalter) | `.wwebjs_auth/` |

Rechnungs-PDFs werden aus der Datenbank neu erzeugt und brauchen keine eigene Sicherung. Jede Sicherung enthält
`MANIFEST.json` mit Größe und SHA-256 jeder Datei.

## Verschlüsselung

AES-256-CBC, Schlüssel per PBKDF2-SHA256 (200 000 Runden) aus dem Backup-Passwort, Dateiformat wie
`openssl enc`. **Ohne das Backup-Passwort ist keine Wiederherstellung möglich.** Das Passwort außerhalb des
Servers aufbewahren (Passwort-Manager, Papier).

## Ziele

- **Server** (immer): die letzten *n* Sicherungen in `backups/` (Standard 7). Download auch im Admin.
- **Cloud-Speicher (S3)**: Cloudflare R2, Backblaze B2, Hetzner Object Storage, AWS. Alte Sicherungen werden
  nach „Extern behalten“ gelöscht (0 = nie).
- **WebDAV**: Nextcloud (`https://<server>/remote.php/dav/files/<benutzer>/Backups`) oder Hetzner Storage Box
  (`https://<benutzer>.your-storagebox.de/backups`).
- **Telegram**: Datei an alle Telegram-Empfänger (bis 49 MB).

Schlägt eine Sicherung fehl, kommt eine Meldung über Telegram/WhatsApp/Push. Im Dashboard steht ein Hinweis, wenn
die Sicherung aus ist, fehlgeschlagen ist oder die letzte erfolgreiche älter als 2 Tage ist.

### Cloudflare R2 einrichten

1. Cloudflare-Dashboard → **R2 Object Storage** → **Create bucket**, z. B. `beckhome-backup` (Location: Automatic).
2. **R2 → Manage API tokens → Create API token**: Berechtigung *Object Read & Write*, nur für diesen Bucket.
3. Angezeigt werden *Access Key ID*, *Secret Access Key* und der Endpunkt
   `https://<account-id>.r2.cloudflarestorage.com`.
4. Im Admin: Endpunkt, Bucket, Region `auto`, Keys eintragen → **Verbindung testen** → Hochladen aktiv → Speichern.

## Wiederherstellen

### Mit der App (empfohlen)

```bash
cd ~/RentalInvoice
# 1. Prüfen und entpacken (ändert nichts): legt restore-<datum>/ an
node backup-restore.js backups/beckhome-backup-2026-11-02_0330.tar.gz.enc

# 2. Zurückspielen
pm2 stop invoice-app
node backup-restore.js backups/beckhome-backup-2026-11-02_0330.tar.gz.enc --apply
pm2 start invoice-app
```

Bei `--apply` werden die aktuellen `rental.db`, `.env`, `uploads/` … vorher nach `pre-restore-<zeit>/` verschoben.
Das Passwort wird abgefragt (oder `BACKUP_PASSWORD=... node backup-restore.js ...`).

### Auf einem neuen Server

1. `setup.sh` ausführen (installiert Node, holt den Code), App stoppen: `pm2 stop invoice-app`.
2. Sicherung aus R2/Nextcloud/Telegram auf den Server kopieren, dann wie oben mit `--apply` zurückspielen.
3. `pm2 start invoice-app`. Cloudflare Tunnel (`cloudflared`) neu einrichten, falls der Server gewechselt hat.

### Ohne die App (nur OpenSSL + tar)

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
  -in beckhome-backup-2026-11-02_0330.tar.gz.enc | tar xz -C wiederherstellung/
```

Unter Windows geht das z. B. mit Git Bash oder WSL.
