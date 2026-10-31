/**
 * Small, dependency-free writers for exports
 *
 *  zip(files)      - ZIP archive (deflate) from [{ name, data: Buffer|string, date? }]
 *  xlsx(sheets)    - Excel workbook (.xlsx) from [{ name, columns, rows, totals? }]
 *                    columns: [{ header, key, type: 'text'|'money'|'date'|'int'|'num'|'pct', width? }]
 *                    rows: objects with the column keys; pct values are fractions (0.42 = 42 %)
 *  csv(columns, rows, totals?) - CSV for German Excel: ";" separated, decimal comma, UTF-8 with BOM
 */
const zlib = require('zlib');

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(date) {
    const d = date || new Date();
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
        date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
}

function zip(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    const used = new Set();
    for (const f of files) {
        // Unique names (two invoices with the same file name would overwrite each other when unpacked)
        let name = String(f.name).replace(/\\/g, '/');
        if (used.has(name)) {
            const dot = name.lastIndexOf('.');
            let i = 2;
            while (used.has(dot > 0 ? `${name.slice(0, dot)}-${i}${name.slice(dot)}` : `${name}-${i}`)) i++;
            name = dot > 0 ? `${name.slice(0, dot)}-${i}${name.slice(dot)}` : `${name}-${i}`;
        }
        used.add(name);
        const nameBuf = Buffer.from(name, 'utf8');
        const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
        const deflated = zlib.deflateRawSync(raw);
        const store = deflated.length >= raw.length; // already compressed (PDF) -> store
        const body = store ? raw : deflated;
        const crc = crc32(raw);
        const { time, date } = dosTime(f.date);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(store ? 0 : 8, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        parts.push(local, nameBuf, body);

        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4);
        cen.writeUInt16LE(20, 6);
        cen.writeUInt16LE(0x0800, 8);
        cen.writeUInt16LE(store ? 0 : 8, 10);
        cen.writeUInt16LE(time, 12);
        cen.writeUInt16LE(date, 14);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(body.length, 20);
        cen.writeUInt32LE(raw.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt32LE(offset, 42);
        central.push(cen, nameBuf);
        offset += 30 + nameBuf.length + body.length;
    }
    const cenSize = central.reduce((s, b) => s + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cenSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, ...central, end]);
}

// ---------------------------------------------------------------- XLSX

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    // Control characters are not allowed in XML
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

const excelDate = ymd => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    if (!m) return null;
    return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
};

// Style ids in styles.xml (cellXfs order)
const ST = { text: 0, header: 1, money: 2, date: 3, int: 4, pct: 5, num: 6, totalText: 7, totalMoney: 8, totalInt: 9, totalPct: 10, totalNum: 11, title: 12 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;€&quot;"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/><numFmt numFmtId="166" formatCode="0.0%"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEFC"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF9CA3AF"/></top><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="1" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="166" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="4" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Standard" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cell(ref, value, type, total) {
    if (value === null || value === undefined || value === '') {
        return total ? `<c r="${ref}" s="${ST.totalText}"/>` : '';
    }
    const T = k => total ? ST['total' + k[0].toUpperCase() + k.slice(1)] : ST[k];
    if (type === 'date') {
        const n = excelDate(value);
        if (n !== null) return `<c r="${ref}" s="${ST.date}"><v>${n}</v></c>`;
    }
    if (['money', 'int', 'num', 'pct'].includes(type) && typeof value === 'number' && isFinite(value)) {
        return `<c r="${ref}" s="${T(type)}"><v>${type === 'int' ? Math.round(value) : Math.round(value * 1e6) / 1e6}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr" s="${total ? ST.totalText : ST.text}"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheetXml(sheet) {
    const cols = sheet.columns;
    const out = [];
    let r = 1;
    const notes = sheet.title ? [sheet.title, ...(sheet.notes || [])] : [];
    notes.forEach((t, i) => {
        out.push(`<row r="${r}"><c r="A${r}" t="inlineStr" s="${i === 0 ? ST.title : ST.text}"><is><t xml:space="preserve">${esc(t)}</t></is></c></row>`);
        r++;
    });
    if (notes.length) r++; // empty row before the table
    const headerRow = r;
    out.push(`<row r="${r}">${cols.map((c, i) => `<c r="${colName(i)}${r}" t="inlineStr" s="${ST.header}"><is><t>${esc(c.header)}</t></is></c>`).join('')}</row>`);
    r++;
    for (const row of sheet.rows) {
        out.push(`<row r="${r}">${cols.map((c, i) => cell(`${colName(i)}${r}`, row[c.key], c.type)).join('')}</row>`);
        r++;
    }
    if (sheet.totals) {
        out.push(`<row r="${r}">${cols.map((c, i) => cell(`${colName(i)}${r}`, sheet.totals[c.key], c.type, true)).join('')}</row>`);
        r++;
    }
    const widths = cols.map((c, i) => {
        if (c.width) return c.width;
        const longest = Math.max(String(c.header).length, ...sheet.rows.slice(0, 500).map(row => {
            const v = row[c.key];
            if (v == null) return 0;
            if (c.type === 'money') return 13;
            if (c.type === 'date') return 10;
            return String(v).split('\n')[0].length;
        }));
        return Math.min(60, Math.max(8, longest + 2));
    });
    const lastCol = colName(Math.max(0, cols.length - 1));
    const filter = sheet.rows.length ? `<autoFilter ref="A${headerRow}:${lastCol}${headerRow + sheet.rows.length}"/>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${out.join('')}</sheetData>${filter}
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

function safeSheetName(name, used) {
    let n = String(name || 'Tabelle').replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31).trim() || 'Tabelle';
    let base = n, i = 2;
    while (used.has(n.toLowerCase())) n = `${base.slice(0, 28)} ${i++}`;
    used.add(n.toLowerCase());
    return n;
}

function xlsx(sheets) {
    const used = new Set();
    const names = sheets.map(s => safeSheetName(s.name, used));
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const files = [
        {
            name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`
        },
        {
            name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`
        },
        {
            name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>Beckhome Admin</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
</cp:coreProperties>`
        },
        {
            name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`
        },
        {
            name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
        },
        { name: 'xl/styles.xml', data: STYLES },
        ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }))
    ];
    return zip(files);
}

// ---------------------------------------------------------------- CSV

function csvValue(v, type) {
    if (v === null || v === undefined) return '';
    if (type === 'date') {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
        if (m) return `${m[3]}.${m[2]}.${m[1]}`;
    }
    if (typeof v === 'number' && ['money', 'num', 'int', 'pct'].includes(type)) {
        const n = type === 'pct' ? v * 100 : v;
        const d = type === 'int' ? 0 : type === 'pct' ? 1 : 2;
        return n.toFixed(d).replace('.', ',');
    }
    let s = String(v);
    // Cells starting with = + - @ would run as formulas in Excel
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(columns, rows, totals) {
    const lines = [columns.map(c => csvValue(c.header, 'text')).join(';')];
    for (const r of rows) lines.push(columns.map(c => csvValue(r[c.key], c.type)).join(';'));
    if (totals) lines.push(columns.map(c => csvValue(totals[c.key], c.type)).join(';'));
    return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { zip, xlsx, csv, crc32 };
