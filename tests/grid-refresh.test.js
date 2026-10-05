#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const gridRefresh = require('../grid-refresh');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function normalize(filePath) {
  return String(filePath || '').replace(/\\/g, '/').toLowerCase();
}

test('off-screen thumbnail patches the loaded model object', () => {
  const model = { filePath: 'C:/lib/a.stl', thumbnail: null };
  const models = [model];
  const patched = gridRefresh.patchLoadedModel(
    models,
    normalize('C:/lib/a.stl'),
    { filePath: 'C:/lib/a.stl', thumbnail: 'data:image/png;base64,abc' },
    normalize
  );
  assert.strictEqual(patched, true);
  assert.strictEqual(models[0], model);
  assert.strictEqual(model.thumbnail, 'data:image/png;base64,abc');
});

test('thumbnail patch misses a model that is not loaded', () => {
  const patched = gridRefresh.patchLoadedModel(
    [{ filePath: 'C:/lib/b.stl' }],
    normalize('C:/lib/missing.stl'),
    { thumbnail: 'x' },
    normalize
  );
  assert.strictEqual(patched, false);
});

test('detailed and preview keep a selection in view', () => {
  assert.strictEqual(gridRefresh.shouldFocusSelectionOnViewSwitch('detailed', 'preview', true), true);
  assert.strictEqual(gridRefresh.shouldFocusSelectionOnViewSwitch('preview', 'detailed', true), true);
  assert.strictEqual(gridRefresh.shouldFocusSelectionOnViewSwitch('detailed', 'list', true), false);
  assert.strictEqual(gridRefresh.shouldFocusSelectionOnViewSwitch('preview', 'detailed', false), false);

});

test('progressive render holds a short page only while preserving scroll', () => {
  assert.strictEqual(gridRefresh.shouldHoldProgressiveRender(true, 500, 2000, false), true);
  assert.strictEqual(gridRefresh.shouldHoldProgressiveRender(true, 2000, 2000, false), false);
  assert.strictEqual(gridRefresh.shouldHoldProgressiveRender(true, 100, 2000, true), false);
  assert.strictEqual(gridRefresh.shouldHoldProgressiveRender(false, 500, 2000, false), false);
});

test('thumbnail reloads coalesce to one call per window', async () => {
  let calls = 0;
  const schedule = gridRefresh.createCoalescedRefresh(40, async () => {
    calls += 1;
  });
  schedule();
  schedule();
  schedule();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.strictEqual(calls, 1);
  schedule();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.strictEqual(calls, 2);
});

// The progressive search itself is TypeScript now: src/web/filters/search.test.ts.

test('renderer wires off-screen patches to a coalesced scroll-preserving refresh', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.ok(renderer.includes('window.gridRefresh.patchLoadedModel'));
  assert.ok(renderer.includes('window.gridRefresh.createCoalescedRefresh'));
  assert.ok(renderer.includes('performCombinedSearch({ preserveScroll: true })'));
  assert.ok(renderer.includes('shouldFocusSelectionOnViewSwitch'));
  // Centering the selection moved to the React grid (src/web/grid/layout.ts, tested there).
  const grid = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'grid', 'LibraryGrid.tsx'), 'utf8');
  assert.ok(grid.includes('scrollTopForSelection('));
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.indexOf('src="grid-refresh.js"') !== -1 && html.indexOf('src="grid-refresh.js"') < html.indexOf('src="renderer.js"'));
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}:`, err && err.stack ? err.stack : err);
      process.exitCode = 1;
    }
  }
})();
