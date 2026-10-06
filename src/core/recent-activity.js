'use strict';

/**
 * The dashboard's Recent Activity: the latest logged prints (model, outcome, printer, filaments)
 * and the models added to the library, one entry per day. Newest first, read-only.
 */

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function time(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function recentActivity(db, limit = 8) {
  const max = Math.max(1, Math.min(50, Number(limit) || 8));
  const items = [];

  if (tableExists(db, 'print_events')) {
    const hasPrinters = tableExists(db, 'printers');
    const filaments = tableExists(db, 'print_event_filaments') && tableExists(db, 'filaments')
      ? db.prepare(`
          SELECT f.name, f.vendor, f.material FROM print_event_filaments pef
          JOIN filaments f ON f.id = pef.filament_id WHERE pef.event_id = ?
          ORDER BY f.vendor COLLATE NOCASE, f.name COLLATE NOCASE`)
      : null;
    const prints = db.prepare(`
      SELECT pe.id, pe.printed_at, pe.outcome, pe.quantity, m.filePath, m.fileName
        ${hasPrinters ? ', p.nickname AS printer' : ', NULL AS printer'}
      FROM print_events pe
      JOIN models m ON m.id = pe.model_id
      ${hasPrinters ? 'LEFT JOIN printers p ON p.id = pe.printer_id' : ''}
      ORDER BY datetime(pe.printed_at) DESC, pe.id DESC
      LIMIT ?`).all(max);
    for (const row of prints) {
      items.push({
        kind: 'print',
        id: row.id,
        at: row.printed_at,
        outcome: row.outcome,
        quantity: Number(row.quantity) || 1,
        filePath: row.filePath,
        fileName: row.fileName,
        printer: row.printer || null,
        filaments: filaments ? filaments.all(row.id).map((f) => [f.vendor, f.name].filter(Boolean).join(' ')) : []
      });
    }
  }

  const days = db.prepare(`
    SELECT date(dateAdded) AS day, COUNT(*) AS count, MAX(dateAdded) AS latest
    FROM models WHERE dateAdded IS NOT NULL AND date(dateAdded) IS NOT NULL
    GROUP BY day ORDER BY day DESC LIMIT ?`).all(max);
  for (const row of days) items.push({ kind: 'added', at: row.latest, day: row.day, count: row.count });

  return items.sort((a, b) => time(b.at) - time(a.at)).slice(0, max);
}

module.exports = { recentActivity };
