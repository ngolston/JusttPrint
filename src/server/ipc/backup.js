'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const spoolman = require('../../../spoolman');
const { getDatabasePath } = require('../../core/db-path');
const { saveModel } = require('./models');

function upsertImportedFilament(filament) {
  if (!filament || typeof filament !== 'object') return null;
  const name = String(filament.name || '').trim();
  if (!name) return null;
  const vendor = String(filament.vendor || '').trim() || null;
  const material = String(filament.material || '').trim() || null;
  const colorHex = spoolman.normalizeColorHex(filament.color_hex) || null;
  const diameter = filament.diameter == null || filament.diameter === '' ? null : Number(filament.diameter);
  const spoolmanId = filament.spoolman_id != null && filament.spoolman_id !== '' ? Number(filament.spoolman_id) : null;
  const source = spoolmanId ? 'spoolman' : (filament.source === 'spoolman' ? 'spoolman' : 'manual');

  if (spoolmanId) {
    const existing = database.db.prepare('SELECT id FROM filaments WHERE spoolman_id = ?').get(spoolmanId);
    if (existing) {
      database.db.prepare(`
        UPDATE filaments SET name = ?, vendor = ?, material = ?, color_hex = ?, diameter = ?, source = 'spoolman'
        WHERE id = ?
      `).run(name, vendor, material, colorHex, Number.isFinite(diameter) ? diameter : null, existing.id);
      return existing.id;
    }
  }

  const existingManual = database.db.prepare(`
    SELECT id FROM filaments
    WHERE name = ?
      AND IFNULL(vendor, '') = IFNULL(?, '')
      AND IFNULL(material, '') = IFNULL(?, '')
      AND IFNULL(color_hex, '') = IFNULL(?, '')
      AND spoolman_id IS NULL
  `).get(name, vendor, material, colorHex);
  if (existingManual) return existingManual.id;

  const result = database.db.prepare(`
    INSERT INTO filaments (name, vendor, material, color_hex, diameter, spoolman_id, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, vendor, material, colorHex, Number.isFinite(diameter) ? diameter : null, spoolmanId || null, source);
  return result.lastInsertRowid;
}

// Update the backup-database handler
ipcMain.handle('backup-database', async () => {
  try {
    const dbPath = getDatabasePath();
    const dbDir = path.dirname(dbPath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(dbDir, `printventory-backup-${timestamp}.db`);

    if (database.db.open) {
      database.db.close();
    }

    await fs.promises.copyFile(dbPath, backupPath);

    database.db = new Database(dbPath);

    return { success: true, filePath: backupPath };
  } catch (error) {
    console.error('Backup error:', error);
    try {
      const dbPath = getDatabasePath();
      database.db = new Database(dbPath);
    } catch (reopenError) {
      console.error('Error reopening database:', reopenError);
    }
    return { success: false, message: error.message };
  }
});

/** Throws unless the file is a readable SQLite database with a models table. */
function checkBackupFile(filePath) {
  let candidate;
  try {
    candidate = new Database(filePath, { readonly: true, fileMustExist: true });
    const check = candidate.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new Error(`the database is damaged (${check})`);
    const models = candidate.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='models'").get();
    if (!models) throw new Error('it has no models table');
  } catch (error) {
    throw new Error(`Not a Printventory backup: ${error.message}`);
  } finally {
    if (candidate) candidate.close();
  }
}

// Replaces the library database with an uploaded backup. The upload is checked in a temp
// file first; the current database is kept next to it as printventory.db.before-restore.
ipcMain.handle('restore-database', async (event, payload = null) => {
  if (!payload || !payload.base64) {
    return { success: false, message: 'Upload a backup file to restore.' };
  }
  const dbPath = getDatabasePath();
  const uploadPath = `${dbPath}.restore-upload`;
  try {
    await fs.promises.writeFile(uploadPath, Buffer.from(payload.base64, 'base64'));
    checkBackupFile(uploadPath);
  } catch (error) {
    await fs.promises.rm(uploadPath, { force: true });
    console.error('Restore refused:', error.message);
    return { success: false, message: error.message };
  }

  try {
    if (database.db && database.db.open) database.db.close();
    await fs.promises.copyFile(dbPath, `${dbPath}.before-restore`);
    for (const suffix of ['-wal', '-shm']) await fs.promises.rm(dbPath + suffix, { force: true });
    await fs.promises.rename(uploadPath, dbPath);
    database.db = new Database(dbPath);
    return { success: true };
  } catch (error) {
    console.error('Restore error:', error);
    await fs.promises.rm(uploadPath, { force: true });
    try {
      database.db = new Database(dbPath);
    } catch (reopenError) {
      console.error('Error reopening database:', reopenError);
    }
    return { success: false, message: error.message };
  }
});

// Export library handler
function libraryTableExists(name) {
  try {
    return Boolean(database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  } catch (_) {
    return false;
  }
}

function libraryColumnExists(table, column) {
  try {
    return database.db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === column);
  } catch (_) {
    return false;
  }
}

function pushGrouped(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function buildLibraryExportData() {
  const models = database.db.prepare(`
    SELECT id, filePath, fileName, designer, source, notes, printed, print_status, print_count, last_printed_at, parentModel, hash, size, license, modifiedDate, dateAdded, isNew, rating, favorite
    FROM models
  `).all();

  const tagsByModelId = new Map();
  if (libraryTableExists('tags') && libraryTableExists('model_tags')) {
    for (const row of database.db.prepare(`
      SELECT mt.model_id, t.name
      FROM tags t
      JOIN model_tags mt ON mt.tag_id = t.id
    `).all()) {
      pushGrouped(tagsByModelId, row.model_id, row.name);
    }
  }

  const filamentsByModelId = new Map();
  if (libraryTableExists('filaments') && libraryTableExists('model_filaments')) {
    for (const row of database.db.prepare(`
      SELECT mf.model_id, f.name, f.vendor, f.material, f.color_hex, f.diameter, f.spoolman_id, f.source
      FROM filaments f
      JOIN model_filaments mf ON mf.filament_id = f.id
      ORDER BY f.vendor COLLATE NOCASE, f.name COLLATE NOCASE
    `).all()) {
      pushGrouped(filamentsByModelId, row.model_id, {
        name: row.name,
        vendor: row.vendor,
        material: row.material,
        color_hex: row.color_hex,
        diameter: row.diameter,
        spoolman_id: row.spoolman_id,
        source: row.source
      });
    }
  }

  const filamentsByEventId = new Map();
  if (libraryTableExists('print_events') && libraryTableExists('print_event_filaments') && libraryTableExists('filaments')) {
    for (const row of database.db.prepare(`
      SELECT pef.event_id, f.name, f.vendor, f.material, f.color_hex, f.diameter, f.spoolman_id, f.source
      FROM filaments f
      JOIN print_event_filaments pef ON pef.filament_id = f.id
      ORDER BY f.vendor COLLATE NOCASE, f.name COLLATE NOCASE
    `).all()) {
      pushGrouped(filamentsByEventId, row.event_id, {
        name: row.name,
        vendor: row.vendor,
        material: row.material,
        color_hex: row.color_hex,
        diameter: row.diameter,
        spoolman_id: row.spoolman_id,
        source: row.source
      });
    }
  }

  const partsByEventId = new Map();
  if (libraryTableExists('print_events') && libraryTableExists('print_event_parts')) {
    const hasPartsCatalog = libraryTableExists('parts');
    for (const row of database.db.prepare(`
      SELECT pep.event_id,
             ${hasPartsCatalog ? 'COALESCE(p.name, pep.name)' : 'pep.name'} AS name,
             ${hasPartsCatalog ? 'p.category' : 'NULL'} AS category,
             ${hasPartsCatalog ? 'p.unit' : 'NULL'} AS unit,
             pep.quantity AS quantity
      FROM print_event_parts pep
      ${hasPartsCatalog ? 'LEFT JOIN parts p ON p.id = pep.part_id' : ''}
      ORDER BY name COLLATE NOCASE
    `).all()) {
      pushGrouped(partsByEventId, row.event_id, {
        name: row.name,
        category: row.category,
        unit: row.unit,
        quantity: row.quantity
      });
    }
  }

  const eventsByModelId = new Map();
  if (libraryTableExists('print_events')) {
    const hasPrinters = libraryTableExists('printers');
    const hasPrinterType = hasPrinters && libraryColumnExists('printers', 'printer_type');
    const hasPrinterId = libraryColumnExists('print_events', 'printer_id');
    const printerSelect = hasPrinters && hasPrinterId
      ? `, pr.nickname AS printer_nickname, pr.manufacturer AS printer_manufacturer, pr.model AS printer_model, ${hasPrinterType ? 'pr.printer_type' : 'NULL'} AS printer_type`
      : ', NULL AS printer_nickname, NULL AS printer_manufacturer, NULL AS printer_model, NULL AS printer_type';
    const printerJoin = hasPrinters && hasPrinterId
      ? 'LEFT JOIN printers pr ON pr.id = pe.printer_id'
      : '';
    for (const row of database.db.prepare(`
      SELECT pe.id, pe.model_id, pe.printed_at, pe.outcome, pe.quantity, pe.notes, pe.created_at
             ${printerSelect}
      FROM print_events pe
      ${printerJoin}
      ORDER BY pe.printed_at DESC, pe.id DESC
    `).all()) {
      pushGrouped(eventsByModelId, row.model_id, {
        printed_at: row.printed_at,
        outcome: row.outcome,
        quantity: row.quantity,
        notes: row.notes,
        created_at: row.created_at,
        printer_nickname: row.printer_nickname || null,
        printer_manufacturer: row.printer_manufacturer || null,
        printer_model: row.printer_model || null,
        printer_type: row.printer_type || null,
        filaments: filamentsByEventId.get(row.id) || [],
        parts: partsByEventId.get(row.id) || []
      });
    }
  }

  const logsByPrinterId = new Map();
  if (libraryTableExists('printer_maintenance_logs')) {
    for (const row of database.db.prepare(`
      SELECT printer_id, maintenance_type, title, description, performed_at, created_at
      FROM printer_maintenance_logs
      ORDER BY performed_at DESC, id DESC
    `).all()) {
      pushGrouped(logsByPrinterId, row.printer_id, {
        maintenance_type: row.maintenance_type,
        title: row.title,
        description: row.description,
        performed_at: row.performed_at,
        created_at: row.created_at
      });
    }
  }

  const remindersByPrinterId = new Map();
  if (libraryTableExists('printer_maintenance_reminders')) {
    const hasLastCompleted = libraryColumnExists('printer_maintenance_reminders', 'last_completed_at');
    for (const row of database.db.prepare(`
      SELECT printer_id, title, maintenance_type, due_date, interval_days, notes, status,
             ${hasLastCompleted ? 'last_completed_at' : 'NULL AS last_completed_at'}, created_at
      FROM printer_maintenance_reminders
      ORDER BY due_date ASC, id ASC
    `).all()) {
      pushGrouped(remindersByPrinterId, row.printer_id, {
        title: row.title,
        maintenance_type: row.maintenance_type,
        due_date: row.due_date,
        interval_days: row.interval_days,
        notes: row.notes,
        status: row.status,
        last_completed_at: row.last_completed_at,
        created_at: row.created_at
      });
    }
  }

  const printers = libraryTableExists('printers')
    ? database.db.prepare(`
        SELECT id, nickname, manufacturer, model, ${libraryColumnExists('printers', 'printer_type') ? 'printer_type' : 'NULL AS printer_type'}, firmware_type, is_klipper, web_url, notes, created_at, updated_at
        FROM printers
        ORDER BY nickname COLLATE NOCASE, id ASC
      `).all().map((row) => ({
        nickname: row.nickname,
        manufacturer: row.manufacturer,
        model: row.model,
        printer_type: row.printer_type || null,
        firmware_type: row.firmware_type,
        is_klipper: row.is_klipper ? 1 : 0,
        web_url: row.web_url,
        notes: row.notes,
        created_at: row.created_at,
        updated_at: row.updated_at,
        maintenanceLogs: logsByPrinterId.get(row.id) || [],
        maintenanceReminders: remindersByPrinterId.get(row.id) || []
      }))
    : [];

  const parts = libraryTableExists('parts')
    ? database.db.prepare(`
        SELECT name, category, quantity, unit, notes, low_stock
        FROM parts
        ORDER BY name COLLATE NOCASE, id ASC
      `).all()
    : [];

  const slicers = libraryTableExists('slicers')
    ? database.db.prepare('SELECT name, path FROM slicers ORDER BY name COLLATE NOCASE, id ASC').all()
    : [];

  return {
    version: '1.0',
    exportDate: new Date().toISOString(),
    printers,
    parts,
    slicers,
    models: models.map((model) => ({
      filePath: model.filePath,
      fileName: model.fileName,
      designer: model.designer,
      source: model.source,
      notes: model.notes,
      printed: model.printed,
      print_status: model.print_status || (model.printed ? 'printed' : 'unprinted'),
      print_count: model.print_count || 0,
      last_printed_at: model.last_printed_at || null,
      parentModel: model.parentModel,
      license: model.license,
      rating: model.rating || 0,
      favorite: model.favorite ? 1 : 0,
      tags: tagsByModelId.get(model.id) || [],
      filaments: filamentsByModelId.get(model.id) || [],
      printEvents: eventsByModelId.get(model.id) || []
    }))
  };
}

ipcMain.handle('export-library', async () => {
  try {
    const exportData = buildLibraryExportData();
    const exportDir = path.dirname(getDatabasePath());
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const exportPath = path.join(exportDir, `printventory-library-${timestamp}.json`);
    await fs.promises.writeFile(exportPath, JSON.stringify(exportData, null, 2), 'utf8');
    return { success: true, filePath: exportPath };
  } catch (error) {
    console.error('Export library error:', error);
    return { success: false, message: error.message };
  }
});

// Import library handler
ipcMain.handle('import-library', async (event, payload = null) => {
  const importLibraryData = async (importData) => {
    if (!importData.models || !Array.isArray(importData.models)) {
      throw new Error('Invalid library file format: missing models array');
    }

    const totalModels = importData.models.length;
    if (event && event.sender) {
      event.sender.send('show-progress-dialog', {
        title: 'Importing Library',
        message: 'Reading library file...',
        total: totalModels
      });
    }

    let importedCount = 0;
    let updatedCount = 0;

    for (let i = 0; i < importData.models.length; i++) {
      const modelData = importData.models[i];
      try {
        const existingModel = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get(modelData.filePath);

        let filamentIds;
        if (Array.isArray(modelData.filaments)) {
          filamentIds = [];
          for (const entry of modelData.filaments) {
            if (entry && typeof entry === 'object') {
              const id = upsertImportedFilament(entry);
              if (id) filamentIds.push(id);
            } else {
              const id = Number(entry);
              if (Number.isInteger(id) && id > 0) filamentIds.push(id);
            }
          }
        }

        await saveModel({
          filePath: modelData.filePath,
          fileName: modelData.fileName,
          designer: modelData.designer || null,
          source: modelData.source || null,
          notes: modelData.notes || null,
          printed: modelData.printed || 0,
          parentModel: modelData.parentModel || null,
          license: modelData.license || null,
          tags: modelData.tags || [],
          ...(filamentIds !== undefined ? { filaments: filamentIds } : {})
        });

        if (existingModel) {
          updatedCount++;
        } else {
          importedCount++;
        }

        if (event && event.sender) {
          event.sender.send('update-progress', {
            current: i + 1,
            total: totalModels,
            message: `Importing model ${i + 1} of ${totalModels}...`
          });
        }
      } catch (modelError) {
        console.error(`Error importing model ${modelData.filePath}:`, modelError);
        if (event && event.sender) {
          event.sender.send('update-progress', {
            current: i + 1,
            total: totalModels,
            message: `Importing model ${i + 1} of ${totalModels}...`
          });
        }
      }
    }

    if (event && event.sender) {
      event.sender.send('close-progress-dialog');
    }

    return { success: true, imported: importedCount, updated: updatedCount };
  };

  if (payload && payload.json) {
    try {
      const importData = JSON.parse(payload.json);
      return await importLibraryData(importData);
    } catch (error) {
      console.error('Import library error:', error);
      if (event && event.sender) {
        event.sender.send('close-progress-dialog');
      }
      return { success: false, message: error.message };
    }
  }
});

module.exports = { buildLibraryExportData };
