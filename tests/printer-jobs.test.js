#!/usr/bin/env node
'use strict';

// Bambu printers' prints (src/server/printer-jobs.js), camera (bambu-camera.js), errors
// (bambu-hms.js) and maintenance by print hours (printer-manager.js): a print that finishes is
// logged once on its model with its plate, time, spools and a camera picture; alerts go out.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-printer-jobs-')));
process.env.JUSTTPRINT_DB_PATH = path.join(tmp, 'justtprint.db');
process.env.JUSTTPRINT_USER_DATA = tmp;
const database = require('../src/core/database');
const { initializeDatabase } = require('../src/core/db-init');
const printerManager = require('../src/core/printer-manager');
const spools = require('../src/core/spools');
const ams = require('../src/core/printer-ams');
const { replacePlateFilaments } = require('../src/core/plate-filaments');
const { createJobs, plateOf } = require('../src/server/printer-jobs');
const camera = require('../src/server/bambu-camera');
const hms = require('../src/server/bambu-hms');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const quiet = console.log;
console.log = () => {};
try {
  initializeDatabase();
} finally {
  console.log = quiet;
}
const db = database.db;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

/** A printer, a model named Benchy with plate 2 needing 12 g of blue PLA, and that spool loaded. */
function setup(name, autoLog = true) {
  const printer = printerManager.savePrinter(db, { nickname: name, connectionType: 'bambu', serialNumber: `SN${name}`, autoLog });
  const modelId = Number(
    db
      .prepare("INSERT INTO models (filePath, fileName, print_status, dateAdded) VALUES (?, ?, 'unprinted', '2026-01-01')")
      .run(`/lib/${name}/Benchy.3mf`, 'Benchy.3mf').lastInsertRowid
  );
  replacePlateFilaments(db, modelId, '3mf', [{ plate: 2, slot: 1, material: 'PLA', color: '#2060d0', grams: 12 }]);
  const blue = spools.saveSpool(db, { material: 'PLA', color_hex: '#2060d0', initial_weight: 1000 });
  const unit = ams.addAmsUnit(db, printer.id);
  const slot = db.prepare('SELECT id FROM printer_ams_slots WHERE unit_id = ? AND slot_index = 0').get(unit);
  ams.loadSpool(db, { slotId: slot.id }, blue.id);
  return { printer, modelId, blue, filePath: `/lib/${name}/Benchy.3mf` };
}

/** The jobs watcher with a clock, and what it alerts. */
function watcher(snapshot = async () => JPEG) {
  let clock = Date.UTC(2026, 10, 3, 10, 0, 0);
  const alerts = [];
  const jobs = createJobs({ db: () => db, now: () => clock, log: () => {}, alert: async (kind, a) => alerts.push({ kind, ...a }), snapshot });
  return { jobs, alerts, tick: (ms) => (clock += ms) };
}

/** Feed reports: each is [state, print fields]. */
async function run(jobs, entry, steps) {
  for (const [state, print] of steps) {
    entry.print = { ...(entry.print || {}), ...print };
    const before = entry.lastState ?? null;
    entry.lastState = state;
    jobs.observe(entry, before, { state, progress: print.mc_percent ?? null, errors: print.errors || [] });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const printing = { gcode_state: 'RUNNING', subtask_name: 'Benchy', gcode_file: '/data/Metadata/plate_2.gcode', task_id: '77', subtask_id: '78' };

test('the plate comes from the G-code file name', () => {
  assert.strictEqual(plateOf({ gcode_file: '/data/Metadata/plate_3.gcode' }), 3);
  assert.strictEqual(plateOf({ gcode_file: 'Benchy.gcode' }), null);
});

test('a finished print is logged once: model, plate, time, printer, the spool loaded and its grams, a camera picture', async () => {
  const { printer, modelId, blue, filePath } = setup('A');
  const { jobs, alerts, tick } = watcher();
  const entry = { printerId: printer.id, model: { filePath, title: 'Benchy' } };
  await run(jobs, entry, [
    ['idle', { gcode_state: 'IDLE' }],
    ['printing', { ...printing, mc_percent: 0 }]
  ]);
  tick(95 * 60 * 1000);
  await run(jobs, entry, [
    ['printing', { mc_percent: 100 }],
    ['finished', { gcode_state: 'FINISH' }]
  ]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const events = db.prepare('SELECT * FROM print_events WHERE model_id = ?').all(modelId);
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual([events[0].outcome, events[0].printer_id, events[0].plate_index, events[0].duration_seconds], ['printed', printer.id, 2, 95 * 60]);
  assert.deepStrictEqual(db.prepare('SELECT spool_id, grams FROM print_event_spools WHERE event_id = ?').all(events[0].id), [{ spool_id: blue.id, grams: 12 }]);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM print_event_photos WHERE event_id = ?').get(events[0].id).n, 1, 'the camera picture');
  assert.deepStrictEqual(
    alerts.map((a) => [a.kind, a.title]),
    [['printFinished', 'A: Benchy finished']]
  );
  assert.match(alerts[0].body, /after 1 h 35 min.*Logged in the print history/);
  // The same print again (a reconnect, a restart): not logged twice.
  const again = watcher().jobs;
  await run(again, { printerId: printer.id, model: entry.model, lastState: null }, [
    ['printing', printing],
    ['finished', { gcode_state: 'FINISH' }]
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM print_events WHERE model_id = ?').get(modelId).n, 1);
});

test('a failed print counts the part it got through; a cancelled one is logged without an alert', async () => {
  const { printer, modelId, filePath } = setup('B');
  const { jobs, alerts } = watcher(async () => null);
  const entry = { printerId: printer.id, model: { filePath, title: 'Benchy' } };
  await run(jobs, entry, [
    ['idle', { gcode_state: 'IDLE' }],
    ['printing', { ...printing, task_id: '1', mc_percent: 50 }],
    ['failed', { gcode_state: 'FAILED', print_error: 0x07008011 }]
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const failed = db.prepare("SELECT * FROM print_events WHERE model_id = ? AND outcome = 'failed'").get(modelId);
  assert.ok(failed, 'logged as failed');
  assert.strictEqual(db.prepare('SELECT grams FROM print_event_spools WHERE event_id = ?').get(failed.id).grams, 6, 'half of 12 g');
  assert.deepStrictEqual(
    alerts.map((a) => a.kind),
    ['printFailed']
  );
  await run(jobs, entry, [
    ['idle', { gcode_state: 'IDLE', print_error: 0 }],
    ['printing', { ...printing, task_id: '2', mc_percent: 10 }],
    ['failed', { gcode_state: 'FAILED', print_error: 0x0300400c }]
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(db.prepare("SELECT 1 FROM print_events WHERE model_id = ? AND outcome = 'cancelled'").get(modelId), 'logged as cancelled');
  assert.deepStrictEqual(
    alerts.map((a) => a.kind),
    ['printFailed'],
    'no alert for a print you cancelled'
  );
});

test('a pause alerts with what the printer says; a print with no library model, or with logging off, only alerts', async () => {
  const { printer } = setup('C');
  const { jobs, alerts } = watcher();
  const entry = { printerId: printer.id, model: null };
  await run(jobs, entry, [
    ['idle', { gcode_state: 'IDLE' }],
    ['printing', { ...printing, subtask_name: 'Unknown thing', task_id: '9' }],
    ['paused', { gcode_state: 'PAUSE', errors: [{ code: '0700_2000_0002_0001', text: 'AMS A filament ran out.' }] }],
    ['printing', { gcode_state: 'RUNNING' }],
    ['finished', { gcode_state: 'FINISH' }]
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepStrictEqual(
    alerts.map((a) => a.kind),
    ['printPaused', 'printFinished']
  );
  assert.match(alerts[0].body, /AMS A filament ran out/);
  assert.match(alerts[1].body, /Not logged: no model in your library is named Unknown thing/);

  const off = setup('D', false);
  const second = watcher();
  await run(second.jobs, { printerId: off.printer.id, model: { filePath: off.filePath, title: 'Benchy' } }, [
    ['idle', { gcode_state: 'IDLE' }],
    ['printing', printing],
    ['finished', { gcode_state: 'FINISH' }]
  ]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM print_events WHERE model_id = ?').get(off.modelId).n, 0, 'logging off');
  assert.deepStrictEqual(
    second.alerts.map((a) => a.kind),
    ['printFinished']
  );
  assert.strictEqual(printerManager.getPrinterById(db, off.printer.id).auto_log, 0);
});

test('maintenance every so many print hours: due once the printer has printed that long, again after Done', () => {
  const printer = printerManager.savePrinter(db, { nickname: 'E' });
  const modelId = Number(
    db.prepare("INSERT INTO models (filePath, fileName, print_status, dateAdded) VALUES ('/lib/E.3mf', 'E.3mf', 'unprinted', '2026-01-01')").run()
      .lastInsertRowid
  );
  const reminder = printerManager.savePrinterReminder(db, { printerId: printer.id, title: 'Lubricate rods', intervalHours: 10 });
  assert.deepStrictEqual([reminder.interval_hours, reminder.hours_now, reminder.hours_due], [10, 0, 10]);
  const due = () => Number(printerManager.getAllPrinters(db).find((p) => p.id === printer.id).due_reminders_count);
  assert.strictEqual(due(), 0, 'no date to be due by');
  const log = (hours) =>
    require('../src/core/print-events').logPrintEvent(db, { modelId, outcome: 'printed', printerId: printer.id, durationSeconds: hours * 3600 });
  log(6);
  assert.strictEqual(due(), 0);
  log(4);
  assert.strictEqual(due(), 1, 'due after 10 print hours');
  assert.strictEqual(printerManager.getAllPrinters(db).find((p) => p.id === printer.id).print_hours, 10);
  const done = printerManager.completePrinterReminder(db, reminder.id, '');
  assert.strictEqual(done.status, 'pending');
  assert.strictEqual(printerManager.getPrinterReminders(db, printer.id)[0].hours_due, 20, 'next due 10 hours on');
  assert.strictEqual(due(), 0);
});

test("errors: HMS and print error codes, and their texts from Bambu's list", () => {
  assert.strictEqual(hms.hmsCode(0x07002000, 0x00020001), '0700_2000_0002_0001');
  assert.strictEqual(hms.printErrorCode(0x0300400c), '0300_400C');
  assert.strictEqual(hms.printErrorCode(0), null);
  const texts = hms.textsFrom({
    data: {
      device_hms: { en: [{ ecode: '0700200000020001', intro: 'AMS A slot 1 filament has run out.' }] },
      device_error: { en: [{ ecode: '0300400C', intro: 'The task was canceled.' }] }
    }
  });
  assert.strictEqual(texts.get('0700200000020001'), 'AMS A slot 1 filament has run out.');
  hms.setTexts(texts);
  assert.deepStrictEqual(hms.errorsOf({ print_error: 0x0300400c, hms: [{ attr: 0x07002000, code: 0x00020001 }] }), [
    { code: '0300_400C', text: 'The task was canceled.', url: hms.lookUpUrl('0300_400C') },
    { code: '0700_2000_0002_0001', text: 'AMS A slot 1 filament has run out.', url: hms.lookUpUrl('0700_2000_0002_0001') }
  ]);
});

test('camera: signs in with bblp and the access code, reads pictures in pieces, and closes when no one looks', async () => {
  let auth = null;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('data', (chunk) => {
      auth = chunk;
      const header = Buffer.alloc(16);
      header.writeUInt32LE(JPEG.length, 0);
      const frame = Buffer.concat([header, JPEG]);
      socket.write(frame.subarray(0, 5));
      setTimeout(() => socket.write(frame.subarray(5)), 10);
    });
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cams = camera.createCameras({
    config: (id) => (id === 1 ? { host: '127.0.0.1', secret: '12345678' } : null),
    port: server.address().port,
    secure: false,
    log: () => {}
  });
  try {
    assert.strictEqual(await cams.frame(2), null, 'no camera for a printer not followed');
    const picture = await cams.frame(1, { waitMs: 3000 });
    assert.ok(picture && picture.jpeg && picture.jpeg.equals(JPEG), 'the picture');
    assert.deepStrictEqual([auth.length, auth.readUInt32LE(0), auth.readUInt32LE(4)], [80, 0x40, 0x3000]);
    assert.strictEqual(auth.subarray(16, 20).toString(), 'bblp');
    assert.strictEqual(auth.subarray(48, 56).toString(), '12345678');
  } finally {
    cams.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepStrictEqual(camera.readFrames(Buffer.from([1, 0, 0])).frames, [], 'a part of a header waits');
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
  database.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
})();
