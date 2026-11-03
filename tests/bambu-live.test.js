#!/usr/bin/env node
'use strict';

// Bambu Lab live status (src/server/bambu-live.js, src/server/mqtt-client.js): a fake printer
// speaks MQTT, JusttPrint reads its state, progress and AMS trays, keeps the slots in line with
// them (src/core/printer-ams.js syncFromPrinter) and sends nothing but "pushall".

const assert = require('assert');
const net = require('net');
const Database = require('better-sqlite3');
const { ensureFilamentSchema } = require('../src/core/filament-schema');
const printerManager = require('../src/core/printer-manager');
const ams = require('../src/core/printer-ams');
const spools = require('../src/core/spools');
const mqtt = require('../src/server/mqtt-client');
const live = require('../src/server/bambu-live');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const fresh = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(
    'CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, filePath TEXT, fileName TEXT, title TEXT, print_status TEXT, dateAdded TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'
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

const tray = (id, type, color, extra = {}) => ({
  id: String(id),
  tray_type: type,
  tray_color: color,
  tray_uuid: '00000000000000000000000000000000',
  remain: -1,
  ...extra
});

/** A fake printer: answers CONNECT (access code `code`), takes SUBSCRIBE, and records what it is sent. */
/** `serial`: like a real printer, hang up on a subscription to another printer's topic. */
function fakePrinter(code, serial = null) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const read = mqtt.readPackets(buffer);
      buffer = Buffer.from(read.rest);
      for (const { type, body } of read.packets) {
        if (type === mqtt.CONNECT) {
          // username and password are the last two strings
          let at = 10;
          const strings = [];
          while (at < body.length) {
            const length = body.readUInt16BE(at);
            strings.push(body.subarray(at + 2, at + 2 + length).toString());
            at += 2 + length;
          }
          const [, username, password] = strings;
          received.push({ type: 'connect', username, password });
          socket.write(mqtt.packet(mqtt.CONNACK, 0, Buffer.from([0, password === code ? 0 : 5])));
        } else if (type === mqtt.SUBSCRIBE) {
          const length = body.readUInt16BE(2);
          const topic = body.subarray(4, 4 + length).toString();
          received.push({ type: 'subscribe', topic });
          if (serial && topic !== `device/${serial}/report`) {
            socket.destroy();
            continue;
          }
          socket.write(mqtt.packet(mqtt.SUBACK, 0, Buffer.concat([body.subarray(0, 2), Buffer.from([0])])));
        } else if (type === mqtt.PUBLISH) {
          const length = body.readUInt16BE(0);
          received.push({ type: 'publish', topic: body.subarray(2, 2 + length).toString(), payload: JSON.parse(body.subarray(2 + length).toString()) });
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        received,
        send(topic, message) {
          const payload = mqtt.packet(mqtt.PUBLISH, 0, Buffer.concat([mqtt.text(topic), Buffer.from(JSON.stringify(message))]));
          // In two pieces, as TCP may cut it.
          for (const socket of sockets) {
            socket.write(payload.subarray(0, 7));
            socket.write(payload.subarray(7));
          }
        },
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(done);
          })
      })
    )
  );
}

const until = async (check, what) => {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('addresses: a host, a host and port, or a link', () => {
  assert.deepStrictEqual(live.parseAddress('192.168.1.40'), { host: '192.168.1.40', port: 8883 });
  assert.deepStrictEqual(live.parseAddress(' 192.168.1.40:1883 '), { host: '192.168.1.40', port: 1883 });
  assert.deepStrictEqual(live.parseAddress('mqtts://p1s.lan/'), { host: 'p1s.lan', port: 8883 });
  assert.deepStrictEqual(live.parseAddress('[fe80::1]:8883'), { host: 'fe80::1', port: 8883 });
  assert.strictEqual(live.parseAddress(''), null);
});

test('reports: changes merge into what the printer said before, AMS units and trays by id', () => {
  let state = live.merge(
    {},
    { gcode_state: 'RUNNING', mc_percent: 10, ams: { ams: [{ id: '0', tray: [tray(0, 'PLA', 'FF0000FF'), tray(1, 'PETG', '00FF00FF')] }] } }
  );
  state = live.merge(state, { mc_percent: 42, ams: { ams: [{ id: '0', tray: [{ id: '1', remain: 80 }] }] } });
  assert.strictEqual(state.gcode_state, 'RUNNING');
  assert.strictEqual(state.mc_percent, 42);
  assert.strictEqual(state.ams.ams[0].tray[0].tray_type, 'PLA');
  assert.deepStrictEqual([state.ams.ams[0].tray[1].tray_type, state.ams.ams[0].tray[1].remain], ['PETG', 80]);
});

test('the AMS as printer-ams.js takes it: empty trays, colors, RFID, humidity in percent only', () => {
  const report = live.amsFromReport({
    ams: {
      tray_exist_bits: '5', // slots 1 and 3 of the first unit
      ams: [
        {
          id: '0',
          humidity: '4',
          humidity_raw: '23',
          tray: [tray(0, 'PLA', '2F6FDFFF', { tray_uuid: 'ABC123' }), tray(1, '', ''), tray(2, '', ''), tray(3, '', '')]
        }
      ]
    },
    vt_tray: { id: '254', tray_type: 'TPU', tray_color: '000000FF' }
  });
  assert.strictEqual(report.units.length, 1);
  assert.strictEqual(report.units[0].humidity, 23);
  assert.deepStrictEqual(report.units[0].trays, [{ type: 'PLA', color: '#2f6fdf', uuid: 'ABC123' }, null, { type: null, color: null, uuid: null }, null]);
  assert.deepStrictEqual(report.external, { type: 'TPU', color: '#000000', uuid: null });
  assert.strictEqual(live.amsFromReport({ ams: { ams: [{ id: '0', humidity: '4', tray: [] }] } }).units[0].humidity, null, 'a level (1–5) is not a percentage');
  assert.strictEqual(live.amsFromReport({}).external, undefined, 'the holder is left as it is when the printer does not say');
});

test('what browsers see: state, job, progress, time left, layer, feeding tray; nothing of the access code', () => {
  const summary = live.summarize({
    printerId: 3,
    connected: true,
    error: null,
    updatedAt: 'now',
    model: null,
    print: {
      gcode_state: 'RUNNING',
      subtask_name: 'Benchy',
      mc_percent: 37,
      mc_remaining_time: 52,
      layer_num: 40,
      total_layer_num: 120,
      nozzle_temper: 219.5,
      bed_temper: 55,
      ams: { tray_now: '5', ams: [] }
    }
  });
  assert.deepStrictEqual(
    [summary.state, summary.job, summary.progress, summary.remainingMinutes, summary.layer, summary.totalLayers, summary.nozzle, summary.feeding],
    ['printing', 'Benchy', 37, 52, 40, 120, 219.5, 'B2']
  );
  const idle = live.summarize({
    printerId: 3,
    connected: true,
    error: null,
    updatedAt: null,
    model: null,
    print: { gcode_state: 'IDLE', subtask_name: 'Old', mc_percent: 100 }
  });
  assert.deepStrictEqual([idle.state, idle.job, idle.progress], ['idle', null, null]);
  assert.strictEqual(
    live.summarize({ printerId: 3, connected: false, error: 'wrong access code', updatedAt: null, model: null, print: null }).state,
    'offline'
  );
});

test('slots follow the trays: a spool that fits is loaded, a pulled tray is emptied, a spool loaded by hand stays', () => {
  const db = fresh();
  const printer = printerManager.savePrinter(db, { nickname: 'P1S', connectionType: 'bambu' });
  ams.addAmsUnit(db, printer.id, { slots: 4 }); // as Import from Bambu Lab makes it
  const blue = spools.saveSpool(db, { material: 'PLA', color_hex: '#3070e0', initial_weight: 1000 });
  const red = spools.saveSpool(db, { material: 'PETG', color_hex: '#d02020', initial_weight: 1000 });
  const mine = spools.saveSpool(db, { material: 'ABS', color_hex: '#ffffff', initial_weight: 1000 });
  const slots = () => ams.getPrinterLoads(db, printer.id)[0].units[0].slots.map((slot) => (slot.spool ? slot.spool.id : null));
  const slotId = (index) => ams.getPrinterLoads(db, printer.id)[0].units[0].slots[index].id;
  // By hand before the printer was connected: C1… no, slot 3 holds mine.
  ams.loadSpool(db, { slotId: slotId(2) }, mine.id);
  const report = (trays, external) => ({ units: [{ id: 0, humidity: 30, trays }], external });
  const T = (type, color, uuid = null) => ({ type, color, uuid });

  assert.strictEqual(ams.syncFromPrinter(db, printer.id, report([T('PLA', '#2f6fdf'), null, T('PLA', '#00ff00'), null])), true);
  assert.deepStrictEqual(slots(), [blue.id, null, mine.id, null], 'blue PLA fits A1; C… slot 3 keeps the spool loaded by hand the first time');
  assert.strictEqual(ams.getPrinterLoads(db, printer.id)[0].units.length, 1, 'the unit made by the import is this AMS');
  assert.strictEqual(ams.getPrinterLoads(db, printer.id)[0].units[0].humidity, 30);
  assert.strictEqual(ams.syncFromPrinter(db, printer.id, report([T('PLA', '#2f6fdf'), null, T('PLA', '#00ff00'), null])), false, 'nothing new, nothing done');

  // Mine is replaced by something else (a red PETG) in slot 3, A1 is pulled.
  assert.strictEqual(ams.syncFromPrinter(db, printer.id, report([null, null, T('PETG', '#cc2222'), null])), true);
  assert.deepStrictEqual(slots(), [null, null, red.id, null]);
  assert.strictEqual(spools.getSpool(db, blue.id).status, 'active', 'a spool taken out stays on the Filament page');

  // Something with no spool that fits: the slot is left empty, not filled with a wrong spool.
  ams.syncFromPrinter(db, printer.id, report([T('PA-CF', '#222222'), null, T('PETG', '#cc2222'), null]));
  assert.deepStrictEqual(slots(), [null, null, red.id, null]);
  // Loading one by hand there stays, and is found again by its tray afterwards.
  ams.loadSpool(db, { slotId: slotId(0) }, mine.id);
  ams.syncFromPrinter(db, printer.id, report([T('PA-CF', '#222222'), null, T('PETG', '#cc2222'), null]));
  assert.deepStrictEqual(slots(), [mine.id, null, red.id, null]);
});

test('a Bambu spool is found by its RFID, wherever it goes', () => {
  const db = fresh();
  const printer = printerManager.savePrinter(db, { nickname: 'X1C', connectionType: 'bambu' });
  const a = spools.saveSpool(db, { material: 'PLA', color_hex: '#ffffff', initial_weight: 1000 });
  const b = spools.saveSpool(db, { material: 'PLA', color_hex: '#ffffff', initial_weight: 1000 });
  const report = (trays) => ({ units: [{ id: 0, humidity: null, trays }] });
  const T = (uuid) => ({ type: 'PLA', color: '#ffffff', uuid });
  ams.syncFromPrinter(db, printer.id, report([T('RFID-1'), null, null, null]));
  const first = ams.getPrinterLoads(db, printer.id)[0].units[0].slots[0].spool.id;
  // Moved to slot 4, with the other white PLA in slot 1: each is the same spool as before.
  ams.syncFromPrinter(db, printer.id, report([T('RFID-2'), null, null, T('RFID-1')]));
  const now = ams.getPrinterLoads(db, printer.id)[0].units[0].slots.map((slot) => (slot.spool ? slot.spool.id : null));
  assert.strictEqual(now[3], first, 'RFID-1 followed its spool');
  assert.strictEqual(now[0], first === a.id ? b.id : a.id);
  assert.ok(ams.getPrinterLoads(db, printer.id)[0].units[0].name, 'a unit made from the report has a name');
});

test('a second AMS and the holder; an AMS HT gets a unit of its own', () => {
  const db = fresh();
  const printer = printerManager.savePrinter(db, { nickname: 'H2D', connectionType: 'bambu' });
  const tpu = spools.saveSpool(db, { material: 'TPU', color_hex: '#101010', initial_weight: 1000 });
  ams.syncFromPrinter(db, printer.id, {
    units: [
      { id: 0, humidity: null, trays: [null, null, null, null] },
      { id: 1, humidity: null, trays: [null, null, null, null] },
      { id: 128, name: 'AMS HT 1', humidity: 12, trays: [null] }
    ],
    external: { type: 'TPU', color: '#000000', uuid: null }
  });
  const loads = ams.getPrinterLoads(db, printer.id)[0];
  assert.deepStrictEqual(
    loads.units.map((unit) => [unit.slots[0].label, unit.slots.length]),
    [
      ['A1', 4],
      ['B1', 4],
      ['C1', 1]
    ]
  );
  assert.strictEqual(loads.direct.id, tpu.id, 'the TPU on the holder');
});

test('live: connects with bblp and the access code, asks for everything, follows the printer, and sends nothing else', async () => {
  const db = fresh();
  const printer = await fakePrinter('12345678');
  const saved = printerManager.savePrinter(db, {
    nickname: 'P1S',
    connectionType: 'bambu',
    serialNumber: '01P00A123',
    apiUrl: `127.0.0.1:${printer.port}`,
    apiSecret: '12345678'
  });
  ams.addAmsUnit(db, saved.id, { slots: 4 });
  const blue = spools.saveSpool(db, { material: 'PLA', color_hex: '#3070e0', initial_weight: 1000 });
  db.prepare("INSERT INTO models (filePath, fileName, title) VALUES ('/lib/Benchy/Benchy.3mf', 'Benchy.3mf', 'Benchy')").run();
  const events = [];
  const following = live.createLive({ db: () => db, secure: false, broadcast: (channel, data) => events.push([channel, data]), log: () => {} });
  try {
    following.refresh();
    await until(() => printer.received.some((m) => m.type === 'publish'), 'pushall');
    assert.deepStrictEqual(printer.received[0], { type: 'connect', username: 'bblp', password: '12345678' });
    assert.deepStrictEqual(printer.received[1], { type: 'subscribe', topic: 'device/01P00A123/report' });
    assert.deepStrictEqual(printer.received[2], {
      type: 'publish',
      topic: 'device/01P00A123/request',
      payload: { pushing: { sequence_id: '0', command: 'pushall', version: 1, push_target: 1 } }
    });

    printer.send('device/01P00A123/report', {
      print: {
        gcode_state: 'RUNNING',
        subtask_name: 'Benchy',
        mc_percent: 12,
        mc_remaining_time: 80,
        ams: {
          tray_now: '0',
          tray_exist_bits: '1',
          ams: [{ id: '0', humidity_raw: '28', tray: [tray(0, 'PLA', '2F6FDFFF', { remain: 64 }), tray(1, '', ''), tray(2, '', ''), tray(3, '', '')] }]
        }
      }
    });
    printer.send('device/OTHER/report', { print: { gcode_state: 'FAILED' } });
    printer.send('device/01P00A123/report', { print: { mc_percent: 13 } });
    const status = await until(() => following.list().find((p) => p.progress === 13), 'the second report');
    assert.deepStrictEqual([status.state, status.job, status.remainingMinutes, status.feeding], ['printing', 'Benchy', 80, 'A1']);
    assert.deepStrictEqual(status.model, { filePath: '/lib/Benchy/Benchy.3mf', title: 'Benchy' }, 'the library model of the job');
    assert.deepStrictEqual(status.ams[0].trays[0], { type: 'PLA', name: 'PLA', color: '#2f6fdf', remain: 64 });
    assert.ok(!JSON.stringify(following.list()).includes('12345678'), 'the access code is not in what browsers see');
    assert.strictEqual(ams.getPrinterLoads(db, saved.id)[0].units[0].slots[0].spool.id, blue.id, 'the slot follows the tray');
    assert.strictEqual(db.prepare('SELECT status FROM printers WHERE id = ?').get(saved.id).status, 'printing');
    await until(() => events.some(([channel]) => channel === 'printer-live'), 'the broadcast');
    assert.ok(
      events.some(([channel]) => channel === 'filament-check-changed'),
      'browsers reload what is loaded'
    );
    assert.deepStrictEqual(
      printer.received.filter((m) => m.type === 'publish').map((m) => Object.keys(m.payload.pushing || {}).includes('command') && m.payload.pushing.command),
      ['pushall'],
      'nothing but pushall is ever sent'
    );

    // The printer goes away: offline, and it tries again.
    await printer.close();
    await until(() => following.list()[0].state === 'offline', 'offline');
    assert.strictEqual(db.prepare('SELECT status FROM printers WHERE id = ?').get(saved.id).status, 'offline');
  } finally {
    following.stop();
    await printer.close().catch(() => {});
  }
});

test('live: a wrong access code says so; a printer without one is not followed', async () => {
  const db = fresh();
  const printer = await fakePrinter('right');
  printerManager.savePrinter(db, {
    nickname: 'A1',
    connectionType: 'bambu',
    serialNumber: 'A1SERIAL',
    apiUrl: `127.0.0.1:${printer.port}`,
    apiSecret: 'wrong'
  });
  printerManager.savePrinter(db, { nickname: 'No code', connectionType: 'bambu', serialNumber: 'NOCODE', apiUrl: '127.0.0.1:1' });
  printerManager.savePrinter(db, { nickname: 'Prusa', connectionType: 'manual', serialNumber: 'X', apiUrl: '127.0.0.1:1', apiSecret: 'x' });
  const following = live.createLive({ db: () => db, secure: false, log: () => {} });
  try {
    following.refresh();
    const status = await until(() => following.list().find((p) => p.error), 'the refusal');
    assert.strictEqual(following.list().length, 1);
    assert.strictEqual(status.error, 'wrong access code');
    assert.strictEqual(status.state, 'offline');
  } finally {
    following.stop();
    await printer.close();
  }
});

test('a serial number typed in lowercase still works: Bambu serials are capitals', async () => {
  const db = fresh();
  const printer = await fakePrinter('code', '01P00A123');
  const saved = printerManager.savePrinter(db, {
    nickname: 'P1S',
    connectionType: 'bambu',
    serialNumber: '01p00a123',
    apiUrl: `127.0.0.1:${printer.port}`,
    apiSecret: 'code'
  });
  assert.strictEqual(db.prepare('SELECT serial_number FROM printers WHERE id = ?').get(saved.id).serial_number, '01P00A123', 'saved in capitals');
  // One saved before 10.7.1, in lowercase: followed in capitals all the same.
  db.prepare("UPDATE printers SET serial_number = '01p00a123' WHERE id = ?").run(saved.id);
  const following = live.createLive({ db: () => db, secure: false, log: () => {} });
  try {
    following.refresh();
    await until(() => printer.received.some((m) => m.type === 'publish'), 'pushall');
    assert.strictEqual(printer.received.find((m) => m.type === 'subscribe').topic, 'device/01P00A123/report');
    assert.strictEqual(following.list()[0].connected, true);
  } finally {
    following.stop();
    await printer.close();
  }
});

test('a printer that hangs up right after signing in points at the serial number', async () => {
  const db = fresh();
  const printer = await fakePrinter('code', 'SOMEOTHER1');
  printerManager.savePrinter(db, {
    nickname: 'P1S',
    connectionType: 'bambu',
    serialNumber: '01P00A123',
    apiUrl: `127.0.0.1:${printer.port}`,
    apiSecret: 'code'
  });
  const following = live.createLive({ db: () => db, secure: false, log: () => {} });
  try {
    following.refresh();
    const status = await until(() => following.list().find((p) => p.error), 'the hang-up');
    assert.match(status.error, /serial number/);
  } finally {
    following.stop();
    await printer.close();
  }
});

test('Import from Bambu Lab keeps the access code for live status, and never sends it to browsers', () => {
  const db = fresh();
  const bambu = require('../src/server/bambu-devices');
  const devices = [{ serial: 'S1', name: 'P1S', product: 'P1S', model: 'C12', online: true, nozzle: 0.4, accessCode: '87654321' }];
  bambu.importDevices(db, devices);
  const row = db.prepare('SELECT id, api_secret FROM printers WHERE serial_number = ?').get('S1');
  assert.strictEqual(row.api_secret, '87654321');
  db.prepare('UPDATE printers SET api_secret = ? WHERE id = ?').run('typed', row.id);
  bambu.importDevices(db, [{ ...devices[0], accessCode: 'other' }]);
  assert.strictEqual(db.prepare('SELECT api_secret FROM printers WHERE id = ?').get(row.id).api_secret, 'typed', 'one typed in stays');
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
