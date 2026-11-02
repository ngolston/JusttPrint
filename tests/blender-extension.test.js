#!/usr/bin/env node
'use strict';

// Blender saves .blend: with only .blender in the list, turning the file type on found nothing.
const assert = require('assert');
const { ADDITIONAL_FILE_TYPES_CATALOG } = require('../src/core/model-filters');
const { MODEL_MIME_TYPES } = require('../src/server/library-file-routes');

const blender = ADDITIONAL_FILE_TYPES_CATALOG.find((entry) => entry.id === 'blender');
assert.deepStrictEqual(blender.extensions, ['.blend', '.blender']);
for (const ext of blender.extensions) assert.ok(MODEL_MIME_TYPES[ext], ext);

console.log('ok Blender finds .blend and it can be downloaded');
