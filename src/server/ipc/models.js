'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const Database = require('better-sqlite3');
const printEvents = require('../../core/print-events');
const { buildFolderForest } = require('../../core/folder-tree-lib');
const { parseExcludePathList, readStlHomeDirectories } = require('../../core/library-paths');
const { ADDITIONAL_FILE_TYPES_CATALOG, buildModelFilterConditions } = require('../../core/model-filters');
const { MODEL_LIST_COLUMNS, MODEL_LIST_COLUMNS_QUALIFIED, deleteModelsByIds, getModelByFilePath } = require('../../core/models');
const events = require('../events');
const { findConflicts, mergeTagLists } = require('../../core/edit-merge');
const { getDatabasePath } = require('../../core/db-path');
const { saveModel, saveModelBatch, updateModelsBatch } = require('./model-save');

function getScanExtensions(selectedIds) {
  const extSet = new Set(['.stl', '.3mf']);
  if (selectedIds && Array.isArray(selectedIds)) {
    for (const id of selectedIds) {
      const entry = ADDITIONAL_FILE_TYPES_CATALOG.find((e) => e.id === id);
      if (entry) entry.extensions.forEach((ext) => extSet.add(ext));
    }
  }
  return Array.from(extSet);
}

function getSupportedExtensionsForLibrary(db) {
  const setting = db && db.prepare ? db.prepare('SELECT value FROM settings WHERE key = ?').get('scanAdditionalFileTypes') : null;
  let selectedIds = [];
  try {
    if (setting && setting.value) selectedIds = JSON.parse(setting.value);
  } catch (e) {
    /* ignore */
  }
  return getScanExtensions(selectedIds);
}

// Add this helper function
function normalizePath(filepath) {
  return filepath.replace(/\\/g, '/');
}

// Match library paths against a scanned directory prefix. Stored paths often use '\' on Windows while
// scan roots are normalized with forward slashes; naive LIKE would fail to pair them.
/** LIKE pattern for the models inside a folder (not a sibling such as "Designer Bx" for "Designer B"). */
function directoryScanPrefixSqlParam(scanDirectoryPath) {
  return normalizePath(scanDirectoryPath).replace(/\/$/, '').toLowerCase() + '/%';
}

ipcMain.handle('get-model', async (event, filePath) => {
  try {
    const model = getModelByFilePath(filePath, { includeThumbnail: true });
    if (!model) return null;

    // Get tags for this model
    const tags = database.db
      .prepare(
        `
      SELECT t.name 
      FROM tags t 
      JOIN model_tags mt ON mt.tag_id = t.id 
      WHERE mt.model_id = ?
    `
      )
      .all(model.id)
      .map((t) => t.name);

    return {
      ...model,
      tags: tags || [],
      categories: require('../../core/categories').modelCategoryNames(model.id)
    };
  } catch (error) {
    console.error('Error getting model:', error);
    throw error;
  }
});

/**
 * The model page's Files: the library models in the same folder as this one, or in the same zip
 * file (an online model only has itself). Each with its grid picture. At most 200.
 */
ipcMain.handle('get-folder-models', async (event, filePath) => {
  const path = require('path');
  const gridThumbnails = require('../grid-thumbnails');
  const { loadThumbnailForModel } = require('../../core/thumbnails');
  const text = String(filePath || '');
  const escape = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
  let rows;
  if (text.startsWith('url::')) {
    rows = database.db.prepare('SELECT filePath, fileName, size FROM models WHERE filePath = ?').all(text);
  } else if (text.includes('::')) {
    const zip = text.split('::')[0];
    rows = database.db.prepare("SELECT filePath, fileName, size FROM models WHERE filePath LIKE ? ESCAPE '\\' LIMIT 200").all(`${escape(zip)}::%`);
  } else {
    const folder = path.dirname(text);
    rows = database.db
      .prepare("SELECT filePath, fileName, size FROM models WHERE filePath LIKE ? ESCAPE '\\' AND filePath NOT LIKE '%::%' LIMIT 1000")
      .all(`${escape(folder)}${path.sep}%`)
      .filter((row) => path.dirname(row.filePath) === folder)
      .slice(0, 200);
  }
  return rows
    .sort((a, b) => String(a.fileName || '').localeCompare(String(b.fileName || ''), undefined, { numeric: true, sensitivity: 'base' }))
    .map((row) => ({ ...row, image: gridThumbnails.gridImage(row.filePath, () => loadThumbnailForModel(row.filePath)) }));
});

/** Tell the other open browsers which models changed, so they show the new values (core/edit-merge.js). */
function announceChanged(event, filePaths) {
  const paths = [...new Set((filePaths || []).filter((p) => typeof p === 'string' && p))];
  if (paths.length) events.broadcastToOthers(event, 'models-changed', { filePaths: paths, by: event && event.user ? event.user.username : null });
}

const storedTagNames = (modelId) =>
  database.db
    .prepare('SELECT t.name FROM model_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = ?')
    .all(modelId)
    .map((row) => row.name);

/**
 * Save one model. With `_base` (the edited fields' values when editing started) the save is
 * checked against what is stored now: when someone else changed one of those fields meanwhile,
 * nothing is saved and the answer lists the conflicts ({ success: false, conflicts }); tags are
 * merged instead. Without `_base` it saves as given (imports, MCP, "keep mine").
 */
ipcMain.handle('save-model', async (event, modelData) => {
  const data = { ...(modelData || {}) };
  const base = data._base && typeof data._base === 'object' ? data._base : null;
  delete data._base;
  const stored = base && data.filePath ? getModelByFilePath(data.filePath) : null;
  if (stored) {
    const conflicts = findConflicts(stored, data, base);
    if (conflicts.length) return { success: false, conflicts };
    if (Array.isArray(base.tags) && Array.isArray(data.tags)) data.tags = mergeTagLists(storedTagNames(stored.id), base.tags, data.tags);
  }
  const result = await saveModel(data);
  announceChanged(event, [data.filePath]);
  return result;
});

ipcMain.handle('save-model-batch', async (event, modelDataBatch) => {
  const result = await saveModelBatch(modelDataBatch);
  announceChanged(
    event,
    (Array.isArray(modelDataBatch) ? modelDataBatch : []).map((m) => m && m.filePath)
  );
  return result;
});

ipcMain.handle('update-models-batch', async (event, modelDataBatch) => {
  const result = await updateModelsBatch(modelDataBatch);
  announceChanged(
    event,
    (Array.isArray(modelDataBatch) ? modelDataBatch : []).map((m) => m && m.filePath)
  );
  return result;
});

ipcMain.handle('get-designers', async () => {
  try {
    const rows = database.db.prepare("SELECT DISTINCT designer FROM models WHERE designer IS NOT NULL AND designer != ''").all();
    return rows.map((row) => row.designer);
  } catch (error) {
    console.error('Error getting designers:', error);
    throw error;
  }
});

ipcMain.handle('get-licenses', async () => {
  try {
    const rows = database.db.prepare("SELECT DISTINCT license FROM models WHERE license IS NOT NULL AND license != ''").all();
    return rows.map((row) => row.license);
  } catch (error) {
    console.error('Error getting licenses:', error);
    throw error;
  }
});

const getAllModelsHandler = async (event, sortOption, limit = 0) => {
  try {
    // Determine the ORDER BY clause based on sortOption.
    /** @type {string | null} */
    let orderClause = '';
    switch (sortOption) {
      case 'name-asc':
        orderClause = 'ORDER BY fileName ASC';
        break;
      case 'name-desc':
        orderClause = 'ORDER BY fileName DESC';
        break;
      case 'size-asc':
        orderClause = 'ORDER BY size ASC';
        break;
      case 'size-desc':
        orderClause = 'ORDER BY size DESC';
        break;
      case 'date-asc':
        orderClause = 'ORDER BY modifiedDate ASC';
        break;
      case 'date-desc':
        orderClause = 'ORDER BY modifiedDate DESC';
        break;
      case 'dateadded-asc':
        orderClause = 'ORDER BY dateAdded ASC';
        break;
      case 'dateadded-desc':
        orderClause = 'ORDER BY dateAdded DESC';
        break;
      case 'rating-asc':
        orderClause = 'ORDER BY rating ASC, fileName ASC';
        break;
      case 'rating-desc':
        orderClause = 'ORDER BY rating DESC, fileName ASC';
        break;
      case 'printed-asc':
      case 'printed-desc':
      case 'printstatus-asc':
      case 'printstatus-desc':
      case 'printcount-asc':
      case 'printcount-desc':
      case 'lastprinted-asc':
      case 'lastprinted-desc':
        orderClause = printEvents.printSortOrderClause(sortOption);
        break;
      default:
        orderClause = 'ORDER BY modifiedDate DESC';
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
    console.error('Error in getAllModels IPC:', error);
    return [];
  }
};

ipcMain.handle('get-all-models', getAllModelsHandler);

const getModelsFilteredHandler = async (event, filters) => {
  try {
    console.debug('getModelsFiltered called with filters:', filters);
    console.debug('Designer inverted flag:', filters.designerInverted);

    const { conditions, params } = buildModelFilterConditions(filters);

    // Build WHERE clause
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    console.debug('WHERE clause built:', whereClause);
    console.debug('Conditions:', conditions);

    // Determine ORDER BY clause based on sortOption
    /** @type {string | null} */
    let orderClause = '';
    const sortOption = filters.sortOption || 'date-desc';
    switch (sortOption) {
      case 'name-asc':
        orderClause = 'ORDER BY fileName ASC';
        break;
      case 'name-desc':
        orderClause = 'ORDER BY fileName DESC';
        break;
      case 'size-asc':
        orderClause = 'ORDER BY size ASC';
        break;
      case 'size-desc':
        orderClause = 'ORDER BY size DESC';
        break;
      case 'date-asc':
        orderClause = 'ORDER BY modifiedDate ASC';
        break;
      case 'date-desc':
        orderClause = 'ORDER BY modifiedDate DESC';
        break;
      case 'dateadded-asc':
        orderClause = 'ORDER BY dateAdded ASC';
        break;
      case 'dateadded-desc':
        orderClause = 'ORDER BY dateAdded DESC';
        break;
      case 'printed-asc':
      case 'printed-desc':
      case 'printstatus-asc':
      case 'printstatus-desc':
      case 'printcount-asc':
      case 'printcount-desc':
      case 'lastprinted-asc':
      case 'lastprinted-desc':
        orderClause = printEvents.printSortOrderClause(sortOption);
        break;
      case 'rating-asc':
        orderClause = 'ORDER BY rating ASC, fileName ASC';
        break;
      case 'rating-desc':
        orderClause = 'ORDER BY rating DESC, fileName ASC';
        break;
      case 'designer-asc':
        orderClause = 'ORDER BY designer ASC';
        break;
      case 'designer-desc':
        orderClause = 'ORDER BY designer DESC';
        break;
      case 'parentmodel-asc':
        orderClause = 'ORDER BY parentModel ASC';
        break;
      case 'parentmodel-desc':
        orderClause = 'ORDER BY parentModel DESC';
        break;
      case 'directory-asc':
        orderClause = 'ORDER BY filePath ASC';
        break;
      case 'directory-desc':
        orderClause = 'ORDER BY filePath DESC';
        break;
      default:
        orderClause = 'ORDER BY modifiedDate DESC';
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
    console.debug('Executing query:', query);
    console.debug('With params:', params);

    const models = database.db.prepare(query).all(...params);

    console.debug(`Returning ${models.length} filtered models`);
    return models;
  } catch (error) {
    console.error('Error in getModelsFiltered IPC:', error);
    throw error;
  }
};

ipcMain.handle('get-models-filtered', getModelsFilteredHandler);

ipcMain.handle('get-parent-models', async () => {
  try {
    const rows = database.db.prepare("SELECT DISTINCT parentModel FROM models WHERE parentModel IS NOT NULL AND parentModel != ''").all();
    return rows.map((row) => row.parentModel);
  } catch (error) {
    console.error('Error getting parent models:', error);
    throw error;
  }
});

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
    const entry = ADDITIONAL_FILE_TYPES_CATALOG.find((e) => e.id === id);
    if (entry) entry.extensions.forEach((ext) => extSet.add(ext));
  }
  return Array.from(extSet);
}

ipcMain.handle('get-model-count-by-file-type-ids', async (event, catalogIds) => {
  try {
    const exts = getExtensionsForCatalogIds(catalogIds);
    if (exts.length === 0) return 0;
    const conditions = exts.map(() => 'LOWER(fileName) LIKE ?').join(' OR ');
    const params = exts.map((ext) => `%${ext}`);
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
    const params = exts.map((ext) => `%${ext}`);
    const modelRows = database.db.prepare(`SELECT id FROM models WHERE ${conditions}`).all(...params);
    const ids = modelRows.map((r) => r.id);
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
    const row = database.db.prepare('SELECT COUNT(*) AS total FROM models').get();
    return row.total;
  } catch (error) {
    console.error('Error getting total model count:', error);
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

ipcMain.handle('get-all-model-references', async () => {
  try {
    const modelRefs = database.db.prepare('SELECT id, filePath FROM models').all();
    return modelRefs;
  } catch (error) {
    console.error('Error getting model references:', error);
    return []; // Return an empty array on error
  }
});

module.exports = {
  directoryScanPrefixSqlParam,
  getModelsFilteredHandler,
  getScanExtensions,
  getSupportedExtensionsForLibrary,
  normalizePath,
  saveModel,
  updateModelsBatch
};
