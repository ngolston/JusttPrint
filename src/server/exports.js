'use strict';

/**
 * Export from the Statistics page: the print history and the models as CSV, or everything in one
 * Excel workbook (print history, models, prints per month, failure analysis). For the browser to
 * download (download-files.js; deleted an hour later). The print history and months follow the
 * period chosen (`months`, 0 for all time).
 */

const fs = require('fs');
const { zipSync, strToU8 } = require('fflate');
const downloadFiles = require('./download-files');

/** The table of a sheet or CSV: column names and rows of values (numbers stay numbers). */
/** @typedef {{ name: string, columns: string[], rows: (string | number | null)[][] }} Table */

const sinceOf = (months) => (months > 0 ? new Date(Date.now() - months * 30.44 * 86400000).toISOString() : null);

/** Every logged print in the period, newest first. */
function printHistory(db, months) {
  const since = sinceOf(months);
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(print_events)')
      .all()
      .map((c) => c.name)
  );
  const col = (name) => (columns.has(name) ? `e.${name}` : 'NULL');
  const rows = db
    .prepare(
      `SELECT e.id, e.printed_at, m.title, m.fileName, m.designer, e.outcome, e.quantity, p.nickname AS printer, ${col('plate_index')} AS plate,
         ${col('duration_seconds')} AS seconds, ${col('filament_used_g')} AS grams, ${col('ams_humidity')} AS humidity, e.notes, m.filePath
       FROM print_events e JOIN models m ON m.id = e.model_id LEFT JOIN printers p ON p.id = ${col('printer_id')}
       ${since ? 'WHERE julianday(e.printed_at) >= julianday(?)' : ''}
       ORDER BY julianday(e.printed_at) DESC, e.id DESC`
    )
    .all(...(since ? [since] : []));
  let spools = new Map();
  try {
    for (const row of db
      .prepare(
        "SELECT u.event_id, GROUP_CONCAT(COALESCE(s.name, s.material, 'Spool') || ' (' || ROUND(u.grams) || ' g)', ', ') AS used FROM print_event_spools u LEFT JOIN spools s ON s.id = u.spool_id GROUP BY u.event_id"
      )
      .all())
      spools.set(row.event_id, row.used);
  } catch (_) {
    spools = new Map();
  }
  return {
    name: 'Print history',
    columns: ['Date', 'Model', 'Designer', 'Outcome', 'Copies', 'Printer', 'Plate', 'Hours', 'Grams', 'Spools', 'AMS humidity (%)', 'Notes', 'File'],
    rows: rows.map((r) => [
      r.printed_at,
      (r.title && r.title.trim()) || r.fileName,
      r.designer,
      r.outcome,
      r.quantity,
      r.printer,
      r.plate,
      r.seconds ? Math.round((r.seconds / 3600) * 100) / 100 : null,
      r.grams !== null && r.grams !== undefined ? Math.round(r.grams * 10) / 10 : null,
      spools.get(r.id) || null,
      r.humidity,
      r.notes,
      r.filePath
    ])
  };
}

/** Every model in the library (parts of merged models too), by name. */
function models(db) {
  const tags = new Map();
  for (const row of db
    .prepare(`SELECT mt.model_id, GROUP_CONCAT(t.name, ', ') AS names FROM model_tags mt JOIN tags t ON t.id = mt.tag_id GROUP BY mt.model_id`)
    .all()) {
    tags.set(row.model_id, row.names);
  }
  const categories = new Map();
  try {
    for (const row of db
      .prepare(
        `SELECT mc.model_id, GROUP_CONCAT(COALESCE(parent.name || ' › ', '') || c.name, ', ') AS names
         FROM model_categories mc JOIN categories c ON c.id = mc.category_id LEFT JOIN categories parent ON parent.id = c.parent_id GROUP BY mc.model_id`
      )
      .all())
      categories.set(row.model_id, row.names);
  } catch (_) {
    /* before categories */
  }
  const rows = db
    .prepare(
      'SELECT id, title, fileName, designer, license, print_status, print_count, rating, favorite, size, dateAdded, filePath FROM models ORDER BY COALESCE(title, fileName) COLLATE NOCASE'
    )
    .all();
  return {
    name: 'Models',
    columns: ['Model', 'File name', 'Designer', 'Category', 'Tags', 'License', 'Print status', 'Prints', 'Rating', 'Favorite', 'Size (MB)', 'Added', 'File'],
    rows: rows.map((r) => [
      (r.title && r.title.trim()) || r.fileName,
      r.fileName,
      r.designer,
      categories.get(r.id) || null,
      tags.get(r.id) || null,
      r.license,
      r.print_status,
      r.print_count || 0,
      r.rating || null,
      r.favorite ? 'Yes' : null,
      r.size ? Math.round((Number(r.size) / 1048576) * 100) / 100 : null,
      r.dateAdded,
      r.filePath
    ])
  };
}

/** Prints per month in the period (src/core/print-stats.js). */
function byMonth(db, months) {
  const stats = require('../core/print-stats').printStatistics(db, { months });
  return {
    name: 'By month',
    columns: ['Month', 'Printed', 'Failed', 'Cancelled', 'Print hours', 'Models added'],
    rows: stats.byMonth.map((m) => [m.month, m.printed, m.failed, m.cancelled, m.hours ?? null, m.added ?? null])
  };
}

/** Failure analysis in the period (src/core/failure-analysis.js): every group, then the findings. */
function failures(db, months) {
  const analysis = require('../core/failure-analysis').failureAnalysis(db, { since: sinceOf(months) });
  const names = { printer: 'Printer', material: 'Material', brand: 'Brand', humidity: 'AMS humidity', duration: 'Print length', timeOfDay: 'Started' };
  const rows = [];
  for (const [kind, list] of Object.entries(analysis.groups)) {
    for (const group of list) rows.push([names[kind] || kind, group.label, group.prints, group.failed, Math.round(group.rate * 1000) / 10]);
  }
  for (const finding of analysis.findings) rows.push(['Finding', finding.text, null, null, null]);
  return { name: 'Failures', columns: ['By', 'Group', 'Prints', 'Failed', 'Failure rate (%)'], rows };
}

// ---- Writing ---------------------------------------------------------------------------------

/** A CSV file's text: comma separated, quoted where needed, with a byte-order mark so Excel reads UTF-8. */
function toCsv(table) {
  const cell = (value) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `\uFEFF${[table.columns, ...table.rows].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

const xml = (text) =>
  String(text)
    // Characters XML cannot hold.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** "A", "B", … "Z", "AA"… for a 0-based column. */
function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** A sheet's XML: a bold header row, numbers as numbers, text inline. */
function sheetXml(table) {
  const rows = [table.columns, ...table.rows].map((row, r) => {
    const cells = row
      .map((value, c) => {
        if (value === null || value === undefined || value === '') return '';
        const ref = `${columnName(c)}${r + 1}`;
        if (r > 0 && typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
        return `<c r="${ref}" t="inlineStr"${r === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
      })
      .join('');
    return `<row r="${r + 1}">${cells}</row>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

/** An Excel workbook (.xlsx) with one sheet per table. */
function toXlsx(tables) {
  const sheets = tables.map((table, i) => ({ ...table, file: `sheet${i + 1}.xml`, sheetName: xml(table.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)) }));
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
      .map((s) => `<Override PartName="/xl/worksheets/${s.file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('')}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((s, i) => `<sheet name="${s.sheetName}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (s, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${s.file}"/>`
      )
      .join(
        ''
      )}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`
  };
  for (const s of sheets) files[`xl/worksheets/${s.file}`] = sheetXml(s);
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)]))));
}

/**
 * Write an export for the browser to download: `what` history or models as CSV, or everything
 * as an Excel workbook. Answers { filePath, name }.
 * @param {any} db
 * @param {{ what: 'history' | 'models' | 'everything', months?: number }} options
 */
async function writeExport(db, options) {
  const months = Number(options.months) || 0;
  const day = new Date().toISOString().slice(0, 10);
  if (options.what === 'everything') {
    const filePath = downloadFiles.newDownloadPath('export', 'xlsx');
    await fs.promises.writeFile(filePath, toXlsx([printHistory(db, months), models(db), byMonth(db, months), failures(db, months)]));
    return { filePath, name: `JusttPrint ${day}.xlsx` };
  }
  const table = options.what === 'models' ? models(db) : options.what === 'history' ? printHistory(db, months) : null;
  if (!table) throw new Error('Export history, models or everything');
  const filePath = downloadFiles.newDownloadPath(options.what, 'csv');
  await fs.promises.writeFile(filePath, toCsv(table), 'utf8');
  return { filePath, name: `JusttPrint ${table.name} ${day}.csv` };
}

module.exports = { writeExport, printHistory, models, byMonth, failures, toCsv, toXlsx, columnName };
