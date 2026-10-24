'use strict';

// The bell's notifications (src/server/notifications.js): each caller sees what their role may.
const { ipcMain } = require('../runtime');
const notifications = require('../notifications');

ipcMain.handle('get-notifications', async (event, options) => notifications.listFor(event && event.user, options || {}));

ipcMain.handle('mark-notifications-read', async (event, upToId) => notifications.markRead(event && event.user, upToId));
/** Clear the list up to that notification (for this account). */
ipcMain.handle('clear-notifications', async (event, upToId) => notifications.clearFor(event && event.user, upToId));

/** What runs in the background now (activity.js): the progress bars above Library Storage. */
ipcMain.handle('get-background-activity', async () => require('../activity').list());
