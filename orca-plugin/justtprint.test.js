#!/usr/bin/env node
'use strict';

// Runs the OrcaSlicer plugin's Python tests (test_justtprint.py) with python3, so npm test covers
// them. Without python3 on this computer they are skipped, with a note.

const { spawnSync } = require('child_process');
const path = require('path');

const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0);
if (!python) {
  console.log('ok   skipped: no python3 to run orca-plugin/test_justtprint.py');
  process.exit(0);
}
const result = spawnSync(python, ['-I', '-m', 'unittest', 'discover', '-s', __dirname, '-p', 'test_*.py'], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8'
});
const output = `${result.stdout || ''}${result.stderr || ''}`;
if (result.status !== 0) {
  console.log(output);
  console.log('FAIL orca-plugin/test_justtprint.py');
  process.exit(1);
}
console.log(`ok   orca-plugin/test_justtprint.py (${(/Ran (\d+) tests?/.exec(output) || [])[1] || '?'} tests)`);
