# 📱 Installation auf Google TV - Schritt für Schritt

## ✨ NEU: Alles in der App konfigurierbar!

Du musst **NICHTS** mehr im Code ändern! Die App hat jetzt einen **Settings-Screen** wo du alles einstellen kannst:

- ⚙️ **Settings öffnen**: 5x schnell auf das Logo tippen (oben links)
- 📝 **Was du einstellen kannst**:
  - Server-IP und Port
  - Gast-Name
  - WLAN-Name und Passwort
  - Check-In/Out Zeiten
  - Kontakt-Telefon

---

## 📦 Schritt 1: APK bauen

### Option A: Mit Android Studio (EINFACH!)

1. **Android Studio installieren**: https://developer.android.com/studio
2. **Projekt öffnen**: `android-tv-kiosk` Ordner
3. **Build APK**: Menü → Build → Build Bundle(s) / APK(s) → Build APK(s)
4. **APK finden**: Klick auf "locate" → `app/build/outputs/apk/debug/app-debug.apk`

👉 **Detaillierte Anleitung**: Siehe [BUILD.md](BUILD.md)

---

## 📺 Schritt 2: Developer-Modus auf TV aktivieren

1. Auf dem TV: **Einstellungen** → **System** → **Info**
2. Klicke **7x auf "Build"** bis "Developer Mode aktiviert" erscheint
3. Gehe zu **Einstellungen** → **System** → **Entwickleroptionen**
4. Aktiviere:
   - ✅ **USB-Debugging**
   - ✅ **ADB über Netzwerk**
5. Notiere dir die **IP-Adresse** des TVs (z.B. 192.168.1.150)

---

## 💻 Schritt 3: ADB auf PC installieren

**Windows:**
1. Download: https://developer.android.com/tools/releases/platform-tools
2. Entpacken nach `C:\platform-tools`
3. Terminal öffnen (CMD oder PowerShell)

**Mac:**
```bash
brew install android-platform-tools
```

**Linux:**
```bash
sudo apt install adb
```

---

## 🔌 Schritt 4: Mit TV verbinden

**Option A: USB-Kabel**
```bash
cd C:\platform-tools
adb devices
```

**Option B: WLAN (empfohlen)**
```bash
cd C:\platform-tools
adb connect 192.168.1.150:5555
# (Ersetze 192.168.1.150 mit deiner TV-IP)
```

Auf dem TV erscheint: **"USB-Debugging erlauben?"** → **OK**

---

## 📲 Schritt 5: APK installieren

```bash
adb install pfad/zur/app-debug.apk
```

Beispiel:
```bash
adb install C:\Users\roybe\Downloads\app-debug.apk
```

---

## 🎉 Schritt 6: App starten und konfigurieren

### App starten:
```bash
adb shell am start -n com.beckhome.tvwelcome/.MainActivity
```

### Settings öffnen:
1. **5x schnell auf das Logo tippen** (oben links im Welcome Screen)
2. Settings-Screen erscheint
3. **Server-URL eingeben**: z.B. `http://192.168.1.100:3000`
4. **Gast-Name eingeben**: z.B. "Familie Müller"
5. **WLAN-Daten eingeben**: Name und Passwort
6. **Zeiten eingeben**: Check-In/Out
7. **Telefon eingeben**: Deine Kontaktnummer
8. **Speichern** klicken

Die App lädt automatisch neu und zeigt alles an! 🎊

---

## 🏠 Schritt 7: Als Standard-Launcher einrichten (Optional)

Damit die App beim Einschalten automatisch startet:

### Via ADB:
```bash
adb shell pm set-home-activity com.beckhome.tvwelcome/.MainActivity
```

### Oder manuell auf dem TV:
1. **Einstellungen** → **Apps** → **Alle Apps anzeigen**
2. Suche **"Ferienwohnung Welcome"**
3. Öffne App-Info
4. Wähle **"Als Standard-Home-App festlegen"**

### Permissions erteilen:
```bash
# "Display over other apps" erlauben
adb shell appops set com.beckhome.tvwelcome SYSTEM_ALERT_WINDOW allow

# Auto-Start beim Boot
adb shell pm grant com.beckhome.tvwelcome android.permission.RECEIVE_BOOT_COMPLETED
```

---

## 🔄 Gast wechseln

Du hast 2 Optionen:

### Option 1: In der App (EINFACH!)
1. 5x auf Logo tippen
2. Neuen Gast-Namen eingeben
3. Speichern

### Option 2: Via ADB
```bash
adb shell am start -n com.beckhome.tvwelcome/.MainActivity --es guest_name "Neuer Gast"
```

---

## 🧪 Testen & Debugging

### App neu starten:
```bash
adb shell am force-stop com.beckhome.tvwelcome
adb shell am start -n com.beckhome.tvwelcome/.MainActivity
```

### Logs anschauen:
```bash
adb logcat | findstr "Welcome"
```

### Settings direkt per ADB setzen:
```bash
# Server URL ändern
adb shell "run-as com.beckhome.tvwelcome && cd shared_prefs && cat WelcomeSettings.xml"
```

---

## ❌ Deinstallation

Falls du die App wieder entfernen möchtest:

```bash
adb uninstall com.beckhome.tvwelcome
```

---

## 🔧 Troubleshooting

### App zeigt nur weißen Bildschirm
→ **Server-IP falsch konfiguriert**
1. 5x auf Logo tippen
2. Richtige Server-URL eingeben (z.B. `http://192.168.1.100:3000`)
3. Speichern

→ **Server nicht erreichbar**
- Prüfe ob Server läuft: `http://DEINE-IP:3000` im Browser
- Prüfe Firewall-Einstellungen

### Settings öffnen sich nicht
→ **Schneller tippen!** Alle 5 Taps innerhalb von 2 Sekunden
→ **Richtige Position**: Oben links auf dem Logo

### App startet nicht
→ USB-Debugging aktiviert?
→ ADB-Verbindung klappt? (`adb devices`)

### Kiosk-Modus funktioniert nicht
→ Permissions erteilt? (siehe Schritt 7)
→ Als Standard-Launcher gesetzt?

### TV zeigt "Nicht autorisiert"
→ Auf dem TV: "USB-Debugging erlauben" bestätigen

### WLAN/Zeiten werden nicht angezeigt
→ Die Web-App muss die URL-Parameter auswerten
→ Prüfe in `public/app.js` ob `URLSearchParams` genutzt wird

---

## 📝 Notizen

- Die App ist jetzt **KOMPLETT konfigurierbar** über den Settings-Screen
- Settings werden lokal gespeichert (kein Server nötig)
- Du kannst den Gast-Namen jederzeit ändern (5x tap → Settings)
- Die App startet automatisch beim TV-Boot (wenn als Launcher gesetzt)
- Buttons (Waipu TV, Netflix) funktionieren nur wenn die Apps installiert sind

---

## 🎯 Quick Start für Ungeduldige

```bash
# 1. TV verbinden
adb connect 192.168.1.XXX:5555

# 2. APK installieren
adb install app-debug.apk

# 3. App starten
adb shell am start -n com.beckhome.tvwelcome/.MainActivity

# 4. Settings öffnen (auf TV)
# → 5x schnell auf Logo tippen
# → Alles einstellen
# → Speichern

# 5. Fertig! 🎉
```

---

Bei Fragen oder Problemen, schreib mir! 😊

---

## 🔒 Echter Kiosk-Modus (Fernbedienung gesperrt)

Ab App-Version 1.1 kann die App Home-, Zurück- und Übersichtstaste komplett sperren (Android „Lock Task“).
Dafür muss sie **Geräte-Eigentümer** sein. Das geht nur einmalig und nur, wenn auf der Box **kein Google-Konto** eingerichtet ist
(sonst meldet Android „already several accounts“; dann Konto unter Einstellungen → Konten entfernen).

```bash
adb install -r app-debug.apk
adb shell dpm set-device-owner com.beckhome.tvwelcome/.AdminReceiver
adb shell am start -n com.beckhome.tvwelcome/.MainActivity
```

Ab dann bleibt die App im Vordergrund. Einstellungen öffnest du weiterhin mit 5× Tippen oben links (oder MENU-Taste).

**Kiosk wieder beenden:**
```bash
adb shell am start -n com.beckhome.tvwelcome/.MainActivity --ez exit_kiosk true
```
Das hebt die Sperre auf und gibt den Geräte-Eigentümer-Status wieder frei.
