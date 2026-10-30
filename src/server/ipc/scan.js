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
const { isInsideOrSame, isInsideSameFolder, isSystemDirectory, isUnraidSystemShare } = require('../server-paths');
const { findMovedModel, moveModel } = require('../relink-moved');
const { isSkippedLibraryFile, compileExcludeDirs, isExcludedPath } = require('../../core/scan-skip');
const { clampFolderLevels } = require('../../core/library-context');
const { shouldAutoTagNewScanFiles } = require('../../core/folder-tags');
const { pathsAreSame } = require('../../core/organize-library');
const { applyFolderTagsToModels } = require('./context-menu');
const { directoryScanPrefixSqlParam, getScanExtensions, normalizePath } = require('./models');

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
// Only sets the designer and the Title when they are empty. Uses pathMetadataStlHomeEnabled, pathMetadataStlHomeDirection,
// pathMetadataUseDesigner, pathMetadataUseParentModel, pathMetadataDesignerIndex, pathMetadataParentModelIndex (the
// ParentModel settings, named before 8.0, choose the folder for the Title).
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
  const getModel = database.db.prepare('SELECT id, designer, title FROM models WHERE filePath = ?');
  const updateModel = database.db.prepare('UPDATE models SET designer = ?, title = ? WHERE id = ?');
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
    const currentParentModel = model.title == null || String(model.title).trim() === '' ? null : model.title;
    const newDesigner = currentDesigner == null && derivedDesigner ? derivedDesigner : currentDesigner;
    const newParentModel = currentParentModel == null && derivedParentModel ? derivedParentModel : currentParentModel;
    if (newDesigner !== currentDesigner || newParentModel !== currentParentModel) {
      updateModel.run(newDesigner || null, newParentModel || null, model.id);
    }
  }
}

// Update the removeNonExistentFiles function
/**
 * @param {any} [window]
 * @param {string[] | null} [excludeDirectories]
 */
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
        // Models listed from inside a ZIP (before 8.6): the archive is now one model of its own.
        if (parseZipPath(model.filePath).isZipEntry) {
          filesToDelete.push({ filePath: model.filePath, id: model.id, reason: 'archive' });
          return;
        }
        let fileExists;
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
/**
 * Folders a scan of `directoryPath` skips: the STL Home exclusions (relative ones from the STL Home
 * folder `scanRoot`, not from a subfolder being scanned), model folders' media folders, and
 * Unraid's own shares when the whole user share or a disk is scanned.
 */
function scanExcludeDirectories(directoryPath, scanRoot, options = {}) {
  const excludeDirectories = stlHomeExcludeDirectoriesForScan(directoryPath, options).map((entry) =>
    path.isAbsolute(entry) ? entry : path.resolve(scanRoot, entry)
  );
  // Model folders' pictures, videos and documents are not models (model-folders.js).
  excludeDirectories.push(...require('../model-folders').mediaFolders(directoryPath));
  // Unraid's own shares, when STL Home is the whole user share or a disk (server-paths.js isUnraidSystemShare).
  if (/^\/mnt\/(user0?|disk\d+|cache)\/?$/i.test(directoryPath)) {
    for (const share of ['appdata', 'system', 'domains', 'isos']) excludeDirectories.push(path.posix.join(directoryPath, share));
  }
  return excludeDirectories;
}

/**
 * Drop the models under `directoryPath` whose files are gone. Runs after a scan has added its
 * files, so a file moved within the scan is relinked first (relink-moved.js) instead of dropped.
 */
async function removeMissingIn(directoryPath, options = {}) {
  const scanRoot = typeof options.scanRoot === 'string' && options.scanRoot ? options.scanRoot : directoryPath;
  if (stlHomeFolderIsGone(scanRoot, options)) return 0;
  return removeNonExistentFiles(directoryPath, null, scanExcludeDirectories(directoryPath, scanRoot, options));
}

/**
 * A whole STL Home folder that is gone (a share not mounted, a container path changed) keeps its
 * models: they are dropped only when files are gone from a folder that is there, and a scan of
 * the folder's new place relinks them (relink-moved.js).
 */
function stlHomeFolderIsGone(scanRoot, options = {}) {
  if (!options.isStlHomeScan || fs.existsSync(scanRoot)) return false;
  console.warn(`[Scan] STL Home folder ${scanRoot} is not there (not mounted?): its models are kept`);
  return true;
}

async function scanDirectoryHandler(event, directoryPath, options = {}) {
  // The progress bars above Library Storage (activity.js) follow what the scan tells its browser.
  const activity = require('../activity');
  const id = activity.start('scan', 'Scanning the library', { unit: 'files', detail: path.basename(String(directoryPath || '')) || null });
  const sender = event && event.sender;
  const followed = {
    ...event,
    sender: {
      ...(sender || {}),
      send: (channel, payload) => {
        if (channel === 'scan-progress' && payload) activity.update(id, { done: payload.processed });
        if (channel === 'db-progress' && payload) activity.update(id, { label: 'Adding models to the library', done: payload.processed, total: null });
        if (sender && typeof sender.send === 'function') sender.send(channel, payload);
      }
    }
  };
  try {
    const result = await scanDirectoryInner(followed, directoryPath, options);
    // Model folders moved or renamed outside JusttPrint keep their cover and links (model-folders.js).
    try {
      const modelFolders = require('../model-folders');
      for (const { to } of modelFolders.relinkMoved(directoryPath)) modelFolders.reapplyCover(to);
    } catch (error) {
      console.warn(`[Model folders] Could not look for moved folders: ${error.message}`);
    }
    return result;
  } finally {
    activity.finish(id);
  }
}

async function scanDirectoryInner(event, directoryPath, options = {}) {
  try {
    // Validate UNC path in server mode
    try {
      assertContainerPath(directoryPath, 'scan-directory');
    } catch (validationError) {
      throw new Error(validationError.message, { cause: validationError });
    }

    if (options.rememberDirectory !== false) rememberScannedDirectory(directoryPath);
    const maxFileSize = await getMaxFileSize();
    const scanRoot = typeof options.scanRoot === 'string' && options.scanRoot ? options.scanRoot : directoryPath;
    const excludeDirectories = scanExcludeDirectories(directoryPath, scanRoot, options);

    // Read scanAdditionalFileTypes from database (archives are always scanned, scan-worker.js)
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

    // A folder that is gone: drop its models now (there is nothing to relink them to).
    let removedEarly = false;
    if (options.removeMissing !== false && !fs.existsSync(directoryPath) && !stlHomeFolderIsGone(scanRoot, options)) {
      removedEarly = true;
      const removedCount = await removeNonExistentFiles(directoryPath, null, excludeDirectories);
      if (removedCount > 0) {
        event.sender.send('db-cleanup', { message: `Removed ${removedCount} non-existent files from directory ${directoryPath}` });
      }
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
        /** @type {any[]} */
        files: [],
        existingFilePaths: new Set(),
        newFilesCount: 0,
        relinked: 0,
        /** @type {string[]} */
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
              const known = ingestState.existingFilePaths.has(file.filePath);
              // A file moved outside JusttPrint: the model follows it (relink-moved.js).
              const movedFrom = known ? null : findMovedModel(database.db, file);
              if (known) {
                updateExisting.run(
                  file.hash || '',
                  file.size,
                  modifiedDate,
                  bundle.bundleKey || null,
                  bundle.bundleLabel || null,
                  bundle.bundleKind || null,
                  file.filePath
                );
              } else if (movedFrom) {
                moveModel(database.db, movedFrom.id, movedFrom.filePath, file.filePath);
                updateExisting.run(
                  file.hash || '',
                  file.size,
                  modifiedDate,
                  bundle.bundleKey || null,
                  bundle.bundleLabel || null,
                  bundle.bundleKind || null,
                  file.filePath
                );
                ingestState.existingFilePaths.add(file.filePath);
                ingestState.relinked++;
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

            // Now that moved files are relinked, drop the models whose files are gone.
            if (options.removeMissing !== false && !removedEarly && !stlHomeFolderIsGone(scanRoot, options)) {
              const removedCount = await removeNonExistentFiles(directoryPath, null, excludeDirectories);
              if (removedCount > 0) {
                event.sender.send('db-cleanup', {
                  message: `Removed ${removedCount} non-existent files from directory ${directoryPath}`
                });
              }
            }
            if (ingestState.relinked) console.log(`[Scan] ${ingestState.relinked} moved file(s) kept their details`);

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
            if (newFilesCount > 0) void require('../webhooks').deliver('models.added', { count: newFilesCount, directory: directoryPath });

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

      // Start the worker
      worker.postMessage({
        directoryPath,
        maxFileSize,
        scanExtensions,
        excludeFolderNames: Array.from(getScanExcludeNames()),
        excludeDirectories
      });
    });
  } catch (error) {
    console.error('Error in scan-directory handler:', error);
    throw error;
  }
}

ipcMain.handle('scan-directory', scanDirectoryHandler);
// The second pass of a scan of several folders (scan-directory with removeMissing: false first):
// drop the models under `dir` whose files are gone. Answers how many.
ipcMain.handle('remove-missing-models', async (event, dir, options) => {
  const removed = await removeMissingIn(dir, options && typeof options === 'object' ? options : {});
  if (removed > 0) require('../events').broadcast('refresh-grid');
  return { removed };
});

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
  // The data folder also counts under another path (Unraid: /mnt/user/appdata/justtprint).
  const isBlocked = (candidate) =>
    !!(
      isSystemDirectory(candidate) ||
      isUnraidSystemShare(candidate) ||
      (ctx.appDir && isInsideOrSame(candidate, ctx.appDir)) ||
      (ctx.dataDir && (isInsideOrSame(candidate, ctx.dataDir) || isInsideSameFolder(candidate, ctx.dataDir)))
    );
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

module.exports = { removeMissingIn, scanDirectoryHandler, readStlHomeExcludeDirectories };
