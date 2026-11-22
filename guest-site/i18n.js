/* Ferienwohnung – Gäste-Seiten mehrsprachig (Deutsch, Englisch, Niederländisch, Polnisch)
 *
 * Der deutsche Text ist der Schlüssel: T('Anreise') gibt auf Englisch "Arrival" zurück,
 * fehlt eine Übersetzung, bleibt der deutsche Text stehen. {name} wird ersetzt.
 * TX() übersetzt Texte vom Server (Fehlermeldungen, Wetter, Öffnungszeiten), auch mit Platzhaltern.
 *
 * Sprache: eigene Wahl des Gastes (Umschalter) > Sprache der Buchung (Admin oder erkannt) > Browser > Deutsch.
 */
(() => {
    'use strict';

    const LANGS = {
        de: { name: 'Deutsch', short: 'DE', locale: 'de-DE' },
        en: { name: 'English', short: 'EN', locale: 'en-GB' },
        nl: { name: 'Nederlands', short: 'NL', locale: 'nl-NL' },
        pl: { name: 'Polski', short: 'PL', locale: 'pl-PL' }
    };
    const IDX = { en: 0, nl: 1, pl: 2 };
    const STORE = 'guest-lang';

    // Deutsch: [English, Nederlands, Polski]
    const D = {
        // ---- Allgemein / Kopf / Fuß ----
        'Die Wohnung': ['The apartment', 'Het appartement', 'Mieszkanie'],
        'Verfügbarkeit': ['Availability', 'Beschikbaarheid', 'Dostępność'],
        'Zur Startseite': ['Home page', 'Naar de startpagina', 'Strona główna'],
        'Startseite': ['Home', 'Startpagina', 'Strona główna'],
        'Abmelden': ['Log out', 'Afmelden', 'Wyloguj'],
        'Anmelden': ['Log in', 'Inloggen', 'Zaloguj'],
        'Impressum': ['Legal notice', 'Colofon', 'Nota prawna'],
        'Datenschutz': ['Privacy', 'Privacy', 'Prywatność'],
        'Dieser Text wird gerade vorbereitet.': ['This text is being prepared.', 'Deze tekst wordt voorbereid.', 'Ten tekst jest w przygotowaniu.'],
        'Menü': ['Menu', 'Menu', 'Menu'],
        'Schließen': ['Close', 'Sluiten', 'Zamknij'],
        'Sprache': ['Language', 'Taal', 'Język'],
        'Willkommen': ['Welcome', 'Welkom', 'Witamy'],
        'Willkommen, {name}': ['Welcome, {name}', 'Welkom, {name}', 'Witamy, {name}'],
        'Einen Moment …': ['One moment …', 'Een moment …', 'Chwileczkę …'],
        'Kopieren': ['Copy', 'Kopiëren', 'Kopiuj'],
        'Kopiert': ['Copied', 'Gekopieerd', 'Skopiowano'],
        'Bitte manuell kopieren': ['Please copy by hand', 'Kopieer het handmatig', 'Skopiuj ręcznie'],
        'Speichern': ['Save', 'Opslaan', 'Zapisz'],
        'Gespeichert, danke!': ['Saved, thank you!', 'Opgeslagen, bedankt!', 'Zapisano, dziękujemy!'],
        'Abbrechen': ['Cancel', 'Annuleren', 'Anuluj'],
        'optional': ['optional', 'optioneel', 'opcjonalnie'],
        'Uhr': ['', '', ''],
        'Anrufen: {phone}': ['Call: {phone}', 'Bellen: {phone}', 'Zadzwoń: {phone}'],
        'Per WhatsApp schreiben': ['Message us on WhatsApp', 'Stuur ons een WhatsApp', 'Napisz na WhatsApp'],

        // ---- Login ----
        'Meine Buchung': ['My booking', 'Mijn boeking', 'Moja rezerwacja'],
        'Melden Sie sich mit Ihrem Buchungscode und Ihrem Anreisedatum an. Den Code finden Sie in unserer E-Mail oder in der Nachricht über Booking.com bzw. Airbnb. Airbnb-Gäste können auch ihren Airbnb-Bestätigungscode (HM…) verwenden.': [
            'Log in with your booking code and your arrival date. You will find the code in our e-mail or in our message via Booking.com or Airbnb. Airbnb guests can also use their Airbnb confirmation code (HM…).',
            'Log in met uw boekingscode en uw aankomstdatum. De code vindt u in onze e-mail of in ons bericht via Booking.com of Airbnb. Airbnb-gasten kunnen ook hun Airbnb-bevestigingscode (HM…) gebruiken.',
            'Zaloguj się kodem rezerwacji i datą przyjazdu. Kod znajdziesz w naszym e-mailu lub w wiadomości przez Booking.com albo Airbnb. Goście Airbnb mogą też użyć kodu potwierdzenia Airbnb (HM…).'],
        'Melden Sie sich mit Ihrem Buchungscode und Ihrem Anreisedatum an. Den Code finden Sie in unserer Nachricht über Booking.com, Airbnb oder per E-Mail.': [
            'Log in with your booking code and your arrival date. You will find the code in our message via Booking.com, Airbnb or e-mail.',
            'Log in met uw boekingscode en uw aankomstdatum. De code vindt u in ons bericht via Booking.com, Airbnb of e-mail.',
            'Zaloguj się kodem rezerwacji i datą przyjazdu. Kod znajdziesz w naszej wiadomości przez Booking.com, Airbnb lub e-mail.'],
        'Buchungscode': ['Booking code', 'Boekingscode', 'Kod rezerwacji'],
        'Anreisedatum': ['Arrival date', 'Aankomstdatum', 'Data przyjazdu'],
        'Noch nicht gebucht?': ['Not booked yet?', 'Nog niet geboekt?', 'Jeszcze bez rezerwacji?'],
        'Verfügbarkeit ansehen': ['Check availability', 'Beschikbaarheid bekijken', 'Sprawdź dostępność'],
        'Anmeldung fehlgeschlagen.': ['Login failed.', 'Inloggen mislukt.', 'Logowanie nie powiodło się.'],
        'Keine Buchung mit diesem Code und Anreisedatum gefunden.': ['No booking found with this code and arrival date.', 'Geen boeking gevonden met deze code en aankomstdatum.', 'Nie znaleziono rezerwacji z tym kodem i datą przyjazdu.'],
        'Zu viele Versuche. Bitte warten Sie 15 Minuten.': ['Too many attempts. Please wait 15 minutes.', 'Te veel pogingen. Wacht 15 minuten.', 'Zbyt wiele prób. Odczekaj 15 minut.'],
        'Zu viele Versuche. Bitte versuchen Sie es später erneut.': ['Too many attempts. Please try again later.', 'Te veel pogingen. Probeer het later opnieuw.', 'Zbyt wiele prób. Spróbuj ponownie później.'],
        'Zu viele Versuche. Bitte warten Sie 15 Minuten oder rufen Sie uns an.': ['Too many attempts. Please wait 15 minutes or call us.', 'Te veel pogingen. Wacht 15 minuten of bel ons.', 'Zbyt wiele prób. Odczekaj 15 minut lub zadzwoń do nas.'],
        'Zu viele Versuche. Bitte später erneut versuchen.': ['Too many attempts. Please try again later.', 'Te veel pogingen. Probeer het later opnieuw.', 'Zbyt wiele prób. Spróbuj ponownie później.'],
        'Zu viele Downloads. Bitte warten Sie kurz.': ['Too many downloads. Please wait a moment.', 'Te veel downloads. Wacht even.', 'Zbyt wiele pobrań. Poczekaj chwilę.'],
        'Zu viele Anfragen. Bitte kurz warten.': ['Too many requests. Please wait a moment.', 'Te veel verzoeken. Wacht even.', 'Zbyt wiele żądań. Poczekaj chwilę.'],
        'Bitte erneut anmelden.': ['Please log in again.', 'Log opnieuw in.', 'Zaloguj się ponownie.'],
        'Buchung nicht gefunden.': ['Booking not found.', 'Boeking niet gevonden.', 'Nie znaleziono rezerwacji.'],

        // ---- Tabs ----
        'Gäste': ['Guests', 'Gasten', 'Goście'],
        'Aufenthalt': ['Stay', 'Verblijf', 'Pobyt'],
        'Ankunft': ['Arrival', 'Aankomst', 'Przyjazd'],
        'A – Z': ['A – Z', 'A – Z', 'A – Z'],
        'Umgebung': ['Area', 'Omgeving', 'Okolica'],

        // ---- Status ----
        'Anfrage wird geprüft': ['Request being reviewed', 'Aanvraag wordt bekeken', 'Zapytanie w trakcie sprawdzania'],
        'Bestätigt': ['Confirmed', 'Bevestigd', 'Potwierdzona'],
        'Leider abgelehnt': ['Unfortunately declined', 'Helaas afgewezen', 'Niestety odrzucona'],
        'Storniert': ['Cancelled', 'Geannuleerd', 'Anulowana'],
        'Nicht mehr vorhanden': ['No longer available', 'Niet meer beschikbaar', 'Już niedostępna'],
        'Wir prüfen Ihre Anfrage und melden uns.': ['We are reviewing your request and will get back to you.', 'We bekijken uw aanvraag en nemen contact met u op.', 'Sprawdzamy zapytanie i odezwiemy się.'],
        'Schön, dass Sie da sind!': ['Lovely to have you here!', 'Fijn dat u er bent!', 'Cieszymy się, że jesteście!'],
        'Heute ist Ihr Abreisetag. Gute Heimreise!': ['Today is your departure day. Safe travels home!', 'Vandaag is uw vertrekdag. Goede reis naar huis!', 'Dziś dzień wyjazdu. Szczęśliwej podróży do domu!'],
        'Danke für Ihren Besuch!': ['Thank you for staying with us!', 'Bedankt voor uw bezoek!', 'Dziękujemy za pobyt!'],
        'Heute ist Ihr Anreisetag.': ['Today is your arrival day.', 'Vandaag is uw aankomstdag.', 'Dziś dzień przyjazdu.'],
        'Morgen geht es los!': ['Your stay starts tomorrow!', 'Morgen gaat het beginnen!', 'Jutro zaczynamy!'],
        'Noch {n} Tage bis zur Anreise.': ['{n} days until your arrival.', 'Nog {n} dagen tot uw aankomst.', 'Do przyjazdu zostało {n} dni.'],

        // ---- Aufenthalt ----
        'Buchung {code}': ['Booking {code}', 'Boeking {code}', 'Rezerwacja {code}'],
        'Diese Buchung finden wir nicht mehr. Möglicherweise wurde sie über das Buchungsportal storniert. Bei Fragen melden Sie sich gerne bei uns.': [
            'We can no longer find this booking. It may have been cancelled via the booking portal. If you have any questions, please get in touch.',
            'We kunnen deze boeking niet meer vinden. Mogelijk is ze via het boekingsportaal geannuleerd. Neem bij vragen gerust contact met ons op.',
            'Nie możemy już znaleźć tej rezerwacji. Mogła zostać anulowana przez portal rezerwacyjny. W razie pytań prosimy o kontakt.'],
        'Erw.': ['adults', 'volw.', 'dor.'],
        'Kind': ['child', 'kind', 'dziecko'],
        'Kinder': ['children', 'kinderen', 'dzieci'],
        'Nacht': ['night', 'nacht', 'noc'],
        'Nächte': ['nights', 'nachten', 'noce'],
        'Vielen Dank für Ihre Anfrage! Ihr Buchungscode:': ['Thank you for your request! Your booking code:', 'Hartelijk dank voor uw aanvraag! Uw boekingscode:', 'Dziękujemy za zapytanie! Kod rezerwacji:'],
        'Bitte notieren. Damit und mit Ihrem Anreisedatum rufen Sie den Status jederzeit ab.': ['Please note it down. With it and your arrival date you can check the status at any time.', 'Noteer deze code. Hiermee en met uw aankomstdatum bekijkt u altijd de status.', 'Prosimy go zapisać. Z nim i datą przyjazdu sprawdzisz status w każdej chwili.'],
        'Gebucht von': ['Booked by', 'Geboekt door', 'Zarezerwował(a)'],
        'Name fehlt': ['Name missing', 'Naam ontbreekt', 'Brak nazwiska'],
        'Gebucht': ['Booked', 'Geboekt', 'Zarezerwowano'],
        'Ferienwohnung': ['Holiday apartment', 'Vakantiewoning', 'Mieszkanie wakacyjne'],
        'Foto {n} der Wohnung': ['Photo {n} of the apartment', 'Foto {n} van het appartement', 'Zdjęcie {n} mieszkania'],
        'Vorheriges Foto': ['Previous photo', 'Vorige foto', 'Poprzednie zdjęcie'],
        'Nächstes Foto': ['Next photo', 'Volgende foto', 'Następne zdjęcie'],
        'Anreise': ['Arrival', 'Aankomst', 'Przyjazd'],
        'Abreise': ['Departure', 'Vertrek', 'Wyjazd'],
        'ab {t}': ['from {t}', 'vanaf {t}', 'od {t}'],
        'bis {t}': ['by {t}', 'tot {t}', 'do {t}'],
        'Gebucht über': ['Booked via', 'Geboekt via', 'Zarezerwowano przez'],
        'Direkt': ['Direct', 'Direct', 'Bezpośrednio'],
        'Preis': ['Price', 'Prijs', 'Cena'],
        'Gutschein': ['Voucher', 'Tegoedbon', 'Bon'],
        'Ihr Türcode': ['Your door code', 'Uw deurcode', 'Twój kod do drzwi'],
        'Türcode': ['Door code', 'Deurcode', 'Kod do drzwi'],
        'Gültig ab Anreisetag {from} Uhr bis Abreisetag {until} Uhr. Code eingeben und mit der Taste bestätigen.': [
            'Valid from {from} on your arrival day until {until} on your departure day. Enter the code and confirm with the key.',
            'Geldig vanaf {from} uur op de aankomstdag tot {until} uur op de vertrekdag. Code invoeren en met de toets bevestigen.',
            'Ważny od godz. {from} w dniu przyjazdu do godz. {until} w dniu wyjazdu. Wpisz kod i potwierdź przyciskiem.'],
        'Gültig ab Anreisetag {from} Uhr bis Abreisetag {until} Uhr.': [
            'Valid from {from} on your arrival day until {until} on your departure day.',
            'Geldig vanaf {from} uur op de aankomstdag tot {until} uur op de vertrekdag.',
            'Ważny od godz. {from} w dniu przyjazdu do godz. {until} w dniu wyjazdu.'],
        'einen Tag': ['one day', 'een dag', 'jeden dzień'],
        '{n} Tage': ['{n} days', '{n} dagen', '{n} dni'],
        'Ihr persönlicher Türcode erscheint hier {when} vor der Anreise{date}.': [
            'Your personal door code will appear here {when} before arrival{date}.',
            'Uw persoonlijke deurcode verschijnt hier {when} voor aankomst{date}.',
            'Twój osobisty kod do drzwi pojawi się tutaj {when} przed przyjazdem{date}.'],
        ', also ab {d}': [', i.e. from {d}', ', dus vanaf {d}', ', czyli od {d}'],
        'Erscheint hier {when} vor der Anreise{date}. Am Anreisetag schicken wir ihn Ihnen auch zu.': [
            'Will appear here {when} before arrival{date}. We will also send it to you on your arrival day.',
            'Verschijnt hier {when} voor aankomst{date}. Op de aankomstdag sturen we hem u ook toe.',
            'Pojawi się tutaj {when} przed przyjazdem{date}. W dniu przyjazdu wyślemy go również do Ciebie.'],
        'Erscheint {when} vor der Anreise unter „Aufenthalt“.': ['Will appear {when} before arrival under “Stay”.', 'Verschijnt {when} voor aankomst onder „Verblijf”.', 'Pojawi się {when} przed przyjazdem w zakładce „Pobyt”.'],
        'Heute ist Anreise': ['Arrival is today', 'Vandaag is de aankomst', 'Przyjazd jest dziś'],
        'Morgen ist Anreise': ['Arrival is tomorrow', 'Morgen is de aankomst', 'Przyjazd jest jutro'],
        'Route, Parken und wie Sie die Haustür öffnen, Schritt für Schritt mit Fotos.': ['Route, parking and how to open the front door, step by step with photos.', 'Route, parkeren en hoe u de voordeur opent, stap voor stap met foto’s.', 'Dojazd, parking i jak otworzyć drzwi wejściowe, krok po kroku ze zdjęciami.'],
        'So kommen Sie hinein': ['How to get in', 'Zo komt u binnen', 'Jak wejść do środka'],
        'Meldeschein ausgefüllt.': ['Registration form completed.', 'Registratieformulier ingevuld.', 'Karta meldunkowa wypełniona.'],
        'Danke!': ['Thank you!', 'Bedankt!', 'Dziękujemy!'],
        'Ansehen': ['View', 'Bekijken', 'Zobacz'],
        'Meldeschein ausfüllen': ['Fill in the registration form', 'Registratieformulier invullen', 'Wypełnij kartę meldunkową'],
        'Bitte füllen Sie vor der Anreise kurz den Meldeschein aus, für sich und alle Personen, die mit Ihnen übernachten. Das dauert zwei Minuten.': [
            'Before you arrive, please fill in the short registration form for yourself and everyone staying with you. It takes two minutes.',
            'Vul vóór aankomst kort het registratieformulier in, voor uzelf en iedereen die bij u overnacht. Het duurt twee minuten.',
            'Przed przyjazdem prosimy wypełnić krótką kartę meldunkową dla siebie i wszystkich osób nocujących. Zajmie to dwie minuty.'],
        'Jetzt ausfüllen': ['Fill in now', 'Nu invullen', 'Wypełnij teraz'],
        'Wir prüfen Ihre Anfrage und melden uns per E-Mail{to}. Auf dieser Seite sehen Sie den aktuellen Stand.': [
            'We are reviewing your request and will get back to you by e-mail{to}. This page always shows the current status.',
            'We bekijken uw aanvraag en sturen u een e-mail{to}. Op deze pagina ziet u de actuele stand.',
            'Sprawdzamy zapytanie i odpowiemy e-mailem{to}. Na tej stronie zobaczysz aktualny status.'],
        ' an {email}': [' to {email}', ' naar {email}', ' na adres {email}'],
        'Nachricht von uns': ['Message from us', 'Bericht van ons', 'Wiadomość od nas'],
        'Zahlung': ['Payment', 'Betaling', 'Płatność'],
        'Verwendungszweck': ['Payment reference', 'Omschrijving', 'Tytuł przelewu'],
        'Für den gewünschten Zeitraum können wir Ihnen leider keine Zusage geben. Schauen Sie gerne nach einem anderen Termin im Kalender.': [
            'Unfortunately we cannot confirm the requested dates. Feel free to look for other dates in the calendar.',
            'Helaas kunnen we de gewenste periode niet bevestigen. Kijk gerust naar een andere datum in de kalender.',
            'Niestety nie możemy potwierdzić wybranego terminu. Zapraszamy do wyboru innego terminu w kalendarzu.'],
        'Diese Buchung wurde storniert. Bei Fragen melden Sie sich gerne bei uns.': ['This booking was cancelled. If you have any questions, please get in touch.', 'Deze boeking is geannuleerd. Neem bij vragen gerust contact met ons op.', 'Ta rezerwacja została anulowana. W razie pytań prosimy o kontakt.'],

        // ---- WLAN-Karte ----
        'WLAN': ['Wi-Fi', 'wifi', 'Wi-Fi'],
        'Netzwerk': ['Network', 'Netwerk', 'Sieć'],
        'Passwort': ['Password', 'Wachtwoord', 'Hasło'],
        'Zugangscode': ['Access code', 'Toegangscode', 'Kod dostępu'],
        'QR-Code: mit der Handykamera scannen, um sich mit dem WLAN zu verbinden': ['QR code: scan with your phone camera to connect to the Wi-Fi', 'QR-code: scan met de camera van uw telefoon om verbinding te maken met de wifi', 'Kod QR: zeskanuj aparatem telefonu, aby połączyć się z Wi-Fi'],
        'Ihr persönliches WLAN-Passwort erscheint hier am Anreisetag ({d}) und gilt ab {t} Uhr.': ['Your personal Wi-Fi password will appear here on your arrival day ({d}) and works from {t}.', 'Uw persoonlijke wifi-wachtwoord verschijnt hier op de aankomstdag ({d}) en geldt vanaf {t} uur.', 'Twoje osobiste hasło Wi-Fi pojawi się tutaj w dniu przyjazdu ({d}) i działa od godz. {t}.'],
        'Ihr persönlicher WLAN-Zugangscode erscheint hier am Anreisetag ({d}).': ['Your personal Wi-Fi access code will appear here on your arrival day ({d}).', 'Uw persoonlijke wifi-toegangscode verschijnt hier op de aankomstdag ({d}).', 'Twój osobisty kod dostępu do Wi-Fi pojawi się tutaj w dniu przyjazdu ({d}).'],
        'QR-Code scannen oder mit dem WLAN verbinden, dann öffnet sich die Anmeldeseite: dort den Zugangscode eingeben. Gilt für bis zu {n} Geräte bis zum Check-out am Abreisetag.': [
            'Scan the QR code or connect to the Wi-Fi, then the login page opens: enter the access code there. Valid for up to {n} devices until check-out on your departure day.',
            'Scan de QR-code of maak verbinding met de wifi, dan opent de inlogpagina: voer daar de toegangscode in. Geldig voor maximaal {n} apparaten tot het uitchecken op de vertrekdag.',
            'Zeskanuj kod QR lub połącz się z Wi-Fi, otworzy się strona logowania: wpisz tam kod dostępu. Działa na maksymalnie {n} urządzeniach do wymeldowania w dniu wyjazdu.'],
        'Mit dem WLAN verbinden, dann öffnet sich die Anmeldeseite: dort den Zugangscode eingeben. Gilt für bis zu {n} Geräte bis zum Check-out am Abreisetag.': [
            'Connect to the Wi-Fi, then the login page opens: enter the access code there. Valid for up to {n} devices until check-out on your departure day.',
            'Maak verbinding met de wifi, dan opent de inlogpagina: voer daar de toegangscode in. Geldig voor maximaal {n} apparaten tot het uitchecken op de vertrekdag.',
            'Połącz się z Wi-Fi, otworzy się strona logowania: wpisz tam kod dostępu. Działa na maksymalnie {n} urządzeniach do wymeldowania w dniu wyjazdu.'],
        'Gilt nur für Ihren Aufenthalt, ab Anreisetag {t} Uhr bis Abreisetag {t} Uhr.': ['Valid for your stay only, from {t} on your arrival day until {t} on your departure day.', 'Alleen geldig tijdens uw verblijf, vanaf {t} uur op de aankomstdag tot {t} uur op de vertrekdag.', 'Ważne tylko w czasie pobytu, od godz. {t} w dniu przyjazdu do godz. {t} w dniu wyjazdu.'],
        'QR-Code mit der Handykamera scannen, dann verbindet sich das Handy von selbst.': ['Scan the QR code with your phone camera and your phone connects by itself.', 'Scan de QR-code met de camera van uw telefoon, dan maakt de telefoon vanzelf verbinding.', 'Zeskanuj kod QR aparatem telefonu, a telefon połączy się sam.'],

        // ---- Gäste / Meldeschein ----
        'Meldeschein': ['Registration form', 'Registratieformulier', 'Karta meldunkowa'],
        'Meldeschein für alle Personen und wie wir Sie erreichen.': ['Registration form for everyone and how we can reach you.', 'Registratieformulier voor iedereen en hoe we u bereiken.', 'Karta meldunkowa dla wszystkich osób i jak możemy się z Tobą skontaktować.'],
        'Bitte vor der Anreise ausfüllen. Für Gäste mit ausländischer Staatsangehörigkeit ist der Meldeschein gesetzlich vorgeschrieben (§ 29 Bundesmeldegesetz), wir bitten alle Gäste darum.': [
            'Please fill in before arrival. German law requires a registration form for guests of non-German nationality (§ 29 Federal Registration Act); we ask all guests to complete it.',
            'Vul dit vóór aankomst in. Voor gasten zonder Duitse nationaliteit is het registratieformulier wettelijk verplicht (§ 29 Bundesmeldegesetz); we vragen het alle gasten.',
            'Prosimy wypełnić przed przyjazdem. Dla gości bez obywatelstwa niemieckiego karta meldunkowa jest wymagana przez prawo (§ 29 Bundesmeldegesetz), prosimy o nią wszystkich gości.'],
        'Person {n}': ['Person {n}', 'Persoon {n}', 'Osoba {n}'],
        'Vorname(n)': ['First name(s)', 'Voornaam/-namen', 'Imię (imiona)'],
        'Familienname': ['Last name', 'Achternaam', 'Nazwisko'],
        'Geburtsdatum': ['Date of birth', 'Geboortedatum', 'Data urodzenia'],
        'Tag der Ankunft': ['Day of arrival', 'Dag van aankomst', 'Dzień przyjazdu'],
        'Voraussichtliche Abreise': ['Expected departure', 'Verwacht vertrek', 'Planowany wyjazd'],
        'Ihre Angaben': ['Your details', 'Uw gegevens', 'Twoje dane'],
        'Staatsangehörigkeit': ['Nationality', 'Nationaliteit', 'Obywatelstwo'],
        'Ausweisdokument': ['ID document', 'Identiteitsbewijs', 'Dokument tożsamości'],
        'Reisepass': ['Passport', 'Paspoort', 'Paszport'],
        'Personalausweis': ['ID card', 'Identiteitskaart', 'Dowód osobisty'],
        'Passersatz': ['Substitute passport', 'Vervangend reisdocument', 'Dokument zastępczy'],
        'Dokumentnummer': ['Document number', 'Documentnummer', 'Numer dokumentu'],
        'Für Gäste mit ausländischer Staatsangehörigkeit gesetzlich vorgeschrieben. Bitte bringen Sie das Dokument zur Anreise mit.': [
            'Required by law for guests of non-German nationality. Please bring the document with you.',
            'Wettelijk verplicht voor gasten zonder Duitse nationaliteit. Neem het document mee bij aankomst.',
            'Wymagane prawem dla gości bez obywatelstwa niemieckiego. Prosimy zabrać dokument ze sobą.'],
        'Wohnanschrift': ['Home address', 'Woonadres', 'Adres zamieszkania'],
        'Straße und Hausnummer': ['Street and house number', 'Straat en huisnummer', 'Ulica i numer domu'],
        'PLZ': ['Postcode', 'Postcode', 'Kod pocztowy'],
        'Ort': ['Town / city', 'Plaats', 'Miejscowość'],
        'Land': ['Country', 'Land', 'Kraj'],
        'Telefon': ['Phone', 'Telefoon', 'Telefon'],
        'E-Mail': ['E-mail', 'E-mail', 'E-mail'],
        'Weitere Personen': ['Other guests', 'Overige personen', 'Pozostałe osoby'],
        'Wie viele Personen übernachten insgesamt, Sie eingeschlossen?': ['How many people are staying in total, including you?', 'Hoeveel personen overnachten er in totaal, uzelf meegerekend?', 'Ile osób łącznie nocuje, wliczając Ciebie?'],
        'Bitte wählen': ['Please choose', 'Maak een keuze', 'Wybierz'],
        'Person (nur ich)': ['person (just me)', 'persoon (alleen ik)', 'osoba (tylko ja)'],
        'Personen': ['people', 'personen', 'osoby'],
        'Jede weitere Person, auch Kinder, braucht einen eigenen Eintrag mit Vorname, Familienname und Geburtsdatum.': [
            'Every other person, children included, needs their own entry with first name, last name and date of birth.',
            'Elke andere persoon, ook kinderen, heeft een eigen regel nodig met voornaam, achternaam en geboortedatum.',
            'Każda kolejna osoba, także dzieci, potrzebuje osobnego wpisu z imieniem, nazwiskiem i datą urodzenia.'],
        'Bestätigung': ['Confirmation', 'Bevestiging', 'Potwierdzenie'],
        'Ich bestätige, dass meine Angaben richtig und vollständig sind.': ['I confirm that my details are correct and complete.', 'Ik bevestig dat mijn gegevens juist en volledig zijn.', 'Potwierdzam, że moje dane są prawidłowe i kompletne.'],
        'Wir nutzen die Angaben nur für die gesetzliche Meldepflicht (§§ 29, 30 Bundesmeldegesetz) und löschen sie nach Ablauf der Aufbewahrungsfrist von einem Jahr nach Abreise.': [
            'We only use these details for the legal registration duty (§§ 29, 30 Federal Registration Act) and delete them when the retention period of one year after departure has passed.',
            'We gebruiken de gegevens alleen voor de wettelijke meldplicht (§§ 29, 30 Bundesmeldegesetz) en verwijderen ze na afloop van de bewaartermijn van een jaar na vertrek.',
            'Dane wykorzystujemy wyłącznie do ustawowego obowiązku meldunkowego (§§ 29, 30 Bundesmeldegesetz) i usuwamy je po upływie rocznego okresu przechowywania od wyjazdu.'],
        'Meldeschein absenden': ['Send registration form', 'Registratieformulier verzenden', 'Wyślij kartę meldunkową'],
        'Wird gesendet …': ['Sending …', 'Wordt verzonden …', 'Wysyłanie …'],
        'Vielen Dank, Ihr Meldeschein ist da.': ['Thank you, we have received your registration form.', 'Hartelijk dank, we hebben uw registratieformulier ontvangen.', 'Dziękujemy, otrzymaliśmy kartę meldunkową.'],
        'Übermittelt am {d}.': ['Sent on {d}.', 'Verzonden op {d}.', 'Wysłano {d}.'],
        'Name': ['Name', 'Naam', 'Imię i nazwisko'],
        'Anschrift': ['Address', 'Adres', 'Adres'],
        'Ausweis': ['ID', 'Identiteitsbewijs', 'Dokument'],
        'geb. {d}': ['born {d}', 'geb. {d}', 'ur. {d}'],
        'keine': ['none', 'geen', 'brak'],
        'Angaben ändern': ['Change details', 'Gegevens wijzigen', 'Zmień dane'],
        'Änderungen ab dem Anreisetag bitte direkt bei uns.': ['From your arrival day, please contact us directly for changes.', 'Wijzigingen vanaf de aankomstdag graag rechtstreeks bij ons.', 'Od dnia przyjazdu zmiany prosimy zgłaszać bezpośrednio do nas.'],
        'Bitte angeben, wie viele Personen übernachten.': ['Please state how many people are staying.', 'Geef aan hoeveel personen er overnachten.', 'Podaj, ile osób nocuje.'],
        'Bitte bei Person {n} Vorname, Familienname und Geburtsdatum eintragen.': ['Please enter first name, last name and date of birth for person {n}.', 'Vul bij persoon {n} voornaam, achternaam en geboortedatum in.', 'Wpisz imię, nazwisko i datę urodzenia osoby {n}.'],
        'Bitte bestätigen Sie, dass Ihre Angaben stimmen.': ['Please confirm that your details are correct.', 'Bevestig dat uw gegevens kloppen.', 'Potwierdź, że dane są prawidłowe.'],
        'Das hat nicht geklappt. Bitte erneut versuchen.': ['That did not work. Please try again.', 'Dat is niet gelukt. Probeer het opnieuw.', 'Nie udało się. Spróbuj ponownie.'],
        'Bitte den Familiennamen angeben.': ['Please enter the last name.', 'Vul de achternaam in.', 'Podaj nazwisko.'],
        'Bitte den Vornamen angeben.': ['Please enter the first name.', 'Vul de voornaam in.', 'Podaj imię.'],
        'Bitte ein gültiges Geburtsdatum angeben.': ['Please enter a valid date of birth.', 'Vul een geldige geboortedatum in.', 'Podaj prawidłową datę urodzenia.'],
        'Bitte die Staatsangehörigkeit angeben.': ['Please enter the nationality.', 'Vul de nationaliteit in.', 'Podaj obywatelstwo.'],
        'Bitte Straße und Hausnummer angeben.': ['Please enter street and house number.', 'Vul straat en huisnummer in.', 'Podaj ulicę i numer domu.'],
        'Bitte die Postleitzahl angeben.': ['Please enter the postcode.', 'Vul de postcode in.', 'Podaj kod pocztowy.'],
        'Bitte eine gültige Postleitzahl angeben.': ['Please enter a valid postcode.', 'Vul een geldige postcode in.', 'Podaj prawidłowy kod pocztowy.'],
        'Bitte den Wohnort angeben.': ['Please enter the town or city.', 'Vul de woonplaats in.', 'Podaj miejscowość.'],
        'Bitte den Ort angeben.': ['Please enter the town or city.', 'Vul de plaats in.', 'Podaj miejscowość.'],
        'Gäste mit ausländischer Staatsangehörigkeit geben bitte die Nummer ihres Reisepasses oder Ausweises an.': ['Guests of non-German nationality, please enter your passport or ID card number.', 'Gasten zonder Duitse nationaliteit vullen het nummer van hun paspoort of identiteitskaart in.', 'Goście bez obywatelstwa niemieckiego proszeni są o podanie numeru paszportu lub dowodu osobistego.'],
        'Bitte eine gültige E-Mail-Adresse angeben.': ['Please enter a valid e-mail address.', 'Vul een geldig e-mailadres in.', 'Podaj prawidłowy adres e-mail.'],
        'Bitte für jede weitere Person Vorname, Familienname und Geburtsdatum angeben.': ['Please enter first name, last name and date of birth for every other person.', 'Vul voor elke andere persoon voornaam, achternaam en geboortedatum in.', 'Podaj imię, nazwisko i datę urodzenia każdej kolejnej osoby.'],
        'Bitte Vor- und Familiennamen von Person {n} angeben.': ['Please enter first and last name of person {n}.', 'Vul voor- en achternaam van persoon {n} in.', 'Podaj imię i nazwisko osoby {n}.'],
        'Bitte das Geburtsdatum von {name} angeben.': ['Please enter the date of birth of {name}.', 'Vul de geboortedatum van {name} in.', 'Podaj datę urodzenia: {name}.'],
        'Ab dem Anreisetag ändern wir den Meldeschein gerne für Sie. Bitte melden Sie sich kurz bei uns.': ['From your arrival day we are happy to change the form for you. Please get in touch.', 'Vanaf de aankomstdag wijzigen wij het formulier graag voor u. Neem even contact met ons op.', 'Od dnia przyjazdu chętnie zmienimy kartę za Ciebie. Prosimy o kontakt.'],
        'Der Meldeschein ist gerade nicht verfügbar.': ['The registration form is not available right now.', 'Het registratieformulier is momenteel niet beschikbaar.', 'Karta meldunkowa jest chwilowo niedostępna.'],
        'Speichern fehlgeschlagen. Bitte später erneut versuchen.': ['Saving failed. Please try again later.', 'Opslaan mislukt. Probeer het later opnieuw.', 'Zapis nie powiódł się. Spróbuj ponownie później.'],
        'Speichern fehlgeschlagen.': ['Saving failed.', 'Opslaan mislukt.', 'Zapis nie powiódł się.'],
        'Bitte ergänzen Sie Ihren Namen': ['Please add your name', 'Vul uw naam aan', 'Uzupełnij swoje imię i nazwisko'],
        'Kontakt & Ankunft': ['Contact & arrival', 'Contact & aankomst', 'Kontakt i przyjazd'],
        'Das Buchungsportal hat uns Ihren Namen nicht übermittelt. Mit dem Meldeschein tragen Sie ihn automatisch ein.': ['The booking portal did not pass on your name. The registration form fills it in automatically.', 'Het boekingsportaal heeft uw naam niet doorgegeven. Met het registratieformulier vult u hem automatisch in.', 'Portal rezerwacyjny nie przekazał nam Twojego nazwiska. Karta meldunkowa uzupełni je automatycznie.'],
        'Damit wir Sie erreichen und rechtzeitig da sind.': ['So we can reach you and are there on time.', 'Zodat we u kunnen bereiken en op tijd zijn.', 'Abyśmy mogli się z Tobą skontaktować i być na czas.'],
        'Vor- und Nachname': ['First and last name', 'Voor- en achternaam', 'Imię i nazwisko'],
        'Ankunft ca.': ['Arrival approx.', 'Aankomst ca.', 'Przyjazd ok.'],
        'z. B. 17:30 Uhr': ['e.g. 5:30 pm', 'bijv. 17:30 uur', 'np. 17:30'],
        'Nachricht': ['Message', 'Bericht', 'Wiadomość'],
        'Bitte Ihren vollständigen Namen angeben.': ['Please enter your full name.', 'Vul uw volledige naam in.', 'Podaj pełne imię i nazwisko.'],

        // ---- Ankunft ----
        'Anfahrt': ['Getting here', 'Route', 'Dojazd'],
        'Route': ['Route', 'Route', 'Trasa'],
        'Route in Google Maps starten': ['Start route in Google Maps', 'Route starten in Google Maps', 'Uruchom trasę w Mapach Google'],
        'Route in Google Maps': ['Route in Google Maps', 'Route in Google Maps', 'Trasa w Mapach Google'],
        'Ankommen': ['Arriving', 'Aankomen', 'Na miejscu'],
        'Parken': ['Parking', 'Parkeren', 'Parking'],
        'Parkplatz': ['Parking space', 'Parkeerplaats', 'Miejsce parkingowe'],
        'Eingang': ['Entrance', 'Ingang', 'Wejście'],
        'Die Haustür': ['The front door', 'De voordeur', 'Drzwi wejściowe'],
        'Haustür': ['Front door', 'Voordeur', 'Drzwi wejściowe'],
        'Tür öffnen': ['Open the door', 'Deur openen', 'Otwórz drzwi'],
        'Schritt für Schritt': ['Step by step', 'Stap voor stap', 'Krok po kroku'],
        'Schritt {n}': ['Step {n}', 'Stap {n}', 'Krok {n}'],
        'Reagiert das Tastenfeld nicht? Scannen Sie den QR-Code an der Tür, damit öffnen Sie während Ihres Aufenthalts die Tür mit dem Handy.': [
            'Keypad not responding? Scan the QR code on the door to open it with your phone during your stay.',
            'Reageert het toetsenbord niet? Scan de QR-code op de deur, dan opent u tijdens uw verblijf de deur met uw telefoon.',
            'Klawiatura nie reaguje? Zeskanuj kod QR na drzwiach, aby w czasie pobytu otworzyć je telefonem.'],
        'Anreise am {d}{t}.': ['Arrival on {d}{t}.', 'Aankomst op {d}{t}.', 'Przyjazd {d}{t}.'],
        ' ab {t} Uhr': [' from {t}', ' vanaf {t} uur', ' od godz. {t}'],
        'Zum Nachschlagen während Ihres Aufenthalts.': ['For reference during your stay.', 'Om na te lezen tijdens uw verblijf.', 'Do wglądu w trakcie pobytu.'],
        'Ihre Ankunft': ['Your arrival', 'Uw aankomst', 'Twój przyjazd'],
        'So finden Sie zu uns und kommen ins Haus.': ['How to find us and get into the house.', 'Zo vindt u ons en komt u binnen.', 'Jak do nas trafić i wejść do domu.'],

        // ---- A – Z ----
        'An- & Abreise': ['Arrival & departure', 'Aankomst & vertrek', 'Przyjazd i wyjazd'],
        'Adresse': ['Address', 'Adres', 'Adres'],
        'Hausregeln': ['House rules', 'Huisregels', 'Regulamin domu'],
        'Kontakt & Notfall': ['Contact & emergency', 'Contact & noodgeval', 'Kontakt i nagłe wypadki'],
        'Gästemappe A – Z': ['Guest guide A – Z', 'Gastenmap A – Z', 'Informator A – Z'],
        'Alles für Ihren Aufenthalt, von WLAN bis Hausregeln.': ['Everything for your stay, from Wi-Fi to house rules.', 'Alles voor uw verblijf, van wifi tot huisregels.', 'Wszystko o pobycie, od Wi-Fi po regulamin domu.'],
        '{d}, ab {t} Uhr': ['{d}, from {t}', '{d}, vanaf {t} uur', '{d}, od godz. {t}'],
        '{d}, bis {t} Uhr': ['{d}, by {t}', '{d}, tot {t} uur', '{d}, do godz. {t}'],

        // ---- Umgebung / Live-Tipps ----
        'Heute': ['Today', 'Vandaag', 'Dziś'],
        'Morgen': ['Tomorrow', 'Morgen', 'Jutro'],
        'morgen': ['tomorrow', 'morgen', 'jutro'],
        'Wetter': ['Weather', 'Weer', 'Pogoda'],
        'Wetter in {place} · jetzt': ['Weather in {place} · now', 'Weer in {place} · nu', 'Pogoda w {place} · teraz'],
        'Wetter · jetzt': ['Weather · now', 'Weer · nu', 'Pogoda · teraz'],
        'Heute {min}° bis {max}°': ['Today {min}° to {max}°', 'Vandaag {min}° tot {max}°', 'Dziś od {min}° do {max}°'],
        'Regenrisiko {n} %': ['chance of rain {n} %', 'kans op regen {n} %', 'szansa opadów {n} %'],
        'Wind {n} km/h': ['wind {n} km/h', 'wind {n} km/u', 'wiatr {n} km/h'],
        'Sonnenuntergang {t}': ['sunset {t}', 'zonsondergang {t}', 'zachód słońca {t}'],
        'Sonnenuntergang {t} Uhr': ['sunset {t}', 'zonsondergang {t} uur', 'zachód słońca {t}'],
        'gefühlt {n}°': ['feels like {n}°', 'voelt als {n}°', 'odczuwalna {n}°'],
        'Öffnungszeiten · jetzt': ['Opening hours · now', 'Openingstijden · nu', 'Godziny otwarcia · teraz'],
        'Einkaufen & Essen': ['Shopping & food', 'Winkelen & eten', 'Zakupy i jedzenie'],
        'Alle Zeiten': ['All times', 'Alle tijden', 'Wszystkie godziny'],
        'Heute {t}': ['Today {t}', 'Vandaag {t}', 'Dziś {t}'],
        'Während Ihres Aufenthalts': ['During your stay', 'Tijdens uw verblijf', 'W czasie pobytu'],
        'In den nächsten Tagen': ['In the coming days', 'In de komende dagen', 'W najbliższych dniach'],
        'Veranstaltungen': ['Events', 'Evenementen', 'Wydarzenia'],
        'Uns sind für diese Tage keine Veranstaltungen bekannt. Fragen Sie uns gerne nach Tipps.': ['We know of no events on these days. Feel free to ask us for tips.', 'Wij kennen voor deze dagen geen evenementen. Vraag ons gerust om tips.', 'Nie znamy wydarzeń w tych dniach. Chętnie podpowiemy, co warto zobaczyć.'],
        'So finden Sie uns': ['How to find us', 'Zo vindt u ons', 'Jak nas znaleźć'],
        'Route planen': ['Plan route', 'Route plannen', 'Zaplanuj trasę'],
        'Mehr erfahren': ['Learn more', 'Meer informatie', 'Więcej'],
        'Umgebung & Highlights': ['Area & highlights', 'Omgeving & hoogtepunten', 'Okolica i atrakcje'],
        'Unsere Tipps für Ausflüge und den Alltag vor Ort.': ['Our tips for day trips and everyday life nearby.', 'Onze tips voor uitstapjes en het dagelijks leven ter plaatse.', 'Nasze wskazówki na wycieczki i codzienne sprawy na miejscu.'],
        'Unsere Ausflugstipps': ['Our day-trip tips', 'Onze uitstaptips', 'Nasze propozycje wycieczek'],
        'Unsere Tipps folgen in Kürze.': ['Our tips are coming soon.', 'Onze tips volgen binnenkort.', 'Nasze wskazówki pojawią się wkrótce.'],
        'Jetzt geöffnet?': ['Open now?', 'Nu open?', 'Otwarte teraz?'],
        'geöffnet': ['open', 'open', 'otwarte'],
        'geschlossen': ['closed', 'gesloten', 'zamknięte'],
        'durchgehend': ['all day', 'doorlopend', 'całą dobę'],
        'Rund um die Uhr geöffnet': ['Open 24 hours', 'Dag en nacht open', 'Otwarte całą dobę'],
        'Geöffnet bis {t}': ['Open until {t}', 'Open tot {t}', 'Otwarte do {t}'],
        'Schließt bald · {t}': ['Closes soon · {t}', 'Sluit binnenkort · {t}', 'Wkrótce zamknięcie · {t}'],
        'Öffnet heute um {t}': ['Opens today at {t}', 'Opent vandaag om {t}', 'Otwarcie dziś o {t}'],
        'Geschlossen · öffnet {day} {t}': ['Closed · opens {day} {t}', 'Gesloten · opent {day} {t}', 'Zamknięte · otwarcie {day} {t}'],
        'Geschlossen': ['Closed', 'Gesloten', 'Zamknięte'],
        'Mo': ['Mon', 'ma', 'pon.'], 'Di': ['Tue', 'di', 'wt.'], 'Mi': ['Wed', 'wo', 'śr.'], 'Do': ['Thu', 'do', 'czw.'],
        'Fr': ['Fri', 'vr', 'pt.'], 'Sa': ['Sat', 'za', 'sob.'], 'So': ['Sun', 'zo', 'niedz.'],
        'Montag': ['Monday', 'maandag', 'w poniedziałek'], 'Dienstag': ['Tuesday', 'dinsdag', 'we wtorek'], 'Mittwoch': ['Wednesday', 'woensdag', 'w środę'],
        'Donnerstag': ['Thursday', 'donderdag', 'w czwartek'], 'Freitag': ['Friday', 'vrijdag', 'w piątek'], 'Samstag': ['Saturday', 'zaterdag', 'w sobotę'], 'Sonntag': ['Sunday', 'zondag', 'w niedzielę'],
        // Wetter (Open-Meteo)
        'Klar': ['Clear', 'Helder', 'Bezchmurnie'], 'Überwiegend klar': ['Mostly clear', 'Overwegend helder', 'Przeważnie bezchmurnie'],
        'Teils bewölkt': ['Partly cloudy', 'Half bewolkt', 'Częściowe zachmurzenie'], 'Bewölkt': ['Cloudy', 'Bewolkt', 'Pochmurno'],
        'Nebel': ['Fog', 'Mist', 'Mgła'], 'Nebel mit Reif': ['Freezing fog', 'Mist met rijp', 'Mgła z szadzią'],
        'Leichter Nieselregen': ['Light drizzle', 'Lichte motregen', 'Lekka mżawka'], 'Nieselregen': ['Drizzle', 'Motregen', 'Mżawka'],
        'Starker Nieselregen': ['Heavy drizzle', 'Zware motregen', 'Silna mżawka'], 'Gefrierender Niesel': ['Freezing drizzle', 'IJzel', 'Marznąca mżawka'],
        'Leichter Regen': ['Light rain', 'Lichte regen', 'Lekki deszcz'], 'Regen': ['Rain', 'Regen', 'Deszcz'], 'Starker Regen': ['Heavy rain', 'Zware regen', 'Silny deszcz'],
        'Gefrierender Regen': ['Freezing rain', 'IJzel', 'Marznący deszcz'], 'Leichter Schneefall': ['Light snow', 'Lichte sneeuwval', 'Lekki śnieg'],
        'Schneefall': ['Snow', 'Sneeuwval', 'Śnieg'], 'Starker Schneefall': ['Heavy snow', 'Zware sneeuwval', 'Intensywny śnieg'], 'Schneegriesel': ['Snow grains', 'Motsneeuw', 'Śnieg ziarnisty'],
        'Regenschauer': ['Rain showers', 'Regenbuien', 'Przelotne opady'], 'Heftige Schauer': ['Heavy showers', 'Zware buien', 'Silne przelotne opady'],
        'Schneeschauer': ['Snow showers', 'Sneeuwbuien', 'Przelotny śnieg'], 'Gewitter': ['Thunderstorm', 'Onweer', 'Burza'], 'Gewitter mit Hagel': ['Thunderstorm with hail', 'Onweer met hagel', 'Burza z gradem'],
        // Art der Orte
        'Supermarkt': ['Supermarket', 'Supermarkt', 'Supermarket'], 'Bäckerei': ['Bakery', 'Bakkerij', 'Piekarnia'], 'Metzgerei': ['Butcher', 'Slagerij', 'Mięsny'],
        'Kiosk / Laden': ['Corner shop', 'Buurtwinkel', 'Sklep osiedlowy'], 'Kiosk': ['Kiosk', 'Kiosk', 'Kiosk'], 'Getränkemarkt': ['Drinks store', 'Drankenhandel', 'Sklep z napojami'],
        'Drogerie': ['Drugstore', 'Drogisterij', 'Drogeria'], 'Apotheke': ['Pharmacy', 'Apotheek', 'Apteka'], 'Restaurant': ['Restaurant', 'Restaurant', 'Restauracja'],
        'Café': ['Café', 'Café', 'Kawiarnia'], 'Imbiss': ['Snack bar', 'Snackbar', 'Bar szybkiej obsługi'], 'Eiscafé': ['Ice cream parlour', 'IJssalon', 'Lodziarnia'],
        'Kneipe': ['Pub', 'Kroeg', 'Pub'], 'Bar': ['Bar', 'Bar', 'Bar'], 'Biergarten': ['Beer garden', 'Biertuin', 'Ogródek piwny'], 'Tankstelle': ['Petrol station', 'Tankstation', 'Stacja benzynowa'],
        'Museum': ['Museum', 'Museum', 'Muzeum'], 'Zoo / Tierpark': ['Zoo', 'Dierentuin', 'Zoo'], 'Sehenswürdigkeit': ['Sight', 'Bezienswaardigheid', 'Atrakcja'], 'Galerie': ['Gallery', 'Galerie', 'Galeria'],
        'Schwimmbad': ['Swimming pool', 'Zwembad', 'Basen'], 'Freizeitbad': ['Leisure pool', 'Subtropisch zwembad', 'Aquapark'], 'Sportzentrum': ['Sports centre', 'Sportcentrum', 'Centrum sportowe'], 'Arztpraxis': ['Doctor', 'Huisartsenpraktijk', 'Gabinet lekarski'],

        // ---- Kontakt / Rechnung ----
        'Kontakt': ['Contact', 'Contact', 'Kontakt'],
        'Fragen zum Aufenthalt? Schreiben Sie uns einfach, wir antworten so schnell wie möglich.': ['Questions about your stay? Just message us, we will reply as soon as possible.', 'Vragen over uw verblijf? Stuur ons gewoon een bericht, we antwoorden zo snel mogelijk.', 'Pytania o pobyt? Po prostu napisz, odpowiemy jak najszybciej.'],
        'Rechnung': ['Invoice', 'Factuur', 'Faktura'],
        'Nr. {n}': ['No. {n}', 'Nr. {n}', 'Nr {n}'],
        ' vom {d}': [' of {d}', ' van {d}', ' z {d}'],
        'bezahlt': ['paid', 'betaald', 'zapłacona'],
        'offen': ['open', 'open', 'do zapłaty'],
        'Als PDF herunterladen': ['Download as PDF', 'Downloaden als pdf', 'Pobierz jako PDF'],
        'Etwas stimmt nicht? Korrektur anfragen': ['Something wrong? Request a correction', 'Klopt er iets niet? Correctie aanvragen', 'Coś się nie zgadza? Poproś o korektę'],
        'Eine erstellte Rechnung können Sie nicht mehr selbst ändern. Schreiben Sie uns, was falsch ist. Wir korrigieren die Rechnung und melden uns.': [
            'You cannot change an invoice yourself once it has been created. Tell us what is wrong. We will correct the invoice and get back to you.',
            'Een aangemaakte factuur kunt u niet meer zelf wijzigen. Laat ons weten wat er niet klopt. We corrigeren de factuur en nemen contact met u op.',
            'Utworzonej faktury nie można już samodzielnie zmienić. Napisz nam, co jest nie tak. Poprawimy fakturę i odezwiemy się.'],
        'Was soll geändert werden?': ['What should be changed?', 'Wat moet er worden gewijzigd?', 'Co należy zmienić?'],
        'Anfrage senden': ['Send request', 'Verzoek verzenden', 'Wyślij prośbę'],
        'Gesendet, wir melden uns.': ['Sent, we will get back to you.', 'Verzonden, we nemen contact met u op.', 'Wysłano, odezwiemy się.'],
        'Sie brauchen eine Rechnung? Ergänzen Sie Ihre Rechnungsdaten. Danach können Sie die Rechnung sofort als PDF herunterladen.': [
            'Need an invoice? Add your billing details. You can then download the invoice as a PDF straight away.',
            'Heeft u een factuur nodig? Vul uw factuurgegevens aan. Daarna kunt u de factuur direct als pdf downloaden.',
            'Potrzebujesz faktury? Uzupełnij dane do faktury. Następnie od razu pobierzesz ją jako PDF.'],
        'Rechnungsdaten eingeben': ['Enter billing details', 'Factuurgegevens invoeren', 'Wpisz dane do faktury'],
        'Firma': ['Company', 'Bedrijf', 'Firma'],
        'optional, nur für Firmenrechnungen': ['optional, for company invoices only', 'optioneel, alleen voor zakelijke facturen', 'opcjonalnie, tylko dla faktur firmowych'],
        'USt-IdNr.': ['VAT number', 'Btw-nummer', 'NIP UE'],
        'z. B. DE123456789': ['e.g. DE123456789', 'bijv. NL123456789B01', 'np. PL1234567890'],
        'Gesamtbetrag': ['Total', 'Totaalbedrag', 'Suma'],
        ' inkl. {n} % MwSt.': [' incl. {n} % VAT', ' incl. {n} % btw', ' z {n} % VAT'],
        'Bereits bezahlt über {s}.': ['Already paid via {s}.', 'Al betaald via {s}.', 'Już opłacono przez {s}.'],
        'Zahlung per Überweisung, die Bankverbindung steht auf der Rechnung.': ['Payment by bank transfer, the bank details are on the invoice.', 'Betaling per overschrijving, de bankgegevens staan op de factuur.', 'Płatność przelewem, dane bankowe są na fakturze.'],
        'Meine Angaben stimmen. Danach kann ich die Rechnung nicht mehr selbst ändern.': ['My details are correct. I understand that I cannot change the invoice myself afterwards.', 'Mijn gegevens kloppen. Daarna kan ik de factuur niet meer zelf wijzigen.', 'Moje dane są prawidłowe. Później nie mogę samodzielnie zmienić faktury.'],
        'Rechnung erstellen': ['Create invoice', 'Factuur aanmaken', 'Utwórz fakturę'],
        'Wird erstellt …': ['Creating …', 'Wordt aangemaakt …', 'Tworzenie …'],
        'Download fehlgeschlagen.': ['Download failed.', 'Downloaden mislukt.', 'Pobieranie nie powiodło się.'],
        'Senden fehlgeschlagen.': ['Sending failed.', 'Verzenden mislukt.', 'Wysyłanie nie powiodło się.'],
        'Übernachtung': ['Overnight stay', 'Overnachting', 'Nocleg'],
        'Endreinigung': ['Final cleaning', 'Eindschoonmaak', 'Sprzątanie końcowe'],
        'Für diese Buchung gibt es schon eine Rechnung.': ['There is already an invoice for this booking.', 'Voor deze boeking bestaat al een factuur.', 'Dla tej rezerwacji istnieje już faktura.'],
        'Die Rechnung erstellen wir gerne für Sie. Bitte melden Sie sich kurz bei uns.': ['We are happy to create the invoice for you. Please get in touch.', 'We maken de factuur graag voor u. Neem even contact met ons op.', 'Chętnie wystawimy fakturę. Prosimy o kontakt.'],
        'Die Rechnung konnte gerade nicht erstellt werden. Bitte später erneut versuchen.': ['The invoice could not be created right now. Please try again later.', 'De factuur kon nu niet worden aangemaakt. Probeer het later opnieuw.', 'Nie udało się teraz utworzyć faktury. Spróbuj ponownie później.'],
        'Bitte zur USt-IdNr. auch den Firmennamen angeben.': ['Please also enter the company name with the VAT number.', 'Vul bij het btw-nummer ook de bedrijfsnaam in.', 'Podaj też nazwę firmy razem z numerem NIP UE.'],
        'Bitte kurz schreiben, was geändert werden soll.': ['Please write briefly what should be changed.', 'Schrijf kort wat er moet worden gewijzigd.', 'Napisz krótko, co należy zmienić.'],
        'Senden fehlgeschlagen. Bitte melden Sie sich direkt bei uns.': ['Sending failed. Please contact us directly.', 'Verzenden mislukt. Neem rechtstreeks contact met ons op.', 'Wysyłanie nie powiodło się. Skontaktuj się z nami bezpośrednio.'],

        // ---- WLAN-Anmeldeseite ----
        'Gäste-WLAN': ['Guest Wi-Fi', 'Gastenwifi', 'Wi-Fi dla gości'],
        'Verbunden': ['Connected', 'Verbonden', 'Połączono'],
        'Willkommen im <em>WLAN</em>': ['Welcome to the <em>Wi-Fi</em>', 'Welkom op de <em>wifi</em>', 'Witamy w <em>Wi-Fi</em>'],
        'Schön, dass Sie da sind. Mit Ihrem persönlichen Zugangscode sind Sie in wenigen Sekunden online.': ['Lovely to have you here. With your personal access code you will be online in a few seconds.', 'Fijn dat u er bent. Met uw persoonlijke toegangscode bent u binnen enkele seconden online.', 'Cieszymy się, że jesteście. Z osobistym kodem dostępu połączysz się w kilka sekund.'],
        'Als {name} verbinden': ['Connect as {name}', 'Verbinden als {name}', 'Połącz jako {name}'],
        'oder mit Code': ['or with code', 'of met code', 'lub kodem'],
        'Verbinden': ['Connect', 'Verbinden', 'Połącz'],
        'Ihren 6-stelligen Code finden Sie': ['You will find your 6-digit code', 'Uw 6-cijferige code vindt u', 'Twój 6-cyfrowy kod znajdziesz'],
        'auf „Meine Buchung“ unter WLAN,': ['on “My booking” under Wi-Fi,', 'op „Mijn boeking” onder wifi,', 'w „Mojej rezerwacji” w sekcji Wi-Fi,'],
        'in Ihrer Nachricht zum Anreisetag,': ['in your arrival-day message,', 'in uw bericht voor de aankomstdag,', 'w wiadomości na dzień przyjazdu,'],
        'auf dem Fernseher in der Wohnung.': ['on the TV in the apartment.', 'op de tv in het appartement.', 'na telewizorze w mieszkaniu.'],
        'Hinweise zur Nutzung': ['Terms of use', 'Gebruiksvoorwaarden', 'Zasady korzystania'],
        'Das WLAN ist für die Gäste dieser Buchung, höchstens {n} Geräte.': ['The Wi-Fi is for the guests of this booking, up to {n} devices.', 'De wifi is voor de gasten van deze boeking, maximaal {n} apparaten.', 'Wi-Fi jest dla gości tej rezerwacji, maksymalnie {n} urządzeń.'],
        'Bitte nutzen Sie es nur im Rahmen der Gesetze: keine Tauschbörsen für urheberrechtlich geschützte Inhalte, keine strafbaren Inhalte.': ['Please use it lawfully only: no file sharing of copyrighted content, no illegal content.', 'Gebruik het alleen binnen de wet: geen filesharing van auteursrechtelijk beschermde inhoud, geen strafbare inhoud.', 'Prosimy korzystać zgodnie z prawem: bez udostępniania treści chronionych prawem autorskim i bez treści niezgodnych z prawem.'],
        'Die Verbindung ins Internet ist verschlüsselt wie zu Hause; Ihre Geräte sind vom Heimnetz des Gastgebers getrennt.': ['The internet connection is encrypted just like at home; your devices are separated from the host’s home network.', 'De internetverbinding is versleuteld zoals thuis; uw apparaten zijn gescheiden van het thuisnetwerk van de gastheer.', 'Połączenie z internetem jest szyfrowane jak w domu; Twoje urządzenia są oddzielone od sieci domowej gospodarza.'],
        'Der Zugang endet automatisch am Abreisetag nach dem Check-out.': ['Access ends automatically on your departure day after check-out.', 'De toegang eindigt automatisch op de vertrekdag na het uitchecken.', 'Dostęp kończy się automatycznie w dniu wyjazdu po wymeldowaniu.'],
        'Sie werden verbunden …': ['Connecting you …', 'U wordt verbonden …', 'Łączenie …'],
        'Das dauert meist nur ein paar Sekunden.': ['This usually takes just a few seconds.', 'Dit duurt meestal maar een paar seconden.', 'Zwykle trwa to tylko kilka sekund.'],
        'Der Router übernimmt die Anmeldung, einen Moment noch …': ['The router is completing the login, just a moment …', 'De router rondt de aanmelding af, nog even …', 'Router kończy logowanie, jeszcze chwila …'],
        'Der WLAN-Router antwortet gerade nicht. Bitte versuchen Sie es in ein paar Minuten noch einmal oder rufen Sie uns an.': ['The Wi-Fi router is not responding right now. Please try again in a few minutes or call us.', 'De wifi-router reageert momenteel niet. Probeer het over een paar minuten opnieuw of bel ons.', 'Router Wi-Fi chwilowo nie odpowiada. Spróbuj ponownie za kilka minut lub zadzwoń do nas.'],
        'Die Anmeldung hat zu lange gedauert. Bitte noch einmal versuchen; hilft das nicht, WLAN am Handy kurz aus- und wieder einschalten.': ['The login took too long. Please try again; if that does not help, switch Wi-Fi on your phone off and on again.', 'Het aanmelden duurde te lang. Probeer het opnieuw; helpt dat niet, zet de wifi op uw telefoon even uit en weer aan.', 'Logowanie trwało zbyt długo. Spróbuj ponownie; jeśli to nie pomoże, wyłącz i włącz Wi-Fi w telefonie.'],
        'Gerade keine Verbindung zum Server. Bitte noch einmal versuchen.': ['No connection to the server right now. Please try again.', 'Momenteel geen verbinding met de server. Probeer het opnieuw.', 'Brak połączenia z serwerem. Spróbuj ponownie.'],
        'Willkommen zurück': ['Welcome back', 'Welkom terug', 'Witamy ponownie'],
        'Willkommen zurück, {name} …': ['Welcome back, {name} …', 'Welkom terug, {name} …', 'Witamy ponownie, {name} …'],
        'Willkommen zurück …': ['Welcome back …', 'Welkom terug …', 'Witamy ponownie …'],
        'Viel Spaß, <em>{name}</em>!': ['Enjoy, <em>{name}</em>!', 'Veel plezier, <em>{name}</em>!', 'Miłego korzystania, <em>{name}</em>!'],
        'Sie sind <em>online</em>.': ['You are <em>online</em>.', 'U bent <em>online</em>.', 'Jesteś <em>online</em>.'],
        'Gastgeber-Zugang für eine Woche.': ['Host access for one week.', 'Toegang voor de gastheer voor een week.', 'Dostęp gospodarza na tydzień.'],
        'Sie sind jetzt mit dem Internet verbunden. Hier noch das Wichtigste für Ihren Aufenthalt.': ['You are now connected to the internet. Here are the essentials for your stay.', 'U bent nu verbonden met internet. Hier nog het belangrijkste voor uw verblijf.', 'Masz już połączenie z internetem. Oto najważniejsze informacje o pobycie.'],
        'Online bis': ['Online until', 'Online tot', 'Online do'],
        'Check-out': ['Check-out', 'Uitchecken', 'Wymeldowanie'],
        'Check-in': ['Check-in', 'Inchecken', 'Zameldowanie'],
        'WhatsApp an uns': ['WhatsApp us', 'WhatsApp ons', 'Napisz na WhatsApp'],
        'Zu Meine Buchung': ['Go to My booking', 'Naar Mijn boeking', 'Do Mojej rezerwacji'],
        'Zur Webseite der Ferienwohnung': ['Apartment website', 'Naar de website van het appartement', 'Strona mieszkania'],
        'Dieses Fenster bleibt offen? Auf „Weiter ins Internet“ tippen, danach oben auf „Fertig“ (iPhone) oder zurück (Android).': ['Window still open? Tap “Continue to the internet”, then “Done” at the top (iPhone) or go back (Android).', 'Blijft dit venster open? Tik op „Verder naar internet” en daarna bovenaan op „Gereed” (iPhone) of ga terug (Android).', 'Okno się nie zamyka? Stuknij „Dalej do internetu”, potem u góry „Gotowe” (iPhone) lub cofnij (Android).'],
        'Weiter ins Internet': ['Continue to the internet', 'Verder naar internet', 'Dalej do internetu'],
        'Live-Tipps': ['Live tips', 'Live-tips', 'Na żywo'],
        'Mehr auf Meine Buchung': ['More on My booking', 'Meer op Mijn boeking', 'Więcej w Mojej rezerwacji'],
        ' in {place}': [' in {place}', ' in {place}', ' w {place}'],
        'Kurz <em>warten</em>': ['Please <em>wait</em>', 'Even <em>wachten</em>', 'Chwilę <em>poczekaj</em>'],
        'Der Server ist gerade nicht erreichbar. Bitte laden Sie die Seite in einer Minute neu.': ['The server cannot be reached right now. Please reload the page in a minute.', 'De server is momenteel niet bereikbaar. Laad de pagina over een minuut opnieuw.', 'Serwer jest chwilowo niedostępny. Odśwież stronę za minutę.'],
        'Gäste-<em>WLAN</em>': ['Guest <em>Wi-Fi</em>', 'Gasten<em>wifi</em>', '<em>Wi-Fi</em> dla gości'],
        'Diese Seite öffnet sich von selbst, wenn Sie sich mit dem WLAN <b>{ssid}</b> verbinden. Erscheint sie nicht, öffnen Sie im Browser einfach <b>http://neverssl.com</b>.': [
            'This page opens by itself when you connect to the Wi-Fi <b>{ssid}</b>. If it does not appear, simply open <b>http://neverssl.com</b> in your browser.',
            'Deze pagina opent vanzelf wanneer u verbinding maakt met de wifi <b>{ssid}</b>. Verschijnt ze niet, open dan in de browser <b>http://neverssl.com</b>.',
            'Ta strona otworzy się sama po połączeniu z Wi-Fi <b>{ssid}</b>. Jeśli się nie pojawi, otwórz w przeglądarce <b>http://neverssl.com</b>.'],
        'Gerade <em>ausgeschaltet</em>': ['Switched <em>off</em>', 'Momenteel <em>uitgeschakeld</em>', 'Chwilowo <em>wyłączone</em>'],
        'Die WLAN-Anmeldung ist im Moment nicht aktiv. Bitte melden Sie sich bei uns.': ['The Wi-Fi login is not active at the moment. Please get in touch with us.', 'De wifi-aanmelding is momenteel niet actief. Neem contact met ons op.', 'Logowanie do Wi-Fi jest chwilowo nieaktywne. Prosimy o kontakt.'],
        'Fragen oder kein Code zur Hand? Rufen Sie uns an:': ['Questions or no code at hand? Call us:', 'Vragen of geen code bij de hand? Bel ons:', 'Pytania lub brak kodu? Zadzwoń:'],
        'Bitte den Zugangscode eingeben.': ['Please enter the access code.', 'Voer de toegangscode in.', 'Wpisz kod dostępu.'],
        'Dieser Code passt leider nicht. Sie finden ihn auf „Meine Buchung“, in Ihrer Anreise-Nachricht und auf dem Fernseher.': ['Sorry, this code does not match. You will find it on “My booking”, in your arrival message and on the TV.', 'Deze code klopt helaas niet. U vindt hem op „Mijn boeking”, in uw aankomstbericht en op de tv.', 'Niestety ten kod jest nieprawidłowy. Znajdziesz go w „Mojej rezerwacji”, w wiadomości przed przyjazdem i na telewizorze.'],
        'Ihr Zugangscode gilt ab dem Anreisetag, {d}.': ['Your access code works from your arrival day, {d}.', 'Uw toegangscode geldt vanaf de aankomstdag, {d}.', 'Kod dostępu działa od dnia przyjazdu, {d}.'],
        'Ihr Aufenthalt ist beendet, der Zugangscode gilt nicht mehr. Vielen Dank für Ihren Besuch!': ['Your stay has ended, the access code no longer works. Thank you for staying with us!', 'Uw verblijf is afgelopen, de toegangscode geldt niet meer. Hartelijk dank voor uw bezoek!', 'Pobyt się zakończył, kod dostępu już nie działa. Dziękujemy za wizytę!'],
        'Mit diesem Code sind schon {n} Geräte angemeldet (höchstens {max}). Bitte melden Sie sich bei uns, dann schalten wir ein weiteres frei.': ['{n} devices are already logged in with this code (maximum {max}). Please contact us and we will enable another one.', 'Met deze code zijn al {n} apparaten aangemeld (maximaal {max}). Neem contact met ons op, dan geven we er nog een vrij.', 'Tym kodem zalogowano już {n} urządzeń (maksymalnie {max}). Skontaktuj się z nami, a odblokujemy kolejne.'],
        'Zu viele falsche Versuche. Bitte warten Sie 15 Minuten oder rufen Sie uns an.': ['Too many wrong attempts. Please wait 15 minutes or call us.', 'Te veel foute pogingen. Wacht 15 minuten of bel ons.', 'Zbyt wiele błędnych prób. Odczekaj 15 minut lub zadzwoń do nas.'],
        'Die WLAN-Anmeldung ist gerade ausgeschaltet. Bitte melden Sie sich bei uns.': ['The Wi-Fi login is switched off right now. Please get in touch with us.', 'De wifi-aanmelding is momenteel uitgeschakeld. Neem contact met ons op.', 'Logowanie do Wi-Fi jest chwilowo wyłączone. Prosimy o kontakt.'],
        'Diese Seite muss über das WLAN geöffnet werden. Bitte die WLAN-Verbindung kurz trennen und neu verbinden.': ['This page must be opened via the Wi-Fi. Please disconnect from the Wi-Fi briefly and reconnect.', 'Deze pagina moet via de wifi worden geopend. Verbreek de wifi-verbinding even en maak opnieuw verbinding.', 'Tę stronę trzeba otworzyć przez Wi-Fi. Rozłącz się na chwilę z Wi-Fi i połącz ponownie.'],

        // ---- Notfall-Öffnen ----
        'Notfall-Zugang': ['Emergency access', 'Noodtoegang', 'Dostęp awaryjny'],
        'Angemeldet mit Buchung {code}': ['Logged in with booking {code}', 'Ingelogd met boeking {code}', 'Zalogowano rezerwacją {code}'],
        'Das Öffnen über die Webseite ist gerade nicht freigeschaltet. Bitte rufen Sie uns an.': ['Opening via the website is not enabled right now. Please call us.', 'Openen via de website is momenteel niet ingeschakeld. Bel ons.', 'Otwieranie przez stronę jest chwilowo wyłączone. Zadzwoń do nas.'],
        'Bitte scannen Sie den QR-Code an der Tür noch einmal mit der Handy-Kamera.': ['Please scan the QR code on the door again with your phone camera.', 'Scan de QR-code op de deur nogmaals met de camera van uw telefoon.', 'Zeskanuj ponownie kod QR na drzwiach aparatem telefonu.'],
        'Ihr Aufenthalt ist beendet. Das Öffnen ist nicht mehr möglich.': ['Your stay has ended. Opening is no longer possible.', 'Uw verblijf is afgelopen. Openen is niet meer mogelijk.', 'Pobyt się zakończył. Otwieranie nie jest już możliwe.'],
        'Die Tür wurde in der letzten Stunde schon mehrfach geöffnet. Bitte rufen Sie uns an.': ['The door has already been opened several times in the last hour. Please call us.', 'De deur is het afgelopen uur al meerdere keren geopend. Bel ons.', 'Drzwi otwierano już kilka razy w ostatniej godzinie. Zadzwoń do nas.'],
        'Gerade nicht erreichbar. Bitte rufen Sie uns an.': ['Not reachable right now. Please call us.', 'Momenteel niet bereikbaar. Bel ons.', 'Chwilowo niedostępne. Zadzwoń do nas.'],
        'Das Öffnen ist ab Ihrem Anreisetag zur Check-in-Zeit möglich:': ['Opening is possible from check-in time on your arrival day:', 'Openen is mogelijk vanaf de incheck-tijd op uw aankomstdag:', 'Otwieranie będzie możliwe od godziny zameldowania w dniu przyjazdu:'],
        'Ist das Tastenfeld an der Tür ausgefallen? Dann können Sie die Tür hier öffnen.': ['Has the keypad on the door stopped working? Then you can open the door here.', 'Werkt het toetsenbord op de deur niet? Dan kunt u de deur hier openen.', 'Klawiatura przy drzwiach nie działa? Możesz otworzyć drzwi tutaj.'],
        'Tür wirklich öffnen?': ['Really open the door?', 'Deur echt openen?', 'Na pewno otworzyć drzwi?'],
        'Stellen Sie sich direkt vor die Tür. Sie springt nach wenigen Sekunden auf.': ['Stand right in front of the door. It will open after a few seconds.', 'Ga direct voor de deur staan. Ze springt na enkele seconden open.', 'Stań tuż przy drzwiach. Otworzą się po kilku sekundach.'],
        'Ja, jetzt öffnen': ['Yes, open now', 'Ja, nu openen', 'Tak, otwórz teraz'],
        'Die Tür wird geöffnet …': ['Opening the door …', 'De deur wordt geopend …', 'Otwieranie drzwi …'],
        'Die Tür wird jetzt geöffnet. Drücken Sie gegen die Tür. Falls sie nicht aufgeht, warten Sie bitte eine Minute und versuchen es erneut.': ['The door is opening now. Push the door. If it does not open, please wait a minute and try again.', 'De deur gaat nu open. Duw tegen de deur. Gaat ze niet open, wacht dan een minuut en probeer het opnieuw.', 'Drzwi się teraz otwierają. Pchnij drzwi. Jeśli się nie otworzą, odczekaj minutę i spróbuj ponownie.'],
        'Zurück': ['Back', 'Terug', 'Wstecz'],
        'Das hat nicht geklappt. Bitte rufen Sie uns an.': ['That did not work. Please call us.', 'Dat is niet gelukt. Bel ons.', 'Nie udało się. Zadzwoń do nas.'],
        'Das Schloss hat nicht reagiert. Bitte rufen Sie uns an.': ['The lock did not respond. Please call us.', 'Het slot reageerde niet. Bel ons.', 'Zamek nie zareagował. Zadzwoń do nas.'],
        'Probleme? Rufen Sie uns an:': ['Problems? Call us:', 'Problemen? Bel ons:', 'Problemy? Zadzwoń:'],

        // ---- TV ----
        'Liebe Gäste': ['Dear guests', 'Beste gasten', 'Drodzy goście'],
        'Wir wünschen Ihnen einen angenehmen Aufenthalt!': ['We wish you a pleasant stay!', 'We wensen u een aangenaam verblijf!', 'Życzymy miłego pobytu!'],
        'Passwort: {p}': ['Password: {p}', 'Wachtwoord: {p}', 'Hasło: {p}'],
        'Zugangscode: {c}': ['Access code: {c}', 'Toegangscode: {c}', 'Kod dostępu: {c}'],
        'ohne Passwort': ['no password', 'zonder wachtwoord', 'bez hasła'],
        'Zugangsdaten in Ihrer Buchung': ['Login details in your booking', 'Inloggegevens in uw boeking', 'Dane dostępu w Twojej rezerwacji'],
        'QR-Code scannen zum Verbinden': ['Scan the QR code to connect', 'Scan de QR-code om te verbinden', 'Zeskanuj kod QR, aby się połączyć'],
        'ab {t} Uhr': ['from {t}', 'vanaf {t} uur', 'od godz. {t}'],
        'bis {t} Uhr': ['by {t}', 'tot {t} uur', 'do godz. {t}'],
        'Für Ihren Aufenthalt': ['For your stay', 'Voor uw verblijf', 'Na pobyt'],
        'Fernsehen schauen': ['Watch TV', 'Televisie kijken', 'Oglądaj telewizję'],
        'Vor-Ort-Informationen': ['Local information', 'Lokale informatie', 'Informacje lokalne'],
        'bis {d}': ['until {d}', 'tot {d}', 'do {d}']
    };

    // ---------------------------------------------------------------------------------------------
    let lang = 'de';
    const fill = (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m)) : s);

    function T(s, v) {
        const tr = lang !== 'de' && D[s] ? D[s][IDX[lang]] : null;
        return fill(tr == null || tr === undefined ? s : tr, v);
    }

    // Server texts: exact entry or one with placeholders ("Geöffnet bis 20:00" -> "Open until 20:00")
    let patterns = null;
    const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    function TX(s) {
        if (s == null || lang === 'de') return s;
        const str = String(s);
        if (D[str]) return T(str);
        if (!patterns) {
            patterns = Object.keys(D).filter(k => /\{\w+\}/.test(k) && !/^\{\w+\}$/.test(k)).map(k => {
                const names = [];
                const re = new RegExp('^' + k.split(/(\{\w+\})/).map(part => {
                    const m = /^\{(\w+)\}$/.exec(part);
                    if (m) { names.push(m[1]); return '(.+?)'; }
                    return reEsc(part);
                }).join('') + '$');
                return { k, re, names };
            });
        }
        for (const p of patterns) {
            const m = p.re.exec(str);
            if (m) {
                const v = {};
                p.names.forEach((n, i) => { v[n] = TX(m[i + 1]); });
                return T(p.k, v);
            }
        }
        return str;
    }

    const locale = () => LANGS[lang].locale;
    const supported = l => Object.prototype.hasOwnProperty.call(LANGS, l);

    function browserLang() {
        const list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'de']);
        for (const l of list) {
            const s = String(l || '').slice(0, 2).toLowerCase();
            if (supported(s)) return s;
        }
        // Any other browser language: English is the better guess than German
        return list.length && String(list[0] || '').slice(0, 2).toLowerCase() !== 'de' ? 'en' : 'de';
    }
    function stored() { try { const s = localStorage.getItem(STORE); return supported(s) ? s : null; } catch (e) { return null; } }
    function store(l) { try { localStorage.setItem(STORE, l); } catch (e) { /* private mode */ } }

    /** Picks the language: own choice > booking > browser. Returns true when it changed. */
    function choose(bookingLang) {
        const want = stored() || (supported(bookingLang) ? bookingLang : null) || browserLang();
        const changed = want !== lang;
        lang = want;
        document.documentElement.lang = lang;
        return changed;
    }

    /** Elements with data-t: text (and data-t-attr attributes) from the German original. */
    function apply(root) {
        (root || document).querySelectorAll('[data-t]').forEach(el => {
            if (el.dataset.de == null) el.dataset.de = el.innerHTML.trim();
            el.innerHTML = T(el.dataset.de);
        });
        (root || document).querySelectorAll('[data-t-attr]').forEach(el => {
            el.dataset.tAttr.split(',').forEach(a => {
                const key = 'de' + a.replace(/[^a-z]/gi, '');
                if (el.dataset[key] == null) el.dataset[key] = el.getAttribute(a) || '';
                el.setAttribute(a, T(el.dataset[key]));
            });
        });
    }

    /** Language buttons; onChange(lang) after a click. */
    function picker(onChange, cls) {
        const wrap = document.createElement('div');
        wrap.className = 'lang-pick' + (cls ? ' ' + cls : '');
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-label', T('Sprache'));
        const draw = () => {
            wrap.setAttribute('aria-label', T('Sprache'));
            wrap.innerHTML = Object.keys(LANGS).map(l => `<button type="button" data-lang="${l}" lang="${l}" title="${LANGS[l].name}" aria-pressed="${l === lang}">${LANGS[l].short}</button>`).join('');
        };
        draw();
        wrap.addEventListener('click', e => {
            const b = e.target.closest('[data-lang]');
            if (!b || b.dataset.lang === lang) return;
            lang = b.dataset.lang;
            store(lang);
            document.documentElement.lang = lang;
            document.querySelectorAll('.lang-pick').forEach(p => p.querySelectorAll('[data-lang]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.lang === lang))));
            if (onChange) onChange(lang);
        });
        wrap.redraw = draw;
        return wrap;
    }

    // Start with the own choice or the browser language (the booking may change it after login)
    choose(null);

    window.GI18N = {
        T, TX, apply, picker, choose, locale, LANGS, supported,
        get lang() { return lang; },
        set lang(l) { if (supported(l)) { lang = l; document.documentElement.lang = l; } },
        hasOwnChoice: () => !!stored(),
        _dict: D
    };
})();
