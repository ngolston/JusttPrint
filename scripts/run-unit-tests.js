#!/usr/bin/env node
'use strict';

/**
 * npm test: runs every *.test.js file with Node and reports which ones failed.
 * Skips node_modules, the end-to-end suite (npm run test:e2e) and TestDriver tests (vitest).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'e2e', 'test-results', 'playwright-report']);
const SKIP_FILES = new Set(['tests/example.test.js']);

function findTests(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTests(full, found);
    else if (entry.name.endsWith('.test.js') && !SKIP_FILES.has(path.relative(root, full))) found.push(full);
  }
  return found;
}

const failed = [];
for (const file of findTests(root).sort()) {
  const name = path.relative(root, file);
  const result = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const failures = output.split('\n').filter((line) => /^FAIL\b|^not ok\b/.test(line));
  if (result.status !== 0 || failures.length) {
    failed.push(name);
    console.log(`FAIL ${name}`);
    for (const line of (failures.length ? failures : output.trim().split('\n').slice(-5))) console.log(`     ${line}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

console.log(failed.length ? `\n${failed.length} test file(s) failed.` : '\nAll test files passed.');
process.exit(failed.length ? 1 : 0);
