'use strict';

const events = require('./events');
const thumbnailWorker = require('./thumbnail-worker');
const { getSettingValueOr } = require('../core/settings');
const { getScanExcludeNames, readStlHomeDirectories } = require('../core/library-paths');
const { compileExcludeDirs, isExcludedDir, shouldSkipDirectoryName } = require('../core/scan-skip');
const { ChangeQueue, TreeWatcher } = require('./folder-watch');
const { readStlHomeExcludeDirectories, scanDirectoryHandler } = require('./ipc/scan');
const { startServerThumbnailJobInternal, thumbnailJobRunning } = require('./ipc/thumbnails');

/**
 * Event for scans the server starts itself: progress goes to every connected browser, but not
 * the "Removed N non-existent files" message, which would pop up in every browser at each
 * scheduled scan (the server log has it).
 */
function serverIpcEvent() {
  return {
    sender: {
      send(channel, ...args) {
        if (channel === 'db-cleanup') return;
        events.broadcast(channel, ...args);
      }
    }
  };
}

/** @type {NodeJS.Timeout | null} */
let serverStlHomeTimer = null;

let serverStlHomeScanRunning = false;

/** STL Home scan run by the server (on Node there is no hidden window to start it). */
async function runServerStlHomeScan(reason) {
  if (serverStlHomeScanRunning || watchScanRunning) return;
  const dirs = readStlHomeDirectories();
  if (!dirs.length) return;
  serverStlHomeScanRunning = true;
  try {
    let newModels = 0;
    for (const dir of dirs) {
      try {
        const result = await scanDirectoryHandler(serverIpcEvent(), dir, { isStlHomeScan: true });
        const found = Number(result && result.newFilesCount) || 0;
        newModels += found;
        console.log(`[STL Home] ${reason} scan of ${dir}: ${found} new`);
      } catch (error) {
        console.error(`[STL Home] ${reason} scan of ${dir} failed:`, error.message);
      }
    }
    events.broadcast('refresh-grid');
    if (newModels > 0 && thumbnailWorker.ready() && !thumbnailJobRunning()) {
      startServerThumbnailJobInternal('missing').catch((error) => console.error('[STL Home] thumbnail job:', error.message));
    }
  } finally {
    serverStlHomeScanRunning = false;
  }
}

/** Minutes until the next scheduled scan (read each time, so a changed setting applies). */
function scanIntervalMs() {
  return (parseInt(getSettingValueOr('stlHomeUpdateFrequency', '60'), 10) || 60) * 60 * 1000;
}

function scheduleNextStlHomeScan() {
  serverStlHomeTimer = setTimeout(async () => {
    await runServerStlHomeScan('scheduled').catch((error) => console.error('[STL Home] scheduled scan:', error));
    scheduleNextStlHomeScan();
  }, scanIntervalMs());
  if (serverStlHomeTimer.unref) serverStlHomeTimer.unref();
}

/** First scan at startup, then every stlHomeUpdateFrequency minutes (default 60). */
function startServerStlHomeScans() {
  runServerStlHomeScan('startup').catch((error) => console.error('[STL Home] startup scan:', error));
  scheduleNextStlHomeScan();
}

// ---- Folder watching (src/server/folder-watch.js) ----

/** Scans started by folder watching are quiet: no progress, no "Removed N files" message. */
const quietEvent = { sender: { send() {} } };

let watchers = [];
/** @type {{ stop: () => void } | null} */
let watchQueue = null;
let watchScanRunning = false;
/** @type {NodeJS.Timeout | null} */
let restartTimer = null;

function watchingEnabled() {
  return getSettingValueOr('stlHomeWatch', '1') !== '0';
}

/** Rescan the changed folders under one STL Home folder. False when an STL Home scan is running (try later). */
async function rescanChangedFolders(root, folders) {
  if (serverStlHomeScanRunning || watchScanRunning) return false;
  watchScanRunning = true;
  try {
    let newModels = 0;
    for (const folder of folders) {
      try {
        const result = await scanDirectoryHandler(quietEvent, folder, { isStlHomeScan: true, scanRoot: root, rememberDirectory: false });
        newModels += Number(result && result.newFilesCount) || 0;
      } catch (error) {
        // A folder removed meanwhile: its parent was queued too and drops its models.
        if (!/ENOENT|no such file/i.test(error.message)) console.error(`[Watch] Rescan of ${folder} failed:`, error.message);
      }
    }
    console.log(`[Watch] Rescanned ${folders.length} folder(s) under ${root}: ${newModels} new`);
    events.broadcast('refresh-grid');
    if (newModels > 0 && thumbnailWorker.ready() && !thumbnailJobRunning()) {
      startServerThumbnailJobInternal('missing').catch((error) => console.error('[Watch] thumbnail job:', error.message));
    }
    return true;
  } finally {
    watchScanRunning = false;
  }
}

/**
 * Add the files just uploaded to `folder` (inside the library root `root`): scan that folder
 * once the running STL Home or watch scan (if any) is done, so two scans never insert the same
 * new file. Returns how many models are new.
 */
async function scanUploadedFolder(folder, root, { isStlHomeScan = false } = {}) {
  while (serverStlHomeScanRunning || watchScanRunning) await new Promise((resolve) => setTimeout(resolve, 250));
  watchScanRunning = true;
  let newModels;
  try {
    const result = await scanDirectoryHandler(quietEvent, folder, { isStlHomeScan, scanRoot: root, rememberDirectory: false });
    newModels = Number(result && result.newFilesCount) || 0;
  } finally {
    watchScanRunning = false;
  }
  console.log(`[Upload] Scanned ${folder}: ${newModels} new`);
  events.broadcast('refresh-grid');
  if (newModels > 0 && thumbnailWorker.ready() && !thumbnailJobRunning()) {
    startServerThumbnailJobInternal('missing').catch((error) => console.error('[Upload] thumbnail job:', error.message));
  }
  return newModels;
}

function stopWatching() {
  for (const watcher of watchers) watcher.close();
  watchers = [];
  if (watchQueue) watchQueue.stop();
  watchQueue = null;
}

/** (Re)start watching every STL Home folder, unless switched off (stlHomeWatch = 0). */
async function startWatching() {
  stopWatching();
  if (!watchingEnabled()) return;
  const roots = readStlHomeDirectories()
    .map((dir) => String(dir).trim())
    .filter(Boolean);
  if (!roots.length) return;
  const queue = new ChangeQueue({ scan: rescanChangedFolders });
  watchQueue = queue;
  const names = getScanExcludeNames();
  const excludes = readStlHomeExcludeDirectories();
  const started = [];
  for (const root of roots) {
    const excluded = compileExcludeDirs(excludes, root);
    const watcher = new TreeWatcher({
      root,
      isIgnoredDir: (dir) => shouldSkipDirectoryName(dir.split('/').pop(), names) || isExcludedDir(dir, excluded),
      onChange: (folder, changedPath) => queue.add(watcher.root, folder, changedPath)
    });
    watchers.push(watcher);
    started.push(
      watcher.start().then(() => {
        if (watcher.error) console.warn(`[Watch] ${watcher.root}: ${watcher.error}`);
        else console.log(`[Watch] Watching ${watcher.folderCount} folder(s) under ${watcher.root}`);
      })
    );
  }
  await Promise.all(started);
}

/** Settings that change what is watched (STL Home folders, exclusions, the switch): restart shortly. */
const WATCH_SETTING_KEYS = new Set(['stlHomeDirectories', 'stlHome', 'stlHomeExcludeDirectories', 'scanExcludeFolders', 'stlHomeWatch']);

function settingChanged(key) {
  if (!WATCH_SETTING_KEYS.has(key)) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startWatching().catch((error) => console.error('[Watch] Restart failed:', error));
  }, 1000);
  if (restartTimer.unref) restartTimer.unref();
}

/** What Settings → STL Home shows. */
function watchStatus() {
  return {
    enabled: watchingEnabled(),
    roots: watchers.map((watcher) => ({ path: watcher.root, folders: watcher.folderCount, error: watcher.error }))
  };
}

module.exports = { startServerStlHomeScans, startWatching, stopWatching, settingChanged, watchStatus, scanUploadedFolder };
