'use strict';

const events = require('../events');
const database = require('../../core/database');
const { app, ipcMain } = require('../runtime');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { isUrlModel, parseZipPath } = require('../../core/library-paths');
const { EXTRACT_TEMP_FILE_PREFIX, cleanupExtractTempFile, ensureExtractTempDir } = require('../../core/extract-temp');
const { getModelByFilePath } = require('../../core/models');
const { extractModelFromZip, find3dModelZipEntry, isLikelyValidZipBuffer, isMacOsResourceForkEntry, openZip } = require('../../core/zip-entries');
const { filter3MFMetadataBySettings, parse3MFModelXML } = require('../../core/three-mf');
const { compressDataUrl } = require('../../core/thumbnail-compress');

// 3MF preview worker/caching
const preview3mfWorkers = new Map();

const preview3mfCache = new Map();

const PREVIEW_3MF_CACHE_LIMIT = 1;

const PREVIEW_3MF_MAX_FILE_SIZE_MB = Math.max(10, Number.parseInt(process.env.JUSTTPRINT_PREVIEW_3MF_MAX_FILE_SIZE_MB || '200', 10) || 200);

const PREVIEW_3MF_WORKER_MEMORY_MB = Math.max(512, Number.parseInt(process.env.JUSTTPRINT_PREVIEW_3MF_WORKER_MEMORY_MB || '2048', 10) || 2048);

const PREVIEW_3MF_MAX_DISK_CACHE_MB = Math.max(50, Number.parseInt(process.env.JUSTTPRINT_PREVIEW_3MF_MAX_DISK_CACHE_MB || '150', 10) || 150);

function getPreview3mfCacheDir() {
  return path.join(app.getPath('userData'), '3mf-preview-cache');
}

function createPreview3mfWorker(workerPath) {
  return new Worker(workerPath, {
    resourceLimits: {
      maxOldGenerationSizeMb: PREVIEW_3MF_WORKER_MEMORY_MB,
      maxYoungGenerationSizeMb: Math.min(256, Math.floor(PREVIEW_3MF_WORKER_MEMORY_MB / 4))
    }
  });
}

function terminatePreview3mfWorker(entry) {
  if (!entry?.worker) return;
  try {
    entry.worker.terminate();
  } catch (error) {
    console.error('Error terminating 3MF preview worker:', error);
  }
}

function formatPreview3mfError(error) {
  const msg = error?.message || String(error || 'Failed to parse 3MF');
  if (msg.includes('ERR_WORKER_OUT_OF_MEMORY') || msg.includes('heap out of memory')) {
    return 'Preview ran out of memory while processing this model. Try closing other previews first, or restart the app.';
  }
  return msg;
}

function cancelAllPreview3mfWorkers(exceptRequestId = null) {
  for (const [id, entry] of preview3mfWorkers.entries()) {
    if (exceptRequestId && id === exceptRequestId) continue;
    terminatePreview3mfWorker(entry.entry);
    entry.reject?.(new Error('Preview cancelled'));
    if (entry.cleanup) {
      Promise.resolve(entry.cleanup()).catch(() => {});
    }
    preview3mfWorkers.delete(id);
  }
}

function trimPreview3mfMemoryCache() {
  while (preview3mfCache.size > PREVIEW_3MF_CACHE_LIMIT) {
    const oldestKey = preview3mfCache.keys().next().value;
    preview3mfCache.delete(oldestKey);
  }
}

function serializePreview3mfForDisk(json) {
  return JSON.stringify(json, (_key, value) => {
    if (ArrayBuffer.isView(value)) {
      return Array.from(value);
    }
    return value;
  });
}

// Typed arrays become { "0": n, "1": n, ... } under JSON.stringify, which
// THREE.ObjectLoader treats as empty buffers. Convert to plain arrays so
// server-mode WebSocket transport and disk/memory caches stay consistent.
function normalizePreview3mfTypedArrays(json) {
  if (!json || !Array.isArray(json.geometries)) return json;
  for (const geometry of json.geometries) {
    const data = geometry && geometry.data;
    if (!data) continue;
    if (data.attributes) {
      for (const key of Object.keys(data.attributes)) {
        const attr = data.attributes[key];
        if (attr && attr.array != null && !Array.isArray(attr.array)) {
          attr.array = ArrayBuffer.isView(attr.array) ? Array.from(attr.array) : Object.values(attr.array);
        }
      }
    }
    if (data.index && data.index.array != null && !Array.isArray(data.index.array)) {
      data.index.array = ArrayBuffer.isView(data.index.array) ? Array.from(data.index.array) : Object.values(data.index.array);
    }
  }
  return json;
}

ipcMain.handle('get3MFImages', async (event, filePath, options = {}) => {
  if (isUrlModel(filePath)) return [];
  // Skip files located in __MACOSX directories
  if (/[\\\/]__macosx[\\\/]/i.test(filePath)) {
    return [];
  }

  const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const verbose = opts.verbose === true || process.env.JUSTTPRINT_DEBUG_3MF === '1';
  const maxImagesRaw = Number(opts.maxImages);
  const maxImages = Number.isFinite(maxImagesRaw) && maxImagesRaw > 0 ? Math.min(Math.floor(maxImagesRaw), 250) : 250;
  const compress = opts.compress !== false;
  const log = (...args) => {
    if (verbose) console.log(...args);
  };

  // Check if this is a zip entry
  const pathInfo = parseZipPath(filePath);
  let actualFilePath = filePath;

  // Skip macOS resource-fork entries (._*) - not valid 3MF
  if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
    return [];
  }

  if (pathInfo.isZipEntry) {
    // Extract to temp file first
    try {
      actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
    } catch (error) {
      console.error('Error extracting zip entry for 3MF images:', error);
      return [];
    }
  }

  try {
    log('Starting to process 3MF file:', actualFilePath);

    // Check if file exists
    if (!fs.existsSync(actualFilePath)) {
      console.error('File does not exist:', actualFilePath);
      return [];
    }

    const data = await fs.promises.readFile(actualFilePath);
    if (!isLikelyValidZipBuffer(data)) {
      log('Skipping non-ZIP or too-small file (e.g. macOS ._ file):', actualFilePath, 'size:', data.length);
      return [];
    }

    // A 3MF file is a zip
    let contents;
    try {
      contents = openZip(data);
    } catch (zipError) {
      const msg = zipError && zipError.message ? zipError.message : String(zipError);
      if (/end of central directory|not a zip/i.test(msg)) {
        log('Invalid or truncated ZIP/3MF, skipping:', actualFilePath);
      } else {
        console.error('Error loading 3MF as ZIP:', zipError);
      }
      return [];
    }
    log('Zip contents loaded successfully');

    // Log all files in the 3MF
    log('\nContents of 3MF file:', actualFilePath);
    log('Number of files in archive:', Object.keys(contents.files).length);
    if (verbose) {
      log('All files in archive:');
      Object.keys(contents.files).forEach((filename) => {
        const file = contents.files[filename];
        log(' -', filename, file.dir ? '(directory)' : `(${file.size} bytes)`);
      });
    }

    // Parse 3dmodel.model XML file to extract metadata
    try {
      const modelXmlFile = find3dModelZipEntry(contents);

      if (modelXmlFile && !modelXmlFile.dir) {
        log('Found 3dmodel.model file, parsing metadata...');
        const xmlContent = modelXmlFile.read('string');
        const parsedMetadata = parse3MFModelXML(xmlContent);

        // Filter metadata based on user settings
        const filteredMetadata = filter3MFMetadataBySettings(parsedMetadata);

        // Update database if we found any metadata
        if (filteredMetadata.designer || filteredMetadata.parentModel || filteredMetadata.notes || filteredMetadata.license) {
          log('Parsed metadata from 3dmodel.model:', filteredMetadata);

          // Use original filePath for database lookup (not actualFilePath which might be a temp file)
          const dbFilePath = filePath;

          // Get the model from database to check existing values
          let existingModel = getModelByFilePath(dbFilePath);

          // If model doesn't exist, create it (similar to add-multiple-thumbnails handler)
          if (!existingModel) {
            log('Model not found in database, creating entry with metadata...');
            const fileName = path.basename(dbFilePath);
            // Handle zip entry paths - extract just the entry name
            const finalFileName = dbFilePath.includes('::') ? dbFilePath.split('::').pop() : fileName;
            const dateAdded = new Date().toISOString();

            database.db
              .prepare(
                `
              INSERT INTO models (filePath, fileName, designer, parentModel, notes, license, dateAdded, isNew)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            `
              )
              .run(
                dbFilePath,
                finalFileName,
                filteredMetadata.designer || null,
                filteredMetadata.parentModel || null,
                filteredMetadata.notes || null,
                filteredMetadata.license || null,
                dateAdded
              );

            log(`Created model entry for ${dbFilePath} with metadata`);
          } else {
            // Model exists - only update fields that are empty/null in the database
            const updates = {};
            const conditions = [];
            const values = [];

            if (filteredMetadata.designer && (!existingModel.designer || existingModel.designer.trim() === '')) {
              updates.designer = filteredMetadata.designer;
              values.push(filteredMetadata.designer);
              conditions.push('designer = ?');
            }

            if (filteredMetadata.parentModel && (!existingModel.parentModel || existingModel.parentModel.trim() === '')) {
              updates.parentModel = filteredMetadata.parentModel;
              values.push(filteredMetadata.parentModel);
              conditions.push('parentModel = ?');
            }

            if (filteredMetadata.notes && (!existingModel.notes || existingModel.notes.trim() === '')) {
              updates.notes = filteredMetadata.notes;
              values.push(filteredMetadata.notes);
              conditions.push('notes = ?');
            }

            if (filteredMetadata.license && (!existingModel.license || existingModel.license.trim() === '')) {
              updates.license = filteredMetadata.license;
              values.push(filteredMetadata.license);
              conditions.push('license = ?');
            }

            // Update database if we have any fields to update
            if (Object.keys(updates).length > 0) {
              values.push(dbFilePath);
              const updateStmt = database.db.prepare(`
                UPDATE models 
                SET ${conditions.join(', ')} 
                WHERE filePath = ?
              `);
              updateStmt.run(...values);
              log(`Updated model metadata for ${dbFilePath}:`, updates);
            } else {
              log('Model already has values for all metadata fields, skipping update');
            }
          }
        } else {
          log('No metadata found in 3dmodel.model file');
        }
      } else {
        log('3dmodel.model file not found in 3MF archive');
      }
    } catch (metadataError) {
      console.warn('Error parsing 3MF metadata (continuing with thumbnail extraction):', metadataError);
    }

    // Helper to check if file is an image and not a system file
    const isImage = (path) => {
      const normalized = path.replace(/\\/g, '/');
      // Skip Mac/System files
      if (normalized.includes('__MACOSX/') || normalized.split('/').pop().startsWith('._')) return false;
      return normalized.match(/\.(png|jpe?g|gif|webp)$/i);
    };

    // Helper to get proper MIME type from file extension
    const getMimeType = (path) => {
      const ext = path.split('.').pop().toLowerCase();
      const mimeMap = {
        jpg: 'jpeg',
        jpeg: 'jpeg',
        png: 'png',
        gif: 'gif',
        webp: 'webp'
      };
      return mimeMap[ext] || 'png';
    };

    // Normalized archive path (zip may use \ or /; match Auxiliaries at any depth)
    const isInAuxiliariesPath = (normLower) =>
      normLower.startsWith('auxiliaries/') || normLower.includes('/auxiliaries/') || normLower.startsWith('auxiliary/') || normLower.includes('/auxiliary/');

    // Helper to calculate score for an image to determine priority
    const calculateScore = (path, size) => {
      let score = 0;
      const norm = path.replace(/\\/g, '/').toLowerCase();
      const fileName = norm.split('/').pop().toLowerCase();
      const inAuxiliaries = isInAuxiliariesPath(norm);

      // Bambu Studio / Orca / PrusaSlicer: project cover is often Metadata/thumbnail.png
      if (/(^|\/)metadata\/thumbnail\.(png|jpe?g|webp|gif)$/.test(norm)) {
        score += 280;
      }

      // 0. HIGHEST: Auxiliaries/ (any subfolder) — slicer/preview thumbnails per 3MF auxiliary content
      if (inAuxiliaries) {
        score += 220;
      }

      // 1. Very high: Images in 3D/Textures/ or 3D/Texture/ (3MF standard texture location)
      if (norm.includes('3d/textures/') || norm.includes('3d/texture/')) {
        score += 200;
      }

      // 2. Plate images (high priority) - prefer images with "plate" in name
      if (fileName.includes('plate')) score += 150; // Prefer plate images like plate_1.jpg

      // 3. Camera photos (high priority) - specific patterns
      if (fileName.match(/^dsc/)) score += 100; // Nikon/Sony
      if (fileName.match(/^img/)) score += 100; // Canon/generic
      if (fileName.match(/^pxl/)) score += 100; // Pixel
      if (fileName.match(/^\d{8}_\d{6}/)) score += 100; // Android date format

      // 4. Paths containing "metadata" (lower priority) unless it is the slicer project thumbnail above
      const isSlicerThumbnailPath = /(^|\/)metadata\/thumbnail\.(png|jpe?g|webp|gif)$/.test(norm);
      if (!inAuxiliaries && norm.includes('metadata') && !isSlicerThumbnailPath) score -= 50;
      if (!inAuxiliaries && fileName.includes('thumbnail')) score -= 20;
      if (!inAuxiliaries && fileName.includes('preview')) score -= 10;

      // 5. File size (preference for larger, likely higher res images)
      // Cap size bonus at 50 points (assuming size is in bytes)
      // Use 0 if size is undefined
      const safeSize = size || 0;
      score += Math.min(safeSize / 1024, 50);

      // 6. Prefer webp/jpg over png (often photos vs generated)
      if (fileName.endsWith('.webp') || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
        score += 10;
      }

      return score;
    };

    // Scan all images in the archive
    log('\nScanning all images in 3MF archive...');
    const allImages = [];

    for (const [path, file] of Object.entries(contents.files)) {
      if (isImage(path) && !file.dir) {
        const size = file.size || 0;
        const score = calculateScore(path, size);
        log(`Found image: ${path} (Score: ${score})`);

        allImages.push({
          path,
          file,
          score
        });
      }
    }

    // Sort images by score descending (default thumbnail order: highest score first)
    allImages.sort((a, b) => b.score - a.score);

    // Extract images in priority order. Cap avoids huge photo dumps blowing IPC + DB row size.
    const MAX_3MF_IMAGES_TO_EXTRACT = maxImages;
    const imageFiles = [];
    const toExtract = allImages.slice(0, MAX_3MF_IMAGES_TO_EXTRACT);
    if (allImages.length > MAX_3MF_IMAGES_TO_EXTRACT) {
      log(`3MF has ${allImages.length} image entries; extracting ${MAX_3MF_IMAGES_TO_EXTRACT} highest-priority (memory / DB safety cap).`);
    }

    for (const imgObj of toExtract) {
      log(`Extracting: ${imgObj.path} (Score: ${imgObj.score})`);
      const imageData = imgObj.file.read('base64');
      const mimeType = getMimeType(imgObj.path);
      let dataUrl = `data:image/${mimeType};base64,${imageData}`;
      if (compress) {
        try {
          dataUrl = compressDataUrl(dataUrl) || dataUrl;
        } catch (_) {
          /* keep original */
        }
      }
      imageFiles.push(dataUrl);
    }

    log('\nExtracted total images:', imageFiles.length);
    if (imageFiles.length === 0) {
      log('No images found in 3MF file. Expected under Auxiliaries/ (any subfolder), 3D/Textures/, or 3D/Texture/.');
    }
    return imageFiles.length > 0 ? imageFiles : [];
  } catch (error) {
    console.error('Error reading 3MF images:', error);
    console.error('Error details:', error.message);
    console.error('Error stack:', error.stack);
    return [];
  }
});

ipcMain.handle('get3MFSTL', async (event, filePath) => {
  if (isUrlModel(filePath)) return null;
  try {
    // Check if this is a zip entry
    const pathInfo = parseZipPath(filePath);
    let actualFilePath = filePath;
    let shouldCleanup = false;

    if (pathInfo.isZipEntry && isMacOsResourceForkEntry(pathInfo.entryPath)) {
      return null;
    }

    if (pathInfo.isZipEntry) {
      // Extract to temp file first
      try {
        actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
        shouldCleanup = true;
      } catch (error) {
        console.error('Error extracting zip entry for 3MF STL:', error);
        return null;
      }
    }

    const data = await fs.promises.readFile(actualFilePath);
    if (!isLikelyValidZipBuffer(data)) {
      return null;
    }

    let contents;
    try {
      contents = openZip(data);
    } catch (zipError) {
      return null;
    }

    // Look for STL files in the 3MF
    for (const [entryPath, file] of Object.entries(contents.files)) {
      if (entryPath.endsWith('.stl')) {
        // Extract STL payload into dedicated OS temp dir
        const tempPath = path.join(ensureExtractTempDir(), `${EXTRACT_TEMP_FILE_PREFIX}${Date.now()}.stl`);
        await fs.promises.writeFile(tempPath, file.read());

        // Clean up intermediate zip-entry extract if needed
        if (shouldCleanup && actualFilePath !== filePath) {
          await cleanupExtractTempFile(actualFilePath);
        }

        return tempPath;
      }
    }

    // Clean up intermediate temp file if needed
    if (shouldCleanup && actualFilePath !== filePath) {
      try {
        await fs.promises.unlink(actualFilePath);
      } catch (cleanupError) {
        console.error('Error cleaning up temp file:', cleanupError);
      }
    }

    return null;
  } catch (error) {
    console.error('Error extracting STL from 3MF:', error);
    return null;
  }
});

// Read model file for preview (STL parsing in renderer)
const readModelFileHandler = async (event, filePath) => {
  if (isUrlModel(filePath)) throw new Error('URL-only model has no file to read');
  let tempPath = null;
  try {
    // Handle zip entries — extract to OS temp, read, then delete
    if (filePath.includes('::')) {
      const pathInfo = parseZipPath(filePath);
      tempPath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
      const data = await fs.promises.readFile(tempPath);
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }

    const data = await fs.promises.readFile(filePath);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } catch (error) {
    console.error(`Error reading model file ${filePath}:`, error);
    throw error;
  } finally {
    if (tempPath) {
      await cleanupExtractTempFile(tempPath);
    }
  }
};

ipcMain.handle('read-model-file', readModelFileHandler);

// Parse 3MF preview handler
const parse3mfPreviewHandler = async (event, filePath, requestId) => {
  // Validate arguments - ensure filePath is a string, not an array
  if (Array.isArray(filePath)) {
    console.error('parse-3mf-preview: filePath is an array, extracting first element');
    filePath = filePath[0];
  }
  if (typeof filePath !== 'string') {
    throw new Error(`parse-3mf-preview: filePath must be a string, received ${typeof filePath}`);
  }
  if (isUrlModel(filePath)) throw new Error('URL-only model has no file to preview');

  const pathInfo = parseZipPath(filePath);
  let actualFilePath = filePath;
  let shouldCleanup = false;
  let fileStat = null;

  if (pathInfo.isZipEntry) {
    if (isMacOsResourceForkEntry(pathInfo.entryPath)) {
      throw new Error('macOS resource-fork entry is not a valid 3MF');
    }
    actualFilePath = await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath);
    shouldCleanup = true;
  }

  try {
    fileStat = await fs.promises.stat(actualFilePath);
  } catch (error) {
    console.error('Error statting 3MF preview file:', error);
  }

  if (fileStat && fileStat.size > PREVIEW_3MF_MAX_FILE_SIZE_MB * 1024 * 1024) {
    if (shouldCleanup && actualFilePath !== filePath) {
      try {
        await fs.promises.unlink(actualFilePath);
      } catch {}
    }
    throw new Error(`3MF preview skipped: file is too large (${Math.round(fileStat.size / 1024 / 1024)}MB > ${PREVIEW_3MF_MAX_FILE_SIZE_MB}MB)`);
  }

  cancelAllPreview3mfWorkers();

  // Bump preview cache version when simplification/placement logic changes
  const cacheKey = fileStat ? `v8|${filePath}|${fileStat.size}|${fileStat.mtimeMs}` : null;
  const cacheDir = getPreview3mfCacheDir();
  const cacheHash = cacheKey ? crypto.createHash('sha256').update(cacheKey).digest('hex') : null;
  const cachePath = cacheHash ? path.join(cacheDir, `${cacheHash}.json`) : null;

  // In-memory cache
  if (cacheKey && preview3mfCache.has(cacheKey)) {
    const cached = preview3mfCache.get(cacheKey);
    preview3mfCache.delete(cacheKey);
    preview3mfCache.set(cacheKey, cached);
    if (shouldCleanup && actualFilePath !== filePath) {
      try {
        await fs.promises.unlink(actualFilePath);
      } catch {}
    }
    return normalizePreview3mfTypedArrays(cached);
  }

  // Disk cache
  if (cachePath) {
    try {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      const cacheStat = await fs.promises.stat(cachePath);
      if (cacheStat.size <= PREVIEW_3MF_MAX_DISK_CACHE_MB * 1024 * 1024) {
        const cachedJson = await fs.promises.readFile(cachePath, 'utf8');
        const parsed = normalizePreview3mfTypedArrays(JSON.parse(cachedJson));
        preview3mfCache.set(cacheKey, parsed);
        trimPreview3mfMemoryCache();
        if (shouldCleanup && actualFilePath !== filePath) {
          try {
            await fs.promises.unlink(actualFilePath);
          } catch {}
        }
        return parsed;
      }
      try {
        await fs.promises.unlink(cachePath);
      } catch {}
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        console.error('Error reading 3MF preview cache:', error);
      }
    }
  }

  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, '..', 'preview-3mf-worker-node.js');
    const entry = { worker: createPreview3mfWorker(workerPath) };
    const worker = entry.worker;
    let settled = false;

    const finish = (handler) => {
      if (settled) return;
      settled = true;
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      handler();
    };

    const cleanup = async () => {
      preview3mfWorkers.delete(requestId);
      terminatePreview3mfWorker(entry);
      if (shouldCleanup && actualFilePath !== filePath) {
        try {
          await fs.promises.unlink(actualFilePath);
        } catch {}
      }
    };

    preview3mfWorkers.set(requestId, { worker, entry, reject, cleanup });

    const onMessage = async (message) => {
      const { ok, json, error, type, message: statusMessage } = message || {};
      if (type === 'status') {
        events.toCaller(event, '3mf-preview-status', requestId, statusMessage);
        return;
      }

      finish(async () => {
        await cleanup();
        if (!ok) {
          reject(new Error(formatPreview3mfError(new Error(error || 'Failed to parse 3MF'))));
          return;
        }

        if (cacheKey) {
          preview3mfCache.set(cacheKey, normalizePreview3mfTypedArrays(json));
          trimPreview3mfMemoryCache();
          if (cachePath) {
            try {
              const serialized = serializePreview3mfForDisk(json);
              if (serialized.length <= PREVIEW_3MF_MAX_DISK_CACHE_MB * 1024 * 1024) {
                await fs.promises.mkdir(cacheDir, { recursive: true });
                await fs.promises.writeFile(cachePath, serialized);
              }
            } catch (cacheError) {
              console.error('Error writing 3MF preview cache:', cacheError);
            }
          }
        }

        resolve(normalizePreview3mfTypedArrays(json));
      });
    };

    const onError = async (error) => {
      finish(async () => {
        await cleanup();
        reject(new Error(formatPreview3mfError(error)));
      });
    };

    const onExit = async (code) => {
      if (code === 0) return;
      finish(async () => {
        await cleanup();
        reject(new Error(`3MF preview worker exited unexpectedly (code ${code})`));
      });
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);

    worker.postMessage({ filePath: actualFilePath });
  });
};

ipcMain.handle('parse-3mf-preview', parse3mfPreviewHandler);

ipcMain.handle('cancel-3mf-preview', async (event, requestId) => {
  const entry = preview3mfWorkers.get(requestId);
  if (!entry) return;

  terminatePreview3mfWorker(entry.entry);
  await entry.cleanup?.();
  entry.reject?.(new Error('Preview cancelled'));
});
