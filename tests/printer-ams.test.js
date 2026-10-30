#!/usr/bin/env node
'use strict';

// Phase 5 (docs/merge-10.md): printers' connection details (the secret never leaves the server),
// AMS units and slots, the printer's own holder, and Bambu Lab cloud printers.

const assert = require('assert');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const { ensureFilamentSchema } = require('../src/core/filament-schema');
const printerManager = require('../src/core/printer-manager');
const ams = require('../src/core/printer-ams');
const spools = require('../src/core/spools');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const fresh = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(
    'CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, print_status TEXT, dateAdded TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'
  );
  const log = console.log;
  console.log = () => {};
  try {
    ensureFilamentSchema(db);
  } finally {
    console.log = log;
  }
  return db;
};

test('the API key or access code is kept on the server, changed only when given', () => {
  const db = fresh();
  const saved = printerManager.savePrinter(db, {
    nickname: 'P1S',
    connectionType: 'bambu',
    serialNumber: '01P00A',
    apiUrl: '192.168.1.40',
    apiSecret: '12345678'
  });
  assert.strictEqual(saved.api_secret, undefined);
  assert.strictEqual(saved.has_api_secret, true);
  assert.deepStrictEqual([saved.connection_type, saved.serial_number, saved.api_url], ['bambu', '01P00A', '192.168.1.40']);
  assert.strictEqual(db.prepare('SELECT api_secret FROM printers WHERE id = ?').get(saved.id).api_secret, '12345678');
  const renamed = printerManager.savePrinter(db, { id: saved.id, nickname: 'P1S Studio', connectionType: 'bambu', serialNumber: '01P00A' });
  assert.strictEqual(renamed.has_api_secret, true, 'saving without apiSecret keeps it');
  const cleared = printerManager.savePrinter(db, { id: saved.id, nickname: 'P1S Studio', apiSecret: '' });
  assert.strictEqual(cleared.has_api_secret, false);
  assert.strictEqual(cleared.connection_type, 'manual', 'an unknown or missing type is manual');
  assert.ok(printerManager.getAllPrinters(db).every((p) => !('api_secret' in p)));
});

test('AMS units get the next letter and four slots; slots are labeled as Bambu does', () => {
  const db = fresh();
  const printer = printerManager.savePrinter(db, { nickname: 'X1C' });
  ams.addAmsUnit(db, printer.id);
  const second = ams.addAmsUnit(db, printer.id, { name: 'AMS lite', slots: 4 });
  const [loads] = ams.getPrinterLoads(db, printer.id);
  assert.deepStrictEqual(
    loads.units.map((u) => [u.name, u.slots.map((s) => s.label).join(' ')]),
    [
      ['AMS 1', 'A1 A2 A3 A4'],
      ['AMS lite', 'B1 B2 B3 B4']
    ]
  );
  ams.updateAmsUnit(db, second, { humidity: 21 });
  assert.strictEqual(ams.getPrinterLoads(db, printer.id)[0].units[1].humidity, 21);
  assert.throws(() => ams.updateAmsUnit(db, second, { humidity: 120 }), /0 to 100/);
  assert.throws(() => ams.addAmsUnit(db, 999), /no longer exists/);
});

test('a spool is loaded in one place at a time, becomes in use, and archived spools cannot be loaded', () => {
  const db = fresh();
  const p1s = printerManager.savePrinter(db, { nickname: 'P1S' });
  const ender = printerManager.savePrinter(db, { nickname: 'Ender 3' });
  ams.addAmsUnit(db, p1s.id);
  const slots = ams.getPrinterLoads(db, p1s.id)[0].units[0].slots;
  const black = spools.saveSpool(db, { material: 'PLA', color_hex: '#111111', initial_weight: 1000, remaining: 18 });
  ams.loadSpool(db, { slotId: slots[3].id }, black.id);
  let loads = ams.getPrinterLoads(db);
  assert.strictEqual(loads.find((l) => l.printerId === p1s.id).units[0].slots[3].spool.remaining, 18);
  assert.strictEqual(spools.getSpool(db, black.id).status, 'active');
  assert.deepStrictEqual(
    spools.getSpool(db, black.id).loaded.map((l) => l.label),
    ['P1S · A4']
  );
  // Onto the Ender's own holder: out of the P1S.
  ams.loadSpool(db, { printerId: ender.id }, black.id);
  loads = ams.getPrinterLoads(db);
  assert.strictEqual(loads.find((l) => l.printerId === p1s.id).units[0].slots[3].spool, null);
  assert.strictEqual(loads.find((l) => l.printerId === ender.id).direct.id, black.id);
  // Empty the holder.
  ams.loadSpool(db, { printerId: ender.id }, null);
  assert.strictEqual(ams.getPrinterLoads(db, ender.id)[0].direct, null);
  spools.archiveSpool(db, black.id, true);
  assert.throws(() => ams.loadSpool(db, { slotId: slots[0].id }, black.id), /archived/);
  assert.throws(() => ams.loadSpool(db, {}, null), /which slot/);
  assert.throws(() => ams.loadSpool(db, { slotId: 999 }, null), /no longer exists/);
  // Removing a unit leaves its spools loaded nowhere.
  const white = spools.saveSpool(db, { material: 'PLA', color_hex: '#ffffff', initial_weight: 1000 });
  ams.loadSpool(db, { slotId: slots[0].id }, white.id);
  ams.removeAmsUnit(db, ams.getPrinterLoads(db, p1s.id)[0].units[0].id);
  assert.deepStrictEqual(spools.getSpool(db, white.id).loaded, []);
});

test('Bambu Lab cloud printers are added once, updated by serial number, with an AMS', async () => {
  const db = fresh();
  const devices = require('../src/server/bambu-devices');
  const first = devices.importDevices(db, [
    { serial: '01P00A1', name: 'Workshop P1S', product: 'P1S', model: 'C12', online: true, nozzle: 0.4 },
    { serial: '', name: 'No serial', product: null, model: null, online: null, nozzle: null }
  ]);
  assert.deepStrictEqual(first, { created: 1, updated: 0, unchanged: 0, total: 1 });
  const printer = printerManager.getAllPrinters(db)[0];
  assert.deepStrictEqual([printer.nickname, printer.model, printer.connection_type, printer.status], ['Workshop P1S', 'P1S', 'bambu', 'idle']);
  assert.strictEqual(ams.getPrinterLoads(db, printer.id)[0].units[0].slots.length, 4);
  const again = devices.importDevices(db, [{ serial: '01P00A1', name: 'Garage P1S', product: 'P1S', model: 'C12', online: false, nozzle: 0.4 }]);
  assert.deepStrictEqual(again, { created: 0, updated: 1, unchanged: 0, total: 1 });
  assert.deepStrictEqual([printerManager.getAllPrinters(db)[0].nickname, printerManager.getAllPrinters(db)[0].status], ['Garage P1S', 'offline']);
  assert.strictEqual(ams.getPrinterLoads(db, printer.id)[0].units.length, 1, 'no second AMS');
});

test('the device list uses the Bambu Lab sign-in, refreshes an expired token once, and says when to sign in', async () => {
  const db = fresh();
  database.db = db;
  const devices = require('../src/server/bambu-devices');
  await assert.rejects(() => devices.listDevices(async () => ({ status: 200 })), /Sign in to your Bambu Lab account/);
  db.prepare("INSERT INTO settings (key, value) VALUES ('makerWorldAccount', ?)").run(
    JSON.stringify({ account: 'me@example.com', accessToken: 'old', refreshToken: 'r1' })
  );
  const seen = [];
  const reply = (status, body) => ({
    status,
    ok: status < 400,
    headers: { get: () => '' },
    body: null,
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
    text: async () => JSON.stringify(body)
  });
  const fetchImpl = async (url, options) => {
    seen.push([url.replace('https://api.bambulab.com', ''), options.headers.authorization || '']);
    if (url.endsWith('/user/bind')) {
      return options.headers.authorization === 'Bearer new'
        ? reply(200, { message: 'success', devices: [{ dev_id: 'SN1', name: 'P1S', dev_product_name: 'P1S', online: true }] })
        : reply(401, {});
    }
    if (url.endsWith('/refreshtoken')) return reply(200, { accessToken: 'new', refreshToken: 'r2' });
    return reply(200, {});
  };
  const list = await devices.listDevices(fetchImpl);
  assert.deepStrictEqual(list, [{ serial: 'SN1', name: 'P1S', product: 'P1S', model: null, online: true, nozzle: null }]);
  assert.deepStrictEqual(
    seen.filter(([url]) => /bind|refresh/.test(url)).map(([url, auth]) => `${url} ${auth}`),
    ['/v1/iot-service/api/user/bind Bearer old', '/v1/user-service/user/refreshtoken ', '/v1/iot-service/api/user/bind Bearer new']
  );
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}:`, err.stack || err.message);
      process.exitCode = 1;
    }
  }
})();
