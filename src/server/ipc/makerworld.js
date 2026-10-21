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
  const before = safely(() => siteDetails.editableValues(url));
  const result = await siteDetails.saveSiteEdits(url, changes, { event });
  // Written down for the History page (model-versions.js detail_changes), by the model's link.
  const after = safely(() => siteDetails.editableValues(url));
  if (before && after) {
    safely(() =>
      require('../model-versions').recordDetailChanges(
        'site',
        url,
        after.title || before.title || url,
        before,
        after,
        event && event.user ? event.user.username : null
      )
    );
    events.broadcast('model-history-changed', {});
  }
  events.broadcast('site-details-changed', { url });
  return result;
});

function safely(work) {
  try {
    return work();
  } catch (error) {
    console.warn('[History] Could not write down a site details change:', error.message);
    return null;
  }
}

ipcMain.handle('makerworld-account-status', async () => account.status());

/** One step of signing in: see makerworld-account.js signIn. */
ipcMain.handle('makerworld-sign-in', async (event, input) => account.signIn(input));

ipcMain.handle('makerworld-sign-out', async () => account.signOut());

/** Whether files can be saved in a library folder (read-only mounts are common in Docker). */
ipcMain.handle('makerworld-check-folder', async (event, folder) => siteDetails.checkFolder(folder));

/** Files downloaded on MakerWorld in a browser: make the model's folder, then (after the upload) add them. */
// Every download goes to the Upload folder (upload-inbox.js), whatever folder the page names.
const intoUploadFolder = (request) => ({ ...(request || {}), folder: require('../upload-inbox').requireUploadFolder() });
ipcMain.handle('makerworld-prepare-folder', async (event, request) => siteDetails.prepareManualFolder(intoUploadFolder(request)));
ipcMain.handle('makerworld-add-files', async (event, request) => siteDetails.finishManualFolder(request || {}));

/**
 * Download a model's files into a library folder: { url, folder, files, profileId }. A missing or
 * expired sign-in answers { signIn: true, error } instead of failing, so the browser asks for it.
 */
ipcMain.handle('makerworld-download', async (event, request) => {
  try {
    return await require('../activity').track('download', 'Downloading from MakerWorld', { unit: 'bytes' }, (progressed) =>
      siteDetails.download(intoUploadFolder(request), {
        event,
        onProgress: (progress) => {
          progressed({ detail: progress.label || null, done: progress.received, total: progress.total || null });
          events.toCaller(event, 'makerworld-download-progress', progress);
        }
      })
    );
  } catch (error) {
    if (error.code === 'SIGN_IN') return { signIn: true, error: error.message };
    throw error;
  }
});

// Google Cloud Translation (src/server/google-translate.js): its key and this month's use (Settings → MakerWorld).
ipcMain.handle('google-translate-status', async () => require('../google-translate').status());
ipcMain.handle('set-google-translate-key', async (event, key) => require('../google-translate').setKey(key));
