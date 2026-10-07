#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { install, parseLevel } = require('../src/core/log');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

/** A console-like object that records what it would print. */
function fakeConsole() {
  const out = { lines: [], errors: [] };
  out.log = (line) => out.lines.push(line);
  out.error = (line) => out.errors.push(line);
  out.warn = out.error;
  out.info = out.log;
  out.debug = out.log;
  return out;
}

test('levels are read from the environment value, info by default', () => {
  assert.strictEqual(parseLevel('DEBUG'), 'debug');
  assert.strictEqual(parseLevel(' warning '), 'warn');
  assert.strictEqual(parseLevel(''), 'info');
  assert.strictEqual(parseLevel('loud'), 'info');
});

test('info hides debug; lines get a time and a level; errors go to stderr', () => {
  const target = fakeConsole();
  install(target, { level: 'info' });
  target.debug('each query', { sql: 'SELECT 1' });
  target.log('Server running at %s', 'http://0.0.0.0:5000');
  target.warn('low disk');
  target.error(new Error('boom'));
  assert.strictEqual(target.lines.length, 1);
  assert.match(target.lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO  Server running at http:\/\/0\.0\.0\.0:5000$/);
  assert.match(target.errors[0], /WARN  low disk$/);
  assert.match(target.errors[1], /ERROR Error: boom/);
});

test('debug shows everything, error only errors; installing again changes the level', () => {
  const target = fakeConsole();
  install(target, { level: 'debug', timestamps: false });
  target.debug('detail');
  assert.deepStrictEqual(target.lines, ['DEBUG detail']);
  install(target, { level: 'error' });
  target.log('hidden');
  target.warn('hidden too');
  target.error('shown');
  assert.deepStrictEqual(target.lines, ['DEBUG detail']);
  assert.deepStrictEqual(target.errors, ['ERROR shown']);
});
