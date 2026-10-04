'use strict';

const events = require('./events');
const thumbnailWorker = require('./thumbnail-worker');
const { getSettingValueOr } = require('../core/settings');
const { readStlHomeDirectories } = require('../core/library-paths');
const { scanDirectoryHandler } = require('./ipc/scan');
const { startServerThumbnailJobInternal, thumbnailJobRunning } = require('./ipc/thumbnails');

/** Event for work the server starts itself: progress goes to every connected browser. */
function serverIpcEvent() {
  return {
    sender: {
      send(channel, ...args) {
        events.broadcast(channel, ...args);
      }
    }
  };
}

let serverStlHomeTimer = null;

let serverStlHomeScanRunning = false;

/** STL Home scan run by the server (on Node there is no hidden window to start it). */
async function runServerStlHomeScan(reason) {
  if (serverStlHomeScanRunning) return;
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

/** First scan at startup, then every stlHomeUpdateFrequency minutes (default 60). */
function startServerStlHomeScans() {
  runServerStlHomeScan('startup').catch((error) => console.error('[STL Home] startup scan:', error));
  const minutes = parseInt(getSettingValueOr('stlHomeUpdateFrequency', '60'), 10) || 60;
  serverStlHomeTimer = setInterval(() => {
    runServerStlHomeScan('scheduled').catch((error) => console.error('[STL Home] scheduled scan:', error));
  }, minutes * 60 * 1000);
}

module.exports = { startServerStlHomeScans };
