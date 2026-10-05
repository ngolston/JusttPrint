'use strict';

// The OBJ and PLY loaders the parse worker uses (src/web/parse/worker.ts), from npm three.js.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TRI_OBJ = path.join(__dirname, 'fixtures', 'triangle.obj');
const TRI_PLY = path.join(__dirname, 'fixtures', 'triangle.ply');

describe('OBJ and PLY mesh parse', () => {
  test('OBJLoader parses a one-triangle OBJ', async () => {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    const object = new OBJLoader().parse(fs.readFileSync(TRI_OBJ, 'utf8'));
    let positions = 0;
    object.traverse((child) => {
      if (child.isMesh && child.geometry && child.geometry.attributes.position) {
        positions += child.geometry.attributes.position.count;
      }
    });
    assert.ok(positions >= 3);
  });

  test('PLYLoader parses a one-triangle ASCII PLY', async () => {
    const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
    const buffer = fs.readFileSync(TRI_PLY);
    const geometry = new PLYLoader().parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    assert.ok(geometry.attributes.position.count >= 3);
    assert.ok(geometry.index && geometry.index.count >= 3);
  });
});
