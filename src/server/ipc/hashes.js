'use strict';

const events = require('../events');
const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const fs = require('fs');
const crypto = require('crypto');
const { getLibraryRootPaths, isUrlModel, parseZipPath } = require('../../core/library-paths');
const { buildModelFilterConditions, sqlAndFilterConditions } = require('../../core/model-filters');
const { extractZipEntryBuffer, isFragileZipError } = require('../../core/zip-extract');

let isGeneratingHashes = false; // Track hash generation state

let isHashGenerationScheduled = false;

/** Whether hashes are being generated right now. */
function hashGenerationRunning() {
  return isGeneratingHashes;
}

function scheduleBackgroundHashGeneration(reason) {
  if (isGeneratingHashes || isHashGenerationScheduled) return;
  isHashGenerationScheduled = true;
  // Defer well past first paint / initial thumb wave so UNC I/O is not contended at cold start.
  const delayMs = reason === 'startup' ? 45000 : 500;
  setTimeout(async () => {
    if (isGeneratingHashes) {
      isHashGenerationScheduled = false;
      return;
    }
    try {
      await calculateMissingHashesInternal(null);
      console.log(`Background hash generation completed (${reason || 'auto'})`);
    } catch (error) {
      console.error('Background hash generation failed:', error);
    } finally {
      isHashGenerationScheduled = false;
    }
  }, delayMs);
}

// Update the calculateFileHash function to be more robust and handle zip entries
async function calculateFileHash(filePath) {
  // Check if this is a zip entry
  const pathInfo = parseZipPath(filePath);

  if (pathInfo.isZipEntry) {
    // Hash zip entries from the extracted buffer — avoids temp files and extra I/O.
    try {
      const zipPath = resolveReadableDiskPath(pathInfo.zipPath) || pathInfo.zipPath;
      const entryData = await extractZipEntryBuffer(zipPath, pathInfo.entryPath);
      const fileHash = crypto.createHash('md5').update(entryData).digest('hex');
      return fileHash;
    } catch (error) {
      console.error(`Error extracting zip entry for hashing: ${filePath}`, error);
      throw new Error(`Failed to extract zip entry for hashing: ${error.message}`);
    }
  }

  const actualFilePath = resolveReadableDiskPath(filePath) || filePath;

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(actualFilePath);

    stream.on('error', err => {
      console.error(`Error reading file for hashing: ${actualFilePath}`, err);
      reject(err);
    });

    stream.on('data', chunk => {
      try {
        hash.update(chunk);
      } catch (err) {
        console.error(`Error updating hash for file: ${actualFilePath}`, err);
        reject(err);
      }
    });

    stream.on('end', () => {
      try {
        const fileHash = hash.digest('hex');
        resolve(fileHash);
      } catch (err) {
        console.error(`Error generating final hash for file: ${filePath}`, err);
        reject(err);
      }
    });
  });
}

// Windows-scanned libraries reused in Docker still store C:\... paths. Try the
// stored path plus Linux mount equivalents derived from STL_HOME / directoryPath.
function collectReadablePathCandidates(filePath) {
  if (!filePath || typeof filePath !== 'string') return [];
  const normalized = filePath.replace(/\\/g, '/');
  const candidates = [];
  const add = (p) => {
    if (p && typeof p === 'string' && !candidates.includes(p)) candidates.push(p);
  };
  add(filePath);
  add(normalized);

  const win = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (win) {
    const drive = win[1].toLowerCase();
    const rest = win[2];
    add('/' + rest);
    add('/mnt/' + rest);
    add('/mnt/' + drive + '/' + rest);
    for (const root of getLibraryRootPaths()) {
      const rootNorm = String(root).replace(/\\/g, '/').replace(/\/$/, '');
      if (!rootNorm) continue;
      const rootBase = rootNorm.split('/').filter(Boolean).pop() || '';
      const restParts = rest.split('/').filter(Boolean);
      const idx = restParts.findIndex((p) => p.toLowerCase() === rootBase.toLowerCase());
      if (idx >= 0) {
        const relative = restParts.slice(idx + 1).join('/');
        add(relative ? `${rootNorm}/${relative}` : rootNorm);
      }
    }
  }
  return candidates;
}

function resolveReadableDiskPath(diskPath) {
  if (!diskPath || isUrlModel(diskPath)) return null;
  for (const candidate of collectReadablePathCandidates(diskPath)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { /* ignore invalid paths */ }
  }
  return null;
}

function resolveReadableModelPath(filePath) {
  if (!filePath || isUrlModel(filePath)) return null;
  const pathInfo = parseZipPath(filePath);
  const diskPath = pathInfo.isZipEntry ? pathInfo.zipPath : filePath;
  const resolved = resolveReadableDiskPath(diskPath);
  if (!resolved) return null;
  return pathInfo.isZipEntry ? `${resolved}::${pathInfo.entryPath}` : resolved;
}

function parseDuplicatesRequest(includeZipOrOptions) {
  if (includeZipOrOptions && typeof includeZipOrOptions === 'object' && !Array.isArray(includeZipOrOptions)) {
    const filters = includeZipOrOptions.filters && typeof includeZipOrOptions.filters === 'object'
      ? includeZipOrOptions.filters
      : null;
    return { includeZip: !!includeZipOrOptions.includeZip, filters };
  }
  return { includeZip: !!includeZipOrOptions, filters: null };
}

// Add a new IPC handler for getting duplicates
const getDuplicatesHandler = async (event, includeZipOrOptions = false) => {
  const { includeZip, filters } = parseDuplicatesRequest(includeZipOrOptions);
  const maxRetries = isGeneratingHashes ? 5 : 1;
  const retryDelayMs = 150;
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Only fetch rows whose hash has 2+ distinct paths (avoids loading every unique model into memory).
      // Zip entries use "archive::entry" paths — exclude them unless includeZip is true.
      // Optional filters (current library view) apply to both the hash-count subquery
      // and the file list so De-Dup can run on a designer/tag/query subset.
      const zipClause = includeZip ? '' : " AND instr(filePath, '::') = 0";
      const outerFilter = buildModelFilterConditions(filters);
      const innerFilter = buildModelFilterConditions(filters);
      const rows = database.db.prepare(`
        SELECT filePath, fileName, hash, size
        FROM models
        WHERE hash IS NOT NULL
          AND hash != ''
          AND LENGTH(TRIM(hash)) > 0
          ${zipClause}
          ${sqlAndFilterConditions(outerFilter.conditions)}
          AND hash IN (
            SELECT hash
            FROM models
            WHERE hash IS NOT NULL
              AND hash != ''
              AND LENGTH(TRIM(hash)) > 0
              ${zipClause}
              ${sqlAndFilterConditions(innerFilter.conditions)}
            GROUP BY hash
            HAVING COUNT(DISTINCT filePath) > 1
          )
        ORDER BY hash, filePath
      `).all(...outerFilter.params, ...innerFilter.params);

      // Group by hash; dedupe by filePath (DB can have duplicate rows for the same path)
      const groupsByHash = new Map();
      for (const row of rows) {
        if (!row.hash || row.hash.trim() === '') continue;
        let group = groupsByHash.get(row.hash);
        if (!group) {
          group = { hash: row.hash, files: [], seen: new Set() };
          groupsByHash.set(row.hash, group);
        }
        if (group.seen.has(row.filePath)) continue;
        group.seen.add(row.filePath);
        // Omit redundant per-file hash to keep IPC payload lean for large libraries
        group.files.push({
          filePath: row.filePath,
          fileName: row.fileName,
          size: row.size
        });
      }

      const duplicateGroups = [];
      for (const group of groupsByHash.values()) {
        if (group.files.length > 1) {
          duplicateGroups.push({ hash: group.hash, files: group.files });
        }
      }

      console.debug('Found duplicate groups:', duplicateGroups.length);
      // Array of { hash, files } — leaner than a hash-keyed object for large result sets
      return duplicateGroups;
    } catch (error) {
      lastError = error;
      console.error('Error getting duplicates (attempt ' + (attempt + 1) + '/' + maxRetries + '):', error);
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
  }
  throw lastError;
};

ipcMain.handle('get-duplicates', getDuplicatesHandler);

function countModelsNeedingHash({ includeSha256 = false, filters = null } = {}) {
  const hashClause = includeSha256
    ? `(hash IS NULL OR hash = '' OR LENGTH(hash) = 64)`
    : `(hash IS NULL OR hash = '')`;
  const { conditions, params } = buildModelFilterConditions(filters);
  const row = database.db.prepare(`
    SELECT COUNT(*) as count FROM models
    WHERE ${hashClause}
      AND filePath NOT LIKE 'url::%'
      ${sqlAndFilterConditions(conditions)}
  `).get(...params);
  return row ? row.count : 0;
}

function emitHashGenerationProgress(event, payload) {
  events.broadcast('hash-generation-progress', payload);
}

function emitHashGenerationComplete(event, payload) {
  events.broadcast('hash-generation-complete', payload);
}

// Internal function to calculate missing hashes
async function calculateMissingHashesInternal(event, filters = null) {
  if (isGeneratingHashes) {
    return { alreadyRunning: true, calculated: 0, failed: 0, total: 0 };
  }
  try {
    // Set hash generation state
    isGeneratingHashes = true;

    // Missing hashes, plus SHA256 (64 hex chars) that can be regenerated as MD5.
    // SHA256 still groups duplicates correctly — conversion is best-effort.
    const filterSql = buildModelFilterConditions(filters);
    const modelsWithMissingHashes = database.db.prepare(`
      SELECT filePath, fileName, size, hash
      FROM models
      WHERE (hash IS NULL OR hash = '' OR LENGTH(hash) = 64)
        AND filePath NOT LIKE 'url::%'
        ${sqlAndFilterConditions(filterSql.conditions)}
    `).all(...filterSql.params);

    console.log(`Found ${modelsWithMissingHashes.length} models with missing or SHA256 hashes (need MD5)`);

    if (modelsWithMissingHashes.length === 0) {
      isGeneratingHashes = false;
      return { calculated: 0, failed: 0, total: 0 };
    }

    console.log('Starting parallel hash calculation for', modelsWithMissingHashes.length, 'files');

    let processedCount = 0;
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let firstError = '';
    const updateHash = database.db.prepare('UPDATE models SET hash = ? WHERE filePath = ?');
    const progressPayload = () => ({
      processed: processedCount,
      total: modelsWithMissingHashes.length,
      success: successCount,
      failed: failedCount,
      skipped: skippedCount
    });

    emitHashGenerationProgress(event, progressPayload());

    // Process files in parallel with concurrency limit
    // Keep Docker/server concurrency low — high parallelism + thumb renders saturates UNC/CIFS.
    const concurrencyLimit = 4;
    
    // Helper function to calculate hash with retry and timeout
    const calculateFileHashWithRetry = async (filePath, maxRetries = 2) => {
      let lastError;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          // Add timeout for file operations (especially important for network files in Docker)
          const timeoutMs = 300000; // 5 min for server mode, 1 min for normal
          const hashPromise = calculateFileHash(filePath);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Hash calculation timeout after ${timeoutMs}ms`)), timeoutMs)
          );
          
          return await Promise.race([hashPromise, timeoutPromise]);
        } catch (error) {
          lastError = error;
          // Only retry on certain errors (network issues, timeouts, temporary file system errors)
          const isRetryableError = error.code === 'ETIMEDOUT' || 
                                   error.code === 'ENOENT' || 
                                   error.code === 'EACCES' ||
                                   error.code === 'Z_BUF_ERROR' ||
                                   error.message.includes('timeout') ||
                                   error.message.includes('ENOTFOUND') ||
                                   isFragileZipError(error);
          
          if (attempt < maxRetries && isRetryableError) {
            console.warn(`Retry ${attempt + 1}/${maxRetries} for ${filePath}: ${error.message}`);
            // Exponential backoff: 1s, 2s, 4s
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            continue;
          }
          throw error;
        }
      }
      throw lastError;
    };

    const processFile = async (model) => {
      try {
        const readablePath = resolveReadableModelPath(model.filePath);
        const existingHash = model.hash && String(model.hash).trim();
        const hasSha256 = existingHash && existingHash.length === 64;

        if (readablePath) {
          try {
            const hash = await calculateFileHashWithRetry(readablePath);
            updateHash.run(hash, model.filePath);
            successCount++;
            console.debug(`Hash calculated for: ${model.filePath} (${successCount} succeeded, ${failedCount} failed, ${processedCount + 1}/${modelsWithMissingHashes.length} total)`);
          } catch (hashError) {
            if (hasSha256) {
              skippedCount++;
              console.warn(`Keeping existing SHA256 hash; MD5 regeneration failed for ${model.filePath}: ${hashError.message}`);
            } else {
              failedCount++;
              if (!firstError) firstError = hashError.message || String(hashError);
              console.error(`Failed to calculate hash for ${model.filePath} after retries:`, hashError.message);
            }
          }
        } else if (hasSha256) {
          skippedCount++;
          console.warn(`Keeping existing SHA256 hash; file not readable: ${model.filePath}`);
        } else {
          console.warn(`File no longer exists: ${model.filePath}`);
          failedCount++;
          if (!firstError) firstError = `File not found: ${model.filePath}`;
        }
        
        processedCount++;
        emitHashGenerationProgress(event, progressPayload());
      } catch (error) {
        console.error(`Unexpected error processing ${model.filePath}:`, error);
        failedCount++;
        if (!firstError) firstError = error.message || String(error);
        processedCount++;
        emitHashGenerationProgress(event, progressPayload());
      }
    };

    // Process files in parallel batches
    for (let i = 0; i < modelsWithMissingHashes.length; i += concurrencyLimit) {
      const batch = modelsWithMissingHashes.slice(i, i + concurrencyLimit);
      await Promise.all(batch.map(processFile));
    }

    isGeneratingHashes = false;

    console.log(`Hash generation complete: ${successCount} succeeded, ${failedCount} failed, ${skippedCount} skipped out of ${modelsWithMissingHashes.length} total`);

    const completePayload = {
      success: successCount,
      failed: failedCount,
      skipped: skippedCount,
      total: modelsWithMissingHashes.length,
      firstError: firstError || undefined
    };
    emitHashGenerationComplete(event, completePayload);

    return { 
      calculated: successCount, 
      failed: failedCount,
      skipped: skippedCount,
      total: modelsWithMissingHashes.length,
      firstError: firstError || undefined
    };
  } catch (error) {
    isGeneratingHashes = false;
    console.error('Error calculating missing hashes:', error);
    throw error;
  }
}

// Add IPC handler for generateMissingHashes (calls the same internal function)
const generateMissingHashesHandler = async (event, filters = null) => {
  // Check if hash generation is already in progress
  if (isGeneratingHashes) {
    console.debug('Hash generation already in progress, returning current status');
    return {
      alreadyRunning: true,
      total: countModelsNeedingHash({ includeSha256: true, filters })
    };
  }
  const total = countModelsNeedingHash({ includeSha256: true, filters });
  if (total === 0) {
    return { calculated: 0, failed: 0, total: 0 };
  }
  // Don't hold the WebSocket IPC slot for the entire hash run (default 30s timeout
  // made Docker/server Dedup report that every hash failed).
  calculateMissingHashesInternal(event, filters).catch((error) => {
    isGeneratingHashes = false;
    console.error('Error calculating missing hashes:', error);
    emitHashGenerationComplete(event, {
      success: 0,
      failed: total,
      total,
      firstError: error.message || String(error)
    });
  });
  return { started: true, total };
};

ipcMain.handle('generateMissingHashes', generateMissingHashesHandler);

const getModelsWithoutHashHandler = async (event, filters = null) => {
  try {
    // SHA256 hashes already work for Dedup grouping — only prompt when hash is empty.
    return countModelsNeedingHash({ includeSha256: false, filters });
  } catch (error) {
    console.error('Error getting models without hash:', error);
    return 0;
  }
};

ipcMain.handle('getModelsWithoutHash', getModelsWithoutHashHandler);

// Add IPC handler to check if hash generation is in progress
ipcMain.handle('is-generating-hashes', async () => {
  return isGeneratingHashes;
});

// Add IPC handler to calculate and save hash for a single file
ipcMain.handle('calculate-file-hash', async (event, filePath) => {
  if (isUrlModel(filePath)) return '';
  try {
    const hash = await calculateFileHash(filePath);
    // Update the database with the calculated hash
    database.db.prepare('UPDATE models SET hash = ? WHERE filePath = ?').run(hash, filePath);
    return hash;
  } catch (error) {
    console.error(`Error calculating hash for ${filePath}:`, error);
    throw error;
  }
});

module.exports = { countModelsNeedingHash, generateMissingHashesHandler, getDuplicatesHandler, hashGenerationRunning, scheduleBackgroundHashGeneration };

// Same geometry (src/server/geometry-job.js): the Duplicates page's second list.
const geometryJob = require('../geometry-job');
ipcMain.handle('get-geometry-duplicates', async (event, options) => geometryJob.duplicates(options && options.filters ? options.filters : null,
  { includeZip: !!(options && options.includeZip) }));
ipcMain.handle('start-geometry-scan', async (event, options) => geometryJob.start(options && options.filters ? options.filters : null));
ipcMain.handle('get-geometry-scan', async () => geometryJob.status());
ipcMain.handle('stop-geometry-scan', async () => geometryJob.stop());
