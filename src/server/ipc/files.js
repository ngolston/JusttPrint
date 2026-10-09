'use strict';

const events = require('../events');

const database = require('../../core/database');
const { ipcMain, shell } = require('../runtime');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { isUrlModel, parseZipPath, assertContainerPath } = require('../../core/library-paths');
const { cleanupExtractTempFile } = require('../../core/extract-temp');
const { deleteModelJunctionRows } = require('../../core/models');
const { clientDialogs } = require('../dialogs');
const { extractModelFromZip } = require('../../core/zip-entries');
const { getDatabasePath } = require('../../core/db-path');
const { deleteFile } = require('./context-menu');
const { findZipEntry, withZipFileLock } = require('../../core/zip-extract');

// Update the trash-file handler with simpler path normalization
ipcMain.handle('trash-file', async (event, filePath) => {
  try {
    // Validate UNC path in server mode (skips URL models)
    try {
      assertContainerPath(filePath, 'trash-file');
    } catch (validationError) {
      throw new Error(validationError.message, { cause: validationError });
    }
  } catch (error) {
    console.error('Error in trash-file handler:', error);
    throw error;
  }

  // Simple path normalization - replace all backslashes with forward slashes
  const normalizedPath = filePath.replace(/\\/g, '/');
  console.debug('trash-file handler received path:', filePath);
  console.debug('Normalized path:', normalizedPath);

  try {
    if (!isUrlModel(filePath)) {
      console.debug('Attempting trashItem with path:', normalizedPath);
      await shell.trashItem(normalizedPath);
      console.debug('trashItem succeeded');
    }

    // Remove from database (for both file and URL-only models)
    await new Promise((resolve, reject) => {
      console.debug('Deleting from database:', normalizedPath);
      database.db.transaction(() => {
        const model = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get(normalizedPath);
        if (model) {
          deleteModelJunctionRows(model.id);
          database.db.prepare('DELETE FROM models WHERE id = ?').run(model.id);
        }
      })();
      resolve(undefined);
    });

    return true;
  } catch (err) {
    console.error('Error moving file to trash:', err);
    console.error('Error details:', {
      message: err.message,
      code: err.code,
      path: normalizedPath
    });
    return false;
  }
});

// Update or add this handler in main.js
ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    // Validate UNC path in server mode
    try {
      assertContainerPath(filePath, 'delete-file');
    } catch (validationError) {
      throw new Error(validationError.message, { cause: validationError });
    }

    console.debug('main: delete-file handler called with:', filePath);
    const result = await deleteFile(filePath);

    // Send refresh-grid event to update the UI after file deletion
    if (result) {
      events.broadcast('refresh-grid');
    }

    return result;
  } catch (error) {
    console.error('Error deleting file:', error);
    throw error;
  }
});

// Update the purge-models handler
const purgeModelsHandler = async (event, options = {}) => {
  try {
    // A browser asks for confirmation in its own dialog before calling.
    const fromBrowser = !!(event && event.fromNetwork);
    const confirmedInDialog = !!(options && options.confirmedInDialog);
    let doPurge = fromBrowser || confirmedInDialog;

    if (!doPurge) {
      const result = await clientDialogs.messageBox(event, {
        type: 'warning',
        title: 'Purge Models',
        message: 'Are you sure you want to purge all models?',
        detail: 'This will remove all model data from the database. This action cannot be undone.',
        buttons: ['Cancel', 'Purge All Models'],
        defaultId: 0,
        cancelId: 0
      });
      doPurge = result.response === 1; // User clicked "Purge All Models"
    }

    if (doPurge) {
      // Check if database is open, if not reopen it
      if (!database.db.open) {
        const dbPath = getDatabasePath();
        database.db = new Database(dbPath);
      }

      try {
        // Rows that reference models go first (print history too, as when one model is removed),
        // then the models, then the tags no model uses any more. All or nothing.
        database.db.transaction(() => {
          for (const table of ['print_event_parts', 'print_events', 'model_tags']) {
            const exists = database.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
            if (exists) database.db.prepare(`DELETE FROM ${table}`).run();
          }
          database.db.prepare('DELETE FROM models').run();
          database.db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM model_tags)').run();
        })();

        return true;
      } catch (dbError) {
        console.error('Database error during purge:', dbError);
        throw dbError;
      }
    }
    return false;
  } catch (error) {
    console.error('Error purging models:', error);
    throw error;
  }
};

ipcMain.handle('purge-models', purgeModelsHandler);

// Add handler to extract model from zip to temp file
ipcMain.handle('extract-model-from-zip', async (event, filePath) => {
  if (isUrlModel(filePath)) throw new Error('URL-only model has no file to extract');
  try {
    const pathInfo = parseZipPath(filePath);
    if (!pathInfo.isZipEntry) {
      // Not a zip entry, return original path
      return filePath;
    }

    return await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
  } catch (error) {
    console.error('Error extracting model from zip:', error);
    throw error;
  }
});

// Renderer cleanup for extract temps (loadModel / preview)
ipcMain.handle('delete-temp-file', async (event, filePath) => {
  try {
    return await cleanupExtractTempFile(filePath);
  } catch (error) {
    console.warn('delete-temp-file failed:', error.message);
    return false;
  }
});

// Add new IPC handler for moving multiple files
ipcMain.handle('move-files', async (event, filePaths, destinationFolder) => {
  try {
    for (const filePath of filePaths) {
      // Check if the file exists before moving
      if (!fs.existsSync(filePath)) {
        console.error(`File does not exist: ${filePath}`);
        throw new Error(`File does not exist: ${filePath}`);
      }

      const newDestination = path.join(destinationFolder, path.basename(filePath));
      console.debug(`Moving file from ${filePath} to ${newDestination}`); // Log the move operation
      await fs.promises.rename(filePath, newDestination);
      database.db.prepare('UPDATE models SET filePath = ? WHERE filePath = ?').run(newDestination, filePath);
    }
    events.broadcast('refresh-grid');
    return true;
  } catch (error) {
    console.error('Error moving files:', error);
    throw error;
  }
});

const getFileStatsHandler = async (event, filePath) => {
  try {
    // URL-only models (old browser extension) have no local file
    if (isUrlModel(filePath)) {
      return { size: 0, mtimeMs: 0 };
    }

    // Virtual zip paths: archive.zip::entry/path.stl — cannot fs.stat the combined path
    const pathInfo = parseZipPath(filePath);
    if (pathInfo.isZipEntry) {
      if (!fs.existsSync(pathInfo.zipPath)) {
        const err = Object.assign(new Error(`ENOENT: no such file or directory, stat '${pathInfo.zipPath}'`), { code: 'ENOENT' });
        throw err;
      }
      return await withZipFileLock(pathInfo.zipPath, async () => {
        const StreamZip = require('node-stream-zip');
        const zip = new StreamZip.async({ file: pathInfo.zipPath });
        try {
          const entries = await zip.entries();
          const entry = findZipEntry(entries, pathInfo.entryPath);
          if (!entry) {
            const err = Object.assign(new Error(`ENOENT: no such file or directory, zip entry '${pathInfo.entryPath}' in '${pathInfo.zipPath}'`), {
              code: 'ENOENT'
            });
            throw err;
          }
          const mtimeMs = entry.time ? Number(entry.time) : 0;
          return {
            size: entry.size,
            mtime: mtimeMs ? new Date(mtimeMs) : new Date(0),
            mtimeMs
          };
        } finally {
          await zip.close();
        }
      });
    }

    const stats = await fs.promises.stat(filePath);
    return stats;
  } catch (error) {
    console.error(`Error getting file stats for ${filePath}:`, error);
    throw error;
  }
};

ipcMain.handle('get-file-stats', getFileStatsHandler);
