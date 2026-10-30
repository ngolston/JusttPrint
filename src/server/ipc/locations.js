'use strict';

// Where spools are kept (src/core/storage-locations.js).

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const locations = require('../../core/storage-locations');

ipcMain.handle('get-storage-locations', () => locations.listLocations(database.db));
ipcMain.handle('save-storage-location', (event, location) =>
  locations.saveLocation(database.db, location, { userId: (event && event.user && event.user.id) || null })
);
ipcMain.handle('delete-storage-location', (event, id) => locations.deleteLocation(database.db, Number(id)));
