'use strict';

// Model folders (src/server/model-folders.js): a model's folder with its pictures, videos and documents.
const modelFolders = require('../model-folders');
const { ipcMain } = require('../runtime');
const { networkPathContext } = require('../path-context');

/** A new model folder inside a library folder, named after the model: { folder }. */
ipcMain.handle('make-model-folder', async (event, parent, name) => {
  const dir = require('../uploads').checkWritableFolder(parent, networkPathContext());
  return { folder: modelFolders.makeFolder(dir, name) };
});

/** Make a folder of models a model folder (its files stay where they are). */
ipcMain.handle('register-model-folder', async (event, dir) => {
  modelFolders.register(dir);
  require('../events').broadcast('folder-changed', { path: modelFolders.folderKey(dir) });
  return modelFolders.getMedia(dir);
});

/** A folder's (or a model file's folder's) pictures, videos, documents and YouTube videos. */
ipcMain.handle('get-model-media', async (event, dir) => modelFolders.getMedia(dir));
ipcMain.handle('set-model-cover', async (event, dir, name) => modelFolders.setCover(dir, name || null));
ipcMain.handle('remove-model-media', async (event, dir, kind, name) => modelFolders.removeMedia(dir, kind, name));
ipcMain.handle('add-model-youtube', async (event, dir, links) => modelFolders.addYoutube(dir, links));
ipcMain.handle('remove-model-youtube', async (event, dir, id) => modelFolders.removeYoutube(dir, id));

// Tidy Into Model Folders (Organize, admins): a folder of its own for each model already in the library.
const tidy = require('../tidy-model-folders');
/** A model page's Upload (editors): the model's own folder, made first when it has none. */
ipcMain.handle('model-own-folder', async (event, filePath) => tidy.ownFolder(filePath));
ipcMain.handle('tidy-model-folders-preview', async (event, under) => tidy.preview({ under: under || null }));
ipcMain.handle('tidy-model-folders', async (event, under, only, covers) =>
  tidy.apply({ under: under || null, only: Array.isArray(only) ? only : null, covers: !!covers })
);
