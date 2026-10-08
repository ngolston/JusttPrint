'use strict';

/**
 * The Statistics page: what the print log and the library say over a period. Read-only.
 *
 * Counts are prints (each logged event times its quantity). The success rate is printed out
 * of printed + failed; cancelled prints are counted on their own.
 * Months are calendar months in UTC, as the print log stores times.
 */

const MAX_MONTHS = 120;
const TOP = 8;

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnExists(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === column);
  } catch (_) {
    return false;
  }
}

const monthKey = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

/** The `count` months ending with the month of `now`, oldest first ("2026-03"). */
function monthRange(now, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  return out;
}

/** Months from `first` ("2025-11") through the month of `now`, at most MAX_MONTHS. */
function monthsSince(first, now) {
  const [year, month] = String(first).split('-').map(Number);
  if (!year || !month) return 1;
  const span = (now.getUTCFullYear() - year) * 12 + (now.getUTCMonth() + 1 - month) + 1;
  return Math.max(1, Math.min(MAX_MONTHS, span));
}

const rate = (printed, failed) => (printed + failed > 0 ? printed / (printed + failed) : null);

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} [options]
 * @param {number} [options.months] Months to cover, ending this month (1–120); 0 for all time. Default 12.
 * @param {Date} [options.now]
 */
function printStatistics(db, { months = 12, now = new Date() } = {}) {
  const hasEvents = tableExists(db, 'print_events');
  const hasPrinters = hasEvents && tableExists(db, 'printers') && columnExists(db, 'print_events', 'printer_id');

  const firstPrint = hasEvents ? db.prepare('SELECT MIN(substr(printed_at, 1, 7)) AS first FROM print_events').get().first : null;
  const requested = Math.floor(Number(months));
  const allTime = requested === 0;
  const span = allTime
    ? (firstPrint ? monthsSince(firstPrint, now) : 12)
    : Math.max(1, Math.min(MAX_MONTHS, Number.isFinite(requested) ? requested : 12));
  const keys = monthRange(now, span);
  const from = allTime ? null : `${keys[0]}-01`;

  // Events in the period: `pe` filtered on printed_at (ISO text sorts by time).
  const where = from ? 'WHERE pe.printed_at >= ?' : '';
  const params = from ? [from] : [];

  const totals = { printed: 0, failed: 0, cancelled: 0 };
  const byMonth = new Map(keys.map((key) => [key, { month: key, printed: 0, failed: 0, cancelled: 0 }]));
  let designers = [];
  let models = [];
  let printers = [];

  if (hasEvents) {
    for (const row of db.prepare(`
      SELECT substr(pe.printed_at, 1, 7) AS month, pe.outcome, SUM(pe.quantity) AS n
      FROM print_events pe ${where}
      GROUP BY month, pe.outcome`).all(...params)) {
      const n = Number(row.n) || 0;
      if (!(row.outcome in totals)) continue;
      totals[row.outcome] += n;
      const bucket = byMonth.get(row.month);
      if (bucket) bucket[row.outcome] += n;
    }

    designers = db.prepare(`
      SELECT TRIM(m.designer) AS name,
             SUM(CASE WHEN pe.outcome = 'printed' THEN pe.quantity ELSE 0 END) AS printed,
             COUNT(DISTINCT m.id) AS models
      FROM print_events pe JOIN models m ON m.id = pe.model_id
      ${where ? `${where} AND` : 'WHERE'} m.designer IS NOT NULL AND TRIM(m.designer) != ''
      GROUP BY TRIM(m.designer) COLLATE NOCASE
      HAVING printed > 0
      ORDER BY printed DESC, name COLLATE NOCASE
      LIMIT ${TOP}`).all(...params).map((row) => ({ name: row.name, printed: Number(row.printed), models: Number(row.models) }));

    models = db.prepare(`
      SELECT m.id, m.fileName, m.filePath, SUM(pe.quantity) AS printed
      FROM print_events pe JOIN models m ON m.id = pe.model_id
      ${where ? `${where} AND` : 'WHERE'} pe.outcome = 'printed'
      GROUP BY m.id
      ORDER BY printed DESC, m.fileName COLLATE NOCASE
      LIMIT ${TOP}`).all(...params).map((row) => ({ id: row.id, fileName: row.fileName, filePath: row.filePath, printed: Number(row.printed) }));

    if (hasPrinters) {
      printers = db.prepare(`
        SELECT COALESCE(p.nickname, '') AS name, pe.printer_id AS id,
               SUM(CASE WHEN pe.outcome = 'printed' THEN pe.quantity ELSE 0 END) AS printed,
               SUM(CASE WHEN pe.outcome = 'failed' THEN pe.quantity ELSE 0 END) AS failed
        FROM print_events pe LEFT JOIN printers p ON p.id = pe.printer_id
        ${where}
        GROUP BY pe.printer_id
        ORDER BY printed DESC, failed DESC`).all(...params).map((row) => ({
        id: row.id == null ? null : Number(row.id),
        name: row.id == null ? '' : row.name,
        printed: Number(row.printed),
        failed: Number(row.failed),
        successRate: rate(Number(row.printed), Number(row.failed))
      })).filter((row) => row.printed + row.failed > 0);
    }
  }

  // Library growth: models added per month in the same period.
  const added = new Map(keys.map((key) => [key, 0]));
  if (columnExists(db, 'models', 'dateAdded')) {
    for (const row of db.prepare(`
      SELECT substr(dateAdded, 1, 7) AS month, COUNT(*) AS n FROM models
      WHERE dateAdded IS NOT NULL ${from ? 'AND dateAdded >= ?' : ''}
      GROUP BY month`).all(...params)) {
      if (added.has(row.month)) added.set(row.month, Number(row.n) || 0);
    }
  }

  return {
    months: allTime ? 0 : span,
    from: keys[0],
    to: keys[keys.length - 1],
    firstPrintMonth: firstPrint || null,
    totals: { ...totals, successRate: rate(totals.printed, totals.failed) },
    byMonth: keys.map((key) => ({ ...byMonth.get(key), added: added.get(key) })),
    designers,
    models,
    printers
  };
}

module.exports = { printStatistics, monthRange };
