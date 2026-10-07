'use strict';

// Uploads from the browser (src/server/uploads.js has the upload route itself).
const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const { readStlHomeDirectories } = require('../../core/library-paths');
const { networkPathContext } = require('../path-context');
const { isInsideOrSame } = require('../server-paths');
const { allowedUploadExtensions, checkFolder, maxUploadBytes, rootFor, uploadChunkBytes } = require('../uploads');

/** What the upload dialog checks before sending: the file types, the size limits, and the size of the pieces it sends. */
ipcMain.handle('get-upload-info', async () => ({
  extensions: allowedUploadExtensions(),
  maxBytes: maxUploadBytes(),
  chunkBytes: uploadChunkBytes(),
  scanMaxBytes: scanMaxBytes()
}));

/** Scans skip files larger than this (Settings → General → Performance; 50 MB unless changed). */
function scanMaxBytes() {
  const row = database.db && database.db.prepare('SELECT value FROM settings WHERE key = ?').get('maxFileSizeMB');
  const mb = row ? parseInt(row.value, 10) : NaN;
  return (Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024;
}

/**
 * After a batch of uploads: scan the folder so the new models show up. `filePaths` (the files
 * just uploaded) are counted in `inLibrary`: folder watching may have added them already.
 */
ipcMain.handle('add-uploaded-files', async (event, folder, filePaths) => {
  const ctx = networkPathContext();
  const dir = checkFolder(folder, ctx);
  const { scanUploadedFolder } = require('../stl-home');
  const isStlHomeScan = readStlHomeDirectories().some((home) => isInsideOrSame(dir, home));
  const newModels = await scanUploadedFolder(dir, rootFor(dir, ctx.roots), { isStlHomeScan });
  const paths = (Array.isArray(filePaths) ? filePaths : []).filter((p) => typeof p === 'string' && isInsideOrSame(p, dir));
  const known = database.db.prepare('SELECT 1 FROM models WHERE filePath = ?');
  return { newModels, inLibrary: paths.filter((p) => known.get(p)).length };
});
