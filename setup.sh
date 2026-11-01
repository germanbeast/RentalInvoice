#!/bin/bash
# Ferienwohnung Rechnung - All-in-One Ubuntu Setup Script
# Dieses Skript kann auf einem frischen Ubuntu-Server ausgeführt werden.

# Einstellungen
REPO_URL="https://github.com/germanbeast/RentalInvoice.git"
PROJECT_DIR="RentalInvoice"

# Fehler abfangen
set -e

echo "🚀 Starte All-in-One Setup für RentalInvoice..."

# 1. System-Updates & Basis-Abhängigkeiten
echo "📦 Aktualisiere Systempakete & installiere Abhängigkeiten..."
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl build-essential python3

# 2. Projekt herunterladen (falls noch nicht vorhanden)
if [ -f "package.json" ]; then
    echo "✅ Bereits im Projekt-Ordner. Lade aktuelle Änderungen..."
    if [ -d ".git" ]; then
        git pull || echo "⚠️ Konnte git pull nicht ausführen."
    fi
elif [ -d "$PROJECT_DIR" ]; then
    echo "📂 Projekt-Ordner '$PROJECT_DIR' existiert. Gehe in den Ordner..."
    cd "$PROJECT_DIR"
    git pull || echo "⚠️ Konnte git pull nicht ausführen."
else
    echo "📂 Klone Projekt von GitHub..."
    git clone "$REPO_URL" "$PROJECT_DIR"
    cd "$PROJECT_DIR"
fi

# Sicherheitscheck: package.json muss existieren
if [ ! -f "package.json" ]; then
    echo "❌ FEHLER: package.json wurde nicht gefunden! Befinde mich in: $(pwd)"
    echo "Das Skript konnte die Dateien nicht von GitHub laden."
    exit 1
fi

# 3. Node.js Installation (v20 LTS)
if ! command -v node &> /dev/null; then
    echo "🟢 Installiere Node.js v20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
else
    echo "✅ Node.js ist bereits installiert ($(node -v))"
fi

# 4. Puppeteer Abhängigkeiten (für PDF-Generierung)
echo "🌐 Installiere Browser-Abhängigkeiten für Puppeteer..."
sudo apt install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils

# 5. App Abhängigkeiten installieren (inkl. better-sqlite3 native build)
echo "📚 Installiere App-Abhängigkeiten (inkl. SQLite-Datenbank)..."
npm install

# 6. Datenbank-Verzeichnis vorbereiten
echo "🗄️  Datenbank wird beim ersten Serverstart automatisch erstellt."
echo "   Speicherort: $(pwd)/rental.db"

# 7. PM2 Setup
if ! command -v pm2 &> /dev/null; then
    echo "⚡ Installiere PM2 global..."
    sudo npm install -g pm2
fi

# 8. .env Setup
if [ ! -f .env ]; then
    echo "📝 Erstelle .env Datei aus Vorlage..."
    cp .env.example .env
    echo "⚠️  HINWEIS: Bitte bearbeite jetzt die '.env' Datei (z.B. mit 'nano .env')."
fi

# 9. Start mit PM2
echo "▶️ Starte Server mit PM2..."
pm2 start server.js --name "invoice-app" || pm2 restart "invoice-app"
pm2 start watchdog.js --name "beckhome-watchdog" || pm2 restart "beckhome-watchdog"
pm2 save

# 10. Autostart bei Reboot
echo "🔄 Konfiguriere Autostart..."
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $USER --hp $HOME || true

echo "✅ Setup erfolgreich abgeschlossen!"
echo "----------------------------------------------------------------"
echo "ℹ️  Datenbank: SQLite wird automatisch eingerichtet (rental.db)"
echo "   Keine manuelle DB-Konfiguration nötig!"
echo "----------------------------------------------------------------"
echo "1. WICHTIG: Bearbeite die Zugangsdaten in der .env Datei!"
echo "   Befehl: nano .env"
echo "2. Starte die App danach neu: pm2 restart invoice-app"
echo "3. Logs ansehen: pm2 logs invoice-app"
echo "----------------------------------------------------------------"
