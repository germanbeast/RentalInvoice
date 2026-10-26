#!/bin/bash
# Aktualisiert die App auf dem Linux-Server: Code holen, Abhängigkeiten installieren, per PM2 neu starten.
# Aufruf im Projektordner:  ./update.sh
set -e
cd "$(dirname "$0")"

echo "📥 Hole Updates von GitHub..."
# Reine Installationskopie (Datenbank, .env usw. sind in .gitignore): nicht mergen, sondern auf origin/main
# setzen. Eigene Änderungen an versionierten Dateien landen in "git stash list".
git reset -q --merge 2>/dev/null || true
git stash push -q -m "update.sh $(date +%F-%H%M)" 2>/dev/null || true
git fetch origin main
git reset -q --hard origin/main

echo "📦 Installiere Abhängigkeiten..."
npm install --no-audit --no-fund

echo "🔄 Starte App neu..."
if command -v pm2 >/dev/null 2>&1; then
    pm2 restart invoice-app || pm2 start server.js --name invoice-app
    pm2 save >/dev/null
else
    echo "⚠️ PM2 nicht gefunden. Bitte den Server selbst neu starten."
fi

echo "✅ Fertig. Version: $(node -p "require('./package.json').version")"
