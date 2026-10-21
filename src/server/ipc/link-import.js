'use strict';

// Bulk import from links (src/server/link-import.js): Library → Add Links.
const database = require('../../core/database');
const events = require('../events');
const { ipcMain } = require('../runtime');
const { saveThumbnail } = require('../../core/thumbnail-store');
const { checkLinks, importLink } = require('../link-import');
const { saveModel } = require('./models');

// Other browsers search again once a batch of imports goes quiet, not after every link.
/** @type {NodeJS.Timeout | null} */
let refreshTimer = null;
function refreshSoon() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => events.broadcast('refresh-grid'), 1500);
  if (refreshTimer.unref) refreshTimer.unref();
}

/** Pasted text → the model links in it, each marked new or already in the library. */
ipcMain.handle('check-model-links', async (event, text) => checkLinks(database.db, text));

/** A designer's or collection's model links (Add Links): { url, title, links, total }. `uid`: a MakerWorld designer's id when known. */
ipcMain.handle('list-model-links', async (event, url, options) =>
  require('../link-lists').listModelLinks(url, { uid: options && typeof options.uid === 'string' ? options.uid : null })
);

/** Add one model link to the library (the dialog calls this link by link, to show progress). */
/** `options.downloadFolder` (any text): download the model's files, into the Upload folder (upload-inbox.js; since 8.4 every download goes there). */
ipcMain.handle('import-model-link', async (event, url, options) => {
  const { download } = require('../site-details');
  const { downloadFiles } = require('../site-files');
  // Only downloads show above Library Storage (adding a link alone is quick).
  const wantsDownload = !!(options && typeof options.downloadFolder === 'string' && options.downloadFolder);
  const downloadFolder = wantsDownload ? require('../upload-inbox').requireUploadFolder() : null;
  /** @param {(changes: object) => void} progressed */
  const run = (progressed) =>
    importLink(
      url,
      { db: database.db, saveModel, saveThumbnail, download, downloadFiles },
      {
        downloadFolder,
        profileIds: options && Array.isArray(options.profileIds) ? options.profileIds.filter((id) => typeof id === 'string').slice(0, 200) : null,
        fileIds: options && Array.isArray(options.fileIds) ? options.fileIds.filter((id) => typeof id === 'string').slice(0, 500) : null,
        downloadOptions: {
          event,
          onProgress: (progress) => {
            progressed({ detail: progress.label || null, done: progress.received, total: progress.total || null });
            events.toCaller(event, 'makerworld-download-progress', progress);
          }
        }
      }
    );
  const result = wantsDownload ? await require('../activity').track('download', 'Downloading from a model site', { unit: 'bytes' }, run) : await run(() => {});
  if (result.status === 'added' || result.status === 'downloaded') refreshSoon();
  return result;
});

/** The files of a Printables or Thingiverse model, to tick in Add Links: { files } or { needsToken, error }. */
ipcMain.handle('list-site-files', async (event, url) => {
  try {
    return { files: await require('../site-files').listFiles(url) };
  } catch (error) {
    if (error.code === 'THINGIVERSE_TOKEN') return { files: [], needsToken: true, error: error.message };
    throw error;
  }
});

/** Download a Printables or Thingiverse model's files from the details panel: { url, fileIds }, into the Upload folder. */
ipcMain.handle('site-download-files', async (event, request) => {
  const { url, fileIds } = request || {};
  const folder = require('../upload-inbox').requireUploadFolder();
  return require('../activity').track('download', 'Downloading from a model site', { unit: 'bytes' }, (progressed) =>
    require('../site-files').downloadFiles(
      { url, folder, fileIds: Array.isArray(fileIds) ? fileIds.filter((id) => typeof id === 'string').slice(0, 500) : null },
      {
        onProgress: (progress) => {
          progressed({ detail: progress.label || null, done: progress.received, total: progress.total || null });
          events.toCaller(event, 'makerworld-download-progress', progress);
        }
      }
    )
  );
});

ipcMain.handle('thingiverse-token-status', async () => require('../site-files').tokenStatus());

/** Admins only: check a Thingiverse API token and keep it ('' removes it). */
ipcMain.handle('set-thingiverse-token', async (event, value) => require('../site-files').setToken(value));
