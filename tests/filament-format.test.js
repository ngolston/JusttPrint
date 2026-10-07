#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { formatFilamentLabel, normalizeColorHex } = require('../src/core/filament-format');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

test('colors are stored as six upper-case hex digits', () => {
  assert.strictEqual(normalizeColorHex('FF0000,00FF00'), 'FF0000');
  assert.strictEqual(normalizeColorHex('#abc'), 'AABBCC');
  assert.strictEqual(normalizeColorHex('1a2b3cff'), '1A2B3C');
  assert.strictEqual(normalizeColorHex('not a color'), '');
  assert.strictEqual(normalizeColorHex(null), '');
});

test('labels read vendor, name and material', () => {
  assert.strictEqual(formatFilamentLabel({ vendor: 'Polymaker', name: 'PolyTerra Charcoal Black', material: 'PLA' }), 'Polymaker PolyTerra Charcoal Black (PLA)');
  assert.strictEqual(formatFilamentLabel({ name: '' }), 'Unnamed filament');
});
