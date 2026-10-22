const workerThreads = require('worker_threads');

// This file only runs as a worker thread (ipc/scan.js), so it always has a parent.
const parentPort = /** @type {import('worker_threads').MessagePort} */ (workerThreads.parentPort);
// Worker threads have their own console: same levels and timestamps as the server.
require('../core/log').install();
const fs = require('fs');
const path = require('path');
const { normalizeExcludeNames, shouldSkipDirectoryName, shouldSkipFileName, compileExcludeDirs, isExcludedDir } = require('../core/scan-skip');

// Concurrency limit for file processing
// Higher concurrency in Docker/Server mode to compensate for slower file system operations
// Docker file system operations (especially on network shares) can be 10-100ms per operation
// vs <1ms for local file systems, so we need more parallel operations to maintain throughput
function isDockerContainer() {
  return (
    require('fs').existsSync('/.dockerenv') ||
    (require('fs').existsSync('/proc/self/cgroup') && require('fs').readFileSync('/proc/self/cgroup', 'utf8').includes('docker'))
  );
}

const MAX_CONCURRENT_OPS = isDockerContainer() ? 100 : 50; // Higher concurrency in Docker

/** Always scanned; main's getScanExtensions() merges these with settings-driven additional types. */
const BASE_SCAN_EXTENSIONS = ['.stl', '.3mf'];
/** Archives are always scanned, each as one model: never opened, and not held to the Max File Size. */
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.7z']);

/**
 * Normalize extension list from main (includes ADDITIONAL_FILE_TYPES_CATALOG selections: .obj, .step, .stp, …).
 * Used for both directory-queue filtering and processFile so behavior stays consistent.
 */
let scanExcludeNames = new Set();

function buildScanExtensionSet(scanExtensions) {
  const set = new Set();
  const add = (raw) => {
    if (raw == null || raw === '') return;
    const s = String(raw).trim().toLowerCase();
    if (!s) return;
    set.add(s.startsWith('.') ? s : `.${s}`);
  };
  BASE_SCAN_EXTENSIONS.forEach(add);
  ARCHIVE_EXTENSIONS.forEach(add);
  if (Array.isArray(scanExtensions)) {
    for (const ext of scanExtensions) add(ext);
  }
  return set;
}

/**
 * @param {string[] | null} [scanExtensions]
 * @param {string[] | null} [excludeDirectories]
 */
async function scanDirectory(directoryPath, maxFileSize, scanExtensions = null, excludeDirectories = null) {
  const files = [];
  /** Model files left out because they are larger than maxFileSize. */
  let skippedDueToSize = 0;
  /** Every file-type dirent seen while walking the tree (matches legacy totalFiles meaning). */
  let traversedFileEntries = 0;
  const extSet = buildScanExtensionSet(scanExtensions);
  const SCAN_FLUSH_BATCH = 400;

  const flushDiscoveredFiles = (force = false) => {
    while (files.length >= SCAN_FLUSH_BATCH || (force && files.length > 0)) {
      const chunk = files.splice(0, Math.min(SCAN_FLUSH_BATCH, files.length));
      parentPort.postMessage({ type: 'batch', files: chunk });
    }
  };

  const shouldQueueFile = (fileName) => {
    if (shouldSkipFileName(fileName)) return false;
    const ext = path.extname(fileName).toLowerCase();
    return extSet.has(ext);
  };

  // Throttle progress IPC: walking huge folders is sync; avoid flooding the main process.
  const TRAVERSE_PROGRESS_INTERVAL = isDockerContainer() ? 2000 : 1000;

  const reportTraversedFile = () => {
    traversedFileEntries++;
    if (traversedFileEntries % TRAVERSE_PROGRESS_INTERVAL === 0) {
      parentPort.postMessage({
        type: 'progress',
        processed: traversedFileEntries
      });
    }
  };

  // Use a simple queue system
  const excludedDirs = compileExcludeDirs(excludeDirectories, directoryPath);
  const queue = [{ type: 'dir', path: directoryPath }];
  const seenDirs = new Set();
  let activeOps = 0;

  // Promise to signal completion
  let resolveDone;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const processNext = () => {
    // If no active ops and queue is empty, we are done
    if (activeOps === 0 && queue.length === 0) {
      if (traversedFileEntries > 0) {
        parentPort.postMessage({
          type: 'progress',
          processed: traversedFileEntries
        });
      }
      flushDiscoveredFiles(true);
      resolveDone({ files: [], totalFiles: traversedFileEntries, skippedDueToSize });
      return;
    }

    // While we have capacity and items in queue, start processing
    while (activeOps < MAX_CONCURRENT_OPS && queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      activeOps++;

      if (item.type === 'dir') {
        processDirectory(item.path).finally(() => {
          activeOps--;
          processNext();
        });
      } else if (item.type === 'file') {
        processFile(item.path, item.name).finally(() => {
          activeOps--;
          processNext();
        });
      }
    }
  };

  const processDirectory = async (dirPath) => {
    if (isExcludedDir(dirPath, excludedDirs)) {
      console.debug(`Skipping excluded directory ${dirPath}`);
      return;
    }
    if (seenDirs.has(dirPath)) return;
    seenDirs.add(dirPath);

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          if (shouldSkipDirectoryName(entry.name, scanExcludeNames)) {
            continue;
          }
          // Prioritize files over directories to keep memory usage lower?
          // Actually directories first might discover more work faster.
          queue.push({ type: 'dir', path: fullPath });
        } else {
          // Only queue model files and archives. Queuing every file caused
          // millions of async processFile() calls on large trees even when stat() was skipped.
          reportTraversedFile();
          if (shouldQueueFile(entry.name)) {
            queue.push({ type: 'file', path: fullPath, name: entry.name });
          }
        }
      }
    } catch (err) {
      console.error(`Skipping directory ${dirPath} due to error: ${err.message}`);
    }
  };

  const processFile = async (filePath, fileName) => {
    try {
      // Check extension FIRST to avoid unnecessary stat() calls
      const ext = path.extname(fileName).toLowerCase();

      if (extSet.has(ext)) {
        // Only call stat() for valid 3D model files
        const stats = await fs.promises.stat(filePath);
        if (stats.size <= maxFileSize || ARCHIVE_EXTENSIONS.has(ext)) {
          // Add file without hash calculation (calculate later if needed)
          files.push({
            filePath,
            fileName,
            size: stats.size,
            mtime: stats.mtime,
            hash: null, // Calculate later if needed
            isZipArchive: false
          });
          flushDiscoveredFiles();
        } else {
          skippedDueToSize++;
        }
      }
      // For all other files, do nothing - no stat() call!
    } catch (error) {
      console.error(`Error processing file ${filePath}:`, error);
    }
  };

  // Start processing
  processNext();

  return donePromise;
}

parentPort.on('message', async ({ directoryPath, maxFileSize, scanExtensions, excludeFolderNames, excludeDirectories }) => {
  scanExcludeNames = normalizeExcludeNames(excludeFolderNames);
  const extList = Array.from(buildScanExtensionSet(scanExtensions));

  try {
    const result = await scanDirectory(directoryPath, maxFileSize, extList, excludeDirectories);
    parentPort.postMessage({ type: 'done', result });
  } catch (error) {
    parentPort.postMessage({ type: 'error', error: error.message });
  }
});
