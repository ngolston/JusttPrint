'use strict';

const assert = require('assert');
const { zipSync, strToU8 } = require('fflate');
const { eigenSymmetric, geometrySignature, stlSignature, threeMfSignature } = require('../src/core/geometry-signature');

// A lopsided solid with no mirror symmetry: two tetrahedra of different shapes, apart.
const SHAPE = [
  [[0, 0, 0], [30, 0, 0], [0, 20, 0], [5, 7, 13]],
  [[40, 2, 1], [52, 4, 0], [45, 15, 3], [47, 6, 9]]
];
const faces = (t) => [[t[0], t[2], t[1]], [t[0], t[1], t[3]], [t[1], t[2], t[3]], [t[0], t[3], t[2]]];
const triangles = (transform) => SHAPE.flatMap((t) => faces(t.map(transform)));

function binaryStl(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((tri, i) => tri.forEach((p, j) => p.forEach((x, k) => buf.writeFloatLE(x, 84 + i * 50 + 12 + j * 12 + k * 4))));
  return buf;
}
const asciiStl = (tris) => Buffer.from(`solid t\n${tris.map((tri) => `facet normal 0 0 0\nouter loop\n${tri.map((p) => `vertex ${p.join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n')}\nendsolid t\n`);
function threeMf(tris) {
  const verts = [];
  const idx = tris.map((tri) => tri.map((p) => verts.push(p) - 1));
  const xml = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${
    verts.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices><triangles>${
    idx.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  return Buffer.from(zipSync({ '3D/3dmodel.model': strToU8(xml) }));
}

// Moved and turned the way a slicer or another export might.
const a = 0.7; const b = -1.1;
const turnMove = ([x, y, z]) => {
  const x1 = x * Math.cos(a) - y * Math.sin(a); const y1 = x * Math.sin(a) + y * Math.cos(a);
  const y2 = y1 * Math.cos(b) - z * Math.sin(b); const z2 = y1 * Math.sin(b) + z * Math.cos(b);
  return [x1 + 120, y2 - 35, z2 + 7.5];
};
const mirror = ([x, y, z]) => [-x, y, z];
const same = (p) => p;

const original = stlSignature(binaryStl(triangles(same)));
assert.ok(original && /^8:/.test(original.signature), JSON.stringify(original));
assert.ok(original.volume > 0 && original.area > 0);
assert.strictEqual(stlSignature(binaryStl(triangles(turnMove))).signature, original.signature, 'moved and turned: the same model');
assert.strictEqual(stlSignature(asciiStl(triangles(turnMove))).signature, original.signature, 'ASCII STL: the same model');
assert.strictEqual(threeMfSignature(threeMf(triangles(turnMove))).signature, original.signature, 'its 3MF: the same model');
assert.strictEqual(geometrySignature(threeMf(triangles(same)), '.3MF').signature, original.signature);

const mirrored = stlSignature(binaryStl(triangles(mirror).map((t) => [t[0], t[2], t[1]])));
assert.notStrictEqual(mirrored.signature, original.signature, 'the mirror image (a left part vs its right part) is not a duplicate');
assert.strictEqual(mirrored.signature.split(':').slice(0, -1).join(':'), original.signature.split(':').slice(0, -1).join(':'), 'it differs only in handedness');

const scaled = stlSignature(binaryStl(triangles(([x, y, z]) => [x * 1.5, y * 1.5, z * 1.5])));
assert.notStrictEqual(scaled.signature, original.signature, 'a scaled copy is a different model');

// A symmetric shape (a cube) has no handedness: 0, and still matches when turned.
const cube = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
const cubeFaces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
const cubeTris = (f) => cubeFaces.map((t) => t.map((i) => f(cube[i])));
const cubeSig = stlSignature(binaryStl(cubeTris(same)));
assert.ok(cubeSig.signature.endsWith(':0'), cubeSig.signature);
assert.ok(Math.abs(cubeSig.volume - 1000) < 1e-6 && Math.abs(cubeSig.area - 600) < 1e-6);

assert.strictEqual(geometrySignature(Buffer.from('x'), '.obj'), null, 'other types: none');
assert.throws(() => stlSignature(Buffer.from('tiny')), /too small/);

const eig = eigenSymmetric([[2, 0, 0], [0, 5, 0], [0, 0, 1]]);
assert.deepStrictEqual(eig.map((e) => Math.round(e.value)), [5, 2, 1]);

console.log('geometry-signature tests passed');
