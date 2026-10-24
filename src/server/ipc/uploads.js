'use strict';

// Uploads from the browser (src/server/uploads.js has the upload route itself).
const path = require('path');
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
  scanMaxBytes: scanMaxBytes(),
  // Pictures, videos and documents a model folder takes (model-folders.js).
  mediaExtensions: require('../model-folders').mediaExtensions()
}));

/** Scans skip files larger than this (Settings → Scanning → File Size; 50 MB unless changed). */
function scanMaxBytes() {
  const row = database.db && database.db.prepare('SELECT value FROM settings WHERE key = ?').get('maxFileSizeMB');
  const mb = row ? parseInt(row.value, 10) : NaN;
  return (Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024;
}

/**
 * After a batch of uploads: scan the folder so the new models show up. `filePaths` (the files
 * just uploaded) are counted in `inLibrary`: folder watching may have added them already.
 * `partOf` (Upload on a model's page): that model's path; the model files become its parts,
 * listed on its page and not in the library.
 */
ipcMain.handle('add-uploaded-files', async (event, folder, filePaths, partOf) => {
  const ctx = networkPathContext();
  const modelFolders = require('../model-folders');
  // Into a model folder's image, video or document folder: the model folder is scanned.
  const dir = checkFolder(modelFolders.isMediaFolder(folder) ? path.dirname(modelFolders.folderKey(folder)) : folder, ctx);
  const { scanUploadedFolder } = require('../stl-home');
  const isStlHomeScan = readStlHomeDirectories().some((home) => isInsideOrSame(dir, home));
  const paths = (Array.isArray(filePaths) ? filePaths : []).filter((p) => typeof p === 'string' && isInsideOrSame(p, dir));
  const newModels = await scanUploadedFolder(dir, rootFor(dir, ctx.roots), { isStlHomeScan });
  const known = database.db.prepare('SELECT 1 FROM models WHERE filePath = ?');
  const isKnown = (p) => !!known.get(p);
  // A model folder's first picture becomes its cover; a cover goes on new files too.
  if (modelFolders.isModelFolder(dir)) await modelFolders.coverIfNone(dir).catch((error) => console.warn(`[Upload] cover: ${error.message}`));
  // Pictures, videos, documents and other files in a model folder's subfolders (any file there is its media).
  const isMedia = (p) => modelFolders.isMediaFolder(path.dirname(p));
  const media = paths.filter(isMedia).length;
  if (modelFolders.isModelFolder(dir)) require('../events').broadcast('folder-changed', { path: modelFolders.folderKey(dir) });
  // Files that did not become models, and why (the upload's summary lists them).
  const max = scanMaxBytes();
  const notAdded = paths
    .filter((p) => !isKnown(p) && !isMedia(p))
    .map((p) => {
      let size = 0;
      try {
        size = require('fs').statSync(p).size;
      } catch (_) {
        /* gone */
      }
      const reason =
        size > max ? `larger than the Max File Size (${Math.round(max / 1024 / 1024)} MB, Settings → Scanning → File Size)` : 'not added by the scan';
      return { name: path.basename(p), reason };
    });
  const parts =
    typeof partOf === 'string' && partOf
      ? require('../../core/models').setModelParts(
          partOf,
          paths.filter((p) => isKnown(p) && !isMedia(p))
        )
      : 0;
  return { newModels, inLibrary: paths.filter(isKnown).length + media, media, notAdded, parts };
});
