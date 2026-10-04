'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const { getFilamentsForModel } = require('./filaments');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { deriveBundleFromFilePath } = require('../../../bundle-keys');
const printEvents = require('../../../print-events');
const { buildFolderForest } = require('../../../folder-tree-lib');
const { parseExcludePathList, readStlHomeDirectories } = require('../../core/library-paths');
const { ADDITIONAL_FILE_TYPES_CATALOG, buildModelFilterConditions } = require('../../core/model-filters');
const { loadThumbnailForModel } = require('../../core/thumbnails');
const { MODEL_DETAIL_COLUMNS, MODEL_LIST_COLUMNS, MODEL_LIST_COLUMNS_QUALIFIED, deleteModelsByIds, getModelByFilePath, getModelById, modelUserFieldsChanged, normalizeModelRating, repairModelTagsTable, replaceModelFilaments } = require('../../core/models');
const { scheduleBackgroundHashGeneration } = require('./hashes');
const { isMacOsResourceForkEntry } = require('../../core/zip-entries');
const { getDatabasePath } = require('../../core/db-path');
const { withZipFileLock } = require('../../../zip-extract');

function getScanExtensions(selectedIds) {
  const extSet = new Set(['.stl', '.3mf']);
  if (selectedIds && Array.isArray(selectedIds)) {
    for (const id of selectedIds) {
      const entry = ADDITIONAL_FILE_TYPES_CATALOG.find(e => e.id === id);
      if (entry) entry.extensions.forEach(ext => extSet.add(ext));
    }
  }
  return Array.from(extSet);
}

function getSupportedExtensionsForLibrary(db) {
  const setting = db && db.prepare ? db.prepare('SELECT value FROM settings WHERE key = ?').get('scanAdditionalFileTypes') : null;
  let selectedIds = [];
  try {
    if (setting && setting.value) selectedIds = JSON.parse(setting.value);
  } catch (e) { /* ignore */ }
  return getScanExtensions(selectedIds);
}

// Add this helper function
function normalizePath(filepath) {
  return filepath.replace(/\\/g, '/');
}

// Match library paths against a scanned directory prefix. Stored paths often use '\' on Windows while
// scan roots are normalized with forward slashes; naive LIKE would fail to pair them.
function directoryScanPrefixSqlParam(scanDirectoryPath) {
  return normalizePath(scanDirectoryPath).replace(/\/$/, '').toLowerCase() + '%';
}

ipcMain.handle('get-model', async (event, filePath) => {
  try {
    const model = getModelByFilePath(filePath, { includeThumbnail: true });
    if (!model) return null;

    // Get tags for this model
    const tags = database.db.prepare(`
      SELECT t.name 
      FROM tags t 
      JOIN model_tags mt ON mt.tag_id = t.id 
      WHERE mt.model_id = ?
    `).all(model.id).map(t => t.name);

    const filaments = getFilamentsForModel(model.id);

    // Parse any JSON fields
    return {
      ...model,
      tags: tags || [],
      filaments: filaments || []
    };
  } catch (error) {
    console.error('Error getting model:', error);
    throw error;
  }
});

// Update the save-model handler to not store tags in the models table
ipcMain.handle('save-model', async (event, modelData) => {
  return await saveModel(modelData);
});

ipcMain.handle('save-model-batch', async (event, modelDataBatch) => {
  return await saveModelBatch(modelDataBatch);
});

ipcMain.handle('update-models-batch', async (event, modelDataBatch) => {
  return await updateModelsBatch(modelDataBatch);
});

ipcMain.handle('get-designers', async () => {
  try {
    const rows = database.db.prepare("SELECT DISTINCT designer FROM models WHERE designer IS NOT NULL AND designer != ''").all();
    return rows.map(row => row.designer);
  } catch (error) {
    console.error('Error getting designers:', error);
    throw error;
  }
});

ipcMain.handle('get-licenses', async () => {
  try {
    const rows = database.db.prepare("SELECT DISTINCT license FROM models WHERE license IS NOT NULL AND license != ''").all();
    return rows.map(row => row.license);
  } catch (error) {
    console.error('Error getting licenses:', error);
    throw error;
  }
});

ipcMain.handle('get-models-by-designer', async (event, designer) => {
  try {
    const rows = database.db.prepare(`
      SELECT id, filePath, fileName, designer, source, notes, printed, print_status, print_count, last_printed_at, parentModel, hash, size, license, modifiedDate, dateAdded, isNew, rating, favorite
      FROM models WHERE designer = ?
    `).all(designer);
    return rows.map((row) => ({
      ...row,
      thumbnail: loadThumbnailForModel(row.filePath)
    }));
  } catch (error) {
    console.error('Error getting models by designer:', error);
    throw error;
  }
});

const getAllModelsHandler = async (event, sortOption, limit = 0) => {
  try {
    // Determine the ORDER BY clause based on sortOption.
    let orderClause = "";
    switch (sortOption) {
      case "name-asc":
        orderClause = "ORDER BY fileName ASC";
        break;
      case "name-desc":
        orderClause = "ORDER BY fileName DESC";
        break;
      case "size-asc":
        orderClause = "ORDER BY size ASC";
        break;
      case "size-desc":
        orderClause = "ORDER BY size DESC";
        break;
      case "date-asc":
        orderClause = "ORDER BY modifiedDate ASC";
        break;
      case "date-desc":
        orderClause = "ORDER BY modifiedDate DESC";
        break;
      case "dateadded-asc":
        orderClause = "ORDER BY dateAdded ASC";
        break;
      case "dateadded-desc":
        orderClause = "ORDER BY dateAdded DESC";
        break;
      case "rating-asc":
        orderClause = "ORDER BY rating ASC, fileName ASC";
        break;
      case "rating-desc":
        orderClause = "ORDER BY rating DESC, fileName ASC";
        break;
      case "printed-asc":
      case "printed-desc":
      case "printstatus-asc":
      case "printstatus-desc":
      case "printcount-asc":
      case "printcount-desc":
      case "lastprinted-asc":
      case "lastprinted-desc":
        orderClause = printEvents.printSortOrderClause(sortOption);
        break;
      default:
        orderClause = "ORDER BY modifiedDate DESC";
        break;
    }

const selectCols = MODEL_LIST_COLUMNS;

    let models;
    if (limit === 0) {
      // When limit is 0, load all models without a limit
      models = database.db.prepare(`SELECT ${selectCols} FROM models ${orderClause}`).all();
    } else {
      models = database.db.prepare(`SELECT ${selectCols} FROM models ${orderClause} LIMIT ?`).all(limit);
    }
    return models;
  } catch (error) {
    console.error("Error in getAllModels IPC:", error);
    return [];
  }
};

ipcMain.handle('get-all-models', getAllModelsHandler);

const getModelsFilteredHandler = async (event, filters) => {
  try {
    console.log('getModelsFiltered called with filters:', filters);
    console.log('Designer inverted flag:', filters.designerInverted);

    const { conditions, params } = buildModelFilterConditions(filters);

    // Build WHERE clause
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    console.log('WHERE clause built:', whereClause);
    console.log('Conditions:', conditions);
    
    // Determine ORDER BY clause based on sortOption
    let orderClause = "";
    const sortOption = filters.sortOption || 'date-desc';
    switch (sortOption) {
      case "name-asc":
        orderClause = "ORDER BY fileName ASC";
        break;
      case "name-desc":
        orderClause = "ORDER BY fileName DESC";
        break;
      case "size-asc":
        orderClause = "ORDER BY size ASC";
        break;
      case "size-desc":
        orderClause = "ORDER BY size DESC";
        break;
      case "date-asc":
        orderClause = "ORDER BY modifiedDate ASC";
        break;
      case "date-desc":
        orderClause = "ORDER BY modifiedDate DESC";
        break;
      case "dateadded-asc":
        orderClause = "ORDER BY dateAdded ASC";
        break;
      case "dateadded-desc":
        orderClause = "ORDER BY dateAdded DESC";
        break;
      case "printed-asc":
      case "printed-desc":
      case "printstatus-asc":
      case "printstatus-desc":
      case "printcount-asc":
      case "printcount-desc":
      case "lastprinted-asc":
      case "lastprinted-desc":
        orderClause = printEvents.printSortOrderClause(sortOption);
        break;
      case "rating-asc":
        orderClause = "ORDER BY rating ASC, fileName ASC";
        break;
      case "rating-desc":
        orderClause = "ORDER BY rating DESC, fileName ASC";
        break;
      case "designer-asc":
        orderClause = "ORDER BY designer ASC";
        break;
      case "designer-desc":
        orderClause = "ORDER BY designer DESC";
        break;
      case "parentmodel-asc":
        orderClause = "ORDER BY parentModel ASC";
        break;
      case "parentmodel-desc":
        orderClause = "ORDER BY parentModel DESC";
        break;
      case "directory-asc":
        orderClause = "ORDER BY filePath ASC";
        break;
      case "directory-desc":
        orderClause = "ORDER BY filePath DESC";
        break;
      default:
        orderClause = "ORDER BY modifiedDate DESC";
        break;
    }
    
const selectCols = MODEL_LIST_COLUMNS_QUALIFIED;

    // Execute query (optional limit/offset for progressive load when clearing filters in Server/Docker)
    // SQLite requires LIMIT when using OFFSET; use a large limit when only offset is set
    let query = `SELECT ${selectCols} FROM models ${whereClause} ${orderClause}`;
    const limit = filters.limit != null && filters.limit > 0 ? Math.min(Number(filters.limit), 10000) : null;
    const offset = filters.offset != null && filters.offset >= 0 ? Number(filters.offset) : null;
    if (limit != null) {
      query += ` LIMIT ${Math.floor(limit)}`;
      if (offset != null) query += ` OFFSET ${Math.floor(offset)}`;
    } else if (offset != null) {
      query += ` LIMIT 999999 OFFSET ${Math.floor(offset)}`;
    }
    console.log('Executing query:', query);
    console.log('With params:', params);
    
    const models = database.db.prepare(query).all(...params);

    console.log(`Returning ${models.length} filtered models`);
    return models;
  } catch (error) {
    console.error("Error in getModelsFiltered IPC:", error);
    throw error;
  }
};

ipcMain.handle('get-models-filtered', getModelsFilteredHandler);

ipcMain.handle('get-parent-models', async () => {
  try {
    const rows = database.db.prepare("SELECT DISTINCT parentModel FROM models WHERE parentModel IS NOT NULL AND parentModel != ''").all();
    return rows.map(row => row.parentModel);
  } catch (error) {
    console.error('Error getting parent models:', error);
    throw error;
  }
});

function normalizeFilamentIds(raw) {
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  const ids = [];
  const seen = new Set();
  for (const item of list) {
    let id = null;
    if (item && typeof item === 'object') id = Number(item.id);
    else id = Number(item);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// Add error handling to the getSetting handler
async function getAdditionalFileTypesCatalogHandler() {
  return ADDITIONAL_FILE_TYPES_CATALOG;
}

ipcMain.handle('get-additional-file-types-catalog', getAdditionalFileTypesCatalogHandler);

/** Get extensions (e.g. ['.obj']) for catalog ids (e.g. ['obj']). Used to find/remove models by file type. */
function getExtensionsForCatalogIds(catalogIds) {
  if (!catalogIds || !Array.isArray(catalogIds) || catalogIds.length === 0) return [];
  const extSet = new Set();
  for (const id of catalogIds) {
    const entry = ADDITIONAL_FILE_TYPES_CATALOG.find(e => e.id === id);
    if (entry) entry.extensions.forEach(ext => extSet.add(ext));
  }
  return Array.from(extSet);
}

ipcMain.handle('get-model-count-by-file-type-ids', async (event, catalogIds) => {
  try {
    const exts = getExtensionsForCatalogIds(catalogIds);
    if (exts.length === 0) return 0;
    const conditions = exts.map(() => 'LOWER(fileName) LIKE ?').join(' OR ');
    const params = exts.map(ext => `%${ext}`);
    const row = database.db.prepare(`SELECT COUNT(*) AS count FROM models WHERE ${conditions}`).get(...params);
    return row ? row.count : 0;
  } catch (error) {
    console.error('Error getting model count by file type ids:', error);
    throw error;
  }
});

ipcMain.handle('remove-models-by-file-type-ids', async (event, catalogIds) => {
  try {
    const exts = getExtensionsForCatalogIds(catalogIds);
    if (exts.length === 0) return { deleted: 0 };
    const conditions = exts.map(() => 'LOWER(fileName) LIKE ?').join(' OR ');
    const params = exts.map(ext => `%${ext}`);
    const modelRows = database.db.prepare(`SELECT id FROM models WHERE ${conditions}`).all(...params);
    const ids = modelRows.map(r => r.id);
    if (ids.length === 0) return { deleted: 0 };
    const deleted = database.db.transaction(() => {
      deleteModelsByIds(ids);
      return ids.length;
    })();
    return { deleted };
  } catch (error) {
    console.error('Error removing models by file type ids:', error);
    throw error;
  }
});

const clearNewFlagsHandler = async () => {
  try {
    if (!database.db || !database.db.open) {
      const dbPath = getDatabasePath();
      database.db = new Database(dbPath);
    }
    const result = database.db.prepare('UPDATE models SET isNew = 0 WHERE isNew = 1').run();
    return { success: true, cleared: result.changes || 0 };
  } catch (error) {
    console.error('Error clearing new flags:', error);
    throw error;
  }
};

ipcMain.handle('clear-new-model-flags', clearNewFlagsHandler);

ipcMain.handle('getTotalModelCount', async () => {
  try {
    // Query total count from the models table
    const row = database.db.prepare("SELECT COUNT(*) AS total FROM models").get();
    return row.total;
  } catch (error) {
    console.error("Error getting total model count:", error);
    return 0;
  }
});

ipcMain.handle('get-folder-tree', async () => {
  try {
    const rows = database.db.prepare('SELECT filePath FROM models').all();
    const filePaths = rows.map((r) => r.filePath).filter(Boolean);
    const homes = readStlHomeDirectories();
    const envHomes = parseExcludePathList(process.env.STL_HOME);
    const lastScan = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('directoryPath')?.value || '';
    const primary = homes[0] || envHomes[0] || '';
    return buildFolderForest(filePaths, {
      stlHome: primary,
      roots: [...homes, ...envHomes, lastScan].filter(Boolean)
    });
  } catch (error) {
    console.error('Error building folder tree:', error);
    return { roots: [] };
  }
});

// Add this new IPC handler to fetch models by directory
ipcMain.handle('get-models-by-directory', async (event, directoryPath) => {
  try {
const selectCols = MODEL_LIST_COLUMNS;
    const models = database.db.prepare(`
      SELECT ${selectCols} FROM models
      WHERE REPLACE(LOWER(filePath), CHAR(92), '/') LIKE ?
    `).all(directoryScanPrefixSqlParam(directoryPath));
    return models;
  } catch (error) {
    console.error('Error fetching models by directory:', error);
    throw error;
  }
});

// Example: Get models for a given page (limit and offset)
ipcMain.handle('get-models-page', async (event, { page, pageSize, sortOption }) => {
  try {
    const offset = (page - 1) * pageSize;
const selectCols = MODEL_LIST_COLUMNS;
    const models = database.db.prepare(
      `SELECT ${selectCols} FROM models ORDER BY ${sortOption} LIMIT ? OFFSET ?`
    ).all(pageSize, offset);
    return models;
  } catch (error) {
    console.error('Error fetching models page:', error);
    return [];
  }
});

ipcMain.handle('get-all-model-references', async () => {
  try {
    const modelRefs = database.db.prepare('SELECT id, filePath FROM models').all();
    return modelRefs;
  } catch (error) {
    console.error('Error getting model references:', error);
    return []; // Return an empty array on error
  }
});

// Add this function after the saveModel function
async function saveModelBatch(modelDataBatch) {
  try {
    if (!database.db) {
      console.error('Database not initialized');
      return false;
    }

    // Begin a transaction for better performance
    const transaction = database.db.transaction(() => {
      const stmt = database.db.prepare(`
        INSERT OR IGNORE INTO models 
        (filePath, fileName, hash, size, modifiedDate, dateAdded, isNew) 
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `);
      
      for (const modelData of modelDataBatch) {
        const dateAdded = new Date().toISOString();
        stmt.run(
          modelData.filePath,
          modelData.fileName,
          modelData.hash || '',
          modelData.size || 0,
          modelData.modifiedDate || dateAdded,
          dateAdded
        );
      }
    });
    
    transaction();
    scheduleBackgroundHashGeneration('save-model-batch');
    return true;
  } catch (error) {
    console.error('Error saving model batch:', error);
    return false;
  }
}

// Bulk update function for updating multiple models in a single transaction
async function updateModelsBatch(modelDataBatch) {
  try {
    if (!database.db) {
      console.error('Database not initialized');
      return false;
    }

    // Enable foreign key constraints
    database.db.pragma('foreign_keys = ON');

    // Use a transaction for better performance - update models and tags together
    const transaction = database.db.transaction(() => {
      const getModelIdStmt = database.db.prepare('SELECT id FROM models WHERE filePath = ?');
      const getExistingModelStmt = database.db.prepare(`SELECT ${MODEL_DETAIL_COLUMNS} FROM models WHERE filePath = ?`);
      const getExistingTagsStmt = database.db.prepare(`
        SELECT t.name FROM model_tags mt
        JOIN tags t ON mt.tag_id = t.id
        WHERE mt.model_id = ?
      `);
      const updateStmt = database.db.prepare(`
        UPDATE models SET 
          fileName = ?,
          designer = ?,
          source = ?,
          notes = ?,
          printed = ?,
          print_status = ?,
          print_count = ?,
          last_printed_at = ?,
          parentModel = ?,
          license = ?,
          rating = ?,
          favorite = ?,
          isNew = CASE WHEN ? THEN 0 ELSE isNew END
        WHERE filePath = ?
      `);

      const deleteTagsStmt = database.db.prepare('DELETE FROM model_tags WHERE model_id = ?');
      const getTagIdStmt = database.db.prepare('SELECT id FROM tags WHERE name = ?');
      const insertTagStmt = database.db.prepare('INSERT OR IGNORE INTO model_tags (model_id, tag_id) VALUES (?, ?)');
      const insertTagNameStmt = database.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
      const getTagIdAfterInsertStmt = database.db.prepare('SELECT id FROM tags WHERE name = ?');

      for (let i = 0; i < modelDataBatch.length; i++) {
        const modelData = modelDataBatch[i];
        const {
          filePath,
          fileName,
          designer,
          source,
          notes,
          printed,
          printStatus,
          parentModel,
          license,
          rating,
          favorite,
          tags,
          filaments
        } = modelData;

        console.log(`[Batch ${i}] Processing model: ${filePath}`);
        console.log(`[Batch ${i}] Field values:`, { fileName, designer, source, notes, printed, parentModel, license, tags });

        // Get existing model to preserve values that aren't being updated
        const existingModel = getExistingModelStmt.get(filePath);
        
        if (!existingModel) {
          console.warn(`[Batch ${i}] Model not found in database: ${filePath}`);
          continue; // Skip this model if it doesn't exist
        }
        
        console.log(`[Batch ${i}] Found existing model with ID: ${existingModel.id}`);
        // Only update fields that are explicitly provided (not undefined)
        const finalFileName = fileName !== undefined ? fileName : existingModel.fileName;
        const finalDesigner = designer !== undefined ? (designer || null) : existingModel.designer;
        const finalSource = source !== undefined ? (source || null) : existingModel.source;
        const finalNotes = notes !== undefined ? (notes || null) : existingModel.notes;
        const printFields = printEvents.resolvePrintFieldsOnSave(existingModel, { printed, printStatus });
        const finalPrinted = printFields.printed;
        const finalPrintStatus = printFields.print_status;
        const finalPrintCount = printFields.print_count;
        const finalLastPrintedAt = printFields.last_printed_at;
        const finalParentModel = parentModel !== undefined ? (parentModel || null) : existingModel.parentModel;
        const finalLicense = license !== undefined ? (license || null) : existingModel.license;
        const finalRating = rating !== undefined ? normalizeModelRating(rating) : normalizeModelRating(existingModel.rating);
        const finalFavorite = favorite !== undefined ? (favorite ? 1 : 0) : (existingModel.favorite ? 1 : 0);

        const finals = {
          fileName: finalFileName,
          designer: finalDesigner,
          source: finalSource,
          notes: finalNotes,
          printed: finalPrinted,
          print_status: finalPrintStatus,
          parentModel: finalParentModel,
          license: finalLicense
        };
        let clearIsNew = modelUserFieldsChanged(existingModel, finals);
        if (!clearIsNew && tags !== undefined && Array.isArray(tags)) {
          const existingTagRows = getExistingTagsStmt.all(existingModel.id).map((row) => row.name);
          clearIsNew = JSON.stringify(sortedTagNames(existingTagRows)) !== JSON.stringify(sortedTagNames(tags));
        }

        // Update model fields
        console.log(`[Batch ${i}] Updating model with values:`, {
          finalFileName,
          finalDesigner,
          finalSource,
          finalNotes,
          finalPrinted,
          finalParentModel,
          finalLicense,
          filePath,
          clearIsNew
        });
        const updateResult = updateStmt.run(
          finalFileName,
          finalDesigner,
          finalSource,
          finalNotes,
          finalPrinted,
          finalPrintStatus,
          finalPrintCount,
          finalLastPrintedAt,
          finalParentModel,
          finalLicense,
          finalRating,
          finalFavorite,
          clearIsNew ? 1 : 0,
          filePath
        );
        console.log(`[Batch ${i}] Update result:`, updateResult);

        // Handle tags if provided
        if (tags && Array.isArray(tags) && tags.length > 0) {
          const modelId = existingModel.id;
          
          // Delete existing tags
          deleteTagsStmt.run(modelId);
          
          // Insert new tags
          for (const tagName of tags) {
            if (!tagName || typeof tagName !== 'string' || tagName.trim() === '') continue;
            
            const trimmedTagName = tagName.trim();
            
            // Get or create tag
            let tagResult = getTagIdStmt.get(trimmedTagName);
            if (!tagResult) {
              // Tag doesn't exist, create it
              insertTagNameStmt.run(trimmedTagName);
              tagResult = getTagIdAfterInsertStmt.get(trimmedTagName);
            }
            
            if (tagResult) {
              insertTagStmt.run(modelId, tagResult.id);
            }
          }
        }

        if (filaments !== undefined) {
          replaceModelFilaments(existingModel.id, normalizeFilamentIds(filaments) || []);
        }
      }
    });

    transaction();

    return true;
  } catch (error) {
    console.error('Error updating models batch:', error);
    return false;
  }
}

function sortedTagNames(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => String(t).trim()).filter(Boolean).sort();
}

// Add this function before the IPC handlers
async function saveModel(modelData) {
  try {
    console.log('saveModel:', modelData?.filePath, modelData?.id != null ? `(id ${modelData.id})` : '');
    
    let {
      id: inputId, // Rename to avoid confusion
      filePath: filePathIn,
      fileName,
      designer,
      source,
      notes,
      printed,
      printStatus,
      parentModel,
      license,
      rating,
      favorite,
      tags: rawTags,
      filaments: rawFilaments,
      markAsNew
    } = modelData;

    // Extension path mapping (Docker: client path -> container path) and optional copy to NAS
    let resolvedFilePath = filePathIn;
    const clientPrefixRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('extensionClientPathPrefix');
    const containerPrefixRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('extensionContainerPathPrefix');
    const copyToNasRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('extensionCopyToNasPath');
    const clientPrefix = (clientPrefixRow && clientPrefixRow.value) ? String(clientPrefixRow.value).replace(/\\/g, '/').trim().replace(/\/+$/, '') : '';
    const containerPrefix = (containerPrefixRow && containerPrefixRow.value) ? String(containerPrefixRow.value).replace(/\\/g, '/').trim().replace(/\/+$/, '') : '';
    const copyToNasPath = (copyToNasRow && copyToNasRow.value) ? String(copyToNasRow.value).replace(/\\/g, '/').trim().replace(/\/+$/, '') : '';
    if (clientPrefix && containerPrefix && filePathIn && typeof filePathIn === 'string') {
      const normalizedInput = filePathIn.replace(/\\/g, '/').trim();
      const prefixNorm = clientPrefix.toLowerCase();
      const inputNorm = normalizedInput.toLowerCase();
      if (inputNorm.startsWith(prefixNorm)) {
        const rest = normalizedInput.slice(clientPrefix.length).replace(/^\//, '');
        resolvedFilePath = containerPrefix + (rest ? '/' + rest : '');
      }
    }
    const zipSepForCopy = resolvedFilePath ? resolvedFilePath.indexOf('::') : -1;
    const srcFileForCopy = (resolvedFilePath && zipSepForCopy >= 0) ? resolvedFilePath.slice(0, zipSepForCopy) : resolvedFilePath;
    if (copyToNasPath && srcFileForCopy && fs.existsSync(srcFileForCopy)) {
      const base = path.basename(srcFileForCopy);
      const destFile = path.join(copyToNasPath, base);
      if (!fs.existsSync(path.dirname(destFile))) fs.mkdirSync(path.dirname(destFile), { recursive: true });
      if (path.resolve(srcFileForCopy) !== path.resolve(destFile)) {
        fs.copyFileSync(srcFileForCopy, destFile);
        resolvedFilePath = (zipSepForCopy >= 0) ? destFile + resolvedFilePath.slice(zipSepForCopy) : destFile;
      }
    } else if (copyToNasPath && resolvedFilePath) {
      const srcFile = (zipSepForCopy >= 0) ? resolvedFilePath.slice(0, zipSepForCopy) : resolvedFilePath;
      if (srcFile && !fs.existsSync(srcFile)) {
        console.warn('saveModel: extension path mapping resolved path not found on server:', srcFile);
      }
    }
    const filePath = resolvedFilePath;

    // Standalone .zip: only add if "Include zipped models" is enabled; add each STL/3MF inside (like scan)
    if (filePath && filePath.toLowerCase().endsWith('.zip') && !filePath.includes('::')) {
      const zipSetting = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enableZipArchives');
      const enableZipArchives = zipSetting && zipSetting.value === '1';
      if (!enableZipArchives) {
        throw new Error('ZIP archives are disabled. Enable "Include zipped models" in Settings to add .zip files.');
      }
      // List STL/3MF entries and save each as zipPath::entryPath (same as scan)
      if (!fs.existsSync(filePath)) {
        throw new Error(`ZIP file not found: ${filePath}`);
      }
      const entries = await withZipFileLock(filePath, async () => {
        const StreamZip = require('node-stream-zip');
        const zip = new StreamZip.async({ file: filePath });
        try {
          return await zip.entries();
        } finally {
          await zip.close();
        }
      });
      const modelExts = getSupportedExtensionsForLibrary(database.db);
      const toAdd = Object.values(entries).filter(
        (e) => !e.isDirectory
          && modelExts.includes(path.extname(e.name).toLowerCase())
          && !isMacOsResourceForkEntry(e.name)
      );
      if (toAdd.length === 0) {
        throw new Error('No supported model files found in the ZIP file. Enable additional file types in Settings > File Type if needed.');
      }
      const baseMeta = {
        designer,
        source,
        notes,
        printed,
        parentModel,
        license,
        rating,
        favorite,
        tags: rawTags,
        filaments: rawFilaments,
        markAsNew
      };
      for (const entry of toAdd) {
        const entryPath = `${filePath}::${entry.name}`;
        const entryFileName = path.basename(entry.name);
        await saveModel({
          ...baseMeta,
          filePath: entryPath,
          fileName: entryFileName
        });
      }
      return { success: true, expanded: true, count: toAdd.length };
    }

    // Ensure tags is always an array, even if a single string was passed
    const tags = rawTags ? (Array.isArray(rawTags) ? rawTags : [rawTags]) : [];

    console.log(`Processing notes field: "${notes}"`);

    // Enable foreign key constraints
    database.db.pragma('foreign_keys = ON');

    // First, handle the model data without tags
    let modelId;
    let insertedNewModel = false;
    try {
      // Check if the model exists first
      const existingModel = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get(filePath);
      
      if (existingModel) {
        // Update existing model
        console.log(`Updating existing model with ID: ${existingModel.id}`);
        
        // Get existing model data to preserve values that aren't being updated
        const existingModelData = getModelById(existingModel.id);
        
        // Only update fields that are explicitly provided (not undefined)
        // Preserve existing values for fields that are undefined in the update
        const finalFileName = fileName !== undefined ? fileName : existingModelData.fileName;
        const finalDesigner = designer !== undefined ? (designer || null) : existingModelData.designer;
        const finalSource = source !== undefined ? (source || null) : existingModelData.source;
        const finalNotes = notes !== undefined ? (notes || null) : existingModelData.notes;
        const printFields = printEvents.resolvePrintFieldsOnSave(existingModelData, { printed, printStatus });
        const finalPrinted = printFields.printed;
        const finalPrintStatus = printFields.print_status;
        const finalPrintCount = printFields.print_count;
        const finalLastPrintedAt = printFields.last_printed_at;
        const finalParentModel = parentModel !== undefined ? (parentModel || null) : existingModelData.parentModel;
        const finalLicense = license !== undefined ? (license || null) : existingModelData.license;
        const finalRating = rating !== undefined ? normalizeModelRating(rating) : normalizeModelRating(existingModelData.rating);
        const finalFavorite = favorite !== undefined ? (favorite ? 1 : 0) : (existingModelData.favorite ? 1 : 0);

        const finals = {
          fileName: finalFileName,
          designer: finalDesigner,
          source: finalSource,
          notes: finalNotes,
          printed: finalPrinted,
          print_status: finalPrintStatus,
          parentModel: finalParentModel,
          license: finalLicense
        };
        let clearIsNew = !markAsNew && modelUserFieldsChanged(existingModelData, finals);
        if (!markAsNew && !clearIsNew && rawTags !== undefined) {
          const existingTagRows = database.db.prepare(`
            SELECT t.name FROM model_tags mt
            JOIN tags t ON mt.tag_id = t.id
            WHERE mt.model_id = ?
          `).all(existingModel.id).map((row) => row.name);
          clearIsNew = JSON.stringify(sortedTagNames(existingTagRows)) !== JSON.stringify(sortedTagNames(tags));
        }
        const bundle = deriveBundleFromFilePath(filePath);
        
        // Use a simpler update approach to avoid foreign key issues
        const updateStmt = database.db.prepare(`
          UPDATE models SET 
            fileName = ?,
            designer = ?,
            source = ?,
            notes = ?,
            printed = ?,
            print_status = ?,
            print_count = ?,
            last_printed_at = ?,
            parentModel = ?,
            license = ?,
            rating = ?,
            favorite = ?,
            bundleKey = ?,
            bundleLabel = ?,
            bundleKind = ?,
            isNew = CASE WHEN ? THEN 1 WHEN ? THEN 0 ELSE isNew END
          WHERE id = ?
        `);
        
        updateStmt.run(
          finalFileName,
          finalDesigner,
          finalSource,
          finalNotes,
          finalPrinted,
          finalPrintStatus,
          finalPrintCount,
          finalLastPrintedAt,
          finalParentModel,
          finalLicense,
          finalRating,
          finalFavorite,
          bundle.bundleKey || null,
          bundle.bundleLabel || null,
          bundle.bundleKind || null,
          markAsNew ? 1 : 0,
          clearIsNew ? 1 : 0,
          existingModel.id
        );
        
        modelId = existingModel.id;
      } else {
        // Insert new model
        console.log('Inserting new model');
        
        const printFields = printEvents.resolvePrintFieldsOnSave(null, { printed, printStatus });
        const dateAdded = new Date().toISOString();
        const bundle = deriveBundleFromFilePath(filePath);
        const insertStmt = database.db.prepare(`
          INSERT INTO models (
            filePath, fileName, designer, source, notes, printed, print_status, print_count, last_printed_at, parentModel, license,
            dateAdded, isNew, rating, favorite, bundleKey, bundleLabel, bundleKind
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        `);
        
        const result = insertStmt.run(
          filePath,
          fileName,
          designer || null,
          source || null,
          notes || null,
          printFields.printed,
          printFields.print_status,
          printFields.print_count,
          printFields.last_printed_at,
          parentModel || null,
          license || null,
          dateAdded,
          normalizeModelRating(rating),
          favorite ? 1 : 0,
          bundle.bundleKey || null,
          bundle.bundleLabel || null,
          bundle.bundleKind || null
        );
        
        modelId = result.lastInsertRowid;
        insertedNewModel = true;
      }
      
      console.log(`Model saved with ID: ${modelId}`);
    } catch (modelError) {
      console.error('Error saving model data:', modelError);
      throw modelError;
    }

    // Now handle tags in a separate transaction if we have a valid model ID
    // Note: We need to process tags even if the array is empty (to remove all tags)
    if (modelId && tags && Array.isArray(tags)) {
      try {
        console.log(`Processing ${tags.length} tags for model ID ${modelId}`);
        
        // Double-check that the model exists before proceeding
        const modelExists = database.db.prepare('SELECT 1 FROM models WHERE id = ?').get(modelId);
        if (!modelExists) {
          console.error(`Model ID ${modelId} does not exist in the database. This should not happen.`);
          return { success: true, modelId }; // Return success but skip tag processing
        }
        
        // Use a transaction to ensure atomicity and handle errors gracefully
        database.db.transaction(() => {
          // First, get existing tags before deleting (to preserve them if there's an error)
          const existingTags = database.db.prepare(`
            SELECT t.name 
            FROM model_tags mt
            JOIN tags t ON mt.tag_id = t.id
            WHERE mt.model_id = ?
          `).all(modelId).map(row => row.name);
          
          // First, remove all existing tags for this model
          const deleteResult = database.db.prepare('DELETE FROM model_tags WHERE model_id = ?').run(modelId);
          console.log(`Deleted ${deleteResult.changes} existing tag relationships`);

          // Process each tag individually (only if there are tags to add)
          if (tags.length > 0) {
            for (const tagName of tags) {
              if (tagName && typeof tagName === 'string' && tagName.trim() !== '') {
                const trimmedTagName = tagName.trim();
                try {
                  console.log(`Processing tag: "${trimmedTagName}"`);
                  
                  // First ensure the tag exists in the tags table
                  database.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(trimmedTagName);
                  
                  // Get the tag ID directly
                  const tagRow = database.db.prepare('SELECT id FROM tags WHERE name = ?').get(trimmedTagName);
                  
                  if (tagRow && tagRow.id) {
                    console.log(`Found tag ID ${tagRow.id} for "${trimmedTagName}"`);
                    
                    // Now create the relationship with the known IDs
                    database.db.prepare('INSERT OR IGNORE INTO model_tags (model_id, tag_id) VALUES (?, ?)').run(modelId, tagRow.id);
                  } else {
                    console.warn(`Could not find tag ID for "${trimmedTagName}" after insertion`);
                  }
                } catch (singleTagError) {
                  console.error(`Error processing tag "${trimmedTagName}":`, singleTagError);
                  // Continue with other tags
                }
              }
            }
          } else {
            console.log('Tags array is empty - all tags have been removed from this model');
          }
        })();
      } catch (tagError) {
        console.error('Error updating tags:', tagError);
        
        // models_old means model_tags still references the renamed parent table.
        // Repair outside this failed transaction, then retry the tag write.
        if (tagError.message && tagError.message.includes('models_old')) {
          console.log('Detected models_old error. Repairing model_tags and retrying...');
          try {
            repairModelTagsTable();
            // Retry the tag save operation in a new transaction
            database.db.transaction(() => {
              // Delete existing tags first
              database.db.prepare('DELETE FROM model_tags WHERE model_id = ?').run(modelId);
              
              // Re-insert the tags we were trying to save (only if there are tags)
              if (tags.length > 0) {
                for (const tagName of tags) {
                  if (tagName && typeof tagName === 'string' && tagName.trim() !== '') {
                    const trimmedTagName = tagName.trim();
                    try {
                      database.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(trimmedTagName);
                      const tagRow = database.db.prepare('SELECT id FROM tags WHERE name = ?').get(trimmedTagName);
                      if (tagRow && tagRow.id) {
                        database.db.prepare('INSERT OR IGNORE INTO model_tags (model_id, tag_id) VALUES (?, ?)').run(modelId, tagRow.id);
                      }
                    } catch (retryError) {
                      console.error(`Error retrying tag "${trimmedTagName}":`, retryError);
                    }
                  }
                }
              }
            })();
            console.log('Successfully retried tag save after repairing model_tags');
          } catch (cleanupError) {
            console.error('Error during cleanup and retry:', cleanupError);
            // Don't throw - we want to preserve the model save even if tags fail
          }
        }
        // Continue with the save even if tag update fails - don't throw to preserve model data
      }
    }

    if (modelId && rawFilaments !== undefined) {
      try {
        replaceModelFilaments(modelId, normalizeFilamentIds(rawFilaments) || []);
      } catch (filamentError) {
        console.error('Error updating filaments:', filamentError);
      }
    }

    if (insertedNewModel) {
      scheduleBackgroundHashGeneration('save-model');
    }
    return { success: true, modelId };

  } catch (error) {
    console.error('Error saving model:', error);
    throw error;
  }
}

module.exports = { directoryScanPrefixSqlParam, getModelsFilteredHandler, getScanExtensions, normalizeFilamentIds, normalizePath, saveModel, updateModelsBatch };
