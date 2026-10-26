#!/usr/bin/env node
'use strict';

// Multi-part 3MF previews (src/core/threemf-loader-simple.js): the meshes are scanned from their
// text (no DOM node per vertex, which ran large kits out of memory), and the triangle budget is
// shared across the parts.

const assert = require('assert');
const fflate = require('fflate');
const { Simple3MFLoader } = require('../src/core/threemf-loader-simple');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

/** A grid mesh of about `triangles` triangles, as 3MF XML (with an optional namespace prefix). */
function gridMesh(triangles, prefix = '') {
  const n = Math.max(1, Math.ceil(Math.sqrt(triangles / 2)));
  let vertices = '';
  let tris = '';
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) vertices += `<${prefix}vertex x="${i}" y="${j}" z="0"/>`;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const a = i * (n + 1) + j;
      const c = a + n + 1;
      tris += `<${prefix}triangle v1="${a}" v2="${c}" v3="${a + 1}"/><${prefix}triangle v1="${a + 1}" v2="${c}" v3="${c + 1}"/>`;
    }
  return `<${prefix}mesh><${prefix}vertices>${vertices}</${prefix}vertices><${prefix}triangles>${tris}</${prefix}triangles></${prefix}mesh>`;
}

/** A 3MF with `parts` objects, each placed by its build item (so the DOM path is used). */
function kit(parts, trianglesEach, prefix = '') {
  const ns = prefix ? ` xmlns:${prefix.slice(0, -1)}="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"` : '';
  let objects = '';
  let items = '';
  for (let p = 1; p <= parts; p++) {
    objects += `<${prefix}object id="${p}" type="model" name="Part ${p}">${gridMesh(trianglesEach, prefix)}</${prefix}object>`;
    items += `<${prefix}item objectid="${p}" transform="1 0 0 0 1 0 0 0 1 ${p * 100} 0 0"/>`;
  }
  const xml = `<?xml version="1.0"?><${prefix}model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"${ns}><${prefix}resources>${objects}</${prefix}resources><${prefix}build>${items}</${prefix}build></${prefix}model>`;
  const zip = fflate.zipSync({ '3D/3dmodel.model': new TextEncoder().encode(xml) });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
}

const parse = (buffer, options = {}) => new Simple3MFLoader({ onStatus: () => {}, ...options }).parse(buffer);
const xsOf = (json, index) => {
  const array = json.geometries[index].data.attributes.position.array;
  const xs = [];
  for (let i = 0; i < array.length; i += 3) xs.push(array[i]);
  return xs;
};

test('every part is read, with its triangles, and placed by its build item', () => {
  const json = parse(kit(3, 200));
  assert.strictEqual(json.geometries.length, 3);
  // Each part sits where its build item puts it (100, 200, 300 along x; the list order may differ).
  const starts = json.geometries.map((_, index) => Math.round(Math.min(...xsOf(json, index)))).sort((a, b) => a - b);
  assert.deepStrictEqual(starts, [100, 200, 300]);
  assert.strictEqual(json.metadata?.simplified ?? false, false, 'small kits are not simplified');
});

test('a namespace prefix (m:mesh, m:vertex) is read too', () => {
  const json = parse(kit(2, 50, 'm:'));
  assert.strictEqual(json.geometries.length, 2);
  assert.ok(json.geometries[0].data.index.array.length >= 50 * 3);
});

test('the triangle budget is for the whole model, shared by its parts', () => {
  const json = parse(kit(10, 20000), { targetTriangles: 100000 });
  assert.strictEqual(json.metadata.sourceTriangles > 100000, true);
  assert.ok(json.metadata.keptTriangles <= 100000 * 1.1, `kept ${json.metadata.keptTriangles} of ${json.metadata.sourceTriangles}`);
});
