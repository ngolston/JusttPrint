'use strict';

// Uploads from the browser (src/server/uploads.js has the upload route itself).
const { ipcMain } = require('../runtime');
const { readStlHomeDirectories } = require('../../core/library-paths');
const { networkPathContext } = require('../path-context');
const { isInsideOrSame } = require('../server-paths');
const { allowedUploadExtensions, checkFolder, maxUploadBytes, rootFor } = require('../uploads');

/** What the upload dialog checks before sending: the file types it may upload, and the size limit. */
ipcMain.handle('get-upload-info', async () => ({
  extensions: allowedUploadExtensions(),
  maxBytes: maxUploadBytes()
}));

/** After a batch of uploads: scan the folder so the new models show up. */
ipcMain.handle('add-uploaded-files', async (event, folder) => {
  const ctx = networkPathContext();
  const dir = checkFolder(folder, ctx);
  const { scanUploadedFolder } = require('../stl-home');
  const isStlHomeScan = readStlHomeDirectories().some((home) => isInsideOrSame(dir, home));
  const newModels = await scanUploadedFolder(dir, rootFor(dir, ctx.roots), { isStlHomeScan });
  return { newModels };
});
