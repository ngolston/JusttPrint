#!/usr/bin/env node
'use strict';

// Printer controls (bambu-control.js): the command for each, and when the printer cannot do it.

const assert = require('assert');
// Answers read as either shape in the checks below.
const commandFor = /** @type {(action: string, value: any, summary: any) => any} */ (require('./bambu-control').commandFor);

function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    console.error('FAIL ' + name + ':', err.message);
    process.exitCode = 1;
  }
}

const printing = { state: 'printing' };
const paused = { state: 'paused' };
const idle = { state: 'idle' };
const print = (made) => ('payload' in made ? made.payload.print || made.payload.system : made);

test('pause while printing, resume while paused, stop either way', () => {
  assert.strictEqual(print(commandFor('pause', null, printing)).command, 'pause');
  assert.deepStrictEqual(commandFor('pause', null, paused), { error: 'Nothing is printing to pause' });
  assert.strictEqual(print(commandFor('resume', null, paused)).command, 'resume');
  assert.deepStrictEqual(commandFor('resume', null, printing), { error: 'The print is not paused' });
  assert.strictEqual(print(commandFor('stop', null, paused)).command, 'stop');
  assert.deepStrictEqual(commandFor('stop', null, idle), { error: 'Nothing is printing to stop' });
});

test('the speed is 1 to 4, while printing', () => {
  const made = print(commandFor('speed', 3, printing));
  assert.deepStrictEqual([made.command, made.param], ['print_speed', '3']);
  assert.match(commandFor('speed', 5, printing).error, /1 \(Silent\) to 4/);
  assert.match(commandFor('speed', 2, idle).error, /only while printing/);
});

test('the chamber light turns on and off at any time', () => {
  const on = print(commandFor('light', 'on', idle));
  assert.deepStrictEqual([on.command, on.led_node, on.led_mode], ['ledctrl', 'chamber_light', 'on']);
  assert.strictEqual(print(commandFor('light', 'off', printing)).led_mode, 'off');
  assert.match(commandFor('light', 'dim', idle).error, /'on' or 'off'/);
  assert.match(commandFor('home', null, idle).error, /Unknown printer control/);
});
