'use strict';

const { describe, test, before } = require('node:test');
const { spawnSync } = require('child_process');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
// The copy the browser loads (vendor/occt-import-js/BUILD.md), not an npm package.
const occtimportjs = require('../vendor/occt-import-js/occt-import-js.js');

const CUBE_STEP = path.join(__dirname, 'fixtures', 'step-cube.stp');
const CUBE_IGES = path.join(__dirname, 'fixtures', 'iges-cube.igs');

let occt;

describe('STEP tessellation', () => {
  before(async () => {
    occt = await occtimportjs();
  });

  test('tessellates a simple STEP cube into mesh triangles', () => {
    const bytes = fs.readFileSync(CUBE_STEP);
    const result = occt.ReadStepFile(new Uint8Array(bytes), {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.01,
      angularDeflection: 0.5
    });
    assert.equal(result.success, true);
    assert.ok(result.meshes && result.meshes.length >= 1);
    const mesh = result.meshes[0];
    assert.ok(mesh.attributes.position.array.length >= 9);
    assert.ok(mesh.index.array.length >= 3);
  });

  test('tessellates a simple IGES cube into mesh triangles', () => {
    const bytes = fs.readFileSync(CUBE_IGES);
    const result = occt.ReadIgesFile(new Uint8Array(bytes), {
      linearUnit: 'millimeter',
      linearDeflectionType: 'bounding_box_ratio',
      linearDeflection: 0.01,
      angularDeflection: 0.5
    });
    assert.equal(result.success, true);
    assert.ok(result.meshes && result.meshes.length >= 1);
    const mesh = result.meshes[0];
    assert.ok(mesh.attributes.position.array.length >= 9);
    assert.ok(mesh.index.array.length >= 3);
  });
});

describe('STEP library without eval', () => {
  const LIBRARY = path.join(__dirname, '..', 'vendor', 'occt-import-js', 'occt-import-js.js');

  test('the library has no eval or new Function', () => {
    const source = fs.readFileSync(LIBRARY, 'utf8');
    assert.doesNotMatch(source, /new Function|\beval\(|newFunc\(Function/);
  });

  // The browser's CSP ('unsafe-eval' left out) blocks code generated from strings; Node's
  // --disallow-code-generation-from-strings does the same, so this is what the parse worker sees.
  test('parses STEP and IGES with code generation from strings turned off', () => {
    const script = `
      const fs = require('fs');
      require(${JSON.stringify(LIBRARY)})().then((occt) => {
        const options = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.01, angularDeflection: 0.5 };
        const step = occt.ReadStepFile(new Uint8Array(fs.readFileSync(${JSON.stringify(CUBE_STEP)})), options);
        const iges = occt.ReadIgesFile(new Uint8Array(fs.readFileSync(${JSON.stringify(CUBE_IGES)})), options);
        console.log(JSON.stringify({ step: step.success && step.meshes.length, iges: iges.success && iges.meshes.length }));
      }).catch((error) => { console.error(error && error.message); process.exit(1); });`;
    const run = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '-e', script], { encoding: 'utf8', timeout: 120000 });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim().split('\n').pop());
    assert.ok(result.step >= 1 && result.iges >= 1, run.stdout);
  });
});
