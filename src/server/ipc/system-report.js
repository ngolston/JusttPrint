'use strict';

const database = require('../../core/database');
const { app, ipcMain } = require('../runtime');
const fs = require('fs');
const path = require('path');
const { getDatabasePath } = require('../../core/db-path');

// Sidebar Library Storage: library size and the STL Home volume's usage (src/core/library-storage.js).
ipcMain.handle('get-library-storage', async () => {
  const { libraryStorage } = require('../../core/library-storage');
  const { readStlHomeDirectories } = require('../../core/library-paths');
  return libraryStorage({ db: database.db, roots: readStlHomeDirectories() });
});

// Queue badge and dashboard figures (src/core/library-counts.js).
ipcMain.handle('get-library-counts', async () => require('../../core/library-counts').libraryCounts(database.db));
// Dashboard Recent Activity (src/core/recent-activity.js).
ipcMain.handle('get-recent-activity', async (event, limit) => require('../../core/recent-activity').recentActivity(database.db, limit));
// Print Queue's Completed list (src/core/recent-activity.js).
ipcMain.handle('get-recent-prints', async (event, limit, outcome, printerId) =>
  require('../../core/recent-activity').recentPrints(database.db, limit, outcome || null, printerId ?? null));
// The Statistics page (src/core/print-stats.js): { months } ending this month, 0 for all time.
ipcMain.handle('get-print-statistics', async (event, options) =>
  require('../../core/print-stats').printStatistics(database.db, { months: options && options.months != null ? Number(options.months) : 12 }));

ipcMain.handle('get-stats', async () => {
  try {
    // Total model count
    const totalModels = database.db.prepare('SELECT COUNT(*) as count FROM models').get();
    const totalCount = totalModels ? totalModels.count : 0;

    // File type breakdown (count + disk usage)
    const stlStats = database.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM models WHERE LOWER(fileName) LIKE '%.stl'").get();
    const threeMfStats = database.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM models WHERE LOWER(fileName) LIKE '%.3mf'").get();
    const otherStats = database.db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM models WHERE LOWER(fileName) NOT LIKE '%.stl' AND LOWER(fileName) NOT LIKE '%.3mf'").get();
    const totalBytesRow = database.db.prepare('SELECT COALESCE(SUM(size), 0) as bytes FROM models').get();
    
    // Archived models (models inside ZIP files)
    const archivedCount = database.db.prepare("SELECT COUNT(*) as count FROM models WHERE filePath LIKE '%::%'").get();
    
    // Models with metadata
    const withDesigner = database.db.prepare("SELECT COUNT(*) as count FROM models WHERE designer IS NOT NULL AND designer != ''").get();
    const withParentModel = database.db.prepare("SELECT COUNT(*) as count FROM models WHERE parentModel IS NOT NULL AND parentModel != ''").get();
    const withLicense = database.db.prepare("SELECT COUNT(*) as count FROM models WHERE license IS NOT NULL AND license != ''").get();
    const withTags = database.db.prepare("SELECT COUNT(DISTINCT model_id) as count FROM model_tags").get();
    
    // Tag statistics
    const totalTags = database.db.prepare('SELECT COUNT(*) as count FROM tags').get();
    const mostUsedTag = database.db.prepare(`
      SELECT t.name, COUNT(mt.model_id) as count 
      FROM tags t 
      JOIN model_tags mt ON t.id = mt.tag_id 
      GROUP BY t.id, t.name 
      ORDER BY count DESC 
      LIMIT 1
    `).get();
    
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
        withParentModel: calculatePercentage(withParentModel ? withParentModel.count : 0),
        withLicense: calculatePercentage(withLicense ? withLicense.count : 0),
        withTags: calculatePercentage(withTags ? withTags.count : 0)
      },
      tags: {
        total: totalTags ? totalTags.count : 0,
        mostUsed: mostUsedTag ? {
          name: mostUsedTag.name,
          count: mostUsedTag.count
        } : null
      }
    };
  } catch (error) {
    console.error('Error getting stats:', error);
    throw error;
  }
});

// System Report: server / Electron-process GPU (client WebGL is detected in the browser)
async function collectServerGpuInfo() {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileAsync = promisify(execFile);

  const glBackend = process.env.JUSTTPRINT_GL_BACKEND
    || (process.argv.includes('--use-angle=swiftshader') ? 'swiftshader'
      : (process.argv.some((a) => a.includes('vulkan') || a === '--use-gl=egl') ? 'nvidia' : 'unknown'));

  const result = {
    available: false,
    serverMode: true,
    glBackend,
    nvidiaVisibleDevices: process.env.NVIDIA_VISIBLE_DEVICES || null,
    nvidiaDriverCapabilities: process.env.NVIDIA_DRIVER_CAPABILITIES || null,
    nvidia: null,
    electronGpuInfo: null,
    featureStatus: null,
    activeRenderer: null,
    usingSwiftShader: glBackend === 'swiftshader',
    warnings: [],
    error: null
  };

  // nvidia-smi (host GPU via nvidia-container-toolkit) — independent of WebGL backend
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=index,name,driver_version,memory.total,memory.used,utilization.gpu',
        '--format=csv,noheader,nounits'
      ],
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
      message: nvidiaErr && nvidiaErr.code === 'ENOENT'
        ? 'nvidia-smi not found (no NVIDIA toolkit device mount)'
        : (nvidiaErr.message || String(nvidiaErr))
    };
  }

  if (result.nvidia?.available && result.nvidiaDriverCapabilities) {
    const caps = `,${result.nvidiaDriverCapabilities},`;
    if (!caps.includes(',graphics,') && !caps.includes(',all,')) {
      result.warnings.push(
        "NVIDIA_DRIVER_CAPABILITIES is missing 'graphics' — WebGL cannot use the GPU (need e.g. graphics,compute,utility)."
      );
    }
  }

  // Chromium/Electron GPU process view (what thumbnail WebGL actually sees)
  try {
    if (app.isReady()) {
      const [gpuInfo, featureStatus] = await Promise.all([
        app.getGPUInfo('complete').catch(() => app.getGPUInfo('basic')),
        Promise.resolve().then(() => app.getGPUFeatureStatus())
      ]);
      result.electronGpuInfo = gpuInfo || null;
      result.featureStatus = featureStatus || null;

      const aux = gpuInfo && gpuInfo.auxAttributes ? gpuInfo.auxAttributes : null;
      const glRenderer = (aux && (aux.glRenderer || aux.gl_renderer)) || null;
      const gpuDevice = Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice[0] : null;
      const deviceString = gpuDevice
        ? [gpuDevice.vendorString, gpuDevice.deviceString].filter(Boolean).join(' ')
        : null;

      result.activeRenderer = glRenderer || deviceString || null;
      if (result.activeRenderer) result.available = true;

      const rendererLower = String(result.activeRenderer || '').toLowerCase();
      if (rendererLower.includes('swiftshader') || rendererLower.includes('llvmpipe')) {
        result.usingSwiftShader = true;
        if (result.nvidia?.available) {
          result.warnings.push(
            'Host NVIDIA GPU is visible, but Electron WebGL is still on software rendering (SwiftShader/llvmpipe). Check JUSTTPRINT_GL_BACKEND and NVIDIA_DRIVER_CAPABILITIES=graphics.'
          );
        }
      } else if (result.activeRenderer && glBackend === 'nvidia') {
        result.usingSwiftShader = false;
      }
    }
  } catch (electronGpuErr) {
    result.warnings.push(`Electron GPU info unavailable: ${electronGpuErr.message || electronGpuErr}`);
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
