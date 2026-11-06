'use strict';

/**
 * Failure analysis (Statistics): how often prints fail, by what they had in common: the printer,
 * the filament's material and brand, the AMS humidity (recorded for prints a Bambu printer logged
 * by itself), how long the print ran, and the time of day. Findings are the groups that fail
 * clearly more often than the rest, in words. Cancelled prints count as neither.
 */

/** A group needs this many prints, and this many failures, before it can be a finding. */
const MIN_PRINTS = 5;
const MIN_FAILED = 2;
/** …and to fail this many times as often as the prints overall. */
const RATIO = 1.5;

const HUMIDITY = [
  [0, 30, 'Under 30%'],
  [30, 40, '30–40%'],
  [40, 50, '40–50%'],
  [50, 101, '50% or more']
];
const DURATION = [
  [0, 3600, 'Under 1 h'],
  [3600, 4 * 3600, '1–4 h'],
  [4 * 3600, 8 * 3600, '4–8 h'],
  [8 * 3600, Infinity, '8 h or more']
];
const TIME_OF_DAY = [
  [5, 12, 'Morning'],
  [12, 17, 'Afternoon'],
  [17, 22, 'Evening'],
  [22, 29, 'Night']
];

const bucket = (value, ranges) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const found = ranges.find(([from, to]) => Number(value) >= from && Number(value) < to);
  return found ? found[2] : null;
};

/** The local hour a print started (or ended, when its start is not known). */
function hourOf(row) {
  const when = new Date(String(row.started_at || row.printed_at).replace(' ', 'T'));
  if (Number.isNaN(when.getTime())) return null;
  const hour = when.getHours();
  return hour < 5 ? hour + 24 : hour;
}

/**
 * @param {any} db
 * @param {{ since?: string | null }} [options] only prints from this time (ISO), else all
 */
function failureAnalysis(db, options = {}) {
  let columns;
  try {
    columns = new Set(
      db
        .prepare('PRAGMA table_info(print_events)')
        .all()
        .map((c) => c.name)
    );
  } catch (_) {
    columns = new Set();
  }
  const col = (name) => (columns.has(name) ? `e.${name}` : 'NULL');
  const rows = db
    .prepare(
      `SELECT e.id, e.outcome, e.printed_at, ${col('started_at')} AS started_at, ${col('duration_seconds')} AS duration_seconds,
         ${col('ams_humidity')} AS ams_humidity, p.nickname AS printer
       FROM print_events e LEFT JOIN printers p ON p.id = ${col('printer_id')}
       WHERE e.outcome IN ('printed', 'failed') ${options.since ? 'AND julianday(e.printed_at) >= julianday(?)' : ''}`
    )
    .all(...(options.since ? [options.since] : []));
  // The filament each print used (its spools), by material and brand.
  const filament = new Map();
  try {
    for (const row of db
      .prepare(
        `SELECT u.event_id, COALESCE(NULLIF(s.material, ''), s.material_type) AS material, b.name AS brand
         FROM print_event_spools u JOIN spools s ON s.id = u.spool_id LEFT JOIN filament_brands b ON b.id = s.brand_id`
      )
      .all()) {
      const list = filament.get(row.event_id) || [];
      list.push(row);
      filament.set(row.event_id, list);
    }
  } catch (_) {
    /* no filament tables */
  }

  const total = rows.length;
  const failed = rows.filter((row) => row.outcome === 'failed').length;
  const overall = total ? failed / total : 0;

  /** @type {Record<string, Map<string, { prints: number, failed: number }>>} */
  const groups = { printer: new Map(), material: new Map(), brand: new Map(), humidity: new Map(), duration: new Map(), timeOfDay: new Map() };
  const add = (kind, label, row) => {
    if (!label) return;
    const entry = groups[kind].get(label) || { prints: 0, failed: 0 };
    entry.prints += 1;
    if (row.outcome === 'failed') entry.failed += 1;
    groups[kind].set(label, entry);
  };
  for (const row of rows) {
    add('printer', row.printer, row);
    const used = filament.get(row.id) || [];
    for (const material of new Set(used.map((u) => u.material).filter(Boolean))) add('material', String(material).toUpperCase(), row);
    for (const brand of new Set(used.map((u) => u.brand).filter(Boolean))) add('brand', brand, row);
    add('humidity', bucket(row.ams_humidity, HUMIDITY), row);
    add('duration', bucket(row.duration_seconds, DURATION), row);
    add('timeOfDay', bucket(hourOf(row), TIME_OF_DAY), row);
  }

  const order = { humidity: HUMIDITY, duration: DURATION, timeOfDay: TIME_OF_DAY };
  const out = {};
  for (const [kind, map] of Object.entries(groups)) {
    const list = [...map.entries()].map(([label, { prints, failed: lost }]) => ({ label, prints, failed: lost, rate: prints ? lost / prints : 0 }));
    const ranges = order[kind];
    list.sort(ranges ? (a, b) => ranges.findIndex((r) => r[2] === a.label) - ranges.findIndex((r) => r[2] === b.label) : (a, b) => b.prints - a.prints);
    out[kind] = list;
  }

  const WORDS = {
    printer: (label) => `on ${label}`,
    material: (label) => `in ${label}`,
    brand: (label) => `with ${label} filament`,
    humidity: (label) => `with the AMS at ${label.toLowerCase()} humidity`,
    duration: (label) => `that run ${label.toLowerCase()}`,
    timeOfDay: (label) => `started in the ${label.toLowerCase()}`
  };
  const findings = [];
  for (const [kind, list] of Object.entries(out)) {
    for (const group of list) {
      if (group.prints < MIN_PRINTS || group.failed < MIN_FAILED || !overall) continue;
      const times = group.rate / overall;
      if (times < RATIO) continue;
      findings.push({
        kind,
        label: group.label,
        rate: group.rate,
        times,
        text: `Prints ${WORDS[kind](group.label)} fail ${Math.round(group.rate * 100)}% of the time (${group.failed} of ${group.prints}), ${
          times >= 1.95 ? `${Math.round(times * 10) / 10} times as often as` : `${Math.round((times - 1) * 100)}% more often than`
        } your prints overall.`
      });
    }
  }
  findings.sort((a, b) => b.times - a.times);
  return {
    total,
    failed,
    rate: overall,
    groups: out,
    findings: findings.slice(0, 6),
    humidityKnown: rows.some((row) => row.ams_humidity !== null && row.ams_humidity !== undefined)
  };
}

module.exports = { failureAnalysis, MIN_PRINTS };
