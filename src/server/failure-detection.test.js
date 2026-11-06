#!/usr/bin/env node
'use strict';

// Failure detection (failure-detection.js): Obico's scoring, one alert per print (and a pause
// when asked), the settings, and asking a detector that fetches the picture from JusttPrint.

const assert = require('assert');
const http = require('http');
const Database = require('better-sqlite3');
const express = require('express');
const database = require('../core/database');
const detection = require('./failure-detection');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function useDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE printers (id INTEGER PRIMARY KEY, nickname TEXT);
    INSERT INTO printers VALUES (1, 'P1S'), (2, 'A1');
  `);
  database.db = db;
  detection._watched.clear();
  return db;
}

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server));
  });
const address = (server) => `http://127.0.0.1:${server.address().port}`;

test("a picture's score is what it detected, added up", () => {
  assert.strictEqual(
    detection.scoreOf([
      ['failure', 0.5, [1, 2, 3, 4]],
      ['failure', 0.25, [5, 6, 7, 8]]
    ]),
    0.75
  );
  assert.strictEqual(detection.scoreOf([]), 0);
  assert.strictEqual(detection.scoreOf(null), 0);
});

test('nothing counts while warming up; a camera that always sees a little is fine; a jump is failing', () => {
  const config = { intervalSeconds: 10, sensitivity: 'medium' };
  const watch = detection.newWatch(1, 'Gear');
  const levels = [];
  for (let i = 0; i < 29; i++) levels.push(detection.addScore(watch, i === 3 ? 4 : 0.3, config));
  assert.ok(
    levels.every((level) => level === 'warming'),
    'the first five minutes (30 pictures 10 s apart) never alert, even with a jump'
  );
  for (let i = 0; i < 30; i++) assert.strictEqual(detection.addScore(watch, 0.3, config), 'ok', 'steady noise is the baseline');
  assert.strictEqual(detection.addScore(watch, 3, config), 'ok', 'one odd picture is not a failure');
  assert.strictEqual(detection.addScore(watch, 3, config), 'failing', 'spaghetti that stays is');
  const calm = detection.newWatch(1, 'Gear');
  for (let i = 0; i < 40; i++) detection.addScore(calm, 0.3, { intervalSeconds: 10, sensitivity: 'low' });
  assert.notStrictEqual(detection.addScore(calm, 1.2, { intervalSeconds: 10, sensitivity: 'low' }), 'failing', 'low sensitivity lets a small jump go');
});

test('settings: checked, the token kept apart and never shown', () => {
  const db = useDb();
  assert.throws(() => detection.saveConfig({ enabled: true, url: '', selfUrl: '' }), /Give the detector's address/);
  assert.throws(() => detection.saveConfig({ url: 'ftp://x' }), /starts with http/);
  const saved = detection.saveConfig({
    enabled: true,
    url: 'http://obico:3333/',
    selfUrl: 'http://jp:5000',
    intervalSeconds: 3,
    sensitivity: 'odd',
    token: 'abc'
  });
  assert.deepStrictEqual(
    [saved.url, saved.intervalSeconds, saved.sensitivity, saved.tokenSet, saved.autoPause],
    ['http://obico:3333', 10, 'medium', true, false],
    'trailing slash gone, the interval at least 10 s, an unknown sensitivity is medium, alerts only by default'
  );
  assert.ok(!JSON.stringify(saved).includes('abc'), 'the token is not sent back');
  assert.ok(!db.prepare("SELECT value FROM settings WHERE key = 'failureDetection'").get().value.includes('abc'));
  detection.saveConfig({ ...saved });
  assert.strictEqual(detection.publicConfig().tokenSet, true, 'saving without a token keeps it');
});

test('a failing print: one alert, a pause when asked, again only after a resume; other printers left alone', async () => {
  useDb();
  detection.saveConfig({ enabled: true, url: 'http://obico:3333', selfUrl: 'http://jp:5000', intervalSeconds: 10, autoPause: true, printers: [1] });
  const states = { 1: 'printing', 2: 'printing' };
  const live = { status: () => [1, 2].map((printerId) => ({ printerId, state: states[printerId], job: 'Gear' })) };
  let score = 0.1;
  const asked = [];
  const alerts = [];
  const paused = [];
  const deps = {
    live,
    cameras: { frame: async (id) => ({ jpeg: Buffer.from(`picture ${id}`), at: 0 }) },
    detectWith: async (config, jpeg) => {
      asked.push(jpeg.toString());
      return [['failure', score, [0, 0, 1, 1]]];
    },
    alert: async (kind, a) => alerts.push([kind, a.title, a.body]),
    pause: async (id) => paused.push(id)
  };
  let now = 1_000_000;
  const step = async (times) => {
    for (let i = 0; i < times; i++) {
      now += 10_000;
      await detection.tick({ ...deps, now });
    }
  };
  await step(35);
  assert.ok(
    asked.every((name) => name === 'picture 1'),
    'only the printer chosen'
  );
  assert.strictEqual(asked.length, 35);
  assert.strictEqual(detection.publicConfig().watching[0].level, 'ok');
  score = 3;
  await step(3);
  assert.deepStrictEqual(alerts.length, 1, 'one alert, not one per picture');
  assert.strictEqual(alerts[0][0], 'printFailing');
  assert.match(alerts[0][1], /P1S: Gear looks like it is failing/);
  assert.match(alerts[0][2], /JusttPrint paused it/);
  assert.deepStrictEqual(paused, [1]);
  const watch = detection.publicConfig().watching[0];
  assert.deepStrictEqual([watch.level, watch.paused, watch.flagged], ['failing', true, true]);

  states[1] = 'paused';
  await step(2);
  assert.strictEqual(asked.length, 38, 'no pictures while paused');
  states[1] = 'printing';
  score = 0.1;
  await step(1);
  score = 3;
  await step(3);
  assert.strictEqual(alerts.length, 2, 'after a resume it may alert again');

  states[1] = 'idle';
  await step(1);
  assert.strictEqual(detection.publicConfig().watching.length, 0, 'a finished print is no longer watched');
});

test('only alerts when auto-pause is off; a camera error is shown, not alerted', async () => {
  useDb();
  detection.saveConfig({ enabled: true, url: 'http://obico:3333', selfUrl: 'http://jp:5000', intervalSeconds: 10 });
  let score = 0.1;
  const alerts = [];
  const paused = [];
  let cameraWorks = true;
  const deps = {
    live: { status: () => [{ printerId: 1, state: 'printing', job: 'Gear' }] },
    cameras: { frame: async () => (cameraWorks ? { jpeg: Buffer.from('x'), at: 0 } : { error: 'the camera is off' }) },
    detectWith: async () => [['failure', score, []]],
    alert: async (kind, a) => alerts.push(a.body),
    pause: async (id) => paused.push(id)
  };
  let now = 0;
  for (let i = 0; i < 33; i++) await detection.tick({ ...deps, now: (now += 10_000) });
  score = 3;
  for (let i = 0; i < 3; i++) await detection.tick({ ...deps, now: (now += 10_000) });
  assert.deepStrictEqual(paused, []);
  assert.match(alerts[0], /It is still printing/);
  cameraWorks = false;
  await detection.tick({ ...deps, now: now + 10_000 });
  assert.match(detection.publicConfig().watching[0].error, /No camera picture: the camera is off/);
});

test('the detector fetches the picture from JusttPrint once, by its short-lived address; its errors in words', async () => {
  useDb();
  const app = express();
  detection.registerFrameRoutes(app);
  const self = await listen(app);
  /** @type {Buffer | null} */
  let lastPicture = null;
  const obico = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/hc/') return res.end('ok');
    if (req.headers.authorization !== 'Bearer s3cret') {
      res.statusCode = 401;
      return res.end();
    }
    const picture = await fetch(String(url.searchParams.get('img')));
    if (!picture.ok) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ detections: [], message: `could not fetch ${picture.status}` }));
    }
    lastPicture = Buffer.from(await picture.arrayBuffer());
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ detections: [['failure', 0.42, [1, 2, 3, 4]]] }));
  });
  try {
    detection.saveConfig({ enabled: true, url: address(obico), selfUrl: address(self), token: 's3cret' });
    const config = detection.readConfig();
    const detections = await detection.detect(config, Buffer.from('jpeg bytes'));
    assert.deepStrictEqual(detections, [['failure', 0.42, [1, 2, 3, 4]]]);
    assert.strictEqual(String(lastPicture), 'jpeg bytes', 'the picture as the camera gave it');

    const tested = await detection.testDetector(null);
    assert.deepStrictEqual(tested, { ok: true, detections: 1, score: 0.42 }, 'the test sends JusttPrint’s logo');

    const stray = await fetch(`${address(self)}/api/detect-frame/${'0'.repeat(32)}.jpg`);
    assert.strictEqual(stray.status, 404, 'no picture without its token');

    await assert.rejects(
      detection.detect({ ...config, selfUrl: `${address(self)}/wrong` }, Buffer.from('x')),
      /could not get the picture from .*Check JusttPrint's address/
    );
    detection.saveConfig({ ...config, token: 'wrong' });
    await assert.rejects(detection.detect(config, Buffer.from('x')), /refused the token/);
    await assert.rejects(detection.detect({ ...config, url: 'http://127.0.0.1:9' }, Buffer.from('x')), /did not answer/);
  } finally {
    self.close();
    obico.close();
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
  detection.stop();
})();
