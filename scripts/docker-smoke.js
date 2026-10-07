#!/usr/bin/env node
'use strict';

/**
 * npm run test:docker: smoke-test the Docker image the way users run it. Builds the image (or
 * uses the one named on the command line), starts it with the test library mounted read-only and
 * an empty data folder, and checks that it becomes healthy, runs as PUID:PGID, logs in, scans
 * STL Home, serves the web UI, renders a thumbnail in its own Chromium, and closes the database
 * on docker stop. Prints the container log when a check fails. Needs Docker; Node built-ins only.
 *
 *   node scripts/docker-smoke.js              build justtprint:smoke from this folder, then test it
 *   node scripts/docker-smoke.js <image>      test an image that is already built
 */

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'library');
const PASSWORD = `smoke-${crypto.randomBytes(6).toString('hex')}`;
const NAME = `justtprint-smoke-${crypto.randomBytes(4).toString('hex')}`;
/** The fixture library: cube.stl, part one.stl, box.3mf and the model inside pack.zip (ZIP support on). */
const FIXTURE_MODELS = 4;

let failed = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`ok   ${name}`);
  else {
    failed++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
  return ok;
}

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs, everyMs = 2000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (_) { /* not ready yet */ }
    if (Date.now() > end) return null;
    await sleep(everyMs);
  }
}

async function main() {
  const image = process.argv[2] || 'justtprint:smoke';
  if (!process.argv[2]) {
    console.log(`# Building ${image}`);
    const build = spawnSync('docker', ['build', '-t', image, ROOT], { stdio: 'inherit' });
    if (build.status !== 0) throw new Error('docker build failed');
  }

  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'justtprint-smoke-')));
  const models = path.join(work, 'models');
  const data = path.join(work, 'data');
  fs.cpSync(FIXTURES, models, { recursive: true });
  fs.mkdirSync(data);
  // Run as this user, so the files the container writes stay ours (and PUID/PGID are tested).
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000;

  console.log(`# Starting ${NAME} (PUID ${uid}, PGID ${gid})`);
  docker(['run', '-d', '--name', NAME, '-p', '127.0.0.1::5000',
    '-v', `${models}:/mnt/models:ro`, '-v', `${data}:/root/.config/justtprint`,
    '-e', `PUID=${uid}`, '-e', `PGID=${gid}`, '-e', `JUSTTPRINT_PASSWORD=${PASSWORD}`,
    '-e', 'STL_HOME=/mnt/models', '-e', 'JUSTTPRINT_ENABLE_ZIP=true', image]);

  let stoppedCleanly = false;
  try {
    const port = docker(['port', NAME, '5000/tcp']).split('\n')[0].split(':').pop();
    const base = `http://127.0.0.1:${port}`;
    const headers = (cookie) => ({ 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) });

    console.log('\n# Start');
    const up = await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 120000);
    check('the server answers /api/health', !!up);
    const healthy = await waitFor(() => docker(['inspect', '-f', '{{.State.Health.Status}}', NAME]) === 'healthy', 180000, 5000);
    check('Docker reports the container healthy (HEALTHCHECK)', !!healthy, docker(['inspect', '-f', '{{.State.Health.Status}}', NAME]));
    // The slim image has no ps: ask Docker for the processes and their user ids.
    const server = docker(['top', NAME, '-eo', 'pid,uid,args']).split('\n').find((line) => /src\/server\/index\.js/.test(line)) || '';
    const serverUid = server.trim().split(/\s+/)[1];
    check(`the server runs as PUID ${uid}, not root`, serverUid === String(uid) && serverUid !== '0', server.trim() || 'no server process');

    console.log('\n# Login');
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: headers(), body: JSON.stringify({ password: PASSWORD }) });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    check('login with JUSTTPRINT_PASSWORD', login.ok && !!cookie, `HTTP ${login.status}`);
    const wrong = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: headers(), body: JSON.stringify({ password: 'wrong-password' }) });
    check('a wrong password is refused', wrong.status === 401, `HTTP ${wrong.status}`);
    const action = async (name, ...args) => {
      const response = await fetch(`${base}/api/actions/${name}`, { method: 'POST', headers: headers(cookie), body: JSON.stringify({ args }) });
      const body = JSON.parse((await response.text()).trim() || '{}');
      if (!response.ok || body.error !== undefined) throw new Error(body.error || `HTTP ${response.status}`);
      return body.result;
    };

    console.log('\n# Library');
    const scanned = await waitFor(async () => ((await action('get-stats')).totalModels === FIXTURE_MODELS), 120000);
    check(`the STL Home scan finds the ${FIXTURE_MODELS} fixture models`, !!scanned, JSON.stringify(await action('get-stats').catch((e) => e.message)));
    const page = await fetch(`${base}/`, { headers: { cookie, accept: 'text/html' } });
    const html = await page.text();
    check('the web UI page loads', page.ok && /web-build\/app\.js/.test(html), `HTTP ${page.status}`);
    const script = await fetch(`${base}/web-build/app.js`, { headers: { cookie } });
    check('the built web UI is in the image', script.ok && Number(script.headers.get('content-length') || (await script.arrayBuffer()).byteLength) > 100000, `HTTP ${script.status}`);
    // The server renders thumbnails for new models itself; no browser is open here.
    const rendered = await waitFor(async () => (await action('get-all-models')).find((model) => model.hasThumbnail), 240000, 5000);
    const image = rendered ? String((await action('get-model', rendered.filePath)).thumbnail || '') : '';
    check('the server renders thumbnails in the container\'s Chromium (no browser open)', image.startsWith('data:image'), rendered ? image.slice(0, 40) : 'none');
    const dbFile = path.join(data, 'data', 'justtprint.db');
    const owner = fs.existsSync(dbFile) ? fs.statSync(dbFile) : null;
    check(`the database in the data volume belongs to PUID ${uid}`, !!owner && owner.uid === uid && owner.gid === gid, owner ? `${owner.uid}:${owner.gid}` : 'missing');

    console.log('\n# Stop');
    docker(['stop', '-t', '60', NAME]);
    const exitCode = docker(['inspect', '-f', '{{.State.ExitCode}}', NAME]);
    const logOutput = spawnSync('docker', ['logs', NAME], { encoding: 'utf8' });
    const logs = `${logOutput.stdout || ''}${logOutput.stderr || ''}`;
    stoppedCleanly = check('docker stop closes the database and exits cleanly', exitCode === '0' && /\[Quit\] Database closed/.test(logs), `exit ${exitCode}`);
  } finally {
    if (failed) {
      console.log('\n# Container log');
      const log = spawnSync('docker', ['logs', '--tail', '200', NAME], { encoding: 'utf8' });
      console.log(`${log.stdout || ''}${log.stderr || ''}`);
    }
    spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
    fs.rmSync(work, { recursive: true, force: true });
  }
  return stoppedCleanly;
}

main()
  .then(() => {
    console.log(`\n${failed ? `${failed} check(s) failed` : 'Docker smoke test passed'}`);
    process.exitCode = failed ? 1 : 0;
  })
  .catch((error) => {
    console.log(`FAIL docker smoke test: ${error.message}`);
    spawnSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
    process.exitCode = 1;
  });
