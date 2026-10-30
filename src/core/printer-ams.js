'use strict';

/**
 * What is loaded in each printer (docs/merge-10.md, Phase 5): AMS units with their slots, and the
 * spool on the printer's own holder (printers.direct_spool_id). A spool is in one place at a time:
 * loading it somewhere takes it out of anywhere else. The filament check prefers spools loaded in
 * the printer you print on (filament-check.js).
 */

const MAX_UNITS = 8;
const MAX_SLOTS = 16;

const SPOOL_COLUMNS = `s.id, s.name, s.material, s.material_type, s.color_hex, s.initial_weight, s.used_weight, s.status,
  p.name AS profile_name, b.name AS brand_name`;
const SPOOL_JOINS = 'LEFT JOIN filament_profiles p ON p.id = s.profile_id LEFT JOIN filament_brands b ON b.id = s.brand_id';

/** A spool as a slot shows it: name, color, grams left. */
function slotSpool(row) {
  if (!row || row.id === null || row.id === undefined) return null;
  return {
    id: row.id,
    name: row.name || row.profile_name || [row.material, row.material_type].filter(Boolean).join(' ') || 'Spool',
    brand_name: row.brand_name || null,
    material: row.material,
    color_hex: row.color_hex,
    initial_weight: row.initial_weight,
    remaining: Math.max(0, (Number(row.initial_weight) || 0) - (Number(row.used_weight) || 0))
  };
}

/**
 * Every printer's loads (or one printer's): { printerId, direct, units: [{ id, unit_index, name,
 * humidity, slots: [{ id, slot_index, label, spool }] }] }. Slot labels are as Bambu writes them:
 * A1–A4 for the first unit, B1–B4 for the second.
 * @param {any} db
 * @param {number | null} [printerId]
 */
function getPrinterLoads(db, printerId = null) {
  const printers = db.prepare(`SELECT id, direct_spool_id FROM printers ${printerId ? 'WHERE id = ?' : ''} ORDER BY id`).all(...(printerId ? [printerId] : []));
  const spoolById = new Map(
    db
      .prepare(`SELECT ${SPOOL_COLUMNS} FROM spools s ${SPOOL_JOINS}`)
      .all()
      .map((row) => [row.id, slotSpool(row)])
  );
  const units = db
    .prepare(`SELECT * FROM printer_ams_units ${printerId ? 'WHERE printer_id = ?' : ''} ORDER BY printer_id, unit_index, id`)
    .all(...(printerId ? [printerId] : []));
  const slots = db.prepare('SELECT * FROM printer_ams_slots ORDER BY unit_id, slot_index').all();
  return printers.map((printer) => ({
    printerId: printer.id,
    direct: printer.direct_spool_id ? spoolById.get(printer.direct_spool_id) || null : null,
    units: units
      .filter((unit) => unit.printer_id === printer.id)
      .map((unit) => ({
        id: unit.id,
        unit_index: unit.unit_index,
        name: unit.name || `AMS ${unit.unit_index + 1}`,
        humidity: unit.humidity,
        slots: slots
          .filter((slot) => slot.unit_id === unit.id)
          .map((slot) => ({
            id: slot.id,
            slot_index: slot.slot_index,
            label: `${String.fromCharCode(65 + (unit.unit_index % 26))}${slot.slot_index + 1}`,
            spool: slot.spool_id ? spoolById.get(slot.spool_id) || null : null
          }))
      }))
  }));
}

/**
 * Add an AMS unit (the next letter) with `slots` empty slots (4, as an AMS has).
 * @param {any} db
 * @param {number} printerId
 * @param {{ name?: string | null, slots?: number }} [options]
 */
function addAmsUnit(db, printerId, options = {}) {
  const { name = null, slots = 4 } = options;
  if (!db.prepare('SELECT 1 FROM printers WHERE id = ?').get(printerId)) throw new Error('That printer no longer exists');
  const count = Math.min(MAX_SLOTS, Math.max(1, Math.floor(Number(slots) || 4)));
  return db.transaction(() => {
    const used = db
      .prepare('SELECT unit_index FROM printer_ams_units WHERE printer_id = ?')
      .all(printerId)
      .map((row) => row.unit_index);
    if (used.length >= MAX_UNITS) throw new Error(`A printer has at most ${MAX_UNITS} AMS units`);
    let index = 0;
    while (used.includes(index)) index++;
    const unitName =
      String(name || '')
        .trim()
        .slice(0, 100) || `AMS ${index + 1}`;
    const unitId = Number(
      db.prepare('INSERT INTO printer_ams_units (printer_id, unit_index, name) VALUES (?, ?, ?)').run(printerId, index, unitName).lastInsertRowid
    );
    const insert = db.prepare('INSERT INTO printer_ams_slots (unit_id, slot_index) VALUES (?, ?)');
    for (let i = 0; i < count; i++) insert.run(unitId, i);
    return unitId;
  })();
}

/**
 * Rename a unit or note its humidity (%).
 * @param {any} db
 * @param {number} unitId
 * @param {{ name?: string, humidity?: number | string | null }} [changes]
 */
function updateAmsUnit(db, unitId, changes = {}) {
  const { name, humidity } = changes;
  const unit = db.prepare('SELECT * FROM printer_ams_units WHERE id = ?').get(unitId);
  if (!unit) throw new Error('That AMS unit no longer exists');
  const nextName =
    name === undefined
      ? unit.name
      : String(name || '')
          .trim()
          .slice(0, 100) || `AMS ${unit.unit_index + 1}`;
  let nextHumidity = unit.humidity;
  if (humidity !== undefined) {
    const h = humidity === null || humidity === '' ? null : Number(humidity);
    if (h !== null && (!Number.isFinite(h) || h < 0 || h > 100)) throw new Error('Humidity is a percentage from 0 to 100');
    nextHumidity = h;
  }
  db.prepare('UPDATE printer_ams_units SET name = ?, humidity = ? WHERE id = ?').run(nextName, nextHumidity, unitId);
}

/** Remove a unit; its spools are then not loaded anywhere. */
function removeAmsUnit(db, unitId) {
  return db.prepare('DELETE FROM printer_ams_units WHERE id = ?').run(unitId).changes > 0;
}

/**
 * Load a spool into an AMS slot (`slotId`) or onto a printer's own holder (`printerId`), or empty
 * it (`spoolId` null). The spool leaves wherever else it was loaded, and is in use from now on.
 * @param {any} db
 * @param {{ slotId?: number | null, printerId?: number | null }} where
 * @param {number | null} spoolId
 */
function loadSpool(db, where, spoolId) {
  const slotId = where && Number(where.slotId) > 0 ? Number(where.slotId) : null;
  const printerId = where && Number(where.printerId) > 0 ? Number(where.printerId) : null;
  if (!slotId && !printerId) throw new Error('Say which slot or printer');
  const spool = spoolId ? db.prepare('SELECT id, status FROM spools WHERE id = ?').get(spoolId) : null;
  if (spoolId && !spool) throw new Error('That spool no longer exists');
  if (spool && spool.status === 'archived') throw new Error('An archived spool cannot be loaded; bring it back first');
  db.transaction(() => {
    if (spool) {
      db.prepare('UPDATE printer_ams_slots SET spool_id = NULL WHERE spool_id = ?').run(spool.id);
      db.prepare('UPDATE printers SET direct_spool_id = NULL WHERE direct_spool_id = ?').run(spool.id);
      db.prepare("UPDATE spools SET status = 'active', updated_at = ? WHERE id = ?").run(new Date().toISOString(), spool.id);
    }
    const changed = slotId
      ? db.prepare('UPDATE printer_ams_slots SET spool_id = ? WHERE id = ?').run(spool ? spool.id : null, slotId).changes
      : db.prepare('UPDATE printers SET direct_spool_id = ? WHERE id = ?').run(spool ? spool.id : null, printerId).changes;
    if (!changed) throw new Error(slotId ? 'That AMS slot no longer exists' : 'That printer no longer exists');
  })();
}

module.exports = { getPrinterLoads, addAmsUnit, updateAmsUnit, removeAmsUnit, loadSpool, MAX_UNITS, MAX_SLOTS };
