# 🛠️ APK Bauen - Einfache Anleitung

## Option 1: Mit Android Studio (EMPFOHLEN - Am Einfachsten!)

### Schritt 1: Android Studio installieren
1. Download: https://developer.android.com/studio
2. Installieren (alle Standard-Optionen OK)
3. Beim ersten Start: **Standard Setup** wählen

### Schritt 2: Projekt öffnen
1. Android Studio starten
2. **"Open an Existing Project"** klicken
3. Diesen Ordner auswählen: `android-tv-kiosk`
4. Warten bis Gradle fertig ist (unten rechts siehst du den Fortschritt)

### Schritt 3: APK bauen
1. Menü: **Build** → **Build Bundle(s) / APK(s)** → **Build APK(s)**
2. Warten bis "BUILD SUCCESSFUL" erscheint
3. Auf **"locate"** klicken

Die fertige APK ist in:
```
app/build/outputs/apk/debug/app-debug.apk
```

### Schritt 4: APK auf TV installieren
Siehe [INSTALL.md](INSTALL.md) ab Schritt 5

---

## Option 2: Mit Kommandozeile (Für Profis)

Wenn du Gradle installiert hast:

```bash
cd android-tv-kiosk
./gradlew assembleDebug
```

Die APK findest du dann in:
```
app/build/outputs/apk/debug/app-debug.apk
```

---

## ❓ Häufige Fragen

### "Gradle Build Failed"
→ Stelle sicher, dass du Internet hast (Gradle lädt Abhängigkeiten)
→ Klicke auf "Sync Project with Gradle Files" (Elefant-Icon)

### "SDK not found"
→ Android Studio installiert das automatisch beim ersten Build
→ Falls nicht: Tools → SDK Manager → Android 13.0 (API 33) installieren

### "Accept License Agreement"
→ Unten erscheint ein Link "Install missing platforms and sync"
→ Klicken und warten

---

## 🎯 Was die App kann

Sobald du die APK installiert hast:

✅ **Kiosk-Modus** - Vollbild, keine System-UI
✅ **Settings** - 5x schnell auf Logo tippen (oben links)
✅ **Alles konfigurierbar**:
   - Server-IP
   - Gast-Name
   - WLAN-Name & Passwort
   - Check-In/Out Zeiten
   - Kontakt-Telefon

Die Settings werden in der App gespeichert - du musst **nichts** im Code ändern!

---

## 📱 Release APK bauen (Für Production)

Wenn du die App verteilen willst:

1. In Android Studio: **Build** → **Generate Signed Bundle / APK**
2. **APK** auswählen
3. **Create new keystore** (beim ersten Mal)
   - Keystore path: Wo auch immer du willst
   - Password: Merken!
   - Alias: `ferienwohnung`
4. Next → **release** → Finish

Die signierte APK ist dann in:
```
app/build/outputs/apk/release/app-release.apk
```

Diese kannst du auf mehreren TVs installieren!

---

Bei Problemen, schreib mir! 😊
