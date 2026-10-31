#!/usr/bin/env node
'use strict';

// 10.2 Phase 11 (docs/plan-10.1.md): one Home Assistant sensor per spool, through its REST API.

const assert = require('assert');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const { ensureFilamentSchema } = require('../src/core/filament-schema');
const spools = require('../src/core/spools');
const ha = require('../src/server/home-assistant');

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
  database.db = db;
  return db;
};
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.e2e-test-token-for-home-assistant';

/** A pretend Home Assistant: records requests, answers as told. */
function fakeHa(answer = () => ({ status: 200, body: {} })) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, auth: options.headers.authorization, body: options.body ? JSON.parse(options.body) : null });
    const { status, body } = answer(url, options);
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return { calls, fetchImpl };
}

test('settings: the address checked, the token never shown back, both needed to turn it on', () => {
  fresh();
  assert.strictEqual(ha.cleanUrl('http://homeassistant.local:8123/'), 'http://homeassistant.local:8123');
  assert.throws(() => ha.cleanUrl('ftp://x'), /http/);
  assert.throws(() => ha.cleanUrl('http://user:pw@ha.local'), /http/);
  assert.throws(() => ha.save({ enabled: true }), /address and a token first/);
  assert.throws(() => ha.save({ token: 'short' }), /long-lived access token/);
  const saved = ha.save({ url: 'http://ha.local:8123', token: TOKEN });
  assert.deepStrictEqual(saved, { url: 'http://ha.local:8123', enabled: false, tokenSet: true, lastPush: null });
  assert.ok(!JSON.stringify(ha.save({ enabled: true })).includes(TOKEN), 'the token stays on the server');
  ha.stop();
});

test('test: Home Assistant answers, or a refused token says what to do', async () => {
  fresh();
  ha.save({ url: 'http://ha.local:8123', token: TOKEN });
  const ok = fakeHa(() => ({ status: 200, body: { message: 'API running.' } }));
  assert.deepStrictEqual(await ha.test({ fetchImpl: ok.fetchImpl }), { ok: true, message: 'API running.' });
  assert.deepStrictEqual([ok.calls[0].url, ok.calls[0].auth], ['http://ha.local:8123/api/', `Bearer ${TOKEN}`]);
  const refused = await ha.test({ fetchImpl: fakeHa(() => ({ status: 401 })).fetchImpl });
  assert.deepStrictEqual([refused.ok, /refused the token/.test(refused.message)], [false, true]);
  const unreachable = await ha.test({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    }
  });
  assert.deepStrictEqual(unreachable, { ok: false, message: 'Could not reach Home Assistant at http://ha.local:8123: ECONNREFUSED' });
});

test('push: a sensor per spool on hand, grams as the state; gone spools are removed', async () => {
  const db = fresh();
  ha.save({ url: 'http://ha.local:8123', token: TOKEN, enabled: true });
  ha.stop();
  const black = spools.saveSpool(db, { name: 'Black', brand_name: 'Bambu', material: 'PLA', color_hex: '#111111', initial_weight: 1000, remaining: 640 });
  const teal = spools.saveSpool(db, { name: 'Teal', material: 'PETG', initial_weight: 1000, remaining: 300 });
  const first = fakeHa();
  const result = await ha.push({ fetchImpl: first.fetchImpl, now: new Date('2026-10-31T12:00:00Z') });
  assert.deepStrictEqual([result.pushed, result.removed, result.errors], [2, 0, 0]);
  const blackCall = first.calls.find((c) => c.url.endsWith(`sensor.justtprint_spool_${black.id}`));
  assert.strictEqual(blackCall.method, 'POST');
  assert.deepStrictEqual(
    [
      blackCall.body.state,
      blackCall.body.attributes.unit_of_measurement,
      blackCall.body.attributes.percent,
      blackCall.body.attributes.brand,
      blackCall.body.attributes.friendly_name
    ],
    [640, 'g', 64, 'Bambu', 'Black']
  );
  assert.deepStrictEqual(ha.status().lastPush, { at: '2026-10-31T12:00:00.000Z', pushed: 2, removed: 0, errors: 0, message: null });
  spools.archiveSpool(db, teal.id, true);
  const second = fakeHa();
  const again = await ha.push({ fetchImpl: second.fetchImpl });
  assert.deepStrictEqual([again.pushed, again.removed], [1, 1]);
  assert.ok(
    second.calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`sensor.justtprint_spool_${teal.id}`)),
    'the archived spool’s sensor goes'
  );
  const third = fakeHa();
  await ha.push({ fetchImpl: third.fetchImpl });
  assert.ok(!third.calls.some((c) => c.method === 'DELETE'), 'removed once');
});

test('push: off does nothing; a refused token stops at once and is kept as the last push', async () => {
  const db = fresh();
  spools.saveSpool(db, { name: 'A', material: 'PLA', initial_weight: 1000 });
  spools.saveSpool(db, { name: 'B', material: 'PLA', initial_weight: 1000 });
  const off = fakeHa();
  assert.strictEqual((await ha.push({ fetchImpl: off.fetchImpl })).skipped, true);
  assert.strictEqual(off.calls.length, 0);
  ha.save({ url: 'http://ha.local:8123', token: TOKEN, enabled: true });
  ha.stop();
  const refused = fakeHa(() => ({ status: 401 }));
  const result = await ha.push({ fetchImpl: refused.fetchImpl });
  assert.deepStrictEqual([result.pushed, result.errors, refused.calls.length], [0, 1, 1]);
  assert.match(ha.status().lastPush.message, /refused the token/);
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
  ha.stop();
})();
