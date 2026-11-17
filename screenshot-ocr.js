'use strict';

/**
 * Texterkennung (OCR) für Screenshots, die im Telegram-Bot ankommen (z. B. Gastdaten aus der Booking.com-App).
 *
 * - Läuft komplett auf dem eigenen Server (tesseract.js), es geht nichts an fremde Dienste.
 * - Sprachdaten Deutsch + Englisch kommen als npm-Pakete mit (@tesseract.js-data/deu, /eng),
 *   es wird also nichts aus dem Internet nachgeladen.
 * - Pro Bild wird ein Worker gestartet und danach beendet (spart Arbeitsspeicher), Bilder werden nacheinander verarbeitet.
 * - Das Bild selbst wird nicht gespeichert: der Aufrufer löscht die temporäre Datei direkt nach der Erkennung.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '.ocr-data');
const LANGS = ['deu', 'eng'];

let queue = Promise.resolve();

/** Copies the language files from the npm packages next to each other (tesseract wants one folder). */
function prepareLangDir() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        for (const lang of LANGS) {
            const target = path.join(DATA_DIR, `${lang}.traineddata.gz`);
            if (fs.existsSync(target)) continue;
            const pkgDir = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
            fs.copyFileSync(path.join(pkgDir, '4.0.0_best_int', `${lang}.traineddata.gz`), target);
        }
        return DATA_DIR;
    } catch (e) {
        console.warn('⚠️ OCR-Sprachdaten nicht gefunden, werden beim ersten Mal aus dem Internet geladen:', e.message);
        return null;
    }
}

/**
 * Removes what a phone screenshot carries besides the content: status bar (time, battery, network),
 * arrows/icons, lines without letters or digits, typical app buttons.
 */
function cleanOcrText(text) {
    return String(text || '').replace(/\r/g, '').split('\n')
        .map(l => l.replace(/[|_~«»©®™•●◦▪►▶◀←→↑↓<>‹›]/g, ' ').replace(/^[\s—–\-=:;.,'"`]+/, '').replace(/\s+/g, ' ').trim())
        .filter(l => l.length >= 2)
        .filter(l => /[A-Za-zÀ-ÿ0-9]/.test(l))
        // Status bar: "17:34 5G 84%"
        .filter(l => !(/^\d{1,2}:\d{2}\b/.test(l) && !/[A-Za-zÀ-ÿ]{4,}/.test(l.replace(/\b(lte|5g|4g|3g|h\+|wlan|wifi|vpn|volte)\b/gi, ''))))
        .filter(l => !/^\d{1,3}\s?%$/.test(l))
        .filter(l => !/^(gast kontaktieren|nachricht senden|anrufen|kontaktieren|contact guest|send message|call|message|mehr|more|zurück|back|teilen|share|bearbeiten|edit|schließen|close|ok|fertig|done)$/i.test(l))
        .join('\n');
}

async function runOcr(imagePath) {
    const { createWorker } = require('tesseract.js');
    const langDir = prepareLangDir();
    const opts = langDir ? { langPath: langDir, cachePath: langDir, gzip: true } : { cachePath: DATA_DIR };
    const worker = await createWorker(LANGS, 1, opts);
    try {
        const { data } = await worker.recognize(imagePath);
        return { text: cleanOcrText(data.text), raw: data.text, confidence: data.confidence };
    } finally {
        await worker.terminate().catch(() => { });
    }
}

/** Recognizes the text in an image file; calls run one after another. */
function recognize(imagePath) {
    const job = queue.then(() => runOcr(imagePath));
    queue = job.catch(() => { });
    return job;
}

module.exports = { recognize, cleanOcrText };
