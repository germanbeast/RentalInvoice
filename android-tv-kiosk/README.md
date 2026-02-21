# Ferienwohnung Welcome - Android TV Kiosk App

Diese APK zeigt einen Welcome Screen für Gäste auf Google TV / Android TV.

## Features

✅ **Kiosk-Modus** - Keine System-UI, keine Navigation
✅ **Auto-Start** - Startet automatisch beim Einschalten
✅ **WebView** - Lädt deine Welcome-Seite
✅ **Vollbild** - Optimiert für TV-Displays
✅ **App-Launch** - Buttons starten Waipu TV, Netflix, etc.

## Installation

### Voraussetzungen
- Android TV / Google TV Gerät
- ADB installiert auf deinem PC
- Developer-Modus auf dem TV aktiviert

### Schritt 1: Server-IP anpassen

Öffne `app/src/main/java/com/beckhome/tvwelcome/MainActivity.java`:

```java
private static final String SERVER_URL = "http://192.168.1.100:3000/?welcome=";
```

Ändere `192.168.1.100` zu deiner Server-IP!

### Schritt 2: APK bauen

```bash
# Im android-tv-kiosk Ordner:
./gradlew assembleRelease
```

Die APK findest du dann in:
`app/build/outputs/apk/release/app-release.apk`

### Schritt 3: Auf TV installieren

```bash
# TV über WLAN verbinden:
adb connect 192.168.1.XXX:5555

# APK installieren:
adb install app/build/outputs/apk/release/app-release.apk

# App starten:
adb shell am start -n com.beckhome.tvwelcome/.MainActivity
```

### Schritt 4: Als Standard-Launcher setzen

1. Auf dem TV: **Einstellungen** → **Apps** → **Standard-Apps**
2. **Launcher** → Wähle "Ferienwohnung Welcome"

## Kiosk-Modus testen

Die App:
- Startet automatisch beim Boot
- Versteckt System-UI (Status bar, Navigation)
- Blockiert Home/Back/Recent Buttons
- Hält Bildschirm an
- Läuft im Vollbild

## Gast-Name ändern

Der Gast-Name wird über die URL übergeben. Du kannst ihn später dynamisch ändern:

```bash
# Neue Intent mit Gast-Name:
adb shell am start -n com.beckhome.tvwelcome/.MainActivity --es guest_name "Max Mustermann"
```

## Deinstallation

```bash
adb uninstall com.beckhome.tvwelcome
```

## Troubleshooting

**App startet nicht:**
- Prüfe Server-IP in MainActivity.java
- Prüfe ob Server läuft und erreichbar ist

**Kiosk-Modus funktioniert nicht:**
- Aktiviere "Display over other apps" Permission
- Setze App als Standard-Launcher

**WebView zeigt nichts:**
- Prüfe Internet-Verbindung
- Prüfe Server-URL im Browser

## Entwicklung

Zum Debuggen:
```bash
./gradlew installDebug
adb logcat | grep Welcome
```
