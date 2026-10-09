#!/usr/bin/env node
'use strict';

/**
 * npm test: runs every *.test.js file with Node and reports which ones failed.
 * Skips node_modules and the end-to-end suite (npm run test:e2e),
 * then runs the TypeScript unit tests in src/web with Vitest (vitest.web.config.mjs),
 * then ESLint (errors fail, warnings are listed: npm run lint) and Prettier (npm run format:check).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'e2e', 'test-results', 'playwright-report']);

function findTests(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTests(full, found);
    else if (entry.name.endsWith('.test.js')) found.push(full);
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

// TypeScript unit tests for the React screens (src/web/**/*.test.ts), run by Vitest.
const vitest = spawnSync(process.execPath, [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.web.config.mjs'], { cwd: root, encoding: 'utf8' });
if (vitest.status !== 0) {
  failed.push('src/web (vitest)');
  console.log('FAIL src/web (vitest)');
  for (const line of `${vitest.stdout || ''}${vitest.stderr || ''}`.trim().split('\n').slice(-20)) console.log(`     ${line}`);
} else {
  const summary = (vitest.stdout || '').split('\n').find((line) => /Tests\s+\d+ passed/.test(line));
  console.log(`ok   src/web (vitest)${summary ? ` -${summary.replace(/\s+/g, ' ')}` : ''}`);
}

// Lint (eslint.config.mjs) and formatting (.prettierrc.json).
const bin = (name) => path.join(root, 'node_modules', '.bin', name);
const lint = spawnSync(bin('eslint'), ['.', '--quiet'], { cwd: root, encoding: 'utf8' });
if (lint.status !== 0) {
  failed.push('eslint');
  console.log('FAIL eslint (npm run lint)');
  for (const line of `${lint.stdout || ''}${lint.stderr || ''}`.trim().split('\n').slice(-20)) console.log(`     ${line}`);
} else {
  console.log('ok   eslint (no errors; npm run lint lists the warnings)');
}
const format = spawnSync(bin('prettier'), ['--check', '.', '--log-level', 'warn'], { cwd: root, encoding: 'utf8' });
if (format.status !== 0) {
  failed.push('prettier');
  console.log('FAIL prettier: files not formatted (npm run format fixes them)');
  for (const line of `${format.stdout || ''}${format.stderr || ''}`.trim().split('\n').slice(-20)) console.log(`     ${line}`);
} else {
  console.log('ok   prettier');
}

console.log(failed.length ? `\n${failed.length} test file(s) failed.` : '\nAll test files passed.');
process.exit(failed.length ? 1 : 0);
