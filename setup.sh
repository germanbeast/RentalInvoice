#!/bin/bash
# Ferienwohnung Rechnung - Ubuntu Setup Script

# Exit on error
set -e

echo "🚀 Starte Setup für Ferienwohnung Rechnung..."

# 1. System-Updates
echo "📦 Aktualisiere Systempakete..."
sudo apt update && sudo apt upgrade -y

# 2. Node.js Installation (v20 LTS)
if ! command -v node &> /dev/null; then
    echo "🟢 Installiere Node.js v20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
else
    echo "✅ Node.js ist bereits installiert ($(node -v))"
fi

# 3. Puppeteer Abhängigkeiten (für PDF-Generierung)
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

# 4. App Abhängigkeiten installieren
echo "npm 📚 Installiere App-Abhängigkeiten..."
npm install

# 5. PM2 Setup
if ! command -v pm2 &> /dev/null; then
    echo "⚡ Installiere PM2 global..."
    sudo npm install -g pm2
fi

# 6. .env Setup
if [ ! -f .env ]; then
    echo "📝 Erstelle .env Datei aus Vorlage..."
    cp .env.example .env
    echo "⚠️  BITTE VERGISS NICHT, DIE .env DATEI ANZUPASSEN!"
fi

# 7. Start mit PM2
echo "▶️ Starte Server mit PM2..."
pm2 start server.js --name "invoice-app"
pm2 save

# 8. Autostart bei Reboot
echo "🔄 Konfiguriere Autostart..."
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $USER --hp $HOME

echo "✅ Setup abgeschlossen!"
echo "--------------------------------------------------"
echo "Die App läuft nun unter: http://localhost:3000 (oder deiner Server-IP)"
echo "Nutze 'pm2 logs invoice-app' um Logs zu sehen."
echo "Nutze 'pm2 restart invoice-app' nach Änderungen an der .env Datei."
echo "💡 Tipp: Nutze 'git pull' um Updates von deinem Repository zu laden."
echo "--------------------------------------------------"

