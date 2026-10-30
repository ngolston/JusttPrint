'use strict';

/** Drying spools (docs/merge-10.md, Phase 3): one session at a time per spool, finished by hand. */

const v = require('./filament-values');

/** Sessions still running, oldest first, with their spool's name and color. */
function listActiveDrying(db) {
  return db
    .prepare(
      `SELECT d.*, s.name AS spool_name, s.material, s.color_hex, p.name AS profile_name
       FROM drying_sessions d JOIN spools s ON s.id = d.spool_id LEFT JOIN filament_profiles p ON p.id = s.profile_id
       WHERE d.finished_at IS NULL ORDER BY d.started_at, d.id`
    )
    .all();
}

/** Start drying a spool. Temperature and time default to its filament's drying settings. */
function startDrying(db, spoolId, input = {}) {
  const spool = db
    .prepare('SELECT s.id, s.status, p.drying_temp, p.drying_hours FROM spools s LEFT JOIN filament_profiles p ON p.id = s.profile_id WHERE s.id = ?')
    .get(spoolId);
  if (!spool) throw new Error('That spool no longer exists');
  if (spool.status === 'archived') throw new Error('An archived spool cannot be dried');
  if (db.prepare('SELECT 1 FROM drying_sessions WHERE spool_id = ? AND finished_at IS NULL').get(spoolId)) throw new Error('This spool is already drying');
  const temp = v.number(input.drying_temp, 'Temperature', { min: 20, max: 150 }) ?? spool.drying_temp ?? null;
  const hours = v.number(input.target_hours, 'Time', { min: 0.25, max: 200 }) ?? spool.drying_hours ?? null;
  if (temp === null || hours === null) throw new Error('Enter the drying temperature and time');
  const info = db
    .prepare('INSERT INTO drying_sessions (spool_id, drying_temp, target_hours, started_at, humidity_before, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(spoolId, Math.round(temp), hours, v.now(), v.number(input.humidity_before, 'Humidity', { min: 0, max: 100 }), v.text(input.notes, 1000));
  return db.prepare('SELECT * FROM drying_sessions WHERE id = ?').get(info.lastInsertRowid);
}

/** Finish a session (taken out of the dryer), with the humidity after if measured. */
function finishDrying(db, sessionId, input = {}) {
  const changed = db
    .prepare('UPDATE drying_sessions SET finished_at = ?, humidity_after = ?, notes = COALESCE(?, notes) WHERE id = ? AND finished_at IS NULL')
    .run(v.now(), v.number(input.humidity_after, 'Humidity', { min: 0, max: 100 }), v.text(input.notes, 1000), sessionId).changes;
  if (!changed) throw new Error('That drying session has already finished');
  return db.prepare('SELECT * FROM drying_sessions WHERE id = ?').get(sessionId);
}

module.exports = { listActiveDrying, startDrying, finishDrying };
