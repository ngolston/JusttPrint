'use strict';

// Collections (core/collections.js) and share links (core/share-links.js).
const database = require('../../core/database');
const collections = require('../../core/collections');
const shares = require('../../core/share-links');
const { ipcMain } = require('../runtime');
const events = require('../events');

const who = (event) => (event && event.user ? event.user.username : null);

/** Every browser redraws its collections after a change. */
const changed = (result) => {
  events.broadcast('collections-changed');
  return result;
};

ipcMain.handle('get-collections', async () => collections.listCollections(database.db));
ipcMain.handle('get-collection', async (event, id) => collections.getCollection(database.db, id));
ipcMain.handle('get-collection-membership', async (event, filePaths) => collections.membership(database.db, filePaths));

ipcMain.handle('create-collection', async (event, details) =>
  changed(collections.createCollection(database.db, { ...(details || {}), createdBy: who(event) }))
);
ipcMain.handle('update-collection', async (event, id, changes) => changed(collections.updateCollection(database.db, id, changes || {})));
ipcMain.handle('delete-collection', async (event, id) => {
  const result = collections.deleteCollection(database.db, id);
  shares.revokeLinksOf(database.db, 'collection', id);
  return changed(result);
});
ipcMain.handle('add-to-collection', async (event, id, filePaths) => changed(collections.addToCollection(database.db, id, filePaths)));
ipcMain.handle('remove-from-collection', async (event, id, filePaths) => changed(collections.removeFromCollection(database.db, id, filePaths)));

ipcMain.handle('create-share-link', async (event, options) => shares.createShareLink(database.db, { ...(options || {}), createdBy: who(event) }));
ipcMain.handle('get-share-links', async (event, filter) => shares.listShareLinks(database.db, filter || {}));
ipcMain.handle('revoke-share-link', async (event, token) => shares.revokeShareLink(database.db, token));
