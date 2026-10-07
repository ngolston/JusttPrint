'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const { normalizeColorHex } = require('../../core/filament-format');
const printEvents = require('../../core/print-events');

function getFilamentsForModel(modelId) {
  if (modelId == null) return [];
  return database.db.prepare(`
    SELECT f.id, f.name, f.vendor, f.material, f.color_hex, f.diameter
    FROM filaments f
    JOIN model_filaments mf ON mf.filament_id = f.id
    WHERE mf.model_id = ?
    ORDER BY f.vendor COLLATE NOCASE, f.name COLLATE NOCASE
  `).all(modelId);
}

async function getAllFilamentsHandler() {
  try {
    // Prints logged with each filament, and the last one (the Filament page's "last used").
    const hasPrints = database.db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('print_events', 'print_event_filaments')"
    ).get().n === 2;
    const printColumns = hasPrints
      ? `(SELECT COUNT(*) FROM print_event_filaments pef WHERE pef.filament_id = f.id) AS print_count,
        (SELECT MAX(pe.printed_at) FROM print_event_filaments pef JOIN print_events pe ON pe.id = pef.event_id WHERE pef.filament_id = f.id) AS last_used_at`
      : '0 AS print_count, NULL AS last_used_at';
    return database.db.prepare(`
      SELECT
        f.id, f.name, f.vendor, f.material, f.color_hex, f.diameter,
        COUNT(DISTINCT mf.model_id) as model_count,
        ${printColumns}
      FROM filaments f
      LEFT JOIN model_filaments mf ON f.id = mf.filament_id
      GROUP BY f.id
      ORDER BY f.vendor COLLATE NOCASE, f.name COLLATE NOCASE
    `).all();
  } catch (error) {
    console.error('Error getting filaments:', error);
    throw error;
  }
}

ipcMain.handle('get-all-filaments', getAllFilamentsHandler);

async function saveFilamentHandler(event, filament) {
  try {
    const name = String(filament?.name || '').trim();
    if (!name) throw new Error('Filament name is required');
    const vendor = String(filament?.vendor || '').trim() || null;
    const material = String(filament?.material || '').trim() || null;
    const colorHex = normalizeColorHex(filament?.color_hex) || null;
    const diameter = filament?.diameter == null || filament.diameter === '' ? 1.75 : Number(filament.diameter);
    const id = filament?.id != null ? Number(filament.id) : null;
    if (id) {
      const existing = database.db.prepare('SELECT id FROM filaments WHERE id = ?').get(id);
      if (!existing) throw new Error('Filament not found');
      database.db.prepare(`
        UPDATE filaments SET name = ?, vendor = ?, material = ?, color_hex = ?, diameter = ?
        WHERE id = ?
      `).run(name, vendor, material, colorHex, Number.isFinite(diameter) ? diameter : 1.75, id);
      return database.db.prepare('SELECT id, name, vendor, material, color_hex, diameter FROM filaments WHERE id = ?').get(id);
    }
    const result = database.db.prepare(`
      INSERT INTO filaments (name, vendor, material, color_hex, diameter, source)
      VALUES (?, ?, ?, ?, ?, 'manual')
    `).run(name, vendor, material, colorHex, Number.isFinite(diameter) ? diameter : 1.75);
    return database.db.prepare('SELECT id, name, vendor, material, color_hex, diameter FROM filaments WHERE id = ?').get(result.lastInsertRowid);
  } catch (error) {
    console.error('Error saving filament:', error);
    throw error;
  }
}

ipcMain.handle('save-filament', saveFilamentHandler);

async function deleteFilamentHandler(event, filamentId) {
  try {
    return database.db.transaction(() => {
      database.db.prepare('DELETE FROM model_filaments WHERE filament_id = ?').run(filamentId);
      printEvents.deletePrintEventFilamentsForFilament(database.db, filamentId);
      database.db.prepare('DELETE FROM filaments WHERE id = ?').run(filamentId);
      return true;
    })();
  } catch (error) {
    console.error('Error deleting filament:', error);
    throw error;
  }
}

ipcMain.handle('delete-filament', deleteFilamentHandler);

async function getModelFilamentsHandler(event, modelId) {
  try {
    return getFilamentsForModel(modelId);
  } catch (error) {
    console.error('Error getting model filaments:', error);
    throw error;
  }
}

ipcMain.handle('get-model-filaments', getModelFilamentsHandler);

module.exports = { deleteFilamentHandler, getAllFilamentsHandler, getFilamentsForModel, saveFilamentHandler };
