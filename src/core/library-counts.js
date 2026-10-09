'use strict';

/**
 * Library counts for the sidebar's Queue badge and the dashboard's figures: every model, how many
 * have been printed, and how many are queued or printing (the same rules as the cards' badges).
 */

const { effectivePrintStatus, derivedPrinted } = require('./print-events');

function libraryCounts(db) {
  const counts = { models: 0, printed: 0, queued: 0, printing: 0, printers: 0 };
  for (const row of db.prepare('SELECT print_status, printed, print_count FROM models').iterate()) {
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
  return counts;
}

module.exports = { libraryCounts };
