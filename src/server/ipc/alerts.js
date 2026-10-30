'use strict';

// Low-stock rules and the reorder list (src/core/low-stock.js), where alerts go
// (alert-delivery.js) and webhooks (webhooks.js). Docs: merge-10.md, Phase 8.

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const lowStock = require('../../core/low-stock');
const delivery = require('../alert-delivery');
const webhooks = require('../webhooks');

const userId = (event) => (event && event.user && event.user.id) || null;

// Check the low-stock rules now (instead of waiting for the hourly check). Resolves to how many spools were told about.
ipcMain.handle('check-low-stock', () => require('../low-stock-alerts').run());
ipcMain.handle('get-reorder-list', () => lowStock.reorderList(database.db));
ipcMain.handle('get-low-stock-rules', () => ({ rules: lowStock.listRules(database.db), defaultRule: lowStock.DEFAULT_RULE }));
ipcMain.handle('save-low-stock-rule', (event, rule) => {
  const saved = lowStock.saveRule(database.db, rule || {}, { userId: userId(event) });
  require('../low-stock-alerts').soon(2000);
  return saved;
});
ipcMain.handle('delete-low-stock-rule', (event, id) => lowStock.deleteRule(database.db, Number(id)));

ipcMain.handle('get-alert-delivery', () => delivery.status());
ipcMain.handle('save-alert-delivery', (event, input) => delivery.save(input || {}));
ipcMain.handle('test-alert-delivery', async (event, kind) => {
  if (kind === 'discord') await delivery.sendDiscord({ content: 'A test from JusttPrint: low-stock alerts will arrive here.' });
  else if (kind === 'email')
    await delivery.sendEmail({ subject: 'JusttPrint test', text: 'A test from JusttPrint: low-stock alerts will arrive at this address.' });
  else throw new Error('Test discord or email');
  return true;
});

ipcMain.handle('get-webhooks', () => ({ webhooks: webhooks.list(), events: webhooks.EVENTS }));
ipcMain.handle('save-webhook', (event, webhook) => webhooks.save(webhook || {}, { userId: userId(event) }));
ipcMain.handle('delete-webhook', (event, id) => webhooks.remove(Number(id)));
ipcMain.handle('test-webhook', (event, id) => webhooks.test(Number(id)));
