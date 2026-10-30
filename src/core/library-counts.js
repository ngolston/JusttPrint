'use strict';

/**
 * Library counts for the sidebar's Queue badge and the dashboard's figures: every model, how many
 * have been printed, and how many are queued or printing (the same rules as the cards' badges).
 */

const { effectivePrintStatus, derivedPrinted } = require('./print-events');

function libraryCounts(db) {
  const counts = { models: 0, printed: 0, queued: 0, printing: 0, printers: 0 };
  // Parts are counted with their model, not as models of their own.
  for (const row of db.prepare(`SELECT print_status, printed, print_count FROM models WHERE ${require('./model-parts').notPartSql(db)}`).iterate()) {
    counts.models += 1;
    const status = effectivePrintStatus(row);
    if (status === 'queued') counts.queued += 1;
    else if (status === 'printing') counts.printing += 1;
    if (derivedPrinted(status, row.print_count)) counts.printed += 1;
  }
  try {
    counts.printers = db.prepare('SELECT COUNT(*) AS n FROM printers').get().n;
  } catch (_) {
    /* no printers table yet */
  }
  // The library's banners (Phase 7 of docs/merge-10.md): models the spools cover, and new this week.
  counts.readyToPrint = 0;
  try {
    for (const fit of require('./filament-check').fitForLibrary(db).values()) if (fit.ready) counts.readyToPrint += 1;
  } catch (_) {
    /* no filament tables yet */
  }
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  try {
    counts.addedThisWeek = db.prepare(`SELECT COUNT(*) AS n FROM models WHERE dateAdded >= ? AND ${require('./model-parts').notPartSql(db)}`).get(weekAgo).n;
  } catch (_) {
    counts.addedThisWeek = 0;
  }
  return counts;
}

module.exports = { libraryCounts };
