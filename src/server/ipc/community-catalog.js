'use strict';

// The filament catalogue's sources: SpoolmanDB downloaded on request (src/server/community-catalog.js). Admins only.

const { ipcMain } = require('../runtime');
const community = require('../community-catalog');

ipcMain.handle('get-catalog-sources', () => community.status());
ipcMain.handle('refresh-spoolmandb', () => community.refresh());
ipcMain.handle('remove-spoolmandb', () => community.remove());
