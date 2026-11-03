#!/usr/bin/env node
'use strict';

// CAD source files that MakerWorld models sometimes include: OpenSCAD, FreeCAD, SketchUp and SolidWorks.
const assert = require('assert');
const { ADDITIONAL_FILE_TYPES_CATALOG } = require('../src/core/model-filters');
const { MODEL_MIME_TYPES } = require('../src/server/library-file-routes');

const byId = (id) => ADDITIONAL_FILE_TYPES_CATALOG.find((entry) => entry.id === id);
assert.deepStrictEqual(byId('scad').extensions, ['.scad']);
assert.deepStrictEqual(byId('fcstd').extensions, ['.fcstd']);
assert.deepStrictEqual(byId('skp').extensions, ['.skp']);
assert.deepStrictEqual(byId('solidworks').extensions, ['.sldprt', '.sldasm']);
for (const id of ['scad', 'fcstd', 'skp', 'solidworks']) for (const ext of byId(id).extensions) assert.ok(MODEL_MIME_TYPES[ext], ext);
const ids = ADDITIONAL_FILE_TYPES_CATALOG.map((entry) => entry.id);
assert.strictEqual(new Set(ids).size, ids.length, 'ids stay unique');

console.log('ok OpenSCAD, FreeCAD, SketchUp and SolidWorks can be scanned and downloaded');
