'use strict';

// Filament brands, profiles and the catalogue (src/core/filament-profiles.js, filament-catalog.js).

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const profiles = require('../../core/filament-profiles');
const catalog = require('../../core/filament-catalog');

ipcMain.handle('get-filament-brands', () => profiles.listBrands(database.db));
ipcMain.handle('save-filament-brand', (event, brand) => profiles.saveBrand(database.db, brand || {}));
ipcMain.handle('delete-filament-brand', (event, id) => profiles.deleteBrand(database.db, Number(id)));
ipcMain.handle('get-filament-profiles', (event, options) => profiles.listProfiles(database.db, options || {}));
ipcMain.handle('save-filament-profile', (event, profile) => profiles.saveProfile(database.db, profile));
ipcMain.handle('delete-filament-profile', (event, id) => {
  const deleted = profiles.deleteProfile(database.db, Number(id));
  require('../photos').sweepSoon();
  return deleted;
});
ipcMain.handle('set-filament-photo', (event, id, photo) => {
  require('../photos').setPhoto(database.db, 'filament', Number(id), photo || null);
  return profiles.getProfile(database.db, Number(id));
});
ipcMain.handle('search-filament-catalog', (event, query, options) => profiles.searchCatalog(database.db, query, { limit: options && options.limit }));
ipcMain.handle('add-catalog-filament', (event, catalogId) => profiles.addFromCatalog(database.db, catalogId));
// The catalogue's filaments, added and changed by hand (src/core/filament-catalog.js).
ipcMain.handle('get-catalog-filament', (event, id) => catalog.getFilament(database.db, Number(id)));
ipcMain.handle('save-catalog-filament', (event, filament) =>
  catalog.saveFilament(database.db, filament || {}, event && event.user && event.user.id ? event.user.id : null)
);
ipcMain.handle('delete-catalog-filament', (event, id) => catalog.deleteFilament(database.db, Number(id)));
