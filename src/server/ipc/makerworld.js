'use strict';

// MakerWorld in the details panel (src/server/site-details.js) and the MakerWorld sign-in (makerworld-account.js).
const events = require('../events');
const { ipcMain } = require('../runtime');
const account = require('../makerworld-account');
const siteDetails = require('../site-details');

/** A model link's MakerWorld details (null for other sites); `refresh` fetches them again. */
ipcMain.handle('get-site-details', async (event, url, refresh) => siteDetails.getDetails(url, { refresh: !!refresh, event }));

/** Keep changes to a model's site details (the Edit dialog); null forgets them. Answers the details as get-site-details does. */
ipcMain.handle('save-site-edits', async (event, url, changes) => {
  const result = await siteDetails.saveSiteEdits(url, changes, { event });
  events.broadcast('site-details-changed', { url });
  return result;
});

ipcMain.handle('makerworld-account-status', async () => account.status());

/** One step of signing in: see makerworld-account.js signIn. */
ipcMain.handle('makerworld-sign-in', async (event, input) => account.signIn(input));

ipcMain.handle('makerworld-sign-out', async () => account.signOut());

/** Whether files can be saved in a library folder (read-only mounts are common in Docker). */
ipcMain.handle('makerworld-check-folder', async (event, folder) => siteDetails.checkFolder(folder));

/** Files downloaded on MakerWorld in a browser: make the model's folder, then (after the upload) add them. */
ipcMain.handle('makerworld-prepare-folder', async (event, request) => siteDetails.prepareManualFolder(request || {}));
ipcMain.handle('makerworld-add-files', async (event, request) => siteDetails.finishManualFolder(request || {}));

/**
 * Download a model's files into a library folder: { url, folder, files, profileId }. A missing or
 * expired sign-in answers { signIn: true, error } instead of failing, so the browser asks for it.
 */
ipcMain.handle('makerworld-download', async (event, request) => {
  try {
    return await siteDetails.download(request || {}, {
      event,
      onProgress: (progress) => events.toCaller(event, 'makerworld-download-progress', progress)
    });
  } catch (error) {
    if (error.code === 'SIGN_IN') return { signIn: true, error: error.message };
    throw error;
  }
});
