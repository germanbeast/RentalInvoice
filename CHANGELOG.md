# Changelog

Alle bedeutenden Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und dieses Projekt folgt [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.20.0] - 2026-10-30

### Hinzugefügt
- Notfall-Öffnen über die Gäste-Webseite: Ist das Tastenfeld an der Tür defekt, scannt der Gast den Notfall-QR-Code, meldet sich mit Buchungscode und Anreisedatum an und lässt das Nuki-Schloss die Tür öffnen (Falle ziehen). Seite `/gast/notfall`, Modul `emergency-door.js`
- Sicherheit: standardmäßig ausgeschaltet; der QR-Link enthält einen geheimen Schlüssel (ohne Scan kein Öffnen-Knopf), nur bestätigte Buchungen, nur vom Anreisetag ab Check-in-Zeit bis Abreisetag zur Check-out-Zeit, Rückfrage vor dem Öffnen, höchstens 3 Öffnungen pro Stunde und Buchung, zusätzlich Sperre pro IP
- Jede Öffnung (und jeder Fehlschlag) wird in `door_emergency_log` protokolliert und sofort per Telegram und Push gemeldet (Push-Typ `nuki_emergency`, gilt als wichtig)
- Admin → Webseite → Einrichtung: Karte „Notfall-Öffnen“ mit Schalter, druckbarem QR-Aushang (A5), „Neuen QR-Code erzeugen“ (alter Aushang wird ungültig) und Protokoll der letzten Versuche

## [1.18.0] - 2026-10-30

### Geändert
- Gäste-Webseite: „Meine Buchung“ ist jetzt eine eigene Login-Seite unter `/gast/meine-buchung` statt eines Bereichs unten auf der Startseite (geteilte Ansicht mit Foto und Anmeldeformular, nach dem Login Buchungsstatus in voller Breite)
- Nach einer Direktanfrage landet der Gast automatisch angemeldet auf der neuen Seite
- Links in E-Mails, im Gastlink und alte Lesezeichen auf `#status` führen auf die neue Seite

## [1.17.2] - 2026-10-30

### Behoben
- Druckansicht der Rechnung: Seit dem Admin-Design (1.17.0) liefen Ränder, Abstände und der Rahmen der Vorschau in den Druck. Die Rechnung war nach rechts verschoben, rechts abgeschnitten, hatte einen beigen Rahmen und es kam eine leere zweite Seite. Eigene Druckregeln am Ende von styles.css setzen das zurück.

## [1.17.1] - 2026-10-30

### Behoben
- Rechnung: Empfänger (Name und Anschrift des Gastes) fehlte in Vorschau, Druck, E-Mail-PDF und Paperless-PDF, weil das Web-Layout den Block per CSS ausblendete. Die Anschrift steht jetzt über der Anrede.

## [1.17.0] - 2026-10-30

### Geändert
- Admin-Oberfläche („Invoice Beckhome“) im gleichen Boutique-/Magazin-Design wie die Gäste-Webseite: Papierton, Tinte und Rost als Farben, Instrument Serif für Titel und Zahlen, Hanken Grotesk für Text, feine Linien statt Schatten, eckige Knöpfe
- Oberfläche passt sich der Bildschirmgröße an: Schrift wächst auf großen Monitoren mit (16–20 px), Inhalt steht mittig mit max. 1680 px Breite und mitwachsenden Rändern, auf sehr breiten Monitoren bekommt die Rechnungsvorschau mehr Platz
- TV-Willkommensseite, Login, Einstellungen und Gäste-Verwaltung im neuen Stil; Diagrammfarben angepasst
- Weniger Rechenlast auf schwachen Geräten: keine großen Unschärfe-Schatten und Farbverläufe mehr

### Behoben
- Gäste-Verwaltung: Kopfzeile und Inhalt hatten keinen Innenabstand
- Einstellungen: Menüspalte lief bei kleineren Fensterhöhen über den Rand hinaus
- Knöpfe nutzten teils die Browser-Standardschrift statt der App-Schrift
## [1.16.0] - 2026-10-30

### Geändert
- Gäste-Webseite neu gestaltet im Boutique-/Magazin-Stil: ganzseitiges Titelbild, Serifenschrift (Instrument Serif + Hanken Grotesk), warmer Papierton, Bildstrecke, Ausstattung als Liste, dunkler Fußbereich
- Bildergalerie mit Vor/Zurück und Tastatursteuerung; Impressum, Datenschutz und Galerie als native `<dialog>`
- Kopfzeile liegt transparent über dem Titelbild und wird beim Scrollen fest
- Ruhige Bewegung: Fotos öffnen sich beim ersten Hineinscrollen wie ein Vorhang, Titelbild mit leichter Tiefe beim Scrollen, gezeichnete Unterstreichungen, weiche Bildwechsel in der Galerie; bei „Bewegung reduzieren“ alles aus
- Layout wächst auf großen Bildschirmen mit (Inhaltsbreite bis 1920 px, Schriftgröße skaliert mit der Fensterbreite)

### Hinzugefügt
- Einstellungen unter „Webseite → Inhalte“: Wohnfläche, Schlafzimmer und Gästestimmen („Text | Name“)

## [1.15.0] - 2026-10-28

### Hinzugefügt
- Öffentliche Gäste-Webseite unter `/gast/`: Beschreibung, Bilder, Ausstattung, Belegungskalender (ohne Namen) und Preisberechnung aus „Preise & Gebühren“
- Buchungsanfragen über die Webseite; Benachrichtigung per Telegram/WhatsApp, Bestätigen/Ablehnen/Stornieren im Admin unter „Webseite“, E-Mails an den Gast über SMTP
- Bestätigte Direktbuchungen werden als Buchung (Quelle „Direkt“) angelegt und bekommen automatisch einen Nuki-Türcode
- Gäste-Login mit Buchungscode + Anreisedatum; jede Buchung erhält einen Code (`bookings.guest_code`), Airbnb-Gäste können auch ihren HM-Code nutzen
- Statusseite für Gäste: Stand der Anfrage, Aufenthaltsdaten, Zahlungsinfos, Anreise-Infos, optional Türcode X Tage vor Anreise; Portal-Gäste können Namen, Kontakt und Ankunftszeit ergänzen
- „Gastlink“-Knopf bei jeder Buchung kopiert eine fertige Nachricht mit Link und Code für den Booking.com-/Airbnb-Chat
- iCal-Export der Direktbuchungen zum Import in Booking.com und Airbnb

### Geändert
- Kalender-Sperren aus Booking.com/Airbnb mit exakt den Daten einer Direktbuchung werden nicht als neue Buchung angelegt (gespiegelte Sperre)

## [1.14.0] - 2026-10-26

### Hinzugefügt
- Installierbare Web-App (PWA) für Android und iOS: Manifest, App-Icons, Service Worker
- Web-Push-Benachrichtigungen (VAPID, Abhängigkeit `web-push`): neue Buchung, Storno und Doppelbuchung; pro Gerät wahlweise alle Meldungen
- Einstellungen → „Handy-App & Push“: Gerät aktivieren/deaktivieren, Geräteliste, Test senden
- Endpunkte `/api/push/*`; Tippen auf eine Buchungs-Meldung öffnet die Buchungsliste (`/?view=bookings`)
- Login: „Angemeldet bleiben (30 Tage)“ (in der installierten App vorausgewählt); Sitzungen liegen in SQLite (Tabelle `sessions`) und überstehen Neustarts/Updates; ohne Häkchen endet die Sitzung nach 8 Stunden ohne Aktivität
- Nuki-Überwachung alle 10 Minuten: Warnung bei schwacher (≤ 25 %) und fast leerer Schloss-Batterie sowie leerer Keypad-/Türsensor-Batterie
- Warnung „Wohnung ist nicht abgeschlossen“, wenn das Schloss 30 Minuten offen ist und gerade kein Gast da ist (Anreisetag ab 15 Uhr bzw. erstem Zutritt, Abreisetag bis 11 Uhr), mit Telegram-Knopf „Jetzt abschließen“
- Telegram: `/schloss` (Status, Batterie), `/zu` (abschließen), `/auf` (aufschließen oder öffnen, nur nach Rückfrage, die nach 5 Minuten verfällt); Knopf „🚪 Schloss“ im Hauptmenü

## [1.13.3] - 2026-10-26

### Behoben
- Update-Knopf und `update.sh` holen `origin/main` per `git fetch` + `git reset --hard` statt `git pull` + `git stash pop`; ein hängengebliebener Merge-Konflikt (z. B. in `package-lock.json`) blockiert Updates nicht mehr. Lokale Änderungen an versionierten Dateien bleiben in `git stash list`.

## [1.13.2] - 2026-10-26

### Behoben
- Vergangene Buchungen mit Türcode, der in Nuki nicht mehr existiert, werden beim stündlichen Nuki-Abgleich bereinigt – jetzt auch, wenn nur der PIN ohne `nuki_auth_id` gespeichert war
- Bereits bestätigt gelöschte Nuki-Codes werden 30 Tage gemerkt; taucht ein Eintrag in der Nuki-Web-Liste wieder auf, wird er still erneut gelöscht statt neu gemeldet

## [1.13.1] - 2026-10-26

### Geändert
- Schneller auf schwachen Geräten: Blur-Effekte entfernt, ungenutzte PDF-Bibliothek (html2pdf) nicht mehr geladen, Chart.js gepinnt (4.4.1) und mit `defer` geladen
- Kein Polling im Hintergrund-Tab; TV-Uhr zeichnet nur noch minütlich neu

## [1.13.0] - 2026-10-26

### Hinzugefügt
- Belegungskalender (Buchungen → Kalender) mit Auslastung und freien Lücken der nächsten 120 Tage
- Endpunkt `GET /api/calendar?month=YYYY-MM`

### Behoben
- Dashboard zählte Rechnungen gelöschter Gäste weiter mit; Umsatz-Diagramm wurde nicht neu gezeichnet
- Manuelle Buchungen gelöschter Gäste blieben in der Heute-Übersicht stehen
- „Nächte“ statt „Nachte“
- Fehlende Abhängigkeit `multer`

### Entfernt
- `error.txt`, `fix-db.js`, `repair_db.js`, `test-users-api.js`, Android-Build-Ausgabe, Abhängigkeit `cors`

## [1.12.1] - 2026-10-25

### Behoben
- Menüpunkt „TV Welcome“ zeigte eine leere Seite; öffnet jetzt `/welcome.html` in einem neuen Tab

## [1.12.0] - 2026-10-25

### Hinzugefügt
- Dashboard-Bereich „Heute“ (im Haus, An-/Abreisen, To-dos, Warnungen, Kalender jetzt abfragen)
- Seite „Buchungen“ mit Filter, Suche, Namenseingabe (benennt Nuki-Code um) und Rechnung aus Buchung
- Statuspunkte in den Einstellungen; Menüpunkt „Booking.com & Airbnb“
- Öffentlicher Endpunkt `/api/welcome` (nur Vorname/Aufenthalt/Telefon) für den TV Welcome Screen

### Behoben
- Handy-Layout: Einstellungen und Rechnungsseite liefen seitlich über

## [1.11.0] - 2026-10-25

### Hinzugefügt
- Doppelbuchungs-Warnung bei Überschneidung zwischen Booking.com und Airbnb
- Storno-Erkennung mit Schutzmechanismen; Türcode wird gelöscht, Buchung entfernt, Benachrichtigung gesendet
- Anreise-Meldung über das Nuki-Zutrittsprotokoll (alle 10 Minuten)
- Neue Spalten in `bookings`: source, missing_count, arrived_at (automatische Migration)

## [1.10.1] - 2026-10-25

### Behoben
- Stündlich wiederkehrende Meldung "Türcode gelöscht": Nuki bestätigt das Löschen sofort, entfernt den Eintrag aber erst nach Synchronisation mit dem Schloss. Anforderungen werden jetzt gemerkt (einmal melden, nach 6 h still wiederholen, nach 24 h einmalig warnen)

## [1.10.0] - 2026-10-25

### Hinzugefügt
- Gastnamen nachtragen: Button in der Telegram-Meldung zur neuen Buchung und Befehl /namen; benennt Gast und Nuki-Code um
- Nach dem Namen: Rechnung mit vorbelegten Daten direkt erstellbar

### Behoben
- Anpassen/Verlängern bestehender Nuki-Codes verwendete einen nicht unterstützten API-Aufruf (PUT) und schlug fehl; jetzt POST /smartlock/{lockId}/auth/{id} mit vollständigem Datensatz

## [1.9.1] - 2026-10-25

### Hinzugefügt
- Manuelle Kalenderabfrage: Button in den Einstellungen und Telegram-Befehl /sync (Booking.com und Airbnb)

## [1.9.0] - 2026-10-25

### Hinzugefügt
- Airbnb iCal URL in den Einstellungen; Buchungen aus Booking.com und Airbnb erhalten automatisch einen Tür-Code
- Stündliches Löschen abgelaufener Türcodes im Nuki-Schloss mit Telegram-/WhatsApp-Benachrichtigung

### Geändert
- Gesperrte Airbnb-Tage ("Not available") und bereits vergangene Aufenthalte werden nicht mehr zu Türcodes
- Neutrale Gastnamen ("Booking TT.MM." / "Airbnb TT.MM.") wenn der Kalender keinen Namen enthält

## [1.8.2] - 2026-10-25

### Geändert
- Telegram /codes fragt die Türcodes live bei der Nuki-API ab (statt aus der lokalen Datenbank)

## [1.8.1] - 2026-10-25

### Behoben
- iCal-Ganztagstermine wurden auf Servern mit Zeitzone Europa/Berlin einen Tag zu früh eingelesen (Türcode lief einen Tag zu früh ab)

### Hinzugefügt
- Telegram: Befehl /codes und Menü-Button „Türcodes“ zeigen alle angelegten Türcodes
- Bestehende Türcodes werden automatisch angepasst, wenn sich der Zeitraum einer Buchung ändert

## [1.8.0] - 2026-10-25

### Hinzugefügt
- Telegram-Bot: Hauptmenü mit Buttons und gefülltes /-Befehlsmenü
- Zurück und Abbrechen in jedem Dialogschritt (Button oder Text)
- Zusammenfassung mit Bestätigung vor dem Anlegen von Tür-Code und Rechnung

### Verbessert
- Bot fragt nur nach fehlenden Angaben (Slot-Filling)
- Befehlserkennung nur am Textanfang, Session-Timeout, HTML-Escaping
- Datumserkennung: Jahreswechsel, Plausibilitätsprüfung (gilt auch für WhatsApp)

## [1.7.1] - 2026-02-20

### Hinzugefügt
- Zoom-Funktionalität im Rechnungsdesigner (+/- Buttons, 30%-150%)
- Template-Presets: "Modern", "Klassisch", "Minimal"
- Falzmarken ein/ausblenden Option
- Vollbild-Designer mit optimiertem Layout

### Verbessert
- Preview-Größe deutlich erhöht (nutzt 100% Höhe)
- Split-Screen Layout optimiert (380px Editor + Rest Preview)
- Save-Button mit Loading-State
- Template wird nach Speichern sofort auf Hauptrechnung angewendet

### Behoben
- Template-Speichern übernimmt jetzt korrekt alle Änderungen
- Preview-Skalierung verbessert

## [1.7.0] - 2026-02-20

### Hinzugefügt
- 🎨 **Rechnungsdesign-Baukasten** mit visuellem Editor
- Live-Vorschau für Rechnungsdesign mit Split-Screen Layout
- Text-Bausteine anpassbar (Logo, Begrüßung, Intro, Footer)
- Farb-Anpassungen (Primärfarbe, Tabellen, Text)
- Schriftarten-Auswahl für Logo und Body
- Logo-Upload-Funktion (Bild statt Text)
- Layout-Optionen (Logo, Steuernummer, Datum ein/ausblenden)
- Template-Konfiguration persistent in Datenbank

### Geändert
- "Ferienwohnung Beckhome" Logo in Georgia Serif (italic)
- PDF-Export auf 1 Seite optimiert (scale: 0.85)
- Kompakteres Layout mit reduzierten Abständen
- "Jede Stadt" Feld ausgeblendet

## [1.6.0] - 2026-02-20

### Hinzugefügt
- CHANGELOG.md zur Versionsverwaltung hinzugefügt
- Automatische Versionsnummer-Anzeige in den Einstellungen
- Telegram Bot Verbindungsstatus-Anzeige (ähnlich wie WhatsApp)
- Neues modernes Rechnungsdesign mit verbesserter Typografie

### Geändert
- Version wird nun automatisch aus package.json geladen

## [1.5.0] - 2026-02-20

### Behoben
- Null-Rechnungen werden nicht mehr in offenen Rechnungen gezählt
- Nuki PIN wird beim Zurücksetzen des Formulars automatisch gelöscht
- Rechnungen können jetzt in der Gästedetailansicht gelöscht werden
- Dashboard-Statistiken aktualisieren sich automatisch nach Änderungen

## [1.4.0] - 2026-02-19

### Behoben
- Einstellungen gehen nicht mehr verloren beim Speichern
- Merge mit existierenden Settings implementiert
- Nuki-Cleanup funktioniert jetzt auch für Buchungen ohne gespeicherte auth_id
- Total Amount wird korrekt berechnet beim Bot-Rechnungserstellen
- Top-Gäste zeigt nur noch aktive Gäste an

## [1.3.0] - 2026-02-18

### Behoben
- Nuki PIN kann jetzt gelöscht werden, auch ohne gespeicherte auth_id
- Live Lookup per PIN-Code implementiert
- Nuki authId wird nach PIN-Erstellung korrekt abgerufen via GET /auth
- Archiv-Modal entfernt, Archive-Funktionen in Gäste-Ansicht integriert

## [1.2.0] - 2026-02-17

### Hinzugefügt
- Nuki PIN-Verwaltung direkt in der Gästedetailansicht
- Archiv-Funktionen in Gäste-Ansicht
- Live Auto-Refresh für Rechnungsvorschau

### Behoben
- Rechnungsbetrag 0€ wurde korrigiert
- PDF-Download funktioniert wieder
- Telegram Email-Versand repariert
- Nuki PIN in Gästeansicht wird korrekt angezeigt

## [1.1.0] - 2026-02-16

### Behoben
- Telegram Re-Registrierung nach Ablehnung möglich
- Hard Delete implementiert
- Persistente Einstellungen: kein Datenverlust mehr
- WhatsApp Status Badge funktioniert
- Telegram Revoke-Funktion repariert
- Live Polling verbessert

## [1.0.0] - 2026-02-15

### Hinzugefügt
- Initiale Version der Ferienwohnung-Rechnungsverwaltung
- Rechnungserstellung mit Positionsverwaltung
- Gästeverwaltung mit Detailansicht
- Dashboard mit Statistiken und Charts
- Nuki Smart Lock Integration
- WhatsApp & Telegram Integration
- Paperless-ngx Integration
- E-Mail Versand via SMTP
- Automatische Buchungsimporte via iCal
- PDF-Generierung für Rechnungen
- Mehrwertsteuer-Berechnung (optional Kleinunternehmer-Regelung)
