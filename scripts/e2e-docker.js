#!/usr/bin/env node
'use strict';

/**
 * npm run test:e2e:docker: builds the Docker image from this checkout and runs the end-to-end
 * checks (tests/e2e/run.js) against it, so problems that only show in the container (paths,
 * permissions, its Chromium) are caught. Needs Docker running.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IMAGE = process.env.E2E_DOCKER_IMAGE || 'justtprint:e2e';

if (!process.env.E2E_DOCKER_IMAGE) {
  console.log(`# Building ${IMAGE}`);
  const build = spawnSync('docker', ['build', '-t', IMAGE, '.'], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status || 1);
}
const run = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'e2e', 'run.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, E2E_DOCKER_IMAGE: IMAGE }
});
process.exit(run.status === null ? 1 : run.status);
