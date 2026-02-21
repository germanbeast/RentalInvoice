# 📱 Installation auf Google TV - Schritt für Schritt

## Option 1: Fertige APK installieren (Einfach)

### Was du brauchst:
- Google TV / Android TV
- Windows PC
- USB-Kabel ODER WLAN-Verbindung

### Schritte:

#### 1. Developer-Modus auf TV aktivieren

1. Auf dem TV: **Einstellungen** → **System** → **Info**
2. Klicke **7x auf "Build"** bis "Developer Mode aktiviert" erscheint
3. Gehe zu **Einstellungen** → **System** → **Entwickleroptionen**
4. Aktiviere:
   - ✅ **USB-Debugging**
   - ✅ **ADB über Netzwerk**
5. Notiere dir die **IP-Adresse** des TVs (z.B. 192.168.1.150)

#### 2. ADB auf PC installieren

**Windows:**
1. Download: https://developer.android.com/tools/releases/platform-tools
2. Entpacken nach `C:\platform-tools`
3. Terminal öffnen (CMD oder PowerShell)

#### 3. Server-IP konfigurieren

**WICHTIG:** Bevor du die APK baust, musst du deine Server-IP eintragen!

Öffne:
```
android-tv-kiosk/app/src/main/java/com/beckhome/tvwelcome/MainActivity.java
```

Ändere Zeile 19:
```java
private static final String SERVER_URL = "http://DEINE-SERVER-IP:3000/?welcome=";
```

Beispiel:
```java
private static final String SERVER_URL = "http://192.168.1.100:3000/?welcome=";
```

#### 4. APK bauen

**Wenn du Android Studio hast:**
1. Öffne Projekt in Android Studio
2. **Build** → **Build Bundle(s) / APK(s)** → **Build APK(s)**
3. Warte bis Build fertig
4. Klicke auf "locate" und kopiere die APK

**Wenn du Gradle Command Line nutzt:**
```bash
cd android-tv-kiosk
./gradlew assembleRelease
```

Die APK findest du in:
```
app/build/outputs/apk/release/app-release.apk
```

#### 5. Mit TV verbinden

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

Auf dem TV erscheint: "USB-Debugging erlauben?" → **OK**

#### 6. APK installieren

```bash
adb install pfad/zur/app-release.apk
```

Beispiel:
```bash
adb install C:\Users\roybe\Downloads\app-release.apk
```

#### 7. App starten

```bash
adb shell am start -n com.beckhome.tvwelcome/.MainActivity
```

🎉 **Fertig!** Der Welcome Screen sollte jetzt erscheinen!

---

## Option 2: Als Standard-Launcher einrichten (Kiosk-Modus)

Damit die App beim Einschalten automatisch startet:

### 1. App zur Home-App machen

```bash
# Setze als Standard-Launcher
adb shell pm set-home-activity com.beckhome.tvwelcome/.MainActivity
```

### 2. Oder manuell auf dem TV:

1. **Einstellungen** → **Apps** → **Alle Apps anzeigen**
2. Suche **"Ferienwohnung Welcome"**
3. Öffne App-Info
4. Wähle **"Als Standard-Home-App festlegen"**

### 3. Permissions erteilen

Die App braucht spezielle Rechte für Kiosk-Modus:

```bash
# "Display over other apps" erlauben
adb shell appops set com.beckhome.tvwelcome SYSTEM_ALERT_WINDOW allow

# Auto-Start beim Boot
adb shell pm grant com.beckhome.tvwelcome android.permission.RECEIVE_BOOT_COMPLETED
```

---

## 🧪 Testen

### Gast-Name ändern
```bash
adb shell am start -n com.beckhome.tvwelcome/.MainActivity --es guest_name "Familie Müller"
```

### App neu starten
```bash
adb shell am force-stop com.beckhome.tvwelcome
adb shell am start -n com.beckhome.tvwelcome/.MainActivity
```

### Logs anschauen
```bash
adb logcat | findstr "Welcome"
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
→ Server-IP falsch oder Server nicht erreichbar
→ Prüfe ob Server läuft: `http://DEINE-IP:3000` im Browser

### App startet nicht
→ USB-Debugging aktiviert?
→ ADB-Verbindung klappt? (`adb devices`)

### Kiosk-Modus funktioniert nicht
→ Permissions erteilt? (siehe oben)
→ Als Standard-Launcher gesetzt?

### TV zeigt "Nicht autorisiert"
→ Auf dem TV: "USB-Debugging erlauben" bestätigen

---

## 📝 Notizen

- Die App lädt die Welcome-Seite von deinem Server
- Buttons (Waipu TV, Netflix) funktionieren nur wenn die Apps installiert sind
- Du kannst die Server-IP später ändern, indem du eine neue APK baust
- Die App speichert keine Daten lokal - alles kommt vom Server

---

Bei Fragen oder Problemen, schreib mir! 😊
