'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const spoolman = require('../../core/spoolman');
const printEvents = require('../../core/print-events');

function getFilamentsForModel(modelId) {
  if (modelId == null) return [];
  return database.db.prepare(`
    SELECT f.id, f.name, f.vendor, f.material, f.color_hex, f.diameter, f.spoolman_id, f.source
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
        f.id, f.name, f.vendor, f.material, f.color_hex, f.diameter, f.spoolman_id, f.source,
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
    const colorHex = spoolman.normalizeColorHex(filament?.color_hex) || null;
    const diameter = filament?.diameter == null || filament.diameter === '' ? 1.75 : Number(filament.diameter);
    const id = filament?.id != null ? Number(filament.id) : null;
    if (id) {
      const existing = database.db.prepare('SELECT id, source FROM filaments WHERE id = ?').get(id);
      if (!existing) throw new Error('Filament not found');
      if (existing.source === 'spoolman') {
        throw new Error('Synced filaments are edited in Spoolman. Sync again to update them here.');
      }
      database.db.prepare(`
        UPDATE filaments SET name = ?, vendor = ?, material = ?, color_hex = ?, diameter = ?
        WHERE id = ?
      `).run(name, vendor, material, colorHex, Number.isFinite(diameter) ? diameter : 1.75, id);
      return database.db.prepare('SELECT * FROM filaments WHERE id = ?').get(id);
    }
    const result = database.db.prepare(`
      INSERT INTO filaments (name, vendor, material, color_hex, diameter, spoolman_id, source)
      VALUES (?, ?, ?, ?, ?, NULL, 'manual')
    `).run(name, vendor, material, colorHex, Number.isFinite(diameter) ? diameter : 1.75);
    return database.db.prepare('SELECT * FROM filaments WHERE id = ?').get(result.lastInsertRowid);
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

function readSpoolmanSettings(urlOverride, tokenOverride) {
  const urlRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('spoolmanUrl');
  const tokenRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('spoolmanApiToken');
  const url = urlOverride != null && String(urlOverride).trim() !== '' ? String(urlOverride).trim() : (urlRow?.value || '');
  const token = tokenOverride != null ? String(tokenOverride) : (tokenRow?.value || '');
  return { url, token };
}

async function testSpoolmanConnectionHandler(event, url, token) {
  const settings = readSpoolmanSettings(url, token);
  if (!settings.url) throw new Error('Spoolman URL is required');
  return await spoolman.testConnection(settings.url, settings.token);
}

ipcMain.handle('test-spoolman-connection', testSpoolmanConnectionHandler);

async function syncSpoolmanFilamentsHandler(event, url, token) {
  const settings = readSpoolmanSettings(url, token);
  if (!settings.url) throw new Error('Spoolman URL is required');
  if (url != null && String(url).trim()) {
    database.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('spoolmanUrl', String(url).trim());
  }
  if (token !== undefined) {
    database.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('spoolmanApiToken', String(token || ''));
  }
  const remote = await spoolman.fetchAllFilaments(settings.url, settings.token);
  let created = 0;
  let updated = 0;
  database.db.transaction(() => {
    const selectBySpoolman = database.db.prepare('SELECT id FROM filaments WHERE spoolman_id = ?');
    const insertStmt = database.db.prepare(`
      INSERT INTO filaments (name, vendor, material, color_hex, diameter, spoolman_id, source)
      VALUES (?, ?, ?, ?, ?, ?, 'spoolman')
    `);
    const updateStmt = database.db.prepare(`
      UPDATE filaments SET name = ?, vendor = ?, material = ?, color_hex = ?, diameter = ?, source = 'spoolman'
      WHERE id = ?
    `);
    for (const filament of remote) {
      const existing = selectBySpoolman.get(filament.spoolman_id);
      if (existing) {
        updateStmt.run(filament.name, filament.vendor, filament.material, filament.color_hex, filament.diameter, existing.id);
        updated += 1;
      } else {
        insertStmt.run(filament.name, filament.vendor, filament.material, filament.color_hex, filament.diameter, filament.spoolman_id);
        created += 1;
      }
    }
  })();
  return { success: true, total: remote.length, created, updated };
}

ipcMain.handle('sync-spoolman-filaments', syncSpoolmanFilamentsHandler);

module.exports = { deleteFilamentHandler, getAllFilamentsHandler, getFilamentsForModel, saveFilamentHandler, syncSpoolmanFilamentsHandler };
