#!/usr/bin/env node
'use strict';

// The AI tagging run the JusttPrint backend keeps for the review (src/server/ai-tag-job.js).

const assert = require('assert');
const events = require('../src/server/events');
const job = require('../src/server/ai-tag-job');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

const sent = [];
events.setBroadcaster((channel, ...args) => sent.push([channel, ...args]));

test('a run keeps its results and announces progress to every page', () => {
  const run = job.start('ann', ['/m/a.stl', '/m/b.stl']);
  assert.ok(run && run.batch);
  job.record(run.id, '/m/a.stl', ['boat', 'red'], null);
  const snap = job.snapshot();
  assert.strictEqual(snap.by, 'ann');
  assert.strictEqual(snap.processed, 1);
  assert.strictEqual(snap.withTags, 1);
  assert.deepStrictEqual(snap.results, [{ filePath: '/m/a.stl', tags: ['boat', 'red'], error: null }]);
  assert.deepStrictEqual(snap.filePaths, ['/m/a.stl', '/m/b.stl']);
  const last = sent[sent.length - 1];
  assert.strictEqual(last[0], 'ai-tag-job');
  assert.strictEqual(last[1].processed, 1);
  assert.ok(!('results' in last[1]));
});

test('one run at a time, and a running run is not dismissed', () => {
  assert.strictEqual(job.start('bob', ['/m/c.stl']), null);
  assert.strictEqual(job.dismiss(), false);
});

test('stop is asked for, then the run finishes and can be dismissed', () => {
  const { id } = job.snapshot();
  assert.strictEqual(job.stopRequested(id), false);
  assert.strictEqual(job.stop(), true);
  assert.strictEqual(job.stopRequested(id), true);
  job.finish(id);
  assert.strictEqual(job.snapshot().running, false);
  assert.strictEqual(job.stop(), false);
  assert.strictEqual(job.dismiss(id + 1), false, 'another run id leaves it');
  assert.strictEqual(job.dismiss(id), true);
  assert.strictEqual(job.snapshot(), null);
  assert.deepStrictEqual(sent[sent.length - 1], ['ai-tag-job', null]);
});

test('results of an old run are ignored', () => {
  const old = job.start('ann', ['/m/a.stl']);
  job.finish(old.id);
  const run = job.start('ann', ['/m/b.stl']);
  assert.ok(run && !run.batch);
  job.record(old.id, '/m/a.stl', ['x'], null);
  assert.strictEqual(job.snapshot().processed, 0);
  job.finish(run.id);
  job.dismiss(run.id);
});

events.setBroadcaster(null);
