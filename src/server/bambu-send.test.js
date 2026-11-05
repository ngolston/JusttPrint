#!/usr/bin/env node
'use strict';

// Sending a print to a Bambu Lab printer (bambu-send.js, bambu-ftps.js): the upload over FTPS,
// the plates a sliced project can print, the AMS mapping and the print command.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { zipSync, strToU8 } = require('fflate');
// The end-to-end checks' fake printer (a path, so the server type check leaves that file alone).
const { startFakeFtps } = require(path.join(__dirname, '..', '..', 'tests', 'e2e', 'fake-bambu'));
const { uploadToPrinter } = require('./bambu-ftps');
// Stood in for below (a printer that is followed and connected).
const live = /** @type {any} */ (require('./bambu-live'));
const send = require('./bambu-send');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-send-'));

/** A sliced project: plate 1 with two filaments, plate 2 with one; `gcode` says which plates hold G-code. */
function slicedProject(name, gcode = [1, 2]) {
  const plate = (i, seconds, grams, filaments) =>
    `<plate><metadata key="index" value="${i}"/><metadata key="prediction" value="${seconds}"/><metadata key="weight" value="${grams}"/>` +
    filaments.map((f) => `<filament id="${f.id}" type="${f.type}" color="${f.color}" used_g="${f.g}"/>`).join('') +
    '</plate>';
  const files = {
    '3D/3dmodel.model': strToU8('<model/>'),
    'Metadata/slice_info.config': strToU8(
      `<config>${plate(1, 4520, 23.5, [
        { id: 1, type: 'PLA', color: '#FF0000', g: 20.1 },
        { id: 3, type: 'PETG', color: '#00AE42', g: 3.4 }
      ])}${plate(2, 1800, 9.2, [{ id: 1, type: 'PLA', color: '#FF0000', g: 9.2 }])}</config>`
    )
  };
  for (const i of gcode) files[`Metadata/plate_${i}.gcode`] = strToU8(`; plate ${i}\nG28\n`);
  const file = path.join(dir, name);
  fs.writeFileSync(file, zipSync(files));
  return file;
}

test('uploads a file over FTPS with the access code, to the printer’s own address', async () => {
  const printer = await startFakeFtps({ accessCode: '12345678' });
  try {
    const local = path.join(dir, 'upload.bin');
    fs.writeFileSync(local, Buffer.alloc(300000, 7));
    const result = await uploadToPrinter({
      host: '127.0.0.1',
      port: printer.port,
      accessCode: '12345678',
      localPath: local,
      remoteName: 'Robot Arm.gcode.3mf'
    });
    assert.strictEqual(result.size, 300000);
    assert.strictEqual(printer.files['Robot Arm.gcode.3mf'].length, 300000, 'every byte arrived');
    await assert.rejects(
      uploadToPrinter({ host: '127.0.0.1', port: printer.port, accessCode: 'wrong', localPath: local, remoteName: 'x.gcode.3mf' }),
      /refused the access code/
    );
    await assert.rejects(uploadToPrinter({ host: '127.0.0.1', port: printer.port, accessCode: '12345678', localPath: local, remoteName: '../x' }), /not valid/);
  } finally {
    await printer.close();
  }
  const noCard = await startFakeFtps({ accessCode: '12345678', noCard: true });
  try {
    const local = path.join(dir, 'small.bin');
    fs.writeFileSync(local, 'G28');
    await assert.rejects(
      uploadToPrinter({ host: '127.0.0.1', port: noCard.port, accessCode: '12345678', localPath: local, remoteName: 'a.gcode.3mf' }),
      /microSD card/,
      'a P1 without a card says so'
    );
  } finally {
    await noCard.close();
  }
});

test('a sliced project’s plates: only those with G-code, with time, grams and filaments', async () => {
  const file = slicedProject('Robot Arm.gcode.3mf', [1]);
  const plates = await send.slicedPlates(file);
  assert.deepStrictEqual(plates, [
    {
      index: 1,
      seconds: 4520,
      grams: 23.5,
      filaments: [
        { slot: 1, material: 'PLA', color: '#ff0000', grams: 20.1 },
        { slot: 3, material: 'PETG', color: '#00ae42', grams: 3.4 }
      ]
    }
  ]);
});

test('the sliced files for a model: its own and the ones beside it, named like it first', async () => {
  const sub = fs.mkdtempSync(path.join(dir, 'model-'));
  const model = path.join(sub, 'Gear.3mf');
  fs.writeFileSync(model, zipSync({ '3D/3dmodel.model': strToU8('<model/>') }));
  fs.copyFileSync(slicedProject('a.gcode.3mf'), path.join(sub, 'Other.gcode.3mf'));
  fs.copyFileSync(slicedProject('b.gcode.3mf'), path.join(sub, 'Gear plate.gcode.3mf'));
  fs.writeFileSync(path.join(sub, 'Broken.gcode.3mf'), 'not a zip');
  const files = await send.slicedFilesFor(model);
  assert.deepStrictEqual(
    files.map((f) => f.name),
    ['Gear plate.gcode.3mf', 'Other.gcode.3mf']
  );
  assert.deepStrictEqual(await send.slicedFilesFor(`${model}::inside.stl`), [], 'not for a model inside a ZIP');
});

test('a printer that is busy or offline cannot take a print; errors it shows are a warning', () => {
  assert.deepStrictEqual(send.readiness({ connected: false }), {
    ready: false,
    reason: 'Not connected: check its address, serial number and access code in Printers',
    warning: null
  });
  assert.strictEqual(send.readiness({ connected: true, state: 'paused', errors: [] }).reason, 'Paused');
  assert.deepStrictEqual(send.readiness({ connected: true, state: 'finished', errors: [{ text: 'The AMS is humid' }] }), {
    ready: true,
    reason: null,
    warning: 'The printer shows: The AMS is humid'
  });
});

test('the file’s address for the printer: /mnt/sdcard on an X1, the microSD card on a P1 or A1', () => {
  assert.strictEqual(send.printerFileUrl('X1 Carbon', 'a.gcode.3mf'), 'file:///mnt/sdcard/a.gcode.3mf');
  assert.strictEqual(send.printerFileUrl('P1S', 'a.gcode.3mf'), 'file:///sdcard/a.gcode.3mf');
  assert.strictEqual(send.printerFileUrl('A1 mini', 'a.gcode.3mf'), 'file:///sdcard/a.gcode.3mf');
  assert.strictEqual(send.printerFileUrl(null, 'a.gcode.3mf'), 'file:///sdcard/a.gcode.3mf');
});

test('AMS mapping: one entry per filament slot, the chosen tray, -1 for slots the plate does not use', () => {
  const plate = { filaments: [{ slot: 1 }, { slot: 3 }] };
  assert.deepStrictEqual(send.amsMappingFor(plate, { 1: 2, 3: 254 }), [2, -1, 254]);
  assert.deepStrictEqual(send.amsMappingFor(plate, undefined), [0, -1, 2], 'by default each filament prints from the slot of its number');
});

test('a printer must be idle; the print goes up, then the print command names the plate and trays', async () => {
  const db = new Database(':memory:');
  db.exec(
    "CREATE TABLE printers (id INTEGER PRIMARY KEY, nickname TEXT, model TEXT, connection_type TEXT); INSERT INTO printers VALUES (1, 'X1C', 'X1 Carbon', 'bambu'), (2, 'Ender', NULL, NULL);"
  );
  const ftps = await startFakeFtps({ accessCode: 'CODE1234' });
  process.env.JUSTTPRINT_BAMBU_FTPS_PORT = String(ftps.port);
  const sent = [];
  let state = 'printing';
  const original = { target: live.target, command: live.command };
  live.target = (id) =>
    id === 1
      ? {
          host: '127.0.0.1',
          serial: 'SERIAL1',
          secret: 'CODE1234',
          summary: { connected: true, state, errors: [], ams: [{ id: 0, trays: [] }], external: null }
        }
      : null;
  live.command = (id, payload) => {
    sent.push({ id, payload });
    return true;
  };
  try {
    const file = slicedProject('Robot Arm (v2)!.gcode.3mf');
    await assert.rejects(send.sendPrint(db, { printerId: 1, filePath: file, plate: 1 }), /cannot take a print now: Printing/);
    await assert.rejects(send.sendPrint(db, { printerId: 2, filePath: file, plate: 1 }), /Choose a Bambu Lab printer/);
    state = 'idle';
    await assert.rejects(send.sendPrint(db, { printerId: 1, filePath: file, plate: 7 }), /no sliced plate 7/);
    const result = await send.sendPrint(db, { printerId: 1, filePath: file, plate: 1, trays: { 1: 1, 3: 254 }, title: 'Robot Arm' });
    assert.deepStrictEqual(result, { printer: 'X1C', file: 'Robot Arm (v2)_.gcode.3mf', plate: 1 });
    assert.ok(ftps.files['Robot Arm (v2)_.gcode.3mf'], 'uploaded under a name the printer takes');
    assert.strictEqual(sent.length, 1);
    const print = sent[0].payload.print;
    assert.strictEqual(print.command, 'project_file');
    assert.strictEqual(print.param, 'Metadata/plate_1.gcode');
    assert.strictEqual(print.url, 'file:///mnt/sdcard/Robot Arm (v2)_.gcode.3mf', 'an X1 finds it under /mnt/sdcard');
    assert.strictEqual(print.bed_levelling, true, 'both spellings');
    assert.strictEqual(print.subtask_name, 'Robot Arm');
    assert.strictEqual(print.use_ams, true);
    assert.deepStrictEqual(print.ams_mapping, [1, -1, 254]);
    assert.strictEqual(print.bed_leveling, true);
    assert.match(print.md5, /^[0-9A-F]{32}$/);
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
  fs.rmSync(dir, { recursive: true, force: true });
})();
