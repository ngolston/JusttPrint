'use strict';

const events = require('./events');
const modelFolders = require('./model-folders');
const database = require('../core/database');
const { ipcMain, shell } = require('./runtime');

// Some MCP tools reuse the IPC handler of the same action.
const ipcHandlerRegistry = ipcMain._handlers;
const fs = require('fs');
const path = require('path');
const printEvents = require('../core/print-events');
const { isUrlModel, parseZipPath, readStlHomeDirectories, assertContainerPath } = require('../core/library-paths');
const { applyThumbnailFlags, loadThumbnailForModel, parseThumbnails, readThumbnailColumn } = require('../core/thumbnails');
const { MODEL_LIST_COLUMNS, deleteModelsByFilePaths, getModelByFilePath, getModelById } = require('../core/models');
const { deleteTagHandler, generateTagsHandler, getAllTagsHandler, renameTagForMcp, resolveTagForMcp, saveTagHandler } = require('./ipc/tags');
const { countModelsNeedingHash, generateMissingHashesHandler, getDuplicatesHandler, hashGenerationRunning } = require('./ipc/hashes');
const { assertMcpToolArgs } = require('./server-paths');
const { openFileInSlicerHandler } = require('./ipc/slicers');
const { extract3MFMetadata, filter3MFMetadataBySettings } = require('../core/three-mf');
const { getDatabasePath } = require('../core/db-path');
const { directoryScanPrefixSqlParam, getModelsFilteredHandler, saveModel, updateModelsBatch } = require('./ipc/models');
const { buildLibraryExportData } = require('./ipc/backup');
const { scanDirectoryHandler } = require('./ipc/scan');
const { saveThumbnail, setDefaultThumbnailIndex } = require('../core/thumbnail-store');
const { networkPathContext } = require('./path-context');
const { checkLinks, importLink } = require('./link-import');
const { version } = require('../../package.json');

/** The model folder of an MCP call: `folder`, or the folder of the model given by id or filePath. */
function mediaFolderForMcp(args) {
  const dir = args && args.folder ? String(args.folder) : resolveModelForMcp(args).filePath;
  const folder = modelFolders.resolveFolder(dir);
  if (!folder) throw new Error('Not a model folder: media belongs to a model with a folder of its own (Keep Them in This Folder, or Tidy Into Model Folders)');
  return folder;
}

function resolveModelForMcp(args) {
  if (!args) throw new Error('Provide id or filePath');
  if (args.filePath) {
    const model = getModelByFilePath(args.filePath);
    if (!model) throw new Error(`Model not found for filePath: ${args.filePath}`);
    return model;
  }
  if (args.id != null && args.id !== '') {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid model id');
    const model = getModelById(id);
    if (!model) throw new Error(`Model not found for id: ${id}`);
    return model;
  }
  throw new Error('Provide id or filePath');
}

function normalizeMcpTagNames(raw) {
  const list = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const name = String(item && typeof item === 'object' && item.name != null ? item.name : item || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function getModelTagNamesForMcp(modelId) {
  return database.db
    .prepare(
      `
    SELECT t.name FROM tags t
    JOIN model_tags mt ON mt.tag_id = t.id
    WHERE mt.model_id = ?
    ORDER BY t.name COLLATE NOCASE
  `
    )
    .all(modelId)
    .map((row) => row.name);
}

const MCP_METADATA_TYPES = new Set(['designer', 'title', 'license']);
/** A metadata type of an MCP call; 'parentModel' (before 8.0) is the Title. */
const mcpMetadataType = (value) => {
  const type = String(value || '').trim();
  return type === 'parentModel' ? 'title' : type;
};
/** An MCP call's fields with 'parentModel' (before 8.0) taken as the Title. */
const withTitle = (item) => (item && item.title === undefined && item.parentModel !== undefined ? { ...item, title: item.parentModel } : item);

function renameMetadataForMcp(args) {
  const type = mcpMetadataType(args && args.type);
  const oldName = String((args && args.oldName) || '').trim();
  const newName = String((args && args.newName) || '').trim();
  if (!MCP_METADATA_TYPES.has(type)) throw new Error('type must be designer, title, or license');
  if (!oldName || !newName) throw new Error('oldName and newName are required');
  const existing = database.db
    .prepare(
      `
    SELECT COUNT(*) as count FROM models
    WHERE ${type} = ? AND ${type} IS NOT NULL AND ${type} != ''
  `
    )
    .get(newName);
  const existingCount = existing ? existing.count : 0;
  const result = database.db.prepare(`UPDATE models SET ${type} = ? WHERE ${type} = ?`).run(newName, oldName);
  return {
    success: true,
    updated: result.changes,
    merged: existingCount > 0,
    existingCount
  };
}

function deleteMetadataForMcp(args) {
  const type = mcpMetadataType(args && args.type);
  const name = String((args && args.name) || '').trim();
  if (!MCP_METADATA_TYPES.has(type)) throw new Error('type must be designer, title, or license');
  if (!name) throw new Error('name is required');
  const result = database.db.prepare(`UPDATE models SET ${type} = NULL WHERE ${type} = ?`).run(name);
  return { success: true, updated: result.changes };
}

function requireMcpConfirm(args, action) {
  if (!args || args.confirm !== true) {
    throw new Error(`Refusing ${action}. Pass confirm: true to proceed.`);
  }
}

/** The links an Add Links tool call names: `links` (a list) or `text` (pasted text). */
function linkTextFromMcpArgs(args) {
  const list = Array.isArray(args && args.links) ? args.links.filter((link) => typeof link === 'string') : [];
  const text = [args && typeof args.text === 'string' ? args.text : '', ...list].join('\n');
  if (!text.trim()) throw new Error('Provide links (a list of model links) or text that contains them');
  return text;
}

/** Most links one import_model_links call takes (each one fetches the site, and maybe downloads). */
const MCP_IMPORT_LINKS_MAX = 50;

function mcpIpcEvent() {
  return { sender: { send() {} } };
}

function filtersFromMcpArgs(args) {
  if (!args) return null;
  const filters = {};
  for (const key of ['search', 'designer', 'tags', 'directory', 'fileType', 'printed']) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== '') filters[key] = args[key];
  }
  return Object.keys(filters).length ? filters : null;
}

function resolveMcpFilePaths(args) {
  const paths = [];
  const seen = new Set();
  const addPath = (filePath) => {
    const p = String(filePath || '').trim();
    if (!p || seen.has(p)) return;
    seen.add(p);
    paths.push(p);
  };
  if (Array.isArray(args && args.filePaths)) args.filePaths.forEach(addPath);
  if (args && args.filePath) addPath(args.filePath);
  const ids = [];
  if (args && args.id != null) ids.push(args.id);
  if (Array.isArray(args && args.ids)) ids.push(...args.ids);
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) continue;
    const model = getModelById(id);
    if (model) addPath(model.filePath);
  }
  return paths;
}

function diskPathForExistCheck(filePath) {
  if (isUrlModel(filePath)) return { kind: 'url', path: filePath };
  const zip = parseZipPath(filePath);
  if (zip && zip.isZipEntry) return { kind: 'zip', path: zip.zipPath, filePath };
  return { kind: 'file', path: filePath };
}

function pathExistsOnDisk(filePath) {
  const info = diskPathForExistCheck(filePath);
  if (info.kind === 'url') return true;
  try {
    fs.accessSync(info.path, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function removeModelsFromLibraryByPaths(filePaths) {
  const { removed, missing } = deleteModelsByFilePaths(filePaths);
  if (removed.length) {
    events.broadcast('refresh-grid');
  }
  return { success: true, removedCount: removed.length, removed, missing };
}

function getMcpToolContext() {
  return {
    // MCP is always a network caller: same path rules as the browser.
    assertToolArgs: (name, args) => assertMcpToolArgs(name, args, networkPathContext()),
    getVersion: () => version,
    searchModels: async (filters) => {
      const models = await getModelsFilteredHandler(null, {
        search: filters.search,
        designer: filters.designer,
        tags: filters.tags,
        directory: filters.directory,
        fileType: filters.fileType,
        printed: filters.printed,
        limit: filters.limit,
        offset: filters.offset
      });
      return {
        count: Array.isArray(models) ? models.length : 0,
        models: models || []
      };
    },
    getModel: async (args) => {
      const includeThumbnails = !!args.includeThumbnails;
      let model;
      if (args.id != null && args.id !== '') {
        model = getModelById(Number(args.id), { includeThumbnail: includeThumbnails });
      } else if (args.filePath) {
        model = getModelByFilePath(args.filePath, { includeThumbnail: includeThumbnails });
      } else {
        throw new Error('Provide id or filePath');
      }
      if (!model) return null;
      const tags = database.db
        .prepare(
          `
        SELECT t.name FROM tags t
        JOIN model_tags mt ON mt.tag_id = t.id
        WHERE mt.model_id = ?
      `
        )
        .all(model.id)
        .map((t) => t.name);
      if (!includeThumbnails) {
        const stored = readThumbnailColumn(model.filePath);
        applyThumbnailFlags(Object.assign(model, { thumbnail: stored }));
        delete model.thumbnail;
      }
      return { ...model, tags };
    },
    updateModel: async (rawArgs) => {
      const args = withTitle(rawArgs);
      const existing = resolveModelForMcp(args);
      const payload = {
        id: existing.id,
        filePath: existing.filePath,
        fileName: existing.fileName,
        designer: existing.designer,
        source: existing.source,
        notes: existing.notes,
        printed: existing.printed,
        printStatus: existing.print_status,
        title: existing.title,
        license: existing.license,
        rating: existing.rating,
        favorite: existing.favorite
      };
      for (const key of ['designer', 'source', 'notes', 'description', 'license', 'title', 'printStatus', 'rating', 'favorite', 'tags']) {
        if (args[key] !== undefined) payload[key] = args[key];
      }
      await saveModel(payload);
      return { success: true, id: existing.id, filePath: existing.filePath };
    },
    getLibraryStats: async () => {
      const handler = ipcHandlerRegistry.get('get-stats');
      return handler({ sender: { send() {} } });
    },
    getFolderTree: async () => {
      const handler = ipcHandlerRegistry.get('get-folder-tree');
      return handler({ sender: { send() {} } });
    },
    listTags: async () => getAllTagsHandler(),
    addTag: async (name) => {
      const tagName = String(name || '').trim();
      if (!tagName) throw new Error('Tag name is required');
      return saveTagHandler(null, tagName);
    },
    renameTag: async (args) => renameTagForMcp(args),
    deleteTag: async (args) => {
      const tag = resolveTagForMcp(args);
      const modelCount = database.db.prepare('SELECT COUNT(*) as count FROM model_tags WHERE tag_id = ?').get(tag.id)?.count || 0;
      await deleteTagHandler(null, tag.id);
      return { success: true, id: tag.id, name: tag.name, unlinkedModels: modelCount };
    },
    addModelTags: async (args) => {
      const model = resolveModelForMcp(args);
      const toAdd = normalizeMcpTagNames(args.tags);
      if (!toAdd.length) throw new Error('tags is required');
      const current = getModelTagNamesForMcp(model.id);
      const have = new Set(current.map((name) => name.toLowerCase()));
      const next = current.slice();
      for (const name of toAdd) {
        if (have.has(name.toLowerCase())) continue;
        have.add(name.toLowerCase());
        next.push(name);
      }
      await saveModel({ id: model.id, filePath: model.filePath, fileName: model.fileName, tags: next });
      return { success: true, id: model.id, filePath: model.filePath, tags: getModelTagNamesForMcp(model.id) };
    },
    removeModelTags: async (args) => {
      const model = resolveModelForMcp(args);
      const toRemove = new Set(normalizeMcpTagNames(args.tags).map((name) => name.toLowerCase()));
      if (!toRemove.size) throw new Error('tags is required');
      const next = getModelTagNamesForMcp(model.id).filter((name) => !toRemove.has(name.toLowerCase()));
      await saveModel({ id: model.id, filePath: model.filePath, fileName: model.fileName, tags: next });
      return { success: true, id: model.id, filePath: model.filePath, tags: next };
    },
    getPrintEvents: async (args) => {
      const model = resolveModelForMcp(args);
      return { id: model.id, filePath: model.filePath, events: printEvents.getPrintEvents(database.db, model.id) };
    },
    logPrintEvent: async (args) => {
      const model = resolveModelForMcp(args);
      return printEvents.logPrintEvent(database.db, {
        modelId: model.id,
        filePath: model.filePath,
        outcome: args.outcome,
        quantity: args.quantity,
        printedAt: args.printedAt,
        notes: args.notes,
        parts: args.parts
      });
    },
    deletePrintEvent: async (eventId) => printEvents.deletePrintEvent(database.db, eventId),
    listTitles: async () => {
      const rows = database.db.prepare("SELECT DISTINCT title FROM models WHERE title IS NOT NULL AND title != ''").all();
      return rows.map((row) => row.title);
    },
    renameMetadata: async (args) => renameMetadataForMcp(args),
    deleteMetadata: async (args) => deleteMetadataForMcp(args),
    listDesigners: async () => {
      const handler = ipcHandlerRegistry.get('get-designers');
      return handler({ sender: { send() {} } });
    },
    listLicenses: async () => {
      const handler = ipcHandlerRegistry.get('get-licenses');
      return handler({ sender: { send() {} } });
    },
    getModelsMissingThumbnails: async (limit) => {
      const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
      return database.db
        .prepare(
          `
        SELECT id, filePath, fileName, size, designer
        FROM models
        WHERE thumbnail IS NULL OR thumbnail = '' OR thumbnail = '3d.png'
        ORDER BY fileName COLLATE NOCASE ASC
        LIMIT ?
      `
        )
        .all(cap);
    },
    getThumbnails: async (args) => {
      const model = resolveModelForMcp(args);
      const stored = loadThumbnailForModel(model.filePath) || '';
      const thumbnails = parseThumbnails(stored);
      return { id: model.id, filePath: model.filePath, count: thumbnails.length, thumbnails };
    },
    setThumbnail: async (args) => {
      const model = resolveModelForMcp(args);
      await saveThumbnail(model.filePath, args.image);
      const payload = { filePath: model.filePath, thumbnailCount: 1, hasMultiple: false, newImageIsDefault: true };
      events.broadcast('thumbnail-added', payload);
      return { success: true, id: model.id, filePath: model.filePath };
    },
    addThumbnail: async (args) => {
      const model = resolveModelForMcp(args);
      const handler = ipcHandlerRegistry.get('add-thumbnail');
      await handler({ sender: { send() {} } }, model.filePath, args.image);
      return { success: true, id: model.id, filePath: model.filePath };
    },
    setDefaultThumbnail: async (args) => {
      const model = resolveModelForMcp(args);
      const index = parseInt(args.index, 10);
      if (!Number.isInteger(index) || index < 0) throw new Error('index must be a non-negative integer');
      const stored = readThumbnailColumn(model.filePath);
      if (!stored) throw new Error('Model has no thumbnails');
      const updated = setDefaultThumbnailIndex(stored, index);
      await saveThumbnail(model.filePath, updated);
      const thumbs = parseThumbnails(updated);
      const payload = { filePath: model.filePath, thumbnailCount: thumbs.length, defaultChanged: true };
      events.broadcast('thumbnail-default-changed', payload);
      return { success: true, id: model.id, filePath: model.filePath, thumbnailCount: thumbs.length };
    },
    // A model folder's pictures, videos and documents (src/server/model-folders.js).
    getModelMedia: async (args) => modelFolders.getMedia(mediaFolderForMcp(args)),
    addModelMedia: async (args) => {
      const folder = mediaFolderForMcp(args);
      if (args.data) {
        if (!args.name) throw new Error('name (with an extension) is required with data');
        return modelFolders.saveMediaData(folder, args.name, args.data);
      }
      if (!args.url || !/^https:\/\//i.test(String(args.url))) throw new Error('Give an https url, or data with name');
      const saved = await modelFolders.saveFromSite(folder, String(args.url), args.name || null);
      if (saved && modelFolders.kindOf(saved) === 'image') await modelFolders.coverIfNone(folder).catch(() => {});
      events.broadcast('folder-changed', { path: folder });
      return { name: saved, kind: saved ? modelFolders.kindOf(saved) : null, skipped: !saved, media: modelFolders.getMedia(folder) };
    },
    setModelCover: async (args) => modelFolders.setCover(mediaFolderForMcp(args), args.name || null),
    removeModelMedia: async (args) => modelFolders.removeMedia(mediaFolderForMcp(args), args.kind, args.name),
    addModelYoutube: async (args) => modelFolders.addYoutube(mediaFolderForMcp(args), Array.isArray(args.links) ? args.links : [args.links]),
    deleteThumbnail: async (args) => {
      const model = resolveModelForMcp(args);
      const index = parseInt(args.index, 10);
      if (!Number.isInteger(index) || index < 0) throw new Error('index must be a non-negative integer');
      const stored = readThumbnailColumn(model.filePath);
      if (!stored) throw new Error('Model has no thumbnails');
      const thumbnails = parseThumbnails(stored).filter((t) => t && t !== '3d.png' && t.length > 0 && String(t).startsWith('data:image'));
      if (thumbnails.length <= 1) throw new Error('Cannot delete thumbnail: model must have at least one thumbnail');
      if (index >= thumbnails.length) throw new Error('Invalid thumbnail index');
      if (index === 0) throw new Error('Cannot delete the active thumbnail');
      thumbnails.splice(index, 1);
      await saveThumbnail(model.filePath, thumbnails.join('::'));
      const payload = { filePath: model.filePath, thumbnailCount: thumbnails.length };
      events.broadcast('thumbnail-deleted', payload);
      return { success: true, id: model.id, filePath: model.filePath, thumbnailCount: thumbnails.length };
    },
    findDuplicates: async (args) => {
      const filters = filtersFromMcpArgs(args);
      const groups = await getDuplicatesHandler(mcpIpcEvent(), { includeZip: !!args.includeZip, filters });
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 200);
      const list = Array.isArray(groups) ? groups : [];
      return {
        groupCount: list.length,
        returned: Math.min(list.length, limit),
        truncated: list.length > limit,
        groups: list.slice(0, limit)
      };
    },
    getHashStatus: async (args) => {
      const filters = filtersFromMcpArgs(args);
      return {
        generating: hashGenerationRunning(),
        missingHash: countModelsNeedingHash({ includeSha256: false, filters }),
        missingOrSha256: countModelsNeedingHash({ includeSha256: true, filters })
      };
    },
    calculateMissingHashes: async (args) => generateMissingHashesHandler(mcpIpcEvent(), filtersFromMcpArgs(args)),
    checkFilesExist: async (args) => {
      let paths = Array.isArray(args.filePaths) ? args.filePaths.map((p) => String(p || '').trim()).filter(Boolean) : [];
      const scanningLibrary = paths.length === 0;
      if (scanningLibrary) {
        const cap = Math.min(Math.max(parseInt(args.limit, 10) || 500, 1), 2000);
        paths = database.db
          .prepare('SELECT filePath FROM models ORDER BY fileName COLLATE NOCASE LIMIT ?')
          .all(cap)
          .map((r) => r.filePath);
      }
      const missingOnly = args.missingOnly !== undefined ? !!args.missingOnly : scanningLibrary;
      const results = [];
      let missingCount = 0;
      for (const filePath of paths) {
        const exists = pathExistsOnDisk(filePath);
        if (!exists) missingCount += 1;
        if (missingOnly && exists) continue;
        results.push({ filePath, exists });
      }
      return { checked: paths.length, missingCount, results };
    },
    getAllMetadata: async () =>
      database.db
        .prepare(
          `
      SELECT 'designer' as type, designer as name, COUNT(*) as model_count
      FROM models
      WHERE designer IS NOT NULL AND designer != ''
      GROUP BY designer
      UNION ALL
      SELECT 'title' as type, title as name, COUNT(*) as model_count
      FROM models
      WHERE title IS NOT NULL AND title != ''
      GROUP BY title
      UNION ALL
      SELECT 'license' as type, license as name, COUNT(*) as model_count
      FROM models
      WHERE license IS NOT NULL AND license != ''
      GROUP BY license
      ORDER BY type, name
    `
        )
        .all(),
    pull3mfMetadata: async (args) => {
      const filePaths = resolveMcpFilePaths(args);
      if (!filePaths.length) throw new Error('Provide filePaths, filePath, or id');
      const threeMFFiles = filePaths.filter((fp) => {
        const target = fp.includes('::') ? fp.split('::')[1] || '' : fp;
        return path.extname(target).toLowerCase() === '.3mf';
      });
      if (!threeMFFiles.length) throw new Error('No 3MF files provided');
      const modelsWithData = [];
      for (const filePath of threeMFFiles) {
        const model = getModelByFilePath(filePath, { includeThumbnail: false });
        if (!model) continue;
        const hasData =
          (model.designer && String(model.designer).trim()) ||
          (model.title && String(model.title).trim()) ||
          (model.description && String(model.description).trim()) ||
          (model.license && String(model.license).trim());
        if (hasData) {
          modelsWithData.push({ filePath, fileName: model.fileName, designer: model.designer, title: model.title, license: model.license });
        }
      }
      if (modelsWithData.length && !args.overwrite) {
        return {
          success: false,
          needsOverwrite: true,
          message: `${modelsWithData.length} model(s) already have metadata. Pass overwrite: true to replace it.`,
          modelsWithData
        };
      }
      const results = [];
      let successCount = 0;
      let errorCount = 0;
      let noMetadataCount = 0;
      for (const filePath of threeMFFiles) {
        try {
          const metadata = await extract3MFMetadata(filePath);
          const filteredMetadata = filter3MFMetadataBySettings(metadata);
          if (filteredMetadata && (filteredMetadata.designer || filteredMetadata.title || filteredMetadata.notes || filteredMetadata.license)) {
            const existingModel = getModelByFilePath(filePath, { includeThumbnail: false });
            if (!existingModel) {
              results.push({ filePath, success: false, error: 'Model not in library' });
              errorCount += 1;
              continue;
            }
            database.db
              .prepare(
                `
              UPDATE models SET designer = ?, title = ?, description = ?, license = ? WHERE filePath = ?
            `
              )
              .run(
                filteredMetadata.designer || null,
                filteredMetadata.title || null,
                filteredMetadata.notes || null,
                filteredMetadata.license || null,
                filePath
              );
            results.push({ filePath, success: true, action: 'updated' });
            successCount += 1;
          } else {
            results.push({ filePath, success: false, error: 'No metadata found in 3MF file' });
            noMetadataCount += 1;
          }
        } catch (error) {
          results.push({ filePath, success: false, error: error.message });
          errorCount += 1;
        }
      }
      return { success: true, processed: threeMFFiles.length, successCount, errorCount, noMetadataCount, results };
    },
    generateTags: async (args) => {
      const model = resolveModelForMcp(args);
      const tags = await generateTagsHandler(mcpIpcEvent(), model.filePath);
      const suggested = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [];
      if (!args.apply || !suggested.length) {
        return { id: model.id, filePath: model.filePath, tags: suggested, applied: false };
      }
      const current = getModelTagNamesForMcp(model.id);
      const have = new Set(current.map((name) => name.toLowerCase()));
      const next = current.slice();
      for (const name of suggested) {
        if (have.has(name.toLowerCase())) continue;
        have.add(name.toLowerCase());
        next.push(name);
      }
      if (!have.has('ai tagged')) next.push('AI Tagged');
      await saveModel({ id: model.id, filePath: model.filePath, fileName: model.fileName, tags: next });
      return { id: model.id, filePath: model.filePath, tags: getModelTagNamesForMcp(model.id), suggested, applied: true };
    },
    updateModelsBatch: async (models) => {
      if (!Array.isArray(models) || !models.length) throw new Error('models is required');
      const batch = models.map((raw) => {
        const item = withTitle(raw);
        const existing = resolveModelForMcp(item);
        const payload = { filePath: existing.filePath };
        for (const key of ['designer', 'source', 'notes', 'description', 'license', 'title', 'printStatus', 'rating', 'favorite', 'tags']) {
          if (item[key] !== undefined) payload[key] = item[key];
        }
        return payload;
      });
      await updateModelsBatch(batch);
      return { success: true, count: batch.length };
    },
    logPrintEventsBatch: async (args) => {
      const filePaths = resolveMcpFilePaths(args);
      if (!filePaths.length && !(Array.isArray(args.modelIds) && args.modelIds.length)) {
        throw new Error('Provide filePaths, filePath, id, ids, or modelIds');
      }
      return printEvents.logPrintEventsBatch(database.db, {
        filePaths,
        modelIds: args.modelIds,
        outcome: args.outcome,
        quantity: args.quantity,
        printedAt: args.printedAt,
        notes: args.notes,
        parts: args.parts
      });
    },
    getModelsByDirectory: async (args) => {
      const directory = String(args.directory || '').trim();
      if (!directory) throw new Error('directory is required');
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 100, 1), 500);
      const models = database.db
        .prepare(
          `
        SELECT ${MODEL_LIST_COLUMNS} FROM models
        WHERE REPLACE(LOWER(filePath), CHAR(92), '/') LIKE ?
        ORDER BY fileName COLLATE NOCASE
        LIMIT ?
      `
        )
        .all(directoryScanPrefixSqlParam(directory), limit);
      return { count: models.length, models };
    },
    checkModelLinks: async (args) => checkLinks(database.db, linkTextFromMcpArgs(args)),
    importModelLinks: async (args) => {
      const { links, unsupported } = checkLinks(database.db, linkTextFromMcpArgs(args));
      if (!links.length) throw new Error('No Printables, Thingiverse or MakerWorld model links found');
      if (links.length > MCP_IMPORT_LINKS_MAX) throw new Error(`At most ${MCP_IMPORT_LINKS_MAX} links per call (got ${links.length})`);
      // Downloads go to the Upload folder (upload-inbox.js), whatever folder is named.
      const wantsDownload = args.download === true || (typeof args.downloadFolder === 'string' && !!args.downloadFolder.trim());
      const downloadFolder = wantsDownload ? require('./upload-inbox').requireUploadFolder() : null;
      const { download } = require('./site-details');
      const { downloadFiles } = require('./site-files');
      const results = [];
      // One at a time, as the Add Links dialog does: the sites limit how fast they answer.
      for (const link of links) {
        try {
          const result = await importLink(
            link.url,
            { db: database.db, saveModel, saveThumbnail, download, downloadFiles },
            { downloadFolder, downloadOptions: { event: mcpIpcEvent(), onProgress() {} } }
          );
          results.push({ url: link.url, ...result });
        } catch (error) {
          results.push({ url: link.url, status: 'failed', error: error.message });
        }
      }
      if (results.some((result) => result.status === 'added' || result.status === 'downloaded')) events.broadcast('refresh-grid');
      const count = (status) => results.filter((result) => result.status === status).length;
      return {
        added: count('added'),
        downloaded: count('downloaded'),
        alreadyInLibrary: count('exists'),
        notFound: count('missing'),
        failed: count('failed'),
        unsupported,
        results
      };
    },
    scanDirectory: async (args) => {
      let directory = String(args.directory || '').trim();
      if (!directory) {
        directory = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('directoryPath')?.value || readStlHomeDirectories()[0] || '';
      }
      if (!directory) throw new Error('directory is required (no last-scanned folder is saved)');
      const result = await scanDirectoryHandler(mcpIpcEvent(), directory, {});
      return { success: true, directory, ...result };
    },
    removeModel: async (args) => {
      requireMcpConfirm(args, 'remove_model');
      const filePaths = resolveMcpFilePaths(args);
      if (!filePaths.length) throw new Error('Provide id, filePath, ids, or filePaths');
      return removeModelsFromLibraryByPaths(filePaths);
    },
    trashFile: async (args) => {
      requireMcpConfirm(args, 'trash_file');
      const filePaths = resolveMcpFilePaths(args);
      if (!filePaths.length) throw new Error('Provide id, filePath, ids, or filePaths');
      const trashed = [];
      const failed = [];
      for (const filePath of filePaths) {
        try {
          if (filePath.includes('::')) {
            failed.push({ filePath, error: 'Zip entries cannot be trashed; use remove_model to drop the library row.' });
            continue;
          }
          assertContainerPath(filePath, 'trash-file');
          if (!isUrlModel(filePath)) {
            await shell.trashItem(filePath.replace(/\\/g, '/'));
          }
          const result = removeModelsFromLibraryByPaths([filePath]);
          trashed.push(...result.removed);
          if (result.missing.length) failed.push({ filePath, error: 'Not in library' });
        } catch (error) {
          failed.push({ filePath, error: error.message });
        }
      }
      return { success: failed.length === 0, trashedCount: trashed.length, trashed, failed };
    },
    listSlicers: async () => {
      const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
      if (!tableExists) return [];
      return database.db.prepare('SELECT * FROM slicers').all();
    },
    openInSlicer: async (args) => {
      const filePaths = resolveMcpFilePaths(args);
      if (!filePaths.length) throw new Error('Provide id, filePath, or filePaths');
      return openFileInSlicerHandler(mcpIpcEvent(), {
        filePaths,
        slicerId: args.slicerId,
        slicerName: args.slicerName
      });
    },
    moveFiles: async (args) => {
      requireMcpConfirm(args, 'move_files');
      const destinationFolder = String(args.destinationFolder || '').trim();
      if (!destinationFolder) throw new Error('destinationFolder is required');
      const filePaths = Array.isArray(args.filePaths) ? args.filePaths.filter(Boolean) : [];
      if (!filePaths.length) throw new Error('filePaths is required');
      const moved = [];
      for (const filePath of filePaths) {
        if (String(filePath).includes('::')) throw new Error(`Cannot move zip entry: ${filePath}`);
        assertContainerPath(filePath, 'move-files');
        if (!fs.existsSync(filePath)) throw new Error(`File does not exist: ${filePath}`);
        const newDestination = path.join(destinationFolder, path.basename(filePath));
        await fs.promises.rename(filePath, newDestination);
        database.db.prepare('UPDATE models SET filePath = ? WHERE filePath = ?').run(newDestination, filePath);
        moved.push({ from: filePath, to: newDestination });
      }
      events.broadcast('refresh-grid');
      return { success: true, moved };
    },
    exportLibrary: async (args) => {
      const exportData = buildLibraryExportData();
      const destPath =
        String(args.destPath || '').trim() ||
        path.join(path.dirname(getDatabasePath()), `justtprint-library-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await fs.promises.writeFile(destPath, JSON.stringify(exportData, null, 2), 'utf8');
      return { success: true, filePath: destPath, modelCount: exportData.models.length };
    },
    backupDatabase: async (args) => {
      const dbPath = getDatabasePath();
      const destPath =
        String(args.destPath || '').trim() || path.join(path.dirname(dbPath), `justtprint-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      if (path.resolve(destPath) === path.resolve(dbPath)) {
        throw new Error('destPath cannot be the live database file');
      }
      if (database.db && database.db.open && typeof database.db.backup === 'function') {
        await database.db.backup(destPath);
      } else {
        await fs.promises.copyFile(dbPath, destPath);
      }
      return { success: true, filePath: destPath };
    },

    // Categories (src/core/categories.js) and Categorize Library (category-scan.js), as the
    // Categories page and the Edit dialog do; changes are written down for History, by "MCP".
    listCategories: async () => {
      const categories = require('../core/categories');
      return { categories: categories.categoryTree(), uncategorized: categories.uncategorizedCount() };
    },
    setModelCategory: async (args) => {
      const categories = require('../core/categories');
      const name = String(args.category || '').trim();
      if (name && !categories.findCategory(name)) throw new Error(`Not a category: ${name} (list_categories lists them)`);
      // One model (id or filePath) or several (ids, filePaths).
      const targets = resolveMcpFilePaths(args).map((filePath) => resolveModelForMcp({ filePath }));
      if (!targets.length) throw new Error('Provide id, filePath, ids or filePaths');
      const history = require('./model-versions');
      await history.tracking(
        targets.map((model) => model.id),
        'MCP',
        async () => {
          for (const model of targets) categories.setModelPlace(model.id, name || null, 'manual');
        }
      );
      events.broadcast('categories-changed');
      events.broadcast('refresh-grid');
      return {
        success: true,
        models: targets.map((model) => ({ id: model.id, filePath: model.filePath, ...categories.modelPlace(model.id) }))
      };
    },
    categorizeLibrary: async (args) => {
      const scan = require('./category-scan');
      const useAi = !!args.useAi;
      if (useAi) {
        if (!scan.aiReady()) throw new Error('Set up the AI service first (Settings → AI Tagging)');
        // Puter answers through a signed-in browser, which an MCP call does not have.
        if (require('./ipc/ai').getAISettings().aiService === 'puter') {
          throw new Error('The AI service is Puter.com, which runs in a browser: run Categorize Library with the AI from the Categories page, or useAi: false');
        }
      }
      const started = scan.start({ by: 'MCP', useAi, again: !!args.again });
      if (!started) return { busy: true, job: scan.summary() };
      if (args.wait) {
        await scan._job().promise;
        return { done: true, job: scan.summary() };
      }
      return { started: true, job: started };
    },
    getCategorizeStatus: async () => ({ job: require('./category-scan').summary() }),

    // The Edit dialog's other changes: the model's name (and file), and its site details.
    renameModel: async (args) => {
      const model = resolveModelForMcp(args);
      const name = String(args.name || '').trim();
      if (!name) throw new Error('name is required');
      const history = require('./model-versions');
      const result = await history.tracking([model.id], 'MCP', async () => require('./model-rename').renameModel(model.filePath, name));
      events.broadcast('refresh-grid');
      return { success: true, id: model.id, ...result };
    },
    getSiteDetails: async (args) => {
      const model = resolveModelForMcp(args);
      const url = siteLinkOf(model);
      const siteDetails = require('./site-details');
      return { id: model.id, url, details: await siteDetails.getDetails(url, { refresh: !!args.refresh }), editable: siteDetails.editableValues(url) };
    },
    updateSiteDetails: async (args) => {
      const model = resolveModelForMcp(args);
      const url = siteLinkOf(model);
      const siteDetails = require('./site-details');
      const before = siteDetails.editableValues(url);
      const changes = args.reset ? null : args.changes;
      if (!args.reset && (!changes || typeof changes !== 'object' || Array.isArray(changes))) {
        throw new Error('Provide changes (an object such as { "title": "…", "tags": ["…"] }) or reset: true');
      }
      const details = await siteDetails.saveSiteEdits(url, changes);
      const after = siteDetails.editableValues(url);
      require('./model-versions').recordDetailChanges('site', url, after.title || before.title || url, before, after, 'MCP');
      events.broadcast('model-history-changed', {});
      events.broadcast('site-details-changed', { url });
      return { success: true, id: model.id, url, details, editable: after };
    }
  };
}

/** A model's MakerWorld, Printables or Thingiverse link (its source, or a link-only model's address). */
function siteLinkOf(model) {
  const { parseModelLink } = require('../core/link-import');
  const candidates = [model.source, String(model.filePath || '').startsWith('url::') ? String(model.filePath).slice(5) : ''];
  const url = candidates.find((text) => text && parseModelLink(text));
  if (!url) throw new Error('This model has no MakerWorld, Printables or Thingiverse link (its Source)');
  return url;
}

module.exports = { getMcpToolContext };
