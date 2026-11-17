'use strict';

/**
 * Anschrift aus unformatiertem Text erkennen
 *
 * Für Text, der irgendwo herauskopiert und unverändert in Telegram eingefügt wird
 * (Booking.com-Extranet, Airbnb, E-Mail, Visitenkarte, eine Zeile mit Kommas …).
 * Erkennt Name, Firma, Straße + Hausnummer, Adresszusatz, PLZ, Ort, Land, Telefon und E-Mail,
 * mit oder ohne Beschriftungen („PLZ: 12345“, „Phone“ in einer eigenen Zeile …),
 * für deutsche und gängige ausländische Formate (AT, CH, NL, BE, PL, CZ, GB, US, FR …).
 *
 * parseAddress(text) liefert ein Objekt mit den einzelnen Feldern und `address`, der Anschrift im
 * Format, das die App überall nutzt (wie der Online-Meldeschein):
 *   Straße Nr.
 *   [Zusatz]
 *   PLZ Ort
 *   [Land, nur wenn nicht Deutschland]
 */

// [Anzeigename, ISO-Code, Telefon-Vorwahl, Schreibweisen]
const COUNTRIES = [
    ['Deutschland', 'DE', '49', ['deutschland', 'germany', 'allemagne', 'duitsland', 'niemcy', 'germania', 'alemania', 'brd', 'de', 'deu', 'ger', 'bundesrepublik deutschland', 'federal republic of germany']],
    ['Österreich', 'AT', '43', ['österreich', 'oesterreich', 'austria', 'autriche', 'oostenrijk', 'at', 'aut']],
    ['Schweiz', 'CH', '41', ['schweiz', 'switzerland', 'suisse', 'svizzera', 'zwitserland', 'szwajcaria', 'ch', 'che']],
    ['Niederlande', 'NL', '31', ['niederlande', 'netherlands', 'the netherlands', 'nederland', 'holland', 'pays-bas', 'holandia', 'nl', 'nld']],
    ['Belgien', 'BE', '32', ['belgien', 'belgium', 'belgië', 'belgie', 'belgique', 'belgia', 'be', 'bel']],
    ['Luxemburg', 'LU', '352', ['luxemburg', 'luxembourg', 'lu', 'lux']],
    ['Frankreich', 'FR', '33', ['frankreich', 'france', 'frankrijk', 'francja', 'fr', 'fra']],
    ['Dänemark', 'DK', '45', ['dänemark', 'daenemark', 'denmark', 'danmark', 'dk', 'dnk']],
    ['Polen', 'PL', '48', ['polen', 'poland', 'polska', 'pologne', 'pl', 'pol']],
    ['Tschechien', 'CZ', '420', ['tschechien', 'czech republic', 'czechia', 'česko', 'cesko', 'česká republika', 'tschechische republik', 'cz', 'cze']],
    ['Slowakei', 'SK', '421', ['slowakei', 'slovakia', 'slovensko', 'sk', 'svk']],
    ['Italien', 'IT', '39', ['italien', 'italy', 'italia', 'italie', 'it', 'ita']],
    ['Spanien', 'ES', '34', ['spanien', 'spain', 'españa', 'espana', 'espagne', 'es', 'esp']],
    ['Portugal', 'PT', '351', ['portugal', 'pt', 'prt']],
    ['Vereinigtes Königreich', 'GB', '44', ['vereinigtes königreich', 'united kingdom', 'uk', 'u.k.', 'great britain', 'england', 'scotland', 'wales', 'northern ireland', 'großbritannien', 'grossbritannien', 'gb', 'gbr']],
    ['Irland', 'IE', '353', ['irland', 'ireland', 'ie', 'irl']],
    ['USA', 'US', '1', ['usa', 'u.s.a.', 'united states', 'united states of america', 'vereinigte staaten', 'us', 'u.s.']],
    ['Kanada', 'CA', '1', ['kanada', 'canada', 'ca', 'can']],
    ['Schweden', 'SE', '46', ['schweden', 'sweden', 'sverige', 'se', 'swe']],
    ['Norwegen', 'NO', '47', ['norwegen', 'norway', 'norge', 'no', 'nor']],
    ['Finnland', 'FI', '358', ['finnland', 'finland', 'suomi', 'fi', 'fin']],
    ['Ungarn', 'HU', '36', ['ungarn', 'hungary', 'magyarország', 'magyarorszag', 'hu', 'hun']],
    ['Slowenien', 'SI', '386', ['slowenien', 'slovenia', 'slovenija', 'si', 'svn']],
    ['Kroatien', 'HR', '385', ['kroatien', 'croatia', 'hrvatska', 'hr', 'hrv']],
    ['Rumänien', 'RO', '40', ['rumänien', 'rumaenien', 'romania', 'românia', 'ro', 'rou']],
    ['Bulgarien', 'BG', '359', ['bulgarien', 'bulgaria', 'bg', 'bgr']],
    ['Griechenland', 'GR', '30', ['griechenland', 'greece', 'gr', 'grc']],
    ['Türkei', 'TR', '90', ['türkei', 'tuerkei', 'turkey', 'türkiye', 'turkiye', 'tr', 'tur']],
    ['Ukraine', 'UA', '380', ['ukraine', 'україна', 'ua', 'ukr']],
    ['Litauen', 'LT', '370', ['litauen', 'lithuania', 'lietuva', 'lt', 'ltu']],
    ['Lettland', 'LV', '371', ['lettland', 'latvia', 'latvija', 'lv', 'lva']],
    ['Estland', 'EE', '372', ['estland', 'estonia', 'eesti', 'ee', 'est']],
    ['Liechtenstein', 'LI', '423', ['liechtenstein', 'li', 'lie']],
    ['Australien', 'AU', '61', ['australien', 'australia', 'au', 'aus']]
];

// Larger towns for postcodes that fit several countries (4 digits: AT, CH, BE, DK, LU, NO …)
const CITY_COUNTRY = {
    AT: ['wien', 'vienna', 'graz', 'linz', 'salzburg', 'innsbruck', 'klagenfurt', 'villach', 'wels', 'sankt pölten', 'st. pölten', 'dornbirn', 'wiener neustadt', 'steyr', 'feldkirch', 'bregenz', 'leoben', 'krems', 'baden', 'wolfsberg', 'leonding', 'traun', 'amstetten', 'kufstein', 'lustenau', 'mödling', 'hallein', 'braunau', 'schwechat', 'spittal', 'saalfelden', 'ansfelden', 'tulln', 'hohenems', 'ternitz', 'perchtoldsdorf', 'eisenstadt', 'kitzbühel', 'zell am see', 'bad ischl', 'gmunden', 'vöcklabruck', 'ried im innkreis', 'lienz', 'bludenz', 'telfs', 'schwaz', 'hall in tirol'],
    CH: ['zürich', 'zuerich', 'zurich', 'genf', 'genève', 'geneve', 'geneva', 'basel', 'bern', 'lausanne', 'winterthur', 'luzern', 'lucerne', 'st. gallen', 'sankt gallen', 'lugano', 'biel', 'bienne', 'thun', 'köniz', 'la chaux-de-fonds', 'fribourg', 'freiburg im üechtland', 'schaffhausen', 'chur', 'vernier', 'neuchâtel', 'neuenburg', 'uster', 'sion', 'emmen', 'zug', 'yverdon-les-bains', 'kriens', 'rapperswil', 'dübendorf', 'dietikon', 'montreux', 'frauenfeld', 'wetzikon', 'baar', 'aarau', 'riehen', 'wädenswil', 'allschwil', 'renens', 'kreuzlingen', 'olten', 'solothurn', 'bellinzona', 'locarno', 'davos', 'st. moritz', 'interlaken', 'zermatt', 'baden ag', 'wil', 'horgen'],
    BE: ['brüssel', 'bruessel', 'brussels', 'bruxelles', 'brussel', 'antwerpen', 'antwerp', 'anvers', 'gent', 'ghent', 'gand', 'charleroi', 'lüttich', 'liège', 'liege', 'luik', 'brügge', 'brugge', 'bruges', 'namur', 'namen', 'leuven', 'löwen', 'louvain', 'mons', 'bergen', 'aalst', 'mechelen', 'kortrijk', 'hasselt', 'ostende', 'oostende', 'eupen', 'sankt vith', 'st. vith', 'genk', 'sint-niklaas', 'tournai', 'doornik', 'verviers', 'arlon'],
    DK: ['kopenhagen', 'copenhagen', 'københavn', 'kobenhavn', 'aarhus', 'århus', 'odense', 'aalborg', 'ålborg', 'esbjerg', 'randers', 'kolding', 'horsens', 'vejle', 'roskilde', 'herning', 'silkeborg', 'næstved', 'fredericia', 'viborg', 'køge', 'holstebro', 'taastrup', 'slagelse', 'hillerød', 'sønderborg', 'svendborg', 'hjørring', 'frederikshavn', 'nyborg', 'tønder', 'aabenraa', 'haderslev', 'ribe', 'skagen', 'billund'],
    LU: ['luxemburg', 'luxembourg', 'esch-sur-alzette', 'esch an der alzette', 'differdange', 'dudelange', 'ettelbruck', 'diekirch', 'wiltz', 'echternach', 'remich', 'grevenmacher', 'mersch', 'vianden', 'clervaux', 'strassen', 'bertrange', 'mamer'],
    NO: ['oslo', 'bergen norway', 'trondheim', 'stavanger', 'drammen', 'fredrikstad', 'kristiansand', 'sandnes', 'tromsø', 'tromso', 'sarpsborg', 'skien', 'ålesund', 'alesund', 'sandefjord', 'haugesund', 'tønsberg', 'moss', 'bodø', 'bodo', 'arendal', 'hamar', 'larvik', 'halden', 'lillehammer'],
    HU: ['budapest', 'debrecen', 'szeged', 'miskolc', 'pécs', 'pecs', 'győr', 'gyor', 'nyíregyháza', 'kecskemét', 'székesfehérvár', 'sopron', 'eger', 'szombathely', 'veszprém', 'siófok'],
    SI: ['ljubljana', 'laibach', 'maribor', 'celje', 'kranj', 'koper', 'velenje', 'novo mesto', 'ptuj', 'bled', 'piran'],
    AU: ['sydney', 'melbourne', 'brisbane', 'perth', 'adelaide', 'canberra', 'hobart', 'darwin', 'gold coast'],
    NL: ['amsterdam', 'rotterdam', 'den haag', "'s-gravenhage", 'the hague', 'utrecht', 'eindhoven', 'groningen', 'tilburg', 'almere', 'breda', 'nijmegen', 'enschede', 'apeldoorn', 'haarlem', 'arnhem', 'zaandam', 'amersfoort', 'maastricht', 'leiden', 'dordrecht', 'zwolle', 'venlo', 'heerlen', 'kerkrade', 'roermond', 'delft', 'alkmaar', 'deventer', 'hilversum', 'zandvoort', 'den bosch', "'s-hertogenbosch", 'emmen', 'leeuwarden', 'assen'],
    PL: ['warschau', 'warszawa', 'warsaw', 'krakau', 'kraków', 'krakow', 'breslau', 'wrocław', 'wroclaw', 'posen', 'poznań', 'poznan', 'danzig', 'gdańsk', 'gdansk', 'stettin', 'szczecin', 'łódź', 'lodz', 'kattowitz', 'katowice', 'lublin', 'bydgoszcz', 'białystok', 'gdynia', 'gleiwitz', 'gliwice', 'zielona góra', 'görlitz polen', 'słubice', 'opole', 'oppeln', 'olsztyn', 'rzeszów', 'toruń', 'kielce', 'sopot', 'zakopane'],
    CZ: ['prag', 'praha', 'prague', 'brünn', 'brno', 'ostrau', 'ostrava', 'pilsen', 'plzeň', 'plzen', 'reichenberg', 'liberec', 'olmütz', 'olomouc', 'aussig', 'ústí nad labem', 'budweis', 'české budějovice', 'karlsbad', 'karlovy vary', 'eger tschechien', 'cheb', 'marienbad', 'mariánské lázně', 'teplitz', 'teplice', 'hradec králové', 'pardubice', 'zlín', 'jihlava'],
    FR: ['paris', 'marseille', 'lyon', 'toulouse', 'nizza', 'nice', 'nantes', 'straßburg', 'strasbourg', 'montpellier', 'bordeaux', 'lille', 'rennes', 'reims', 'metz', 'mulhouse', 'colmar', 'nancy', 'dijon', 'grenoble', 'le havre', 'toulon', 'saint-étienne', 'brest', 'annecy', 'cannes', 'avignon'],
    IT: ['rom', 'roma', 'rome', 'mailand', 'milano', 'milan', 'neapel', 'napoli', 'turin', 'torino', 'florenz', 'firenze', 'venedig', 'venezia', 'bologna', 'genua', 'genova', 'verona', 'bozen', 'bolzano', 'meran', 'merano', 'trient', 'trento', 'padua', 'padova', 'palermo', 'bari', 'catania', 'triest', 'trieste', 'brixen', 'bressanone'],
    ES: ['madrid', 'barcelona', 'valencia', 'sevilla', 'saragossa', 'zaragoza', 'málaga', 'malaga', 'palma', 'palma de mallorca', 'bilbao', 'alicante', 'córdoba', 'granada', 'las palmas', 'santa cruz de tenerife', 'marbella', 'ibiza'],
    GB: ['london', 'birmingham', 'manchester', 'glasgow', 'edinburgh', 'liverpool', 'leeds', 'bristol', 'sheffield', 'cardiff', 'belfast', 'newcastle upon tyne', 'nottingham', 'leicester', 'oxford', 'cambridge', 'brighton', 'southampton', 'york', 'aberdeen'],
    SE: ['stockholm', 'göteborg', 'goteborg', 'gothenburg', 'malmö', 'malmo', 'uppsala', 'västerås', 'örebro', 'linköping', 'helsingborg', 'norrköping', 'jönköping', 'lund', 'umeå'],
    FI: ['helsinki', 'helsingfors', 'espoo', 'tampere', 'vantaa', 'oulu', 'turku', 'åbo', 'jyväskylä', 'lahti', 'kuopio'],
    US: ['new york', 'new york city', 'los angeles', 'chicago', 'houston', 'phoenix', 'philadelphia', 'san antonio', 'san diego', 'dallas', 'san francisco', 'seattle', 'boston', 'miami', 'washington', 'washington dc', 'las vegas', 'atlanta', 'denver', 'austin']
};
const COUNTRY_BY_CITY = new Map();
for (const [code, cities] of Object.entries(CITY_COUNTRY)) for (const c of cities) COUNTRY_BY_CITY.set(c, code);

const COUNTRY_BY_ALIAS = new Map();
for (const [name, code, dial, aliases] of COUNTRIES) {
    for (const a of aliases.concat([name.toLowerCase()])) COUNTRY_BY_ALIAS.set(a, { name, code, dial });
}
const COUNTRY_BY_CODE = new Map(COUNTRIES.map(([name, code, dial]) => [code, { name, code, dial }]));
// Longest dial code first, so +352 is not read as +35…
const DIAL_CODES = COUNTRIES.filter(c => c[1] !== 'CA').map(([name, code, dial]) => ({ name, code, dial }))
    .sort((a, b) => b.dial.length - a.dial.length);

// Country letters in front of a postcode ("D-12345", "CH-8001", "A 1010")
const ZIP_PREFIX = { D: 'DE', DE: 'DE', A: 'AT', AT: 'AT', CH: 'CH', NL: 'NL', B: 'BE', BE: 'BE', L: 'LU', LU: 'LU', F: 'FR', FR: 'FR', DK: 'DK', PL: 'PL', CZ: 'CZ', I: 'IT', IT: 'IT', E: 'ES', ES: 'ES', FL: 'LI' };

// Beschriftungen -> Feld. "street" und "address" landen im allgemeinen Topf, weil dort oft alles in einer Zeile steht.
const LABELS = [
    ['name', /^(rechnung an|rechnungsempfänger|an|to|bill to|invoice to|name|vollständiger name|vollstaendiger name|full name|guest name|gastname|gast|guest|name des gastes|vor- ?und nachname|vorname und nachname|buchende person|gebucht von|booker|booked by|booker name|kunde|customer|ansprechpartner|contact person|rechnungsempfänger|empfänger|recipient|naam|nazwisko|imię i nazwisko)$/],
    ['firstName', /^(vorname|first name|given name|firstname|voornaam|imię|imie|prénom|prenom)$/],
    ['lastName', /^(nachname|familienname|last name|surname|family name|lastname|achternaam|nom)$/],
    ['company', /^(firma|firmenname|company|company name|unternehmen|organisation|organization|bedrijf|firma\/unternehmen)$/],
    ['address', /^(adresse|address|anschrift|postanschrift|wohnadresse|rechnungsadresse|billing address|home address|street address|straße|strasse|str|straße und hausnummer|strasse und hausnummer|straße \/ nr|street|address line 1|adresszeile 1|adres|adresa|adresse ligne 1|ulica|straat)$/],
    ['houseNumber', /^(hausnummer|hausnr|nr|nummer|house number|house no|no|huisnummer)$/],
    ['extra', /^(adresszusatz|zusatz|address line 2|adresszeile 2|address 2|apartment|wohnung|c\/o)$/],
    ['zip', /^(plz|postleitzahl|zip|zip code|zipcode|postal code|postcode|post code|postleitzahl \/ ort|code postal|kod pocztowy)$/],
    ['zipCity', /^(plz \/ ort|plz\/ort|plz und ort|plz, ort|plz ort|zip \/ city|postal code \/ city|postcode \/ city)$/],
    ['city', /^(ort|stadt|wohnort|city|town|city \/ town|plaats|woonplaats|ville|miasto|miejscowość|gemeinde)$/],
    ['state', /^(bundesland|state|province|provinz|region|county|kanton)$/],
    ['country', /^(land|country|staat|country\/region|country \/ region|land\/region|land \/ region|herkunftsland|wohnland|country of residence|pays|kraj)$/],
    ['phone', /^(telefon|telefonnummer|tel|telephone|phone|phone number|mobil|mobile|mobilnummer|mobile phone|handy|handynummer|cell|cellphone|telefoonnummer|telefoon|mobiel|telefon komórkowy|téléphone|whatsapp)$/],
    ['email', /^(e-mail|email|e-mail-adresse|email address|e-mail address|mail|e-mailadres)$/]
];
// Beschriftungen, deren Wert keine Anschrift ist (z. B. aus dem Booking.com-Extranet mitkopiert): Zeile weg
const IGNORE_LABEL = /^(gesamtzahl der gäste|anzahl gäste|number of guests|total guests|zeitraum|bezahlt via|bezahlt|betrag|summe|rechnungsnummer|rechnungsdatum|leistungszeitraum|erwachsener?|erwachsene|adult|kind|kinder|child|babys?|haustiere?|pets?|bevorzugte sprache|preferred language|sprachen?|unterkunft|property|objekt|zimmertyp|room type|wohnungstyp|unit type|ankunftszeit|estimated arrival time|geschätzte ankunftszeit|reiseanlass|reason for travel|purpose of trip|geschäftsreise|business trip|stornierungsbedingungen|cancellation policy|bezahlung|payment method|zahlungsart|kreditkarte|credit card|genius-level|buchung über|booked via|buchungsdetails|reservation details|reservierungsdetails|gastdaten|guest details|kontaktdaten|contact details|buchungsnummer|booking number|reservation number|reservierungsnummer|bestätigungsnummer|confirmation( code| number)?|buchungscode|pin( code)?|anreise|abreise|check-?in|check-?out|ankunft|arrival|departure|aufenthalt|dauer|nächte|naechte|nights|preis|gesamtpreis|price|total|total price|betrag|provision|commission|zahlung|payment|personen|gäste|gaeste|guests|erwachsene|adults|kinder|children|zimmer|room|unit|wohneinheit|sprache|language|nationalität|nationality|staatsangehörigkeit|geburtsdatum|date of birth|ankunftszeit|arrival time|voraussichtliche ankunft|nachricht|message|anmerkung|anmerkungen|notiz|notes|remarks|bemerkung|bemerkungen|wünsche|special requests|status|quelle|source|kanal|channel|gebucht am|booked on|buchungsdatum|booking date|genius)$/;

const SALUTATION = /^(herr|frau|hr\.?|fr\.?|mr\.?|mrs\.?|ms\.?|miss|mx\.?|monsieur|madame|mme\.?|m\.|mevrouw|mevr\.?|meneer|dhr\.?|de heer|pan|pani|signor|signora|sig\.?|sig\.ra|señor|señora|sr\.?|sra\.?|herrn)\s+/i;
const COMPANY = /\b(gmbh|ag|ug|kg|ohg|gbr|e\.\s?k\.?|e\.\s?v\.?|mbh|se|ltd\.?|limited|llc|inc\.?|corp\.?|b\.\s?v\.?|bv|n\.\s?v\.?|nv|s\.a\.?|sarl|s\.a\.r\.l\.?|s\.r\.l\.?|srl|spa|s\.p\.a\.?|sp\.? z o\.?o\.?|s\.r\.o\.?|a\/s|aps|oy|ab|plc|co\.? kg|holding|group|gruppe|firma|stiftung|verein|praxis|kanzlei|hotel|consulting|services|solutions|software|systems|bank|versicherung|universität|university|institut|institute|agentur|agency|werk|werke|handel|bau)\b/i;
const EXTRA = /^(c\/o|c\/o\.|z\.?\s?hd\.?|zu händen|attn\.?|apt\.?|apartment|appartement|app\.?|wohnung|whg\.?|etage|stock|stockwerk|\d+\.\s?(og|etage|stock|obergeschoss)|eg|erdgeschoss|dg|dachgeschoss|haus\s+\w|gebäude|building|bldg\.?|suite|unit|flat|floor|room|zimmer|hinterhaus|vorderhaus|seitenflügel|postfach\s|po box|p\.o\. box|bus\s+\d)/i;
const STREET_WORD = /(straße|strasse|str\.|str\b|weg|allee|gasse|platz|ring|damm|ufer|chaussee|steig|pfad|stieg|markt|hof|berg|graben|kamp|wall|zeile|park|siedlung|promenade|street|st\.|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?|way|place|pl\.?|court|ct\.?|terrace|close|crescent|square|sq\.?|highway|hwy|straat|laan|plein|gracht|kade|dijk|singel|ulica|ul\.|aleja|al\.|rue|avenue|chemin|via|viale|piazza|calle|avenida|plaza|vej|gade|gatan|vägen|veien|utca)\b/i;
const ZIP_LINE_DE = /^(?:([A-Z]{1,2})\s?-\s?|([A-Z]{1,2})\s+(?=\d))?(\d{4,5})\s*,?\s+(\D.*)$/i;
const ZIP_LINE_NL = /^(\d{4})\s?([A-Z]{2})\b\s*,?\s*(\D.*)$/;
const ZIP_LINE_PL = /^(\d{2}-\d{3})\s+(\D.*)$/;
const ZIP_LINE_CZ = /^(\d{3}\s\d{2})\s+(\D.*)$/;
const ZIP_LINE_US = /^(\D+?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/;
const CITY_ZIP = /^(\D+?)\s*,?\s+(\d{4,5})$/;
const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/;
const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/i;
// Telefonnummer: optional +/00, dann Ziffern mit Leerzeichen, Bindestrichen, Schrägstrichen, Klammern, Punkten
const PHONE = /(?:\+|\b00)?\(?\d[\d\s\-/().]{5,}\d/;

const LOWER_PARTICLES = new Set(['am', 'an', 'der', 'die', 'das', 'den', 'dem', 'des', 'im', 'in', 'bei', 'ob', 'vor', 'und', 'auf', 'zu', 'zum', 'zur', 'von', 'vom', 'van', 'de', 'la', 'le', 'du', 'di', 'da', 'del', 'della', 'dos', 'aan', 'op', 'ten', 'ter', 'het', "'t", 'y', 'of', 'the', 'and', 'on', 'upon', 'nad']);

function cleanSpaces(s) {
    return String(s || '').replace(/[   \t]/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripEdges(s) {
    return cleanSpaces(s).replace(/^[\s,;|•·*\-–—>]+|[\s,;|•·*\-–—]+$/g, '').trim();
}

/** "MAX MUSTERMANN" / "max mustermann" -> "Max Mustermann"; mixed case stays as typed. */
function tidyCase(s, { particles = true } = {}) {
    const str = cleanSpaces(s);
    const letters = str.replace(/[^A-Za-zÀ-ÖØ-öø-ÿĀ-žА-я]/g, '');
    if (letters.length < 2) return str;
    const allUpper = letters === letters.toUpperCase();
    const allLower = letters === letters.toLowerCase();
    if (!allUpper && !allLower) return str;
    return str.split(' ').map((word, i) => {
        const lw = word.toLowerCase();
        if (particles && i > 0 && LOWER_PARTICLES.has(lw)) return lw;
        // Capitalize every letter group that starts the word or follows - ' / . ( (but not after digits: "12a")
        return lw.replace(/(^|[-'’/.(])([a-zà-öø-ÿā-žа-я])/g, (m, pre, ch) => pre + ch.toUpperCase());
    }).join(' ');
}

function countryFromText(s) {
    const key = cleanSpaces(s).toLowerCase().replace(/[()]/g, '').replace(/\.$/, '');
    if (!key) return null;
    return COUNTRY_BY_ALIAS.get(key) || COUNTRY_BY_ALIAS.get(key.replace(/\./g, '')) || null;
}

function countryFromPhone(phone) {
    const m = String(phone || '').replace(/[^\d+]/g, '').match(/^\+(\d+)/);
    if (!m) return null;
    const hit = DIAL_CODES.find(c => m[1].startsWith(c.dial));
    return hit || null;
}

function normalizePhone(raw) {
    let p = cleanSpaces(raw).replace(/^[^\d+(]+/, '');
    p = p.replace(/^00(?=[1-9])/, '+');
    p = p.replace(/^(\+\d{1,3})\s*\(0\)\s*/, '$1 ');   // +49 (0) 170 -> +49 170
    p = p.replace(/[^\d+\s\-/().]/g, '').replace(/\s*([-/])\s*/g, '$1').replace(/\s+/g, ' ').trim();
    const digits = p.replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 16) return '';
    return p;
}

function isPhoneLike(s) {
    const m = String(s).match(PHONE);
    if (!m || /\d{1,2}\.\d{1,2}\./.test(m[0])) return null;
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 16) return null;
    // Postcode + city or street with a number are not phone numbers
    const rest = String(s).replace(m[0], '').replace(/^(tel\.?|telefon|phone|mobil|mobile|handy|fon|cell|whatsapp|t)\s*[:.]?/i, '').trim();
    if (/[A-Za-zÀ-ÿ]{3,}/.test(rest)) return null;
    return m[0];
}

// "Musterstr.12" -> "Musterstr. 12", "Nr. 12" -> "12", "12 a" -> "12a"
function normalizeStreetText(s) {
    return cleanSpaces(s)
        .replace(/([a-zäöüß])\.(\d)/gi, '$1. $2')
        .replace(/\b(nr|no|nummer|hausnummer)\.?\s*(?=\d)/gi, '')
        .replace(/(\d)\s+([a-z])\b(?![a-zäöüß.])/gi, '$1$2')
        .replace(/\s*,\s*$/, '');
}

const NUM = String.raw`\d+\s*[a-z]?(?:\s*[-/]\s*\d+\s*[a-z]?)?`;
const STREET_NUMBER_LAST = new RegExp(String.raw`^(.*[A-Za-zÀ-ÿ.'’)]{2,}.*?)\s*,?\s+(${NUM})$`, 'i');
const STREET_NUMBER_FIRST = new RegExp(String.raw`^(${NUM})\s*,?\s+(.*[A-Za-zÀ-ÿ]{2,}.*)$`, 'i');

/** Splits a street line into street + house number, or returns null when it does not look like one. */
function parseStreet(token, { requireNumber = true } = {}) {
    const s = normalizeStreetText(token);
    let m = s.match(STREET_NUMBER_LAST);
    if (m && !/\d{4,}\s*$/.test(m[2]) || (m && STREET_WORD.test(m[1]))) {
        return { street: tidyCase(m[1].replace(/[,\s]+$/, '')), houseNumber: m[2].replace(/\s+/g, ''), numberFirst: false };
    }
    m = s.match(STREET_NUMBER_FIRST);
    if (m && (STREET_WORD.test(m[2]) || m[1].replace(/\D/g, '').length <= 3)) {
        return { street: tidyCase(m[2]), houseNumber: m[1].replace(/\s+/g, ''), numberFirst: true };
    }
    if (!requireNumber && STREET_WORD.test(s) && !/\d/.test(s)) return { street: tidyCase(s), houseNumber: '', numberFirst: false };
    return null;
}

/** Postcode + city in one token, or null. */
function parseZipCity(token) {
    const s = cleanSpaces(token);
    let m = s.match(ZIP_LINE_NL);
    if (m) return { zip: `${m[1]} ${m[2]}`, city: m[3], hint: 'NL' };
    m = s.match(ZIP_LINE_PL);
    if (m) return { zip: m[1], city: m[2], hint: 'PL' };
    m = s.match(ZIP_LINE_CZ);
    if (m) return { zip: m[1], city: m[2], hint: 'CZ' };
    m = s.match(ZIP_LINE_US);
    if (m && !STREET_WORD.test(m[1])) return { zip: m[3], city: m[1], state: m[2], hint: 'US' };
    m = s.match(ZIP_LINE_DE);
    if (m) {
        const prefix = (m[1] || m[2] || '').toUpperCase();
        if (prefix && !ZIP_PREFIX[prefix]) return null;
        const city = m[4];
        // "1600 Pennsylvania Avenue" is a street, not a postcode
        if (STREET_WORD.test(city) && city.split(' ').length > 1 && !/\b(am|an der|ob der|im|in der|bei)\b/i.test(city)) return null;
        return { zip: m[3], city, hint: prefix ? ZIP_PREFIX[prefix] : (m[3].length === 5 ? null : null) };
    }
    m = s.match(UK_POSTCODE);
    if (m) {
        const city = stripEdges(s.replace(m[0], ''));
        if (!/\d/.test(city)) return { zip: m[1].replace(/\s+/, ' ').replace(/^(\S+?)(\d[A-Z]{2})$/, '$1 $2'), city, hint: 'GB' };
    }
    m = s.match(CITY_ZIP);
    if (m && !STREET_WORD.test(m[1])) return { zip: m[2], city: m[1], hint: null };
    return null;
}

const ZIP_FORMATS = {
    DE: /^\d{5}$/, AT: /^\d{4}$/, CH: /^\d{4}$/, LI: /^\d{4}$/, BE: /^\d{4}$/, LU: /^\d{4}$/, DK: /^\d{4}$/, NO: /^\d{4}$/,
    HU: /^\d{4}$/, SI: /^\d{4}$/, AU: /^\d{4}$/, BG: /^\d{4}$/, NL: /^\d{4} ?[A-Z]{2}$/, PL: /^\d{2}-\d{3}$/,
    CZ: /^\d{3} ?\d{2}$/, SK: /^\d{3} ?\d{2}$/, SE: /^\d{3} ?\d{2}$/, GR: /^\d{3} ?\d{2}$/, FR: /^\d{5}$/, IT: /^\d{5}$/,
    ES: /^\d{5}$/, FI: /^\d{5}$/, HR: /^\d{5}$/, TR: /^\d{5}$/, UA: /^\d{5}$/, LT: /^(LT-)?\d{5}$/, EE: /^\d{5}$/,
    US: /^\d{5}(-\d{4})?$/, PT: /^\d{4}(-\d{3})?$/, RO: /^\d{6}$/, LV: /^(LV-)?\d{4}$/, IE: /^[A-Z0-9]{3} ?[A-Z0-9]{4}$/
};
const ZIP_FORMAT_OK = (code, zip) => !ZIP_FORMATS[code] || ZIP_FORMATS[code].test(zip);
// Words that turned up as "street" in pasted portal texts
const COUNT_STREET = /^(erwachsene[rn]?|adults?|kinder|personen|gäste|guests?|nächte|nights?)$/i;

function looksLikeName(s) {
    const t = cleanSpaces(s);
    if (!t || /\d/.test(t) || t.length > 60) return false;
    const words = t.split(' ');
    return words.length >= 1 && words.length <= 6 && /^[A-Za-zÀ-ÖØ-öø-ÿĀ-žА-я.'’\- ]+$/.test(t);
}

function cleanName(s) {
    let n = stripEdges(s).replace(SALUTATION, '').trim();
    // "Mustermann, Max" -> "Max Mustermann"
    const comma = n.match(/^([^,\d]+),\s*([^,\d]+)$/);
    if (comma && comma[1].trim().split(' ').length <= 2 && comma[2].trim().split(' ').length <= 2) n = `${comma[2].trim()} ${comma[1].trim()}`;
    return tidyCase(n);
}

function labelOf(line) {
    // "Label: Wert" / "Label - Wert" / "Label<Tab>Wert"
    const m = line.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .\-/&()0-9]{0,40}?)\s*(?::|\t|\s[-–]\s)\s*(.*)$/);
    const tryLabel = (raw) => {
        const key = cleanSpaces(raw).toLowerCase().replace(/[*.]+$/, '').replace(/\s*\(.*?\)\s*$/, '').trim();
        if (IGNORE_LABEL.test(key)) return 'ignore';
        const hit = LABELS.find(([, re]) => re.test(key));
        return hit ? hit[0] : null;
    };
    if (m) {
        const field = tryLabel(m[1]);
        // "12:30" or "Hauptstr. 1 - 3": not a label
        if (field) return { field, value: m[2].trim() };
        if (line.includes(':') && /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-/]*( [A-Za-zÀ-ÿ\-/]+){0,2}$/.test(m[1].trim()) && m[2].trim()
            && !/^(c\/o|z\.?\s?hd)/i.test(m[1].trim())) return { field: 'ignore', value: m[2].trim() };
    }
    // Label on its own line ("Telefon"), the value follows in the next line
    const alone = tryLabel(line.replace(/:$/, ''));
    if (alone && line.length <= 40) return { field: alone, value: '', alone: true };
    return null;
}

/**
 * @param {string} text  unformatierte Anschrift
 * @returns {{name, company, street, houseNumber, extra, zip, city, state, country, countryCode,
 *            phone, email, address, unknown: string[], found: number}}
 */
function parseAddress(text) {
    const r = { name: '', company: '', street: '', houseNumber: '', extra: '', zip: '', city: '', state: '', country: '', countryCode: '', phone: '', email: '', unknown: [] };
    const raw = String(text || '').replace(/\r/g, '').replace(/^\/?(adresse|anschrift|address)(@\w+)?\b[:\s-]*/i, '');
    let lines = raw.split('\n').map(cleanSpaces).filter(Boolean);

    const pool = [];        // unlabeled tokens, in order
    let first = '', last = '', streetLabeled = '', numberLabeled = '';
    let countryHint = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lab = labelOf(line);
        if (!lab) { pool.push(line); continue; }
        let value = lab.value;
        if (lab.alone) {
            const next = lines[i + 1];
            if (next !== undefined && !labelOf(next)) { value = next; i++; } else continue;
        }
        value = stripEdges(value);
        if (!value || lab.field === 'ignore') continue;
        switch (lab.field) {
            case 'name':
                // "Rechnung an: Thomas Becker, Kirchplatz 1, 48143 Münster": the whole address after the label
                if (/,/.test(value) && /\d/.test(value)) pool.push(value); else r.name = r.name || cleanName(value);
                break;
            case 'firstName': first = value; break;
            case 'lastName': last = value; break;
            case 'company': r.company = r.company || value; break;
            case 'houseNumber': numberLabeled = value; break;
            case 'extra': r.extra = r.extra || value; break;
            case 'zip': r.zip = r.zip || value.toUpperCase(); break;
            case 'city': {
                const zc = parseZipCity(value);
                if (zc && !r.zip) { r.zip = zc.zip; r.city = zc.city; countryHint = countryHint || zc.hint; } else r.city = r.city || value;
                break;
            }
            case 'zipCity': {
                const zc = parseZipCity(value);
                if (zc) { r.zip = zc.zip; r.city = zc.city; countryHint = countryHint || zc.hint; } else pool.push(value);
                break;
            }
            case 'state': r.state = r.state || value; break;
            case 'country': {
                // "ET Slowakei": a flag icon read as letters in front of the name
                const c = countryFromText(value) || countryFromText(value.replace(/^\S{1,3}\s+/, ''));
                r.country = c ? c.name : tidyCase(value); r.countryCode = c ? c.code : '';
                break;
            }
            case 'phone': r.phone = r.phone || normalizePhone(value); break;
            case 'email': { const m = value.match(EMAIL); if (m) r.email = r.email || m[0]; break; }
            case 'address': {
                // A labeled street line without house number (number labeled separately) stays a street
                const parts = value.split(/\s*[,;|]\s*/).filter(Boolean);
                if (parts.length === 1 && !/\d/.test(parts[0]) && !countryFromText(parts[0])) streetLabeled = parts[0];
                else pool.push(...parts);
                break;
            }
        }
    }
    if (!r.name && (first || last)) r.name = cleanName(`${first} ${last}`);
    if (streetLabeled) {
        const p = parseStreet(`${streetLabeled} ${numberLabeled}`.trim(), { requireNumber: false });
        if (p) Object.assign(r, { street: p.street, houseNumber: p.houseNumber });
        else r.street = tidyCase(streetLabeled);
        r._numberFirst = p ? p.numberFirst : false;
    } else if (numberLabeled) r.houseNumber = numberLabeled;

    // One line with commas ("Max Mustermann, Musterstr. 1, 12345 Berlin") -> parts.
    // Separate lines keep their commas only where a line holds street + town ("Musterstr. 1, 12345 Berlin").
    let tokens = [];
    for (const line of pool) {
        const parts = line.split(/\s*(?:[;|·•]|,(?!\s*\d+\s*[a-z]?\s*$))\s*/i).map(stripEdges).filter(Boolean);
        if (parts.length > 1 && /^[^,\d]+,\s*[^,\d]+$/.test(line) && pool.indexOf(line) === 0 && parts.every(p => p.split(' ').length <= 2) && pool.length > 1) {
            tokens.push(cleanName(line)); // "Mustermann, Max" in its own first line
        } else tokens.push(...parts);
    }
    // Everything in one line without separators: "Max Mustermann Musterstr. 1 12345 Berlin"
    if (tokens.length === 1 && !parseZipCity(tokens[0]) && !parseStreet(tokens[0])) {
        const m = tokens[0].match(/^(.*\S)\s+((?:[A-Z]{1,2}-)?\d{4,5}\s+\D+)$/);
        if (m) {
            const head = m[1];
            const words = head.split(' ');
            // Street = from the first word with a street ending (or the last word) up to the house number
            const numM = head.match(new RegExp(String.raw`\s(${NUM})$`, 'i'));
            if (numM) {
                const before = head.slice(0, head.length - numM[0].length).split(' ');
                let k = before.findIndex((w, idx) => idx > 0 && STREET_WORD.test(w));
                if (k < 0) k = before.length - 1;
                // "Am Hang 3": a lowercase/short particle in front of the street word belongs to it
                while (k > 1 && /^(am|an|im|in|auf|zum|zur|unter|ober|alte|alter|neue|neuer|hinter|vor|bei|der|die|das|den|dem)$/i.test(before[k - 1])) k--;
                const name = before.slice(0, k).join(' ');
                const street = `${before.slice(k).join(' ')} ${numM[1]}`;
                tokens = [name, street, m[2]].filter(Boolean);
            } else if (words.length > 1) tokens = [head, m[2]];
        }
    }
    // US/CA: "Washington, DC 20500" belongs together
    for (let i = tokens.length - 1; i > 0; i--) {
        if (/^[A-Z]{2}\s+\d{5}(-\d{4})?$/.test(tokens[i]) && !/\d/.test(tokens[i - 1])) tokens.splice(i - 1, 2, `${tokens[i - 1]}, ${tokens[i]}`);
    }

    // Inside a text pasted as one block (Booking.com copies): labels without colon, counts, "37 Slowakei"
    let looseNumber = '';
    {
        const out = [];
        const COUNT = /^(?:(erwachsene[rn]?|adults?|kinder|kind|children|child|babys?|nächte|naechte|nights?|personen|gäste|gaeste|guests?|zimmer|rooms?)\s*:?\s*\d+|\d+\s+(erwachsene[rn]?|adults?|kinder|kind|children|nächte|nights?|personen|gäste|guests?))$/i;
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (COUNT.test(t)) continue;
            const lab = labelOf(t);
            if (lab && lab.alone) {
                const next = tokens[i + 1];
                if (lab.field === 'ignore') { if (next !== undefined && !labelOf(next)) i++; continue; }
                if (lab.field === 'country' && next !== undefined) {
                    const m = next.match(/^(\d+[a-z]?)\s+(.+)$/i) || next.match(/^()(.+)$/);
                    const c = countryFromText(m[2]);
                    if (c && !r.country) { r.country = c.name; r.countryCode = c.code; if (m[1]) looseNumber = m[1]; i++; continue; }
                }
                continue; // other labels alone: the value follows as its own token
            }
            const num = t.match(/^(\d+[a-z]?)\s+(\D+)$/i);
            if (num && countryFromText(num[2]) && num[2].length > 3) {
                const c = countryFromText(num[2]);
                if (!r.country) { r.country = c.name; r.countryCode = c.code; }
                looseNumber = num[1];
                continue;
            }
            out.push(t);
        }
        tokens = out;
    }

    // E-mail and phone can sit anywhere, also inside a line
    tokens = tokens.map(t => {
        const mail = t.match(EMAIL);
        if (mail) {
            r.email = r.email || mail[0];
            t = stripEdges(t.replace(mail[0], '').replace(/\b(e-?mail|mail)\s*:?\s*$/i, ''));
        }
        const ph = isPhoneLike(t);
        if (ph) {
            r.phone = r.phone || normalizePhone(ph);
            t = stripEdges(t.replace(ph, '').replace(/\b(tel\.?|telefon|phone|mobil|mobile|handy|fon|cell|whatsapp)\s*[:.]?\s*$/i, '').replace(/^\+\s*$/, ''));
        }
        return t;
    }).filter(Boolean);

    // Classify
    const kinds = tokens.map(() => null);
    // Country first, wherever it stands: the postcode check below depends on it
    tokens.forEach((t, i) => {
        const c = !r.country && countryFromText(t);
        // "DE" alone is a country only near the end or after the town
        if (c && (t.length > 3 || i === tokens.length - 1)) { r.country = c.name; r.countryCode = c.code; kinds[i] = 'country'; }
    });
    tokens.forEach((t, i) => {
        if (kinds[i]) return;
        if (!r.zip) {
            const zc = parseZipCity(t);
            // "A.Hlinka 3118" with a Slovak address: street + house number, the postcode follows elsewhere
            if (zc && r.countryCode && !zc.hint && !ZIP_FORMAT_OK(r.countryCode, zc.zip) && !r.street && /^\D+\s+\d+$/.test(t)) {
                r.street = tidyCase(zc.city); r.houseNumber = zc.zip; kinds[i] = 'street'; return;
            }
            if (zc) {
                // City followed by a country in the same token ("12345 Berlin Germany")
                let city = zc.city;
                const words = city.split(' ');
                for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
                    const c = countryFromText(words.slice(-n).join(' '));
                    if (c && words.slice(-n).join(' ').length > 2) {
                        if (!r.country) { r.country = c.name; r.countryCode = c.code; }
                        city = words.slice(0, -n).join(' ');
                        break;
                    }
                }
                r.zip = zc.zip; r.city = city; if (zc.state) r.state = zc.state;
                countryHint = countryHint || zc.hint; kinds[i] = 'zip'; return;
            }
        }
        if (!r.zip && /^(?:[A-Z]{1,2}-)?\d{4,5}$/.test(t)) { r.zip = t.replace(/^[A-Z]{1,2}-/, ''); kinds[i] = 'zipOnly'; return; }
        if (!r.street) {
            const st = parseStreet(t);
            if (st) { r.street = st.street; r.houseNumber = st.houseNumber; r._numberFirst = st.numberFirst; kinds[i] = 'street'; return; }
        }
        if (EXTRA.test(t)) { kinds[i] = 'extra'; return; }
    });

    // A street without house number ("Am Marktplatz") when nothing else matched
    if (!r.street) {
        const i = tokens.findIndex((t, k) => !kinds[k] && parseStreet(t, { requireNumber: false }));
        if (i >= 0 && i > 0) {
            const st = parseStreet(tokens[i], { requireNumber: false });
            r.street = st.street; r.houseNumber = r.houseNumber || st.houseNumber; kinds[i] = 'street';
        }
    }

    // Postcode alone: the town is the next free token (or the one before)
    const zipOnly = kinds.indexOf('zipOnly');
    if (zipOnly >= 0 && !r.city) {
        let j = zipOnly + 1;
        if (!(j < tokens.length && !kinds[j] && looksLikeName(tokens[j]))) j = zipOnly - 1;
        if (j >= 0 && !kinds[j] && looksLikeName(tokens[j]) && j !== 0) { r.city = tokens[j]; kinds[j] = 'city'; }
    }

    const streetIdx = kinds.indexOf('street');
    const zipIdx = kinds.findIndex(k => k === 'zip' || k === 'zipOnly');
    const extras = [];
    tokens.forEach((t, i) => {
        if (kinds[i] === 'extra') { extras.push(t); return; }
        if (kinds[i]) return;
        const beforeAddress = (streetIdx < 0 || i < streetIdx) && (zipIdx < 0 || i < zipIdx);
        if (beforeAddress && !r.name && looksLikeName(t) && !COMPANY.test(t)) { r.name = cleanName(t); kinds[i] = 'name'; return; }
        if (beforeAddress && !r.company && COMPANY.test(t) && t.split(' ').length <= 6 && !/[.!?]$/.test(t)) { r.company = t; kinds[i] = 'company'; return; }
        if (!r.name && looksLikeName(t) && !COMPANY.test(t) && streetIdx < 0 && zipIdx < 0) { r.name = cleanName(t); kinds[i] = 'name'; return; }
        // No postcode: the last free name-like token after the street is the town ("Musterstr. 1 / Berlin")
        if (!r.city && zipIdx < 0 && streetIdx >= 0 && i > streetIdx && looksLikeName(t)
            && !tokens.some((u, k) => k > i && !kinds[k] && looksLikeName(u))) { r.city = t; kinds[i] = 'city'; return; }
        // Between street and town: address addition ("Hinterhaus", "Apt 4")
        if (streetIdx >= 0 && i > streetIdx && (zipIdx < 0 || i < zipIdx)) { extras.push(t); kinds[i] = 'extra'; return; }
        // GB: town on its own line before the postcode
        if (!r.city && zipIdx >= 0 && i === zipIdx - 1 && i > streetIdx && looksLikeName(t)) { r.city = t; kinds[i] = 'city'; return; }
        if (!r.city && zipIdx < 0 && streetIdx >= 0 && i === streetIdx + 1 && looksLikeName(t)) { r.city = t; kinds[i] = 'city'; return; }
        r.unknown.push(t);
    });
    if (extras.length && !r.extra) r.extra = extras.join(', ');

    // "3118 A.Hlinka" with a Slovak address is house number + street, not postcode + town
    if (r.countryCode && r.zip && !ZIP_FORMAT_OK(r.countryCode, r.zip) && /^\d+$/.test(r.zip) && r.city
        && (!r.street || /^\d+$/.test(r.houseNumber) === false || COUNT_STREET.test(r.street))) {
        r.street = tidyCase(r.city);
        r.houseNumber = looseNumber ? `${r.zip}/${looseNumber}` : r.zip;
        r.zip = '';
        r.city = '';
        looseNumber = '';
    }

    // Tidy up
    r.city = tidyCase(stripEdges(r.city.replace(/,\s*[A-Z]{2}$/, '')));
    r.extra = cleanSpaces(r.extra);
    r.company = cleanSpaces(r.company);
    if (r.name) r.name = cleanName(r.name);
    r.zip = cleanSpaces(r.zip).toUpperCase();

    if (!r.country) {
        const phoneCountry = countryFromPhone(r.phone);
        let code = countryHint;
        const cityKey = cleanSpaces(r.city).toLowerCase().replace(/\s*\(.*\)$/, '');
        const cityCountry = COUNTRY_BY_CITY.get(cityKey) || COUNTRY_BY_CITY.get(cityKey.split(/[ ,-]/)[0]);
        // A well-known town decides when the postcode format fits it (Wien 1010, Bern 3011, Paris 75001 …)
        if (!code && cityCountry) {
            const fits = { AT: /^\d{4}$/, CH: /^\d{4}$/, BE: /^\d{4}$/, DK: /^\d{4}$/, LU: /^\d{4}$/, NO: /^\d{4}$/, HU: /^\d{4}$/, SI: /^\d{4}$/, AU: /^\d{4}$/,
                NL: /^\d{4} ?[A-Z]{2}$/, PL: /^\d{2}-\d{3}$/, CZ: /^\d{3} ?\d{2}$/, GB: /^[A-Z]/, US: /^\d{5}/ }[cityCountry] || /^\d{5}$/;
            if (!r.zip || fits.test(r.zip)) code = cityCountry;
        }
        if (!code && r.zip) {
            if (/^\d{5}$/.test(r.zip)) code = phoneCountry && ['FR', 'IT', 'ES', 'FI', 'HR', 'TR', 'UA', 'GR', 'LT', 'EE', 'US'].includes(phoneCountry.code) ? phoneCountry.code : 'DE';
            else if (/^\d{4}$/.test(r.zip)) code = phoneCountry && phoneCountry.code !== 'DE' ? phoneCountry.code : null;
        }
        if (!code && !r.zip && phoneCountry) code = null; // no address at all: do not guess from the phone
        const c = code ? COUNTRY_BY_CODE.get(code) : null;
        if (c) { r.country = c.name; r.countryCode = c.code; }
    }

    if ((r.countryCode === 'SK' || r.countryCode === 'CZ') && /^\d{5}$/.test(r.zip)) r.zip = `${r.zip.slice(0, 3)} ${r.zip.slice(3)}`;
    r.address = formatAddress(r);
    r.found = ['name', 'street', 'zip', 'city', 'phone', 'email', 'company'].filter(k => r[k]).length;
    delete r._numberFirst;
    return r;
}

const NUMBER_FIRST_COUNTRIES = new Set(['GB', 'US', 'IE', 'FR', 'CA', 'AU', 'LU']);

function streetLine(r) {
    if (!r.street) return r.houseNumber || '';
    if (!r.houseNumber) return r.street;
    return NUMBER_FIRST_COUNTRIES.has(r.countryCode) ? `${r.houseNumber} ${r.street}` : `${r.street} ${r.houseNumber}`;
}

function townLine(r) {
    if (r.countryCode === 'US' || r.countryCode === 'CA') return [r.city, [r.state, r.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (r.countryCode === 'GB' || r.countryCode === 'IE') return [r.city, r.zip].filter(Boolean).join(' ');
    return [r.zip, r.city].filter(Boolean).join(' ');
}

/** Address block as used for guests and invoices; the company goes first, Germany is left out. */
function formatAddress(r) {
    return [
        r.company,
        streetLine(r),
        r.extra,
        townLine(r),
        r.country && r.countryCode !== 'DE' ? r.country : ''
    ].map(cleanSpaces).filter(Boolean).join('\n');
}

/** True when the text holds enough of an address to be worth offering "Anschrift übernehmen". */
function looksLikeAddress(text) {
    const r = parseAddress(text);
    return Boolean((r.street && (r.zip || r.city || r.country)) || (r.zip && r.city && (r.name || r.street)));
}

/** Stored guest address ("Straße Nr.\nPLZ Ort\nLand") split into form fields (Meldeschein, invoice). */
function splitAddress(address) {
    const out = { street: '', zip: '', city: '', country: '', countryCode: '' };
    if (!String(address || '').trim()) return out;
    const r = parseAddress(address);
    out.street = streetLine(r);
    out.zip = r.zip || '';
    out.city = r.city || '';
    out.country = r.country || '';
    out.countryCode = r.countryCode || '';
    return out;
}

module.exports = { parseAddress, looksLikeAddress, formatAddress, splitAddress, tidyCase, normalizePhone, _internal: { parseStreet, parseZipCity, countryFromText } };
