'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const fs = require('fs');
const Database = require('better-sqlite3');
const { getDatabasePath } = require('../../core/db-path');
const { SECRET_SETTING_KEYS } = require('../server-auth');
const { saveModel } = require('./models');
const { checkBackupFile } = require('../../core/backup-check');
const autoBackup = require('../auto-backup');
const downloadFiles = require('../download-files');

// Copies the live database to downloads/justtprint-backup-<time>.db for the browser to download
// (deleted an hour later, src/server/download-files.js).
ipcMain.handle('backup-database', async () => {
  try {
    const backupPath = downloadFiles.newDownloadPath('backup', 'db');

    // SQLite's online backup: the database stays open, so other requests keep working.
    await database.db.backup(backupPath);

    return { success: true, filePath: backupPath };
  } catch (error) {
    console.error('Backup error:', error);
    return { success: false, message: error.message };
  }
});

/**
 * Replace the library database with a checked copy (an upload or an automatic backup) at
 * `uploadPath`, which is consumed. The current database is kept next to it as
 * justtprint.db.before-restore.
 */
async function restoreFromCheckedFile(uploadPath) {
  const dbPath = getDatabasePath();
  try {
    // The server's own login (password, session secret, API token) is not library data:
    // keep it, so a restore does not change the password or log everyone out.
    const serverLogin = database.db && database.db.open
      ? database.db.prepare(`SELECT key, value FROM settings WHERE key IN (${[...SECRET_SETTING_KEYS].map(() => '?').join(', ')})`).all(...SECRET_SETTING_KEYS)
      : [];
    if (database.db && database.db.open) database.db.close();
    await fs.promises.copyFile(dbPath, `${dbPath}.before-restore`);
    for (const suffix of ['-wal', '-shm']) await fs.promises.rm(dbPath + suffix, { force: true });
    await fs.promises.rename(uploadPath, dbPath);
    database.db = new Database(dbPath);
    const keepLogin = database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const row of serverLogin) keepLogin.run(row.key, row.value);
    autoBackup.schedule();
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
}

const BACKUP_RUNNING = 'A backup is being written. Try again when it has finished.';

// Replaces the library database with an uploaded backup. The upload is checked in a temp
// file first.
ipcMain.handle('restore-database', async (event, payload = null) => {
  if (!payload || !payload.base64) {
    return { success: false, message: 'Upload a backup file to restore.' };
  }
  if (autoBackup.isRunning()) return { success: false, message: BACKUP_RUNNING };
  const uploadPath = `${getDatabasePath()}.restore-upload`;
  try {
    await fs.promises.writeFile(uploadPath, Buffer.from(payload.base64, 'base64'));
    checkBackupFile(uploadPath);
  } catch (error) {
    await fs.promises.rm(uploadPath, { force: true });
    console.error('Restore refused:', error.message);
    return { success: false, message: error.message };
  }
  return restoreFromCheckedFile(uploadPath);
});

// Backups and exports earlier versions left in the data folder (Settings → Backup shows them).
ipcMain.handle('get-leftover-downloads', async () => downloadFiles.leftovers());
ipcMain.handle('delete-leftover-downloads', async () => downloadFiles.deleteLeftovers());

// Automatic backups (src/server/auto-backup.js): settings, Back Up Now, and Restore by name.
ipcMain.handle('get-auto-backup', async () => autoBackup.status());
ipcMain.handle('save-auto-backup', async (event, input = {}) => autoBackup.saveSettings(input || {}));
ipcMain.handle('run-auto-backup', async () => {
  const result = await autoBackup.runBackup('manual');
  return { ...result, status: autoBackup.status() };
});
ipcMain.handle('restore-auto-backup', async (event, name) => {
  if (autoBackup.isRunning()) return { success: false, message: BACKUP_RUNNING };
  let backupFile;
  try {
    backupFile = autoBackup.findBackup(name);
  } catch (error) {
    return { success: false, message: error.message };
  }
  const uploadPath = `${getDatabasePath()}.restore-upload`;
  try {
    await fs.promises.copyFile(backupFile.path, uploadPath);
    checkBackupFile(uploadPath);
  } catch (error) {
    await fs.promises.rm(uploadPath, { force: true });
    console.error('Restore refused:', error.message);
    return { success: false, message: error.message };
  }
  console.log(`[Backup] Restoring ${backupFile.path}`);
  return restoreFromCheckedFile(uploadPath);
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
      printEvents: eventsByModelId.get(model.id) || []
    }))
  };
}

ipcMain.handle('export-library', async () => {
  try {
    const exportData = buildLibraryExportData();
    // For the browser to download; deleted an hour later (src/server/download-files.js).
    const exportPath = downloadFiles.newDownloadPath('library', 'json');
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

        await saveModel({
          filePath: modelData.filePath,
          fileName: modelData.fileName,
          designer: modelData.designer || null,
          source: modelData.source || null,
          notes: modelData.notes || null,
          printed: modelData.printed || 0,
          parentModel: modelData.parentModel || null,
          license: modelData.license || null,
          tags: modelData.tags || []
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
