'use strict';

const events = require('../events');
const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { deriveBundleFromFilePath } = require('../../core/bundle-keys');
const { getScanExcludeNames, parseZipPath, readScannedDirectorySetting, readStlHomeDirectories, assertContainerPath } = require('../../core/library-paths');
const { deleteModelsByIds } = require('../../core/models');
const { scheduleBackgroundHashGeneration } = require('./hashes');
const { browseFolders, mountPoints } = require('../folder-browse');
const { networkPathContext } = require('../path-context');
const { isInsideOrSame, isSystemDirectory } = require('../server-paths');
const { isSkippedLibraryFile, compileExcludeDirs, isExcludedPath } = require('../../core/scan-skip');
const { clampFolderLevels } = require('../../core/library-context');
const { shouldAutoTagNewScanFiles } = require('../../core/folder-tags');
const { pathsAreSame } = require('../../core/organize-library');
const { applyFolderTagsToModels } = require('./context-menu');
const { directoryScanPrefixSqlParam, getScanExtensions, normalizePath } = require('./models');
const { findZipEntry, withZipFileLock } = require('../../core/zip-extract');

ipcMain.handle('load-directory', async () => {
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('directoryPath');
    return row ? row.value : null;
  } catch (error) {
    console.error('Error loading directory:', error);
    throw error;
  }
});

ipcMain.handle('save-directory', async (event, directoryPath) => {
  try {
    database.db
      .prepare(
        `
      INSERT INTO settings (key, value) 
      VALUES (?, ?) 
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `
      )
      .run('directoryPath', directoryPath);
    return true;
  } catch (error) {
    console.error('Error saving directory:', error);
    throw error;
  }
});

// Update the isValidFile function to get the max file size from settings
async function getMaxFileSize() {
  try {
    const maxFileSize = await database.db.prepare('SELECT value FROM settings WHERE key = ?').get('maxFileSizeMB');
    return maxFileSize ? parseInt(maxFileSize.value) * 1024 * 1024 : 50 * 1024 * 1024;
  } catch (error) {
    console.error('Error getting max file size:', error);
    return 50 * 1024 * 1024; // Default to 50MB if there's an error
  }
}

// Apply path-based metadata for STL Home scan: segments from root (From Root) or from model up (From Model).
// Only sets designer/parentModel when current value is empty. Uses pathMetadataStlHomeEnabled, pathMetadataStlHomeDirection,
// pathMetadataUseDesigner, pathMetadataUseParentModel, pathMetadataDesignerIndex, pathMetadataParentModelIndex.
function applyPathMetadataFromSegments(scanRootPath, filePaths) {
  if (!database.db || !database.db.prepare) return;
  const enabledRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('pathMetadataStlHomeEnabled');
  if (!enabledRow || enabledRow.value !== '1') return;
  const directionRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('pathMetadataStlHomeDirection');
  const fromRoot = directionRow?.value === 'fromRoot';
  const useDesigner = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('pathMetadataUseDesigner');
  const useParentModel = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('pathMetadataUseParentModel');
  const designerIndexRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('pathMetadataDesignerIndex');
  const parentModelIndexRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('pathMetadataParentModelIndex');
  const applyDesigner = useDesigner?.value === '1';
  const applyParentModel = useParentModel?.value === '1';
  if (!applyDesigner && !applyParentModel) return;
  const rawDesigner = parseInt(designerIndexRow?.value, 10);
  const rawParent = parseInt(parentModelIndexRow?.value, 10);
  const designerIndex = Math.max(0, Number.isInteger(rawDesigner) ? rawDesigner : 0);
  const parentModelIndex = Math.max(0, Number.isInteger(rawParent) ? rawParent : 0);
  const getModel = database.db.prepare('SELECT id, designer, parentModel FROM models WHERE filePath = ?');
  const updateModel = database.db.prepare('UPDATE models SET designer = ?, parentModel = ? WHERE id = ?');
  const normalizedRoot = normalizePath(scanRootPath).replace(/\/$/, '');
  const rootSegment = normalizedRoot.split('/').filter(Boolean).pop() || '';
  for (const filePath of filePaths) {
    let relativeDir;
    if (filePath.includes('::')) {
      const entryPath = filePath.split('::')[1] || '';
      relativeDir = path.dirname(entryPath);
    } else {
      const normalizedFile = normalizePath(filePath);
      const relative = path.relative(normalizedRoot, normalizedFile);
      relativeDir = path.dirname(relative);
    }
    const segmentsRootToFile = normalizePath(relativeDir).split('/').filter(Boolean);
    // From Root: level 0 = STL Home, 1 = first folder under it, ... From Model: level 0 = parent of file, 1 = grandparent, ...
    const segments = fromRoot ? [rootSegment, ...segmentsRootToFile] : segmentsRootToFile.slice().reverse();
    const derivedDesigner = applyDesigner && segments.length > designerIndex ? segments[designerIndex] : null;
    const derivedParentModel = applyParentModel && segments.length > parentModelIndex ? segments[parentModelIndex] : null;
    const model = getModel.get(filePath);
    if (!model) continue;
    const currentDesigner = model.designer == null || String(model.designer).trim() === '' ? null : model.designer;
    const currentParentModel = model.parentModel == null || String(model.parentModel).trim() === '' ? null : model.parentModel;
    const newDesigner = currentDesigner == null && derivedDesigner ? derivedDesigner : currentDesigner;
    const newParentModel = currentParentModel == null && derivedParentModel ? derivedParentModel : currentParentModel;
    if (newDesigner !== currentDesigner || newParentModel !== currentParentModel) {
      updateModel.run(newDesigner || null, newParentModel || null, model.id);
    }
  }
}

// Helper function to check if a zip entry exists
async function checkZipEntryExists(zipPath, entryPath) {
  try {
    if (!fs.existsSync(zipPath)) {
      return false;
    }
    return await withZipFileLock(zipPath, async () => {
      const StreamZip = require('node-stream-zip');
      const zip = new StreamZip.async({ file: zipPath });
      try {
        const entries = await zip.entries();
        return findZipEntry(entries, entryPath) != null;
      } finally {
        await zip.close();
      }
    });
  } catch (error) {
    console.error(`Error checking zip entry existence for ${zipPath}::${entryPath}:`, error);
    return false;
  }
}

// Update the removeNonExistentFiles function
async function removeNonExistentFiles(scanDirectoryPath, window = null, excludeDirectories = null) {
  try {
    const excluded = compileExcludeDirs(excludeDirectories, scanDirectoryPath);
    // OPTIMIZATION: Only query models in the scanned directory using SQL instead of loading all models
    // This dramatically reduces memory usage and improves performance, especially for large databases
    const prefixParam = directoryScanPrefixSqlParam(scanDirectoryPath);

    // Query only models under this directory: unify '\' and '/' so LIKE sees the same prefix as scanDirectoryPath.
    const modelsInDirectory = database.db
      .prepare(
        `
      SELECT filePath, id FROM models
      WHERE REPLACE(LOWER(filePath), CHAR(92), '/') LIKE ?
    `
      )
      .all(prefixParam);

    if (modelsInDirectory.length === 0) {
      return 0; // No models in this directory, nothing to check
    }

    const filesToDelete = [];
    const scanExcludeNames = getScanExcludeNames();

    // OPTIMIZATION: Batch file existence checks with concurrency limit
    // This prevents overwhelming the file system, especially in Docker/network share scenarios
    // Sequential checks were causing massive slowdowns (10-100ms per file in Docker)
    const MAX_CONCURRENT_CHECKS = 20; // Limit concurrent file system operations
    const checkPromises = [];

    for (let i = 0; i < modelsInDirectory.length; i += MAX_CONCURRENT_CHECKS) {
      const batch = modelsInDirectory.slice(i, i + MAX_CONCURRENT_CHECKS);
      const batchPromises = batch.map(async (model) => {
        if (isExcludedPath(model.filePath, excluded)) return;
        if (isSkippedLibraryFile(model.filePath, scanExcludeNames, scanDirectoryPath)) {
          filesToDelete.push({
            filePath: model.filePath,
            id: model.id,
            reason: 'skipped'
          });
          return;
        }
        const pathInfo = parseZipPath(model.filePath);
        let fileExists = false;

        if (pathInfo.isZipEntry) {
          // For zip entries, check if the zip file exists and the entry exists within it
          try {
            fileExists = await checkZipEntryExists(pathInfo.zipPath, pathInfo.entryPath);
          } catch (error) {
            console.error(`Error checking zip entry ${model.filePath}:`, error);
            fileExists = false;
          }
        } else {
          // For regular files, check if the file exists
          try {
            // First try the path as stored
            try {
              await fs.promises.access(model.filePath, fs.constants.F_OK);
              fileExists = true;
            } catch (accessError) {
              // If access fails, try normalizing the path (handles forward/backslash issues)
              const normalizedPath = path.normalize(model.filePath);
              if (normalizedPath !== model.filePath) {
                try {
                  await fs.promises.access(normalizedPath, fs.constants.F_OK);
                  fileExists = true;
                } catch (normalizedError) {
                  fileExists = false;
                }
              } else {
                fileExists = false;
              }
            }
          } catch (error) {
            console.error(`Error checking file existence for ${model.filePath}:`, error);
            fileExists = false;
          }
        }

        if (!fileExists) {
          filesToDelete.push({
            filePath: model.filePath,
            id: model.id,
            reason: 'missing'
          });
        }
      });

      // Wait for this batch to complete before starting the next batch
      await Promise.all(batchPromises);
    }

    // If there are files to delete, show confirmation dialog
    if (filesToDelete.length > 0) {
      // Auto-remove in server mode - use transaction for better performance
      database.db.transaction(() => {
        deleteModelsByIds(filesToDelete.map((file) => file.id));
      })();
      console.log(`Server mode: Removed ${filesToDelete.length} missing or skipped files from library`);
      return filesToDelete.length; // Return early in server mode to avoid duplicate deletion
    }

    // Proceed with deletion if user confirmed or if there were no files to delete
    const removedCount = database.db.transaction(() => {
      deleteModelsByIds(filesToDelete.map((fileInfo) => fileInfo.id));
      return filesToDelete.length;
    })();

    if (removedCount > 0) {
      console.log(`Removed ${removedCount} non-existent files from directory ${scanDirectoryPath}`);
    }

    return removedCount;
  } catch (error) {
    console.error('Error removing non-existent files:', error);
    throw error;
  }
}

function readStlHomeExcludeDirectories() {
  try {
    if (!database.db) return [];
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('stlHomeExcludeDirectories');
    if (!row || !row.value) return [];
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => String(entry).trim()).filter(Boolean);
  } catch (error) {
    console.error('Invalid stlHomeExcludeDirectories setting:', error);
    return [];
  }
}

function scanPathIsUnderStlHome(directoryPath) {
  try {
    const homes = readStlHomeDirectories();
    if (!homes.length) return false;
    return isExcludedPath(directoryPath, compileExcludeDirs(homes));
  } catch (_) {
    return false;
  }
}

function stlHomeExcludeDirectoriesForScan(directoryPath, options) {
  const excludes = readStlHomeExcludeDirectories();
  if (!excludes.length) return [];
  if (options && options.isStlHomeScan) return excludes;
  if (scanPathIsUnderStlHome(directoryPath)) return excludes;
  return [];
}

/**
 * Scan a folder: index new and changed models, drop the ones whose files are gone.
 * options.isStlHomeScan: apply STL Home exclusions and folder-name metadata.
 * options.scanRoot: the STL Home folder that `directoryPath` is inside (folder watching scans
 *   only a changed subfolder): relative exclusions and folder levels count from it.
 * options.rememberDirectory: false keeps the folder out of the scanned-directories list.
 */
async function scanDirectoryHandler(event, directoryPath, options = {}) {
  try {
    // Validate UNC path in server mode
    try {
      assertContainerPath(directoryPath, 'scan-directory');
    } catch (validationError) {
      throw new Error(validationError.message);
    }

    if (options.rememberDirectory !== false) rememberScannedDirectory(directoryPath);
    const maxFileSize = await getMaxFileSize();
    const scanRoot = typeof options.scanRoot === 'string' && options.scanRoot ? options.scanRoot : directoryPath;
    // Relative exclusions are relative to the STL Home folder, not to a subfolder being scanned.
    const excludeDirectories = stlHomeExcludeDirectoriesForScan(directoryPath, options).map((entry) =>
      path.isAbsolute(entry) ? entry : path.resolve(scanRoot, entry)
    );

    // Read enableZipArchives and scanAdditionalFileTypes from database
    const zipSetting = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enableZipArchives');
    const enableZipArchives = zipSetting && zipSetting.value === '1';
    let scanExtensions = ['.stl', '.3mf'];
    try {
      const scanTypesSetting = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('scanAdditionalFileTypes');
      if (scanTypesSetting && scanTypesSetting.value) {
        const selectedIds = JSON.parse(scanTypesSetting.value);
        if (Array.isArray(selectedIds)) scanExtensions = getScanExtensions(selectedIds);
      }
    } catch (e) {
      /* ignore */
    }

    // First, remove any non-existent files from the scanned directory
    // Pass the window so we can show a confirmation dialog if needed (null in server mode)
    const window = null;
    const removedCount = await removeNonExistentFiles(directoryPath, window, excludeDirectories);
    if (removedCount > 0) {
      event.sender.send('db-cleanup', {
        message: `Removed ${removedCount} non-existent files from directory ${directoryPath}`
      });
    }

    return new Promise((resolve, reject) => {
      // Use scan-worker.js for scanning (supports zip files)
      const workerPath = path.join(__dirname, '..', 'scan-worker.js');

      // Verify the worker file exists before creating the worker
      if (!fs.existsSync(workerPath)) {
        reject(new Error(`scan-worker.js not found at: ${workerPath}`));
        return;
      }

      const worker = new Worker(workerPath);

      // Preserve existing hash when scan doesn't provide one (worker sends null to avoid slow scans).
      // Otherwise every scan would overwrite hashes with '' and trigger full hash regeneration on each start.
      const updateExisting = database.db.prepare(`
        UPDATE models 
        SET hash = COALESCE(NULLIF(?, ''), hash),
            size = ?,
            modifiedDate = ?,
            bundleKey = ?,
            bundleLabel = ?,
            bundleKind = ?
        WHERE filePath = ?
      `);

      const insertNew = database.db.prepare(`
        INSERT INTO models (
          filePath, fileName, hash, size, modifiedDate, dateAdded, isNew,
          bundleKey, bundleLabel, bundleKind
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `);

      const ingestState = {
        files: [],
        existingFilePaths: new Set(),
        newFilesCount: 0,
        newFilePaths: []
      };
      let ingestChain = Promise.resolve();
      const enqueueIngest = (task) => {
        ingestChain = ingestChain.then(task);
        return ingestChain;
      };

      const fileModifiedIso = (file) => {
        if (file.mtime instanceof Date) return file.mtime.toISOString();
        if (typeof file.mtime === 'string' && file.mtime) return file.mtime;
        return new Date().toISOString();
      };

      const ingestFileBatch = (batch) =>
        enqueueIngest(() => {
          if (!batch || batch.length === 0) return;

          const unknown = [];
          for (const file of batch) {
            if (!ingestState.existingFilePaths.has(file.filePath)) {
              unknown.push(file.filePath);
            }
          }
          const existenceCheckBatchSize = 500;
          for (let i = 0; i < unknown.length; i += existenceCheckBatchSize) {
            const pathBatch = unknown.slice(i, i + existenceCheckBatchSize);
            const placeholders = pathBatch.map(() => '?').join(',');
            const existing = database.db.prepare(`SELECT filePath FROM models WHERE filePath IN (${placeholders})`).all(...pathBatch);
            existing.forEach((row) => ingestState.existingFilePaths.add(row.filePath));
          }

          database.db.transaction(() => {
            for (const file of batch) {
              const bundle = deriveBundleFromFilePath(file.filePath);
              const modifiedDate = fileModifiedIso(file);
              if (ingestState.existingFilePaths.has(file.filePath)) {
                updateExisting.run(
                  file.hash || '',
                  file.size,
                  modifiedDate,
                  bundle.bundleKey || null,
                  bundle.bundleLabel || null,
                  bundle.bundleKind || null,
                  file.filePath
                );
              } else {
                insertNew.run(
                  file.filePath,
                  file.fileName,
                  file.hash || '',
                  file.size,
                  modifiedDate,
                  new Date().toISOString(),
                  bundle.bundleKey || null,
                  bundle.bundleLabel || null,
                  bundle.bundleKind || null
                );
                ingestState.newFilesCount++;
                ingestState.newFilePaths.push(file.filePath);
                ingestState.existingFilePaths.add(file.filePath);
              }
              ingestState.files.push(file);
            }
          })();

          try {
            event.sender.send('db-progress', {
              total: ingestState.files.length,
              processed: ingestState.files.length
            });
          } catch (_) {
            /* sender may be gone */
          }
        });

      // Set up worker message handling
      worker.on('message', async (message) => {
        if (message.type === 'progress') {
          // Send progress to renderer
          event.sender.send('scan-progress', {
            processed: message.processed
          });
        } else if (message.type === 'batch') {
          ingestFileBatch(message.files);
        } else if (message.type === 'done') {
          try {
            if (Array.isArray(message.result?.files) && message.result.files.length > 0) {
              ingestFileBatch(message.result.files);
            }
            await ingestChain;

            const files = ingestState.files;
            const totalFiles = message.result.totalFiles;
            const newFilesCount = ingestState.newFilesCount;
            const skippedDueToSize = Number(message.result.skippedDueToSize) || 0;
            const allFilePaths = files.map((f) => f.filePath);

            worker.terminate();

            // STL Home scan with path metadata: set designer/parent from folder segments (from model level up) when enabled
            if (options.isStlHomeScan && Array.isArray(allFilePaths) && allFilePaths.length > 0) {
              try {
                applyPathMetadataFromSegments(scanRoot, allFilePaths);
              } catch (pathMetaErr) {
                console.error('Path metadata from folder (STL Home):', pathMetaErr);
              }
            }

            if (ingestState.newFilePaths.length > 0) {
              try {
                applyFolderTagsToNewScanFiles(ingestState.newFilePaths);
              } catch (tagErr) {
                console.error('Tag from Folder on newly scanned files:', tagErr);
              }
            }

            resolve({ files, totalFiles, newFilesCount, skippedDueToSize });

            scheduleBackgroundHashGeneration('scan-directory');

            // Send refresh-grid event to update the UI after scanning completes
            // Use setTimeout to ensure the promise resolves first and database is fully updated
            setTimeout(() => {
              events.broadcast('refresh-grid');
            }, 100);
          } catch (error) {
            worker.terminate();
            reject(error);
          }
        } else if (message.type === 'error') {
          worker.terminate();
          reject(new Error(message.error));
        }
      });

      // Handle worker errors
      worker.on('error', (error) => {
        worker.terminate();
        reject(error);
      });

      // Handle worker exit
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });

      // Start the worker - pass node_modules path so worker can find dependencies
      const nodeModulesPath = path.join(__dirname, '..', '..', '..', 'node_modules');

      worker.postMessage({
        directoryPath,
        maxFileSize,
        enableZipArchives,
        scanExtensions,
        excludeFolderNames: Array.from(getScanExcludeNames()),
        excludeDirectories,
        nodeModulesPath: nodeModulesPath
      });
    });
  } catch (error) {
    console.error('Error in scan-directory handler:', error);
    throw error;
  }
}

ipcMain.handle('scan-directory', scanDirectoryHandler);

/**
 * Choose folder (src/web/components/FolderPicker.tsx): the places to start from (the container's
 * mounted volumes and the library folders) and the subfolders of `dir`. System, app and data
 * folders are never listed. Where there is no /proc (the server run directly on a Mac or PC),
 * the home folder stands in for the mounts.
 */
ipcMain.handle('browse-folders', async (event, dir) => {
  const ctx = networkPathContext();
  const mounts = mountPoints();
  const places = [...mounts, ...(mounts.length ? [] : [os.homedir()]), ...ctx.roots];
  const isBlocked = (candidate) =>
    isSystemDirectory(candidate) || (ctx.appDir && isInsideOrSame(candidate, ctx.appDir)) || (ctx.dataDir && isInsideOrSame(candidate, ctx.dataDir));
  return browseFolders({ dir: dir || null, places, isBlocked });
});

function rememberScannedDirectory(directoryPath) {
  const dir = String(directoryPath || '').trim();
  if (!dir || !database.db) return;
  const list = readScannedDirectorySetting();
  if (list.some((item) => pathsAreSame(item, dir))) return;
  list.push(dir);
  try {
    database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('scannedDirectories', JSON.stringify(list));
  } catch (error) {
    console.error('Could not remember scanned directory:', error);
  }
}

// Folder names only, and only for paths this scan inserted. Existing models are not passed in.
function applyFolderTagsToNewScanFiles(filePaths) {
  if (!database.db || !Array.isArray(filePaths) || filePaths.length === 0) {
    return { updated: 0, tagsAdded: 0 };
  }
  const enabledRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('autoTagFromFolderOnScan');
  const levelsRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiTagFolderLevels');
  const levels = clampFolderLevels(levelsRow ? levelsRow.value : 2);
  if (!shouldAutoTagNewScanFiles(enabledRow ? enabledRow.value : '0', levels)) {
    return { updated: 0, tagsAdded: 0 };
  }
  const result = applyFolderTagsToModels(filePaths, levels);
  if (result.tagsAdded > 0) {
    console.log(`[Tag from Folder] Added ${result.tagsAdded} tag(s) on ${result.updated} newly scanned model(s).`);
  }
  return result;
}

module.exports = { scanDirectoryHandler, readStlHomeExcludeDirectories };
