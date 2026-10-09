'use strict';

// Bulk import from links (src/server/link-import.js): Library → Add Links.
const database = require('../../core/database');
const events = require('../events');
const { ipcMain } = require('../runtime');
const { saveThumbnail } = require('../../core/thumbnail-store');
const { checkLinks, importLink } = require('../link-import');
const { saveModel } = require('./models');

// Other browsers search again once a batch of imports goes quiet, not after every link.
let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => events.broadcast('refresh-grid'), 1500);
  if (refreshTimer.unref) refreshTimer.unref();
}

/** Pasted text → the model links in it, each marked new or already in the library. */
ipcMain.handle('check-model-links', async (event, text) => checkLinks(database.db, text));

/** Add one model link to the library (the dialog calls this link by link, to show progress). */
/** `options.downloadFolder`: download MakerWorld models into that library folder (site-details.js). */
ipcMain.handle('import-model-link', async (event, url, options) => {
  const { download } = require('../site-details');
  const { downloadFiles } = require('../site-files');
  const result = await importLink(url, { db: database.db, saveModel, saveThumbnail, download, downloadFiles }, {
    downloadFolder: options && typeof options.downloadFolder === 'string' ? options.downloadFolder : null,
    profileIds: options && Array.isArray(options.profileIds) ? options.profileIds.filter((id) => typeof id === 'string').slice(0, 200) : null,
    fileIds: options && Array.isArray(options.fileIds) ? options.fileIds.filter((id) => typeof id === 'string').slice(0, 500) : null,
    downloadOptions: { event, onProgress: (progress) => events.toCaller(event, 'makerworld-download-progress', progress) }
  });
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

/** Download a Printables or Thingiverse model's files from the details panel: { url, folder, fileIds }. */
ipcMain.handle('site-download-files', async (event, request) => {
  const { url, folder, fileIds } = request || {};
  return require('../site-files').downloadFiles(
    { url, folder, fileIds: Array.isArray(fileIds) ? fileIds.filter((id) => typeof id === 'string').slice(0, 500) : null },
    { onProgress: (progress) => events.toCaller(event, 'makerworld-download-progress', progress) }
  );
});

ipcMain.handle('thingiverse-token-status', async () => require('../site-files').tokenStatus());

/** Admins only: check a Thingiverse API token and keep it ('' removes it). */
ipcMain.handle('set-thingiverse-token', async (event, value) => require('../site-files').setToken(value));
