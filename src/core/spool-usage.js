'use strict';

/**
 * The spools a logged print used (docs/merge-10.md, Phase 4): print_event_spools rows, and the
 * grams taken off each spool in the same transaction as the print event. Deleting the event gives
 * the grams back.
 */

/** [{ spoolId, grams }] from Log Print, one entry per spool (grams added up), only real amounts. */
function normalizeSpoolUsage(list) {
  const bySpool = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const spoolId = Number(item && (item.spoolId ?? item.spool_id));
    const grams = Number(item && item.grams);
    if (!Number.isInteger(spoolId) || spoolId <= 0 || !Number.isFinite(grams) || grams <= 0) continue;
    bySpool.set(spoolId, Math.round(((bySpool.get(spoolId) || 0) + Math.min(grams, 100000)) * 100) / 100);
  }
  return [...bySpool].map(([spoolId, grams]) => ({ spoolId, grams }));
}

/**
 * Record what a print took from each spool and take it off them. A spool used from storage is now
 * in use. Sets the event's grams (filament_used_g) and plate. Call inside the event's transaction.
 */
function applySpoolUsage(db, eventId, list, { printedAt = new Date().toISOString(), plateIndex = null } = {}) {
  const usage = normalizeSpoolUsage(list);
  const insert = db.prepare('INSERT INTO print_event_spools (event_id, spool_id, grams) VALUES (?, ?, ?)');
  const take = db.prepare(
    `UPDATE spools SET used_weight = used_weight + ?, last_used_at = ?, first_used_at = COALESCE(first_used_at, ?),
       status = CASE status WHEN 'storage' THEN 'active' ELSE status END, updated_at = ? WHERE id = ?`
  );
  const now = new Date().toISOString();
  for (const { spoolId, grams } of usage) {
    if (!db.prepare('SELECT 1 FROM spools WHERE id = ?').get(spoolId)) throw new Error('A spool chosen for this print no longer exists');
    insert.run(eventId, spoolId, grams);
    take.run(grams, printedAt, printedAt, now, spoolId);
  }
  const plate = Number(plateIndex);
  db.prepare('UPDATE print_events SET filament_used_g = ?, plate_index = ? WHERE id = ?').run(
    usage.length ? Math.round(usage.reduce((sum, u) => sum + u.grams, 0) * 100) / 100 : null,
    Number.isInteger(plate) && plate > 0 ? plate : null,
    eventId
  );
  return usage;
}

/** Give a print's grams back to its spools (before the event is deleted). */
function restoreSpoolUsage(db, eventId) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'print_event_spools'").get();
  if (!exists) return;
  const giveBack = db.prepare('UPDATE spools SET used_weight = MAX(0, used_weight - ?), updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  for (const row of db.prepare('SELECT spool_id, grams FROM print_event_spools WHERE event_id = ? AND spool_id IS NOT NULL').all(eventId)) {
    giveBack.run(row.grams, now, row.spool_id);
  }
}

/** The spools a print used, with their names and colors, for its history row. */
function spoolsForEvents(db, eventIds) {
  if (!eventIds.length) return new Map();
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'print_event_spools'").get();
  if (!exists) return new Map();
  const rows = db
    .prepare(
      `SELECT pes.event_id, pes.spool_id, pes.grams, s.name, s.material, s.color_hex, p.name AS profile_name
       FROM print_event_spools pes LEFT JOIN spools s ON s.id = pes.spool_id LEFT JOIN filament_profiles p ON p.id = s.profile_id
       WHERE pes.event_id IN (SELECT value FROM json_each(?)) ORDER BY pes.id`
    )
    .all(JSON.stringify(eventIds));
  const out = new Map();
  for (const row of rows) {
    const list = out.get(row.event_id) || [];
    list.push({ spoolId: row.spool_id, grams: row.grams, name: row.name || row.profile_name || row.material || 'Deleted spool', color: row.color_hex });
    out.set(row.event_id, list);
  }
  return out;
}

module.exports = { normalizeSpoolUsage, applySpoolUsage, restoreSpoolUsage, spoolsForEvents };
