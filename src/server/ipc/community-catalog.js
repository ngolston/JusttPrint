'use strict';

// The filament catalogue's sources and brands (src/server/community-catalog.js,
// src/core/filament-catalog.js): checking SpoolmanDB for updates, removing it, renaming and
// merging brands. Admins only (api-actions.js).

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const community = require('../community-catalog');
const catalog = require('../../core/filament-catalog');

const ids = (list) => (Array.isArray(list) ? list.map(Number).filter((id) => Number.isInteger(id) && id > 0) : []);

ipcMain.handle('get-catalog-sources', () => community.status(database.db));
ipcMain.handle('refresh-spoolmandb', (event, options) => community.refresh(database.db, { force: !!(options && options.force) }));
ipcMain.handle('remove-spoolmandb', () => community.remove(database.db));
ipcMain.handle('get-catalog-brands', (event, options) =>
  catalog.listBrands(database.db, { search: options && options.search, limit: options && options.limit })
);
ipcMain.handle('rename-catalog-brand', (event, id, name) => catalog.renameBrand(database.db, Number(id), name));
ipcMain.handle('merge-catalog-brands', (event, fromIds, intoId) => catalog.mergeBrands(database.db, ids(fromIds), Number(intoId)));
ipcMain.handle('get-catalog-brand-suggestions', () => catalog.brandSuggestions(database.db));
ipcMain.handle('ignore-catalog-brand-suggestion', (event, brandIds) => catalog.ignoreBrandSuggestion(database.db, ids(brandIds)));
