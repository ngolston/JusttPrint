#!/usr/bin/env node
'use strict';

// The files on a Bambu Lab printer (printer-files.js, bambu-ftps.js): list, plates, print, delete.

const assert = require('assert');
const path = require('path');
const Database = require('better-sqlite3');
const { zipSync, strToU8 } = require('fflate');
// The end-to-end checks' fake printer (a path, so the server type check leaves that file alone).
const { startFakeFtps } = require(path.join(__dirname, '..', '..', 'tests', 'e2e', 'fake-bambu'));
const { parseListing, printerPath } = require('./bambu-ftps');
// Stood in for below (a printer that is followed and connected).
const live = /** @type {any} */ (require('./bambu-live'));
const files = require('./printer-files');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const sliced = () =>
  Buffer.from(
    zipSync({
      'Metadata/slice_info.config': strToU8(
        '<config><plate><metadata key="index" value="2"/><metadata key="prediction" value="600"/><filament id="1" type="PLA" color="#FFFFFF" used_g="5"/></plate></config>'
      ),
      'Metadata/plate_2.gcode': strToU8('G28\n')
    })
  );

test('reads a LIST reply: folders and files, sizes and dates', () => {
  const now = new Date('2026-11-05T15:00:00');
  const listed = parseListing(
    [
      'drwxr-xr-x    2 root     root            0 Jan 02  2026 timelapse',
      '-rw-r--r--    1 root     root      1234567 Nov 05 12:34 Robot Arm.gcode.3mf',
      '-rw-r--r--    1 root     root          10 Dec 30 09:00 old.gcode',
      'total 3'
    ].join('\r\n'),
    now
  );
  assert.deepStrictEqual(
    listed.map((e) => [e.name, e.folder, e.size]),
    [
      ['timelapse', true, 0],
      ['Robot Arm.gcode.3mf', false, 1234567],
      ['old.gcode', false, 10]
    ]
  );
  assert.strictEqual(new Date(listed[1].modified).getFullYear(), 2026);
  assert.strictEqual(new Date(listed[2].modified).getFullYear(), 2025, 'a date still to come this year is last year’s');
  assert.strictEqual(printerPath('timelapse/'), '/timelapse');
  assert.throws(() => printerPath('/../etc'), /not a path/);
});

test('lists, reads plates, prints and deletes files on the printer', async () => {
  const db = new Database(':memory:');
  db.exec(
    "CREATE TABLE printers (id INTEGER PRIMARY KEY, nickname TEXT, model TEXT, connection_type TEXT); INSERT INTO printers VALUES (1, 'P1S', 'P1S', 'bambu');"
  );
  const ftps = await startFakeFtps({ accessCode: 'CODE' });
  ftps.files['Robot.gcode.3mf'] = sliced();
  ftps.files['calibration.gcode'] = Buffer.from('G28\n');
  ftps.files['notes.txt'] = Buffer.from('hi');
  process.env.JUSTTPRINT_BAMBU_FTPS_PORT = String(ftps.port);
  const sent = [];
  /** @type {any} */
  let summary = { connected: true, state: 'idle', job: null, errors: [], ams: [{ id: 0, trays: [] }] };
  const original = { target: live.target, command: live.command };
  live.target = (id) => (id === 1 ? { host: '127.0.0.1', serial: 'S', secret: 'CODE', summary } : null);
  live.command = (id, payload) => sent.push(payload) > 0;
  try {
    const listing = await files.listPrinterFiles(db, 1, '/');
    assert.strictEqual(listing.dir, '/');
    assert.strictEqual(listing.entries[0].name, 'timelapse', 'folders first');
    assert.deepStrictEqual(
      listing.entries.filter((e) => e.printable).map((e) => e.path),
      ['/calibration.gcode', '/Robot.gcode.3mf'],
      'files of the same time by name'
    );
    assert.deepStrictEqual(
      (await files.printerFilePlates(db, 1, '/Robot.gcode.3mf')).map((p) => p.index),
      [2]
    );
    await files.printPrinterFile(db, 1, '/Robot.gcode.3mf', {});
    assert.deepStrictEqual([sent[0].print.param, sent[0].print.url], ['Metadata/plate_2.gcode', 'file:///sdcard/Robot.gcode.3mf']);
    await files.printPrinterFile(db, 1, '/calibration.gcode');
    assert.deepStrictEqual([sent[1].print.command, sent[1].print.param], ['gcode_file', '/sdcard/calibration.gcode']);
    await assert.rejects(files.printPrinterFile(db, 1, '/notes.txt'), /Only sliced projects/);
    summary = { ...summary, state: 'printing', job: 'Robot' };
    await assert.rejects(files.printPrinterFile(db, 1, '/calibration.gcode'), /cannot take a print now: Printing/);
    await assert.rejects(files.deletePrinterFile(db, 1, '/Robot.gcode.3mf'), /printing this file/);
    await files.deletePrinterFile(db, 1, '/calibration.gcode');
    assert.ok(!ftps.files['calibration.gcode'], 'deleted on the printer');
    await assert.rejects(files.deletePrinterFile(db, 1, '/gone.gcode'), /Deleting the file/);
    live.target = () => null;
    await assert.rejects(files.listPrinterFiles(db, 1), /not connected/);
  } finally {
    live.target = original.target;
    live.command = original.command;
    delete process.env.JUSTTPRINT_BAMBU_FTPS_PORT;
    await ftps.close();
  }
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}:`, error.stack || error.message);
      process.exitCode = 1;
    }
  }
})();
