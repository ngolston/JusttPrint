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
ipcMain.handle('import-model-link', async (event, url) => {
  const result = await importLink(url, { db: database.db, saveModel, saveThumbnail });
  if (result.status === 'added') refreshSoon();
  return result;
});
