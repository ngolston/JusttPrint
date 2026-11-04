#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compareVersions, entriesSince, parseChangelog } = require('./whats-new');

function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    console.error('FAIL ' + name + ':', err.message);
    process.exitCode = 1;
  }
}

const CHANGELOG = `# Changelog

## [Unreleased]

- Not out yet.

## [10.13.0] - 2026-11-05

The sidebar is new.

**Changes:**
- **A dark rail.** With menus.

## [10.12.0] - 2026-11-04

Library is now Models.

## [10.10.0] - 2026-11-03

Home your way.
`;

test('reads each released version with its date and notes, newest first; Unreleased is left out', () => {
  const entries = parseChangelog(CHANGELOG);
  assert.deepStrictEqual(
    entries.map((e) => [e.version, e.date]),
    [
      ['10.13.0', '2026-11-05'],
      ['10.12.0', '2026-11-04'],
      ['10.10.0', '2026-11-03']
    ]
  );
  assert.strictEqual(entries[0].body, 'The sidebar is new.\n\n**Changes:**\n- **A dark rail.** With menus.');
});

test('shows the versions since the one seen last, up to the running one', () => {
  assert.deepStrictEqual(
    entriesSince(CHANGELOG, '10.10.0', '10.13.0').map((e) => e.version),
    ['10.13.0', '10.12.0']
  );
  assert.deepStrictEqual(
    entriesSince(CHANGELOG, '10.10.0', '10.12.0').map((e) => e.version),
    ['10.12.0']
  );
  assert.deepStrictEqual(entriesSince(CHANGELOG, '10.13.0', '10.13.0'), []);
});

test('without a version seen, only the running version', () => {
  assert.deepStrictEqual(
    entriesSince(CHANGELOG, null, '10.13.0').map((e) => e.version),
    ['10.13.0']
  );
});

test('compares versions as numbers', () => {
  assert.strictEqual(compareVersions('10.9.0', '10.10.0'), -1);
  assert.strictEqual(compareVersions('10.10', '10.10.0'), 0);
  assert.strictEqual(compareVersions('11.0.0', '10.99.9'), 1);
});

test('the shipped changelog has an entry for the running version', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
  const { version } = require('../../package.json');
  assert.strictEqual(entriesSince(text, null, version)[0]?.version, version);
});
