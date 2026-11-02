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

/** A tray as the printer last reported it, for the slot to show: { type, color } or null. */
function printerTray(value) {
  if (!value || value === 'empty') return null;
  const tray = parseTray(value);
  return tray ? { type: tray.type || null, color: tray.color || null } : null;
}

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
        // The printer's own number for this AMS, when it reports it (Bambu live status).
        live_id: /^bambu-ams:\d+$/.test(String(unit.source_ref || '')) ? Number(String(unit.source_ref).slice(10)) : null,
        name: unit.name || `AMS ${unit.unit_index + 1}`,
        humidity: unit.humidity,
        slots: slots
          .filter((slot) => slot.unit_id === unit.id)
          .map((slot) => ({
            id: slot.id,
            slot_index: slot.slot_index,
            label: `${String.fromCharCode(65 + (unit.unit_index % 26))}${slot.slot_index + 1}`,
            spool: slot.spool_id ? spoolById.get(slot.spool_id) || null : null,
            // What the printer last said is in the tray: { type, color } or null (empty or not known).
            printer_tray: printerTray(slot.live_tray)
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
    // A Bambu spool's RFID, as the printer last saw it there: the spool is found by it next time.
    if (spool && hasLiveColumns(db)) {
      const row = slotId
        ? db.prepare('SELECT live_tray FROM printer_ams_slots WHERE id = ?').get(slotId)
        : db.prepare('SELECT live_tray FROM printers WHERE id = ?').get(printerId);
      rememberTray(db, spool.id, parseTray(row && row.live_tray));
    }
  })();
}

// ---- Bambu Lab live status (src/server/bambu-live.js) ----

const hasLiveColumns = (db) =>
  db
    .prepare('PRAGMA table_info(printer_ams_slots)')
    .all()
    .some((c) => c.name === 'live_tray');

/** @returns {{ type: string | null, color: string | null, uuid: string | null } | null} */
function parseTray(textValue) {
  if (!textValue) return null;
  try {
    const tray = JSON.parse(textValue);
    return tray && typeof tray === 'object' ? tray : null;
  } catch (_) {
    return null;
  }
}

/** What a tray holds, as stored: 'empty', or its type, color and RFID. */
const traySignature = (tray) => (tray ? JSON.stringify({ type: tray.type || null, color: tray.color || null, uuid: tray.uuid || null }) : 'empty');

const materialKey = (value) =>
  String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

function rgbOf(hex) {
  const m = /^#?([0-9a-f]{6})/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Color distance, or null when either color is not known. */
function colorGap(a, b) {
  const x = rgbOf(a);
  const y = rgbOf(b);
  if (!x || !y) return null;
  return Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2);
}

/** Colors this close are the same filament color, as the printer and the spool write them. */
const SAME_COLOR = 60;

/** The spool is what the tray holds: the same RFID, or the same material and a close color. */
function spoolFitsTray(spool, tray) {
  if (!spool || !tray) return false;
  if (tray.uuid && spool.bambu_tray_uuid) return tray.uuid === spool.bambu_tray_uuid;
  if (!tray.type || materialKey(spool.material) !== materialKey(tray.type)) return false;
  const gap = colorGap(spool.color_hex, tray.color);
  return gap === null || gap <= SAME_COLOR;
}

function rememberTray(db, spoolId, tray) {
  if (!tray || !tray.uuid) return;
  db.prepare('UPDATE spools SET bambu_tray_uuid = NULL WHERE bambu_tray_uuid = ? AND id != ?').run(tray.uuid, spoolId);
  db.prepare('UPDATE spools SET bambu_tray_uuid = ? WHERE id = ?').run(tray.uuid, spoolId);
}

/**
 * The spool a tray holds: the one with its RFID, else the closest in color of the spools of its
 * material that are loaded nowhere (opened ones first, then the one with less left). Null when
 * none fits.
 */
function findSpoolForTray(db, tray) {
  if (!tray) return null;
  if (tray.uuid) {
    const known = db.prepare("SELECT id FROM spools WHERE bambu_tray_uuid = ? AND status != 'archived'").get(tray.uuid);
    if (known) return known.id;
  }
  if (!tray.type) return null;
  const loose = db
    .prepare(
      `SELECT id, material, color_hex, status, initial_weight - used_weight AS remaining, bambu_tray_uuid FROM spools
       WHERE status != 'archived'
         AND id NOT IN (SELECT spool_id FROM printer_ams_slots WHERE spool_id IS NOT NULL)
         AND id NOT IN (SELECT direct_spool_id FROM printers WHERE direct_spool_id IS NOT NULL)`
    )
    .all()
    // A spool with an RFID is that one Bambu spool: another tray's RFID is not it.
    .filter((spool) => !(spool.bambu_tray_uuid && tray.uuid && spool.bambu_tray_uuid !== tray.uuid))
    .filter((spool) => spoolFitsTray({ ...spool, bambu_tray_uuid: null }, tray));
  loose.sort(
    (a, b) =>
      (colorGap(a.color_hex, tray.color) ?? SAME_COLOR) - (colorGap(b.color_hex, tray.color) ?? SAME_COLOR) ||
      (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) ||
      a.remaining - b.remaining ||
      a.id - b.id
  );
  return loose.length ? loose[0].id : null;
}

/**
 * Bring one slot (or the holder) in line with the printer. Only a tray that changed since the
 * printer last said is acted on, so a spool loaded by hand stays until the filament there changes;
 * an empty tray is always emptied. Returns true when the loaded spool changed.
 * @param {any} db
 * @param {{ slotId?: number, printerId?: number }} where
 * @param {{ type: string | null, color: string | null, uuid: string | null } | null} tray null: empty
 */
function syncTray(db, where, tray) {
  const row = where.slotId
    ? db.prepare('SELECT spool_id, live_tray FROM printer_ams_slots WHERE id = ?').get(where.slotId)
    : db.prepare('SELECT direct_spool_id AS spool_id, live_tray FROM printers WHERE id = ?').get(where.printerId);
  if (!row) return false;
  const signature = traySignature(tray);
  const firstTime = row.live_tray === null || row.live_tray === undefined;
  if (row.live_tray === signature) return false;
  const saveSignature = () =>
    where.slotId
      ? db.prepare('UPDATE printer_ams_slots SET live_tray = ? WHERE id = ?').run(signature, where.slotId)
      : db.prepare('UPDATE printers SET live_tray = ? WHERE id = ?').run(signature, where.printerId);
  const current = row.spool_id ? db.prepare('SELECT id, material, color_hex, bambu_tray_uuid FROM spools WHERE id = ?').get(row.spool_id) : null;
  const next = !tray ? null : current && (firstTime || spoolFitsTray(current, tray)) ? current.id : findSpoolForTray(db, tray);
  saveSignature();
  if (next === (current ? current.id : null)) {
    if (next) rememberTray(db, next, tray);
    return false;
  }
  loadSpool(db, where, next);
  return true;
}

/**
 * What a Bambu printer says its AMS units and holder hold (src/server/bambu-live.js
 * `amsFromReport`): units are made and named after the printer's own (AMS 1…), get their
 * humidity, and their slots follow the trays. Returns true when anything loaded changed.
 * @param {any} db
 * @param {number} printerId
 * @param {{ units: { id: number, name?: string | null, humidity: number | null, trays: ({ type: string | null, color: string | null, uuid: string | null } | null)[] }[], external?: { type: string | null, color: string | null, uuid: string | null } | null | undefined }} report
 */
function syncFromPrinter(db, printerId, report) {
  if (!hasLiveColumns(db) || !db.prepare('SELECT 1 FROM printers WHERE id = ?').get(printerId)) return false;
  let changed = false;
  db.transaction(() => {
    for (const unit of report.units || []) {
      const ref = `bambu-ams:${unit.id}`;
      let row = db.prepare('SELECT * FROM printer_ams_units WHERE printer_id = ? AND source_ref = ?').get(printerId, ref);
      if (!row && unit.id < MAX_UNITS) {
        // A unit made by hand or by Import from Bambu Lab, at the same place: this one.
        row = db
          .prepare("SELECT * FROM printer_ams_units WHERE printer_id = ? AND unit_index = ? AND (source_ref IS NULL OR source_ref NOT LIKE 'bambu-ams:%')")
          .get(printerId, unit.id);
        if (row) db.prepare('UPDATE printer_ams_units SET source_ref = ? WHERE id = ?').run(ref, row.id);
      }
      if (!row) {
        let unitId;
        try {
          unitId = addAmsUnit(db, printerId, { name: unit.name || null, slots: Math.max(1, unit.trays.length) });
        } catch (_) {
          continue; // at most MAX_UNITS
        }
        db.prepare('UPDATE printer_ams_units SET source_ref = ? WHERE id = ?').run(ref, unitId);
        row = db.prepare('SELECT * FROM printer_ams_units WHERE id = ?').get(unitId);
      }
      if (unit.humidity !== null && unit.humidity !== undefined && unit.humidity !== row.humidity) {
        db.prepare('UPDATE printer_ams_units SET humidity = ? WHERE id = ?').run(unit.humidity, row.id);
      }
      unit.trays.forEach((tray, index) => {
        if (index >= MAX_SLOTS) return;
        let slot = db.prepare('SELECT id FROM printer_ams_slots WHERE unit_id = ? AND slot_index = ?').get(row.id, index);
        if (!slot) {
          const id = db.prepare('INSERT INTO printer_ams_slots (unit_id, slot_index) VALUES (?, ?)').run(row.id, index).lastInsertRowid;
          slot = { id: Number(id) };
        }
        if (syncTray(db, { slotId: slot.id }, tray)) changed = true;
      });
    }
    if (report.external !== undefined && syncTray(db, { printerId }, report.external)) changed = true;
  })();
  return changed;
}

module.exports = {
  getPrinterLoads,
  addAmsUnit,
  updateAmsUnit,
  removeAmsUnit,
  loadSpool,
  syncFromPrinter,
  spoolFitsTray,
  MAX_UNITS,
  MAX_SLOTS
};
