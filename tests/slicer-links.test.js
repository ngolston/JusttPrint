#!/usr/bin/env node
'use strict';

// Open in OrcaSlicer without the helper (src/server/slicer-links.js, slicer-protocol.js).

const assert = require('assert');
const { MAX_FILES, isOrcaLinkSlicer, issueSlicerFileLinks, linkFileName, _links } = require('../src/server/slicer-links');
const { buildOrcaSlicerOpenUrl } = require('../slicer-protocol');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

test('only orcaslicer:// slicers use the links', () => {
  assert.ok(isOrcaLinkSlicer({ path: 'orcaslicer://' }));
  assert.ok(isOrcaLinkSlicer({ path: ' OrcaSlicer:// ' }));
  assert.ok(!isOrcaLinkSlicer({ path: '/Applications/OrcaSlicer.app' }));
  assert.ok(!isOrcaLinkSlicer(null));
});

test('the address ends in a plain file name with the model\'s extension', () => {
  assert.strictEqual(linkFileName('/lib/Designer A/Benchy Boat.STL'), 'Benchy_Boat.stl');
  assert.strictEqual(linkFileName('/lib/pack.zip::inner/Gear (v2).3mf'), 'Gear_v2.3mf');
  assert.strictEqual(linkFileName('/lib/Café déco.stl'), 'Cafe_deco.stl');
  assert.strictEqual(linkFileName('/lib/../.hidden.stl'), 'hidden.stl');
  assert.strictEqual(linkFileName('/lib/★★.stl'), 'model.stl');
  assert.match(linkFileName(`/lib/${'a'.repeat(300)}.stl`), /^a{120}\.stl$/);
});

test('each file gets its own token, which expires after 30 minutes', () => {
  _links.clear();
  const t0 = 1_000_000;
  const files = issueSlicerFileLinks(['/lib/a.stl', '/lib/b.3mf'], t0);
  assert.strictEqual(files.length, 2);
  assert.notStrictEqual(files[0].token, files[1].token);
  assert.match(files[0].token, /^[A-Za-z0-9_-]{22}$/);
  assert.deepStrictEqual(files.map((f) => f.name), ['a.stl', 'b.3mf']);
  assert.strictEqual(_links.get(files[0].token).filePath, '/lib/a.stl');
  issueSlicerFileLinks(['/lib/c.stl'], t0 + 31 * 60 * 1000);
  assert.ok(!_links.has(files[0].token), 'expired tokens are dropped');
});

test('at most 10 files at a time, and at least one', () => {
  assert.throws(() => issueSlicerFileLinks(Array.from({ length: MAX_FILES + 1 }, (_, i) => `/lib/${i}.stl`)), /up to 10 files/);
  assert.throws(() => issueSlicerFileLinks([]), /No model files/);
});

test('the OrcaSlicer link carries the address encoded once', () => {
  const href = buildOrcaSlicerOpenUrl('http://nas.local:5000/some/page', { token: 'tok_en-1', name: 'Benchy_Boat.stl' });
  assert.strictEqual(href, 'orcaslicer://open?file=http%3A%2F%2Fnas.local%3A5000%2Fapi%2Fslicer-file%2Ftok_en-1%2FBenchy_Boat.stl');
  // OrcaSlicer decodes once (curl_easy_unescape) and names the file after the last part.
  const decoded = decodeURIComponent(href.slice('orcaslicer://open?file='.length));
  assert.strictEqual(decoded, 'http://nas.local:5000/api/slicer-file/tok_en-1/Benchy_Boat.stl');
  assert.strictEqual(decoded.split('/').pop(), 'Benchy_Boat.stl');
  assert.throws(() => buildOrcaSlicerOpenUrl('http://x', { token: '' }), /Missing/);
});
