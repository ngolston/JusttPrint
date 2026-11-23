#!/usr/bin/env node
'use strict';

// The routes the OrcaSlicer plugin calls (orca-plugin.js): search, open links, the filament check,
// sliced files into the Sliced inbox (filed by name, or with the model the plugin opened), roles,
// and the plugin download.

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { zipSync, strToU8 } = require('fflate');
const database = require('../core/database');
const inbox = require('./sliced-inbox');
const { registerOrcaPluginRoutes, needsFrom, plainName } = require('./orca-plugin');
const { _links } = require('./slicer-links');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-orca-'));
const library = path.join(dir, 'library');
const folder = path.join(dir, 'inbox');
for (const sub of ['Gear', 'Benchy', 'Clip']) fs.mkdirSync(path.join(library, sub), { recursive: true });
fs.mkdirSync(folder);

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, filePath TEXT, fileName TEXT, title TEXT, designer TEXT, print_status TEXT,
    print_count INTEGER DEFAULT 0, dateAdded TEXT, thumbnail TEXT, last_printed_at TEXT, printed INTEGER DEFAULT 0,
    favorite INTEGER DEFAULT 0, rating INTEGER DEFAULT 0, notes TEXT);
  CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE model_tags (model_id INTEGER, tag_id INTEGER);
  CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT, keywords TEXT, position INTEGER DEFAULT 0, parent_id INTEGER);
  CREATE TABLE model_categories (model_id INTEGER, category_id INTEGER, source TEXT DEFAULT 'manual');
  CREATE TABLE print_events (id INTEGER PRIMARY KEY, model_id INTEGER, printed_at TEXT, outcome TEXT, quantity INTEGER DEFAULT 1, notes TEXT, created_at TEXT);
`);
const log = console.log;
console.log = () => {};
try {
  require('../core/filament-schema').ensureFilamentSchema(db);
} finally {
  console.log = log;
}
const add = db.prepare('INSERT INTO models (filePath, fileName, title, designer, print_status, dateAdded, thumbnail) VALUES (?, ?, ?, ?, ?, ?, ?)');
const gear = add.run(path.join(library, 'Gear', 'Gear.3mf'), 'Gear.3mf', null, 'Ana', 'unprinted', '2026-01-02', 'data:image/png;base64,AAAA').lastInsertRowid;
const benchy = add.run(path.join(library, 'Benchy', 'benchy.stl'), 'benchy.stl', 'Benchy 100%', null, 'printed', '2026-01-03', null).lastInsertRowid;
add.run('url::https://example.com/thing', 'thing', 'Link only', null, 'unprinted', '2026-01-04', null);
add.run(path.join(library, 'Clip', 'clip pack.zip'), 'clip pack.zip', null, null, 'unprinted', '2026-01-05', null);
const clip = add.run(path.join(library, 'Clip', 'clip_v2.stl'), 'clip_v2.stl', 'Cable Clip', null, 'unprinted', '2026-01-01', null).lastInsertRowid;
fs.writeFileSync(path.join(library, 'Gear', 'Gear.3mf'), 'gear');

db.prepare(
  "INSERT INTO spools (name, material, color_hex, initial_weight, used_weight, status, registered_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)"
).run('White PLA', 'PLA', '#ffffff', 1000, 900, '2026-01-01', '2026-01-01');
db.prepare("INSERT INTO filament_brands (name, created_at, updated_at) VALUES ('Prusament', '2026-01-01', '2026-01-01')").run();
db.prepare(
  "INSERT INTO spools (name, material, color_hex, color_hex_2, brand_id, initial_weight, used_weight, status, registered_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, 'storage', ?, ?)"
).run('Galaxy PETG', 'PETG', '#112233', '#445566', 1000, 50, '2026-01-01', '2026-01-01');
db.prepare(
  "INSERT INTO spools (name, material, color_hex, initial_weight, used_weight, status, registered_at, updated_at) VALUES ('Used up', 'PLA', '#000000', 1000, 1000, 'archived', ?, ?)"
).run('2026-01-01', '2026-01-01');
// Two printers: one with an AMS (White PLA loaded in A1), one Bambu that logs its prints by itself.
const t = '2026-01-01';
const mk3 = db
  .prepare("INSERT INTO printers (nickname, manufacturer, model, created_at, updated_at) VALUES ('MK4', 'Prusa', 'MK4', ?, ?)")
  .run(t, t).lastInsertRowid;
const x1c = db
  .prepare(
    "INSERT INTO printers (nickname, connection_type, serial_number, api_url, api_secret, created_at, updated_at) VALUES ('X1C', 'bambu', '01P00A123', '192.168.1.9', 'code', ?, ?)"
  )
  .run(t, t).lastInsertRowid;
const ams = require('../core/printer-ams');
ams.addAmsUnit(db, Number(mk3));
const slotA1 = db.prepare('SELECT id FROM printer_ams_slots ORDER BY id').get().id;
ams.loadSpool(db, { slotId: slotA1 }, 1);
const spoolLeft = (id) => db.prepare('SELECT initial_weight - used_weight AS g FROM spools WHERE id = ?').get(id).g;
database.db = db;

const sliced = () => Buffer.from(zipSync({ 'Metadata/plate_1.gcode': strToU8('G28\n') }));

async function server() {
  const app = express();
  // Stands in for requireAuth: X-Test-Role picks the caller's role.
  app.use((req, res, next) => {
    req.user = { id: 1, username: 'ace', role: req.get('x-test-role') || 'editor' };
    next();
  });
  const order = ['viewer', 'editor', 'admin'];
  const requireRole = (role) => (req, res, next) =>
    order.indexOf(req.user.role) >= order.indexOf(role) ? next() : res.status(403).json({ error: `${role} or higher` });
  registerOrcaPluginRoutes(app, { requireRole, db: () => db });
  const s = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  return { s, base: `http://127.0.0.1:${s.address().port}` };
}

test('what the plugin sends to check is cleaned up', () => {
  assert.deepStrictEqual(
    needsFrom([
      { material: ' PLA ', color: 'FFFFFF', grams: '12.34', preset: 'Bambu PLA' },
      { color: 'red', grams: -1 }
    ]),
    [
      { slot: 1, material: 'PLA', color: '#ffffff', grams: 12.3, preset: 'Bambu PLA' },
      { slot: 2, material: null, color: null, grams: null, preset: null }
    ]
  );
  assert.throws(() => needsFrom([]), /needs/);
  assert.throws(() => needsFrom(new Array(40).fill({})), /At most/);
  assert.throws(() => plainName('../x.gcode.3mf', /\.gcode\.3mf$/i, 'sliced'), /plain file name/);
  assert.throws(() => plainName('x.gcode', /\.gcode\.3mf$/i, 'a sliced project'), /not a sliced project/);
});

test('the routes', async () => {
  const { s, base } = await server();
  const get = (p, headers = {}) => fetch(base + p, { headers }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const post = (p, body, headers = {}) =>
    fetch(base + p, {
      method: 'POST',
      headers: Buffer.isBuffer(body) ? { 'content-type': 'application/octet-stream', ...headers } : { 'content-type': 'application/json', ...headers },
      body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body)
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    // Hello: who is signed in and what is set up.
    let r = await get('/api/orca/hello');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.username, 'ace');
    assert.strictEqual(r.body.slicedInbox, false);
    assert.ok(r.body.version);
    // The plugin file's own version, so the plugin can say when a newer one is offered; it matches the file's header.
    const pluginSource = fs.readFileSync(path.join(__dirname, '..', '..', 'orca-plugin', 'justtprint.py'), 'utf8');
    assert.match(r.body.pluginVersion, /^\d+\.\d+\.\d+$/);
    assert.ok(pluginSource.includes(`# version = "${r.body.pluginVersion}"`), 'PLUGIN_VERSION and the header version agree');

    // Search: newest first, by name, title or designer; link-only models and archives OrcaSlicer cannot open left out.
    r = await get('/api/orca/models');
    assert.deepStrictEqual(
      r.body.models.map((m) => m.name),
      ['Benchy 100%', 'Gear', 'Cable Clip']
    );
    assert.strictEqual(r.body.models[1].thumbnail, 'data:image/png;base64,AAAA');
    assert.strictEqual(r.body.models[1].fileType, '3mf');
    assert.strictEqual(r.body.total, 3);
    assert.strictEqual(r.body.models[0].printStatus, 'printed');

    // A page at a time, sorted, filtered by print status.
    r = await get('/api/orca/models?limit=2&offset=2');
    assert.deepStrictEqual([r.body.models.map((m) => m.name), r.body.total, r.body.offset], [['Cable Clip'], 3, 2]);
    r = await get('/api/orca/models?sort=name');
    assert.deepStrictEqual(
      r.body.models.map((m) => m.name),
      ['Benchy 100%', 'Cable Clip', 'Gear']
    );
    r = await get('/api/orca/models?status=unprinted&sort=oldest');
    assert.deepStrictEqual(
      r.body.models.map((m) => m.name),
      ['Cable Clip', 'Gear']
    );
    r = await get('/api/orca/models?status=printed');
    assert.deepStrictEqual(
      r.body.models.map((m) => m.id),
      [benchy]
    );

    // One model's details: what the website's Model Details shows, its pictures and print history.
    db.prepare("INSERT INTO print_events (model_id, printed_at, outcome, quantity, notes, created_at) VALUES (?, '2026-02-01', 'printed', 2, 'Nice', ?)").run(
      benchy,
      t
    );
    r = await get(`/api/orca/models/${gear}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(
      [r.body.model.name, r.body.model.designer, r.body.model.fileType, r.body.model.size, r.body.model.pictures, r.body.model.history],
      ['Gear', 'Ana', '3mf', 4, ['data:image/png;base64,AAAA'], []]
    );
    assert.strictEqual(r.body.model.page, `#/model/${encodeURIComponent(path.join(library, 'Gear', 'Gear.3mf'))}`);
    r = await get(`/api/orca/models/${benchy}`);
    assert.deepStrictEqual(
      r.body.model.history.map((e) => [e.printedAt, e.outcome, e.quantity, e.notes]),
      [['2026-02-01', 'printed', 2, 'Nice']]
    );
    // Its print photos come as data URLs (the plugin has no browser sign-in); a missing file is left out.
    const photos = require('./photos');
    const dirFor = photos.dirFor;
    photos.dirFor = (kind) => path.join(dir, 'photos', kind);
    try {
      fs.mkdirSync(photos.dirFor('print'), { recursive: true });
      fs.writeFileSync(path.join(photos.dirFor('print'), 'p1.png'), Buffer.from('png'));
      const eventId = db.prepare('SELECT id FROM print_events WHERE model_id = ?').get(benchy).id;
      const addPhoto = db.prepare("INSERT INTO print_event_photos (event_id, file_path, caption, created_at) VALUES (?, ?, ?, '2026-02-01')");
      addPhoto.run(eventId, 'p1.png', 'On the bed');
      addPhoto.run(eventId, 'gone.png', null);
      r = await get(`/api/orca/models/${benchy}`);
      assert.deepStrictEqual(r.body.model.history[0].photos, [
        { src: `data:image/png;base64,${Buffer.from('png').toString('base64')}`, caption: 'On the bed' }
      ]);
    } finally {
      photos.dirFor = dirFor;
    }
    r = await get('/api/orca/models/3');
    assert.strictEqual(r.status, 404, 'a link-only model has no details here');
    r = await get('/api/orca/models/999');
    assert.match(r.body.error, /not in the library/);

    // Filters: tags, categories (a subcategory counts for its category) and favorites, then searching by them.
    db.exec(`INSERT INTO tags (id, name) VALUES (1, 'gears'), (2, 'boats'), (3, 'unused');
      INSERT INTO model_tags VALUES (${gear}, 1), (${benchy}, 2);
      INSERT INTO categories (id, name, position, parent_id) VALUES (901, 'JP Mechanical', 0, NULL), (902, 'JP Gears', 0, 901), (903, 'JP Toys', 1, NULL);
      INSERT INTO model_categories (model_id, category_id) VALUES (${gear}, 902), (${benchy}, 903);
      UPDATE models SET favorite = 1 WHERE id = ${clip};`);
    r = await get('/api/orca/filters', { 'x-test-role': 'viewer' });
    assert.deepStrictEqual(r.body, {
      tags: [
        { name: 'boats', count: 1 },
        { name: 'gears', count: 1 }
      ],
      categories: [
        { id: 901, name: 'JP Mechanical', count: 1, subcategories: [{ id: 902, name: 'JP Gears', count: 1 }] },
        { id: 903, name: 'JP Toys', count: 1, subcategories: [] }
      ],
      favorites: 1
    });
    const names = async (q) => (await get(`/api/orca/models?${q}`)).body.models.map((m) => m.name);
    assert.deepStrictEqual(await names('favorite=1'), ['Cable Clip']);
    assert.deepStrictEqual(await names('tag=GEARS'), ['Gear']);
    assert.deepStrictEqual(await names('category=901'), ['Gear'], 'a category finds the models of its subcategories');
    assert.deepStrictEqual(await names('category=902'), ['Gear']);
    assert.deepStrictEqual(await names('category=903&tag=gears'), []);

    // Edits from the details window go through the handlers the browser uses (here stand-ins), editors only.
    const handlers = require('./runtime').ipcMain._handlers;
    const seen = [];
    handlers.set('save-model', async (event, payload) => {
      seen.push(['save-model', event.user.username, payload]);
      db.prepare('UPDATE models SET rating = coalesce(?, rating), favorite = coalesce(?, favorite), notes = coalesce(?, notes) WHERE filePath = ?').run(
        payload.rating ?? null,
        payload.favorite === undefined ? null : Number(payload.favorite),
        payload.notes ?? null,
        payload.filePath
      );
    });
    handlers.set('set-print-status', async (event, payload) => {
      seen.push(['set-print-status', payload.printStatus]);
      db.prepare('UPDATE models SET print_status = ? WHERE id = ?').run(payload.printStatus, payload.modelId);
    });
    handlers.set('log-print-event', async (event, payload) => {
      seen.push(['log-print-event', payload.outcome, payload.quantity, payload.notes, payload.printerId]);
    });
    try {
      r = await post(`/api/orca/models/${gear}/edit`, { rating: 4, favorite: true, notes: 'Use 0.2', printStatus: 'queued' });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual([r.body.model.rating, r.body.model.favorite, r.body.model.notes, r.body.model.printStatus], [4, true, 'Use 0.2', 'queued']);
      assert.deepStrictEqual(seen[0], ['set-print-status', 'queued']);
      assert.deepStrictEqual(seen[1], [
        'save-model',
        'ace',
        { filePath: path.join(library, 'Gear', 'Gear.3mf'), tags: ['gears'], rating: 4, favorite: true, notes: 'Use 0.2' }
      ]);
      assert.strictEqual((await post(`/api/orca/models/${gear}/edit`, { rating: 9 })).status, 400);
      assert.strictEqual((await post(`/api/orca/models/${gear}/edit`, { printStatus: 'lost' })).status, 400);
      assert.strictEqual((await post(`/api/orca/models/${gear}/edit`, { rating: 1 }, { 'x-test-role': 'viewer' })).status, 403);
      assert.strictEqual((await post('/api/orca/models/999/edit', { rating: 1 })).status, 404);

      r = await post(`/api/orca/models/${gear}/log-print`, { outcome: 'failed', quantity: 2, notes: 'Warped', printerId: mk3 });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(seen[seen.length - 1], ['log-print-event', 'failed', 2, 'Warped', Number(mk3)]);
      assert.strictEqual((await post(`/api/orca/models/${gear}/log-print`, { outcome: 'great' })).status, 400);
      assert.strictEqual((await post(`/api/orca/models/${gear}/log-print`, { printerId: 999 })).status, 400);
    } finally {
      for (const name of ['save-model', 'set-print-status', 'log-print-event']) handlers.delete(name);
    }
    db.prepare("UPDATE models SET print_status = 'unprinted', favorite = 0 WHERE id = ?").run(gear);

    // Spools for the Filament tab: not archived, with colors, brand and grams.
    r = await get('/api/orca/spools', { 'x-test-role': 'viewer' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(
      r.body.spools.map((sp) => [sp.name, sp.brand, sp.colors, sp.remaining, sp.available, sp.status]),
      [
        ['Galaxy PETG', 'Prusament', ['#112233', '#445566'], 950, 950, 'storage'],
        ['White PLA', null, ['#ffffff'], 100, 100, 'active']
      ]
    );

    // One spool's details, as the website's spool window shows them.
    r = await get('/api/orca/spools/2', { 'x-test-role': 'viewer' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(
      [r.body.spool.name, r.body.spool.brand, r.body.spool.colors, r.body.spool.remaining, r.body.spool.initial, r.body.spool.currency, r.body.spool.page],
      ['Galaxy PETG', 'Prusament', ['#112233', '#445566'], 950, 1000, 'USD', '#/filament']
    );
    r = await get('/api/orca/spools/1');
    assert.deepStrictEqual(r.body.spool.loadedIn, ['MK4 · A1']);
    r = await get('/api/orca/spools/999');
    assert.strictEqual(r.status, 404);

    // Weigh and dry a spool from its details window (editors).
    r = await post('/api/orca/spools/2/weigh', { weight: 700, withSpool: false });
    assert.deepStrictEqual([r.status, r.body.spool.remaining, r.body.spool.weighings.length], [200, 700, 1]);
    r = await post('/api/orca/spools/2/weigh', { weight: 700 });
    assert.match(r.body.error, /empty spool/, 'weighing with the spool needs its empty weight');
    assert.strictEqual((await post('/api/orca/spools/2/weigh', { weight: 700, withSpool: false }, { 'x-test-role': 'viewer' })).status, 403);
    r = await post('/api/orca/spools/2/drying', { action: 'start', temp: 65, hours: 4 });
    assert.deepStrictEqual([r.status, r.body.spool.drying && r.body.spool.drying.temp], [200, 65]);
    assert.match((await post('/api/orca/spools/2/drying', { action: 'start', temp: 65, hours: 4 })).body.error, /already drying/);
    r = await post('/api/orca/spools/2/drying', { action: 'finish', humidityAfter: 12 });
    assert.deepStrictEqual([r.body.spool.drying, r.body.spool.dryings[0].humidityAfter], [null, 12]);
    assert.match((await post('/api/orca/spools/2/drying', { action: 'finish' })).body.error, /not drying/);
    db.prepare('UPDATE spools SET used_weight = 50 WHERE id = 2').run();

    r = await get('/api/orca/models?q=ana');
    assert.deepStrictEqual(
      r.body.models.map((m) => m.id),
      [gear]
    );
    r = await get('/api/orca/models?q=100%25');
    assert.deepStrictEqual(
      r.body.models.map((m) => m.id),
      [benchy],
      'a % in the search is a %'
    );

    // Open: a one-file slicer link for OrcaSlicer to download.
    r = await post(`/api/orca/models/${gear}/open`, {}, { 'x-test-role': 'viewer' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.modelId, gear);
    const [link] = r.body.links;
    assert.match(link.path, /^\/api\/slicer-file\/[A-Za-z0-9_-]+\/Gear\.3mf$/);
    assert.strictEqual(_links.get(link.path.split('/')[3]).filePath, path.join(library, 'Gear', 'Gear.3mf'));
    assert.strictEqual((await post('/api/orca/models/999/open', {})).status, 404);
    assert.strictEqual((await post('/api/orca/models/3/open', {})).status, 400, 'a link-only model has no file');

    // Printers: what is loaded where, and loading a spool from the plugin.
    r = await get('/api/orca/printers', { 'x-test-role': 'viewer' });
    assert.deepStrictEqual(
      r.body.printers.map((p) => [p.name, p.logsItself, p.units.length]),
      [
        ['MK4', false, 1],
        ['X1C', true, 0]
      ]
    );
    assert.deepStrictEqual(
      r.body.printers[0].units[0].slots.map((slot) => [slot.label, slot.spool && slot.spool.name]),
      [
        ['A1', 'White PLA'],
        ['A2', null],
        ['A3', null],
        ['A4', null]
      ]
    );
    assert.strictEqual((await post('/api/orca/printers/load', { slotId: slotA1, spoolId: 2 }, { 'x-test-role': 'viewer' })).status, 403);
    r = await post('/api/orca/printers/load', { printerId: x1c, spoolId: 2 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.printers[1].direct.name, 'Galaxy PETG');
    r = await post('/api/orca/printers/load', { printerId: x1c, spoolId: null });
    assert.strictEqual(r.body.printers[1].direct, null, 'emptied');
    assert.strictEqual((await post('/api/orca/printers/load', { spoolId: 2 })).status, 400);

    // A print sent from OrcaSlicer: its grams come off the spools.
    assert.strictEqual(
      (await post('/api/orca/print-started', { needs: [{ material: 'PLA', color: '#ffffff', grams: 10 }] }, { 'x-test-role': 'viewer' })).status,
      403
    );
    assert.strictEqual((await post('/api/orca/print-started', { needs: [{ material: 'PLA', color: '#ffffff' }] })).status, 400, 'no grams: not sliced');
    r = await post('/api/orca/print-started', { needs: [{ material: 'PLA', color: '#ffffff', grams: 12.5 }], printerId: mk3 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(
      [r.body.status, r.body.eventId, r.body.used],
      ['taken', null, [{ spoolId: 1, name: 'White PLA', color: '#ffffff', grams: 12.5, left: 88 }]]
    );
    assert.strictEqual(spoolLeft(1), 87.5);
    r = await post('/api/orca/print-started/undo', { used: r.body.used });
    assert.strictEqual(spoolLeft(1), 100, 'given back');
    // With a library model it is logged in the print history; Undo deletes it.
    r = await post('/api/orca/print-started', {
      needs: [
        { material: 'PETG', color: '#112233', grams: 40 },
        { material: 'ABS', color: '#ff0000', grams: 5 }
      ],
      modelId: gear,
      deviceId: 'nope',
      name: 'Gear_PLA.gcode.3mf'
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.eventId);
    assert.deepStrictEqual(r.body.missing, ['ABS red']);
    assert.strictEqual(spoolLeft(2), 910);
    assert.strictEqual(db.prepare('SELECT grams FROM print_event_spools WHERE event_id = ?').get(r.body.eventId).grams, 40);
    r = await post('/api/orca/print-started/undo', { eventId: r.body.eventId });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(spoolLeft(2), 950);
    // A printer that logs its prints by itself (found by OrcaSlicer's device id) is left to it.
    r = await post('/api/orca/print-started', { needs: [{ material: 'PLA', grams: 5 }], modelId: gear, deviceId: '01p00a123' });
    assert.deepStrictEqual([r.body.status, r.body.printer], ['auto', { id: Number(x1c), name: 'X1C' }]);
    assert.strictEqual(spoolLeft(1), 100);
    r = await post('/api/orca/print-started', { needs: [{ material: 'TPU', color: '#00ff00', grams: 5 }] });
    assert.strictEqual(r.status, 409, 'no spool matches');

    // Filament check against the spools.
    r = await post('/api/orca/filament-check', { needs: [{ material: 'PLA', color: '#fefefe', grams: 50 }] }, { 'x-test-role': 'viewer' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ready, true);
    assert.strictEqual(r.body.needs[0].spool.name, 'White PLA');
    assert.strictEqual(r.body.needs[0].left, 50);
    r = await post('/api/orca/filament-check', { needs: [{ material: 'PLA', color: '#ffffff', grams: 150 }] });
    assert.strictEqual(r.body.ready, false);
    assert.strictEqual(r.body.needs[0].short, 50);
    assert.strictEqual((await post('/api/orca/filament-check', { needs: 'x' })).status, 400);

    // Sliced files: editors only, and only with a Sliced inbox folder.
    assert.strictEqual((await post('/api/orca/sliced?name=Gear.gcode.3mf', sliced(), { 'x-test-role': 'viewer' })).status, 403);
    r = await post('/api/orca/sliced?name=Gear.gcode.3mf', sliced());
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /Sliced inbox/);
    inbox.setInboxFolder(db, folder, { homes: [library] });
    assert.strictEqual((await post('/api/orca/sliced?name=Gear.gcode', sliced())).status, 400);

    // Named like its model: filed beside it and queued at once.
    r = await post('/api/orca/sliced?name=Gear_PLA_1h2m.gcode.3mf', sliced());
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body, { fileName: 'Gear_PLA_1h2m.gcode.3mf', status: 'filed', model: { id: gear, name: 'Gear' } });
    assert.ok(fs.existsSync(path.join(library, 'Gear', 'Gear_PLA_1h2m.gcode.3mf')));
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM print_queue WHERE model_id = ?').get(gear).n, 1);

    // Named like no model: waits, unless the plugin says which model it opened.
    r = await post('/api/orca/sliced?name=Untitled.gcode.3mf', sliced());
    assert.strictEqual(r.body.status, 'waiting');
    assert.ok(fs.existsSync(path.join(folder, 'Untitled.gcode.3mf')));
    r = await post(`/api/orca/sliced?name=Project1.gcode.3mf&modelId=${clip}`, sliced());
    assert.deepStrictEqual(r.body, { fileName: 'Project1.gcode.3mf', status: 'filed', model: { id: clip, name: 'Cable Clip' } });
    assert.ok(fs.existsSync(path.join(library, 'Clip', 'Project1.gcode.3mf')));
    assert.ok(!fs.readdirSync(folder).some((name) => name.endsWith('.part')), 'no temp files left');

    // Projects: editors only; without an Upload folder or library folder it says so.
    assert.strictEqual((await post('/api/orca/project?name=Gear.3mf', Buffer.from('x'), { 'x-test-role': 'viewer' })).status, 403);
    const uploads = path.join(library, 'Uploads');
    db.prepare("INSERT INTO settings (key, value) VALUES ('uploadFolder', ?)").run(uploads);
    fs.mkdirSync(uploads);
    assert.strictEqual((await post('/api/orca/project?name=notes.exe', Buffer.from('x'))).status, 400, 'only types the library scans');
    r = await post('/api/orca/project?name=Gear.3mf', Buffer.from('PK project'));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.filePath, path.join(uploads, 'Gear.3mf'));
    r = await post('/api/orca/project?name=Gear.3mf', Buffer.from('PK again'));
    assert.strictEqual(r.body.fileName, 'Gear (2).3mf', 'never replaces a file');
    assert.strictEqual(fs.readFileSync(path.join(uploads, 'Gear.3mf'), 'utf8'), 'PK project');

    // The plugin file to install.
    const file = await fetch(`${base}/api/orca/plugin.py`);
    assert.strictEqual(file.status, 200);
    assert.match(file.headers.get('content-disposition') || '', /justtprint\.py/);
    assert.match(await file.text(), /\[tool\.orcaslicer\.plugin\]/);
  } finally {
    s.close();
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name}`);
      console.log(error);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
