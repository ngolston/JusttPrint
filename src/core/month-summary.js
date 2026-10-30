'use strict';

/**
 * Home's This month tile (docs/merge-10.md, Phase 7): logged prints since the first of the month
 * (copies counted), how many worked, the filament they took off spools, and prints per week for
 * the last four weeks.
 */

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** @param {any} db @param {Date} [now] */
function monthSummary(db, now = new Date()) {
  const since = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const rows = db.prepare('SELECT id, outcome, quantity, printed_at FROM print_events WHERE printed_at >= ?').all(since);
  const copies = (outcome) => rows.filter((row) => row.outcome === outcome).reduce((sum, row) => sum + (Number(row.quantity) || 1), 0);
  const printed = copies('printed');
  const failed = copies('failed');
  const hasSpools = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'print_event_spools'").get();
  const grams = hasSpools
    ? Number(
        db
          .prepare('SELECT COALESCE(SUM(s.grams), 0) AS g FROM print_event_spools s JOIN print_events e ON e.id = s.event_id WHERE e.printed_at >= ?')
          .get(since).g
      ) || 0
    : 0;
  const end = now.getTime();
  const weeks = [3, 2, 1, 0].map((back) => {
    const to = end - back * WEEK_MS;
    const from = to - WEEK_MS;
    const count = db
      .prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM print_events WHERE printed_at > ? AND printed_at <= ?')
      .get(new Date(from).toISOString(), new Date(to).toISOString()).n;
    return { start: new Date(from).toISOString(), prints: Number(count) || 0 };
  });
  return {
    since,
    prints: rows.reduce((sum, row) => sum + (Number(row.quantity) || 1), 0),
    printed,
    failed,
    successRate: printed + failed ? Math.round((printed / (printed + failed)) * 100) : null,
    grams: Math.round(grams * 10) / 10,
    weeks
  };
}

module.exports = { monthSummary };
