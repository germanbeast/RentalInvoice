# Changelog

Alle bedeutenden Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und dieses Projekt folgt [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
