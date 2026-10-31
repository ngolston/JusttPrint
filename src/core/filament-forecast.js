'use strict';

/**
 * When each spool runs out (docs/plan-10.1.md, Phase 7): the grams logged prints took off it over
 * the last 30 days (print_event_spools), as a rate per day, and the day its grams left last at
 * that rate. Spools not used in that time have no forecast: nothing says how fast they go.
 */

const WINDOW_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

/** Grams per spool used by prints logged in the last `days` days, by spool id. */
function recentUse(db, now = new Date(), days = WINDOW_DAYS) {
  const since = new Date(now.getTime() - days * DAY_MS).toISOString();
  /** @type {Map<number, number>} */
  const used = new Map();
  try {
    for (const row of db
      .prepare(
        `SELECT pes.spool_id AS id, SUM(pes.grams) AS grams FROM print_event_spools pes JOIN print_events pe ON pe.id = pes.event_id
         WHERE pes.spool_id IS NOT NULL AND pe.printed_at >= ? AND pe.printed_at <= ? GROUP BY pes.spool_id`
      )
      .all(since, now.toISOString())) {
      used.set(Number(row.id), Number(row.grams) || 0);
    }
  } catch (_) {
    /* no print log tables (a database before 10.0) */
  }
  return used;
}

/**
 * A spool's forecast from its grams left and the grams used in the window: grams per day, days
 * left and the day it runs out (ISO date), or null when it was not used (or is archived).
 */
function forecastOf(spool, usedGrams, now = new Date(), days = WINDOW_DAYS) {
  if (!spool || spool.status === 'archived' || !(usedGrams > 0)) return null;
  const perDay = usedGrams / days;
  const daysLeft = Math.max(0, Number(spool.remaining) || 0) / perDay;
  return {
    perDay: Math.round(perDay * 10) / 10,
    daysLeft: Math.round(daysLeft * 10) / 10,
    runsOut: new Date(now.getTime() + daysLeft * DAY_MS).toISOString().slice(0, 10)
  };
}

/** Spools that run out within `within` days at their recent rate, soonest first. */
function runningOut(spools, { within = 30 } = {}) {
  return spools.filter((s) => s.forecast && s.forecast.daysLeft <= within).sort((a, b) => a.forecast.daysLeft - b.forecast.daysLeft);
}

module.exports = { WINDOW_DAYS, recentUse, forecastOf, runningOut };
