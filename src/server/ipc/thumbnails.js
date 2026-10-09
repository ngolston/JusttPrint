'use strict';

const events = require('../events');
const thumbnailWorker = require('../thumbnail-worker');
const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const { deriveBundleFromFilePath } = require('../../core/bundle-keys');
const { loadThumbnailForModel, parseThumbnails, readThumbnailColumn } = require('../../core/thumbnails');
const { getModelByFilePath } = require('../../core/models');
const { addMultipleThumbnails, addThumbnailToModel, saveThumbnail, setDefaultThumbnailIndex } = require('../../core/thumbnail-store');
const gridThumbnails = require('../grid-thumbnails');

ipcMain.handle('save-thumbnail', async (event, filePath, thumbnail) => {
  try {
    await saveThumbnail(filePath, thumbnail);
    return true;
  } catch (error) {
    console.error('Error saving thumbnail:', error);
    throw error;
  }
});

ipcMain.handle('purge-thumbnails', async () => {
  try {
    database.db.prepare('UPDATE models SET thumbnail = NULL').run();
    return true;
  } catch (error) {
    console.error('Error purging thumbnails:', error);
    throw error;
  }
});

// ---------------------------------------------------------------------------
// Server/Docker: bulk thumbnail jobs run in the hidden Electron window (WebGL),
// so browser-tab focus throttling cannot stall Generate Missing / Regenerate.
// ---------------------------------------------------------------------------
/** @type {{ status: string, mode: string | null, cancelRequested: boolean }} */
let serverThumbnailJob = {
  status: 'idle', // idle | running
  mode: null,
  cancelRequested: false
};

function thumbnailJobRunning() {
  return serverThumbnailJob.status === 'running';
}

/** Ask a running job to stop after the current model (server shutdown). */
function requestThumbnailJobCancel() {
  if (thumbnailJobRunning()) serverThumbnailJob.cancelRequested = true;
}

function broadcastThumbnailJobEvent(channel, payload) {
  events.broadcast(channel, payload);
}

async function startServerThumbnailJobInternal(mode) {
  if (serverThumbnailJob.status === 'running') {
    return { success: false, error: 'A thumbnail job is already running' };
  }
  if (!thumbnailWorker.ready()) {
    return { success: false, error: "The JusttPrint backend's thumbnail worker is not ready" };
  }

  const jobMode = mode === 'all' ? 'all' : 'missing';
  serverThumbnailJob = { status: 'running', mode: jobMode, cancelRequested: false };

  try {
    if (jobMode === 'all') {
      database.db.prepare('UPDATE models SET thumbnail = NULL').run();
    }
    thumbnailWorker.send('run-server-thumbnail-job', { mode: jobMode });
    broadcastThumbnailJobEvent('thumbnail-job-progress', {
      phase: jobMode === 'all' ? 'Starting regeneration on the JusttPrint backend...' : 'Starting generation on the JusttPrint backend...',
      processed: 0,
      total: 0,
      mode: jobMode
    });
    return { success: true, mode: jobMode };
  } catch (error) {
    serverThumbnailJob = { status: 'idle', mode: null, cancelRequested: false };
    console.error('[Server thumbnails] Failed to start job:', error);
    return { success: false, error: error.message || String(error) };
  }
}

ipcMain.handle('start-server-thumbnail-job', async (_event, options) => {
  const mode = options && options.mode === 'all' ? 'all' : 'missing';
  const result = await startServerThumbnailJobInternal(mode);
  // A job someone started (it can run for a long time) ends with a notification; automatic ones after a scan do not.
  if (result && result.success) startedByPerson = true;
  return result;
});

ipcMain.handle('cancel-server-thumbnail-job', async () => {
  if (serverThumbnailJob.status !== 'running') {
    return { success: false, error: 'No thumbnail job running' };
  }
  serverThumbnailJob.cancelRequested = true;
  try {
    thumbnailWorker.send('cancel-server-thumbnail-job');
  } catch (error) {
    console.warn('[Server thumbnails] Cancel notify failed:', error.message);
  }
  return { success: true };
});

ipcMain.handle('report-server-thumbnail-progress', async (_event, progress) => {
  broadcastThumbnailJobEvent('thumbnail-job-progress', progress || {});
  return true;
});

/** The running job was started by a person (Generate Missing, Regenerate All), not after a scan. */
let startedByPerson = false;

ipcMain.handle('report-server-thumbnail-complete', async (_event, result) => {
  const info = result || {};
  console.log(`[Server thumbnails] Job ${info.cancelled ? 'cancelled' : 'finished'}: ${Number(info.count) || 0} rendered`);
  if (startedByPerson && !info.cancelled) {
    const notifications = require('../notifications');
    notifications.notify({
      level: 'success',
      title: 'Thumbnails finished',
      body: `${notifications.plural(Number(info.count) || 0, 'thumbnail')} rendered.`,
      minRole: 'editor'
    });
  }
  startedByPerson = false;
  serverThumbnailJob = { status: 'idle', mode: null, cancelRequested: false };
  broadcastThumbnailJobEvent('thumbnail-job-complete', result || {});
  events.broadcast('refresh-grid');
  return true;
});

ipcMain.handle('report-server-thumbnail-error', async (_event, errorInfo) => {
  console.error('[Server thumbnails] Job failed:', (errorInfo && errorInfo.message) || 'unknown error');
  serverThumbnailJob = { status: 'idle', mode: null, cancelRequested: false };
  startedByPerson = false;
  const message = (errorInfo && (errorInfo.message || errorInfo.error)) || String(errorInfo || 'Thumbnail job failed');
  require('../notifications').notify({ level: 'error', title: 'Thumbnails stopped with an error', body: message, minRole: 'editor' });
  broadcastThumbnailJobEvent('thumbnail-job-error', { error: message });
  return true;
});

ipcMain.handle('get-server-thumbnail-job-status', async () => {
  return {
    status: serverThumbnailJob.status,
    mode: serverThumbnailJob.mode,
    cancelRequested: !!serverThumbnailJob.cancelRequested
  };
});

// Add this IPC handler for thumbnails
// The grid's image: a small copy of a large first image when there is one (src/server/grid-thumbnails.js).
ipcMain.handle('getThumbnail', async (event, filePath) => {
  try {
    return gridThumbnails.gridImage(filePath, () => loadThumbnailForModel(filePath));
  } catch (error) {
    console.error('Error getting thumbnail:', error);
    return null;
  }
});

// IPC handler to get all thumbnails for a model
ipcMain.handle('get-all-thumbnails', async (event, filePath) => {
  try {
    const stored = loadThumbnailForModel(filePath);
    if (!stored) return [];
    return parseThumbnails(stored);
  } catch (error) {
    console.error('Error getting all thumbnails:', error);
    return [];
  }
});

// IPC handler to add a thumbnail to a model
ipcMain.handle('add-thumbnail', async (event, filePath, imageDataUrl) => {
  try {
    const currentThumbnail = readThumbnailColumn(filePath);
    const thumbnailsWithNew = addThumbnailToModel(currentThumbnail, imageDataUrl);

    // Parse thumbnails to get count and new index
    const thumbnails = parseThumbnails(thumbnailsWithNew);
    const newImageIndex = thumbnails.length - 1; // The new image is at the end

    // Make the new image the default (move it to the front)
    const updatedThumbnail = setDefaultThumbnailIndex(thumbnailsWithNew, newImageIndex);
    await saveThumbnail(filePath, updatedThumbnail);

    // Verify the save was successful
    const finalThumbnails = parseThumbnails(readThumbnailColumn(filePath) || '');

    events.broadcast('thumbnail-added', {
      filePath: filePath,
      thumbnailCount: finalThumbnails.length,
      hasMultiple: finalThumbnails.length > 1,
      newImageIsDefault: true
    });

    return true;
  } catch (error) {
    console.error('Error adding thumbnail:', error);
    throw error;
  }
});

// IPC handler to add multiple thumbnails at once (for 3MF files)
ipcMain.handle('add-multiple-thumbnails', async (event, filePath, imageDataUrls) => {
  try {
    if (!imageDataUrls || !Array.isArray(imageDataUrls) || imageDataUrls.length === 0) {
      return false;
    }

    // Check if model exists in database
    let model = getModelByFilePath(filePath);
    if (!model) {
      // Model doesn't exist yet - create it with just the thumbnails
      // Extract fileName from filePath
      const path = require('path');
      const fileName = path.basename(filePath);
      // Create model entry
      const dateAdded = new Date().toISOString();
      const bundle = deriveBundleFromFilePath(filePath);
      database.db
        .prepare(
          `
        INSERT INTO models (filePath, fileName, thumbnail, dateAdded, isNew, bundleKey, bundleLabel, bundleKind)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `
        )
        .run(filePath, fileName, '', dateAdded, bundle.bundleKey || null, bundle.bundleLabel || null, bundle.bundleKind || null);
      // Re-fetch the model
      model = getModelByFilePath(filePath);
      if (!model) {
        return false;
      }
    }

    const currentThumbnail = readThumbnailColumn(filePath);

    // Filter out any null/undefined/empty images
    const validImages = imageDataUrls.filter((img) => img && typeof img === 'string' && img.length > 0);

    if (validImages.length === 0) {
      return false;
    }

    const updatedThumbnail = addMultipleThumbnails(currentThumbnail, validImages);
    const finalCount = parseThumbnails(updatedThumbnail).length;

    // Save the thumbnail
    await saveThumbnail(filePath, updatedThumbnail);

    // Verify it was saved
    const verifyThumbnail = readThumbnailColumn(filePath);
    const verifyCount = verifyThumbnail ? parseThumbnails(verifyThumbnail).length : 0;

    if (verifyCount !== finalCount) {
      // Try to save again
      await saveThumbnail(filePath, updatedThumbnail);
    }

    // Return the updated thumbnail string so renderer can use it
    return {
      success: true,
      thumbnailCount: verifyCount,
      thumbnailString: verifyThumbnail || updatedThumbnail
    };
  } catch (error) {
    console.error('Error adding multiple thumbnails:', error);
    console.error('Error stack:', error.stack);
    throw error;
  }
});

// IPC handler to set the default thumbnail index
ipcMain.handle('set-default-thumbnail', async (event, filePath, index) => {
  try {
    const thumbnail = readThumbnailColumn(filePath);
    if (!thumbnail) return false;
    const updatedThumbnail = setDefaultThumbnailIndex(thumbnail, index);
    await saveThumbnail(filePath, updatedThumbnail);
    const thumbs = parseThumbnails(updatedThumbnail);
    const payload = {
      filePath,
      thumbnailCount: thumbs.length,
      defaultChanged: true
    };
    events.broadcast('thumbnail-default-changed', payload);
    return true;
  } catch (error) {
    console.error('Error setting default thumbnail:', error);
    throw error;
  }
});

// IPC handler to delete a thumbnail by index
ipcMain.handle('delete-thumbnail', async (event, filePath, index) => {
  try {
    const thumbnail = readThumbnailColumn(filePath);
    if (!thumbnail) return false;

    const thumbnails = parseThumbnails(thumbnail).filter((t) => t && t !== '3d.png' && t.length > 0 && t.startsWith('data:image'));

    // Ensure model has at least one thumbnail and index is valid
    if (thumbnails.length <= 1) {
      throw new Error('Cannot delete thumbnail: model must have at least one thumbnail');
    }

    if (index < 0 || index >= thumbnails.length) {
      throw new Error('Invalid thumbnail index');
    }

    // Cannot delete the active (first) thumbnail
    if (index === 0) {
      throw new Error('Cannot delete the active thumbnail');
    }

    // Remove the thumbnail at the specified index
    thumbnails.splice(index, 1);
    const updatedThumbnail = thumbnails.join('::');
    await saveThumbnail(filePath, updatedThumbnail);

    // Send refresh event
    if (event && event.sender) {
      events.broadcast('thumbnail-deleted', {
        filePath: filePath,
        thumbnailCount: thumbnails.length
      });
    } else
      events.broadcast('thumbnail-deleted', {
        filePath: filePath,
        thumbnailCount: thumbnails.length
      });

    return true;
  } catch (error) {
    console.error('Error deleting thumbnail:', error);
    throw error;
  }
});

// Add or update this function to get models without thumbnails
ipcMain.handle('get-models-without-thumbnails', async () => {
  try {
    const modelsWithoutThumbnails = database.db
      .prepare(
        `
      SELECT filePath FROM models WHERE thumbnail IS NULL OR thumbnail = '' OR thumbnail = '3d.png'
    `
      )
      .all();
    return modelsWithoutThumbnails;
  } catch (error) {
    console.error('Error fetching models without thumbnails:', error);
    return [];
  }
});

ipcMain.handle('get-models-with-default-thumbnails', async () => {
  try {
    const modelsWithDefaultThumbnails = database.db
      .prepare(
        `
      SELECT filePath FROM models WHERE thumbnail IS NULL OR thumbnail = '' OR thumbnail = '3d.png'
    `
      )
      .all();
    return modelsWithDefaultThumbnails;
  } catch (error) {
    console.error('Error fetching models with default thumbnails:', error);
    return [];
  }
});

module.exports = { requestThumbnailJobCancel, startServerThumbnailJobInternal, thumbnailJobRunning };
