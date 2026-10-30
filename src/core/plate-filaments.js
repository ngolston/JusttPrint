'use strict';

/**
 * What each model's plates need (model_plate_filaments; docs/merge-10.md, Phase 4), written by
 * the plate job (src/server/plate-filament-job.js) and read by the filament check and Log Print.
 * Plate 0 means every plate (an unsliced painted project, a MakerWorld print profile).
 */

/** Replace a model's plate filaments with `rows` [{ plate, slot, material, color, grams }]. */
function replacePlateFilaments(db, modelId, source, rows) {
  db.transaction(() => {
    db.prepare('DELETE FROM model_plate_filaments WHERE model_id = ?').run(modelId);
    const insert = db.prepare(
      'INSERT OR REPLACE INTO model_plate_filaments (model_id, plate_index, slot, material, color_hex, grams, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const row of rows) insert.run(modelId, row.plate, row.slot, row.material ?? null, row.color ?? null, row.grams ?? null, source);
  })();
}

/** A model's rows, by plate then slot. */
function getPlateFilaments(db, modelId) {
  return db
    .prepare('SELECT plate_index, slot, material, color_hex, grams, source FROM model_plate_filaments WHERE model_id = ? ORDER BY plate_index, slot')
    .all(modelId);
}

/**
 * What printing a model needs, one entry per slot: { slot, material, color, grams }. For some
 * plates (`plates` from 1: one, or a list) their own rows and the every-plate rows; for the whole
 * model (null) every row. Grams are added up per slot, null when any plate's are not known.
 * @param {{ plate_index: number, slot: number, material: string | null, color_hex: string | null, grams: number | null }[]} rows
 * @param {number | number[] | null} [plates]
 */
function needsFrom(rows, plates = null) {
  const only = plates === null || plates === undefined ? null : new Set(Array.isArray(plates) ? plates : [plates]);
  const bySlot = new Map();
  for (const row of rows) {
    if (only && row.plate_index !== 0 && !only.has(row.plate_index)) continue;
    const known = bySlot.get(row.slot);
    if (!known) bySlot.set(row.slot, { slot: row.slot, material: row.material, color: row.color_hex, grams: row.grams });
    else known.grams = known.grams === null || row.grams === null ? null : Math.round((known.grams + row.grams) * 100) / 100;
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot);
}

/** The plates a model has (from 1), for Log Print's plate choice; empty when only plate 0 is known. */
function platesOf(rows) {
  return [...new Set(rows.map((row) => row.plate_index).filter((plate) => plate > 0))].sort((a, b) => a - b);
}

module.exports = { replacePlateFilaments, getPlateFilaments, needsFrom, platesOf };
