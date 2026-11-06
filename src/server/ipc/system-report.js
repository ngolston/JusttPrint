'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const fs = require('fs');
const path = require('path');
const { getDatabasePath } = require('../../core/db-path');

// Sidebar Library Storage: library size and the STL Home volume's usage (src/core/library-storage.js).
ipcMain.handle('get-library-storage', async () => {
  const { libraryStorage } = require('../../core/library-storage');
  const { readStlHomeDirectories } = require('../../core/library-paths');
  return libraryStorage({ db: database.db, roots: readStlHomeDirectories() });
});

// Home's Needs attention (src/core/library-attention.js); the backups only for admins.
ipcMain.handle('get-library-attention', async (event) => {
  const { libraryAttention, backupProblem } = require('../../core/library-attention');
  const found = libraryAttention(database.db, { coverSql: require('../model-folders').onlyCoverSql() });
  const uncategorized = require('../../core/categories').uncategorizedCount();
  const user = event && event.user;
  const admin = !user || user.role === 'admin';
  /** @type {ReturnType<typeof backupProblem>} */
  let backup = null;
  if (admin) {
    try {
      backup = backupProblem(require('../auto-backup').status());
    } catch (error) {
      console.warn('[Home] Could not read the backup status:', error.message);
    }
  }
  // Models waiting in the Upload folder for Organize Uploads (upload-inbox.js).
  const unorganized = require('../upload-inbox').waitingCount();
  return { ...found, uncategorized, unorganized, backup };
});

// Queue badge and dashboard figures (src/core/library-counts.js).
ipcMain.handle('get-library-counts', async () => require('../../core/library-counts').libraryCounts(database.db));
// Dashboard Recent Activity (src/core/recent-activity.js).
ipcMain.handle('get-recent-activity', async (event, limit) => require('../../core/recent-activity').recentActivity(database.db, limit));
// Print Queue's Completed list (src/core/recent-activity.js).
ipcMain.handle('get-recent-prints', async (event, limit, outcome, printerId) =>
  require('../../core/recent-activity').recentPrints(database.db, limit, outcome || null, printerId ?? null)
);
// The Statistics page (src/core/print-stats.js): { months } ending this month, 0 for all time.
ipcMain.handle('get-print-statistics', async (event, options) =>
  require('../../core/print-stats').printStatistics(database.db, { months: options && options.months != null ? Number(options.months) : 12 })
);

// Failure analysis on the Statistics page (src/core/failure-analysis.js): { months } as above.
ipcMain.handle('get-failure-analysis', async (event, options) => {
  const months = options && options.months != null ? Number(options.months) : 12;
  const since = months > 0 ? new Date(Date.now() - months * 30.44 * 86400000).toISOString() : null;
  return require('../../core/failure-analysis').failureAnalysis(database.db, { since });
});

// Export from Statistics (src/server/exports.js): history or models as CSV, everything as Excel.
ipcMain.handle('export-data', (event, options) => require('../exports').writeExport(database.db, options || {}));

ipcMain.handle('get-stats', async () => {
  try {
    // Total model count
    const totalModels = database.db.prepare('SELECT COUNT(*) as count FROM models').get();
    const totalCount = totalModels ? totalModels.count : 0;

    // File type breakdown (count + disk usage)
    const stlStats = database.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM models WHERE LOWER(fileName) LIKE '%.stl'").get();
    const threeMfStats = database.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM models WHERE LOWER(fileName) LIKE '%.3mf'").get();
    const otherStats = database.db
      .prepare(
        "SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM models WHERE LOWER(fileName) NOT LIKE '%.stl' AND LOWER(fileName) NOT LIKE '%.3mf'"
      )
      .get();
    const totalBytesRow = database.db.prepare('SELECT COALESCE(SUM(size), 0) as bytes FROM models').get();

    // Archived models (models inside ZIP files)
    const archivedCount = database.db.prepare("SELECT COUNT(*) as count FROM models WHERE filePath LIKE '%::%'").get();

    // Models with metadata
    const withDesigner = database.db.prepare("SELECT COUNT(*) as count FROM models WHERE designer IS NOT NULL AND designer != ''").get();
    const withTitle = database.db.prepare("SELECT COUNT(*) as count FROM models WHERE title IS NOT NULL AND title != ''").get();
    const withLicense = database.db.prepare("SELECT COUNT(*) as count FROM models WHERE license IS NOT NULL AND license != ''").get();
    const withTags = database.db.prepare('SELECT COUNT(DISTINCT model_id) as count FROM model_tags').get();

    // Tag statistics
    const totalTags = database.db.prepare('SELECT COUNT(*) as count FROM tags').get();
    const mostUsedTag = database.db
      .prepare(
        `
      SELECT t.name, COUNT(mt.model_id) as count 
      FROM tags t 
      JOIN model_tags mt ON t.id = mt.tag_id 
      GROUP BY t.id, t.name 
      ORDER BY count DESC 
      LIMIT 1
    `
      )
      .get();

    // Calculate percentages
    const calculatePercentage = (count) => {
      if (totalCount === 0) return 0;
      return ((count / totalCount) * 100).toFixed(1);
    };

    const stlBytes = stlStats ? stlStats.bytes : 0;
    const threeMfBytes = threeMfStats ? threeMfStats.bytes : 0;
    const otherBytes = otherStats ? otherStats.bytes : 0;
    const totalBytes = totalBytesRow ? totalBytesRow.bytes : 0;

    return {
      totalModels: totalCount,
      totalBytes,
      fileTypes: {
        stl: stlStats ? stlStats.count : 0,
        threeMf: threeMfStats ? threeMfStats.count : 0,
        other: otherStats ? otherStats.count : 0,
        stlBytes,
        threeMfBytes,
        otherBytes
      },
      archivedModels: archivedCount ? archivedCount.count : 0,
      percentages: {
        withDesigner: calculatePercentage(withDesigner ? withDesigner.count : 0),
        withTitle: calculatePercentage(withTitle ? withTitle.count : 0),
        withLicense: calculatePercentage(withLicense ? withLicense.count : 0),
        withTags: calculatePercentage(withTags ? withTags.count : 0)
      },
      tags: {
        total: totalTags ? totalTags.count : 0,
        mostUsed: mostUsedTag
          ? {
              name: mostUsedTag.name,
              count: mostUsedTag.count
            }
          : null
      }
    };
  } catch (error) {
    console.error('Error getting stats:', error);
    throw error;
  }
});

// System Report: the server's GPU (nvidia-smi) and the WebGL of its thumbnail renderer (this browser's WebGL is detected in the browser)
async function collectServerGpuInfo() {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  const glBackend =
    process.env.JUSTTPRINT_GL_BACKEND ||
    (process.argv.includes('--use-angle=swiftshader')
      ? 'swiftshader'
      : process.argv.some((a) => a.includes('vulkan') || a === '--use-gl=egl')
        ? 'nvidia'
        : 'unknown');

  const result = {
    available: false,
    serverMode: true,
    glBackend,
    nvidiaVisibleDevices: process.env.NVIDIA_VISIBLE_DEVICES || null,
    nvidiaDriverCapabilities: process.env.NVIDIA_DRIVER_CAPABILITIES || null,
    /** @type {{ available: boolean, gpus?: object[], message?: string } | null} */
    nvidia: null,
    /** @type {any} */
    workerWebgl: null,
    /** @type {string | null} */
    activeRenderer: null,
    usingSwiftShader: glBackend === 'swiftshader',
    /** @type {string[]} */
    warnings: [],
    /** @type {string | null} */
    error: null
  };

  // nvidia-smi (host GPU via nvidia-container-toolkit) — independent of WebGL backend
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=index,name,driver_version,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true }
    );
    const gpus = String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(',').map((p) => p.trim());
        return {
          index: parts[0] || '',
          name: parts[1] || '',
          driverVersion: parts[2] || '',
          memoryTotalMiB: parts[3] || '',
          memoryUsedMiB: parts[4] || '',
          utilizationPercent: parts[5] || ''
        };
      });
    if (gpus.length) {
      result.nvidia = { available: true, gpus };
      result.available = true;
    } else {
      result.nvidia = { available: false, message: 'nvidia-smi returned no GPUs' };
    }
  } catch (nvidiaErr) {
    result.nvidia = {
      available: false,
      message: nvidiaErr && nvidiaErr.code === 'ENOENT' ? 'nvidia-smi not found (no NVIDIA toolkit device mount)' : nvidiaErr.message || String(nvidiaErr)
    };
  }

  if (result.nvidia?.available && result.nvidiaDriverCapabilities) {
    const caps = `,${result.nvidiaDriverCapabilities},`;
    if (!caps.includes(',graphics,') && !caps.includes(',all,')) {
      result.warnings.push("NVIDIA_DRIVER_CAPABILITIES is missing 'graphics' — WebGL cannot use the GPU (need e.g. graphics,compute,utility).");
    }
  }

  // The Chromium that renders the server's thumbnails: the GPU it actually uses for WebGL.
  try {
    const webgl = await require('../thumbnail-worker').webglInfo();
    result.workerWebgl = webgl;
    if (!webgl) {
      result.warnings.push('The thumbnail renderer (headless Chromium) is not running, so its WebGL could not be checked.');
    } else if (!webgl.renderer) {
      result.warnings.push('The thumbnail renderer has no WebGL: server thumbnails cannot be rendered.');
    } else {
      result.activeRenderer = webgl.renderer;
      result.available = true;
      const rendererLower = webgl.renderer.toLowerCase();
      if (rendererLower.includes('swiftshader') || rendererLower.includes('llvmpipe')) {
        result.usingSwiftShader = true;
        if (result.nvidia?.available) {
          result.warnings.push(
            'Host NVIDIA GPU is visible, but the thumbnail renderer is still on software rendering (SwiftShader/llvmpipe). Check JUSTTPRINT_GL_BACKEND and NVIDIA_DRIVER_CAPABILITIES=graphics.'
          );
        }
      } else {
        result.usingSwiftShader = false;
      }
    }
  } catch (webglError) {
    result.warnings.push(`The thumbnail renderer's WebGL could not be read: ${webglError.message || webglError}`);
  }

  if (glBackend === 'swiftshader') {
    result.warnings.push(
      'Container is using SwiftShader (CPU WebGL). Set JUSTTPRINT_GPU=nvidia (or auto with a working NVIDIA device) to attempt hardware WebGL.'
    );
  }

  return result;
}

ipcMain.handle('get-gpu-info', async () => {
  try {
    return await collectServerGpuInfo();
  } catch (error) {
    console.error('Error getting GPU info:', error);
    return { available: false, serverMode: true, error: error.message };
  }
});

ipcMain.handle('benchmark-filesystem', async () => {
  try {
    const dbPath = getDatabasePath();
    const dbDir = path.dirname(dbPath);
    const testFilePath = path.join(dbDir, 'benchmark-test.tmp');

    const iterations = 10;
    const fileSize = 1024 * 1024; // 1MB test file
    const testData = Buffer.alloc(fileSize, 'A');

    // Write benchmark
    const writeStart = Date.now();
    for (let i = 0; i < iterations; i++) {
      await fs.promises.writeFile(testFilePath, testData);
    }
    const writeTime = Date.now() - writeStart;
    const writeSpeed = (iterations * fileSize) / (writeTime / 1000); // bytes per second

    // Read benchmark
    const readStart = Date.now();
    for (let i = 0; i < iterations; i++) {
      await fs.promises.readFile(testFilePath);
    }
    const readTime = Date.now() - readStart;
    const readSpeed = (iterations * fileSize) / (readTime / 1000); // bytes per second

    // Cleanup
    try {
      await fs.promises.unlink(testFilePath);
    } catch (cleanupError) {
      console.warn('Failed to cleanup benchmark test file:', cleanupError);
    }

    return {
      success: true,
      write: {
        time: writeTime,
        speed: writeSpeed,
        speedMBps: (writeSpeed / (1024 * 1024)).toFixed(2)
      },
      read: {
        time: readTime,
        speed: readSpeed,
        speedMBps: (readSpeed / (1024 * 1024)).toFixed(2)
      },
      iterations: iterations,
      fileSize: fileSize
    };
  } catch (error) {
    console.error('Error benchmarking filesystem:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('benchmark-database', async () => {
  try {
    if (!database.db) {
      return { success: false, error: 'Database not initialized' };
    }

    const iterations = 100;

    // Write benchmark - insert test records
    const insertStmt = database.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    const writeStart = Date.now();
    const transaction = database.db.transaction(() => {
      for (let i = 0; i < iterations; i++) {
        insertStmt.run(`benchmark_test_${i}`, `test_value_${i}`);
      }
    });
    transaction();
    const writeTime = Date.now() - writeStart;
    const writeOpsPerSec = (iterations / (writeTime / 1000)).toFixed(2);

    // Read benchmark - select test records
    const selectStmt = database.db.prepare('SELECT value FROM settings WHERE key = ?');
    const readStart = Date.now();
    for (let i = 0; i < iterations; i++) {
      selectStmt.get(`benchmark_test_${i}`);
    }
    const readTime = Date.now() - readStart;
    const readOpsPerSec = (iterations / (readTime / 1000)).toFixed(2);

    // Cleanup - delete test records
    const deleteStmt = database.db.prepare('DELETE FROM settings WHERE key LIKE ?');
    deleteStmt.run('benchmark_test_%');

    return {
      success: true,
      write: {
        time: writeTime,
        operations: iterations,
        opsPerSec: writeOpsPerSec
      },
      read: {
        time: readTime,
        operations: iterations,
        opsPerSec: readOpsPerSec
      }
    };
  } catch (error) {
    console.error('Error benchmarking database:', error);
    return { success: false, error: error.message };
  }
});
