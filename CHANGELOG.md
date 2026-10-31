# Changelog

Alle bedeutenden Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und dieses Projekt folgt [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.31.0] - 2026-10-31

### Neu
- „Meine Buchung“ als App: Titelbild mit schwebender Kopfzeile und Menü, Karten „Buchungscode“ und „Gebucht von“, Abschnitt „Gebucht“ mit Foto-Karussell und Aufenthaltsdaten, Tab-Leiste Gäste / Aufenthalt / A – Z / Umgebung (Handy: unten fixiert, ab 900 px oben unter dem Titelbild). Gleiche Boutique-Tokens wie die Webseite (`guest-site/app.css`)
- Gästemappe A – Z: WLAN, Türcode, An- & Abreise, Adresse, Parken, Hausregeln, Kontakt und alle „Gut zu wissen“-Abschnitte alphabetisch zum Aufklappen
- Umgebung: Anfahrt mit Routen-Link und die Ausflugstipps aus „Inhalte“
- Online-Meldeschein (`meldeschein.js`, Tabelle `guest_registrations`): Familienname, Vornamen, Geburtsdatum, Staatsangehörigkeit, Anschrift, Ausweisart und -nummer (Pflicht bei ausländischer Staatsangehörigkeit), Anzahl der Personen und für jede weitere Person (auch Kinder) Vorname, Familienname und Geburtsdatum als Pflicht, Bestätigung per Häkchen (keine Unterschrift). Änderbar bis zum Anreisetag. Füllt fehlende Gastnamen, Adresse und Kontakt beim Gast auf
- Admin „Anfragen“ → „Meldescheine“: Liste nach Jahr/Monat, Drucken einzeln (`GET /api/meldescheine/:id/druck`) oder gesammelt (`/api/meldescheine/druck`), CSV-Export (`/api/meldescheine/export.csv`), Löschen, offene Meldescheine der nächsten 30 Tage. Im Kalender-Popup: Status „Meldeschein“ und Knopf zum Drucken
- Einstellung „Online-Meldeschein“ (Webseite → Einrichtung), Telegram-Nachricht bei neuem oder geändertem Meldeschein, Hinweis in der Gästenachricht
- Automatische Löschung 13 Monate nach Abreise (Aufbewahrung 1 Jahr nach § 30 Abs. 4 BMG)

## [1.30.1] - 2026-10-31

### Behoben
- Bei Booking.com geschlossene Zeiträume (z. B. 02.–08.11.) wurden nur teilweise als belegt angezeigt. Liefert ein Kalender mehrere Einträge mit derselben UID, hat der iCal-Parser sie zu einem zusammengefasst und die übrigen Tage galten als frei. Jeder VEVENT wird jetzt einzeln gelesen (`ical-events.js`); weitere Blöcke derselben UID werden als eigene Einträge `UID#Anreise` gespeichert, ohne zweiten Türcode und ohne „Neue Buchung“-Nachricht. Eine schon gespeicherte Buchung behält ihre UID und ihren Türcode
- Einträge ohne DTEND (oder mit Ende am selben Tag) zählen als ein Tag statt übersprungen zu werden
- Auch die Kalender-Vorschau (`POST /api/calendar/fetch`) zeigt alle Einträge

### Neu
- Bei Airbnb gesperrte Tage („Airbnb (Not available)“) werden in der neuen Tabelle `calendar_blocks` gespeichert und blockieren auf der Webseite Kalender und Anfragen. Sie werden keine Buchungen, bekommen keinen Türcode und stehen nicht in Auswertungen

 - 2026-10-31

### Neu
- „Türcode bearbeiten“ im Buchungsfenster des Kalenders: Name im Schloss sowie gültig ab/bis direkt im Nuki-Schloss ändern, die Ziffern bleiben gleich. Ist kein Code (mehr) da, wird einer angelegt. Bei selbst eingetragenen Buchungen wahlweise auch den Buchungszeitraum ändern. Endpunkte `GET/PUT /api/bookings/:id/nuki`
- Gast in der Gästeliste umbenannt → Türcodes seiner laufenden und kommenden Buchungen werden umbenannt

### Behoben
- Bei geänderter An-/Abreise wurde ein neuer Türcode angelegt und der alte blieb im Schloss. Jetzt wird der vorhandene Code der Buchung (per gespeicherter ID oder per PIN gefunden) auf den neuen Zeitraum verschoben: beim Kalender-Abgleich, bei „Keypad-PIN generieren“ in der Rechnung, im Telegram/WhatsApp-Ablauf, bei „Verlängern“ und „PIN erstellen“ in der Gästeliste
- Name des Türcodes änderte sich nicht, wenn beim Anlegen die Nuki-ID nicht gespeichert werden konnte. Der Code wird jetzt über die PIN gefunden und die ID nachgetragen
- Stündlicher Abgleich benennt Codes wie „Gast: Booking 12.03.“ / „Gast: Airbnb …“ nach dem eingetragenen Gastnamen um. Von Hand vergebene Namen bleiben unverändert
- Abgelaufene Codes einer Buchung werden auch dann gelöscht, wenn sie von Hand umbenannt wurden

## [1.30.0] - 2026-10-31

### Neu
- „Türcode bearbeiten“ im Buchungsfenster des Kalenders: Name im Schloss sowie gültig ab/bis direkt im Nuki-Schloss ändern, die Ziffern bleiben gleich. Ist kein Code (mehr) da, wird einer angelegt. Bei selbst eingetragenen Buchungen wahlweise auch den Buchungszeitraum ändern. Endpunkte `GET/PUT /api/bookings/:id/nuki`
- Gast in der Gästeliste umbenannt → Türcodes seiner laufenden und kommenden Buchungen werden umbenannt

### Behoben
- Bei geänderter An-/Abreise wurde ein neuer Türcode angelegt und der alte blieb im Schloss. Jetzt wird der vorhandene Code der Buchung (per gespeicherter ID oder per PIN gefunden) auf den neuen Zeitraum verschoben: beim Kalender-Abgleich, bei „Keypad-PIN generieren“ in der Rechnung, im Telegram/WhatsApp-Ablauf, bei „Verlängern“ und „PIN erstellen“ in der Gästeliste
- Name des Türcodes änderte sich nicht, wenn beim Anlegen die Nuki-ID nicht gespeichert werden konnte. Der Code wird jetzt über die PIN gefunden und die ID nachgetragen
- Stündlicher Abgleich benennt Codes wie „Gast: Booking 12.03.“ / „Gast: Airbnb …“ nach dem eingetragenen Gastnamen um. Von Hand vergebene Namen bleiben unverändert
- Abgelaufene Codes einer Buchung werden auch dann gelöscht, wenn sie von Hand umbenannt wurden

## [1.28.0] - 2026-10-31

### Neu
- Menüpunkt „Auslastung“: der Jahresrückblick ist von der Startseite auf eine eigene Seite umgezogen und erweitert um Umsatz pro Monat (mit Vorjahr), Umsatz je Buchungskanal, Belegung Tag für Tag (12 × 31 Raster), Tabelle „Monate im Überblick“ (Nächte, Auslastung, Anreisen, Umsatz, pro Nacht, Vorjahr) und „Jahresvergleich“ über alle Jahre. Excel-Export der Seite (`GET /api/review/export.xlsx`)
- Menüpunkt „Finanz-Auswertung“ (unter Finanzen): Zeitraum als Jahr, Quartal, Monat oder frei; nach Rechnungsdatum oder Zahlungseingang (Zuflussprinzip, EÜR); Rechnungen gelöschter Gäste wahlweise mit. Kennzahlen (brutto, netto, USt, Kurtaxe, Ausgaben, Ergebnis, offen), Monatsübersicht, USt nach Steuersatz, Einnahmen nach Art, Ausgaben nach Kategorie, Rechnungsliste
- Massen-Export: Excel mit allen Tabellen als Blätter (Übersicht, Monate, Umsatzsteuer, Rechnungen, Positionen, Kurtaxe, Ausgaben, Kategorien, Belegung), jede Tabelle einzeln als CSV (Semikolon, Dezimalkomma, UTF-8 mit BOM), alle CSV als ZIP und alle Rechnungs-PDFs des Zeitraums als ZIP
- `xlsx-writer.js` (ZIP, XLSX, CSV ohne zusätzliche Abhängigkeit) und `finance-report.js`; Endpunkte `GET /api/finance`, `/api/finance/export.xlsx`, `/api/finance/export.csv?kind=…`, `/api/finance/export-csv.zip`, `/api/finance/invoices.zip`

### Geändert
- Startseite ohne Jahresrückblick (steht jetzt unter „Auslastung“); Telegram `/jahr` verweist dorthin

## [1.27.0] - 2026-10-31

### Neu
- Admin-Bereich neu aufgebaut nach dem Vorbild gängiger Ferienwohnungs-Software: helle Oberfläche (weiß, Blau als Akzent, Inter), Seitenleiste mit Gruppen „Finanzen“ und „Konfiguration“, einklappbar auf Symbole; Kopfzeile mit „Buchung eintragen“, Suche (Gast, Datum, Portal) und Benutzer
- Kalender ist die neue Startseite: Zeitleiste über 8 Wochen mit Balken je Plattform (Booking.com blau, Airbnb rot, Direkt grün, Manuell gelb) und einer Zeile für offene Webseiten-Anfragen; Monatsauswahl, ±2 Wochen blättern, Auslastung des Monats
- Klick auf einen Balken: Details (Zeitraum, Nächte, Quelle, Türcode, Gastcode) mit Name ändern, Rechnung erstellen, Gastlink kopieren und, bei selbst eingetragenen Buchungen, Löschen
- „Bevorstehende Buchungen“ (Check-in/Check-out mit Uhrzeit aus den Webseiten-Einstellungen, Nächte, Türcode-Status) und „Aktivitätsfeed“ (neue Buchungen, Anfragen, Rechnungen, Anreisen) unter dem Kalender
- Buchung eintragen: `POST /api/bookings` speichert als Direktbuchung (blockiert Booking.com/Airbnb über den Kalender-Export, bekommt einen Gastcode), legt auf Wunsch den Nuki-Code an und warnt bei Überschneidungen; `DELETE /api/bookings/:id` nur für selbst eingetragene Buchungen
- `GET /api/activity` für den Aktivitätsfeed

### Geändert
- „Dashboard“ heißt jetzt „Start“, „Neue Rechnung“ heißt „Rechnungen“; Ausgaben und Erbverwaltung liegen unter „Finanzen“, Einstellungen und TV Welcome unter „Konfiguration“
- Buchungsliste hat den Filter „Alle“ (wird von der Suche oben genutzt)

## [1.26.1] - 2026-10-31

### Behoben
- Nuki-Cleanup: `nuki_delete_requests` wurde nur flach kopiert, Änderungen an bestehenden Einträgen (`warned`, `lastTry`, `gone`) wurden daher nie gespeichert. Folge: „Türcode nach 24 Stunden noch im Schloss“ kam stündlich. Jetzt tiefe Kopie und Vergleich gegen den gespeicherten Stand

## [1.26.0] - 2026-10-30

### Neu
- Jahresrückblick im Dashboard (unter den Diagrammen) mit Jahresauswahl: Auslastung, Aufenthalte (Ø und längster), Umsatz (davon offen), Umsatz pro belegter Nacht, Ergebnis nach Ausgaben, Gäste und Stammgäste. Jeweils mit Vergleich zum Vorjahr
- Belegte Nächte pro Monat (mit Vorjahr), Buchungskanäle (Booking.com, Airbnb, Direkt, Manuell, nur Rechnung) und stärkster Monat
- Landkarte „Woher die Gäste kommen“ mit Länder- und Ortsliste. Die Herkunft kommt aus der Adresse des Gastes oder der Rechnung zum Aufenthalt (PLZ, Ort, Land; auch „A-1010 Wien“, „1012 AB Amsterdam“). Orte werden über OpenStreetMap (Nominatim) gesucht, dabei gehen nur PLZ, Ort und Land raus, nie Namen. Ergebnisse werden in der Tabelle `geo_cache` gespeichert. Karte mit Leaflet und OpenStreetMap-Kacheln, lädt erst im Dashboard
- Aufenthalte zählen nach Anreisejahr. Belegte Nächte kommen aus Buchungen und Rechnungen, doppelte Einträge für denselben Aufenthalt zählen einmal. Umsatz wie im Dashboard nach Rechnungsdatum
- Telegram `/jahr` (oder `/jahr 2025`): Rückblick als Nachricht. Im Januar zeigt `/jahr` das Vorjahr
- Doppelbuchungs-Alarm: tägliche Erinnerung um 8 Uhr, solange die Überschneidung besteht. Knopf „✅ Ist in Ordnung“ in der Telegram-Meldung und „ist in Ordnung“ im Dashboard beendet die Erinnerungen (z. B. bei verknüpften Kalendern)
- Warnung, wenn eine neue Buchung aus Booking.com oder Airbnb eine offene Webseiten-Anfrage überschneidet
- Nuki-Offline-Warnung: Ist das Schloss länger als 30 Minuten offline (Bridge/WLAN), kommt eine Meldung per Telegram und Push, später die Entwarnung. Ist Nuki Web länger als 2 Stunden nicht erreichbar, ebenfalls einmal eine Meldung
- Nuki vor der Anreise: Reist innerhalb von zwei Tagen ein Gast an, während das Schloss offline oder die Schloss- oder Keypad-Batterie fast leer ist, kommt einmal pro Buchung ein Hinweis
- „Nuki-Batterie fast leer“ wird täglich wiederholt, bis die Batterien getauscht sind
- Dashboard „To-do & Warnungen“ zeigt Batterie- und Offline-Probleme aus der letzten Schloss-Prüfung
- `/schloss` zeigt an, wenn das Schloss offline ist

### Geändert
- Push-Typ `nuki_offline` gilt als wichtige Meldung
- Content-Security-Policy erlaubt Leaflet-CSS von cdnjs und Kartenkacheln von tile.openstreetmap.org

## [1.25.0] - 2026-10-30

### Neu
- Rechnung selbst erstellen: Auf „Meine Buchung“ (auch über den Direktlink ohne Anmeldung) ergänzt der Gast Name, Adresse und bei Bedarf Firma und USt-IdNr. Die Rechnung wird sofort erstellt und als PDF heruntergeladen. Vorher sieht der Gast Positionen und Gesamtbetrag
- Beträge wie im Telegram-Bot aus Einstellungen → Preise & Gebühren, bei Direktbuchungen der vereinbarte Preis. Booking.com- und Airbnb-Buchungen gelten als „bezahlt via Booking.com/Airbnb“, Direktbuchungen als offen mit Bankverbindung
- Telegram-Nachricht an dich bei jeder vom Gast erstellten Rechnung (Nummer, Betrag, Empfänger, Aufenthalt)
- Nach dem Erstellen sind die Daten fest (GoBD). Der Gast kann nur noch „Korrektur anfragen“, das kommt als Telegram-Nachricht bei dir an
- Einstellung unter Webseite → Einrichtung: „Gäste erstellen ihre Rechnung selbst“ bei allen Buchungen, nur bei Direktbuchungen oder aus
- Enthält die Gästemappe und den Rechnungs-Download aus PR #16: Türcode, WLAN, An- und Abreise, Adresse, Parken, Hausregeln und eigene Abschnitte auf „Meine Buchung“

### Geändert
- Rechnungs-PDFs (Gast-Download und Telegram-Bot) haben jetzt dasselbe Layout wie die Rechnung im Admin: Aufbau aus der Rechnungsvorschau, Farben, Schriften, Logo-Text, Anrede und Einleitung aus dem Rechnungs-Template. Zusätzlich stehen im PDF Rechnungs-Nr., Datum und Aufenthalt sowie Netto und MwSt. (Pflichtangaben). Bei Firmenrechnungen wird die Person angesprochen, nicht die Firma. „Offen“ wird orange statt grün angezeigt. Nichts wird mehr unten abgeschnitten

### Sicherheit
- Name und Adresse auf der Rechnung werden im PDF und in der Vorschau im Admin als Text ausgegeben, nicht als HTML

## [1.24.0] - 2026-10-30

### Neu
- Fertige Gästenachricht per Telegram: Bei jeder neuen Buchung aus Booking.com oder Airbnb schickt der Bot zusätzlich einen kopierfertigen Text für den Gast (antippen kopiert ihn). Inhalt: Anrede mit Vorname, An- und Abreise mit Uhrzeit, Türcode, persönlicher Link zu „Meine Buchung“, Link zum Notfall-Öffnen, Buchungscode, Telefonnummer
- Abrufbar mit `/nachricht` oder „✉️ Gästenachricht“ im Hauptmenü, Knopf „🇬🇧 English“ für die englische Version, „📋 Nur Link kopieren“
- Nach „Namen eintragen“ kommt die Nachricht automatisch noch einmal mit dem Namen des Gastes
- Persönlicher Direktlink `/gast/b/<token>`: meldet den Gast ohne Buchungscode an. Der Link `/gast/b/<token>/notfall` öffnet direkt die Notfall-Seite

### Sicherheit
- Pro Buchung ein zufälliger Schlüssel (43 Zeichen), gültig bis einen Tag nach der Abreise; bei Storno endet er sofort
- Im Bot „🔒 Link sperren“ oder „🔁 Neuer Link“: Wer mit dem alten Link angemeldet ist, wird abgemeldet
- Begrenzung gegen Durchprobieren (20 falsche Links pro 15 Minuten und Besucher), neue Sitzung bei jedem Öffnen
- Die Tür lässt sich weiterhin nur von der Anreise-Uhrzeit bis zur Abreise-Uhrzeit öffnen
- Die Gästenachricht geht nur an Telegram, nicht an WhatsApp oder Push

## [1.23.0] - 2026-10-30

### Hinzugefügt
- Gäste-Webseite, Bewertungen: Gesamtnoten von Booking.com (von 10), Airbnb und Google (von 5) mit Sternen und Anzahl, verlinkbar auf die Plattform, dazu einzelne Bewertungen mit Sternen, Plattform, Name und Monat. Ab sieben Bewertungen gibt es „Alle Bewertungen“. Die Plattformen haben keine offene Schnittstelle, deshalb werden Noten und Texte im Admin unter Webseite → Inhalte → Bewertungen gepflegt. Die bisherigen „Gästestimmen“ werden weiter angezeigt
- Vollbild-Galerie: „Alle Fotos“ unter den Bildern, Vorschaubilder unten, Wischen auf dem Handy, Pfeiltasten, Vergrößern (Lupe oder Doppelklick), echtes Vollbild wo der Browser es erlaubt; Nachbarbilder werden vorgeladen
- Grundriss: eigenes Bild (Webseite → Inhalte → Grundriss), öffnet über den Knopf „Grundriss“ im Vollbild auf weißem Grund
- Abschnitt „Lage & Umgebung“: Adresse mit „Route planen“ (Google Maps), Anfahrt, Ausflugstipps (Name, Entfernung, Beschreibung, Link) und eine Google-Maps-Karte ohne API-Schlüssel. Die Karte lädt erst nach Klick auf „Karte laden“, vorher wird nichts an Google übertragen (DSGVO). Dafür erlaubt die Content-Security-Policy jetzt Frames von google.com
- Hausregeln stehen jetzt in einem eigenen Abschnitt unter „Lage & Umgebung“

## [1.22.0] - 2026-10-30

### Sicherheit
- Sperren nach Fehlversuchen gelten pro Besucher: Die App vertraut jetzt Proxys/Tunneln auf demselben Rechner und im Heimnetz (`trust proxy`) und sieht so die echte IP. Vorher konnte ein Fremder mit ein paar falschen Versuchen Admin-Login, Gast-Login und Notfall-Öffnen für alle sperren. Anpassbar mit `TRUST_PROXY` in der `.env`
- Wiederherstellungs-Schlüssel (Recovery-Key) werden nur noch als Hash gespeichert (vorhandene Schlüssel gelten weiter) und nicht mehr in der Benutzerliste angezeigt. Neue Schlüssel sind 24 Zeichen lang und werden nur einmal angezeigt: beim Anlegen eines Benutzers oder über „Neuer Recovery-Key“
- Passwörter und Tokens (Paperless, SMTP, Nuki, Telegram) gehen nicht mehr an den Browser. Die Einstellungen zeigen `••••••••`; unverändert gespeichert bleibt der alte Wert. Notfall-QR-Schlüssel, iCal-Export-Token und Push-Schlüssel lassen sich über die Einstellungen weder lesen noch überschreiben
- Abhängigkeiten aktualisiert (`npm audit fix`, nodemailer 10), bekannte Lücken von 31 auf 20

### Behoben
- Das Rechnungstemplate wurde beim Speichern der Einstellungen auf die Standardwerte zurückgesetzt (das Logo-Speichern überschrieb das Template mit `{}`)
- Die Check-in-E-Mail nutzt die SMTP-Zugangsdaten aus den Einstellungen

## [1.20.1] - 2026-10-30

### Behoben
- Gäste-Webseite: Abmelden war nur ganz unten auf „Meine Buchung“ möglich und auf der Notfall-Seite gar nicht. Jetzt steht „Abmelden“ nach dem Login oben rechts in der Kopfzeile (auf „Meine Buchung“ anstelle von „Zur Startseite“). Die Notfall-Seite zeigt zusätzlich „Angemeldet mit Buchung BH-…“ mit Abmelde-Link

## [1.20.0] - 2026-10-30

### Hinzugefügt
- Notfall-Öffnen über die Gäste-Webseite: Ist das Tastenfeld an der Tür defekt, scannt der Gast den Notfall-QR-Code, meldet sich mit Buchungscode und Anreisedatum an und lässt das Nuki-Schloss die Tür öffnen (Falle ziehen). Seite `/gast/notfall`, Modul `emergency-door.js`
- Sicherheit: standardmäßig ausgeschaltet; der QR-Link enthält einen geheimen Schlüssel (ohne Scan kein Öffnen-Knopf), nur bestätigte Buchungen, nur vom Anreisetag ab Check-in-Zeit bis Abreisetag zur Check-out-Zeit, Rückfrage vor dem Öffnen, höchstens 3 Öffnungen pro Stunde und Buchung, zusätzlich Sperre pro IP
- Jede Öffnung (und jeder Fehlschlag) wird in `door_emergency_log` protokolliert und sofort per Telegram und Push gemeldet (Push-Typ `nuki_emergency`, gilt als wichtig)
- Admin → Webseite → Einrichtung: Karte „Notfall-Öffnen“ mit Schalter, druckbarem QR-Aushang (A5), „Neuen QR-Code erzeugen“ (alter Aushang wird ungültig) und Protokoll der letzten Versuche

## [1.18.1] - 2026-10-30

### Sicherheit
- `/api/whatsapp/qr` stand auf der Auth-Whitelist. Damit konnte jeder ohne Login den QR-Code abrufen und ein eigenes WhatsApp-Konto mit dem Server koppeln. Der Endpunkt verlangt jetzt eine Admin-Sitzung wie `/api/whatsapp/status` und `/api/whatsapp/logout`. Die Kopplung in den Einstellungen läuft unverändert, weil sie nur nach dem Login abgefragt wird.

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
