#!/usr/bin/env node
'use strict';

/**
 * End-to-end test: starts the server on plain Node with a fresh data folder and a copy of
 * tests/fixtures/library, then checks the API, security rules and the web UI in a browser.
 *
 *   npm run test:e2e
 *   npm run test:e2e:docker     the same checks against the Docker image (scripts/e2e-docker.js)
 *
 * With E2E_DOCKER_IMAGE set, the server runs in that image instead: the test folders (and /tmp)
 * are mounted at the same paths, so the checks that look at files on disk work unchanged, and
 * the container runs as this user (PUID/PGID), so the files stay writable here.
 *
 * Needs a Chromium-based browser for the thumbnail worker and the browser checks:
 * CHROME_PATH=/path/to/chrome (on macOS, Google Chrome is found automatically).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..', '..');
const WORK = path.join(__dirname, '.work');
const LIBRARY = path.join(WORK, 'library');
const DATA = path.join(WORK, 'data');
/** A folder outside the app for Choose Folder (the e2e library is inside the app folder, which cannot be browsed). */
let browseDir = '';
/** The library folder the upload checks use (outside the app folder, like browseDir). */
let uploadLibrary = '';
const PASSWORD = 'e2e-test-password';
const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE || '';
/** The server's own folder (never scanned or browsed): this checkout, or /app inside the image. */
const APP_DIR = DOCKER_IMAGE ? '/app' : ROOT;
/** How the server reaches helpers this script runs (the fake AI service): the host, from inside a container. */
const HOST_FOR_SERVER = DOCKER_IMAGE ? 'host.docker.internal' : '127.0.0.1';
/** The container renders thumbnails in software (SwiftShader): steps that wait for one get longer there. */
const SLOW = DOCKER_IMAGE ? 3 : 1;
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME = process.env.CHROME_PATH || (fs.existsSync(MAC_CHROME) ? MAC_CHROME : '');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`ok   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A PNG of noise (it does not compress), as a data URL: a large stored thumbnail. */
function noisePng(width, height) {
  const zlib = require('zlib');
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let seed = 7;
  for (let i = 0; i < raw.length; i++) raw[i] = i % (width * 3 + 1) === 0 ? 0 : (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** Width and height of a WebP data URL (lossy, lossless or extended), or null. */
function webpSize(dataUrl) {
  const buf = Buffer.from(String(dataUrl).split(',')[1] || '', 'base64');
  if (buf.length < 30 || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  return null;
}

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (_) {
      /* retry */
    }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(500);
  }
}

function startServer(port) {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.cpSync(path.join(ROOT, 'tests', 'fixtures', 'library'), LIBRARY, { recursive: true });
  const log = fs.openSync(path.join(WORK, 'server.log'), 'w');
  if (DOCKER_IMAGE) return startContainer(port, log);
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.js')], {
    cwd: ROOT,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      JUSTTPRINT_USER_DATA: DATA,
      JUSTTPRINT_PORT: String(port),
      JUSTTPRINT_PASSWORD: PASSWORD,
      // Tiny upload pieces, so the upload checks send a model in several pieces.
      JUSTTPRINT_UPLOAD_CHUNK_MB: '0.0001', // the 256-byte minimum
      STL_HOME: LIBRARY,
      // Keep Move to Trash inside the work folder (the home trash is the fallback on a single-drive machine).
      XDG_DATA_HOME: path.join(WORK, 'share'),
      ...(CHROME ? { JUSTTPRINT_CHROMIUM: CHROME } : {})
    }
  });
  return child;
}

/** The server in the Docker image, with the same settings and the test folders at the same paths. */
function startContainer(port, log) {
  const name = `justtprint-e2e-${process.pid}`;
  const folders = [...new Set([WORK, '/tmp', fs.realpathSync('/tmp')])];
  const env = {
    JUSTTPRINT_USER_DATA: DATA,
    JUSTTPRINT_PORT: String(port),
    JUSTTPRINT_PASSWORD: PASSWORD,
    JUSTTPRINT_UPLOAD_CHUNK_MB: '0.0001',
    STL_HOME: LIBRARY,
    XDG_DATA_HOME: path.join(WORK, 'share'),
    PUID: String(process.getuid()),
    PGID: String(process.getgid()),
    ...(process.env.JUSTTPRINT_LOG_LEVEL ? { JUSTTPRINT_LOG_LEVEL: process.env.JUSTTPRINT_LOG_LEVEL } : {})
  };
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      name,
      '-p',
      `127.0.0.1:${port}:${port}`,
      '--add-host',
      'host.docker.internal:host-gateway',
      ...folders.flatMap((folder) => ['-v', `${folder}:${folder}`]),
      ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      DOCKER_IMAGE
    ],
    { cwd: ROOT, stdio: ['ignore', log, log] }
  );
  child.containerName = name;
  console.log(`# Server in Docker image ${DOCKER_IMAGE} (container ${name})`);
  return child;
}

function stopServer(child) {
  if (child && child.containerName) {
    return new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        spawn('docker', ['rm', '-f', child.containerName]);
        resolve();
      }, 30000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      spawn('docker', ['stop', '-t', '15', child.containerName], { stdio: 'ignore' });
    });
  }
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 15000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/** Small HTTP client that keeps the session cookie. */
function client(base) {
  let cookie = '';
  async function request(urlPath, { method = 'GET', headers = {}, body, json, redirect = 'manual', useCookie = true } = {}) {
    const response = await fetch(base + urlPath, {
      method,
      redirect,
      headers: {
        ...(useCookie && cookie ? { cookie } : {}),
        ...(json ? { 'content-type': 'application/json' } : {}),
        ...headers
      },
      body: json ? JSON.stringify(json) : body
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie && useCookie) cookie = setCookie.split(';')[0];
    return response;
  }
  return { request, cookie: () => cookie };
}

/** One call to the HTTP API (POST /api/actions/<name>). Resolves to { status, result } or { status, error }. */
async function invoke(base, { cookie, origin, client }, channel, args = []) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  // The browser sends its WebSocket's client id, so the server can answer that browser only.
  if (client) headers['X-JusttPrint-Client'] = client;
  try {
    const response = await fetch(`${base}/api/actions/${encodeURIComponent(channel)}`, { method: 'POST', headers, body: JSON.stringify({ args }) });
    if (response.ok && (response.headers.get('content-type') || '').startsWith('application/octet-stream')) {
      return { status: response.status, result: Buffer.from(await response.arrayBuffer()) };
    }
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { error: text };
    }
    return 'error' in data ? { status: response.status, error: data.error } : { status: response.status, result: data.result };
  } catch (error) {
    return { error: error.message };
  }
}

/** Open the event WebSocket. Resolves to { hello } (the first message), { rejected: status } or { error }. */
function openEvents(wsUrl, { cookie, origin }, send) {
  return new Promise((resolve) => {
    const headers = { Origin: origin };
    if (cookie) headers.Cookie = cookie;
    const ws = new WebSocket(wsUrl, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ error: 'timeout' });
    }, 10000);
    const messages = [];
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      messages.push(message);
      if (messages.length === 1 && send) {
        ws.send(JSON.stringify(send));
        return;
      }
      // Broadcast events (refresh-grid, ...) can arrive in between; wait for the reply to `send`.
      if (send && message.id !== send.id) return;
      clearTimeout(timer);
      ws.close();
      resolve({ hello: messages[0], reply: send ? message : undefined });
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve({ rejected: res.statusCode });
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      resolve({ error: error.message });
    });
  });
}

/** A browser's event socket kept open: its client id and the event channels it receives. */
function listenEvents(wsUrl, { cookie, origin }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { Origin: origin, Cookie: cookie } });
    const channels = [];
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(null);
    }, 10000);
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello') {
        clearTimeout(timer);
        resolve({ clientId: message.clientId, channels, close: () => ws.close() });
      } else if (message.type === 'event') {
        channels.push(message.channel);
      }
    });
    ws.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function apiChecks(base, wsUrl) {
  const anon = client(base);
  const http = client(base);
  const file = (p) => `/api/file/${encodeURIComponent(p)}`;
  const download = (p) => `/api/download/${encodeURIComponent(p)}`;
  const cube = path.join(LIBRARY, 'Designer A', 'cube.stl');
  const box = path.join(LIBRARY, 'Designer B', 'box.3mf');

  console.log('\n# HTTP and login');
  check('health without login', (await anon.request('/api/health')).status === 200);
  // Images are in assets/; the login page, share pages and installing need some before logging in.
  const imageType = async (p) => {
    const r = await anon.request(p);
    return r.status === 200 ? r.headers.get('content-type') || '' : `status ${r.status}`;
  };
  check(
    'icons load without login, also /favicon.ico',
    /image\/png/.test(await imageType('/assets/logo.png')) &&
      /image\/png/.test(await imageType('/assets/pwa-maskable-512.png')) &&
      /icon/.test(await imageType('/favicon.ico')) &&
      /icon/.test(await imageType('/assets/favicon.ico'))
  );
  const home = await anon.request('/', { headers: { accept: 'text/html' } });
  check('home redirects to login', home.status === 302 && /\/login/.test(home.headers.get('location') || ''));
  check('API needs login', (await anon.request(file(cube))).status === 401);
  check('wrong password refused', (await anon.request('/api/auth/login', { method: 'POST', json: { password: 'nope-nope' } })).status === 401);
  check('login', (await http.request('/api/auth/login', { method: 'POST', json: { password: PASSWORD } })).status === 200);
  // The server scans STL Home in the background after it starts listening.
  const scanned = await waitFor(
    async () => {
      const stats = await invoke(base, { cookie: http.cookie(), origin: base }, 'get-stats');
      return stats.result && stats.result.totalModels === 4 ? 4 : null;
    },
    60000,
    'STL Home scan'
  ).catch((error) => error.message);
  check('startup scan found the 4 fixture models', scanned === 4, scanned);
  // Folder watching (src/server/folder-watch.js): a file added to STL Home appears without a scan, a deleted one goes.
  const ctxCookie = () => ({ cookie: http.cookie(), origin: base });
  const watchStatus = (await invoke(base, ctxCookie(), 'get-folder-watch-status')).result || {};
  check(
    'STL Home folders are watched',
    watchStatus.enabled === true && watchStatus.roots?.some((root) => root.path === LIBRARY && root.folders >= 4 && !root.error),
    JSON.stringify(watchStatus)
  );
  const neighbour = path.join(LIBRARY, 'Designer B', 'box.3mf');
  const neighbourId = ((await invoke(base, ctxCookie(), 'get-model', [neighbour])).result || {}).id;
  const watchedDir = path.join(LIBRARY, 'Designer B', 'Watched Drop');
  const watchedFile = path.join(watchedDir, 'dropped.stl');
  fs.mkdirSync(watchedDir);
  fs.copyFileSync(cube, watchedFile);
  const hasModel = async (p) => ((await invoke(base, ctxCookie(), 'get-all-models')).result || []).some((m) => m.filePath === p);
  const appeared = await waitFor(async () => ((await hasModel(watchedFile)) ? true : null), 30000, 'watched file').catch(() => false);
  check('a model copied into a new STL Home folder appears without a scan', appeared === true);
  fs.rmSync(watchedDir, { recursive: true });
  const gone = await waitFor(async () => (!(await hasModel(watchedFile)) ? true : null), 30000, 'deleted watched file').catch(() => false);
  check('a deleted model leaves the library without a scan', gone === true && ((await invoke(base, ctxCookie(), 'get-stats')).result || {}).totalModels === 4);
  // The rescans must not drop and re-add the other models in the folder (that loses their tags and history).
  const neighbourAfter = ((await invoke(base, ctxCookie(), 'get-model', [neighbour])).result || {}).id;
  check('a rescan keeps the other models in the folder (same record)', !!neighbourId && neighbourAfter === neighbourId, `${neighbourId} -> ${neighbourAfter}`);
  check(
    'a watched subfolder is not added to the scanned folders',
    !JSON.stringify((await invoke(base, ctxCookie(), 'get-setting', ['scannedDirectories'])).result || '').includes('Designer B')
  );
  check('home after login', (await http.request('/')).status === 200);
  // The page links app.js and app.css with the version, so caches (Cloudflare's, for one) cannot serve an updated page old files.
  const pageHtml = await (await fetch(`${base}/`, { headers: { cookie: http.cookie() } })).text();
  const appVersion = require(path.join(ROOT, 'package.json')).version;
  check(
    'the page asks for this build’s script and app.css of this version',
    pageHtml.includes(`web-build/app.css?v=${appVersion}-`) && /web-build\/app-[A-Za-z0-9_-]+\.js/.test(pageHtml),
    (pageHtml.match(/web-build\/app\.(?:css|js)[^"']*/g) || []).join(' ')
  );
  check('web asset served', (await http.request('/slicer-protocol.js')).status === 200);
  for (const hidden of ['/main.js', '/spoolman.js', '/src/core/spoolman.js', '/package.json', '/node_modules/express/package.json', '/src/server/index.js']) {
    check(`${hidden} not served`, (await http.request(hidden)).status === 404);
  }

  console.log('\n# Security headers');
  const health = await http.request('/api/health');
  check('nosniff', health.headers.get('x-content-type-options') === 'nosniff');
  check('frame-ancestors', /frame-ancestors 'self'/.test(health.headers.get('content-security-policy') || ''));
  check(
    'CSP allows only script files from this server',
    /script-src 'self' 'wasm-unsafe-eval';/.test(health.headers.get('content-security-policy') || '') &&
      !/unsafe-inline/.test(health.headers.get('content-security-policy') || '')
  );
  const cspOf = async (urlPath) => (await http.request(urlPath)).headers.get('content-security-policy') || '';
  check('page scripts may not eval', !/'unsafe-eval'/.test(await cspOf('/slicer-protocol.js')));
  check(
    'the parse worker may not eval either (STEP library built without it)',
    !/'unsafe-eval'/.test(await cspOf('/web-build/parse-worker.js')) && /'wasm-unsafe-eval'/.test(await cspOf('/web-build/parse-worker.js'))
  );
  check('library page does not allow Puter.js', !/js\.puter\.com/.test(await cspOf('/')));
  check('Puter sign-in page allows Puter.js only', /script-src 'self' https:\/\/js\.puter\.com;/.test(await cspOf('/puter-signin.html')));
  check('Puter sign-in page needs login', (await anon.request('/puter-signin.html')).status !== 200);
  check('no X-Powered-By', !health.headers.get('x-powered-by'));

  console.log('\n# Library files');
  check('library STL served', (await http.request(file(cube))).status === 200);
  check('library 3MF download', (await http.request(download(box))).status === 200);
  check('/etc/passwd via file refused', (await http.request(file('/etc/passwd'))).status === 403);
  check('/etc/passwd via download refused', (await http.request(download('/etc/passwd'))).status === 403);
  check('traversal out of library refused', (await http.request(file(path.join(LIBRARY, '..', '..', 'package.json')))).status === 403);
  check('live database refused', (await http.request(download(path.join(DATA, 'data', 'justtprint.db')))).status === 403);
  const crossSite = await http.request('/api/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example' } });
  check('cross-site POST refused', crossSite.status === 403);

  console.log('\n# HTTP API');
  const origin = base;
  const cookie = http.cookie();
  const version = require(path.join(ROOT, 'package.json')).version;
  check('API without login refused', (await invoke(base, { origin }, 'get-setting', ['currentVersion'])).status === 401);
  check('API from another origin refused', (await invoke(base, { cookie, origin: 'https://evil.example' }, 'get-setting', ['currentVersion'])).status === 403);
  check('API with login', (await invoke(base, { cookie, origin }, 'get-setting', ['currentVersion'])).result === version);
  check('secret settings hidden', (await invoke(base, { cookie, origin }, 'get-setting', ['serverPasswordHash'])).result === null);
  for (const channel of [
    'getSetting',
    'saveSetting',
    'quitApp',
    'open-path',
    'fetch-makerworld-page',
    'puter-ai-chat',
    'is-server-mode',
    'import-extension-inbox',
    'get-default-extension-inbox-directory'
  ]) {
    check(`${channel} is not an action`, (await invoke(base, { cookie, origin }, channel, [])).status === 404);
  }
  const wrongType = await invoke(base, { cookie, origin }, 'get-setting', [42]);
  check('wrong argument type refused', wrongType.status === 400 && /must be a string/.test(wrongType.error), JSON.stringify(wrongType));
  check('missing argument refused', (await invoke(base, { cookie, origin }, 'get-model', [])).status === 400);
  check('extra arguments refused', (await invoke(base, { cookie, origin }, 'get-stats', ['extra'])).status === 400);
  const badJson = await http.request('/api/actions/get-stats', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{not json' });
  check('malformed JSON refused', badJson.status === 400 && /json/.test(badJson.headers.get('content-type') || ''));

  console.log('\n# WebSocket (events)');
  check('WS without login, other origin', (await openEvents(wsUrl, { origin: 'https://evil.example' })).rejected === 403);
  check('WS without login, same origin', (await openEvents(wsUrl, { origin })).rejected === 401);
  check('WS with login, other origin', (await openEvents(wsUrl, { cookie, origin: 'https://evil.example' })).rejected === 403);
  const eventSocket = await openEvents(wsUrl, { cookie, origin }, { id: 1, channel: 'get-setting', args: ['currentVersion'] });
  check(
    'WS sends a client id',
    eventSocket.hello && eventSocket.hello.type === 'hello' && /^[0-9a-f]{32}$/.test(eventSocket.hello.clientId),
    JSON.stringify(eventSocket)
  );
  check(
    'WS no longer runs actions',
    eventSocket.reply && eventSocket.reply.type === 'error' && /api\/actions/.test(eventSocket.reply.error),
    JSON.stringify(eventSocket.reply)
  );

  console.log('\n# Path guard');
  const refused = (res, pattern) => res.status === 403 && typeof res.error === 'string' && pattern.test(res.error);
  check('read /etc/passwd refused', refused(await invoke(base, { cookie, origin }, 'read-model-file', ['/etc/passwd']), /outside the library/));
  check(
    'delete live database refused',
    refused(await invoke(base, { cookie, origin }, 'delete-file', [path.join(DATA, 'data', 'justtprint.db')]), /outside the library/)
  );
  check('scan /etc refused', refused(await invoke(base, { cookie, origin }, 'scan-directory', ['/etc']), /cannot be scanned/));
  // The old Thangs page scraper (headless Chromium) is gone: nothing called it.
  check('the Thangs page scraper is gone', (await invoke(base, { cookie, origin }, 'fetch-thangs-page', ['https://thangs.com/m/1'])).status === 404);
  check('scan of the app folder refused', refused(await invoke(base, { cookie, origin }, 'scan-directory', [path.join(APP_DIR, 'src')]), /cannot be scanned/));
  check('move out of library refused', refused(await invoke(base, { cookie, origin }, 'move-files', [[cube], '/tmp']), /outside the library/));
  // Choose Folder (browse-folders): the same folders as scanning; system, app and data folders are refused.
  browseDir = fs.realpathSync(fs.mkdtempSync('/tmp/justtprint-e2e-browse-'));
  fs.mkdirSync(path.join(browseDir, 'Prints', 'Benchy'), { recursive: true });
  fs.mkdirSync(path.join(browseDir, '.cache'));
  fs.writeFileSync(path.join(browseDir, 'part.stl'), 'solid');
  const placesOnly = await invoke(base, { cookie, origin }, 'browse-folders', []);
  check(
    'Choose Folder lists places and no folder yet',
    Array.isArray(placesOnly.result?.places) &&
      placesOnly.result.path === null &&
      !placesOnly.result.places.some((place) => place.path === '/' || place.path.startsWith(APP_DIR)),
    JSON.stringify(placesOnly).slice(0, 300)
  );
  const browsed = (await invoke(base, { cookie, origin }, 'browse-folders', [browseDir])).result;
  check(
    'Choose Folder lists subfolders only (no files or hidden folders)',
    browsed?.path === browseDir && JSON.stringify(browsed.folders.map((f) => f.name)) === '["Prints"]' && browsed.parent === path.dirname(browseDir),
    JSON.stringify(browsed)
  );
  for (const [what, dir] of [
    ['/etc', '/etc'],
    ['the app folder', APP_DIR],
    ['the data folder', DATA],
    ['/', '/']
  ]) {
    const res = await invoke(base, { cookie, origin }, 'browse-folders', [dir]);
    check(`Choose Folder refuses ${what}`, /cannot be browsed/.test(res.result?.error || '') && res.result.path === null, JSON.stringify(res).slice(0, 200));
  }
  const read = await invoke(base, { cookie, origin }, 'read-model-file', [cube]);
  check('read library file returns its bytes', Buffer.isBuffer(read.result) && read.result.equals(fs.readFileSync(cube)), read.error);

  console.log('\n# MCP');
  const info = await invoke(base, { cookie, origin }, 'get-server-access-info');
  const token = info.result && info.result.apiToken;
  check('API token available', typeof token === 'string' && token.startsWith('pv_'));
  const mcpBody = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_models', arguments: { limit: 10 } } };
  check('MCP without token refused', (await anon.request('/mcp', { method: 'POST', json: mcpBody, useCookie: false })).status === 401);
  const mcp = await anon.request('/mcp', { method: 'POST', json: mcpBody, useCookie: false, headers: { authorization: `Bearer ${token}` } });
  const mcpText = await mcp.text();
  check(
    'MCP with token finds library models',
    mcp.status === 200 && mcpText.includes('cube.stl') && mcpText.includes('pack.zip') && !mcpText.includes('pack.zip::')
  );
  const mcpTool = async (name, args = {}) => {
    const res = await anon.request('/mcp', {
      method: 'POST',
      json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      useCookie: false,
      headers: { authorization: `Bearer ${token}` }
    });
    return { status: res.status, text: await res.text() };
  };
  const mcpStats = await mcpTool('get_library_stats');
  check(
    'MCP library stats',
    mcpStats.status === 200 && /totalModels/.test(mcpStats.text) && !/"isError":\s*true/.test(mcpStats.text),
    mcpStats.text.slice(0, 200)
  );
  const mcpLinks = await mcpTool('check_model_links', { text: 'see https://www.printables.com/model/3161-3d-benchy and https://www.thingiverse.com/thing:42' });
  check(
    'MCP finds model links in text (Add Links)',
    mcpLinks.status === 200 && /printables/.test(mcpLinks.text) && /thingiverse/.test(mcpLinks.text) && !/"isError":\s*true/.test(mcpLinks.text),
    mcpLinks.text.slice(0, 200)
  );
  const mcpNoLinks = await mcpTool('import_model_links', { text: 'no links here' });
  check(
    'MCP import_model_links says when there are no links',
    /"isError":\s*true/.test(mcpNoLinks.text) && /No Printables/.test(mcpNoLinks.text),
    mcpNoLinks.text.slice(0, 200)
  );
  // Downloads go to the Upload folder (8.4), whatever folder is named; without one MCP is told to set it.
  const mcpOutside = await mcpTool('import_model_links', { links: ['https://www.printables.com/model/3161'], downloadFolder: '/etc' });
  check(
    'MCP import_model_links downloads only into the Upload folder, and asks for one',
    /"isError":\s*true/.test(mcpOutside.text) && /Upload folder/.test(mcpOutside.text) && !fs.existsSync('/etc/3161'),
    mcpOutside.text.slice(0, 200)
  );
  const mcpTree = await mcpTool('get_folder_tree');
  check(
    'MCP folder tree',
    mcpTree.status === 200 && mcpTree.text.includes('Designer A') && !/"isError":\s*true/.test(mcpTree.text),
    mcpTree.text.slice(0, 200)
  );
  const backupMcp = await anon.request('/mcp', {
    method: 'POST',
    useCookie: false,
    headers: { authorization: `Bearer ${token}` },
    json: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'backup_database', arguments: { destPath: '/etc/evil.db' } } }
  });
  check('MCP backup outside data folder refused', /Can only write/.test(await backupMcp.text()));

  console.log('\n# Inventory');
  const ask = (channel, args) => invoke(base, { cookie, origin }, channel, args);
  const printer = (await ask('save-printer', [{ nickname: 'E2E Printer', firmwareType: 'Klipper' }])).result;
  const printers = (await ask('get-all-printers')).result || [];
  check('printer saved and listed', !!printer && printers.some((p) => p.id === printer.id && p.nickname === 'E2E Printer'));
  if (printer) {
    await ask('save-printer-maintenance-log', [{ printer_id: printer.id, title: 'Nozzle swap', maintenance_type: 'nozzle' }]);
    const logs = (await ask('get-printer-maintenance-logs', [printer.id])).result || [];
    check(
      'printer maintenance log saved',
      logs.some((l) => l.title === 'Nozzle swap')
    );
    const removed = (await ask('delete-printer', [printer.id])).result;
    check('printer deleted', removed === true && !((await ask('get-all-printers')).result || []).some((p) => p.id === printer.id));
  }
  const savedPart = (await ask('save-part', [{ name: 'E2E Magnet', quantity: 12, unit: 'pcs' }])).result;
  check('part saved and listed', !!savedPart && ((await ask('get-all-parts')).result || []).some((p) => p.id === savedPart.id && p.quantity === 12));
  // Filament was removed in 7.0: its actions are gone, and models carry no filaments.
  for (const gone of ['get-all-filaments', 'save-filament', 'delete-filament', 'get-model-filaments', 'sync-spoolman-filaments', 'test-spoolman-connection']) {
    check(`${gone} is gone`, (await ask(gone, [])).status === 404);
  }
  check('models carry no filaments', !('filaments' in ((await ask('get-model', [cube])).result || {})));
  const names = async (filters) =>
    ((await ask('get-models-filtered', [filters])).result || [])
      .map((m) => m.fileName)
      .sort()
      .join(',');
  const term = (value) => ({ t: 'clause', field: 'all', value });
  check('search: one word', (await names({ search: 'cube' })) === 'cube.stl', await names({ search: 'cube' }));
  const either = await names({ searchTokens: [term('cube'), { t: 'op', op: 'OR' }, term('box')] });
  check('search: OR', either === 'box.3mf,cube.stl', either);
  const notCube = await names({ searchTokens: [{ t: 'not' }, term('cube')] });
  check('search: NOT', notCube.length > 0 && !notCube.includes('cube.stl'), notCube);
  const both = await names({ searchTokens: [term('cube'), { t: 'op', op: 'AND' }, term('box')] });
  check('search: AND with no match', both === '', both);

  const tag = (await ask('save-tag', ['e2e-tag'])).result;
  check('tag saved and listed', !!tag && ((await ask('get-all-tags')).result || []).some((t) => t.id === tag.id), JSON.stringify(tag));
  if (tag) {
    await ask('rename-tag', [tag.id, 'e2e-renamed']);
    const renamed = ((await ask('get-all-tags')).result || []).find((t) => t.id === tag.id);
    check('tag renamed', renamed && renamed.name === 'e2e-renamed', JSON.stringify(renamed));
    check('tag model count', renamed && renamed.model_count === 0, JSON.stringify(renamed));
    await ask('delete-tag', [tag.id]);
    check('tag deleted', !((await ask('get-all-tags')).result || []).some((t) => t.id === tag.id));
  }

  // Undo of a tag merge and a tag delete (restore-tag; the Tag Manager and the Tags page use it).
  const tagsOf = async (p) => ((await ask('get-model', [p])).result || {}).tags || [];
  const cubeTagsBefore = await tagsOf(cube);
  const boxTagsBefore = await tagsOf(box);
  await ask('update-models-batch', [
    [
      { filePath: cube, tags: [...cubeTagsBefore, 'e2e-undo-from'] },
      { filePath: box, tags: [...boxTagsBefore, 'e2e-undo-from', 'e2e-undo-into'] }
    ]
  ]);
  const tagNamed = async (name) => ((await ask('get-all-tags')).result || []).find((t) => t.name.toLowerCase() === name.toLowerCase());
  const fromTag = await tagNamed('e2e-undo-from');
  const merge = fromTag ? (await ask('rename-tag', [fromTag.id, 'E2E-UNDO-INTO'])).result || {} : {};
  check(
    'a tag merge says how to undo it',
    merge.merged === true && merge.undo && merge.undo.modelIds.length === 2 && merge.undo.addedModelIds.length === 1,
    JSON.stringify(merge)
  );
  if (merge.undo) await ask('restore-tag', [merge.undo]);
  const cubeAfterUndo = await tagsOf(cube);
  const boxAfterUndo = await tagsOf(box);
  check(
    'undoing a merge splits the tags again',
    cubeAfterUndo.includes('e2e-undo-from') &&
      !cubeAfterUndo.some((t) => /e2e-undo-into/i.test(t)) &&
      boxAfterUndo.includes('e2e-undo-from') &&
      boxAfterUndo.includes('e2e-undo-into'),
    JSON.stringify({ cubeAfterUndo, boxAfterUndo })
  );
  const intoTag = await tagNamed('e2e-undo-into');
  const deletedTag = intoTag ? (await ask('delete-tag', [intoTag.id])).result || {} : {};
  check('a tag delete says which models had it', deletedTag.name === 'e2e-undo-into' && (deletedTag.modelIds || []).length === 1, JSON.stringify(deletedTag));
  if (deletedTag.name) await ask('restore-tag', [{ name: deletedTag.name, modelIds: deletedTag.modelIds }]);
  check('undoing a delete puts the tag back on its models', (await tagsOf(box)).includes('e2e-undo-into'));
  await ask('update-models-batch', [
    [
      { filePath: cube, tags: cubeTagsBefore },
      { filePath: box, tags: boxTagsBefore }
    ]
  ]);
  for (const name of ['e2e-undo-from', 'e2e-undo-into']) {
    const leftover = await tagNamed(name);
    if (leftover) await ask('delete-tag', [leftover.id]);
  }

  const cubeHash = (await ask('calculate-file-hash', [cube])).result;
  const expectedHash = require('crypto').createHash('md5').update(fs.readFileSync(cube)).digest('hex');
  check('file hash is the MD5 of the file', cubeHash === expectedHash, `${cubeHash} vs ${expectedHash}`);
  const duplicates = await ask('get-duplicates', [false]);
  check('duplicates query runs', Array.isArray(duplicates.result), duplicates.error);

  await ask('save-slicer', [{ name: 'E2E Slicer', path: '/usr/bin/e2e-slicer' }]);
  const slicer = ((await ask('get-slicers')).result || []).find((s) => s.name === 'E2E Slicer');
  check('slicer saved and listed', !!slicer);
  if (slicer) {
    // Send to Slicer: the server only builds the helper command; it never starts a program.
    const sent = await ask('open-file-in-slicer', [{ filePaths: [cube], slicerId: slicer.id }]);
    const command = (sent.result || {}).command || {};
    check(
      'Send to Slicer returns a helper command',
      command.type === 'open-in-slicer' && command.slicerPath === '/usr/bin/e2e-slicer' && command.filePaths[0] === cube && !!command.downloadToken,
      sent.error || JSON.stringify(sent.result)
    );
    const helperDownload = await fetch(`${base}/api/download/${encodeURIComponent(cube)}?token=${encodeURIComponent(command.downloadToken || '')}`);
    check('helper can download with the command token (no login)', helperDownload.status === 200, helperDownload.status);
    const zipEntry = path.join(LIBRARY, 'Designer C', 'pack.zip') + '::inner/widget.stl';
    const zipCommand = ((await ask('open-file-in-slicer', [{ filePaths: [zipEntry], slicerId: slicer.id }])).result || {}).command || {};
    const zipDownload = await fetch(`${base}/api/download/${encodeURIComponent(zipEntry)}?token=${encodeURIComponent(zipCommand.downloadToken || '')}`);
    check(
      'helper can download a ZIP entry',
      zipCommand.isZipEntry === true && zipDownload.status === 200 && (await zipDownload.arrayBuffer()).byteLength > 0,
      zipDownload.status
    );
    const menuWithSlicer = (await ask('show-context-menu', [[cube]])).result || {};
    const slicerItem = (menuWithSlicer.items || []).flatMap((i) => i.submenu || []).find((i) => i.clientAction);
    check(
      'context menu slicer item carries a helper command',
      !!slicerItem && slicerItem.clientAction.slicerPath === '/usr/bin/e2e-slicer' && !!slicerItem.clientAction.downloadToken,
      JSON.stringify(slicerItem)
    );
    const spawn = await ask('execute-client-command', [{ type: 'open-in-slicer', slicerPath: '/bin/sh', filePaths: [cube] }]);
    check('server cannot be told to run a program (execute-client-command removed)', !!spawn.error, JSON.stringify(spawn));
    await ask('delete-slicer', [slicer.id]);
    check('slicer deleted', !((await ask('get-slicers')).result || []).some((s) => s.id === slicer.id));
  }

  const preview3mf = await ask('parse-3mf-preview', [box, 'e2e-preview']);
  check('3MF preview parsed by the worker', !!preview3mf.result && !preview3mf.error, preview3mf.error);
  const images = await ask('get3MFImages', [box]);
  check('3MF images read', Array.isArray(images.result), images.error);
  const meta = await ask('get-all-metadata');
  check('metadata lists load', !!meta.result && !meta.error, meta.error);

  const gpu = await ask('get-gpu-info');
  check('System Report GPU info', !gpu.error && gpu.result !== undefined, gpu.error);
  // The GPU the thumbnail renderer (headless Chromium) uses, read from its WebGL.
  const rendererGpu = await waitFor(async () => (await ask('get-gpu-info')).result?.activeRenderer, 30000, 'the renderer GPU').catch(() => null);
  check("System Report names the thumbnail renderer's GPU", typeof rendererGpu === 'string' && rendererGpu.length > 0, String(rendererGpu));

  // A large thumbnail: the grid gets a small copy (made by the renderer's Chromium), the original stays.
  const cubeStored = String((await ask('get-model', [cube])).result?.thumbnail || '');
  const largeThumb = noisePng(1200, 900);
  await ask('save-thumbnail', [cube, largeThumb]);
  check('the grid gets a large thumbnail as it is until its copy is made', (await ask('getThumbnail', [cube])).result === largeThumb);
  const gridCopy = await waitFor(
    async () => {
      const image = (await ask('getThumbnail', [cube])).result;
      return typeof image === 'string' && image.startsWith('data:image/webp') ? image : null;
    },
    30000,
    'the grid copy'
  ).catch(() => null);
  const copySize = gridCopy ? webpSize(gridCopy) : null;
  check(
    'the grid gets a small copy of a large thumbnail (512 px, WebP)',
    !!copySize && copySize.width === 512 && copySize.height === 384 && gridCopy.length < largeThumb.length / 4,
    JSON.stringify({ copySize, chars: gridCopy && gridCopy.length, original: largeThumb.length })
  );
  check('the large original stays stored', ((await ask('get-all-thumbnails', [cube])).result || [])[0] === largeThumb);
  await ask('save-thumbnail', [cube, cubeStored || '3d.png']);
  const dbBench = await ask('benchmark-database');
  check('System Report database benchmark', !dbBench.error && !!dbBench.result, dbBench.error);

  const menu = (await ask('show-context-menu', [[cube]])).result || {};
  check(
    'context menu built for a model',
    menu.type === 'html-menu' && Array.isArray(menu.items) && menu.items.some((i) => i.label),
    JSON.stringify(menu).slice(0, 200)
  );

  const before = (await ask('get-model', [cube])).result;
  check('model loaded with tags', !!before && Array.isArray(before.tags), JSON.stringify(before).slice(0, 200));
  if (before) {
    const saved = await ask('save-model', [{ ...before, thumbnail: undefined, notes: 'e2e note', designer: 'E2E Designer', tags: ['e2e-model-tag'] }]);
    const after = (await ask('get-model', [cube])).result || {};
    check(
      'model edits saved',
      !saved.error && after.notes === 'e2e note' && after.designer === 'E2E Designer' && (after.tags || []).includes('e2e-model-tag'),
      saved.error || JSON.stringify({ notes: after.notes, designer: after.designer, tags: after.tags })
    );
    check(
      'designer list includes the edit',
      ((await ask('get-designers')).result || []).some((d) => JSON.stringify(d).includes('E2E Designer'))
    );
    await ask('update-models-batch', [[{ filePath: cube, tags: [] }]]);
    const cleared = ((await ask('get-model', [cube])).result || {}).tags;
    check('a batch update with no tags removes them', Array.isArray(cleared) && cleared.length === 0, JSON.stringify(cleared));
    await ask('update-models-batch', [[{ filePath: cube, tags: ['e2e-model-tag'] }]]);
  }
  const tree = await ask('get-folder-tree');
  check('folder tree builds', !tree.error && JSON.stringify(tree.result || '').includes('Designer A'), tree.error);

  const zipEntry = path.join(LIBRARY, 'Designer C', 'pack.zip') + '::inner/widget.stl';
  const extracted = (await ask('extract-model-from-zip', [zipEntry])).result;
  check('ZIP entry extracted to a temp file', typeof extracted === 'string' && fs.existsSync(extracted), extracted);
  if (typeof extracted === 'string') {
    const cleaned = (await ask('delete-temp-file', [extracted])).result;
    check('extracted temp file cleaned up', cleaned !== false && !fs.existsSync(extracted), String(cleaned));
  }

  const sources = (await ask('list-organize-sources')).result || [];
  check('organize sources list the library', JSON.stringify(sources).includes(LIBRARY), JSON.stringify(sources));
  const previewReply = await ask('organize-library-preview', [
    { sourceDir: LIBRARY, destDir: '/tmp/pv-e2e-organize-preview' /* preview only: never created */ }
  ]);
  const preview = previewReply.result || {};
  check(
    'organize preview plans copies',
    preview.ok === true && preview.copyCount > 0,
    previewReply.error || preview.error || JSON.stringify(preview).slice(0, 200)
  );
  const prompt = await ask('get-default-ai-prompt');
  check('default AI prompt', typeof prompt.result === 'string' && prompt.result.length > 0, prompt.error);
  const logged = (await ask('log-print-event', [{ filePath: cube, outcome: 'printed', quantity: 1 }])).result;
  const events = logged && logged.eventId && (await ask('get-print-events', [logged.model && logged.model.id])).result;
  check('print event logged and listed', Array.isArray(events) && events.some((e) => e.id === logged.eventId), JSON.stringify(logged));

  console.log('\n# Backup and trash');
  const backup = await invoke(base, { cookie, origin }, 'backup-database');
  const backupPath = backup.result && backup.result.filePath;
  check('backup created', !!backupPath, backup.error);
  if (backupPath) check('backup downloadable', (await http.request(download(backupPath))).status === 200);
  // Download files (src/server/download-files.js): in downloads/, cleaned up after an hour; old ones in the data folder are listed.
  const downloadsDir = path.join(DATA, 'data', 'downloads');
  check('a backup for download goes into downloads/', !!backupPath && path.dirname(backupPath) === downloadsDir, backupPath);
  const staleDownload = path.join(downloadsDir, 'justtprint-library-stale.json');
  fs.writeFileSync(staleDownload, '{}');
  fs.utimesSync(staleDownload, new Date(Date.now() - 2 * 3600 * 1000), new Date(Date.now() - 2 * 3600 * 1000));
  const freshExport = (await invoke(base, { cookie, origin }, 'export-library')).result || {};
  check(
    'making a new download deletes ones older than an hour',
    !!freshExport.filePath && !fs.existsSync(staleDownload) && fs.existsSync(freshExport.filePath)
  );
  const leftoverFile = path.join(DATA, 'data', 'justtprint-backup-2026-01-01T00-00-00-000Z.db');
  fs.writeFileSync(leftoverFile, 'old backup');
  const leftoverList = (await invoke(base, { cookie, origin }, 'get-leftover-downloads')).result || {};
  check(
    'old backups in the data folder are listed',
    leftoverList.files?.length === 1 && leftoverList.files[0].name === path.basename(leftoverFile) && leftoverList.totalBytes === 10,
    JSON.stringify(leftoverList)
  );
  const leftoverDeleted = (await invoke(base, { cookie, origin }, 'delete-leftover-downloads')).result || {};
  check(
    'and deleted on request, leaving the database',
    leftoverDeleted.count === 1 && !fs.existsSync(leftoverFile) && fs.existsSync(path.join(DATA, 'data', 'justtprint.db'))
  );
  const junk = await invoke(base, { cookie, origin }, 'restore-database', [{ base64: Buffer.from('not a database').toString('base64') }]);
  check(
    'restore refuses a file that is not a backup',
    junk.result && junk.result.success === false && /Not a JusttPrint backup/.test(junk.result.message),
    JSON.stringify(junk)
  );
  check('library still works after a refused restore', ((await invoke(base, { cookie, origin }, 'get-stats')).result || {}).totalModels > 0);
  if (backupPath) {
    // The API token changes after the backup was taken; a restore must keep the current one.
    const newToken = ((await invoke(base, { cookie, origin }, 'regenerate-server-api-token')).result || {}).apiToken;
    const restored = await invoke(base, { cookie, origin }, 'restore-database', [{ base64: fs.readFileSync(backupPath).toString('base64') }]);
    check('restore from a backup', restored.result && restored.result.success === true, JSON.stringify(restored));
    const tokenAfter = ((await invoke(base, { cookie, origin }, 'get-server-access-info')).result || {}).apiToken;
    check('restore keeps the current API token and session', !!newToken && tokenAfter === newToken, `${newToken} / ${tokenAfter}`);
    check('library works after restore', ((await invoke(base, { cookie, origin }, 'get-stats')).result || {}).totalModels > 0);
    check('previous database kept', fs.existsSync(path.join(DATA, 'data', 'justtprint.db.before-restore')));
  }
  // Automatic backups (src/server/auto-backup.js): off by default, into the data volume unless a folder is chosen.
  const act = (name, ...args) => invoke(base, { cookie, origin }, name, args);
  const autoDefault = (await act('get-auto-backup')).result || {};
  check(
    'automatic backups are off by default and go to backups/ in the data folder',
    autoDefault.enabled === false && autoDefault.directory === path.join(DATA, 'backups') && Array.isArray(autoDefault.backups),
    JSON.stringify(autoDefault).slice(0, 300)
  );
  check('automatic backups refuse a system folder', /system folder/.test((await act('save-auto-backup', { directory: '/etc/backups' })).error || ''));
  const autoDir = fs.realpathSync(fs.mkdtempSync('/tmp/justtprint-e2e-autobackup-'));
  fs.writeFileSync(path.join(autoDir, 'other.db'), 'not ours');
  const autoSaved = (await act('save-auto-backup', { enabled: true, keep: 2, intervalHours: 12, directory: autoDir })).result || {};
  check(
    'automatic backup settings are saved',
    autoSaved.enabled === true && autoSaved.keep === 2 && autoSaved.intervalHours === 12 && autoSaved.directory === autoDir
  );
  const autoRuns = [];
  for (let n = 0; n < 3; n++) autoRuns.push((await act('run-auto-backup')).result || {});
  const autoAfter = autoRuns[2].status || {};
  check(
    'Back Up Now writes checked backups and keeps the newest 2',
    autoRuns.every((r) => r.success) &&
      autoAfter.backups.length === 2 &&
      autoAfter.lastError === '' &&
      !!autoAfter.nextRun &&
      fs.existsSync(path.join(autoDir, 'other.db')),
    JSON.stringify(autoRuns.map((r) => r.message || r.backup?.name))
  );
  const newest = autoAfter.backups[0];
  check('an automatic backup can be downloaded', !!newest && (await http.request(download(newest.path))).status === 200);
  check('other files in the backup folder cannot', (await http.request(download(path.join(autoDir, 'other.db')))).status !== 200);
  check(
    'restore refuses a name that is not an automatic backup',
    /Not an automatic backup/.test(((await act('restore-auto-backup', '../other.db')).result || {}).message || '')
  );
  const autoRestored = (await act('restore-auto-backup', newest.name)).result || {};
  check(
    'restore from an automatic backup',
    autoRestored.success === true && ((await act('get-stats')).result || {}).totalModels > 0,
    JSON.stringify(autoRestored)
  );
  await act('save-auto-backup', { enabled: false, directory: '' });
  fs.rmSync(autoDir, { recursive: true, force: true });

  // Messages for one browser go to that browser only; library changes go to every browser.
  const browserA = await listenEvents(wsUrl, { cookie, origin });
  const browserB = await listenEvents(wsUrl, { cookie, origin });
  const scannedBefore = (await invoke(base, { cookie, origin }, 'get-setting', ['scannedDirectories'])).result;
  const ownDir = fs.realpathSync(fs.mkdtempSync('/tmp/justtprint-e2e-own-'));
  fs.copyFileSync(cube, path.join(ownDir, 'keep.stl'));
  fs.copyFileSync(cube, path.join(ownDir, 'gone.stl'));
  const asA = { cookie, origin, client: browserA?.clientId };
  await invoke(base, asA, 'scan-directory', [ownDir]);
  fs.rmSync(path.join(ownDir, 'gone.stl'));
  if (DOCKER_IMAGE) await sleep(1500); // Docker Desktop shows the deletion inside the container a moment later.
  browserA?.channels.splice(0);
  browserB?.channels.splice(0);
  await invoke(base, asA, 'scan-directory', [ownDir]);
  await new Promise((r) => setTimeout(r, 1500));
  check(
    'a scan\'s progress and "Removed" message go only to the browser that scanned',
    !!browserA &&
      !!browserB &&
      browserA.channels.includes('db-cleanup') &&
      browserA.channels.includes('scan-progress') &&
      !browserB.channels.includes('db-cleanup') &&
      !browserB.channels.includes('scan-progress'),
    JSON.stringify({ a: browserA?.channels, b: browserB?.channels })
  );
  check(
    'a library change still reaches every browser',
    !!browserA && !!browserB && browserA.channels.includes('refresh-grid') && browserB.channels.includes('refresh-grid')
  );
  fs.rmSync(ownDir, { recursive: true, force: true });
  // Scanning the deleted folder drops its models.
  await invoke(base, asA, 'scan-directory', [ownDir]);
  await invoke(base, { cookie, origin }, 'save-setting', ['scannedDirectories', scannedBefore || '[]']);
  browserA?.close();
  browserB?.close();
  check('the library is back to the fixture models', ((await invoke(base, { cookie, origin }, 'get-stats')).result || {}).totalModels === 4);

  // A file moved outside JusttPrint keeps its model, tags and all (src/server/relink-moved.js).
  {
    // Outside the app folder (the e2e library is inside it, and web scans of the app folder are refused).
    const moveDir = fs.realpathSync(fs.mkdtempSync('/tmp/justtprint-e2e-move-'));
    const from = path.join(moveDir, 'Old', 'relink-me.stl');
    const to = path.join(moveDir, 'New', 'relink-me.stl');
    fs.mkdirSync(path.dirname(from), { recursive: true });
    fs.copyFileSync(cube, from);
    await invoke(base, { cookie, origin }, 'scan-directory', [moveDir]);
    const tagged = await invoke(base, { cookie, origin }, 'save-model', [{ filePath: from, tags: ['e2e-relinked'] }]);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    if (DOCKER_IMAGE) await sleep(1500); // Docker Desktop shows the move inside the container a moment later.
    await invoke(base, { cookie, origin }, 'scan-directory', [moveDir]);
    const found = (await invoke(base, { cookie, origin }, 'get-models-filtered', [{ tags: ['e2e-relinked'] }])).result || [];
    check(
      'a file moved outside JusttPrint keeps its model and tags',
      !tagged.error && found.length === 1 && found[0].filePath === to,
      JSON.stringify({ error: tagged.error, found: found.map((m) => m.filePath) })
    );
    fs.rmSync(moveDir, { recursive: true, force: true });
    await invoke(base, { cookie, origin }, 'scan-directory', [moveDir]);
    await invoke(base, { cookie, origin }, 'save-setting', ['scannedDirectories', scannedBefore || '[]']);
    check('the library is back to the fixture models after the move', ((await invoke(base, { cookie, origin }, 'get-stats')).result || {}).totalModels === 4);
  }

  // A whole STL Home folder that is gone (a share not mounted) keeps its models; a plain scan of a deleted folder drops them.
  {
    const offline = fs.realpathSync(fs.mkdtempSync('/tmp/justtprint-e2e-offline-'));
    fs.copyFileSync(cube, path.join(offline, 'offline.stl'));
    await invoke(base, { cookie, origin }, 'scan-directory', [offline]);
    fs.rmSync(offline, { recursive: true, force: true });
    if (DOCKER_IMAGE) await sleep(1500);
    await invoke(base, { cookie, origin }, 'scan-directory', [offline, { isStlHomeScan: true }]);
    await invoke(base, { cookie, origin }, 'remove-missing-models', [offline, { isStlHomeScan: true }]);
    const kept = ((await invoke(base, { cookie, origin }, 'get-stats')).result || {}).totalModels;
    await invoke(base, { cookie, origin }, 'scan-directory', [offline]);
    const dropped = ((await invoke(base, { cookie, origin }, 'get-stats')).result || {}).totalModels;
    await invoke(base, { cookie, origin }, 'save-setting', ['scannedDirectories', scannedBefore || '[]']);
    check('a missing STL Home folder keeps its models; a scan of a deleted folder drops them', kept === 5 && dropped === 4, JSON.stringify({ kept, dropped }));
  }

  const part = path.join(LIBRARY, 'Designer A', 'Benchy Pack', 'part one.stl');
  const trash = await invoke(base, { cookie, origin }, 'trash-file', [part]);
  const trashed = !fs.existsSync(part) && fs.readdirSync(WORK, { recursive: true }).some((p) => String(p).endsWith('part one.stl.trashinfo'));
  check('Move to Trash keeps a restorable copy', !trash.error && trashed, trash.error);

  return { cookie, origin };
}

async function browserChecks(base, wsUrl, session) {
  console.log('\n# Browser');
  if (!CHROME) {
    check('browser checks (set CHROME_PATH)', false, 'no Chromium-based browser found');
    return;
  }
  const { chromium } = require('@playwright/test');
  // The background thumbnail job renders through the headless Chromium worker.
  const missing = await waitFor(
    async () => {
      const res = await invoke(base, session, 'get-models-with-default-thumbnails');
      return Array.isArray(res.result) && res.result.length === 0 ? 'done' : null;
    },
    120000,
    'thumbnails'
  ).catch((error) => error.message);
  check('worker rendered all thumbnails', missing === 'done', missing);
  // The last thumbnail is saved just before the worker reports the job complete.
  const jobStatus = await waitFor(
    async () => {
      const status = (await invoke(base, session, 'get-server-thumbnail-job-status')).result || {};
      return status.status === 'idle' ? status : null;
    },
    30000,
    'thumbnail job'
  ).catch((error) => ({ error: error.message }));
  check('thumbnail job finished', jobStatus.status === 'idle', JSON.stringify(jobStatus));
  const cubeThumbs = (await invoke(base, session, 'get-all-thumbnails', [path.join(LIBRARY, 'Designer A', 'cube.stl')])).result;
  check('rendered thumbnail stored for a model', JSON.stringify(cubeThumbs || '').includes('data:image'), JSON.stringify(cubeThumbs).slice(0, 120));
  await invoke(base, session, 'save-setting', ['hasRunBefore', 'true']);

  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = [];
    const badResponses = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      // No helper is installed here, so Chrome cannot open the Send to Slicer link. Expected.
      if (/Failed to launch 'justtprint:\/\/.*does not have a registered handler/.test(message.text())) return;
      const where = message.location();
      errors.push(`${message.text()} (${where.url ? where.url.replace(base, '') : '?'}:${where.lineNumber})`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`);
    });
    // The library's Filter popover (src/web/pages/LibraryPage.tsx) holds the old sidebar's filters.
    const openFilters = async () => {
      if (!(await page.isVisible('#jp-filter-popover'))) await page.click('#jp-filter-button');
      await page.waitForSelector('#jp-filter-popover', { state: 'visible', timeout: 5000 }).catch(() => {});
    };
    // A row of the Settings page (src/web/pages/SettingsPage.tsx); the old sidebar buttons live there now.
    // Settings is in tabs: go through them until the row shows.
    const runSetting = async (label) => {
      await page.evaluate(() => {
        window.location.hash = '#/settings';
      });
      await page.waitForSelector('#jp-settings-tabs [role=tab]', { timeout: 10000 });
      const row = `.jp-settings-row:has-text("${label}")`;
      for (const tab of await page.$$('#jp-settings-tabs [role=tab]')) {
        if (await page.isVisible(row)) break;
        await tab.click();
        await page.waitForTimeout(150);
      }
      await page.click(row);
    };
    const showLibrary = () =>
      page.evaluate(() => {
        window.location.hash = '#/library';
      });

    await page.goto(base + '/');
    check('browser lands on login page', page.url().includes('/login'));
    await page.fill('#username', 'admin');
    await page.fill('#password', 'wrong-password');
    await page.click('button[type=submit]');
    check('wrong password shows an error', await page.isVisible('.error'));
    check('the user name is kept after a wrong password', (await page.inputValue('#username')) === 'admin');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    await page.waitForTimeout(3000);

    // The page fits the window: the grid and the details panel scroll, the page itself does not (no empty strip under it).
    const pageFits = await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight);
    check('the page is no taller than the window', pageFits);
    check('the top bar has Add New Model next to the search box', await page.isVisible('.jp-topbar #jp-topbar-add-button'));
    await page.click('#jp-topbar-add-button');
    check(
      'Add New Model offers Upload and Add Links',
      (await page.locator('.jp-topbar [role=menu] [role=menuitem]').allTextContents()).map((t) => t.trim()).join('|') === 'Upload|Add Links'
    );
    await page.keyboard.press('Escape');
    // Home dashboard (React, src/web/pages/HomeDashboard.tsx): the app opens on it, above the library.
    const libraryTotal = (await invoke(base, session, 'get-library-counts')).result || {};
    check(
      'the app opens on Home with a greeting',
      (await page.isVisible('.jp-sidebar .jp-nav__row[aria-current="page"]:has-text("Home")')) &&
        /^Good (morning|afternoon|evening)$/.test((await page.textContent('.jp-hero__title').catch(() => '')).trim())
    );
    check(
      'the dashboard figures are the library counts',
      await page
        .waitForFunction((n) => document.querySelector('.jp-hero .jp-stat__value')?.textContent === String(n), libraryTotal.models, { timeout: 10000 })
        .then(
          () => true,
          () => false
        ),
      `${await page.textContent('.jp-hero .jp-stat__value').catch(() => '')} vs ${libraryTotal.models}`
    );
    check(
      'Recent Activity lists the models added',
      await page.waitForSelector('.jp-activity-list .jp-activity__title:has-text("new models added")', { timeout: 10000 }).then(
        () => true,
        () => false
      )
    );
    check(
      'Your Printers offers to add a printer',
      (await page.isVisible('.jp-home__panel :text("No printers yet")')) || (await page.isVisible('.jp-printer-list'))
    );
    check(
      'the dashboard draws a library model',
      await page.waitForSelector('.jp-hero__render, .jp-hero__fallback', { timeout: 60000 }).then(
        () => true,
        () => false
      )
    );
    check(
      'Home lists the most recently added models',
      (await page.waitForSelector('.jp-recent-grid .jp-recent-card', { timeout: 10000 }).then(
        () => true,
        () => false
      )) && (await page.isVisible('#jp-home-library-title'))
    );
    // Needs attention (home/HomeSections.tsx): the library's loose ends, as get-library-attention counts them.
    const attention = (await invoke(base, session, 'get-library-attention')).result || {};
    const untaggedModels = (await invoke(base, session, 'get-models-filtered', [{ tags: ['__none__'] }])).result || [];
    check(
      'the tag filter None finds the models without tags',
      untaggedModels.length === attention.untagged,
      `${untaggedModels.length} vs ${attention.untagged}`
    );
    check(
      'Needs attention says how many models have no tags',
      attention.untagged > 0 &&
        (await page.waitForSelector(`#jp-home-attention [data-attention="untagged"]:has-text("${attention.untagged} model")`, { timeout: 10000 }).then(
          () => true,
          () => false
        )),
      JSON.stringify(attention)
    );
    await page.click('.jp-sidebar .jp-nav__row:has-text("Library")');
    check(
      'Library shows the library without the dashboard',
      (await page.waitForSelector('.jp-hero', { state: 'detached', timeout: 5000 }).then(
        () => true,
        () => false
      )) && /#\/library$/.test(page.url())
    );

    const previewView = await page.$('.view-button[data-view="preview"]');
    if (previewView) {
      await previewView.click();
      await page.waitForTimeout(2000);
    }
    const tiles = await page.$$eval('[data-filepath], [data-file-path]', (els) =>
      els.map((el) => el.getAttribute('data-filepath') || el.getAttribute('data-file-path'))
    );
    // 4 scanned, minus the one moved to the trash in the API checks.
    check('grid shows the library (3 models)', tiles.length === 3, `${tiles.length} tiles`);

    for (const filePath of tiles) {
      const errorsBefore = errors.length;
      const tile = await page.$(`[data-filepath="${filePath.replace(/"/g, '\\"')}"], [data-file-path="${filePath.replace(/"/g, '\\"')}"]`);
      await tile.dblclick();
      // An archive is one model that is never opened: no 3D preview, a message instead.
      if (/\.(zip|rar|7z)$/i.test(filePath)) {
        const said = await page
          .waitForSelector('dialog[open]:has-text("No 3D Preview")', { timeout: 10000 })
          .then(() => page.textContent('dialog[open]'))
          .catch(() => '');
        check(`an archive has no 3D preview, and says why: ${path.basename(filePath)}`, /archive/i.test(said) && errors.length === errorsBefore, said);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        continue;
      }
      const opened = await page
        .waitForFunction(() => [...document.querySelectorAll('canvas')].some((c) => c.width > 50 && c.offsetParent !== null), null, { timeout: 30000 })
        .then(
          () => true,
          () => false
        );
      await page.waitForTimeout(1500);
      const loaded = await page
        .waitForFunction(
          () =>
            /^Dimensions: [\d.]+ × [\d.]+ × [\d.]+ mm$/.test(document.getElementById('preview-dimensions')?.textContent || '') &&
            getComputedStyle(document.getElementById('preview-loading')).display === 'none',
          null,
          { timeout: 30000 }
        )
        .then(
          () => true,
          async () => page.textContent('#preview-loading').catch(() => '')
        );
      check(`3D preview opens: ${path.basename(filePath)}`, opened && loaded === true, [String(loaded), ...errors.slice(errorsBefore)].join(' | '));
      if (process.env.E2E_DEBUG) console.log(`     errors while open: ${errors.length - errorsBefore}`);
      if (filePath === tiles.find((p) => !/\.(zip|rar|7z)$/i.test(p)) && loaded === true) {
        // Studio (React, src/web/preview/PreviewDialog.tsx): settings apply and are saved; Save Image downloads a PNG.
        await page.click('#preview-toggle-studio');
        const studioOpen = await page.isVisible('#preview-studio-panel');
        await page.click('#preview-studio-backdrop [data-backdrop="mint"]');
        const savedBackdrop = await page.evaluate(() => JSON.parse(localStorage.getItem('justtprint.previewStudio.v5') || '{}').backdrop);
        check(
          'the Studio panel opens and saves its settings',
          studioOpen && savedBackdrop === 'mint' && (await page.getAttribute('#preview-studio-backdrop [data-backdrop="mint"]', 'aria-checked')) === 'true',
          String(savedBackdrop)
        );
        await page.click('#preview-studio-backdrop [data-backdrop="charcoal"]');
        await page.click('#preview-studio-close');
        await page.click('#preview-save-image');
        const download = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
        await page.click('#preview-save-with-backdrop');
        const file = await download;
        check('Save Image downloads a PNG of the preview', !!file && /-preview\.png$/.test(file.suggestedFilename()), file && file.suggestedFilename());
      }
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1500);
      if (process.env.E2E_DEBUG) console.log(`     errors after close: ${errors.length - errorsBefore}`);
    }

    // Grid cards (React, src/web/grid/ModelCard.tsx) in the detailed view.
    await page.click('.view-button[data-view="detailed"]');
    // The first model file (an archive has no Open in Slicer or 3D preview; card order can vary).
    const firstCard = await page.waitForSelector('.file-grid .file-item-detailed:not([data-filepath$=".zip"])', { timeout: 10000 }).catch(() => null);
    check('detailed view shows cards', !!firstCard && (await page.locator('.file-grid .file-item-detailed').count()) === 3);
    if (firstCard) {
      const cardPath = await firstCard.getAttribute('data-filepath');
      const card = `.file-grid .file-item-detailed[data-filepath="${cardPath.replace(/"/g, '\\"')}"]`;
      await page.click(`${card} .file-name`);
      check('clicking a card selects it and shows its details', (await page.isVisible(`${card}.selected`)) && (await page.isVisible('#model-details')));
      // Details panel fields (React, src/web/details/DetailsFields.tsx).
      const panelModel = async () => (await invoke(base, session, 'get-model', [cardPath])).result || {};
      // The sidebar (React, src/web/details/ModelDetailsPanel.tsx): the model page's sections in one column.
      const cardFile = path.basename(cardPath);
      check(
        'the panel shows the name as its title and the file in the Details list',
        (await page
          .waitForFunction((name) => document.querySelector('#model-details .jp-details__title')?.textContent === name.replace(/\.[^.]+$/, ''), cardFile, {
            timeout: 10000
          })
          .then(
            () => true,
            () => false
          )) &&
          (await page.textContent('#model-details .jp-prop:has(.jp-prop__label:text-is("File")) .jp-prop__value')) === cardFile &&
          (await page.isVisible('#model-details #jp-details-edit')) &&
          (await page.isVisible('#model-details #jp-details-open-page')) &&
          (await page.isVisible('#model-details #model-print-status'))
      );
      await page.click('#model-details .jp-split__more');
      check('Open in Slicer offers to set up a slicer when none is configured', await page.isVisible('.jp-menu [role="menuitem"]:has-text("Set up a slicer")'));
      await page.keyboard.press('Escape');
      // Source, designer and tags: the Edit dialog (src/web/details/EditModelDialog.tsx) from the sidebar.
      await page.click('#jp-details-edit');
      const editOpen = await page.waitForSelector('#edit-model-dialog[open] #edit-model-source', { timeout: 10000 }).catch(() => null);
      if (editOpen) {
        const saveOffAtFirst = await page.isDisabled('#edit-model-save');
        await page.fill('#edit-model-source', 'https://example.com/e2e-source');
        await page.fill('#edit-model-designer', 'E2E Panel Designer');
        await page.fill('#edit-model-tags', 'e2e-panel-tag');
        await page.keyboard.press('Enter');
        const chipAdded = await page.isVisible('#edit-model-dialog .jp-edit__chip:has-text("e2e-panel-tag")');
        const counted = ((await page.textContent('#edit-model-dialog .jp-edit__status')) || '').trim();
        check(
          'the Edit dialog saves only after a change, adds a tag as a chip and counts the changes',
          saveOffAtFirst && chipAdded && counted === '3 changes' && (await page.isEnabled('#edit-model-save')),
          JSON.stringify({ saveOffAtFirst, chipAdded, counted })
        );
        await page.click('#edit-model-save');
      }
      const hasPanelTag = async () => ((await panelModel()).tags || []).some((t) => (t.name || t) === 'e2e-panel-tag');
      const editSaved = await waitFor(
        async () => {
          const m = await panelModel();
          return m.source === 'https://example.com/e2e-source' && m.designer === 'E2E Panel Designer' && (await hasPanelTag()) ? true : null;
        },
        10000,
        'edit from the sidebar'
      ).catch(async () => JSON.stringify(await panelModel()));
      const editShown = await page
        .waitForFunction(
          (cardSelector) =>
            /By E2E Panel Designer/.test(document.querySelector('#model-details .jp-model-page__byline')?.textContent || '') &&
            /E2E Panel Designer/.test(document.querySelector(`${cardSelector} .designer-info`)?.textContent || ''),
          card,
          { timeout: 10000 }
        )
        .then(
          () => true,
          () => false
        );
      check(
        'Edit from the sidebar saves the source, designer and tags, and the sidebar and card show them',
        !!editOpen && editSaved === true && editShown,
        String(editSaved)
      );
      // As before: the model keeps that source, another model has a designer, and the tag is gone.
      const listedOn = (await page.$$eval('.file-grid [data-filepath]', (els) => els.map((el) => el.getAttribute('data-filepath')))).find(
        (p) => p !== cardPath
      );
      await invoke(base, session, 'update-models-batch', [
        [
          { filePath: listedOn, designer: 'E2E Listed Designer' },
          { filePath: cardPath, designer: 'E2E Listed Designer', tags: [] }
        ]
      ]);
      await waitFor(async () => (!(await hasPanelTag()) ? true : null), 10000, 'tag removed').catch(() => {});
      // Print status and history in the details panel, and the Log Print dialog (React, src/web/print/PrintHistory.tsx).
      await page.selectOption('#model-print-status', 'queued');
      const queued = await waitFor(async () => ((await panelModel()).print_status === 'queued' ? true : null), 10000, 'status').catch(() => false);
      check(
        'details set the print status',
        queued === true &&
          (await page
            .waitForFunction(() => document.getElementById('model-print-status')?.value === 'queued', null, { timeout: 10000 })
            .then(
              () => true,
              () => false
            ))
      );
      const printsBefore = Number((await panelModel()).print_count) || 0;
      await page.click('#jp-details-log-print');
      const logDialog = await page.waitForSelector('#log-print-dialog[open]', { timeout: 10000 }).catch(() => null);
      check(
        'log print dialog opens from the details panel',
        !!logDialog &&
          (await page.textContent('#log-print-title')) === 'Log a print' &&
          /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(await page.inputValue('#log-print-when'))
      );
      if (logDialog) {
        await page.fill('#log-print-quantity', '2');
        await page.fill('#log-print-notes', 'e2e log entry');
        await page.click('#log-print-save');
      }
      const loggedPrint = await waitFor(async () => (Number((await panelModel()).print_count) === printsBefore + 2 ? true : null), 10000, 'print logged').catch(
        async () => `print_count ${(await panelModel()).print_count}, before ${printsBefore}`
      );
      const historyItem = '#print-history-list .print-history-item:has(.print-history-notes:text-is("e2e log entry"))';
      const historyShown = await page.waitForSelector(historyItem, { timeout: 10000 }).then(
        () => true,
        () => false
      );
      check(
        'logging a print saves it and lists it in the history',
        loggedPrint === true &&
          historyShown &&
          !(await page.isVisible('#log-print-dialog')) &&
          /×2/.test(await page.textContent(`${historyItem} .print-history-outcome`).catch(() => '')) &&
          (await page.inputValue('#model-print-status')) === 'printed',
        String(loggedPrint)
      );
      await page.click(`${historyItem} .print-history-delete`);
      const confirmDelete = await page.waitForSelector('dialog[id^="browser-message-"][open] button:text-is("Delete")', { timeout: 10000 }).catch(() => null);
      if (confirmDelete) await confirmDelete.click();
      const deletedPrint = await waitFor(
        async () => ((Number((await panelModel()).print_count) || 0) === printsBefore ? true : null),
        10000,
        'print deleted'
      ).catch(() => false);
      check(
        'deleting a history entry removes it',
        !!confirmDelete &&
          deletedPrint === true &&
          (await page.waitForSelector(historyItem, { state: 'detached', timeout: 10000 }).then(
            () => true,
            () => false
          ))
      );
      // The Edit dialog (src/web/details/EditModelDialog.tsx): every field at once; a new name renames the file.
      {
        const before = await panelModel();
        const extension = path.extname(cardPath);
        const stem = path.basename(cardPath, extension);
        const renamedPath = path.join(path.dirname(cardPath), `e2e renamed${extension}`);
        const editOnce = async (values) => {
          await page.click('#jp-details-edit');
          const open = await page.waitForSelector('#edit-model-dialog[open]', { timeout: 10000 }).catch(() => null);
          if (!open) return false;
          await page.waitForFunction(() => document.getElementById('edit-model-name')?.value, null, { timeout: 10000 }).catch(() => {});
          const shownStem = await page.inputValue('#edit-model-name');
          await page.fill('#edit-model-name', values.name);
          await page.fill('#edit-model-license', values.license);
          await page.fill('#edit-model-notes', values.notes);
          await page.click(`#edit-model-rating-${values.rating}`);
          await page.click('#edit-model-save');
          await page.waitForSelector('#edit-model-dialog', { state: 'hidden', timeout: 10000 }).catch(() => {});
          return shownStem;
        };
        const shownStem = await editOnce({ name: 'e2e renamed', license: 'E2E Edit License', notes: 'e2e edit notes', rating: '4' });
        const edited = await waitFor(
          async () => {
            const model = (await invoke(base, session, 'get-model', [renamedPath])).result;
            return model && model.license === 'E2E Edit License' && model.notes === 'e2e edit notes' && Number(model.rating) === 4 ? model : null;
          },
          10000,
          'edited'
        ).catch(() => null);
        check(
          'the Edit dialog saves every field and renames the file',
          shownStem === stem && !!edited && fs.existsSync(renamedPath) && !fs.existsSync(cardPath) && (await page.isVisible('#model-details')),
          JSON.stringify({ shownStem, stem, edited: !!edited })
        );
        // The sidebar follows the rename: wait for it before editing again.
        await page
          .waitForFunction(
            (name) =>
              document.querySelector('#model-details .jp-prop:has(.jp-prop__label) .jp-prop__value')?.textContent === name &&
              !!document.getElementById('jp-details-edit'),
            path.basename(renamedPath),
            { timeout: 15000 }
          )
          .catch(() => {});
        await editOnce({ name: stem, license: before.license || '', notes: before.notes || '', rating: String(Number(before.rating) || 0) });
        const restored = await waitFor(async () => ((await invoke(base, session, 'get-model', [cardPath])).result ? true : null), 10000, 'renamed back').catch(
          () => false
        );
        check('renaming back in the Edit dialog restores the file', restored === true && fs.existsSync(cardPath) && !fs.existsSync(renamedPath));
        await page.waitForSelector(card, { timeout: 10000 }).catch(() => {});
        // Undo takes back a whole save of the Edit dialog: the name, the library fields and the place.
        await page
          .waitForFunction(
            (name) =>
              document.querySelector('#model-details .jp-prop:has(.jp-prop__label) .jp-prop__value')?.textContent === name &&
              !!document.getElementById('jp-details-edit'),
            path.basename(cardPath),
            { timeout: 15000 }
          )
          .catch(() => {});
        const undonePath = path.join(path.dirname(cardPath), `e2e undone${extension}`);
        await page.click('#jp-details-edit');
        await page.waitForFunction(() => document.getElementById('edit-model-name')?.value, null, { timeout: 10000 }).catch(() => {});
        await page.waitForSelector('#edit-model-category option[value="Puzzles"]', { state: 'attached', timeout: 10000 }).catch(() => {});
        await page.fill('#edit-model-name', 'e2e undone');
        await page.fill('#edit-model-license', 'E2E Undo License');
        await page.fill('#edit-model-notes', 'e2e undo notes');
        await page.fill('#edit-model-tags', [...(before.tags || []).map((t) => t.name || t), 'e2e-undo-tag'].join(', '));
        await page.click('#edit-model-rating-5');
        await page.selectOption('#edit-model-category', 'Puzzles').catch(() => {});
        await page.click('#edit-model-save');
        const savedForUndo = await waitFor(
          async () => {
            const model = (await invoke(base, session, 'get-model', [undonePath])).result;
            return model && model.license === 'E2E Undo License' && (model.categories || []).includes('Puzzles') ? true : null;
          },
          10000,
          'edited for undo'
        ).catch(() => false);
        const toast = await page.waitForSelector('.jp-undo-toast:has-text("Edited") .jp-undo-toast__button', { timeout: 10000 }).catch(() => null);
        if (toast) await toast.click();
        const tagNamesOf = (m) => (m.tags || []).map((t) => t.name || t).sort();
        const undone = await waitFor(
          async () => {
            const model = (await invoke(base, session, 'get-model', [cardPath])).result;
            return model &&
              (model.license || '') === (before.license || '') &&
              (model.notes || '') === (before.notes || '') &&
              Number(model.rating) === (Number(before.rating) || 0) &&
              JSON.stringify(tagNamesOf(model)) === JSON.stringify(tagNamesOf(before)) &&
              JSON.stringify(model.categories || []) === JSON.stringify(before.categories || [])
              ? true
              : null;
          },
          15000,
          'undone'
        ).catch(async () => JSON.stringify((await invoke(base, session, 'get-model', [cardPath])).result || null));
        check(
          'Undo takes back a save of the Edit dialog: name, fields, tags and place',
          savedForUndo === true && !!toast && undone === true && fs.existsSync(cardPath) && !fs.existsSync(undonePath),
          String(undone)
        );
        await page.waitForSelector(card, { timeout: 10000 }).catch(() => {});
      }
      // Categories (src/web/pages/CategoriesPage.tsx): the fixed list, Categorize Library without the AI (a Subcategory's words), and its models in the library.
      {
        const cubePath = path.join(LIBRARY, 'Designer A', 'cube.stl');
        await page.evaluate(() => {
          window.location.hash = '#/categories';
        });
        await page.waitForSelector('#jp-categories-list', { timeout: 10000 }).catch(() => {});
        check('the Categories page lists the eleven Categories', (await page.locator('#jp-categories-list .jp-category-group').count()) === 11);
        const puzzles = ((await invoke(base, session, 'get-categories')).result.categories || []).find((c) => c.name === 'Puzzles') || {};
        check('Puzzles is a Subcategory of Toys & Games', !!puzzles.parent_id);
        await invoke(base, session, 'update-category', [puzzles.id || 0, { keywords: 'cube' }]);
        // The sort after an update may be running, or done and showing its summary: closed first.
        await page.waitForSelector('#jp-category-scan-start, #jp-category-scan-close', { timeout: 60000 }).catch(() => {});
        if (await page.isVisible('#jp-category-scan-close')) await page.click('#jp-category-scan-close');
        await page.waitForSelector('#jp-category-scan-start', { timeout: 10000 }).catch(() => {});
        await page.uncheck('.jp-category-scan__ai input').catch(() => {});
        await page.check('#jp-category-scan-again').catch(() => {});
        await page.click('#jp-category-scan-start');
        const placed = await waitFor(
          async () => {
            const names = ((await invoke(base, session, 'get-model', [cubePath])).result || {}).categories || [];
            return names.join(' > ') === 'Toys & Games > Puzzles' || null;
          },
          30000,
          'categorized'
        ).catch(() => false);
        const summaryShown = await page.waitForSelector('#jp-category-scan-summary', { timeout: 30000 }).then(
          () => true,
          () => false
        );
        check("Categorize Library gives a model its Category and Subcategory by a Subcategory's words", placed === true && summaryShown);
        // Who placed it comes with the model, and Undo can put a place back as the AI or the site gave it.
        const sourceBefore = ((await invoke(base, session, 'get-model', [cubePath])).result || {}).categorySource;
        await invoke(base, session, 'set-model-categories', [cubePath, ['Puzzles'], 'ai']);
        const sourceAfter = ((await invoke(base, session, 'get-model', [cubePath])).result || {}).categorySource;
        check(
          'a model says who placed it, and a place can be put back with its source',
          !!sourceBefore && sourceBefore !== 'manual' && sourceAfter === 'ai',
          `${sourceBefore} → ${sourceAfter}`
        );
        await invoke(base, session, 'set-model-categories', [cubePath, ['Puzzles'], sourceBefore]);
        await page.click('#jp-category-scan-close').catch(() => {});
        const shapes = '.jp-category-row[data-category-name="Puzzles"]';
        await page.evaluate((selector) => {
          const details = document.querySelector(selector)?.closest('details');
          if (details) details.open = true;
        }, shapes);
        await page.click(`${shapes} .jp-category-row__name`);
        const onlyCube = await page
          .waitForFunction(
            (want) => {
              const shown = [...document.querySelectorAll('.file-grid [data-filepath]')].map((el) => el.getAttribute('data-filepath'));
              return shown.length >= 1 && shown.every((p) => p === want || p.startsWith(`${want}::`)) && shown.includes(want);
            },
            cubePath,
            { timeout: 10000 }
          )
          .then(
            () => true,
            () => false
          );
        check('a Subcategory shows its models in the library', onlyCube);
        // Multi-edit: one place for many models (it stays: a person chose it).
        const many = await invoke(base, session, 'set-models-category', [[cubePath], 'Hand Tools']);
        const placedByHand = ((await invoke(base, session, 'get-model', [cubePath])).result || {}).categories || [];
        check(
          'Multi-edit gives the selected models one Category and Subcategory',
          many.result?.placed === 1 && placedByHand.join(' > ') === 'Tools > Hand Tools',
          JSON.stringify({ many, placedByHand })
        );
        const listed =
          ((await invoke(base, session, 'get-models-filtered', [{ searchTokens: [{ t: 'clause', field: 'category', value: 'Hand Tools' }] }])).result ||
            [])[0] || {};
        check(
          'the grid gets the place of each model',
          listed.subcategory === 'Hand Tools' && listed.category === 'Tools',
          JSON.stringify(listed).slice(0, 200)
        );
        await page.click('#jp-filter-strip .jp-filter-clear, button:has-text("Clear All Filters")').catch(() => {});
        await invoke(base, session, 'update-category', [puzzles.id || 0, { keywords: (puzzles.keywords || []).join(', ') }]);
        await page.evaluate(() => {
          window.location.hash = '#/library';
        });
        await page.waitForSelector(card, { timeout: 10000 }).catch(() => {});
        await page.click(`${card} .file-name`).catch(() => {});
      }
      // A model's page (src/web/pages/ModelPage.tsx), from the card's Open, and the sidebar switch.
      {
        await page.hover(card);
        await page.click(`${card} .jp-model-card__open`);
        const titled = await page
          .waitForFunction((want) => document.getElementById('jp-model-page-title')?.textContent === want, path.basename(cardPath, path.extname(cardPath)), {
            timeout: 10000
          })
          .then(
            () => true,
            () => false
          );
        const listed = await page.waitForSelector(`#jp-model-page-file-grid [data-filepath="${cardPath.replace(/"/g, '\\"')}"]`, { timeout: 10000 }).then(
          () => true,
          () => false
        );
        check("Open on a card shows the model page with its folder's files", titled && listed && (await page.isVisible('#jp-model-page-edit')));
        await page.click('.jp-model-page__back');
        await page.waitForSelector(card, { timeout: 10000 }).catch(() => {});
        await page.click('#jp-sidebar-toggle');
        const sidebarGone = await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).display === 'none');
        await page.click(`${card} .file-name`);
        const clickOpens = await page.waitForSelector('#jp-model-page-title', { timeout: 10000 }).then(
          () => true,
          () => false
        );
        check('with the sidebar off, a click on a model opens its page', sidebarGone && clickOpens);
        await page.click('.jp-model-page__back');
        await page.waitForSelector(card, { timeout: 10000 }).catch(() => {});
        await page.click('#jp-sidebar-toggle');
        // The card is still selected from the page: the first click unselects it, the next shows its details.
        const detailsShown = () =>
          page.waitForSelector('#model-details #jp-details-edit', { state: 'visible', timeout: 5000 }).then(
            () => true,
            () => false
          );
        let shownAgain = false;
        for (let i = 0; i < 2 && !shownAgain; i++) {
          await page.click(`${card} .file-name`);
          shownAgain = await detailsShown();
        }
        check('turning the sidebar on shows the details again', shownAgain && !(await page.evaluate(() => document.body.classList.contains('jp-no-details'))));
      }
      // 7.15: smart collections, folder pages and kits, More like this, the AI search buttons, designer links in Add Links.
      {
        const stem = path.basename(cardPath, path.extname(cardPath));
        const folder = path.dirname(cardPath);
        // Save Search: the current search becomes a smart collection that shows what it finds.
        await page.evaluate(() => {
          window.location.hash = '#/library';
        });
        await page.fill('.jp-topbar__search input', stem);
        await page.press('.jp-topbar__search input', 'Enter');
        await page.waitForSelector('#save-search-button:not([hidden])', { timeout: 10000 }).catch(() => {});
        await page.click('#save-search-button').catch(() => {});
        const nameBox = await page.waitForSelector('dialog.browser-input-dialog[open] input', { timeout: 5000 }).catch(() => null);
        if (nameBox) {
          await nameBox.fill('E2E Smart');
          await page.click('dialog.browser-input-dialog[open] button[type=submit]');
        }
        const openIt = await page.waitForSelector('dialog[open] button:text-is("Open It")', { timeout: 10000 }).catch(() => null);
        if (openIt) await openIt.click();
        const smartShows = await page
          .waitForFunction(
            (want) =>
              document.getElementById('jp-collection-title')?.textContent === 'E2E Smart' &&
              !!document.querySelector(`#jp-collection-models [data-filepath="${CSS.escape(want)}"]`),
            cardPath,
            {
              timeout: 10000
            }
          )
          .then(
            () => true,
            () => false
          );
        check('Save Search makes a smart collection showing what the search finds', smartShows && (await page.isVisible('#jp-collection-show-search')));
        // Off its page first: a page showing a deleted collection would ask for it again.
        await page.evaluate(() => {
          window.location.hash = '#/library';
        });
        await page.waitForTimeout(300);
        const smart = ((await invoke(base, session, 'get-collections')).result || []).find((c) => c.name === 'E2E Smart');
        if (smart) await invoke(base, session, 'delete-collection', [smart.id]);

        // A folder's page, its notes, and kit progress (ticked by hand and by a logged print).
        await page.evaluate((dir) => {
          window.location.hash = `#/folder/${encodeURIComponent(dir)}`;
        }, folder);
        const folderShown = await page
          .waitForFunction((want) => document.getElementById('jp-folder-title')?.textContent === want, path.basename(folder), { timeout: 10000 })
          .then(
            () => true,
            () => false
          );
        await page.click('#jp-folder-notes-edit').catch(() => {});
        await page.fill('#jp-folder-notes-input', 'e2e folder notes').catch(() => {});
        await page.click('#jp-folder-notes-save').catch(() => {});
        const notesSaved = await waitFor(
          async () => (((await invoke(base, session, 'get-folder', [folder])).result || {}).notes === 'e2e folder notes' ? true : null),
          10000,
          'notes'
        ).catch(() => false);
        check(
          'a folder has a page with its files and notes of its own',
          folderShown && notesSaved === true && (await page.isVisible(`#jp-folder-file-grid [data-filepath="${cardPath.replace(/"/g, '\\"')}"]`))
        );
        // The notes change is in the History, and can be put back (model-versions.js detail_changes).
        const notesChange = (((await invoke(base, session, 'get-all-history', [{ search: 'e2e folder notes' }])).result || {}).entries || []).find(
          (e) => e.kind === 'detail' && e.scope === 'folder' && e.newValue === 'e2e folder notes'
        );
        await invoke(base, session, 'save-folder-notes', [folder, 'changed again']);
        if (notesChange) await invoke(base, session, 'undo-detail-change', [notesChange.id]);
        check(
          "a folder's notes are in the History and can be put back",
          !!notesChange && ((await invoke(base, session, 'get-folder', [folder])).result || {}).notes === notesChange.oldValue,
          JSON.stringify(notesChange)
        );
        await invoke(base, session, 'save-folder-notes', [folder, '']);
        // The print logged above (Log Print, Printed) ticked this model's part.
        const kitBefore = (await invoke(base, session, 'get-kit', [folder])).result || {};
        const mine = (kitBefore.parts || []).filter((p) => p.filePath === cardPath);
        await invoke(base, session, 'set-kit-part', [cardPath, 0, false]);
        const unticked = ((await invoke(base, session, 'get-kit', [folder])).result || {}).parts?.find((p) => p.filePath === cardPath)?.done;
        await invoke(base, session, 'set-kit-part', [cardPath, 0, true]);
        const ticked = ((await invoke(base, session, 'get-kit', [folder])).result || {}).parts?.find((p) => p.filePath === cardPath)?.done;
        check(
          'kit parts are ticked by a logged print and by hand',
          mine.length === 1 && mine[0].done === true && unticked === false && ticked === true,
          JSON.stringify({ mine, unticked, ticked })
        );

        // More like this on the model's page.
        await page.evaluate((file) => {
          window.location.hash = `#/model/${encodeURIComponent(file)}`;
        }, cardPath);
        await page.click('#jp-more-like-this', { timeout: 10000 }).catch(() => {});
        const compared = await page
          .waitForFunction(
            () =>
              /not been measured|No other model|Only STL|could not be read|#/.test(document.querySelector('.jp-model-page__alike')?.textContent || '') &&
              !document.querySelector('#jp-more-like-this:disabled'),
            null,
            {
              timeout: 30000
            }
          )
          .then(
            () => true,
            () => false
          );
        check('More like this compares the model with the library', compared);

        // New Version on the model's page keeps the old file; History (sidebar) lists it with the Edit dialog's changes above.
        const original = fs.readFileSync(cardPath);
        // Upload and New Version are in the page's More menu.
        await page.click('#jp-model-more');
        const canUpload =
          (await page.isVisible('.jp-menu [role="menuitem"]:has-text("Upload New Version")')) &&
          (await page.isVisible('.jp-menu [role="menuitem"]:has-text("Upload Files")'));
        await page.keyboard.press('Escape');
        // The test library is inside the app's folder, where uploads are refused: the new file is put next to the model as an upload would.
        const uploadedCopy = path.join(folder, `e2e-new-version${path.extname(cardPath)}`);
        fs.writeFileSync(uploadedCopy, original);
        await invoke(base, session, 'replace-model-file', [cardPath, uploadedCopy]);
        await page.evaluate(() => {
          window.location.hash = '#/history';
        });
        const historyShown = await page
          .waitForFunction(
            () => {
              const text = document.getElementById('jp-history-list')?.textContent || '';
              return /License/.test(text) && /Earlier file/.test(text);
            },
            null,
            { timeout: 15000 }
          )
          .then(
            () => true,
            () => false
          );
        const kept = ((await invoke(base, session, 'get-model-history', [cardPath])).result || {}).versions || [];
        check(
          'History lists the changes and keeps the replaced file',
          historyShown && canUpload && kept.length === 1 && fs.readFileSync(cardPath).equals(original) && !fs.existsSync(uploadedCopy),
          JSON.stringify({ historyShown, canUpload, kept: kept.length })
        );
        await page.evaluate((file) => {
          window.location.hash = `#/model/${encodeURIComponent(file)}`;
        }, cardPath);
        for (const version of kept) await invoke(base, session, 'delete-model-version', [version.id]);

        // Assembly view: a folder's layout is kept.
        const savedLayout = (await invoke(base, session, 'save-assembly', [folder, { layout: 'laid-out', poses: {} }])).result;
        const readLayout = (await invoke(base, session, 'get-assembly', [folder])).result;
        await invoke(base, session, 'save-assembly', [folder, null]);
        check('an assembly layout is saved for its folder', savedLayout?.layout === 'laid-out' && readLayout?.layout === 'laid-out');

        // Typed search: fields and NOT in the search box.
        await page.evaluate(() => {
          window.location.hash = '#/library';
        });
        await page.fill('.jp-topbar__search input', `name:"${stem}" -name:zzzz`);
        await page.press('.jp-topbar__search input', 'Enter');
        const typed = await page
          .waitForFunction(
            (want) => {
              const shown = [...document.querySelectorAll('.file-grid [data-filepath]')].map((el) => el.getAttribute('data-filepath'));
              const chips = document.querySelector('.filter-pills-search-chain')?.textContent || '';
              return shown.includes(want) && /NOT/.test(chips) && /File name/.test(chips);
            },
            cardPath,
            { timeout: 10000 }
          )
          .then(
            () => true,
            () => false
          );
        check('a typed search reads fields and NOT', typed);
        await page.click('#clear-all-filters-button').catch(() => {});

        // The AI searches: the buttons, and the photo dialog (no AI service in this run).
        await page.click('#jp-search-photo');
        const photoDialog = await page.waitForSelector('#photo-search-dialog[open]', { timeout: 5000 }).catch(() => null);
        check(
          'the top bar searches by meaning and with a photo',
          (await page.isVisible('#jp-search-meaning')) && !!photoDialog && (await page.isDisabled('#photo-search-go'))
        );
        await page.keyboard.press('Escape');

        // Add Links offers to list a designer's models.
        await page.click('#jp-topbar-add-button');
        await page.click('.jp-topbar [role=menuitem]:has-text("Add Links")');
        await page.fill('dialog[open] textarea', 'https://www.printables.com/@Someone_123');
        const listed = await page
          .waitForSelector('#jp-links-lists li:has-text("@Someone_123") button:has-text("Get Their Models")', { timeout: 10000 })
          .catch(() => null);
        check("Add Links offers a designer's models", !!listed);
        await page.fill('dialog[open] textarea', '');
        await page.keyboard.press('Escape');
        await page.evaluate(() => {
          window.location.hash = '#/library';
        });
        await page.waitForSelector(card, { timeout: 10000 }).catch(() => {});
        await page.click(`${card} .file-name`).catch(() => {});
      }
      check(
        'cards show only the file type and Subcategory badges',
        !(await page.$(`${card} .jp-model-card__badges .print-status`)) && (await page.isVisible(`${card} .jp-model-card__badges .jp-badge`))
      );
      await invoke(base, session, 'set-print-status', [{ filePath: cardPath, printStatus: 'unprinted' }]);
      check(
        'the details panel has no Filament section',
        !(await page.$('#filament-select')) &&
          !(await page.$('#details-filaments-slot')) &&
          !(await page.isVisible('#model-details .jp-details__heading:text-is("Filament")'))
      );
      // Notes in the sidebar (React, src/web/pages/ModelPageParts.tsx NotesPanel): edited in place, shown as Markdown.
      const notesBefore = (await panelModel()).notes || '';
      await page.click('#model-details #jp-model-notes button[aria-label="Edit your notes"]');
      const notesEditor = await page.waitForSelector('#model-details #jp-model-notes-input', { timeout: 10000 }).catch(() => null);
      check('the notes edit button opens the editor in place', !!notesEditor);
      if (notesEditor) {
        await notesEditor.fill('Hello **world**');
        await page.click('#model-details #jp-model-notes-save');
      }
      const notesSaved = await waitFor(async () => ((await panelModel()).notes === 'Hello **world**' ? true : null), 10000, 'notes saved').catch(async () =>
        JSON.stringify((await panelModel()).notes)
      );
      check(
        'the notes save as Markdown and show rendered',
        notesSaved === true &&
          (await page.waitForSelector('#model-details #jp-model-notes strong:text-is("world")', { timeout: 10000 }).then(
            () => true,
            () => false
          )),
        String(notesSaved)
      );
      await page.click('#model-details #jp-model-notes button[aria-label="Edit your notes"]');
      await page.fill('#model-details #jp-model-notes-input', 'Hello world discarded');
      await page.click('#model-details #jp-model-notes-cancel');
      await page.waitForTimeout(500);
      check(
        'cancel leaves the notes unchanged',
        (await panelModel()).notes === 'Hello **world**' && !(await page.isVisible('#model-details #jp-model-notes-input'))
      );
      await invoke(base, session, 'update-models-batch', [[{ filePath: cardPath, notes: notesBefore }]]);
      // Path row (React, src/web/details/DetailsPath.tsx): folders, then the file; a folder click filters the grid.
      const cardDir = path.dirname(cardPath);
      const pathFolder = `#path-tree-container .path-tree-folder[data-path="${cardDir.replace(/"/g, '\\"')}"]`;
      check(
        'details show the path',
        (await page.isVisible(`#path-tree-container .path-tree-file:text-is("${path.basename(cardPath)}")`)) &&
          (await page.isVisible(pathFolder)) &&
          (await page.getAttribute('#path-tree-container', 'data-file-path')) === cardPath
      );
      await page.click(pathFolder);
      const folderFiltered = await page
        .waitForFunction((dir) => window.currentDirectoryFilter === dir, cardDir, { timeout: 10000 })
        .then(
          () => true,
          () => false
        );
      check('clicking a folder in the path shows that folder', folderFiltered);
      // Folder tree (React, src/web/folders/): the select, Reveal in folders, the popover, the rail and the panel widths.
      const treeRow = (scope) => `${scope} .folder-tree-row[data-path="${cardDir.replace(/"/g, '\\"')}"]`;
      check('the Folders select follows the folder shown', (await page.inputValue('#folder-select')) === cardDir);
      await page.click('#reveal-in-folders-button');
      check(
        "Reveal in folders opens the folder panel at the model's folder",
        (await page.waitForSelector(`${treeRow('#folder-rail')}.is-selected`, { timeout: 10000 }).then(
          () => true,
          () => false
        )) && (await page.evaluate(() => document.body.classList.contains('folder-rail-open')))
      );
      await page.click('#folder-rail-close');
      const railSetting = await waitFor(
        async () => ((await invoke(base, session, 'get-setting', ['folderRailOpen'])).result === 'false' ? true : null),
        5000,
        'rail setting'
      ).catch(() => false);
      check('closing the folder panel hides it and saves that', railSetting === true && !(await page.isVisible('#folder-rail')));
      await openFilters();
      check(
        'the Filter button opens the filters',
        (await page.isVisible('#jp-filter-popover #folder-select')) && (await page.isVisible('#jp-filter-popover #sort-select'))
      );
      await page.selectOption('#folder-select', '');
      check(
        '"All folders" clears the folder',
        await page
          .waitForFunction(() => window.currentDirectoryFilter === '', null, { timeout: 10000 })
          .then(
            () => true,
            () => false
          )
      );
      await page.click('#folder-tree-button');
      await page.waitForSelector('#folder-tree-popover', { timeout: 5000 }).catch(() => {});
      await page.click('#folder-tree-button');
      check(
        'the ☰ button opens and closes the folder popover',
        await page.waitForSelector('#folder-tree-popover', { state: 'detached', timeout: 5000 }).then(
          () => true,
          () => false
        )
      );
      await page.click('#folder-tree-button');
      await page.fill('#folder-tree-search', path.basename(cardDir));
      await page.click(treeRow('#folder-tree-popover'));
      check(
        'picking a folder in the popover shows it and closes the popover',
        (await page
          .waitForFunction((dir) => window.currentDirectoryFilter === dir, cardDir, { timeout: 10000 })
          .then(
            () => true,
            () => false
          )) && !(await page.isVisible('#folder-tree-popover'))
      );
      await page.keyboard.press('Escape');
      check('Escape closes the Filter popover', !(await page.isVisible('#jp-filter-popover')));
      await page.click('#folder-rail-toggle');
      check(
        'the Folders button opens the folder panel beside the grid',
        (await page.waitForSelector(`${treeRow('#folder-rail')}.is-selected`, { timeout: 10000 }).then(
          () => true,
          () => false
        )) && (await page.evaluate(() => document.body.classList.contains('folder-rail-open')))
      );
      await page.click('#folder-rail-toggle');
      await page.waitForSelector('#folder-rail', { state: 'hidden', timeout: 5000 }).catch(() => {});
      // The details panels are the right column (src/web/styles/library-frame.css), at the spec's 360 px.
      const column = await page.locator('.sidebar').boundingBox();
      check(
        'the details column sits at the right edge, 360 px wide',
        !!column && Math.round(column.width) === 360 && Math.round(column.x + column.width) === 1400,
        JSON.stringify(column)
      );
      // Library header (src/web/pages/LibraryPage.tsx): the model count.
      const totalModels = (await invoke(base, session, 'getTotalModelCount', [])).result;
      const counted = await page
        .waitForFunction(
          (n) =>
            /^\d+ models?$/.test(document.getElementById('jp-library-count')?.textContent || '') &&
            document.getElementById('jp-library-count')?.title === `${n} models in the library`,
          totalModels,
          { timeout: 10000 }
        )
        .then(
          () => true,
          () => false
        );
      check('the header shows the models in view and in total', counted, await page.textContent('#jp-library-count'));
      await runSetting('Scan a Folder');
      const scanPicker = await page.waitForSelector('dialog.jp-folder-picker[open]:has-text("Scan Directory")', { timeout: 10000 }).catch(() => null);
      await page.fill('#folder-picker-path', browseDir);
      await page.press('#folder-picker-path', 'Enter');
      const pickerListed = await page.waitForSelector('#folder-picker-list .jp-folder-picker__folder:has-text("Prints")', { timeout: 10000 }).then(
        () => true,
        () => false
      );
      await page.click('#folder-picker-list .jp-folder-picker__folder:has-text("Prints")');
      const pickerOpened = await page
        .waitForFunction((dir) => document.getElementById('folder-picker-path')?.value === dir, path.join(browseDir, 'Prints'), { timeout: 10000 })
        .then(
          () => true,
          () => false
        );
      await page.fill('#folder-picker-path', '/etc');
      await page.press('#folder-picker-path', 'Enter');
      const pickerRefused =
        (await page.waitForSelector('.jp-folder-picker__error:has-text("cannot be browsed")', { timeout: 10000 }).then(
          () => true,
          () => false
        )) && (await page.isVisible('#folder-picker-list .jp-folder-picker__folder:has-text("Benchy")'));
      await page.click('dialog.jp-folder-picker[open] .jp-overlay__footer button:has-text("Cancel")');
      check(
        'Scan a Folder opens Choose Folder: a typed path lists its folders, a click opens one, a system folder is refused, Cancel scans nothing',
        !!scanPicker && pickerListed && pickerOpened && pickerRefused && !(await page.isVisible('dialog.jp-folder-picker[open]'))
      );
      await runSetting('View Entire Library');
      check(
        'View Entire Library leaves the folder',
        await page
          .waitForFunction(() => window.currentDirectoryFilter === '', null, { timeout: 10000 })
          .then(
            () => true,
            () => false
          )
      );
      await showLibrary();
      await page.evaluate(async () => {
        window.currentDirectoryFilter = '';
        await window.performCombinedSearch?.();
      });
      await page.waitForSelector(card, { timeout: 10000 }).catch(() => {});
      // Model menu (React, src/web/menus/ContextMenu.tsx): the card's ⋯ button (right-click does nothing), a destructive item asks first, Escape closes.
      const openCardMenu = async () => {
        await page.hover(card);
        await page.click(`${card} .thumbnail-menu-button`, { force: true });
      };
      await page.click(`${card} .file-name`, { button: 'right' });
      await page.waitForTimeout(500);
      check('right-clicking a card shows no menu', !(await page.isVisible('#html-context-menu')));
      await page.keyboard.press('Escape');
      await openCardMenu();
      check(
        "the card's ⋯ button shows the model menu, without a close button",
        (await page.waitForSelector('#html-context-menu .html-context-menu-item:text-is("Preview")', { timeout: 10000 }).then(
          () => true,
          () => false
        )) && !(await page.$('#html-context-menu .html-context-menu-close'))
      );
      await page.click('#html-context-menu .html-context-menu-item:text-is("Remove from Library")');
      const removeAsk = await page
        .waitForSelector('dialog[id^="browser-message-"][open]:has-text("Confirm Remove") button:text-is("No")', { timeout: 10000 })
        .catch(() => null);
      if (removeAsk) await removeAsk.click();
      await page.waitForSelector('#html-context-menu', { state: 'detached', timeout: 5000 }).catch(() => {});
      check(
        'Remove from Library asks first, and No keeps the model',
        !!removeAsk && !(await page.isVisible('#html-context-menu')) && !!(await invoke(base, session, 'get-model', [cardPath])).result
      );
      await openCardMenu();
      await page.waitForSelector('#html-context-menu', { timeout: 10000 }).catch(() => {});
      await page.keyboard.press('Escape');
      check(
        'Escape closes the model menu',
        await page.waitForSelector('#html-context-menu', { state: 'detached', timeout: 5000 }).then(
          () => true,
          () => false
        )
      );
      // Copy Path and Download run in this browser; another open browser gets nothing.
      const secondPage = await page.context().newPage();
      const secondDownloads = [];
      secondPage.on('download', (download) => secondDownloads.push(download.suggestedFilename()));
      await secondPage.goto(base + '/');
      await secondPage.waitForSelector(card, { timeout: 30000 }).catch(() => {});
      await page.evaluate(() => {
        window.__copiedText = null;
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text) => {
              window.__copiedText = text;
            }
          }
        });
      });
      await openCardMenu();
      await page.click('#html-context-menu .html-context-menu-item:text-is("Copy Path")');
      check(
        "Copy Path copies the model's path",
        await page
          .waitForFunction((p) => window.__copiedText === p, cardPath, { timeout: 5000 })
          .then(
            () => true,
            () => false
          ),
        await page.evaluate(() => window.__copiedText)
      );
      await openCardMenu();
      const [menuDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
        page.click('#html-context-menu .html-context-menu-item:text-is("Download")')
      ]);
      await secondPage.waitForTimeout(1500);
      check(
        'Download saves the file in this browser only',
        menuDownload?.suggestedFilename() === path.basename(cardPath) && secondDownloads.length === 0,
        JSON.stringify({ here: menuDownload?.suggestedFilename(), secondPage: secondDownloads })
      );
      await secondPage.close();
      await invoke(base, session, 'update-models-batch', [
        [
          { filePath: cardPath, designer: null, source: null },
          { filePath: listedOn, designer: null }
        ]
      ]);
      await page.click(`${card} .model-star[data-star="3"]`);
      const rated = await waitFor(
        async () => (((await invoke(base, session, 'get-model', [cardPath])).result || {}).rating === 3 ? true : null),
        10000,
        'rating'
      ).catch(() => false);
      check('a card saves its star rating', rated === true && (await page.locator(`${card} .model-star.is-filled`).count()) === 3);
      await page.click(`${card} .model-favorite-btn`);
      const favorited = await waitFor(
        async () => (((await invoke(base, session, 'get-model', [cardPath])).result || {}).favorite ? true : null),
        10000,
        'favorite'
      ).catch(() => false);
      // The card redraws after the save, so wait for it rather than reading it once.
      check(
        'a card saves its favorite',
        favorited === true &&
          (await page.waitForSelector(`${card} .model-favorite-btn.is-favorited`, { timeout: 5000 }).then(
            () => true,
            () => false
          ))
      );
      // The favorite redraws the grid; wait for the cards before picking a second one.
      await page.waitForFunction(() => document.querySelectorAll('.file-grid .file-item-detailed').length >= 2, null, { timeout: 10000 }).catch(() => {});
      const other = (await page.$$eval('.file-grid .file-item-detailed', (els) => els.map((el) => el.getAttribute('data-filepath')))).find(
        (p) => p !== cardPath
      );
      // Selection (src/web/selection.ts): the cards follow it.
      const selectedPaths = () => page.$$eval('.file-grid .file-item.selected', (els) => els.map((el) => el.getAttribute('data-filepath')));
      await page.evaluate(() => window.selection.clear());
      await page.click(`${card} .file-name`);
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('ArrowDown');
      const movedTo = await page
        .waitForFunction(
          (from) => {
            const path = document.getElementById('path-tree-container')?.getAttribute('data-file-path');
            return path && path !== from ? path : null;
          },
          cardPath,
          { timeout: 10000 }
        )
        .then(
          (h) => h.jsonValue(),
          () => null
        );
      await page.evaluate(() => window.libraryGrid?.refresh());
      const afterArrow = await selectedPaths();
      check(
        'arrow keys move the selection to the next model',
        !!movedTo && afterArrow.length === 1 && afterArrow[0] === movedTo,
        JSON.stringify({ movedTo, afterArrow })
      );
      await page.click(`.file-grid .file-item-detailed[data-filepath="${String(movedTo).replace(/"/g, '\\"')}"] .file-name`);
      await page.waitForTimeout(300);
      check('clicking the selected card again unselects it', (await selectedPaths()).length === 0 && !(await page.isVisible('#model-details')));
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
      const allSelected = await page
        .waitForFunction(() => document.querySelector('#multi-edit-panel .selected-count')?.textContent?.trim() === '3 models selected', null, {
          timeout: 10000
        })
        .then(
          () => true,
          () => false
        );
      check(
        'Ctrl/Cmd+A selects every model shown and opens multi-edit',
        allSelected && (await selectedPaths()).length === 3 && (await page.isVisible('#multi-edit-panel'))
      );
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      check('Escape clears the selection', (await selectedPaths()).length === 0 && !(await page.isVisible('#multi-edit-panel')));
      await runSetting('Print Roulette');
      const rouletteDone = await page
        .waitForSelector('dialog[id^="browser-message-"][open]:has-text("Print Roulette") button', { timeout: 20000 })
        .catch(() => null);
      const picked = await selectedPaths();
      check(
        'Print Roulette picks one model and shows it',
        !!rouletteDone && picked.length === 1 && (await page.getAttribute('#path-tree-container', 'data-file-path')) === picked[0],
        JSON.stringify(picked)
      );
      if (rouletteDone) await rouletteDone.click();
      await showLibrary();

      // Sidebar filters (React, src/web/filters/): the grid, the filter strip and the saved settings follow them.
      const third = (await page.$$eval('.file-grid .file-item-detailed[data-filepath]', (els) => els.map((el) => el.getAttribute('data-filepath')))).find(
        (p) => p !== cardPath && p !== other
      );
      const shownPaths = () => page.$$eval('.file-grid .file-item-detailed[data-filepath]', (els) => els.map((el) => el.getAttribute('data-filepath')).sort());
      const waitShown = (paths) =>
        page
          .waitForFunction(
            (want) => {
              const have = [...document.querySelectorAll('.file-grid .file-item-detailed[data-filepath]')].map((el) => el.getAttribute('data-filepath')).sort();
              return JSON.stringify(have) === JSON.stringify([...want].sort());
            },
            paths,
            { timeout: 10000 }
          )
          .then(
            () => true,
            async () => JSON.stringify(await shownPaths())
          );
      const stripText = () => page.textContent('#current-filter-body').then((t) => t.replace(/\s+/g, ' ').trim());
      await invoke(base, session, 'update-models-batch', [
        [
          { filePath: other, designer: 'E2E Sidebar Designer', tags: ['e2e-s1'] },
          { filePath: third, tags: ['e2e-s1', 'e2e-s2'] }
        ]
      ]);
      await page.evaluate(() => window.libraryFilters.reloadOptions());
      await page.waitForSelector('#designer-select option[value="E2E Sidebar Designer"]', { state: 'attached', timeout: 10000 }).catch(() => {});
      await openFilters();
      await page.selectOption('#designer-select', 'E2E Sidebar Designer');
      const byDesigner = await waitShown([other]);
      check(
        'the designer filter narrows the grid and shows in the filter strip',
        byDesigner === true && /Showing 1 models.*Designer: E2E Sidebar Designer/.test(await stripText()),
        `${byDesigner} ${await stripText()}`
      );
      await page.click('#current-filter-body .filter-pill:has-text("Designer:") .filter-remove');
      check(
        'removing a filter chip shows the library again',
        (await waitShown([cardPath, other, third])) === true && !(await page.isVisible('#current-filter-body .filter-pill'))
      );
      const cardName = path.basename(cardPath);
      await openFilters();
      await page.fill('#search-filter-input', cardName);
      await page.press('#search-filter-input', 'Enter');
      check(
        'a search narrows the grid and becomes a chip',
        (await waitShown([cardPath])) === true &&
          (await page.inputValue('#search-filter-input')) === '' &&
          (await stripText()).includes(`Search: "${cardName}"`)
      );
      await page.click('#search-add-or-btn');
      const awaitingHint = await page.isVisible('#search-boolean-hint');
      await openFilters();
      await page.selectOption('#designer-select', 'E2E Sidebar Designer');
      const orResult = await waitShown([cardPath, other]);
      check(
        'OR then a filter pick adds it to the query',
        awaitingHint &&
          orResult === true &&
          /Search: ".*".*OR.*Designer: E2E Sidebar Designer/.test(await stripText()) &&
          (await page.inputValue('#designer-select')) === '',
        `${awaitingHint} ${orResult} ${await stripText()}`
      );
      await page.click('#invert-filter-button');
      const inverted = await waitShown([third]);
      check(
        'Invert Filters inverts the query',
        inverted === true && (await stripText()).includes('NOT') && (await page.getAttribute('#invert-filter-button', 'class')) === 'active',
        `${inverted} ${await stripText()}`
      );
      await page.click('#clear-all-filters-button');
      check(
        'Clear All Filters shows the whole library',
        (await waitShown([cardPath, other, third])) === true &&
          !(await page.isVisible('#clear-all-filters-button')) &&
          !(await page.getAttribute('#invert-filter-button', 'class'))
      );
      await openFilters();
      await page.selectOption('#tag-filter', 'e2e-s1');
      const oneTag = await waitShown([other, third]);
      await page.selectOption('#tag-filter', 'e2e-s2');
      const bothTags = await waitShown([third]);
      check(
        'two tags must both match by default',
        oneTag === true &&
          bothTags === true &&
          (await page.isVisible('#tags-combine-row')) &&
          (await page.locator('#tags-filter-chips .filter-value-chip').count()) === 2,
        `${oneTag} ${bothTags}`
      );
      await page.check('#tags-combine-row input[value="OR"]');
      check('Any tag matches either tag', (await waitShown([other, third])) === true && (await stripText()).includes('(any)'));
      await page.click('#clear-all-filters-button');
      await waitShown([cardPath, other, third]);
      await openFilters();
      await page.selectOption('#sort-select', 'name-asc');
      const savedSort = await waitFor(
        async () => ((await invoke(base, session, 'get-setting', ['sortOption'])).result === 'name-asc' ? true : null),
        10000,
        'sort saved'
      ).catch(() => false);
      const sortedNames = await page
        .waitForFunction(
          () => {
            const names = [...document.querySelectorAll('.file-grid .file-item-detailed .file-name')].map((el) => el.textContent.trim().toLowerCase());
            return JSON.stringify(names) === JSON.stringify([...names].sort()) ? names : null;
          },
          null,
          { timeout: 10000 }
        )
        .then(
          (h) => h.jsonValue(),
          async () => page.$$eval('.file-grid .file-item-detailed .file-name', (els) => els.map((el) => el.textContent.trim()))
        );
      check(
        'the sort order applies and is saved',
        savedSort === true && JSON.stringify(sortedNames) === JSON.stringify([...sortedNames].sort()),
        JSON.stringify(sortedNames)
      );
      await page.selectOption('#sort-select', 'date-desc');
      await page.uncheck('#search-include-notes');
      const notesSettingSaved = await waitFor(
        async () => ((await invoke(base, session, 'get-setting', ['searchIncludeNotes'])).result === '0' ? true : null),
        10000,
        'notes saved'
      ).catch(() => false);
      check('the notes toggle is saved', notesSettingSaved === true);
      await page.check('#search-include-notes');
      await invoke(base, session, 'update-models-batch', [
        [
          { filePath: other, designer: null, tags: [] },
          { filePath: third, tags: [] }
        ]
      ]);
      await page.evaluate(() => window.libraryFilters.reloadOptions());
      // Ctrl-click is a right-click on macOS; the app takes Cmd there.
      const multiKey = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.click(`${card} .file-name`, { modifiers: [multiKey] });
      await page.click(`.file-grid .file-item-detailed[data-filepath="${other.replace(/"/g, '\\"')}"] .file-name`, { modifiers: [multiKey] });
      check(
        'Ctrl/Cmd-click chooses several cards in Edit mode, which opens Multi-edit',
        (await page.locator('.file-grid .file-item.selected').count()) === 2 && (await page.isVisible('#multi-edit-panel'))
      );
      // Multi-edit panel (React, src/web/details/MultiEditPanel.tsx): each change applies to both selected models.
      const pair = [cardPath, other];
      const pairModels = async () => Promise.all(pair.map(async (p) => (await invoke(base, session, 'get-model', [p])).result || {}));
      const pairBefore = await pairModels();
      check('the multi-edit panel counts the selection', /^2 models selected$/.test((await page.textContent('#multi-edit-panel .selected-count')).trim()));
      // The server asks every page to refresh its grid (after a scan, an MCP edit, ...): the selection stays.
      await page.evaluate(() => Promise.all(((window._electronEventListeners || {})['refresh-grid'] || []).map((listener) => listener())));
      await page.waitForTimeout(1000);
      check(
        'a server grid refresh keeps the multi-edit selection',
        (await page.locator('.file-grid .file-item.selected').count()) === 2 &&
          (await page.isVisible('#multi-edit-panel')) &&
          /^2 models selected$/.test((await page.textContent('#multi-edit-panel .selected-count')).trim()),
        JSON.stringify(
          await page.evaluate(() => ({ selected: window.selection.size, highlighted: document.querySelectorAll('.file-grid .file-item.selected').length }))
        )
      );
      await page.click('#multi-designer-add');
      const multiPrompt = await page.waitForSelector('dialog.browser-input-dialog[open] input', { timeout: 10000 }).catch(() => null);
      if (multiPrompt) {
        await multiPrompt.fill('E2E Multi Designer');
        await page.click('dialog.browser-input-dialog[open] button[type=submit]');
      }
      const multiDesigner = await waitFor(
        async () => ((await pairModels()).every((m) => m.designer === 'E2E Multi Designer') ? true : null),
        10000,
        'multi designer'
      ).catch(() => false);
      check('multi-edit sets a new designer on every selected model', multiDesigner === true);
      await page.selectOption('#multi-tag-select', 'e2e-model-tag');
      const hasTag = (m) => (m.tags || []).some((t) => (t.name || t) === 'e2e-model-tag');
      const tagOnBoth = await waitFor(async () => ((await pairModels()).every(hasTag) ? true : null), 10000, 'multi tag').catch(() => false);
      check('multi-edit adds a tag to every selected model', tagOnBoth === true);
      await page.waitForSelector('#multi-tag-remove-select option[value="e2e-model-tag"]', { state: 'attached', timeout: 10000 }).catch(() => {});
      await page.selectOption('#multi-tag-remove-select', 'e2e-model-tag').catch(() => {});
      const confirmRemoveTag = await page.waitForSelector('dialog[id^="browser-message-"][open] button:text-is("Yes")', { timeout: 10000 }).catch(() => null);
      if (confirmRemoveTag) await confirmRemoveTag.click();
      const tagOffBoth = await waitFor(async () => ((await pairModels()).every((m) => !hasTag(m)) ? true : null), 10000, 'multi untag').catch(() => false);
      check('multi-edit removes a tag from every selected model after asking', !!confirmRemoveTag && tagOffBoth === true);
      check('multi-edit has no Filament section', !(await page.$('#multi-filament-select')));
      check('multi-edit offers Merge for two models', await page.isEnabled('#multi-merge'));
      // Collections (Multi-edit): a new collection with the chosen models, then an existing one from the picker.
      const inCollection = async (name) => {
        const list = (await invoke(base, session, 'get-collections')).result || [];
        const found = list.find((c) => c.name === name);
        if (!found) return [];
        return (((await invoke(base, session, 'get-collection', [found.id])).result || {}).models || []).map((m) => m.filePath);
      };
      await page.click('#multi-collection-add');
      const collectionPrompt = await page.waitForSelector('dialog.browser-input-dialog[open] input', { timeout: 10000 }).catch(() => null);
      if (collectionPrompt) {
        await collectionPrompt.fill('E2E Multi Collection');
        await page.click('dialog.browser-input-dialog[open] button[type=submit]');
      }
      const madeCollection = await waitFor(
        async () => ((await inCollection('E2E Multi Collection')).sort().join('|') === [...pair].sort().join('|') ? true : null),
        10000,
        'multi collection'
      ).catch(async () => JSON.stringify(await inCollection('E2E Multi Collection')));
      check(
        'multi-edit makes a new collection with the chosen models',
        madeCollection === true && /Added 2 models to E2E Multi Collection/.test((await page.textContent('#multi-collection-note').catch(() => '')) || ''),
        String(madeCollection)
      );
      await invoke(base, session, 'create-collection', [{ name: 'E2E Multi Existing' }]);
      await page.waitForSelector('#multi-collection-select option:text-is("E2E Multi Existing")', { state: 'attached', timeout: 10000 }).catch(() => {});
      const existingCollectionId = String(
        ((await invoke(base, session, 'get-collections')).result || []).find((c) => c.name === 'E2E Multi Existing')?.id || ''
      );
      await page.selectOption('#multi-collection-select', existingCollectionId).catch(() => {});
      const addedToExistingCollection = await waitFor(
        async () => ((await inCollection('E2E Multi Existing')).length === 2 ? true : null),
        10000,
        'existing collection'
      ).catch(() => false);
      check('multi-edit adds the chosen models to an existing collection', addedToExistingCollection === true);
      check(
        'multi-edit can delete the chosen models from the library or from disk',
        (await page.isVisible('#multi-delete-library')) && (await page.isVisible('#multi-delete-disk'))
      );
      // Merge (Multi-edit): pick the main model; the other is merged into it (one card), and Multi-edit closes.
      await page.click('#multi-merge');
      const mergeMain = await page.waitForSelector('#jp-merge-main', { timeout: 10000 }).catch(() => null);
      if (mergeMain) {
        await page.selectOption('#jp-merge-main', pair[0]);
        await page.click('#jp-merge-submit');
      }
      const mergedPair = await waitFor(
        async () => {
          const [main, merged] = await pairModels();
          return main.id && merged.partOf === main.id && !main.partOf ? true : null;
        },
        10000,
        'merged'
      ).catch(async () => JSON.stringify((await pairModels()).map((m) => m.partOf)));
      const mergedCardGone = await page
        .waitForSelector(`.file-grid [data-filepath="${pair[1].replace(/"/g, '\\"')}"]`, { state: 'detached', timeout: 10000 })
        .then(
          () => true,
          () => false
        );
      check(
        'Merge merges the chosen models into the main one: one card in the library',
        !!mergeMain && mergedPair === true && mergedCardGone,
        String(mergedPair)
      );
      await invoke(base, session, 'set-model-parts', [null, [pair[1]]]);
      await invoke(base, session, 'update-models-batch', [pairBefore.map((m) => ({ filePath: m.filePath, designer: m.designer || null, tags: m.tags || [] }))]);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      check('Escape leaves multi-edit', !(await page.isVisible('#multi-edit-panel')));
      // Shift-click: every card from the one clicked last to this one, in grid order; the pointer stays the arrow.
      const ordered = await page.$$eval('.file-grid .file-item-detailed[data-filepath]', (els) =>
        els.sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index)).map((el) => el.getAttribute('data-filepath'))
      );
      if (ordered.length >= 3) {
        const cardAt = (i) => `.file-grid .file-item-detailed[data-filepath="${ordered[i].replace(/"/g, '\\"')}"] .file-name`;
        await page.click(cardAt(0));
        await page.click(cardAt(2), { modifiers: ['Shift'] });
        const rangeChosen = await page
          .waitForFunction(() => document.querySelectorAll('.file-grid .file-item.selected').length === 3, null, { timeout: 10000 })
          .then(
            () => true,
            () => false
          );
        check(
          'Shift-click chooses every card in between and opens Multi-edit',
          rangeChosen &&
            (await page.isVisible('#multi-edit-panel')) &&
            /^3 models selected$/.test((await page.textContent('#multi-edit-panel .selected-count')).trim())
        );
        const cursors = await page.evaluate(
          (sel) => [document.querySelector(sel)?.closest('.file-item'), document.querySelector(sel)].map((el) => (el ? getComputedStyle(el).cursor : null)),
          cardAt(1)
        );
        check(
          'cards show the normal arrow pointer',
          cursors.every((c) => c === 'default'),
          JSON.stringify(cursors)
        );
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      }
      await invoke(base, session, 'update-models-batch', [[{ filePath: cardPath, rating: 0, favorite: 0 }]]);

      // A model with several images shows a carousel; the image left showing becomes the default.
      const images = await page.evaluate(() =>
        ['#d33', '#33d'].map((color) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 64;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 64, 64);
          return canvas.toDataURL('image/png');
        })
      );
      await invoke(base, session, 'add-multiple-thumbnails', [cardPath, images]);
      const total = ((await invoke(base, session, 'get-all-thumbnails', [cardPath])).result || []).length;
      await page.evaluate(() => window.performCombinedSearch({ force: true }));
      const badge = await page.waitForSelector(`${card} .thumbnail-count-badge`, { timeout: 15000 }).catch(() => null);
      check(
        'a card with several images shows the carousel',
        !!badge && (await badge.textContent()).trim() === `1/${total}`,
        badge && (await badge.textContent())
      );
      if (badge) {
        await page.click(`${card} .thumbnail-nav-right`);
        check('the carousel steps to the next image', (await page.textContent(`${card} .thumbnail-count-badge`)).trim() === `2/${total}`);
        const second = await page.getAttribute(`${card} .thumbnail-container img`, 'src');
        const saved = await waitFor(
          async () => {
            const thumbnail = ((await invoke(base, session, 'get-model', [cardPath])).result || {}).thumbnail || '';
            return thumbnail.split('::')[0] === second ? true : null;
          },
          10000,
          'default image'
        ).catch(() => false);
        check('the image left showing becomes the default', saved === true);
        // Manage Thumbnails (React, src/web/ManageThumbnailsDialog.tsx).
        const storedImages = async () =>
          ((await invoke(base, session, 'get-all-thumbnails', [cardPath])).result || []).filter((t) => String(t).startsWith('data:image'));
        await page.evaluate((p) => window.openManageThumbnails(p), cardPath);
        const manage = await page.waitForSelector('#manage-thumbnails-dialog[open] .thumbnail-item', { timeout: 10000 }).catch(() => null);
        const beforeManage = await storedImages();
        check(
          'Manage Thumbnails lists the images with the active one first',
          !!manage &&
            (await page.locator('#manage-thumbnails-dialog .thumbnail-item').count()) === beforeManage.length &&
            (await page.textContent('#manage-thumbnails-dialog .thumbnail-item.active .thumbnail-item-label')) === 'Active'
        );
        await page.click('#manage-thumbnails-dialog .thumbnail-item[data-index="1"] .set-active', { force: true });
        const activated = await waitFor(async () => ((await storedImages())[0] === beforeManage[1] ? true : null), 10000, 'set active').catch(() => false);
        check('Manage Thumbnails sets another image as active', activated === true);
        await page
          .waitForSelector('#manage-thumbnails-dialog .thumbnail-item[data-index="1"] .delete:not([disabled])', { state: 'attached', timeout: 10000 })
          .catch(() => {});
        await page.click('#manage-thumbnails-dialog .thumbnail-item[data-index="1"] .delete', { force: true });
        const confirmThumbDelete = await page
          .waitForSelector('dialog[id^="browser-message-"][open] button:text-is("Delete")', { timeout: 10000 })
          .catch(() => null);
        if (confirmThumbDelete) await confirmThumbDelete.click();
        const deletedImage = await waitFor(async () => ((await storedImages()).length === beforeManage.length - 1 ? true : null), 10000, 'delete image').catch(
          () => false
        );
        const listShrunk = await page
          .waitForFunction((n) => document.querySelectorAll('#manage-thumbnails-dialog .thumbnail-item').length === n, beforeManage.length - 1, {
            timeout: 10000
          })
          .then(
            () => true,
            () => false
          );
        check(
          'Manage Thumbnails deletes an image after asking',
          !!confirmThumbDelete && deletedImage === true && listShrunk,
          JSON.stringify({ confirm: !!confirmThumbDelete, saved: deletedImage, listShrunk, before: beforeManage.length, after: (await storedImages()).length })
        );
        await page.click('#manage-thumbnails-dialog .dialog-buttons button');
        const cardShowsActive = await page
          .waitForFunction(([sel, src]) => document.querySelector(`${sel} .thumbnail-container img`)?.getAttribute('src') === src, [card, beforeManage[1]], {
            timeout: 10000
          })
          .then(
            () => true,
            () => false
          );
        check('closing Manage Thumbnails redraws the card with the active image', !(await page.isVisible('#manage-thumbnails-dialog')) && cardShowsActive);
      }
    }
    // Merged models: one card in the library; the main model's page lists the merged one, which says where it is merged.
    const grouped = (await page.$$eval('.file-grid .file-item-detailed[data-filepath]', (els) => els.map((el) => el.getAttribute('data-filepath')))).slice(
      0,
      2
    );
    await invoke(base, session, 'set-model-parts', [grouped[0], [grouped[1]]]);
    await page.evaluate(() => window.performCombinedSearch({ force: true }));
    const cardOfPath = (p) => `.file-grid [data-filepath="${p.replace(/"/g, '\\"')}"]`;
    const oneCard = await page.waitForSelector(cardOfPath(grouped[1]), { state: 'detached', timeout: 15000 }).then(
      () => true,
      () => false
    );
    check('merged models show as one card', oneCard && (await page.isVisible(cardOfPath(grouped[0]))));
    await page.evaluate((file) => {
      window.location.hash = `#/model/${encodeURIComponent(file)}`;
    }, grouped[0]);
    const mergedListed = await page.waitForSelector(`.jp-model-file[data-filepath="${grouped[1].replace(/"/g, '\\"')}"]`, { timeout: 15000 }).then(
      () => true,
      () => false
    );
    check("the main model's page lists the models merged into it", mergedListed);
    await page.evaluate((file) => {
      window.location.hash = `#/model/${encodeURIComponent(file)}`;
    }, grouped[1]);
    const mergedNote = await page
      .waitForSelector('#jp-model-merged-into', { timeout: 15000 })
      .then((el) => el.textContent())
      .catch(() => '');
    check("a merged model's page says what it is merged into, with Un-merge", /Merged into/.test(mergedNote) && /Un-merge/.test(mergedNote), mergedNote);
    await invoke(base, session, 'set-model-parts', [null, [grouped[1]]]);
    await page.evaluate(() => {
      window.location.hash = '#/library';
    });
    await page.waitForSelector(cardOfPath(grouped[1]), { timeout: 15000 }).catch(() => {});
    // Edit mode (the header's Edit button), and Done leaves it.
    await page.click('#jp-edit-button');
    await page.click('#jp-edit-button');
    check('Done leaves Edit mode', !(await page.isVisible('#multi-edit-panel')) && !(await page.isVisible('#jp-edit-hint')));
    // 8.0: a model's Title is its name on cards (the file's name otherwise), and a Title alone makes no group.
    await invoke(base, session, 'update-models-batch', [[{ filePath: grouped[0], title: 'E2E Shown Title' }]]);
    await page.evaluate(() => window.performCombinedSearch({ force: true }));
    const titledCard = `.file-grid .file-item-detailed[data-filepath="${grouped[0].replace(/"/g, '\\"')}"] .file-name`;
    const titleShown = await page
      .waitForFunction((sel) => document.querySelector(sel)?.textContent?.trim() === 'E2E Shown Title', titledCard, { timeout: 15000 })
      .then(
        () => true,
        () => false
      );
    check("a model's Title is its name on its card", titleShown, (await page.textContent(titledCard).catch(() => '')) || '');
    await invoke(base, session, 'update-models-batch', [[{ filePath: grouped[0], title: null }]]);
    await page.evaluate(() => window.performCombinedSearch({ force: true }));

    // Grid toolbar and list view columns (React, src/web/grid/GridToolbar.tsx, ListHeader.tsx, columns.ts).
    await page.click('.view-button[data-view="list"]');
    const listShown = await page.waitForSelector('.file-grid .list-view-header [data-list-col="name"] .sortable-header', { timeout: 10000 }).then(
      () => true,
      () => false
    );
    const savedView = await waitFor(
      async () => ((await invoke(base, session, 'get-setting', ['gridView'])).result === 'list' ? true : null),
      5000,
      'gridView'
    ).catch(() => false);
    check(
      'the List button shows the list with its column header, and is saved',
      listShown &&
        savedView === true &&
        (await page.isVisible('#list-view-columns-toolbar-btn')) &&
        (await page.isVisible('.view-button.active[data-view="list"]'))
    );
    await page.click('.list-view-header [data-list-col="name"] .sortable-header');
    const sortedByName = await page
      .waitForFunction(
        () =>
          window.libraryFilters.state().sort === 'name-asc' &&
          document.querySelector('.list-view-header [data-list-col="name"] .sort-indicator')?.textContent === '↑',
        null,
        { timeout: 5000 }
      )
      .then(
        () => true,
        () => false
      );
    await page.click('.list-view-header [data-list-col="name"] .sortable-header');
    const sortedDesc = await page
      .waitForFunction(() => window.libraryFilters.state().sort === 'name-desc', null, { timeout: 5000 })
      .then(
        () => true,
        () => false
      );
    check('clicking a column title sorts by it, and again the other way', sortedByName && sortedDesc);
    await page.evaluate(() => window.libraryFilters.setSort('dateAdded DESC'));
    await page.click('#list-view-columns-toolbar-btn');
    await page.uncheck('.list-view-columns-popover input[data-col-id="size"]');
    const sizeHidden = await page
      .waitForFunction(() => [...document.querySelectorAll('.file-grid [data-list-col="size"]')].every((el) => el.style.display === 'none'), null, {
        timeout: 5000
      })
      .then(
        () => true,
        () => false
      );
    const layoutSaved = await waitFor(
      async () => {
        const raw = (await invoke(base, session, 'get-setting', ['listViewColumnLayout'])).result;
        return raw && JSON.parse(raw).visibility.size === false ? true : null;
      },
      5000,
      'column layout'
    ).catch(() => false);
    check('Show/Hide columns hides a column in the header and rows, and saves it', sizeHidden && layoutSaved === true);
    await page.check('.list-view-columns-popover input[data-col-id="size"]');
    // An empty spot of the top bar (the corner is the JusttPrint logo, which opens Home).
    await page.mouse.click(240, 20);
    check('a click outside closes the columns popover', !(await page.isVisible('.list-view-columns-popover')));
    const nameCell = await page.locator('.list-view-header [data-list-col="name"]').boundingBox();
    const handle = await page.locator('.list-view-header [data-list-col="name"] .list-view-col-resize-handle').boundingBox();
    if (handle) {
      // The handle straddles the cell edge; the cell clips its outer half.
      await page.mouse.move(handle.x + 1, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + 61, handle.y + handle.height / 2, { steps: 4 });
      await page.mouse.up();
    }
    const widened = await page.evaluate(() => document.querySelector('.list-view-header [data-list-col="name"]').getBoundingClientRect().width);
    const rowWidth = await page.evaluate(() => document.querySelector('.file-grid .file-info [data-list-col="name"]')?.getBoundingClientRect().width);
    check(
      'dragging a column edge widens the column in the header and rows',
      !!nameCell && widened > nameCell.width + 40 && Math.abs(rowWidth - widened) < 2,
      `${nameCell && nameCell.width} -> ${widened} (row ${rowWidth})`
    );
    const dragColumn = async (from, to) => {
      const a = await page.locator(`.list-view-header [data-list-col="${from}"] .sortable-header`).boundingBox();
      const b = await page.locator(`.list-view-header [data-list-col="${to}"]`).boundingBox();
      await page.mouse.move(a.x + 10, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + 5, b.y + b.height / 2, { steps: 6 });
      await page.mouse.up();
    };
    await dragColumn('size', 'name');
    const moved = await page.evaluate(() => {
      const left = (sel) => document.querySelector(sel)?.getBoundingClientRect().left ?? 0;
      return (
        left('.list-view-header [data-list-col="size"]') < left('.list-view-header [data-list-col="name"]') &&
        left('.file-grid .file-info [data-list-col="size"]') < left('.file-grid .file-info [data-list-col="name"]')
      );
    });
    check(
      'dragging a column title moves the column in the header and rows, without sorting',
      moved && (await page.evaluate(() => window.libraryFilters.state().sort)) === 'dateAdded DESC'
    );
    await dragColumn('name', 'size');
    await page.click('.view-button[data-view="preview"]');
    await page.click('#preview-size-switcher [data-preview-size="s"]');
    const smallTiles = await waitFor(
      async () => ((await invoke(base, session, 'get-setting', ['previewTileSize'])).result === 's' ? true : null),
      5000,
      'tile size'
    ).catch(() => false);
    check(
      'the tile size switcher shows smaller tiles and saves the size',
      smallTiles === true && (await page.isVisible('#preview-size-switcher [data-preview-size="s"].active')) && !(await page.isVisible('.list-view-header'))
    );
    await page.click('#preview-size-switcher [data-preview-size="m"]');

    // Searchable list (React, src/web/components/ListPicker.tsx): search narrows it, Cancel picks nothing.
    await openFilters();
    await page.click('#tag-filter + .list-button, .form-group:has(#tag-filter) .list-button');
    await page.waitForSelector('#searchable-list-dialog[open] li', { timeout: 10000 }).catch(() => {});
    const allTags = await page.locator('#searchable-list-dialog li').count();
    await page.fill('#searchable-list-search', 'e2e-model');
    const narrowed = await page.locator('#searchable-list-dialog li').count();
    await page.click('#searchable-list-cancel');
    check(
      'the searchable list narrows as you type, and Cancel closes it without a pick',
      allTags > 1 &&
        narrowed >= 1 &&
        narrowed < allTags &&
        !(await page.isVisible('#searchable-list-dialog')) &&
        (await page.evaluate(() => window.libraryFilters.state().tags.length)) === 0,
      `${allTags} -> ${narrowed}`
    );
    await page.evaluate(() => document.getElementById('preview-dialog').showModal());
    await page.click('#preview-fullscreen-toggle');
    check('the preview goes full screen', await page.evaluate(() => document.getElementById('preview-dialog').classList.contains('modal-fullscreen')));
    await page.click('#preview-fullscreen-toggle');
    await page.evaluate(() => document.getElementById('preview-dialog').close());
    // STEP previews compile WebAssembly in the parse worker ('wasm-unsafe-eval').
    const stepResult = await page.evaluate(
      async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const worker = new Worker(window.parseWorkerUrl);
        const reply = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ success: false, error: 'timeout' }), 60000);
          worker.onmessage = (event) => {
            clearTimeout(timer);
            resolve(event.data);
          };
          worker.onerror = (event) => {
            clearTimeout(timer);
            resolve({ success: false, error: event.message });
          };
          worker.postMessage({ id: 1, fileExtension: 'stp', arrayBuffer: bytes.buffer }, [bytes.buffer]);
        });
        worker.terminate();
        return { success: reply.success, geometries: (reply.geometries || []).length, error: reply.error };
      },
      fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'step-cube.stp')).toString('base64')
    );
    check('STEP preview parses in the browser (WebAssembly under CSP)', stepResult.success === true && stepResult.geometries > 0, JSON.stringify(stepResult));

    // Send to Slicer in the page: the server's command becomes a justtprint:// link for the helper.
    // Its own tab: on Linux, Chrome asks whether to open the unknown link in another app, and that
    // prompt blocks mouse and keyboard input to the tab until it is closed.
    await invoke(base, session, 'save-slicer', [{ name: 'Browser Slicer', path: '/usr/bin/browser-slicer' }]);
    const slicerPage = await page.context().newPage();
    await slicerPage.goto(base + '/');
    await slicerPage.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    const helperLink = await slicerPage.evaluate(
      async (file) => {
        const slicers = await window.electron.getSlicers();
        const slicer = slicers.find((s) => s.name === 'Browser Slicer');
        const result = await window.electron.openFileInSlicer({ filePaths: [file], slicerId: slicer.id });
        window.electron.launchSlicerCommand(result.command);
        const frame = [...document.querySelectorAll('iframe')].find((f) => String(f.src).startsWith('justtprint://'));
        return frame ? frame.src : null;
      },
      path.join(LIBRARY, 'Designer A', 'cube.stl')
    );
    await slicerPage.close();
    check(
      'Send to Slicer opens a helper link with a download token',
      /^justtprint:\/\/open\/\?.*token=/.test(helperLink || '') && helperLink.includes('browser-slicer'),
      helperLink
    );
    const browserSlicer = ((await invoke(base, session, 'get-slicers')).result || []).find((s) => s.name === 'Browser Slicer');
    if (browserSlicer) await invoke(base, session, 'delete-slicer', [browserSlicer.id]);

    // Rename a designer through the in-page input dialog (Metadata Manager).
    const cube = path.join(LIBRARY, 'Designer A', 'cube.stl');
    await invoke(base, session, 'update-models-batch', [[{ filePath: cube, designer: 'Old Designer' }]]);
    await page.evaluate(() => window.openMetadataEditor());
    await page.waitForSelector('#metadata-editor-dialog[open]', { timeout: 15000 }).catch(() => {});
    const renameButton = await page
      .waitForSelector('#metadata-editor-dialog .metadata-item:has-text("Old Designer") .metadata-rename', { timeout: 15000 })
      .catch(() => null);
    if (renameButton) {
      await renameButton.click();
      const prompt = await page.waitForSelector('dialog.browser-input-dialog[open] input', { timeout: 10000 }).catch(() => null);
      check('rename opens an in-page input dialog', !!prompt);
      if (prompt) {
        await prompt.fill('New Designer');
        await page.click('dialog.browser-input-dialog[open] button[type=submit]');
        const renamed = await waitFor(
          async () => {
            const model = await invoke(base, session, 'get-model', [cube]);
            return model.result && model.result.designer === 'New Designer';
          },
          15000,
          'designer rename'
        ).catch(() => false);
        check('designer renamed in the JusttPrint backend', renamed === true);
        const listed = await page.waitForSelector('#metadata-editor-dialog .metadata-item:has-text("New Designer")', { timeout: 10000 }).catch(() => null);
        check(
          'Metadata Manager list shows the new name',
          !!listed && !(await page.isVisible('#metadata-editor-dialog .metadata-item:has-text("Old Designer")'))
        );
        await page.fill('#metadata-editor-search', 'zzz-no-match');
        check('Metadata Manager search filters the list', await page.isVisible('#metadata-editor-dialog .no-metadata'));
        await page.click('#clear-metadata-search');
        await page.click('#metadata-editor-dialog .metadata-item:has-text("New Designer") .metadata-delete');
        const confirmClear = await page.waitForSelector('dialog[open]:has-text("Delete Designer") button:text-is("Yes")', { timeout: 10000 }).catch(() => null);
        if (confirmClear) await confirmClear.click();
        const cleared = await waitFor(
          async () => {
            const model = await invoke(base, session, 'get-model', [cube]);
            return model.result && !model.result.designer;
          },
          15000,
          'designer cleared'
        ).catch(() => false);
        check('Metadata Manager clears a designer after asking', !!confirmClear && cleared === true);

        // Undo, in the dialog's own Undo line (the page's notice is behind the dialog): the clear, then the rename.
        const designerIs = (name, what) =>
          waitFor(
            async () => {
              const model = await invoke(base, session, 'get-model', [cube]);
              return model.result && (model.result.designer || '') === name;
            },
            15000,
            what
          ).catch(() => false);
        const undoLine = await page.waitForSelector('#metadata-editor-undo', { timeout: 10000 }).catch(() => null);
        if (undoLine) await undoLine.click();
        check('Metadata Editor undoes clearing a designer', !!undoLine && (await designerIs('New Designer', 'clear undone')) === true);
        const undoRename = await page
          .waitForSelector('#metadata-editor-dialog .metadata-editor-undo:has-text("Renamed")', { timeout: 10000 })
          .catch(() => null);
        if (undoRename) await page.click('#metadata-editor-undo');
        check('Metadata Editor undoes a rename', !!undoRename && (await designerIs('Old Designer', 'rename undone')) === true);
        check(
          'the Metadata Editor list shows the undone name',
          !!(await page.waitForSelector('#metadata-editor-dialog .metadata-item:has-text("Old Designer")', { timeout: 10000 }).catch(() => null))
        );

        // A merge is undone on the models it changed only, and keeps edits made since.
        const ball = path.join(LIBRARY, 'Designer A', 'cube.stl');
        const other = (await invoke(base, session, 'get-model', [path.join(LIBRARY, 'Designer B', 'box.3mf')])).result;
        if (other) {
          await invoke(base, session, 'update-models-batch', [[{ filePath: other.filePath, designer: 'Merge Target' }]]);
          const merged = (await invoke(base, session, 'rename-metadata', ['designer', 'Old Designer', 'Merge Target'])).result || {};
          const cubeId = (await invoke(base, session, 'get-model', [ball])).result?.id;
          check(
            'a merge reports the models it changed',
            merged.merged === true && JSON.stringify(merged.modelIds) === JSON.stringify([cubeId]),
            JSON.stringify(merged)
          );
          const restored =
            (await invoke(base, session, 'restore-metadata', [{ type: 'designer', name: 'Old Designer', current: 'Merge Target', modelIds: merged.modelIds }]))
              .result || {};
          const otherAfter = (await invoke(base, session, 'get-model', [other.filePath])).result?.designer;
          check(
            'undoing a merge splits it again',
            restored.restored === 1 && (await designerIs('Old Designer', 'merge undone')) === true && otherAfter === 'Merge Target'
          );
          await invoke(base, session, 'rename-metadata', ['designer', 'Old Designer', 'Merge Target']);
          await invoke(base, session, 'update-models-batch', [[{ filePath: ball, designer: 'Edited Since' }]]);
          const kept =
            (await invoke(base, session, 'restore-metadata', [{ type: 'designer', name: 'Old Designer', current: 'Merge Target', modelIds: merged.modelIds }]))
              .result || {};
          check('undo keeps a value edited since', kept.restored === 0 && (await designerIs('Edited Since', 'edit kept')) === true);
          await invoke(base, session, 'update-models-batch', [[{ filePath: other.filePath, designer: other.designer || '' }]]);
        } else {
          check('a second model for the merge undo', false);
        }
        await invoke(base, session, 'update-models-batch', [[{ filePath: ball, designer: '' }]]);
      }
    } else {
      check('Metadata Manager lists the designer', false, 'rename button not found');
    }
    await page.evaluate(() => document.getElementById('metadata-editor-dialog')?.close());

    // Server-initiated confirmation (Pull Metadata over existing details) shows in this browser.
    const box3mf = path.join(LIBRARY, 'Designer B', 'box.3mf');
    await invoke(base, session, 'update-models-batch', [[{ filePath: box3mf, designer: 'Keep Me' }]]);
    const pull = page.evaluate((file) => window.electron.pull3MFMetadata([file]), box3mf);
    const confirmDialog = await page
      .waitForSelector('dialog[open]:has-text("Confirm Metadata Overwrite") button:text-is("No")', { timeout: 15000 })
      .catch(() => null);
    check('server confirmation appears in the browser', !!confirmDialog);
    if (confirmDialog) {
      await confirmDialog.click();
      const pullResult = await pull.catch((error) => ({ error: error.message }));
      check('answering No cancels Pull Metadata', pullResult && pullResult.cancelled === true, JSON.stringify(pullResult));
      const kept = await invoke(base, session, 'get-model', [box3mf]);
      check('existing designer kept', kept.result && kept.result.designer === 'Keep Me');
    }

    // Opening a dialog in one tab must not open it in another tab.
    const otherTab = await page.context().newPage();
    await otherTab.goto(base + '/');
    await otherTab.waitForFunction(() => window._electronBridgeReady === true && typeof window.openTagManager === 'function', null, { timeout: 60000 });
    await page.evaluate(() => window.openTagManager());
    await page.waitForSelector('#tag-manager-dialog[open]', { timeout: 10000 }).catch(() => {});
    await otherTab.waitForTimeout(1000);
    check('a dialog opened in one tab stays in that tab', (await page.isVisible('#tag-manager-dialog')) && !(await otherTab.isVisible('#tag-manager-dialog')));
    await otherTab.close();
    await page.evaluate(() => document.getElementById('tag-manager-dialog').close());

    // Tag Manager (React): create, rename inline, search and delete.
    const serverTagNames = async () => ((await invoke(base, session, 'get-all-tags')).result || []).map((t) => t.name);
    await page.evaluate(() => window.openTagManager());
    check('Tag Manager opens', await page.isVisible('#tag-manager-dialog'));
    await page.click('#tag-manager-dialog-fullscreen-toggle');
    check('Tag Manager full screen toggle', await page.evaluate(() => document.getElementById('tag-manager-dialog').classList.contains('modal-fullscreen')));
    await page.click('#tag-manager-dialog-fullscreen-toggle');
    await page.fill('#new-tag-manager-name', 'e2e-browser-tag');
    await page.press('#new-tag-manager-name', 'Enter');
    const created = await page.waitForSelector('#tag-manager-list .tag[data-tag-name="e2e-browser-tag"]', { timeout: 10000 }).catch(() => null);
    check('Tag Manager creates a tag', !!created && (await serverTagNames()).includes('e2e-browser-tag'));
    if (created) {
      await page.click('#tag-manager-list .tag[data-tag-name="e2e-browser-tag"] .tag-text');
      await page.fill('#tag-manager-list .tag-edit-input', 'e2e-browser-renamed');
      await page.press('#tag-manager-list .tag-edit-input', 'Enter');
      const renamedChip = await page.waitForSelector('#tag-manager-list .tag[data-tag-name="e2e-browser-renamed"]', { timeout: 10000 }).catch(() => null);
      const names = await serverTagNames();
      check('Tag Manager renames a tag inline', !!renamedChip && names.includes('e2e-browser-renamed') && !names.includes('e2e-browser-tag'));
      await page.fill('#tag-manager-search', 'browser-ren');
      const visible = await page.$$eval('#tag-manager-list .tag', (chips) => chips.map((c) => c.dataset.tagName));
      check('Tag Manager search filters the list', visible.length === 1 && visible[0] === 'e2e-browser-renamed', JSON.stringify(visible));
      await page.click('#tag-manager-list .tag[data-tag-name="e2e-browser-renamed"] .tag-remove');
      await page.waitForSelector('#tag-manager-list .tag[data-tag-name="e2e-browser-renamed"]', { state: 'detached', timeout: 10000 }).catch(() => {});
      check('Tag Manager deletes an unused tag', !(await serverTagNames()).includes('e2e-browser-renamed'));
    }
    // Renaming onto an existing name asks, then merges.
    await page.fill('#tag-manager-search', '');
    for (const name of ['e2e-merge-target', 'e2e-merge-source']) {
      await page.fill('#new-tag-manager-name', name);
      await page.press('#new-tag-manager-name', 'Enter');
      await page.waitForSelector(`#tag-manager-list .tag[data-tag-name="${name}"]`, { timeout: 10000 }).catch(() => {});
    }
    await page.click('#tag-manager-list .tag[data-tag-name="e2e-merge-source"] .tag-text');
    await page.fill('#tag-manager-list .tag-edit-input', 'E2E-MERGE-TARGET');
    await page.press('#tag-manager-list .tag-edit-input', 'Enter');
    const mergeButton = await page.waitForSelector('dialog[open]:has-text("Merge Tags") button:text-is("Merge")', { timeout: 10000 }).catch(() => null);
    check('renaming onto an existing tag asks to merge', !!mergeButton);
    if (mergeButton) {
      await mergeButton.click();
      await page.waitForSelector('#tag-manager-list .tag[data-tag-name="e2e-merge-source"]', { state: 'detached', timeout: 10000 }).catch(() => {});
      const merged = (await serverTagNames()).filter((n) => /e2e-merge/i.test(n));
      check('merge leaves one tag', merged.length === 1, JSON.stringify(merged));
      // The dialog's own Undo line (the page's Undo notice is behind the dialog).
      const undoMerge = await page.waitForSelector('#tag-manager-undo', { timeout: 5000 }).catch(() => null);
      check('Tag Manager offers to undo the merge', !!undoMerge && /Merged the tag "e2e-merge-source"/.test(await page.textContent('.tag-manager-undo')));
      if (undoMerge) {
        await undoMerge.click();
        await page.waitForSelector('#tag-manager-list .tag[data-tag-name="e2e-merge-source"]', { timeout: 10000 }).catch(() => {});
        const split = (await serverTagNames()).filter((n) => /e2e-merge/i.test(n)).sort();
        check('Undo in the Tag Manager splits the merged tags', split.join() === 'e2e-merge-source,e2e-merge-target', JSON.stringify(split));
      }
    }
    await page.click('#tag-manager-dialog .dialog-buttons button');
    check('Tag Manager closes', !(await page.isVisible('#tag-manager-dialog')));

    // Tags page (React, src/web/pages/TagsPage.tsx): create, rename, merge, show models, delete.
    const tagNamesNow = async () => ((await invoke(base, session, 'get-all-tags')).result || []).map((t) => t.name);
    await page.click('.jp-sidebar .jp-nav__row:has-text("Tags")');
    await page.fill('#jp-new-tag', 'e2e-page-tag');
    await page.click('.jp-tags__create button[type=submit]');
    const pageTagRow = (name) => `.jp-tag-row[data-tag-name="${name}"]`;
    check(
      'the Tags page creates a tag',
      /#\/tags$/.test(page.url()) &&
        (await page.waitForSelector(pageTagRow('e2e-page-tag'), { timeout: 10000 }).then(
          () => true,
          () => false
        )) &&
        (await tagNamesNow()).includes('e2e-page-tag')
    );
    await page.click(`${pageTagRow('e2e-page-tag')} button[aria-label^="Rename"]`);
    await page.fill(`${pageTagRow('e2e-page-tag')} .jp-tag-row__input`, 'e2e-page-renamed');
    await page.press(`${pageTagRow('e2e-page-tag')} .jp-tag-row__input`, 'Enter');
    check(
      'renaming a tag on the page saves it',
      (await page.waitForSelector(pageTagRow('e2e-page-renamed'), { timeout: 10000 }).then(
        () => true,
        () => false
      )) && !(await tagNamesNow()).includes('e2e-page-tag')
    );
    const taggedModel = ((await invoke(base, session, 'get-all-models')).result || []).find((m) => !m.filePath.includes('::'))?.filePath;
    await invoke(base, session, 'save-tag', ['e2e-page-other']);
    await invoke(base, session, 'update-models-batch', [[{ filePath: taggedModel, tags: ['e2e-page-other'] }]]);
    // Made through the API, not this page: open the page again to read them.
    await page.click('.jp-sidebar .jp-nav__row:has-text("Library")');
    await page.click('.jp-sidebar .jp-nav__row:has-text("Tags")');
    await page.waitForSelector(`${pageTagRow('e2e-page-other')} :text("1 model")`, { timeout: 10000 }).catch(() => {});
    await page.click(`${pageTagRow('e2e-page-renamed')} button[aria-label^="Rename"]`);
    await page.fill(`${pageTagRow('e2e-page-renamed')} .jp-tag-row__input`, 'E2E-PAGE-OTHER');
    await page.press(`${pageTagRow('e2e-page-renamed')} .jp-tag-row__input`, 'Enter');
    const mergeAsk = await page
      .waitForSelector('dialog[id^="browser-message-"][open]:has-text("Merge Tags") button:text-is("Merge")', { timeout: 10000 })
      .catch(() => null);
    if (mergeAsk) await mergeAsk.click();
    check(
      'renaming onto an existing tag merges after asking',
      !!mergeAsk &&
        (await page.waitForSelector(pageTagRow('e2e-page-renamed'), { state: 'detached', timeout: 10000 }).then(
          () => true,
          () => false
        )) &&
        (await tagNamesNow()).filter((n) => n.toLowerCase() === 'e2e-page-other').length === 1
    );
    // The merged tag keeps the name as typed.
    const mergedName = (await tagNamesNow()).find((n) => n.toLowerCase() === 'e2e-page-other') || 'e2e-page-other';
    await page.click(`${pageTagRow(mergedName)} button[aria-label^="Show models"]`);
    check(
      'a tag shows its models in the library',
      (await page
        .waitForFunction((name) => JSON.stringify(window.libraryFilters.state().tags) === JSON.stringify([name]), mergedName, { timeout: 10000 })
        .then(
          () => true,
          () => false
        )) &&
        (await page
          .waitForFunction(
            (p) => [...document.querySelectorAll('.file-grid [data-filepath]')].map((el) => el.getAttribute('data-filepath')).join() === p,
            taggedModel,
            { timeout: 10000 }
          )
          .then(
            () => true,
            () => false
          ))
    );
    await page.evaluate(() => window.clearAllLibraryFilters());
    await page.click('.jp-sidebar .jp-nav__row:has-text("Tags")');
    await page.click(`${pageTagRow(mergedName)} button[aria-label^="Delete"]`);
    const deleteTagAsk = await page
      .waitForSelector('dialog[id^="browser-message-"][open]:has-text("Delete Tag") button:text-is("Yes")', { timeout: 10000 })
      .catch(() => null);
    if (deleteTagAsk) await deleteTagAsk.click();
    check(
      'deleting a used tag asks first and removes it',
      !!deleteTagAsk &&
        (await page.waitForSelector(pageTagRow(mergedName), { state: 'detached', timeout: 10000 }).then(
          () => true,
          () => false
        )) &&
        !(await tagNamesNow()).includes(mergedName)
    );
    await page.click('.jp-sidebar .jp-nav__row:has-text("Library")');

    // Parts Manager (React): add, step the quantity, edit, remove.
    const serverParts = async () => (await invoke(base, session, 'get-all-parts')).result || [];
    await page.evaluate(() => window.openPartsStock());
    check('Parts Manager opens', await page.isVisible('#parts-stock-dialog'));
    await page.click('#parts-stock-toggle-add-btn');
    await page.fill('#parts-stock-name', 'E2E M3 screw');
    await page.fill('#parts-stock-category', 'Screws');
    await page.fill('#parts-stock-quantity', '10');
    await page.fill('#parts-stock-low', '2');
    await page.click('#parts-stock-add');
    const partRow = await page.waitForSelector('#parts-stock-list .parts-stock-item:has-text("E2E M3 screw")', { timeout: 10000 }).catch(() => null);
    let part = (await serverParts()).find((p) => p.name === 'E2E M3 screw');
    check('Parts Manager adds a part', !!partRow && part && part.quantity === 10 && part.low_stock === 2 && part.category === 'Screws', JSON.stringify(part));
    if (partRow && part) {
      const row = `#parts-stock-list .parts-stock-item[data-part-id="${part.id}"]`;
      await page.click(`${row} .parts-stock-step[aria-label="Increase quantity"]`);
      await waitFor(async () => ((await serverParts()).find((p) => p.id === part.id) || {}).quantity === 11, 10000, 'quantity step').catch(() => {});
      check('Parts Manager steps the quantity', ((await serverParts()).find((p) => p.id === part.id) || {}).quantity === 11);
      await page.click(`${row} .parts-stock-edit`);
      check('Edit fills the form', (await page.inputValue('#parts-stock-name')) === 'E2E M3 screw' && (await page.textContent('#parts-stock-add')) === 'Save');
      await page.fill('#parts-stock-quantity', '1');
      await page.press('#parts-stock-quantity', 'Enter');
      await page.waitForSelector(`${row}.is-low`, { timeout: 10000 }).catch(() => {});
      part = (await serverParts()).find((p) => p.id === part.id);
      check(
        'Parts Manager saves an edit (Enter) and flags low stock',
        part && part.quantity === 1 && (await page.isVisible(`${row}.is-low`)),
        JSON.stringify(part)
      );
      await page.click(`${row} .parts-stock-remove`);
      const removeButton = await page.waitForSelector('dialog[open]:has-text("Remove Part") button:text-is("Remove")', { timeout: 10000 }).catch(() => null);
      if (removeButton) await removeButton.click();
      await page.waitForSelector(row, { state: 'detached', timeout: 10000 }).catch(() => {});
      check('Parts Manager removes a part after asking', !!removeButton && !(await serverParts()).some((p) => p.id === part.id));
    }
    await page.click('#parts-stock-close');
    check('Parts Manager closes', !(await page.isVisible('#parts-stock-dialog')));

    // Filament was removed in 7.0: no page, no sidebar entry, no dialogs.
    check('the sidebar has no Filament page', !(await page.isVisible('.jp-sidebar .jp-nav__row:has-text("Filament")')));
    await page.evaluate(() => {
      window.location.hash = '#/filament';
    });
    check(
      '#/filament opens Home',
      await page.waitForSelector('.jp-hero', { timeout: 10000 }).then(
        () => true,
        () => false
      )
    );
    check(
      'no filament dialogs or filters',
      await page.evaluate(
        () => !document.querySelector('dialog.jp-add-filament, #filament-manager-dialog, #filament-filter') && !('openFilamentManager' in window)
      )
    );
    await page.click('.jp-sidebar .jp-nav__row:has-text("Library")');

    // Printer Manager (React): add, edit, maintenance reminders and log, delete.
    const serverPrinters = async () => (await invoke(base, session, 'get-all-printers')).result || [];
    await page.evaluate(() => window.openPrinterManagement());
    check('Printer Manager opens', await page.isVisible('#printer-management-dialog'));
    await page.click('#printer-toggle-add-btn');
    await page.fill('#printer-form-nickname', 'E2E Voron');
    await page.selectOption('#printer-form-firmware', 'Marlin');
    check('choosing non-Klipper firmware unticks Klipper', !(await page.isChecked('#printer-form-klipper')));
    await page.fill('#printer-form-web-url', 'voron.local');
    await page.click('#printer-form-submit');
    const printerCard = await page.waitForSelector('#printer-cards-list .printer-card:has-text("E2E Voron")', { timeout: 10000 }).catch(() => null);
    let voron = (await serverPrinters()).find((p) => p.nickname === 'E2E Voron');
    check(
      'Printer Manager adds a printer',
      !!printerCard && voron && voron.firmware_type === 'Marlin' && voron.web_url === 'http://voron.local',
      JSON.stringify(voron)
    );
    if (voron) {
      const card = `#printer-cards-list .printer-card[data-printer-id="${voron.id}"]`;
      await page.click(`${card} .printer-action-btn:has-text("Edit")`);
      check(
        'Edit fills the printer form',
        (await page.textContent('#printer-form-title')) === 'Edit Printer: E2E Voron' && (await page.inputValue('#printer-form-nickname')) === 'E2E Voron'
      );
      await page.fill('#printer-form-model', '2.4r2');
      await page.click('#printer-form-submit');
      await page.waitForSelector(`${card}:has-text("2.4r2")`, { timeout: 10000 }).catch(() => {});
      voron = (await serverPrinters()).find((p) => p.id === voron.id);
      check('Printer Manager saves an edit', voron && voron.model === '2.4r2');
      await page.click(`${card} .printer-action-btn.maintenance`);
      check(
        'Maintenance opens for that printer',
        (await page.isVisible('#printer-view-maintenance')) && (await page.inputValue('#maintenance-printer-select')) === String(voron.id)
      );
      await page.fill('#reminder-form-title', 'E2E grease rails');
      await page.selectOption('#reminder-form-interval', '30');
      await page.click('#reminder-form button[type=submit]');
      const reminderItem = await page
        .waitForSelector('#maintenance-reminders-list .reminder-item:has-text("E2E grease rails")', { timeout: 10000 })
        .catch(() => null);
      check('a reminder is scheduled', !!reminderItem && /Repeats every 30 days/.test(await reminderItem.textContent()));
      await page.fill('#log-form-title', 'E2E swapped nozzle');
      await page.click('#log-maintenance-form button[type=submit]');
      const logItem = await page.waitForSelector('#maintenance-logs-list .log-item:has-text("E2E swapped nozzle")', { timeout: 10000 }).catch(() => null);
      check('maintenance is logged', !!logItem);
      if (reminderItem) {
        await page.click('#maintenance-reminders-list .reminder-item:has-text("E2E grease rails") .reminder-done-btn');
        const notesInput = await page.waitForSelector('dialog.browser-input-dialog[open] input', { timeout: 10000 }).catch(() => null);
        if (notesInput) {
          await notesInput.fill('E2E done notes');
          await page.click('dialog.browser-input-dialog[open] button[type=submit]');
        }
        const logs = await waitFor(
          async () => {
            const list = (await invoke(base, session, 'get-printer-maintenance-logs', [voron.id])).result || [];
            return list.length >= 2 ? list : null;
          },
          10000,
          'completed reminder log'
        ).catch(() => []);
        check('completing a reminder asks for notes and records it', !!notesInput && logs.length >= 2, JSON.stringify(logs.map((l) => l.title)));
      }
      await page.click('#printer-tab-printers');
      await page.click(`${card} .printer-action-btn.danger`);
      const confirmDelete = await page
        .waitForSelector('dialog[open]:has-text("Delete Printer") button:text-is("Delete")', { timeout: 10000 })
        .catch(() => null);
      if (confirmDelete) await confirmDelete.click();
      await page.waitForSelector(card, { state: 'detached', timeout: 10000 }).catch(() => {});
      check('Printer Manager deletes a printer after asking', !!confirmDelete && !(await serverPrinters()).some((p) => p.id === voron.id));
    }
    await page.click('#printer-management-close');
    check('Printer Manager closes', !(await page.isVisible('#printer-management-dialog')));

    // Printers page (React, src/web/pages/PrintersPage.tsx): cards, the selected printer, Edit, a reminder, Delete.
    const pagePrinter = (
      await invoke(base, session, 'save-printer', [{ nickname: 'E2E Page Printer', manufacturer: 'Prusa', model: 'MK4', webUrl: 'mk4.local' }])
    ).result;
    await invoke(base, session, 'save-printer-reminder', [
      {
        printerId: pagePrinter.id,
        title: 'E2E clean nozzle',
        maintenanceType: 'Cleaning',
        dueDate: new Date(Date.now() - 86400000).toISOString(),
        intervalDays: 0,
        notes: null
      }
    ]);
    await page.click('.jp-sidebar .jp-nav__row:has-text("Printers")');
    const pageCard = '.jp-printer-card:has-text("E2E Page Printer")';
    check(
      'the Printers page lists the printer with its maintenance due',
      /#\/printers/.test(page.url()) &&
        (await page.waitForSelector(`${pageCard} :text("Maintenance due")`, { timeout: 10000 }).then(
          () => true,
          () => false
        ))
    );
    await page.click(pageCard);
    check(
      'selecting a printer shows its details and web page',
      (await page.waitForSelector('.jp-printer-detail__name:text-is("E2E Page Printer")', { timeout: 10000 }).then(
        () => true,
        () => false
      )) &&
        (await page.getAttribute('#jp-printer-open-web', 'href')) === 'http://mk4.local' &&
        new RegExp(`#/printers/${pagePrinter.id}$`).test(page.url())
    );
    await page.click('.jp-printer-detail__actions button:has-text("Edit")');
    check(
      'Edit opens the Printer Manager form for that printer',
      await page
        .waitForFunction(() => document.getElementById('printer-form-title')?.textContent === 'Edit Printer: E2E Page Printer', null, { timeout: 10000 })
        .then(
          () => true,
          () => false
        )
    );
    await page.click('#printer-management-close');
    await page.click('.jp-printer-detail__item:has-text("E2E clean nozzle") button:has-text("Done")');
    const doneAsk = await page.waitForSelector('dialog.browser-input-dialog[open] button[type=submit]', { timeout: 10000 }).catch(() => null);
    if (doneAsk) await doneAsk.click();
    const completedLog = await waitFor(
      async () => (((await invoke(base, session, 'get-printer-maintenance-logs', [pagePrinter.id])).result || []).length ? true : null),
      10000,
      'reminder done'
    ).catch(() => false);
    check(
      'Done completes a reminder and logs it',
      !!doneAsk &&
        completedLog === true &&
        (await page.waitForSelector('.jp-printer-detail__list--log :text("E2E clean nozzle")', { timeout: 10000 }).then(
          () => true,
          () => false
        ))
    );
    await page.click('.jp-printer-detail__actions button:has-text("Delete")');
    const deleteAsk = await page
      .waitForSelector('dialog[id^="browser-message-"][open]:has-text("Delete Printer") button:text-is("Delete")', { timeout: 10000 })
      .catch(() => null);
    if (deleteAsk) await deleteAsk.click();
    check(
      'Delete removes the printer after asking',
      !!deleteAsk &&
        (await waitFor(
          async () => (!((await invoke(base, session, 'get-all-printers')).result || []).some((p) => p.id === pagePrinter.id) ? true : null),
          10000,
          'printer deleted'
        ).then(
          () => true,
          () => false
        )) &&
        (await page.waitForSelector(pageCard, { state: 'detached', timeout: 10000 }).then(
          () => true,
          () => false
        ))
    );

    // Library Stats (React): counts match get-stats, and both charts draw.
    const serverStats = (await invoke(base, session, 'get-stats')).result || {};
    // Opened from Settings in the JusttPrint 5 shell (src/web/shell/AppShell.tsx, src/web/pages/SettingsPage.tsx).
    await page.click('.jp-sidebar .jp-nav__row:has-text("Library")');
    await page.waitForSelector('.jp-page', { state: 'detached', timeout: 5000 }).catch(() => {});
    await page.click('.jp-sidebar .jp-nav__row:has-text("Settings")');
    await page.waitForSelector('.jp-page h1:text-is("Settings")', { timeout: 5000 }).catch(() => {});
    check(
      'the sidebar opens Settings and marks it as the current page',
      /#\/settings$/.test(page.url()) &&
        (await page.isVisible('.jp-page h1:text-is("Settings")')) &&
        (await page.getAttribute('.jp-sidebar .jp-nav__row:has-text("Settings")', 'aria-current')) === 'page'
    );
    // Settings forms sit on the page (src/web/settings/EmbeddedDialog.tsx): the dialogs, opened in place.
    const formOpen = (selector) =>
      page.waitForSelector(selector, { timeout: 10000 }).then(
        () => true,
        () => false
      );
    // Settings is in tabs: one group at a time; a group with several forms has tabs for them.
    const showSetting = async (id) => {
      // Like a click on a tab: no step for Back.
      await page.evaluate((section) => {
        window.location.replace(`#/settings/${section}`);
      }, id);
      await page.waitForTimeout(300);
    };
    const performanceShown = await formOpen('#setting-performance #performance-settings-dialog[open]');
    const oneGroup = (await page.locator('.jp-settings-panel').count()) === 1 && !(await page.isVisible('#setting-stl-home'));
    await showSetting('scanning');
    const stlHomeShown = await formOpen('#setting-stl-home #stl-home-dialog[open]');
    await showSetting('mcp');
    const mcpShown = await formOpen('#setting-mcp #mcp-server-settings-dialog[open]');
    const mcpTab = (await page.getAttribute('.jp-settings-subtabs [role=tab]:has-text("MCP Server")', 'aria-selected')) === 'true';
    check(
      'Settings shows one group at a time, its forms in tabs',
      performanceShown &&
        oneGroup &&
        stlHomeShown &&
        mcpShown &&
        mcpTab &&
        !(await page.isVisible('#setting-makerworld')) &&
        (await page.evaluate(() => !document.querySelector('#performance-settings-dialog:modal')))
    );
    // In the page, a form's Close and Cancel only reopened it: they are hidden (EmbeddedDialog.tsx).
    const dismissShown = await page.evaluate(() =>
      [...document.querySelectorAll('.jp-settings-embed dialog.is-embedded[open] .dialog-buttons > button')]
        .filter((button) => button.offsetParent && /^(Close|Cancel)$/.test((button.textContent || '').trim()))
        .map((button) => button.textContent.trim())
    );
    check('Settings forms in the page have no Close or Cancel', dismissShown.length === 0, JSON.stringify(dismissShown));
    await page.click('.jp-settings-subtabs [role=tab]:has-text("MakerWorld")');
    check(
      'Settings → MakerWorld shows the sign-in and the translation choice',
      (await page.waitForSelector('#setting-makerworld #makerworld-settings-dialog[open] #makerworld-account-status', { timeout: 10000 }).then(
        () => true,
        () => false
      )) &&
        /Not signed in/.test(await page.textContent('#makerworld-account-status')) &&
        (await page.isChecked('#translator-list li:first-child input')) &&
        /MyMemory/.test(await page.textContent('#translator-list li:first-child')) &&
        (await page.isDisabled('#translator-list li:has-text("Google") input')) &&
        (await page.isVisible('#google-translate-key'))
    );
    const googleStatus = (await invoke(base, session, 'google-translate-status')).result || {};
    check(
      "Google Cloud Translation's status counts this month against the free characters",
      googleStatus.hasKey === false &&
        googleStatus.free === 500000 &&
        googleStatus.used === 0 &&
        googleStatus.daysLeft >= 1 &&
        /^\d{4}-\d{2}-01$/.test(googleStatus.resetsOn),
      JSON.stringify(googleStatus)
    );
    const sizeBefore = (await invoke(base, session, 'get-setting', ['maxFileSizeMB'])).result;
    await page.click('#settings-tab-general');
    await page.waitForSelector('#setting-performance #performance-settings-dialog[open]', { timeout: 10000 }).catch(() => {});
    await page.fill('#max-file-size', '61');
    await page.click('#save-performance-settings');
    const inlineSaved = await page
      .waitForSelector('dialog[open]:has-text("Performance settings saved") button:text-is("OK")', { timeout: 10000 })
      .catch(() => null);
    if (inlineSaved) await inlineSaved.click();
    check(
      'a settings form saves on the page and stays open',
      !!inlineSaved &&
        (await invoke(base, session, 'get-setting', ['maxFileSizeMB'])).result === '61' &&
        (await page.waitForSelector('#setting-performance #performance-settings-dialog[open]', { timeout: 5000 }).then(
          () => true,
          () => false
        ))
    );
    await invoke(base, session, 'save-setting', ['maxFileSizeMB', sizeBefore == null ? '50' : sizeBefore]);
    await page.click('#settings-tab-backup');
    check(
      'a tab shows its group',
      (await page.waitForSelector('#settings-backup', { timeout: 5000 }).then(
        () => true,
        () => false
      )) &&
        /#\/settings\/backup$/.test(page.url()) &&
        !(await page.isVisible('#setting-performance'))
    );
    await showSetting('stats');
    await page.click('.jp-settings-row:has-text("Library Stats")');
    check('Library Stats opens from Settings', await page.isVisible('#stats-dialog'));
    const shownTotal = await page
      .waitForFunction(
        (total) => {
          const text = document.getElementById('stats-total-models')?.textContent;
          return text === total ? text : null;
        },
        String(serverStats.totalModels || 0),
        { timeout: 10000 }
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    check('Library Stats shows the model count', shownTotal !== null, `${shownTotal} vs ${serverStats.totalModels}`);
    check(
      'Library Stats draws its charts',
      (await page.isVisible('#stats-dialog .stats-pie svg')) && (await page.locator('#stats-dialog .stats-bar-row').count()) === 4
    );
    await page.click('#stats-dialog .dialog-buttons button');
    check('Library Stats closes', !(await page.isVisible('#stats-dialog')));
    await page.goBack();
    check('Back returns to the library', !(await page.isVisible('.jp-page')) && !/#\/settings/.test(page.url()));
    check(
      'leaving Settings returns its forms to dialogs',
      await page.evaluate(() => {
        const dialog = document.getElementById('performance-settings-dialog');
        return !!dialog && !dialog.open && !dialog.closest('.jp-settings-embed') && !dialog.classList.contains('is-embedded');
      })
    );

    // The rest of the shell: the old menu bar is gone, the account menu, search and the queue link.
    check(
      'the shell replaces the old menu bar, logo and phone layout',
      (await page.evaluate(() => !document.querySelector('#server-menu-bar, #logo, #mobile-app-bar, .sidebar-chrome'))) &&
        (await page.isVisible('.jp-sidebar .jp-brand'))
    );
    await page.click('.jp-account');
    check(
      'the account menu offers JusttPrint Backend Access and Log Out',
      (await page.isVisible('.jp-menu [role="menuitem"]:has-text("JusttPrint Backend Access")')) &&
        (await page.isVisible('.jp-menu [role="menuitem"]:has-text("Log Out")'))
    );
    await page.keyboard.press('Escape');
    check('Escape closes the account menu', !(await page.isVisible('.jp-menu')));
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    check('Ctrl/Cmd+K focuses the search', (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Search the library');
    await page.keyboard.type('cube');
    await page.keyboard.press('Enter');
    const searched = await page
      .waitForFunction(
        () => {
          const tokens = window.libraryFilters.state().tokens || [];
          return tokens.some((t) => JSON.stringify(t).includes('cube')) ? true : null;
        },
        null,
        { timeout: 5000 }
      )
      .then(
        () => true,
        () => false
      );
    check('the top bar search filters the library', searched && (await page.inputValue('.jp-topbar input')) === '');
    await page.evaluate(() => window.clearAllLibraryFilters());
    // Print Queue (React, src/web/pages/QueuePage.tsx): a queued model moves through the page with its status.
    const queuedModel = ((await invoke(base, session, 'get-all-models')).result || []).find((m) => !m.filePath.includes('::'))?.filePath;
    await invoke(base, session, 'set-print-status', [{ filePath: queuedModel, printStatus: 'queued' }]);
    await page.click('.jp-sidebar .jp-nav__row:has-text("Queue")');
    const queuedRow = `ol[aria-label="Up next"] .jp-queue__row:has(.jp-queue__title:text-is("${path.basename(queuedModel).replace(/\.[^.]+$/, '')}"))`;
    check(
      'Queue opens the Print Queue with the queued model up next',
      /#\/queue$/.test(page.url()) &&
        (await page.waitForSelector(queuedRow, { timeout: 10000 }).then(
          () => true,
          () => false
        ))
    );
    await page.click(`${queuedRow} button:has-text("Start")`);
    const startedRow = 'ul[aria-label="Printing now"] .jp-queue__row';
    const started = await page.waitForSelector(startedRow, { timeout: 10000 }).then(
      () => true,
      () => false
    );
    check('Start moves it to Printing now', started && (await invoke(base, session, 'get-model', [queuedModel])).result?.print_status === 'printing');
    await page.click(`${startedRow} button[aria-label="Back to the queue"]`);
    await page.waitForSelector(queuedRow, { timeout: 10000 }).catch(() => {});
    await page.click(`${queuedRow} button[aria-label="Remove from the queue"]`);
    check(
      'Remove takes it off the queue',
      (await page
        .waitForSelector('#jp-queue-next ~ * :text("The queue is empty"), .jp-queue__section:has(#jp-queue-next) :text("The queue is empty")', {
          timeout: 10000
        })
        .then(
          () => true,
          () => false
        )) && (await invoke(base, session, 'get-model', [queuedModel])).result?.print_status === 'unprinted'
    );
    await page.click('.jp-queue__header button:has-text("Show in Library")');
    check(
      "Show in Library opens the library's Queue tab",
      (await page
        .waitForFunction(() => window.libraryFilters.state().printed === 'in-queue', null, { timeout: 5000 })
        .then(
          () => true,
          () => false
        )) && (await page.isVisible('.jp-library-header .jp-tab[aria-selected="true"]:has-text("Queue")'))
    );
    await page.evaluate(() => window.clearAllLibraryFilters());
    const storageText = await page.textContent('.jp-storage').catch(() => '');
    check('the sidebar shows Library Storage', /Library Storage/.test(storageText) && /( of |in \d+ models)/.test(storageText), storageText);

    // Keyboard (spec §37): the skip link, a card as one Tab stop, Enter selects, focus follows the arrows.
    await page.evaluate(() => {
      window.location.hash = '#/library';
    });
    await page.click('.view-button[data-view="detailed"]');
    await page.waitForSelector('.file-grid .jp-model-card', { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => {
      window.selection.clear();
      document.activeElement?.blur();
    });
    // The first element in Tab order (DOM order, tabbable, not inert or hidden).
    const firstStop = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')];
      const tabbable = candidates.find(
        (el) =>
          el.tabIndex >= 0 &&
          !el.disabled &&
          !el.closest('[inert], [hidden], dialog:not([open])') &&
          getComputedStyle(el).visibility !== 'hidden' &&
          getComputedStyle(el).display !== 'none'
      );
      return tabbable?.textContent?.trim() || tabbable?.outerHTML.slice(0, 80);
    });
    await page.focus('.jp-skip');
    await page.keyboard.press('Enter');
    const skipped = await page.evaluate(() => !!document.activeElement?.matches('.file-grid .jp-model-card'));
    check('the first Tab stop is Skip to content, and it jumps to the first model', firstStop === 'Skip to content' && skipped, String(firstStop));
    await page.keyboard.press('Enter');
    const keyboardSelected = await page
      .waitForFunction(
        () => document.activeElement?.matches('.jp-model-card.selected') && document.activeElement.getAttribute('aria-label')?.endsWith('selected'),
        null,
        { timeout: 10000 }
      )
      .then(
        () => true,
        () => false
      );
    check(
      'Enter on a focused card selects it and opens its details',
      keyboardSelected &&
        (await page
          .waitForFunction(() => !!document.querySelector('#model-details .jp-details__title')?.textContent?.trim(), null, { timeout: 10000 })
          .then(
            () => true,
            () => false
          )),
      JSON.stringify(
        await page.evaluate(() => ({
          active: document.activeElement?.className,
          label: document.activeElement?.getAttribute('aria-label'),
          selected: document.querySelectorAll('.file-item.selected').length,
          panels: ['model-details', 'multi-edit-panel', 'bundle-details'].filter((id) => !document.getElementById(id)?.classList.contains('hidden'))
        }))
      )
    );
    const focusedBefore = await page.evaluate(() => document.activeElement?.getAttribute('data-filepath'));
    await page.keyboard.press('ArrowDown');
    check(
      'the arrow keys move the selection and the focus with it',
      await page
        .waitForFunction(
          (before) => {
            const el = document.activeElement;
            return !!el && el.matches('.jp-model-card.selected') && el.getAttribute('data-filepath') !== before;
          },
          focusedBefore,
          { timeout: 10000 }
        )
        .then(
          () => true,
          () => false
        )
    );
    await page.keyboard.press('Escape');
    await page.click('.jp-sidebar .jp-nav__row:has-text("Tags")');
    await page.waitForSelector('.jp-page h1:text-is("Tags")', { timeout: 10000 }).catch(() => {});
    const inertState = await page.evaluate(() => {
      const card = document.querySelector('.file-grid .file-item');
      card?.focus();
      return {
        card: !!card,
        focusedCard: document.activeElement === card,
        inert: !!document.querySelector('.file-grid')?.closest('[inert]'),
        hash: location.hash,
        dialogs: [...document.querySelectorAll('dialog[open]')].map((d) => d.id)
      };
    });
    check('a page covers the grid for the keyboard too (inert)', inertState.card && !inertState.focusedCard && inertState.inert, JSON.stringify(inertState));

    // Accessibility audit (axe-core): no serious or critical problems on the JusttPrint 5 pages.
    const auditContext = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      bypassCSP: true,
      storageState: await page.context().storageState()
    });
    const audit = await auditContext.newPage();
    const axeProblems = [];
    for (const hash of ['#/home', '#/library', '#/queue', '#/printers', '#/stats', '#/tags', '#/settings', '#/help']) {
      await audit.goto(`${base}/${hash}`);
      await audit.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 }).catch(() => {});
      await audit.waitForSelector(hash === '#/library' ? '.file-grid .file-item' : '.jp-page h1, .jp-hero__title', { timeout: 20000 }).catch(() => {});
      if (hash === '#/library') {
        await audit.click('.file-grid .file-item .file-name').catch(() => {});
        await audit.waitForSelector('#model-details .jp-details__title', { timeout: 10000 }).catch(() => {});
      }
      await audit.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
      const found = await audit.evaluate(async () => {
        const result = await window.axe.run(
          { include: [['.jp-shell'], ['.grid-view-selector'], ['.file-grid'], ['#model-details']] },
          { resultTypes: ['violations'] }
        );
        return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`);
      });
      axeProblems.push(...found.map((problem) => `${hash} ${problem}`));
    }
    check('no serious or critical accessibility problems (axe) on the main pages', axeProblems.length === 0, axeProblems.slice(0, 6).join(' | '));
    // The older dialogs, drawn with the tokens since Phase 14, and the message box.
    const dialogProblems = [];
    const DIALOG_OPENERS = [
      'openAbout',
      'openAiConfig',
      'openBackupRestore',
      'openFileTypeSettings',
      'openHttpsSettings',
      'openKeyboardShortcuts',
      'openMcpServerSettings',
      'openMetadataEditor',
      'openPartsStock',
      'openPerformanceSettings',
      'openPrinterManagement',
      'openPurgeModels',
      'openServerAccess',
      'openSlicerSettings',
      'openStats',
      'openStlHome',
      'openSystemReport',
      'openTagManager',
      'openThemeSettings',
      'showMessage'
    ];
    for (const opener of DIALOG_OPENERS) {
      await audit.evaluate((name) => {
        if (name === 'showMessage') window.electron.showMessage('Check', 'A message.', ['OK', 'Cancel']);
        else window[name]?.();
      }, opener);
      const id = await audit
        .waitForFunction(
          () => [...document.querySelectorAll('dialog[open]')].pop()?.id || (document.querySelector('dialog.jp-message-dialog[open]') ? 'message' : null),
          null,
          { timeout: 10000 }
        )
        .then(
          (h) => h.jsonValue(),
          () => ''
        );
      if (!id) {
        dialogProblems.push(`${opener}: did not open`);
        continue;
      }
      await audit.waitForTimeout(400);
      const found = await audit.evaluate(async () => {
        const dialog = [...document.querySelectorAll('dialog[open]')].pop();
        const result = await window.axe.run(dialog, { resultTypes: ['violations'] });
        return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`);
      });
      dialogProblems.push(...found.map((problem) => `${opener} ${problem}`));
      await audit.evaluate(() =>
        document.querySelectorAll('dialog[open]').forEach((d) => (d.classList.contains('jp-message-dialog') ? d.querySelector('button')?.click() : d.close()))
      );
    }
    check('no serious or critical accessibility problems (axe) in the dialogs', dialogProblems.length === 0, dialogProblems.slice(0, 6).join(' | '));
    await auditContext.close();

    // Phone layout (spec §36; src/web/shell/AppShell.tsx, styles/responsive.css), same session at phone size.
    const phone = await (
      await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await page.context().storageState() })
    ).newPage();
    phone.on('pageerror', (error) => errors.push(`phone: ${error.message}`));
    await phone.goto(base + '/');
    await phone.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    // The long search text showed as "Search moc" on a phone.
    check('the phone search box says Search…', (await phone.getAttribute('.jp-topbar input', 'placeholder')) === 'Search…');
    const phoneHome = {
      nav: await phone.waitForSelector('#jp-bottom-nav', { timeout: 10000 }).then(
        () => true,
        () => false
      ),
      hero: await phone.waitForSelector('.jp-hero__title', { timeout: 10000 }).then(
        () => true,
        () => false
      ),
      sidebarHidden: await phone.waitForSelector('#jp-sidebar', { state: 'hidden', timeout: 5000 }).then(
        () => true,
        () => false
      ),
      noOldBar: !(await phone.isVisible('#mobile-app-bar'))
    };
    check('the phone opens Home with the bottom bar instead of the sidebar', Object.values(phoneHome).every(Boolean), JSON.stringify(phoneHome));
    await phone.tap('#jp-bottom-nav .jp-bottom-nav__item:has-text("Library")');
    // Earlier checks leave the wall or the list as the saved view.
    await phone.tap('.view-button[data-view="detailed"]');
    const phoneTile = await phone.waitForSelector('.file-grid .jp-model-card[data-filepath]', { timeout: 30000 }).catch(() => null);
    // Cards are redrawn while the library loads: wait for two side by side.
    const phoneColumns = await phone
      .waitForFunction(
        () => {
          const lefts = new Set(
            [...document.querySelectorAll('.file-grid .jp-model-card[data-filepath]')].map((el) => Math.round(el.getBoundingClientRect().left))
          );
          return lefts.size >= 2 ? lefts.size : null;
        },
        null,
        { timeout: 15000 }
      )
      .then(
        (h) => h.jsonValue(),
        () => 0
      );
    check('the phone library shows two columns of cards', !!phoneTile && phoneColumns === 2, String(phoneColumns));
    await phone.tap('.jp-topbar__menu');
    check(
      'Menu opens the sidebar as a drawer',
      (await phone
        .waitForFunction(() => document.body.classList.contains('jp-nav-open'), null, { timeout: 10000 })
        .then(
          () => true,
          () => false
        )) &&
        (await phone.waitForSelector('#jp-sidebar .jp-nav__row:has-text("Duplicates")', { timeout: 5000 }).then(
          () => true,
          () => false
        )),
      JSON.stringify(await phone.evaluate(() => ({ body: document.body.className, dialogs: [...document.querySelectorAll('dialog[open]')].map((d) => d.id) })))
    );
    await phone.tap('#jp-sidebar .jp-nav__row:has-text("Tags")');
    check(
      'a page from the drawer opens and closes the drawer',
      (await phone.waitForSelector('.jp-page h1:text-is("Tags")', { timeout: 10000 }).then(
        () => true,
        () => false
      )) && !(await phone.evaluate(() => document.body.classList.contains('jp-nav-open')))
    );
    await phone.tap('#jp-bottom-nav .jp-bottom-nav__item:has-text("Library")');
    await phone.tap('#jp-filter-button');
    const sheet = await phone.locator('#jp-filter-popover').boundingBox();
    check(
      'Filter opens the filters as a full-width sheet',
      !!sheet && Math.round(sheet.width) === 390 && (await phone.isVisible('#jp-filter-popover #sort-select'))
    );
    await phone.tap('#jp-filter-popover button[aria-label="Close filters"]');
    if (phoneTile) {
      // Touch screens (responsive.css): hover-only buttons show, and small controls are finger-sized.
      const cardAction = await phone.$eval('.file-grid .jp-model-card[data-filepath] .jp-model-card__action', (el) => ({
        opacity: getComputedStyle(el).opacity,
        size: el.getBoundingClientRect().width
      }));
      check('on a touch screen card buttons show without hover, finger-sized', cardAction.opacity === '1' && cardAction.size >= 36, JSON.stringify(cardAction));
      await phone.tap('.file-grid .jp-model-card[data-filepath]:not([data-filepath$=".zip"]) .file-name');
      const phoneDetails = await phone
        .waitForFunction(() => document.body.classList.contains('jp-details-open'), null, { timeout: 10000 })
        .then(
          () => true,
          () => false
        );
      const drawer = await phone.locator('.sidebar').boundingBox();
      check(
        'tapping a model opens its details full screen with its name',
        phoneDetails && !!drawer && Math.round(drawer.width) === 390 && (await phone.textContent('#model-details .jp-details__title')).trim().length > 0
      );
      const sizes = await phone.evaluate(() =>
        Object.fromEntries(
          [
            ['edit', '#model-details #jp-details-edit'],
            ['slicer', '#model-details .jp-split__more'],
            ['status', '#model-details #model-print-status']
          ].map(([k, s]) => {
            const r = document.querySelector(s)?.getBoundingClientRect();
            return [k, r ? [Math.round(r.width), Math.round(r.height)] : null];
          })
        )
      );
      check(
        'the details buttons and fields are finger-sized',
        sizes.edit?.[1] >= 40 && sizes.slicer?.[0] >= 40 && sizes.slicer?.[1] >= 40 && sizes.status?.[1] >= 40,
        JSON.stringify(sizes)
      );
      await phone.tap('#jp-details-close');
      check(
        '× closes the details',
        await phone
          .waitForFunction(() => !document.body.classList.contains('jp-details-open'), null, { timeout: 5000 })
          .then(
            () => true,
            () => false
          )
      );
    }
    await phone.close();

    // Tablet: the sidebar is an icon rail; laptop: the details are a drawer.
    const tablet = await (await browser.newContext({ viewport: { width: 900, height: 1000 }, storageState: await page.context().storageState() })).newPage();
    tablet.on('pageerror', (error) => errors.push(`tablet: ${error.message}`));
    await tablet.goto(base + '/#/library');
    await tablet.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    const rail = await tablet.waitForSelector('#jp-sidebar', { timeout: 10000 }).then(
      () => tablet.locator('#jp-sidebar').boundingBox(),
      () => null
    );
    check('a tablet shows the sidebar as an icon rail', !!rail && Math.round(rail.width) === 72 && !(await tablet.isVisible('#jp-sidebar .jp-storage')));
    const tabletCard = await tablet.waitForSelector('.file-grid .jp-model-card[data-filepath] .file-name', { timeout: 30000 }).catch(() => null);
    if (tabletCard) {
      // By locator: the grid may draw the card again before the click (slower machines).
      await tablet.locator('.file-grid .jp-model-card[data-filepath] .file-name').first().click();
      // Waits for the close button and backdrop too: they render after the drawer class is set.
      const drawerState = await tablet
        .waitForFunction(
          () => {
            const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
            return (
              document.body.classList.contains('jp-details-open') &&
              visible(document.getElementById('jp-details-close')) &&
              visible(document.querySelector('.jp-details-backdrop'))
            );
          },
          null,
          { timeout: 10000 }
        )
        .then(
          () => true,
          () => false
        );
      check(
        'below 1200 px the details open as a drawer over the grid',
        drawerState,
        JSON.stringify(
          await tablet.evaluate(() => ({
            open: document.body.classList.contains('jp-details-open'),
            close: !!document.getElementById('jp-details-close')?.getClientRects().length,
            backdrop: !!document.querySelector('.jp-details-backdrop')?.getClientRects().length
          }))
        )
      );
      await tablet.click('.jp-details-backdrop', { position: { x: 300, y: 300 } });
      check(
        'a click beside the drawer closes it',
        await tablet
          .waitForFunction(() => !document.body.classList.contains('jp-details-open'), null, { timeout: 5000 })
          .then(
            () => true,
            () => false
          )
      );
    }
    await tablet.close();

    // First run (React, src/web/startup/FirstRun.tsx): the welcome, then the guide. No terms to accept.
    await invoke(base, session, 'save-setting', ['hasRunBefore', '']);
    const fresh = await page.context().newPage();
    fresh.on('pageerror', (error) => errors.push(`first run: ${error.message}`));
    await fresh.goto(base + '/');
    check(
      'a first visit shows the welcome, with no terms to accept',
      (await fresh.waitForSelector('#welcome-message[open]', { timeout: 30000 }).then(
        () => true,
        () => false
      )) && !(await fresh.$('#terms-of-service-dialog'))
    );
    await fresh.click('#dismiss-welcome');
    check(
      'Get Started opens the Quick Start Guide',
      (await fresh.waitForSelector('#quickstart-guide[open]', { timeout: 10000 }).then(
        () => true,
        () => false
      )) && (await invoke(base, session, 'get-setting', ['hasRunBefore'])).result === 'true'
    );
    // The guide (src/web/QuickStartGuide.tsx): Next, the arrow keys, Back, and Finish on the last page.
    const guidePage = () => fresh.textContent('#guide-progress-text').catch(() => '');
    await fresh.click('#guide-next-button');
    const onSecond = await fresh
      .waitForFunction(() => /Page 2 of 5/.test(document.getElementById('guide-progress-text')?.textContent || ''), null, { timeout: 5000 })
      .then(
        () => true,
        () => false
      );
    await fresh.waitForTimeout(500);
    await fresh.keyboard.press('ArrowRight');
    await fresh.waitForTimeout(600);
    const third = await guidePage();
    await fresh.click('#guide-back-button');
    await fresh.waitForTimeout(600);
    check(
      'the guide pages forward and back (buttons and arrow keys)',
      onSecond && /Page 3 of 5/.test(third) && /Page 2 of 5/.test(await guidePage()) && /Model Details/.test(await fresh.textContent('#guide-text')),
      `${third} / ${await guidePage()}`
    );
    for (let k = 0; k < 3; k++) {
      await fresh.click('#guide-next-button');
      await fresh.waitForTimeout(600);
    }
    check('the last page says Finish', (await fresh.textContent('#guide-next-button')).trim() === 'Finish');
    await fresh.click('#guide-next-button');
    check('Finish closes the guide', !(await fresh.isVisible('#quickstart-guide')));
    await fresh.close();

    // Review Generated Tags (React, src/web/tags/TagPreviewDialog.tsx), driven by the events an AI run sends.
    const reviewPaths = (await page.$$eval('.file-grid [data-filepath]', (els) => els.map((el) => el.getAttribute('data-filepath'))))
      .filter((p) => !p.includes('::'))
      .slice(0, 2);
    if (reviewPaths.length === 2) {
      const [ra, rb] = reviewPaths;
      const tagNames = async (filePath) =>
        (((await invoke(base, session, 'get-model', [filePath])).result || {}).tags || []).map((t) => (typeof t === 'string' ? t : t.name));
      const tagsBefore = await tagNames(ra);
      const emit = (...args) => page.evaluate((a) => window.electron.send(...a), args);
      await emit('start-batch-tag-generation', 2, [ra, rb, ra]);
      await page
        .waitForFunction(() => document.querySelectorAll('#tag-preview-container .tag-review-model').length === 2, null, { timeout: 10000 })
        .catch(() => {});
      check(
        'a batch run lists each model once while it waits, with Apply off',
        (await page.isVisible('#tag-preview-dialog')) &&
          (await page.locator('#tag-preview-container .tag-review-model').count()) === 2 &&
          (await page.isDisabled('#tag-preview-apply')) &&
          /\(0\/2 processed/.test(await page.textContent('#tag-preview-dialog h3'))
      );
      await emit('tags-generated', ra, ['e2e-ai-a', 'e2e-ai-b'], null);
      await emit('tags-generated', rb, [], 'Rate limit exceeded: wait a minute');
      const limitNotice = await page
        .waitForSelector('dialog[id^="browser-message-"][open]:has-text("Rate Limit Exceeded") button', { timeout: 10000 })
        .catch(() => null);
      if (limitNotice) await limitNotice.click();
      check(
        'suggestions show as ticked boxes, and a rate limit is reported once',
        !!limitNotice &&
          (await page.locator('#tag-preview-container input[type=checkbox]:checked').count()) === 2 &&
          /wait a minute/.test(await page.textContent('#tag-preview-container'))
      );
      await emit('batch-tag-generation-complete');
      check(
        'Apply turns on when the batch ends',
        await page.waitForSelector('#tag-preview-apply:not([disabled])', { timeout: 5000 }).then(
          () => true,
          () => false
        )
      );
      await page.uncheck('#tag-preview-container input[value="e2e-ai-b"]');
      await page.click('#tag-preview-apply');
      const applied = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("Tags applied") button', { timeout: 15000 }).catch(() => null);
      if (applied) await applied.click();
      const tagsAfter = await tagNames(ra);
      check(
        'Apply saves only the ticked tags, plus "AI Tagged"',
        !!applied &&
          tagsAfter.includes('e2e-ai-a') &&
          tagsAfter.includes('AI Tagged') &&
          !tagsAfter.includes('e2e-ai-b') &&
          !(await page.isVisible('#tag-preview-dialog')),
        JSON.stringify(tagsAfter)
      );
      await emit('tags-generated', ra, ['late'], null);
      await page.waitForTimeout(500);
      check('a late result does not reopen a closed review', !(await page.isVisible('#tag-preview-dialog')));
      await invoke(base, session, 'update-models-batch', [[{ filePath: ra, tags: tagsBefore }]]);

      // A real run (src/server/ai-tag-job.js) against a stand-in AI service whose answers the test releases one by one.
      const held = [];
      const fakeAi = require('http').createServer((req, res) => {
        req.resume();
        held.push(() => {
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              id: 'e2e',
              object: 'chat.completion',
              created: 0,
              model: 'e2e',
              choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"tags":["e2e-real-a","e2e-real-b"]}' } }]
            })
          );
        });
      });
      await new Promise((resolve) => fakeAi.listen(0, DOCKER_IMAGE ? '0.0.0.0' : '127.0.0.1', resolve));
      const release = async () => {
        await waitFor(async () => held.length > 0, 15000 * SLOW, 'an AI request').catch(() => {});
        held.shift()?.();
      };
      const runKeys = ['aiService', 'apiEndpoint', 'aiModel', 'aiTagConcurrency', 'aiTagAllowRetagging'];
      const runSaved = {};
      for (const key of runKeys) runSaved[key] = (await invoke(base, session, 'get-setting', [key])).result;
      for (const [key, value] of [
        ['aiService', 'custom'],
        ['apiEndpoint', `http://${HOST_FOR_SERVER}:${fakeAi.address().port}/v1`],
        ['aiModel', 'e2e'],
        ['aiTagConcurrency', '1'],
        ['aiTagAllowRetagging', '1']
      ]) {
        await invoke(base, session, 'save-setting', [key, value]);
      }
      const runTags = async () => {
        const menu = (await invoke(base, session, 'show-context-menu', [[ra, rb]])).result || {};
        const item = (menu.items || []).find((i) => i.label === 'Generate Tags');
        return item ? invoke(base, session, 'execute-context-menu-action', [menu.requestId, item.index]) : null;
      };
      const job = async () => (await invoke(base, session, 'get-ai-tag-job')).result;
      check(
        'Generate Tags starts a run the JusttPrint backend keeps',
        !!(await runTags()) && (await waitFor(async () => (await job())?.running, 10000, 'run').catch(() => false))
      );
      await page.waitForSelector('#tag-preview-dialog[open]', { timeout: 10000 }).catch(() => {});
      check('a second run waits for the first', ((await job()) || {}).total === 2 && !!(await runTags()) && ((await job()) || {}).total === 2);
      for (const dialog of await page.$$('dialog[id^="browser-message-"][open]:has-text("already running") button')) await dialog.click();
      check(
        'the review offers Stop and Run in Background while the run goes on',
        (await page.isVisible('#tag-preview-stop')) && /Run in Background/.test(await page.textContent('#tag-preview-cancel'))
      );
      await release();
      await waitFor(async () => ((await job()) || {}).processed === 1, 15000, 'first result').catch(() => {});
      await page.reload();
      await page.waitForSelector('.file-grid [data-filepath]', { timeout: 30000 }).catch(() => {});
      check(
        'after a reload the sidebar still shows the run',
        await page
          .waitForFunction(() => /AI tagging: 1\/2/.test(document.getElementById('ai-tag-progress-text')?.textContent || ''), null, { timeout: 15000 })
          .then(
            () => true,
            () => false
          )
      );
      await page.click('#ai-tag-review').catch(() => {});
      check(
        'Review reopens it with the tags that came in',
        (await page.waitForSelector(`#tag-preview-dialog[open] input[value="e2e-real-a"]`, { timeout: 10000 }).then(
          () => true,
          () => false
        )) && /\(1\/2 processed/.test(await page.textContent('#tag-preview-dialog h3'))
      );
      await release();
      const applyReady = await page.waitForSelector('#tag-preview-apply:not([disabled])', { timeout: 15000 * SLOW }).then(
        () => true,
        () => false
      );
      const tagInputs = await page.locator('#tag-preview-container input[value="e2e-real-a"]').count();
      check(
        'the rest arrives in the reopened review',
        applyReady && tagInputs === 2,
        JSON.stringify({
          applyReady,
          tagInputs,
          title: await page.textContent('#tag-preview-dialog h3').catch(() => null),
          job: await job()
        })
      );
      await page.click('#tag-preview-cancel');
      check(
        'closing a finished review forgets the run',
        (await waitFor(async () => (await job()) === null, 10000, 'dismissed').catch(() => false)) &&
          (await page.waitForSelector('#ai-tag-progress-container', { state: 'detached', timeout: 5000 }).then(
            () => true,
            () => false
          ))
      );
      // Stop: the model not started yet is skipped.
      await runTags();
      await page.waitForSelector('#tag-preview-stop', { timeout: 10000 }).catch(() => {});
      await page.click('#tag-preview-stop').catch(() => {});
      await waitFor(async () => (await job())?.stopping, 10000, 'stopping').catch(() => {});
      await release();
      const stopped = await waitFor(
        async () => {
          const j = await job();
          return j && !j.running ? j : null;
        },
        15000,
        'stopped'
      ).catch(() => null);
      check(
        'Stop skips the models not started yet',
        !!stopped && stopped.processed === 2 && stopped.results.some((r) => /Stopped before this model/.test(r.error || '')),
        JSON.stringify(stopped)
      );
      await page.click('#tag-preview-cancel').catch(() => {});
      await waitFor(async () => (await job()) === null, 10000, 'dismissed').catch(() => {});
      for (const key of runKeys) await invoke(base, session, 'save-setting', [key, runSaved[key] ?? null]);
      held.splice(0).forEach((answer) => answer());
      fakeAi.close();
    }

    // System Report (React): every section finishes, and both benchmarks complete.
    await page.evaluate(() => window.openSystemReport());
    check('System Report opens', await page.isVisible('#system-report-dialog'));
    const reportDone = await page
      .waitForFunction(
        () => {
          const statuses = [...document.querySelectorAll('#system-report-dialog .system-report-section')].map(
            (section) => section.querySelector('[class^="system-report-status-"]')?.textContent || ''
          );
          return statuses.length === 4 && statuses.every(Boolean) ? statuses : null;
        },
        null,
        { timeout: 30000 }
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    check('System Report fills every section', !!reportDone, JSON.stringify(reportDone));
    check('System Report benchmarks complete', !!reportDone && reportDone[2] === '✓ Completed' && reportDone[3] === '✓ Completed', JSON.stringify(reportDone));
    await page.click('#system-report-dialog .dialog-buttons button');
    check('System Report closes', !(await page.isVisible('#system-report-dialog')));

    // Backup/Restore (React): backup and export download, the export imports back, a bad backup is refused.
    // Backups left in the data folder by older versions: a notice with Delete Them.
    const uiLeftover = path.join(DATA, 'data', 'justtprint-library-2026-02-02T00-00-00-000Z.json');
    fs.writeFileSync(uiLeftover, '{}');
    await page.evaluate(() => window.openBackupRestore());
    check('Backup/Restore opens', await page.isVisible('#backup-restore-dialog'));
    const leftoverNotice = await page.waitForSelector('#leftover-downloads:has-text("1 backup and export file")', { timeout: 10000 }).catch(() => null);
    if (leftoverNotice) await page.click('#delete-leftover-downloads');
    const confirmLeftovers = await page
      .waitForSelector('dialog[open]:has-text("Delete Old Backup Files") button:text-is("Delete")', { timeout: 10000 })
      .catch(() => null);
    if (confirmLeftovers) await confirmLeftovers.click();
    const noticeGone = await page.waitForSelector('#leftover-downloads', { state: 'detached', timeout: 10000 }).then(
      () => true,
      () => false
    );
    check(
      'the Backup page offers to delete old backup files, asks, and deletes them',
      !!leftoverNotice && !!confirmLeftovers && noticeGone && !fs.existsSync(uiLeftover)
    );
    const backupDownload = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#backup-button')])
      .then(([download]) => download)
      .catch(() => null);
    check(
      'Create Backup downloads a .db file',
      !!backupDownload && /^justtprint-backup-.*\.db$/.test(backupDownload.suggestedFilename()),
      backupDownload && backupDownload.suggestedFilename()
    );
    const exportDownload = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#export-library-button')])
      .then(([download]) => download)
      .catch(() => null);
    const exportPath = exportDownload && (await exportDownload.path().catch(() => null));
    const exported = exportPath ? JSON.parse(fs.readFileSync(exportPath, 'utf8')) : null;
    check(
      'Export Library downloads the library',
      !!exported && Array.isArray(exported.models) && exported.models.length === 3,
      exported ? `${exported.models.length} models` : 'no file'
    );
    if (exportPath) {
      await page.click('#import-library-button');
      const confirmImport = await page.waitForSelector('dialog[open]:has-text("Confirm Import") button:text-is("Yes")', { timeout: 10000 }).catch(() => null);
      check('Import Library asks first', !!confirmImport);
      if (confirmImport) {
        const chooser = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
        await confirmImport.click();
        const fileChooser = await chooser;
        check('Import Library opens a file picker', !!fileChooser);
        if (fileChooser) await fileChooser.setFiles(exportPath);
        const imported = await page.waitForSelector('dialog[open]:has-text("Library imported successfully")', { timeout: 30000 }).catch(() => null);
        check(
          'Import Library merges the export',
          !!imported && /0 new models added, 3 models updated/.test(await imported.textContent()),
          imported && (await imported.textContent())
        );
        if (imported) await page.click('dialog[open]:has-text("Library imported successfully") button:text-is("OK")');
      }
    }
    await page.setInputFiles('#restore-file-input', { name: 'junk.db', mimeType: 'application/octet-stream', buffer: Buffer.from('not a database') });
    const refused = await page.waitForSelector('dialog[open]:has-text("Not a JusttPrint backup")', { timeout: 30000 }).catch(() => null);
    check('Restore refuses a file that is not a backup', !!refused);
    if (refused) await page.click('dialog[open]:has-text("Not a JusttPrint backup") button:text-is("OK")');
    // Automatic Backups: switching them on writes the first backup; it lists and downloads.
    await page.check('#auto-backup-enabled');
    const firstAuto = await page.waitForSelector('#auto-backup-list .auto-backup-item', { timeout: 60000 }).catch(() => null);
    const autoStatus = firstAuto ? await page.textContent('#auto-backup-status') : '';
    const autoDownload = firstAuto
      ? await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#auto-backup-list .auto-backup-download')])
          .then(([download]) => download)
          .catch(() => null)
      : null;
    check(
      'switching on Automatic Backups writes the first backup, shows when, and downloads it',
      !!firstAuto && /Last backup: .*Next: /.test(autoStatus) && /^justtprint-auto-\d{8}-\d{6}\.db$/.test(autoDownload?.suggestedFilename() || ''),
      `${autoStatus} / ${autoDownload?.suggestedFilename()}`
    );
    await page.uncheck('#auto-backup-enabled');
    await page.waitForFunction(() => !/Next:/.test(document.getElementById('auto-backup-status')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
    for (const name of fs.readdirSync(path.join(DATA, 'backups'))) if (/^justtprint-auto-/.test(name)) fs.rmSync(path.join(DATA, 'backups', name));
    await page.click('#save-backup-restore');
    check('Backup/Restore closes', !(await page.isVisible('#backup-restore-dialog')));

    // Keyboard Shortcuts and About (React).
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+?' : 'Control+Shift+?');
    check(
      'Ctrl+Shift+? opens Keyboard Shortcuts',
      (await page.isVisible('#keyboard-shortcuts-dialog')) && (await page.locator('#keyboard-shortcuts-dialog .shortcut-row').count()) === 13
    );
    await page.click('#keyboard-shortcuts-dialog .dialog-buttons button');
    check('Keyboard Shortcuts closes', !(await page.isVisible('#keyboard-shortcuts-dialog')));
    // Installing (src/web/install.ts, startup/pageInit.ts): the service worker is there for the browser, and Install App says how.
    check(
      'the install service worker is active',
      await page
        .waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.active, null, { timeout: 15000 })
        .then(
          () => true,
          () => false
        )
    );
    await page.evaluate(() => window.openInstallApp());
    check(
      'Install App shows the steps for this browser',
      (await page.isVisible('#install-app-dialog')) && ['prompt', 'browser-menu'].includes(await page.getAttribute('#install-app-steps', 'data-way')),
      await page.getAttribute('#install-app-steps', 'data-way').catch(() => '')
    );
    await page.click('#close-install-app');
    // Shortcuts (React, src/web/shortcuts.ts).
    const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modKey}+/`);
    check('Ctrl+/ focuses the search box', (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Search the library');
    await page.evaluate(() => document.activeElement?.blur());
    await page.evaluate(() => window.libraryFilters.setFromSelect('favorite-select', 'favorited'));
    await page.keyboard.press(`${modKey}+Shift+C`);
    check(
      'Ctrl+Shift+C clears the filters',
      await page
        .waitForFunction(() => window.libraryFilters.state().favorite === 'all', null, { timeout: 5000 })
        .then(
          () => true,
          () => false
        )
    );
    await page.evaluate(() => window.openAbout());
    const aboutVersion = await page
      .waitForFunction(
        (version) => {
          const text = document.getElementById('about-version')?.textContent || '';
          return text.includes(version) ? text : null;
        },
        require('../../package.json').version,
        { timeout: 10000 }
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    check('About shows the version', !!aboutVersion, aboutVersion);
    await page.uncheck('#auto-update-check');
    const updateSetting = await waitFor(
      async () => {
        const value = (await invoke(base, session, 'get-setting', ['autoUpdateCheck'])).result;
        return value === '0' ? value : null;
      },
      10000,
      'autoUpdateCheck'
    ).catch(() => null);
    check('About saves the update check setting', updateSetting === '0');
    await page.check('#auto-update-check');
    await page.click('#about-dialog .about-close-x');
    check('About closes', !(await page.isVisible('#about-dialog')));

    // Performance Settings (React): loads the setting, refuses a bad value, saves a good one.
    const savedMaxSize = (await invoke(base, session, 'get-setting', ['maxFileSizeMB'])).result;
    await page.evaluate(() => window.openPerformanceSettings());
    await page.waitForSelector('#performance-settings-dialog[open]', { timeout: 10000 }).catch(() => {});
    check(
      'Performance Settings opens with the saved value',
      (await page.inputValue('#max-file-size')) === (savedMaxSize || '50'),
      await page.inputValue('#max-file-size')
    );
    await page.fill('#max-file-size', '0');
    await page.click('#save-performance-settings');
    const badSize = await page.waitForSelector('dialog[open]:has-text("Invalid max file size") button:text-is("OK")', { timeout: 10000 }).catch(() => null);
    check('Performance Settings refuses 0 MB', !!badSize);
    if (badSize) await badSize.click();
    await page.fill('#max-file-size', '75');
    await page.click('#save-performance-settings');
    const sizeSaved = await page
      .waitForSelector('dialog[open]:has-text("Performance settings saved") button:text-is("OK")', { timeout: 10000 })
      .catch(() => null);
    if (sizeSaved) await sizeSaved.click();
    check(
      'Performance Settings saves',
      !!sizeSaved && (await invoke(base, session, 'get-setting', ['maxFileSizeMB'])).result === '75' && !(await page.isVisible('#performance-settings-dialog'))
    );
    await invoke(base, session, 'save-setting', ['maxFileSizeMB', savedMaxSize || '50']);

    // MCP Server settings (React): this page's URL, and a client config that carries the API token.
    const apiToken = ((await invoke(base, session, 'get-server-access-info')).result || {}).apiToken;
    await page.evaluate(() => window.openMcpServerSettings());
    check('MCP Server settings opens', await page.isVisible('#mcp-server-settings-dialog'));
    check('MCP URL is this server', (await page.inputValue('#mcp-server-url')) === `${base}/mcp`, await page.inputValue('#mcp-server-url'));
    // The setup shown for each app, with this page's URL and the API token filled in.
    const mcpSetupFor = async (client) => {
      await page.selectOption('#mcp-client-select', client);
      return page
        .waitForFunction(
          () => {
            const text = document.getElementById('mcp-server-config')?.textContent || '';
            return text.includes('Bearer pv_') ? text : null;
          },
          null,
          { timeout: 10000 }
        )
        .then((h) => h.jsonValue())
        .catch(() => '');
    };
    const parse = (text) => {
      try {
        return JSON.parse(text);
      } catch (_) {
        return null;
      }
    };
    const mcpConfig = await mcpSetupFor('other');
    const parsedConfig = parse(mcpConfig)?.mcpServers?.justtprint;
    check(
      'MCP client config has the URL and API token',
      !!parsedConfig && parsedConfig.url === `${base}/mcp` && parsedConfig.headers && parsedConfig.headers.Authorization === `Bearer ${apiToken}`,
      mcpConfig.slice(0, 200)
    );
    const claudeCode = await mcpSetupFor('claude-code');
    check(
      'MCP setup for Claude Code is one command',
      claudeCode === `claude mcp add --transport http justtprint ${base}/mcp --header "Authorization: Bearer ${apiToken}"` &&
        /Copy command/.test(await page.textContent('#copy-mcp-server-config')),
      claudeCode
    );
    const vscode = parse(await mcpSetupFor('vscode'))?.servers?.justtprint;
    check(
      'MCP setup for VS Code uses servers and type http',
      !!vscode && vscode.type === 'http' && vscode.url === `${base}/mcp` && vscode.headers.Authorization === `Bearer ${apiToken}`,
      JSON.stringify(vscode)
    );
    const desktop = parse(await mcpSetupFor('claude-desktop'))?.mcpServers?.justtprint;
    check(
      'MCP setup for Claude Desktop runs mcp-remote with the token',
      !!desktop &&
        desktop.command === 'npx' &&
        desktop.args.includes('mcp-remote') &&
        desktop.args.includes(`${base}/mcp`) &&
        desktop.env.AUTH_HEADER === `Bearer ${apiToken}`,
      JSON.stringify(desktop)
    );
    const cursor = parse(await mcpSetupFor('cursor'))?.mcpServers?.justtprint;
    check('MCP setup for Cursor has the URL and token', !!cursor && cursor.url === `${base}/mcp` && cursor.headers.Authorization === `Bearer ${apiToken}`);
    check('MCP settings list the tools', /search_models/.test(await page.textContent('#mcp-server-tools').catch(() => '')));
    await page.click('#cancel-mcp-server-settings');
    check('MCP Server settings closes', !(await page.isVisible('#mcp-server-settings-dialog')));

    // The browser extension is removed: no menu item and no dialog.
    check(
      'no Browser Extension dialog',
      await page.evaluate(() => typeof window.openBrowserExtensionSettings === 'undefined' && !document.getElementById('browser-extension-settings-dialog'))
    );

    // File Type settings (React): lists the catalog, saves a type, and the sidebar filter offers it.
    const savedTypes = (await invoke(base, session, 'get-setting', ['scanAdditionalFileTypes'])).result;
    await page.evaluate(() => window.openFileTypeSettings());
    await page.waitForSelector('#file-type-settings-dialog[open] #scan-type-obj', { timeout: 10000 }).catch(() => {});
    check('File Type settings lists the file types', (await page.locator('#file-type-settings-dialog .scan-file-type-option').count()) >= 19);
    check('3MF metadata options default to on', await page.isChecked('#enable-3mf-designer'));
    await page.check('#scan-type-obj');
    await page.click('#save-file-type-settings');
    await page.waitForSelector('#file-type-settings-dialog', { state: 'hidden', timeout: 10000 }).catch(() => {});
    check('File Type settings saves', JSON.parse((await invoke(base, session, 'get-setting', ['scanAdditionalFileTypes'])).result || '[]').includes('obj'));
    check(
      'file type filter offers the new type',
      await page
        .waitForSelector('#filetype-select option[value="obj"]', { state: 'attached', timeout: 10000 })
        .then(() => true)
        .catch(() => false)
    );
    await invoke(base, session, 'save-setting', ['scanAdditionalFileTypes', savedTypes || '[]']);

    // HTTPS / SSL settings (React): status, mode panels and the redirect label. Not applied (that restarts the listener).
    await page.evaluate(() => window.openHttpsSettings());
    await page.waitForSelector('#https-settings-dialog[open]', { timeout: 10000 }).catch(() => {});
    check('HTTPS settings shows the status', /HTTP on port \d+/.test(await page.textContent('#https-settings-status').catch(() => '')));
    check('HTTPS settings starts in Off mode with no panels', (await page.inputValue('#tls-mode')) === 'off' && !(await page.isVisible('.tls-mode-panel')));
    await page.selectOption('#tls-mode', 'custom');
    check('Custom mode shows the certificate fields', (await page.isVisible('#tls-cert-path')) && !(await page.isVisible('#tls-domain')));
    await page.selectOption('#tls-mode', 'letsencrypt');
    check("Let's Encrypt mode shows domain and email", (await page.isVisible('#tls-domain')) && (await page.isVisible('#tls-email')));
    await page.selectOption('#tls-mode', 'selfsigned');
    check('Self-signed mode shows the hostname', (await page.isVisible('#tls-selfsigned-host')) && !(await page.isVisible('#tls-cert-path')));
    await page.fill('#tls-listen-port', '5443');
    check('redirect label follows the listen port', /:5443$/.test((await page.textContent('#tls-redirect-http-label')).trim()));
    await page.click('#cancel-https-settings');
    check('HTTPS settings closes', !(await page.isVisible('#https-settings-dialog')));

    // AI Configuration (React): service defaults, nothing saved until Save, and the prompt editor.
    const aiKeys = ['aiService', 'apiEndpoint', 'aiModel', 'apiKey', 'aiTagMaxTags', 'aiTagPrompt'];
    const savedAi = {};
    for (const key of aiKeys) savedAi[key] = (await invoke(base, session, 'get-setting', [key])).result;
    await page.evaluate(() => window.openAiConfig());
    await page.waitForSelector('#ai-config-dialog[open]', { timeout: 10000 }).catch(() => {});
    check('AI Configuration opens', await page.isVisible('#ai-config-dialog'));
    await page.selectOption('#ai-service-select', 'claude');
    check(
      'choosing Claude fills its endpoint and model',
      (await page.inputValue('#ai-endpoint')) === 'https://api.anthropic.com/v1/' && (await page.inputValue('#ai-model')) === 'claude-haiku-4-5'
    );
    check('Claude asks for an API key', /^API Key:$/.test((await page.textContent('label[for="ai-api-key"]')).trim()));
    await page.selectOption('#ai-service-select', 'custom');
    check('a custom server makes the key optional', /optional/.test(await page.textContent('label[for="ai-api-key"]')));
    await page.click('#cancel-ai-config');
    check('Cancel saves nothing', (await invoke(base, session, 'get-setting', ['aiService'])).result === savedAi.aiService);
    await page.evaluate(() => window.openAiConfig());
    await page.waitForSelector('#ai-config-dialog[open]', { timeout: 10000 }).catch(() => {});
    await page.selectOption('#ai-service-select', 'custom');
    await page.fill('#ai-endpoint', 'http://ollama.local:11434/v1');
    await page.fill('#ai-model', 'llava');
    await page.fill('#ai-tag-max-tags', '7');
    await page.click('#edit-ai-prompt');
    await page.waitForSelector('#ai-prompt-edit-dialog[open]', { timeout: 10000 }).catch(() => {});
    check('Edit Prompt shows the default prompt', (await page.inputValue('#ai-prompt-textarea')).length > 50);
    await page.click('#cancel-ai-prompt-edit');
    await page.click('#save-ai-config');
    await page.waitForSelector('#ai-config-dialog', { state: 'hidden', timeout: 10000 }).catch(() => {});
    const aiAfter = {};
    for (const key of aiKeys) aiAfter[key] = (await invoke(base, session, 'get-setting', [key])).result;
    check(
      'Save stores the AI settings',
      aiAfter.aiService === 'custom' && aiAfter.apiEndpoint === 'http://ollama.local:11434/v1' && aiAfter.aiModel === 'llava' && aiAfter.aiTagMaxTags === '7',
      JSON.stringify(aiAfter)
    );
    for (const key of aiKeys) await invoke(base, session, 'save-setting', [key, savedAi[key] == null ? '' : savedAi[key]]);

    // Puter.com: Puter.js runs only in the sign-in popup, which hands its login to the page. A stand-in
    // Puter.js (served as js.puter.com, so the popup's CSP is what allows it) and Puter proxy keep this offline.
    const puterContext = page.context();
    await puterContext.route('https://js.puter.com/**', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: "window.puter = { authToken: 'e2e-puter-token', auth: { isSignedIn: () => true, signIn: async () => {}, signOut: () => { window.puter.authToken = null; } } };"
      })
    );
    // The popup can close before its URL is read, so record the page request instead.
    const signInPages = [];
    const recordSignInPage = (request) => {
      if (/\/puter-signin\.html/.test(request.url())) signInPages.push(request.url());
    };
    puterContext.on('request', recordSignInPage);
    const puterRequests = [];
    await page.route('**/api/puter-ai/chat', (route) => {
      puterRequests.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: 'dragon, toy' }) });
    });
    await page.evaluate(() => window.openAiConfig());
    await page.waitForSelector('#ai-config-dialog[open]', { timeout: 10000 }).catch(() => {});
    await page.selectOption('#ai-service-select', 'puter');
    check(
      'Puter shows its account, not an API key',
      (await page.textContent('#puter-account-status')) === 'Not signed in' && !(await page.isVisible('#ai-api-key'))
    );
    const signInPopup = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
    await page.click('#puter-sign-in');
    const popup = await signInPopup;
    check('Sign In opens the Puter sign-in page', !!popup && signInPages.length === 1, signInPages.join(', '));
    await page.waitForFunction(() => document.querySelector('#puter-account-status')?.textContent === 'Signed in', null, { timeout: 10000 }).catch(() => {});
    check('the popup hands the Puter login to the page', (await page.evaluate(() => localStorage.getItem('justtprint.puterAuthToken'))) === 'e2e-puter-token');
    check(
      'the popup closes after signing in',
      !popup ||
        (await popup
          .waitForEvent('close', { timeout: 10000 })
          .then(() => true)
          .catch(() => popup.isClosed()))
    );
    // The login is kept for the account: another device (the same login cookie, nothing in its browser) has it too.
    check('the Puter login is kept for the account', ((await invoke(base, session, 'get-puter-login')).result || {}).token === 'e2e-puter-token');
    const { cookies } = await page.context().storageState();
    const otherDevice = await (
      await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: { cookies, origins: [] } })
    ).newPage();
    const otherLogin = async () => {
      await otherDevice.goto(base);
      await otherDevice.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 }).catch(() => {});
      await otherDevice.waitForTimeout(1000);
      return otherDevice.evaluate(() => localStorage.getItem('justtprint.puterAuthToken'));
    };
    check('another device logged in to the same account is signed in to Puter', (await otherLogin()) === 'e2e-puter-token');
    await page.click('#test-ai-config');
    await page
      .waitForFunction(() => /Test (successful|failed)/.test(document.querySelector('#ai-config-result')?.textContent || ''), null, { timeout: 20000 })
      .catch(() => {});
    check(
      'Puter test goes through the server proxy with the login',
      /Test successful/.test(await page.textContent('#ai-config-result')) && puterRequests.length > 0 && puterRequests[0].authToken === 'e2e-puter-token',
      `${await page.textContent('#ai-config-result')} ${JSON.stringify(puterRequests)}`
    );
    const signOutPopup = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
    await page.click('#puter-sign-out');
    await signOutPopup;
    check(
      'Sign Out forgets the Puter login',
      (await page.textContent('#puter-account-status')) === 'Not signed in' &&
        (await page.evaluate(() => localStorage.getItem('justtprint.puterAuthToken'))) === null
    );
    await waitFor(async () => (((await invoke(base, session, 'get-puter-login')).result || {}).token === null ? true : null), 10000, 'signed out').catch(
      () => {}
    );
    check('signing out on one device signs the other out too', (await otherLogin()) === null);
    // A browser signed in before the login was kept for the account hands it over once.
    await otherDevice.evaluate(() => {
      localStorage.removeItem('justtprint.puterAuthSynced');
      localStorage.setItem('justtprint.puterAuthToken', 'e2e-old-puter-token');
    });
    await otherLogin();
    check(
      'a Puter login from before moves to the account',
      (await waitFor(
        async () => (((await invoke(base, session, 'get-puter-login')).result || {}).token === 'e2e-old-puter-token' ? true : null),
        10000,
        'moved'
      ).catch(() => false)) === true
    );
    await invoke(base, session, 'save-puter-login', [null]);
    await otherDevice.context().close();
    await page.click('#cancel-ai-config');
    // Cleanup: the sign-in popup's context may be closed already.
    await page.unroute('**/api/puter-ai/chat').catch(() => {});
    await puterContext.unroute('https://js.puter.com/**').catch(() => {});
    puterContext.off('request', recordSignInPage);

    // Theme settings (React): saving a theme applies its accent color without a regenerate prompt.
    const savedTheme = (await invoke(base, session, 'get-setting', ['uiTheme'])).result;
    await page.evaluate(() => window.openThemeSettings());
    await page.waitForSelector('#settings-dialog[open]', { timeout: 10000 }).catch(() => {});
    check('Theme settings opens with the saved theme', (await page.inputValue('#ui-theme')) === (savedTheme || 'modern-cyan'));
    await page.selectOption('#ui-theme', 'modern-purple');
    await page.click('#save-settings');
    await page.waitForSelector('#settings-dialog', { state: 'hidden', timeout: 10000 }).catch(() => {});
    const accent = await page.evaluate(() => ({
      token: document.documentElement.style.getPropertyValue('--jp-accent').trim(),
      button: getComputedStyle(document.querySelector('.jp-tab.is-active, .jp-btn--primary') || document.body).backgroundColor
    }));
    check(
      'Theme settings saves and applies the theme to the whole interface',
      (await invoke(base, session, 'get-setting', ['uiTheme'])).result === 'modern-purple' &&
        accent.token === '#b47cfa' &&
        !(await page.isVisible('dialog[open]:has-text("Regenerate Thumbnails")')),
      JSON.stringify(accent)
    );
    // Startup (src/web/startup/start.ts) applies the saved theme after a reload.
    await page.reload();
    await page.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    const themed = await page
      .waitForFunction(
        () =>
          document.body.getAttribute('data-theme') === 'modern-purple' && document.documentElement.style.getPropertyValue('--jp-accent').trim() === '#b47cfa',
        null,
        { timeout: 15000 }
      )
      .then(
        () => true,
        () => false
      );
    check('the saved theme is applied when the page loads', themed);

    // Light color scheme (tokens.css, startup/theme.ts): the page turns light, the accent takes its light shade.
    await page.evaluate(() => window.openThemeSettings());
    await page.waitForSelector('#settings-dialog[open]', { timeout: 10000 }).catch(() => {});
    check('Theme settings offers the color scheme, dark to start', (await page.inputValue('#ui-color-scheme')) === 'dark');
    await page.selectOption('#ui-color-scheme', 'light');
    await page.click('#save-settings');
    await page.waitForSelector('#settings-dialog', { state: 'hidden', timeout: 10000 }).catch(() => {});
    const lightLook = () =>
      page.evaluate(() => ({
        scheme: document.documentElement.getAttribute('data-color-scheme'),
        background: getComputedStyle(document.body).backgroundColor,
        accent: document.documentElement.style.getPropertyValue('--jp-accent').trim()
      }));
    const isLight = (look) => look.scheme === 'light' && /rgb\((2[0-9]{2}), (2[0-9]{2}), (2[0-9]{2})\)/.test(look.background) && look.accent === '#7c3aed';
    let look = await lightLook();
    check(
      'choosing Light turns the page light, with the light shade of the accent',
      (await invoke(base, session, 'get-setting', ['uiColorScheme'])).result === 'light' && isLight(look),
      JSON.stringify(look)
    );
    await page.reload();
    await page.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    const lightFirst = await page.evaluate(() => document.documentElement.getAttribute('data-color-scheme'));
    await page
      .waitForFunction(() => document.documentElement.style.getPropertyValue('--jp-accent').trim() === '#7c3aed', null, { timeout: 15000 })
      .catch(() => {});
    look = await lightLook();
    check('the light scheme is there from the first paint after a reload', lightFirst === 'light' && isLight(look), JSON.stringify({ lightFirst, look }));
    await invoke(base, session, 'save-setting', ['uiColorScheme', 'dark']);
    await page.evaluate(() => window.applyColorScheme?.('dark'));
    await invoke(base, session, 'save-setting', ['uiTheme', savedTheme || 'modern-cyan']);
    await page.waitForSelector('.file-grid [data-filepath]', { timeout: 30000 }).catch(() => {});

    // Same shape, any resolution (geometry-signature.js similarShape): a ball meshed coarse and fine.
    const ballDir = path.join(LIBRARY, 'Balls');
    fs.mkdirSync(ballDir, { recursive: true });
    const ballStl = (n) => {
      const tris = [];
      const p = (i, j) => {
        const th = (i / n) * Math.PI * 2;
        const ph = (j / (n / 2)) * Math.PI;
        return [10 * Math.sin(ph) * Math.cos(th), 10 * Math.sin(ph) * Math.sin(th), 10 * Math.cos(ph)];
      };
      for (let i = 0; i < n; i++) for (let j = 0; j < n / 2; j++) tris.push([p(i, j), p(i + 1, j), p(i + 1, j + 1)], [p(i, j), p(i + 1, j + 1), p(i, j + 1)]);
      const buf = Buffer.alloc(84 + tris.length * 50);
      buf.writeUInt32LE(tris.length, 80);
      tris.forEach((tri, i) => tri.forEach((pt, j) => pt.forEach((x, k) => buf.writeFloatLE(x, 84 + i * 50 + 12 + j * 12 + k * 4))));
      return buf;
    };
    fs.writeFileSync(path.join(ballDir, 'ball smooth.stl'), ballStl(96));
    fs.writeFileSync(path.join(ballDir, 'ball coarse.stl'), ballStl(32));
    // Folder watching adds them (scanning a new folder inside the app folder is refused from the web).
    await waitFor(
      async () => {
        for (const name of ['ball smooth.stl', 'ball coarse.stl'])
          if (!(await invoke(base, session, 'get-model', [path.join(ballDir, name)])).result) return false;
        return true;
      },
      60000,
      'balls added by folder watching'
    ).catch(() => {});

    // Notifications (src/server/notifications.js, shell/Notifications.tsx): a finished same-geometry search shows in the bell.
    await invoke(base, session, 'start-geometry-scan', [null]);
    await waitFor(async () => (await invoke(base, session, 'get-geometry-scan')).result?.running === false, 60000, 'geometry search').catch(() => {});
    const bell = await page
      .waitForFunction(() => /unread/.test(document.getElementById('jp-notifications-button')?.getAttribute('aria-label') || ''), null, { timeout: 15000 })
      .then(
        () => true,
        () => false
      );
    check('the bell shows unread notifications', bell, await page.getAttribute('#jp-notifications-button', 'aria-label').catch(() => ''));
    await page.click('#jp-notifications-button');
    const notice = await page
      .waitForSelector('#jp-notifications .jp-notify__item:has-text("Same-geometry search finished")', { timeout: 10000 })
      .catch(() => null);
    check('the panel lists what finished', !!notice);
    const cleared = await page
      .waitForFunction(() => !document.querySelector('.jp-notify__badge'), null, { timeout: 10000 })
      .then(
        () => true,
        () => false
      );
    // What was listed is read now. (A background job can finish meanwhile and bring a new unread one:
    // that is not what this checks.)
    const afterOpen = (await invoke(base, session, 'get-notifications', [null])).result || {};
    const geometryNote = (afterOpen.items || []).find((item) => /Same-geometry search finished/.test(item.title || ''));
    check(
      'opening the panel marks it read',
      cleared && !!geometryNote && geometryNote.unread === false,
      JSON.stringify((afterOpen.items || []).slice(0, 3).map((item) => [item.title, item.unread]))
    );
    if (notice) await page.click('#jp-notifications .jp-notify__item:has-text("Same-geometry search finished") button');
    check(
      'a notification opens its page',
      await page
        .waitForFunction(() => location.hash.startsWith('#/duplicates'), null, { timeout: 10000 })
        .then(
          () => true,
          () => false
        )
    );
    const similarGroups = (await invoke(base, session, 'get-geometry-duplicates', [{ similar: true }])).result?.groups || [];
    check(
      'Same shape, any resolution groups a ball meshed coarse and fine',
      similarGroups.some(
        (g) =>
          g.files
            .map((f) => path.basename(f.filePath))
            .sort()
            .join('|') === 'ball coarse.stl|ball smooth.stl'
      ),
      JSON.stringify(similarGroups.map((g) => g.files.map((f) => path.basename(f.filePath))))
    );
    await page.evaluate(() => (location.hash = '#/duplicates'));
    await page.click('#dedup-mode-similar').catch(() => {});
    const similarCard = await page.waitForSelector('.jp-dup-group:has-text("files with the same shape")', { timeout: 15000 }).catch(() => null);
    check('the Duplicates page shows them under Same shape, any resolution', !!similarCard && /check before deleting/.test(await similarCard.textContent()));
    await page.click('#dedup-mode-files').catch(() => {});
    for (const name of ['ball smooth.stl', 'ball coarse.stl']) await invoke(base, session, 'delete-file', [path.join(ballDir, name)]);
    await page.evaluate(() => (location.hash = '#/library'));
    await page.waitForSelector('.file-grid [data-filepath]', { timeout: 30000 }).catch(() => {});
    // The deleted balls leave the grid once the refresh arrives.
    await page.waitForFunction(() => !document.querySelector('.file-grid [data-filepath*="/Balls/"]'), null, { timeout: 15000 }).catch(() => {});

    // Tools → Clear New Flag (src/web/library/actions.ts).
    const flagged = (await page.$$eval('.file-grid [data-filepath]', (els) => els.map((el) => el.getAttribute('data-filepath')))).filter(
      (p) => !p.includes('::')
    )[0];
    if (flagged) {
      const flaggedModel = (await invoke(base, session, 'get-model', [flagged])).result;
      await invoke(base, session, 'save-model', [{ ...flaggedModel, markAsNew: true }]);
      await runSetting('Clear New Flag');
      const askClear = await page
        .waitForSelector('dialog[id^="browser-message-"][open]:has-text("clear the New flag") button:text-is("Yes")', { timeout: 10000 })
        .catch(() => null);
      if (askClear) await askClear.click();
      const doneDialog = await page
        .waitForSelector('dialog[id^="browser-message-"][open]:has-text("Clear New Flag") button', { timeout: 10000 })
        .catch(() => null);
      const done = doneDialog && /Cleared the New flag from/.test(await page.textContent('dialog[id^="browser-message-"][open]'));
      if (doneDialog) await doneDialog.click();
      await page.click('.jp-sidebar .jp-nav__row:has-text("Library")');
      check(
        'Clear New Flag asks, clears the flag and says how many',
        !!askClear && !!done && !((await invoke(base, session, 'get-model', [flagged])).result || {}).isNew
      );

      // Add Image (model menu → server → this page): pick a file, and it becomes another image of the model.
      const imagesBefore = ((await invoke(base, session, 'get-all-thumbnails', [flagged])).result || []).length;
      const chooser = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
      await page.evaluate((p) => window.electron.send('add-image-request', p), flagged);
      const fileChooser = await chooser;
      if (fileChooser) await fileChooser.setFiles(path.join(ROOT, 'assets', 'logo.png'));
      const added = await waitFor(
        async () => (((await invoke(base, session, 'get-all-thumbnails', [flagged])).result || []).length > imagesBefore ? true : null),
        15000,
        'image added'
      ).catch(() => false);
      check('Add Image picks a file in the browser and adds it to the model', !!fileChooser && added === true, flagged);
    }

    // Slicer settings (React): lists saved slicers, refuses a duplicate name, saves a new one.
    await invoke(base, session, 'save-slicer', [{ name: 'Seed Slicer', path: '/usr/bin/seed-slicer' }]);
    await page.evaluate(() => window.openSlicerSettings());
    await page.waitForSelector('#slicer-dialog[open] .slicer-entry', { timeout: 10000 }).catch(() => {});
    const slicerRows = await page.locator('#slicer-dialog .slicer-entry').count();
    check('Slicer settings lists the saved slicers', slicerRows >= 1 && (await page.inputValue('#slicer-dialog .slicer-name')) !== '');
    await page.click('#add-slicer-button');
    const newRow = page.locator('#slicer-dialog .slicer-entry').last();
    await newRow.locator('.slicer-path').fill('/opt/OrcaSlicer/orca-slicer');
    await newRow.locator('.slicer-path').blur();
    check('a typed path suggests a name', (await newRow.locator('.slicer-name').inputValue()) === 'Orca Slicer');
    const firstName = await page.inputValue('#slicer-dialog .slicer-name');
    await newRow.locator('.slicer-name').fill(firstName);
    await page.click('#save-slicer-settings');
    const duplicate = await page.waitForSelector('dialog[open]:has-text("is already used") button:text-is("OK")', { timeout: 10000 }).catch(() => null);
    check('Slicer settings refuses a duplicate name', !!duplicate);
    if (duplicate) await duplicate.click();
    await newRow.locator('.slicer-name').fill('Orca Slicer');
    await page.click('#save-slicer-settings');
    const slicersSaved = await page
      .waitForSelector('dialog[open]:has-text("Slicer settings saved") button:text-is("OK")', { timeout: 10000 })
      .catch(() => null);
    if (slicersSaved) await slicersSaved.click();
    const savedSlicers = (await invoke(base, session, 'get-slicers')).result || [];
    check(
      'Slicer settings saves the list',
      !!slicersSaved &&
        savedSlicers.length === slicerRows + 1 &&
        savedSlicers.some((s) => s.name === 'Orca Slicer' && s.path === '/opt/OrcaSlicer/orca-slicer'),
      JSON.stringify(savedSlicers)
    );
    await invoke(base, session, 'clear-and-save-slicers', [[]]);

    // STL Home (React): loads the saved directory, edits the lists and path options, saves.
    // (No directory is left on save: the web UI may not scan the e2e library, inside the app folder.)
    const stlHomeKeys = ['stlHomeDirectories', 'stlHome', 'stlHomeExcludeDirectories', 'pathMetadataStlHomeEnabled', 'pathMetadataStlHomeDirection'];
    const savedStlHome = {};
    for (const key of stlHomeKeys) savedStlHome[key] = (await invoke(base, session, 'get-setting', [key])).result;
    await page.evaluate(() => window.openStlHome());
    const homeRow = await page.waitForSelector(`#stl-home-directories-list li:has-text("${LIBRARY}")`, { timeout: 10000 }).catch(() => null);
    check('STL Home opens with the saved directory', !!homeRow);
    await page.fill('#stl-home-directories-input', '/srv/models');
    await page.press('#stl-home-directories-input', 'Enter');
    await page.fill('#stl-home-directories-input', '/srv/models/');
    await page.click('#stl-home-directories-add');
    check('STL Home ignores a duplicate directory', (await page.locator('#stl-home-directories-list .stl-home-exclude-item').count()) === 2);
    await page.click('#stl-home-directories-list li:has-text("/srv/models") .stl-home-exclude-remove');
    if (homeRow) await page.click(`#stl-home-directories-list li:has-text("${LIBRARY}") .stl-home-exclude-remove`);
    check('STL Home shows the empty list', await page.isVisible('#stl-home-directories-list .stl-home-exclude-empty'));
    await page.fill('#stl-home-exclude-input', 'Designer C');
    await page.click('#stl-home-exclude-add');
    check(
      'path options are grayed until enabled',
      await page.evaluate(() => document.getElementById('stl-home-path-metadata-options').classList.contains('grayed'))
    );
    await page.check('#stl-home-path-metadata-enabled');
    await page.selectOption('#stl-home-path-direction', 'fromRoot');
    check('From Root explains its levels', /From Root: level 0/.test(await page.textContent('#stl-home-dialog .stl-home-path-direction-desc')));
    await page.click('#save-stl-home-button');
    await page.waitForSelector('#stl-home-dialog', { state: 'hidden', timeout: 10000 }).catch(() => {});
    const stlHomeAfter = {};
    for (const key of stlHomeKeys) stlHomeAfter[key] = (await invoke(base, session, 'get-setting', [key])).result;
    check(
      'STL Home saves directories, exclusions and path options',
      stlHomeAfter.stlHomeDirectories === '[]' &&
        !stlHomeAfter.stlHome &&
        stlHomeAfter.stlHomeExcludeDirectories === '["Designer C"]' &&
        stlHomeAfter.pathMetadataStlHomeEnabled === '1' &&
        stlHomeAfter.pathMetadataStlHomeDirection === 'fromRoot',
      JSON.stringify(stlHomeAfter)
    );
    for (const key of stlHomeKeys) await invoke(base, session, 'save-setting', [key, savedStlHome[key] == null ? '' : savedStlHome[key]]);
    await page.evaluate(() => window.updateScanStlHomeButtonVisibility?.());

    // Organize (8.1): the sidebar runs it at once; without its folders it opens Settings → Scanning → Organize and says so.
    await page.click('.jp-sidebar .jp-nav__row:has-text("Organize")');
    const organizeAsk = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("scanned directory")', { timeout: 10000 }).catch(() => null);
    if (organizeAsk) await page.click('dialog[id^="browser-message-"][open] button:text-is("OK")');
    const organizeForm = await page.waitForSelector('#organize-settings-dialog[open] #organize-layers', { timeout: 10000 }).catch(() => null);
    check(
      'Organize without its folders opens its settings and says so',
      !!organizeAsk && !!organizeForm && /#\/settings\/organize$/.test(page.url()),
      page.url()
    );
    check(
      'Organize is set up as Category / Subcategory / Title, every step on',
      !!organizeForm &&
        (await page.$$eval('#organize-layers select', (selects) => selects.map((select) => select.value))).join('/') === 'category/subcategory' &&
        (await page.isChecked('#organize-tidy')) &&
        (await page.isChecked('#organize-tags')) &&
        (await page.isChecked('#organize-auto-apply'))
    );

    // De-Dup (React): a copy of cube.stl shows as a duplicate; Easy with a preferred directory keeps the original; Delete removes the copy.
    const dedupOriginal = path.join(LIBRARY, 'Designer A', 'cube.stl');
    const dedupCopy = path.join(LIBRARY, 'Designer A', 'cube copy.stl');
    fs.copyFileSync(dedupOriginal, dedupCopy);
    await invoke(base, session, 'save-model', [{ filePath: dedupCopy, fileName: 'cube copy.stl' }]);
    await invoke(base, session, 'calculate-file-hash', [dedupOriginal]);
    await invoke(base, session, 'calculate-file-hash', [dedupCopy]);
    await page.click('.jp-sidebar .jp-nav__row:has-text("Duplicates")');
    const copyRow = `#dedup-page input[data-filepath="${dedupCopy}"]`;
    const originalRow = `#dedup-page input[data-filepath="${dedupOriginal}"]`;
    const dedupGroup = await page.waitForSelector(copyRow, { timeout: 30000 }).catch(() => null);
    check(
      'Duplicates lists the pair side by side',
      !!dedupGroup &&
        (await page.isVisible(originalRow)) &&
        /#\/duplicates$/.test(page.url()) &&
        (await page.locator(`#dedup-page .jp-dup-group:has(input[data-filepath="${dedupCopy}"]) .jp-dup-copy`).count()) === 2
    );
    check('De-Dup scope: entire library without filters', (await page.isChecked('#dedup-scope-entire')) && (await page.isDisabled('#dedup-scope-current')));
    await page.fill('#dedup-preferred-directory-input', path.join(LIBRARY, 'Designer A'));
    await page.press('#dedup-preferred-directory-input', 'Enter');
    check(
      'Easy with a preferred directory keeps the original',
      (await page.isChecked(copyRow)) && !(await page.isChecked(originalRow)) && (await page.locator('#dedup-page .preferred-directory-badge').count()) >= 2
    );
    check(
      'De-Dup saves the preferred directory',
      (await invoke(base, session, 'get-setting', ['dedupPreferredDirectory'])).result === path.join(LIBRARY, 'Designer A')
    );
    await page.click('#dedup-clear-button');
    check('Clear unselects everything', !(await page.isChecked(copyRow)));
    await page.click(`#dedup-page .jp-dup-copy:has(input[data-filepath="${dedupOriginal}"]) button:has-text("Keep this")`);
    check('Keep this selects the other copy for deletion', (await page.isChecked(copyRow)) && !(await page.isChecked(originalRow)));
    await page.click(`#dedup-page .jp-dup-group:has(input[data-filepath="${dedupCopy}"]) button:has-text("Keep all")`);
    check('Keep all keeps every copy', !(await page.isChecked(copyRow)) && !(await page.isChecked(originalRow)));
    await page.check(copyRow);
    await page.click('#delete-selected');
    const confirmDedupDelete = await page
      .waitForSelector('dialog[open]:has-text("Confirm Delete") button:text-is("Yes")', { timeout: 10000 })
      .catch(() => null);
    if (confirmDedupDelete) await confirmDedupDelete.click();
    const copyGone = await page
      .waitForSelector(copyRow, { state: 'detached', timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check(
      'Delete Selected removes the copy from disk and the list',
      !!confirmDedupDelete && copyGone && !fs.existsSync(dedupCopy) && fs.existsSync(dedupOriginal)
    );
    await page.click('.jp-sidebar .jp-nav__row:has-text("Library")');
    check(
      'leaving the page closes Duplicates',
      await page.waitForSelector('#dedup-page', { state: 'detached', timeout: 5000 }).then(
        () => true,
        () => false
      )
    );
    await invoke(base, session, 'save-setting', ['dedupPreferredDirectory', '']);
    if (fs.existsSync(dedupCopy)) fs.rmSync(dedupCopy);

    // ZIP bundle panel (React, src/web/details/BundleDetails.tsx): a two-model archive groups into one card.
    const kitDir = path.join(LIBRARY, 'Bundle Kit');
    const kitZip = path.join(kitDir, 'kit.zip');
    fs.mkdirSync(kitDir, { recursive: true });
    // Different content from cube.stl and from each other, so De-Dup and hashes leave them alone.
    const cubeText = fs.readFileSync(path.join(LIBRARY, 'Designer A', 'cube.stl'), 'utf8');
    const kitPart = (name) => new TextEncoder().encode(cubeText.replace(/^solid[^\n]*/, `solid ${name}`));
    fs.writeFileSync(kitZip, require('fflate').zipSync({ 'kit/left.stl': kitPart('left'), 'kit/right.stl': kitPart('right') }));
    // The e2e library is inside the app folder, which scans refuse; register the entries directly.
    for (const entry of ['kit/left.stl', 'kit/right.stl']) {
      await invoke(base, session, 'save-model', [{ filePath: `${kitZip}::${entry}`, fileName: path.basename(entry) }]);
    }
    await page.click('.view-button[data-view="detailed"]');
    await page.evaluate(() => window.performCombinedSearch?.({ force: true }));
    const kitCard = '.file-grid .parent-model-group-detailed:has-text("kit.zip")';
    const kitShown = await page.waitForSelector(kitCard, { timeout: 30000 }).catch(() => null);
    check('a ZIP with two models shows as one bundle card', !!kitShown);
    if (kitShown) {
      await page.click(`${kitCard} .parent-model-group-meta`);
      const bundlePanel = await page.waitForSelector('#bundle-details:not(.hidden) #bundle-contents-list li', { timeout: 10000 }).catch(() => null);
      check(
        'clicking a bundle shows the bundle panel',
        !!bundlePanel &&
          (await page.textContent('#bundle-details-title')) === 'kit.zip' &&
          /ZIP archive • 2 files/.test(await page.textContent('#bundle-details-subtitle')) &&
          (await page.inputValue('#bundle-details-path')) === kitZip &&
          (await page.locator('#bundle-contents-list .bundle-contents-list-item').count()) === 2 &&
          /2\s*models/.test(await page.textContent('#bundle-details-stats'))
      );
      const kitModels = [`${kitZip}::kit/left.stl`, `${kitZip}::kit/right.stl`];
      const kitTagged = async (tag) => {
        const models = await Promise.all(kitModels.map(async (p) => (await invoke(base, session, 'get-model', [p])).result || {}));
        return models.map((m) => (m.tags || []).some((t) => (t.name || t) === tag));
      };
      await page.click('#bundle-add-tag');
      const bundleTagPrompt = await page.waitForSelector('dialog.browser-input-dialog[open] input', { timeout: 10000 }).catch(() => null);
      if (bundleTagPrompt) {
        await bundleTagPrompt.fill('e2e-bundle-tag');
        await page.click('dialog.browser-input-dialog[open] button[type=submit]');
      }
      const tagAdded = await waitFor(async () => ((await kitTagged('e2e-bundle-tag')).every(Boolean) ? true : null), 10000, 'bundle tag').catch(() => false);
      check(
        'the bundle panel adds a tag to every model in it',
        tagAdded === true && (await page.isVisible('#bundle-tags .tag[data-tag-name="e2e-bundle-tag"]'))
      );
      await page.click('#bundle-tags .tag[data-tag-name="e2e-bundle-tag"] .tag-remove');
      const tagRemoved = await waitFor(async () => ((await kitTagged('e2e-bundle-tag')).every((v) => !v) ? true : null), 10000, 'bundle tag removed').catch(
        () => false
      );
      check(
        'the bundle panel removes a tag from every model',
        tagRemoved === true && !(await page.isVisible('#bundle-tags .tag[data-tag-name="e2e-bundle-tag"]')),
        JSON.stringify({ saved: await kitTagged('e2e-bundle-tag'), chip: await page.isVisible('#bundle-tags .tag[data-tag-name="e2e-bundle-tag"]') })
      );
      // 3D preview of the whole bundle: parts laid out side by side, each one selectable.
      await page.evaluate(
        ([zip]) =>
          window.openBundlePreview({
            groupLabel: 'kit.zip',
            children: [
              { filePath: `${zip}::kit/left.stl`, fileName: 'left.stl', bundleKind: 'zip' },
              { filePath: `${zip}::kit/right.stl`, fileName: 'right.stl', bundleKind: 'zip' }
            ]
          }),
        [kitZip]
      );
      const bundlePreview = await page
        .waitForFunction(
          () =>
            document.getElementById('preview-file-type')?.textContent === 'ZIP bundle • 2 models' &&
            getComputedStyle(document.getElementById('preview-loading')).display === 'none',
          null,
          { timeout: 30000 }
        )
        .then(
          () => true,
          async () => page.textContent('#preview-dialog .preview-loading').catch(() => '')
        );
      const partNames = await page.$$eval('#preview-part-select option', (opts) => opts.map((o) => o.textContent));
      check(
        'the bundle 3D preview lays out every model with a part picker',
        bundlePreview === true &&
          (await page.isVisible('#preview-part-picker')) &&
          JSON.stringify(partNames) === JSON.stringify(['All parts', 'left.stl', 'right.stl']),
        `${bundlePreview} ${JSON.stringify(partNames)}`
      );
      await page.selectOption('#preview-part-select', { label: 'right.stl' });
      check('picking a part focuses it', /^Dimensions: /.test(await page.textContent('#preview-dimensions')));
      await page.click('#close-preview');
      await page.click('#bundle-contents-list .bundle-contents-list-item:text-is("left.stl")');
      const openedChild = await page
        .waitForFunction(
          () =>
            document.getElementById('path-tree-container')?.getAttribute('data-file-path')?.endsWith('::kit/left.stl') &&
            !document.getElementById('model-details')?.classList.contains('hidden'),
          null,
          { timeout: 10000 }
        )
        .then(
          () => true,
          () => false
        );
      check('a model in the bundle list opens its details', openedChild && (await page.isHidden('#bundle-details')));
    }

    // Thumbnails and scanning (TypeScript, src/web/thumbnails/ and src/web/scan/).
    const cubePath = path.join(LIBRARY, 'Designer A', 'cube.stl');
    const storedThumb = async (filePath) => String(((await invoke(base, session, 'get-model', [filePath])).result || {}).thumbnail || '');
    await page.evaluate(() => window.libraryFilters.setFromSelect('favorite-select', 'all'));
    await page.evaluate(() => window.clearAllLibraryFilters?.());
    // A card without an image renders one in this browser and saves it.
    await invoke(base, session, 'save-thumbnail', [cubePath, '3d.png']);
    await page.reload();
    await page.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    const cardRender = await waitFor(async () => ((await storedThumb(cubePath)).startsWith('data:image') ? true : null), 60000, 'card render').catch(
      () => false
    );
    check('a card without a thumbnail renders one in the browser and saves it', cardRender === true);
    // Tools → Generate Missing Thumbnails runs the server job in the dialog.
    await invoke(base, session, 'save-thumbnail', [cubePath, '3d.png']);
    await page.evaluate(() => window.electron.send('generate-missing-thumbnails'));
    const askMissing = await page
      .waitForSelector('dialog[id^="browser-message-"][open]:has-text("missing thumbnails") button:text-is("Yes")', { timeout: 10000 })
      .catch(() => null);
    if (askMissing) await askMissing.click();
    const jobDialog = await page.waitForSelector('#thumbnail-progress-overlay', { timeout: 10000 }).then(
      () => true,
      () => false
    );
    const jobDone = await page.waitForSelector('#thumbnail-progress-overlay', { state: 'detached', timeout: 120000 }).then(
      () => true,
      () => false
    );
    check(
      'Generate Missing Thumbnails asks, shows the server job, and renders the model',
      !!askMissing && jobDialog && jobDone && (await storedThumb(cubePath)).startsWith('data:image')
    );
    // Regenerate in the background: the sidebar follows it, and its end is reported.
    await page.evaluate(() => window.electron.send('regenerate-thumbnails'));
    const askAll = await page
      .waitForSelector('dialog[id^="browser-message-"][open]:has-text("regenerate thumbnails for all") button:text-is("Yes")', { timeout: 10000 })
      .catch(() => null);
    if (askAll) await askAll.click();
    await page.click('#thumbnail-progress-background', { timeout: 10000 }).catch(() => {});
    const inSidebar = await page.waitForSelector('.jp-sidebar .jp-jobs #render-progress-container', { timeout: 10000 }).then(
      () => true,
      () => false
    );
    const finishedNote = await page
      .waitForSelector('dialog[id^="browser-message-"][open]:has-text("Thumbnail generation finished") button', { timeout: 120000 })
      .catch(() => null);
    if (finishedNote) await finishedNote.click();
    check(
      'a background job shows in the sidebar and reports when it is done',
      !!askAll && inSidebar && !!finishedNote && !(await page.isVisible('#render-progress-container'))
    );
    // Scan Directory: the server indexes, the new model is offered, and its thumbnail is rendered.
    const scanDir = fs.mkdtempSync('/tmp/justtprint-e2e-scan-');
    const scannedModel = path.join(fs.realpathSync(scanDir), 'scanned-cube.stl');
    fs.copyFileSync(cubePath, scannedModel);
    await runSetting('Scan a Folder');
    await page.waitForSelector('dialog.jp-folder-picker[open]', { timeout: 10000 }).catch(() => {});
    await page.fill('#folder-picker-path', scanDir);
    await page.press('#folder-picker-path', 'Enter');
    await page.waitForFunction((dir) => document.getElementById('folder-picker-path')?.value === dir, scanDir, { timeout: 10000 }).catch(() => {});
    await page.click('#folder-picker-choose');
    // The scan notice (src/web/scan/ScanToast.tsx) says how it went and offers the new model.
    const offer = await page
      .waitForSelector('[data-testid="scan-toast"][data-state="done"]:has-text("Scan finished: 1 new model") button:text-is("Show Them")', { timeout: 60000 })
      .catch(() => null);
    check('a scan says when it is done and how many models are new', !!offer);
    if (offer) await offer.click();
    const shownNew = await page
      .waitForFunction(
        (p) => {
          const shown = [...document.querySelectorAll('.file-grid [data-filepath]')].map((el) => el.getAttribute('data-filepath'));
          return shown.length === 1 && shown[0].endsWith(p);
        },
        path.basename(scannedModel),
        { timeout: 15000 }
      )
      .then(
        () => true,
        () => false
      );
    const scannedThumb = await waitFor(
      async () => {
        const models = (await invoke(base, session, 'get-all-models')).result || [];
        const model = models.find((m) => m.filePath.endsWith('scanned-cube.stl'));
        return model && (await storedThumb(model.filePath)).startsWith('data:image') ? true : null;
      },
      120000,
      'scanned thumbnail'
    ).catch(() => false);
    check('Scan Directory adds the new model, offers to show it, and its thumbnail is rendered', !!offer && shownNew && scannedThumb === true);
    fs.rmSync(scanDir, { recursive: true, force: true });
    await page.evaluate(async () => {
      window.clearAllLibraryFilters?.();
      await window.performCombinedSearch({ force: true });
    });

    // Scan Library in the sidebar: busy while it runs, then the notice says how it went. STL Home is
    // a folder outside the app for this (the e2e library is inside it, and web scans of it are refused).
    const homeDir = fs.realpathSync(fs.mkdtempSync('/tmp/justtprint-e2e-home-'));
    fs.copyFileSync(cubePath, path.join(homeDir, 'home-cube.stl'));
    const settingBefore = async (key) => (await invoke(base, session, 'get-setting', [key])).result;
    const homeSettings = {};
    for (const key of ['stlHomeDirectories', 'stlHome', 'directoryPath', 'scannedDirectories']) homeSettings[key] = await settingBefore(key);
    await invoke(base, session, 'save-setting', ['stlHomeDirectories', JSON.stringify([homeDir])]);
    await invoke(base, session, 'save-setting', ['stlHome', homeDir]);
    await page.click('[data-testid="scan-toast"] .jp-undo-toast__close').catch(() => {});
    // The scan above starts a thumbnail job whose "finished" message can open at any moment and
    // blocks the page: answer any open message, then click (again, if a message came in between).
    let scanClicked = false;
    for (let attempt = 0; attempt < 5 && !scanClicked; attempt++) {
      for (const button of await page.$$('dialog[id^="browser-message-"][open] button')) await button.click().catch(() => {});
      scanClicked = await page.click('.jp-sidebar .jp-nav__row:has-text("Scan Library")', { timeout: 3000 }).then(
        () => true,
        () => false
      );
    }
    const scanDone = await page
      .waitForSelector('[data-testid="scan-toast"][data-state="done"]:has-text("Scan finished: 1 new model")', { timeout: 60000 })
      .then(
        () => true,
        () => false
      );
    check(
      'Scan Library says when the scan is done and how many models are new',
      scanClicked && scanDone && !(await page.isDisabled('.jp-sidebar .jp-nav__row:has-text("Scan Library")')),
      await page.textContent('[data-testid="scan-toast"]').catch(() => '')
    );
    // Its thumbnail is drawn from the file: wait until it is saved, so the folder is not deleted under it.
    await waitFor(
      async () =>
        JSON.stringify((await invoke(base, session, 'get-all-thumbnails', [path.join(homeDir, 'home-cube.stl')])).result || '').includes('data:image'),
      90000,
      "the scanned model's thumbnail"
    ).catch(() => {});
    await page.waitForTimeout(1000);
    // Put STL Home back and drop the model of the folder (scanning the deleted folder).
    for (const [key, value] of Object.entries(homeSettings)) await invoke(base, session, 'save-setting', [key, value ?? '']);
    fs.rmSync(homeDir, { recursive: true, force: true });
    if (DOCKER_IMAGE) await sleep(1500);
    await invoke(base, session, 'scan-directory', [homeDir]);
    await invoke(base, session, 'save-setting', ['scannedDirectories', homeSettings.scannedDirectories ?? '[]']);
    for (const button of await page.$$('dialog[id^="browser-message-"][open] button')) await button.click().catch(() => {});

    // Purge Models (React). Empties the library, so it runs last among the library checks.
    // A late message from the scan or thumbnail jobs above (slow machines) would cover the
    // dialog: wait a moment, then note and answer any that is open.
    const dismissStrayMessages = async () => {
      await page.waitForTimeout(1000);
      const strays = await page.evaluate(() =>
        [...document.querySelectorAll('dialog.jp-message-dialog[open]')].map((dialog) => {
          const text = dialog.textContent.replace(/\s+/g, ' ').trim().slice(0, 160);
          [...dialog.querySelectorAll('button')].pop()?.click();
          return text;
        })
      );
      if (strays.length) console.log(`note: answered a late message before Purge Models: ${strays.join(' | ')}`);
    };
    await dismissStrayMessages();
    await page.evaluate(() => window.openPurgeModels());
    check('Purge Models opens', await page.isVisible('#purge-models-dialog'));
    await dismissStrayMessages();
    await page.click('#cancel-purge-button');
    check('Cancel keeps the models', ((await invoke(base, session, 'get-stats')).result || {}).totalModels > 0);
    await page.evaluate(() => window.openPurgeModels());
    await dismissStrayMessages();
    await page.click('#confirm-purge-button');
    const purged = await page
      .waitForSelector('dialog[open]:has-text("All models have been purged") button:text-is("OK")', { timeout: 15000 })
      .catch(() => null);
    if (purged) await purged.click();
    check(
      'Purge Models empties the library and the grid',
      !!purged &&
        ((await invoke(base, session, 'get-stats')).result || {}).totalModels === 0 &&
        (await page.$$('.file-grid [data-filepath], .file-grid [data-file-path]')).length === 0
    );

    await page.evaluate(() => window.openServerAccess());
    check('JusttPrint Backend Access dialog opens', await page.isVisible('#server-access-dialog'));
    const shownToken = await page
      .waitForFunction(() => document.getElementById('server-access-api-token')?.value, null, { timeout: 10000 })
      .then((handle) => handle.jsonValue())
      .catch(() => '');
    check('API token shown', String(shownToken).startsWith('pv_'), shownToken);
    // The e2e server's password comes from JUSTTPRINT_PASSWORD, so the dialog says where it is set.
    check('password set by environment: JusttPrint Backend Access says so', await page.isVisible('#server-access-dialog :text("JUSTTPRINT_PASSWORD")'));
    await page.click('#close-server-access');
    check('Close closes JusttPrint Backend Access', !(await page.isVisible('#server-access-dialog')));
    await page.evaluate(() => window.openServerAccess());
    check('JusttPrint Backend Access reopens', await page.isVisible('#server-access-dialog'));
    await page.keyboard.press('Escape');

    await page.evaluate(() => window.logOutOfServer());
    await page.waitForURL(/\/login/, { timeout: 15000 }).catch(() => {});
    check('Log Out returns to login', page.url().includes('/login'));

    check('no failed requests', badResponses.length === 0, badResponses.slice(0, 5).join(' | '));
    check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
  }
}

/** Log in through the API as a user; returns { cookie, origin } for invoke(), or null. */
async function loginAs(base, username, password) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username, password })
  });
  if (!response.ok) return null;
  return { cookie: (response.headers.get('set-cookie') || '').split(';')[0], origin: base };
}

/** POST /api/upload as a session; resolves to { status, ...body }. */
async function uploadAs(base, session, folder, name, body) {
  const response = await fetch(`${base}/api/upload?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { origin: base, cookie: session.cookie, 'content-type': 'application/octet-stream' },
    body
  });
  return { status: response.status, ...(await response.json().catch(() => ({}))) };
}

/**
 * Model folders (src/server/model-folders.js): a folder per model with image, video and document
 * subfolders, the media route, site-free parts of saving, and Tidy Into Model Folders.
 */
async function modelFolderChecks(base, { admin, editor, viewer }, cubeBytes) {
  console.log('\n# Model folders');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  check('viewers cannot make model folders', (await invoke(base, viewer, 'make-model-folder', [uploadLibrary, 'Nope'])).status === 403);
  const made = (await invoke(base, editor, 'make-model-folder', [uploadLibrary, 'E2E Robot: Mk/2'])).result || {};
  const robot = made.folder || '';
  check(
    'an editor makes a model folder named after the model',
    robot === path.join(uploadLibrary, 'E2E Robot Mk 2') && fs.existsSync(robot),
    JSON.stringify(made)
  );
  const model = await uploadAs(base, editor, robot, 'Robot.stl', cubeBytes);
  const picture = await uploadAs(base, editor, path.join(robot, 'image'), 'Front view.png', png);
  const guide = await uploadAs(base, editor, path.join(robot, 'document'), 'Guide.md', '# Guide\n\n<script>x</script>');
  check(
    'pictures and documents upload into their subfolders',
    model.status === 200 && picture.status === 200 && guide.status === 200 && fs.existsSync(path.join(robot, 'image', 'Front view.png')),
    JSON.stringify([model, picture, guide])
  );
  check('a subfolder takes only its kind', (await uploadAs(base, editor, path.join(robot, 'image'), 'Guide.pdf', '%PDF')).status === 400);
  check('pictures are not uploaded into a plain folder', (await uploadAs(base, editor, uploadLibrary, 'loose.png', png)).status === 400);
  check(
    'only a model folder gets media subfolders',
    (await uploadAs(base, editor, path.join(uploadLibrary, 'image'), 'x.png', png)).status === 400 && !fs.existsSync(path.join(uploadLibrary, 'image'))
  );
  const added = (await invoke(base, editor, 'add-uploaded-files', [robot, [model.filePath, picture.filePath, guide.filePath]])).result || {};
  check('the upload counts its pictures and documents', added.inLibrary === 3 && added.media === 2, JSON.stringify(added));
  const inFolder = (await invoke(base, viewer, 'get-folder-models', [model.filePath])).result || [];
  check('pictures and documents are not models of their own', inFolder.length === 1, JSON.stringify(inFolder.map((m) => m.fileName)));
  let media = (await invoke(base, viewer, 'get-model-media', [robot])).result || {};
  check(
    'viewers see a model folder with its cover, pictures and documents',
    media.isModelFolder && media.cover === 'Front view.png' && media.image?.length === 1 && media.document?.[0]?.name === 'Guide.md',
    JSON.stringify(media)
  );
  const thumb = ((await invoke(base, viewer, 'get-model', [model.filePath])).result || {}).thumbnail || '';
  check('the cover is the first thumbnail', thumb.startsWith('data:image/'), thumb.slice(0, 40));
  // The model page: without a Title, its title is the model folder's name; each file shows its own picture, not the cover.
  const asPage = (await invoke(base, viewer, 'get-model', [model.filePath])).result || {};
  check(
    'a model in a model folder is titled after the folder',
    asPage.pageTitle === 'E2E Robot Mk 2' && asPage.modelFolder === robot,
    JSON.stringify({ pageTitle: asPage.pageTitle })
  );
  const fileCards = (await invoke(base, viewer, 'get-folder-models', [model.filePath])).result || [];
  check(
    'file cards never show the cover photo',
    fileCards.length === 1 && fileCards[0].image !== thumb.split('::')[0],
    String(fileCards[0]?.image).slice(0, 40)
  );
  // A description, apart from your notes.
  const full = (await invoke(base, editor, 'get-model', [model.filePath])).result || {};
  await invoke(base, editor, 'save-model', [{ ...full, description: 'A robot arm with five joints.', notes: 'Print in PETG.' }]);
  const described = (await invoke(base, viewer, 'get-model', [model.filePath])).result || {};
  check(
    'a description is kept apart from the notes',
    described.description === 'A robot arm with five joints.' && described.notes === 'Print in PETG.',
    JSON.stringify({ description: described.description, notes: described.notes })
  );

  const mediaUrl = (filePath, query = '') => `${base}/api/media/${encodeURIComponent(filePath)}${query}`;
  const shown = await fetch(mediaUrl(picture.filePath), { headers: { cookie: viewer.cookie } });
  check('a picture is shown to viewers', shown.status === 200 && shown.headers.get('content-type') === 'image/png');
  const part = await fetch(mediaUrl(picture.filePath), { headers: { cookie: viewer.cookie, range: 'bytes=0-3' } });
  check('media are sent in ranges (videos seek)', part.status === 206 && /^bytes 0-3\//.test(part.headers.get('content-range') || ''));
  const doc = await fetch(mediaUrl(guide.filePath), { headers: { cookie: viewer.cookie } });
  check(
    'documents run nothing (a sandbox)',
    /sandbox/.test(doc.headers.get('content-security-policy') || '') && doc.headers.get('x-content-type-options') === 'nosniff'
  );
  const saved = await fetch(mediaUrl(guide.filePath, '?download=1'), { headers: { cookie: viewer.cookie } });
  check('documents download', /attachment/.test(saved.headers.get('content-disposition') || ''));
  check('the media route serves only model folder media', (await fetch(mediaUrl(model.filePath), { headers: { cookie: viewer.cookie } })).status === 404);
  check('the media route needs a login', (await fetch(mediaUrl(picture.filePath))).status === 401);

  check('viewers cannot choose the cover', (await invoke(base, viewer, 'set-model-cover', [robot, null])).status === 403);
  media = (await invoke(base, editor, 'add-model-youtube', [robot, ['https://youtu.be/dQw4w9WgXcQ']])).result || {};
  check('a YouTube video is kept as a link', media.youtube?.[0]?.id === 'dQw4w9WgXcQ', JSON.stringify(media.youtube));
  check('only YouTube links', (await invoke(base, editor, 'add-model-youtube', [robot, ['https://example.com/v']])).status === 500);
  media = (await invoke(base, editor, 'remove-model-media', [robot, 'document', 'Guide.md'])).result || {};
  check('a document is removed (to the Trash)', media.document?.length === 0 && !fs.existsSync(guide.filePath), JSON.stringify(media.document));
  check('removing outside a model folder is refused', (await invoke(base, editor, 'remove-model-media', [uploadLibrary, 'image', 'x.png'])).status !== 200);

  // Tidy Into Model Folders: loose models get folders of their own.
  const loose = path.join(uploadLibrary, 'Loose');
  fs.mkdirSync(loose, { recursive: true });
  for (const name of ['Gear.stl', 'Wheel.stl']) await uploadAs(base, editor, loose, name, cubeBytes);
  fs.writeFileSync(path.join(loose, 'Gear.png'), png);
  await invoke(base, editor, 'add-uploaded-files', [loose, [path.join(loose, 'Gear.stl'), path.join(loose, 'Wheel.stl')]]);
  check('only admins tidy', (await invoke(base, editor, 'tidy-model-folders-preview', [loose])).status === 403);
  const tidyPreview = (await invoke(base, admin, 'tidy-model-folders-preview', [loose])).result || {};
  check('the tidy preview lists the moves', tidyPreview.moveCount === 2 && fs.existsSync(path.join(loose, 'Gear.stl')), JSON.stringify(tidyPreview));
  const tidied = (await invoke(base, admin, 'tidy-model-folders', [loose, null, false])).result || {};
  check(
    'tidying moves each model into its folder, its picture along',
    tidied.moved === 2 && fs.existsSync(path.join(loose, 'Gear', 'Gear.stl')) && fs.existsSync(path.join(loose, 'Gear', 'image', 'Gear.png')),
    JSON.stringify(tidied)
  );
  check('the moved model keeps its record', !!(await invoke(base, viewer, 'get-model', [path.join(loose, 'Wheel', 'Wheel.stl')])).result);

  // An uploaded ZIP is one model, the archive itself (8.6): never unpacked, nothing listed from inside it.
  const { zipSync } = require('fflate');
  const kitDir = path.join(uploadLibrary, 'E2E Kit');
  fs.mkdirSync(kitDir, { recursive: true });
  const kitZip = Buffer.from(zipSync({ 'arm/upper.stl': new Uint8Array(cubeBytes) }));
  const sentKit = await uploadAs(base, editor, kitDir, 'Kit.zip', kitZip);
  const addedKit = (await invoke(base, editor, 'add-uploaded-files', [kitDir, [sentKit.filePath]])).result || {};
  check(
    'an uploaded ZIP is one model in the library, the archive itself',
    sentKit.status === 200 &&
      fs.existsSync(path.join(kitDir, 'Kit.zip')) &&
      !fs.existsSync(path.join(kitDir, 'Kit')) &&
      !fs.existsSync(path.join(kitDir, 'archives')) &&
      addedKit.inLibrary === 1 &&
      !!(await invoke(base, viewer, 'get-model', [path.join(kitDir, 'Kit.zip')])).result &&
      !(await invoke(base, viewer, 'get-model', [`${path.join(kitDir, 'Kit.zip')}::arm/upper.stl`])).result,
    JSON.stringify(addedKit)
  );
  // RAR and 7Z are uploaded too, each one model (never unpacked).
  const sentRar = await uploadAs(base, editor, kitDir, 'Kit.rar', 'x');
  const addedRar = (await invoke(base, editor, 'add-uploaded-files', [kitDir, [sentRar.filePath]])).result || {};
  check(
    'RAR and 7Z files are uploaded, each one model in the library',
    sentRar.status === 200 &&
      fs.existsSync(path.join(kitDir, 'Kit.rar')) &&
      addedRar.inLibrary === 1 &&
      !(addedRar.notAdded || []).length &&
      !!(await invoke(base, viewer, 'get-model', [path.join(kitDir, 'Kit.rar')])).result,
    JSON.stringify(addedRar)
  );

  // The Upload folder and Organize Uploads (src/server/upload-inbox.js): uploads wait there, then
  // each moves to Destination/Category/Subcategory/Model name.
  const inboxDir = path.join(uploadLibrary, 'Inbox');
  const sortedDir = path.join(uploadLibrary, 'Sorted');
  check('only admins choose the Upload folder', (await invoke(base, editor, 'save-upload-folder', [inboxDir, sortedDir])).status === 403);
  const chosen = (await invoke(base, admin, 'save-upload-folder', [inboxDir, sortedDir])).result || {};
  check(
    'the Upload folder is made and saved',
    chosen.uploadFolder === inboxDir && chosen.destination === sortedDir && fs.existsSync(inboxDir),
    JSON.stringify(chosen)
  );
  check(
    'the destination may not be inside the Upload folder',
    (await invoke(base, admin, 'save-upload-folder', [inboxDir, path.join(inboxDir, 'x')])).status !== 200
  );
  const dragonDir = (await invoke(base, editor, 'make-model-folder', [inboxDir, 'Dragon Skull'])).result?.folder || '';
  const sentDragon = await uploadAs(base, editor, dragonDir, 'skull.stl', cubeBytes);
  await invoke(base, editor, 'add-uploaded-files', [dragonDir, [sentDragon.filePath]]);
  fs.writeFileSync(path.join(dragonDir, 'photo.png'), png);
  const sentGear = await uploadAs(base, editor, inboxDir, 'Gear Box.stl', cubeBytes);
  await invoke(base, editor, 'add-uploaded-files', [inboxDir, [sentGear.filePath]]);
  // A model with a Title (one with a file extension, as 3MFs sometimes have): its folder and file take it, without the extension.
  const sentShip = await uploadAs(base, editor, inboxDir, 'spaceship_v3_final.stl', cubeBytes);
  await invoke(base, editor, 'add-uploaded-files', [inboxDir, [sentShip.filePath]]);
  await invoke(base, editor, 'update-models-batch', [[{ filePath: sentShip.filePath, title: 'Space Ship.3mf' }]]);
  const waiting = (await invoke(base, viewer, 'get-upload-folder')).result || {};
  check('uploads in the Upload folder wait, not organized', waiting.waiting === 3, JSON.stringify(waiting));
  const attention = (await invoke(base, editor, 'get-library-attention')).result || {};
  check('Home lists the models not organized', attention.unorganized === 3, JSON.stringify(attention.unorganized));
  check('viewers cannot organize', (await invoke(base, viewer, 'organize-uploads')).status === 403);
  // With a stand-in AI service (custom, as earlier): every answer is a tag and Toys & Games › Puzzles.
  // Organize tags first (step 2), so the first question comes while the uploads are still in the Upload folder.
  const organizeAiKeys = ['aiService', 'apiEndpoint', 'aiModel', 'aiTagAllowRetagging'];
  const organizeAiBefore = {};
  for (const key of organizeAiKeys) organizeAiBefore[key] = (await invoke(base, admin, 'get-setting', [key])).result;
  const asked = [];
  const organizeAi = require('http').createServer((req, res) => {
    req.resume();
    asked.push({ uploadsStillWaiting: fs.existsSync(dragonDir) });
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: 'e2e',
        object: 'chat.completion',
        created: 0,
        model: 'e2e',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: '{"tags":["e2e-organized"],"category":"Toys & Games > Puzzles"}' }
          }
        ]
      })
    );
  });
  await new Promise((resolve) => organizeAi.listen(0, DOCKER_IMAGE ? '0.0.0.0' : '127.0.0.1', resolve));
  for (const [key, value] of [
    ['aiService', 'custom'],
    ['apiEndpoint', `http://${HOST_FOR_SERVER}:${organizeAi.address().port}/v1`],
    ['aiModel', 'e2e'],
    ['aiTagAllowRetagging', '1']
  ]) {
    await invoke(base, admin, 'save-setting', [key, value]);
  }
  check('editors organize', !!(await invoke(base, editor, 'organize-uploads')).result?.running);
  const run = await waitFor(
    async () => {
      const current = (await invoke(base, viewer, 'get-organize-uploads')).result;
      return current && !current.running ? current : null;
    },
    120000,
    'Organize'
  );
  organizeAi.close();
  for (const key of organizeAiKeys) await invoke(base, admin, 'save-setting', [key, organizeAiBefore[key] == null ? '' : organizeAiBefore[key]]);
  check(
    'Organize tags first, before it chooses categories and moves (the uploads were still waiting)',
    asked.length > 0 && asked[0].uploadsStillWaiting && run.tagged === 3,
    JSON.stringify({ asked: asked.length, first: asked[0], tagged: run.tagged, warning: run.warning })
  );
  const dragonTo = (run.moved || []).find((m) => m.name === 'Dragon Skull');
  const gearTo = (run.moved || []).find((m) => m.name === 'Gear Box.stl');
  check(
    'Organize moves each upload to Category/Subcategory/Model name',
    run.movedCount === 3 &&
      !!dragonTo &&
      dragonTo.to === path.join(sortedDir, dragonTo.category, dragonTo.subcategory, 'Dragon Skull') &&
      fs.existsSync(path.join(dragonTo.to, 'skull.stl')) &&
      !fs.existsSync(dragonDir),
    JSON.stringify(run)
  );
  check(
    'a loose model file gets a folder of its own, named after it',
    !!gearTo && path.basename(gearTo.to) === 'Gear Box' && fs.existsSync(path.join(gearTo.to, 'Gear Box.stl')),
    JSON.stringify(gearTo)
  );
  const shipTo = (run.moved || []).find((m) => m.name === 'spaceship_v3_final.stl');
  check(
    "a model's folder and file are named after its Title, without the extension",
    !!shipTo && path.basename(shipTo.to) === 'Space Ship' && fs.readdirSync(shipTo.to).includes('Space Ship.stl') && run.renamed >= 1,
    JSON.stringify({ to: shipTo && shipTo.to, files: shipTo && fs.existsSync(shipTo.to) ? fs.readdirSync(shipTo.to) : null, renamed: run.renamed })
  );
  const dragonModel = (await invoke(base, viewer, 'get-model', [path.join(dragonTo?.to || '', 'skull.stl')])).result || {};
  check(
    "the AI's tags are applied and its category is the model's place",
    !!dragonTo &&
      dragonTo.category === 'Toys & Games' &&
      dragonTo.subcategory === 'Puzzles' &&
      (dragonModel.tags || []).includes('e2e-organized') &&
      (dragonModel.tags || []).includes('AI Tagged'),
    JSON.stringify({ category: dragonTo && dragonTo.category, subcategory: dragonTo && dragonTo.subcategory, tags: dragonModel.tags })
  );
  check('its loose pictures become the model folder’s own', !!dragonTo && fs.existsSync(path.join(dragonTo.to, 'image', 'photo.png')));
  const movedModel = (await invoke(base, viewer, 'get-model', [path.join(dragonTo?.to || '', 'skull.stl')])).result;
  check('the moved model keeps its record and has its place', !!movedModel, JSON.stringify(movedModel && movedModel.filePath));
  check('nothing waits any more', (await invoke(base, viewer, 'get-upload-folder')).result?.waiting === 0);
  // The Upload folder off again, so the checks after these see the library as before.
  await invoke(base, admin, 'save-upload-folder', ['', '']);

  // MCP: categories, Categorize Library and renaming (mcp-tools.js), on the model Organize just moved.
  const mcpToken = (await invoke(base, admin, 'get-server-access-info')).result?.apiToken;
  const mcpCall = async (name, args = {}) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    });
    const body = await res.json().catch(() => ({}));
    const text = body.result?.content?.[0]?.text || '';
    let value = null;
    try {
      value = JSON.parse(text);
    } catch (_) {
      /* an error message */
    }
    return { error: !!body.result?.isError, text, value };
  };
  const gearFile = gearTo ? path.join(gearTo.to, 'Gear Box.stl') : '';
  const listed = await mcpCall('list_categories');
  const toys = (listed.value?.categories || []).find((c) => c.name === 'Toys & Games');
  check('MCP lists the categories with their subcategories', !!toys && toys.subcategories.some((s) => s.name === 'Puzzles'), listed.text.slice(0, 200));
  const placed = await mcpCall('set_model_category', { filePath: gearFile, category: 'Puzzles' });
  check(
    'MCP gives a model its category',
    placed.value?.models?.[0]?.subcategory === 'Puzzles' && placed.value.models[0].category === 'Toys & Games',
    placed.text.slice(0, 200)
  );
  check('MCP refuses a category that is not on the list', (await mcpCall('set_model_category', { filePath: gearFile, category: 'Spaceships' })).error);
  const renamed = await mcpCall('rename_model', { filePath: gearFile, name: 'Gear Box Mk 2' });
  check(
    'MCP renames a model and its file (and its own folder)',
    !!renamed.value?.filePath &&
      path.basename(renamed.value.filePath) === 'Gear Box Mk 2.stl' &&
      fs.existsSync(renamed.value.filePath) &&
      !fs.existsSync(gearFile),
    renamed.text.slice(0, 200)
  );
  const categorized = await mcpCall('categorize_library', { wait: true });
  check('MCP runs Categorize Library', categorized.value?.done === true && categorized.value.job?.running === false, categorized.text.slice(0, 200));
  check('MCP follows Categorize Library', (await mcpCall('get_categorize_status')).value?.job?.id === categorized.value?.job?.id);
  // Puter answers only through a signed-in browser: the AI step is refused, nothing starts.
  const aiServiceBefore = (await invoke(base, admin, 'get-setting', ['aiService'])).result;
  await invoke(base, admin, 'save-setting', ['aiService', 'puter']);
  const puterRun = await mcpCall('categorize_library', { useAi: true });
  await invoke(base, admin, 'save-setting', ['aiService', aiServiceBefore || '']);
  check('MCP leaves the AI out when it is Puter (it needs a browser)', puterRun.error && /Puter/.test(puterRun.text), puterRun.text.slice(0, 200));

  // Multi-edit's Delete (src/server/delete-models.js): from the library the files move to a trash folder no scan looks in; from disk they are deleted.
  const deleteDir = path.join(uploadLibrary, 'E2E Delete');
  fs.mkdirSync(deleteDir, { recursive: true });
  const toLibraryTrash = await uploadAs(base, editor, deleteDir, 'Keep File.stl', cubeBytes);
  const toDisk = await uploadAs(base, editor, deleteDir, 'Gone File.stl', cubeBytes);
  await invoke(base, editor, 'add-uploaded-files', [deleteDir, [toLibraryTrash.filePath, toDisk.filePath]]);
  check('viewers cannot delete models', (await invoke(base, viewer, 'delete-models', [[toLibraryTrash.filePath], 'library'])).status === 403);
  const fromLibrary = (await invoke(base, editor, 'delete-models', [[toLibraryTrash.filePath], 'library'])).result || {};
  const trashed = path.join(uploadLibrary, '.JusttPrint Trash', 'E2E Delete', 'Keep File.stl');
  check(
    'Delete from Library keeps the file in a trash folder that is not scanned, and the model leaves the library',
    fromLibrary.removed === 1 &&
      fs.existsSync(trashed) &&
      !fs.existsSync(toLibraryTrash.filePath) &&
      !(await invoke(base, viewer, 'get-model', [toLibraryTrash.filePath])).result,
    JSON.stringify(fromLibrary)
  );
  await invoke(base, admin, 'scan-directory', [uploadLibrary]);
  check('a scan does not bring it back', !(await invoke(base, viewer, 'get-model', [trashed])).result);
  check(
    'editors cannot delete models from disk until an admin allows it',
    /admins and the editors allowed/.test((await invoke(base, editor, 'delete-models', [[toDisk.filePath], 'disk'])).error || '') &&
      fs.existsSync(toDisk.filePath)
  );
  const fromDisk = (await invoke(base, admin, 'delete-models', [[toDisk.filePath], 'disk'])).result || {};
  check(
    'Delete from Disk deletes the file for good',
    fromDisk.removed === 1 && !fs.existsSync(toDisk.filePath) && !fs.existsSync(path.join(uploadLibrary, '.JusttPrint Trash', 'E2E Delete', 'Gone File.stl')),
    JSON.stringify(fromDisk)
  );
}

/**
 * User accounts, roles, uploads and the Statistics page. Runs after the browser checks, which end
 * with an empty library (Purge Models), so the uploads here do not change the counts above.
 */
async function accountChecks(base, wsUrl, admin) {
  console.log('\n# User accounts and roles');
  const status = await (await fetch(`${base}/api/auth/status`, { headers: { cookie: admin.cookie } })).json();
  check(
    'the JUSTTPRINT_PASSWORD login is the admin account',
    status.user && status.user.username === 'admin' && status.user.role === 'admin',
    JSON.stringify(status)
  );
  check(
    'an admin adds an editor',
    (await invoke(base, admin, 'create-user', [{ username: 'maker', password: 'maker-password', role: 'editor' }])).status === 200
  );
  check('an admin adds a viewer', (await invoke(base, admin, 'create-user', [{ username: 'kid', password: 'kid-password', role: 'viewer' }])).status === 200);
  check(
    'user names are unique (any case)',
    /already a user/.test((await invoke(base, admin, 'create-user', [{ username: 'KID', password: 'kid-password', role: 'viewer' }])).error || '')
  );
  check('wrong user name refused', (await loginAs(base, 'nobody', 'kid-password')) === null);
  const editor = await loginAs(base, 'maker', 'maker-password');
  const viewer = await loginAs(base, 'kid', 'kid-password');
  check('editor and viewer log in', !!editor && !!viewer);
  check(
    'viewers do not see editor notifications, and guests none',
    !((await invoke(base, viewer, 'get-notifications', [null])).result?.items || []).some((item) => /Same-geometry/.test(item.title)) &&
      ((await invoke(base, editor, 'get-notifications', [null])).result?.items || []).some((item) => /Same-geometry/.test(item.title))
  );
  check(
    'viewers cannot undo Metadata Editor changes',
    (await invoke(base, viewer, 'restore-metadata', [{ type: 'designer', name: 'x', current: '', modelIds: [1] }])).status === 403
  );
  // Deleting files from disk: admins, and editors an admin allows (users.js canDeleteFiles).
  const notAFile = path.join(LIBRARY, 'no-such-e2e-model.stl');
  check(
    'editors cannot delete files from disk until an admin allows it',
    (await invoke(base, editor, 'delete-file', [notAFile])).status === 403 && (await invoke(base, editor, 'trash-file', [notAFile])).status === 403
  );
  const makerId = ((await invoke(base, admin, 'list-users')).result?.users || []).find((u) => u.username === 'maker')?.id;
  await invoke(base, admin, 'update-user', [makerId, { canDeleteFiles: true }]);
  const allowedStatus = (await invoke(base, editor, 'delete-file', [notAFile])).status;
  check('an editor an admin allows may delete files from disk', allowedStatus !== 403, String(allowedStatus));
  await invoke(base, admin, 'update-user', [makerId, { canDeleteFiles: false }]);
  const users = (await invoke(base, admin, 'list-users')).result || {};
  check(
    'the user list has all three, without password hashes',
    users.users?.length === 3 && !JSON.stringify(users).includes('scrypt'),
    JSON.stringify(users).slice(0, 200)
  );
  check('viewers read the library', (await invoke(base, viewer, 'get-library-counts')).status === 200);
  const viewerEdit = await invoke(base, viewer, 'save-tag', ['nope']);
  check('viewers cannot edit', viewerEdit.status === 403 && /Viewer accounts cannot do this/.test(viewerEdit.error || ''), JSON.stringify(viewerEdit));
  check('editors edit the library', (await invoke(base, editor, 'save-tag', ['from-editor'])).status === 200);
  check('editors cannot change settings', /Only an admin/.test((await invoke(base, editor, 'save-setting', ['stlHomeDirectories', '[]'])).error || ''));
  check('editors may save display preferences', (await invoke(base, editor, 'save-setting', ['gridView', 'true'])).result === true);
  check('editors cannot see the API token', (await invoke(base, editor, 'get-server-access-info')).status === 403);
  check('editors cannot manage users', (await invoke(base, editor, 'list-users')).status === 403);
  check(
    'viewers cannot use MCP',
    (await fetch(`${base}/mcp`, { method: 'POST', headers: { origin: base, cookie: viewer.cookie, 'content-type': 'application/json' }, body: '{}' }))
      .status === 403
  );
  const viewerSocket = await openEvents(wsUrl, { cookie: viewer.cookie, origin: base });
  check('viewers get the event WebSocket', !!viewerSocket.hello);

  // Add Links: checking finds links already in the library (link-only models, and files whose source is the link).
  // Nothing here reaches the sites: links already in the library are answered without fetching.
  check(
    'viewers cannot add links',
    (await invoke(base, viewer, 'check-model-links', ['https://www.printables.com/model/3161'])).status === 403 &&
      (await invoke(base, viewer, 'import-model-link', ['https://www.printables.com/model/3161'])).status === 403
  );
  await invoke(base, admin, 'save-model', [
    { filePath: 'url::https://www.printables.com/model/3161', fileName: 'E2E Benchy', source: 'https://www.printables.com/model/3161' }
  ]);
  const linkCheck =
    (
      await invoke(base, editor, 'check-model-links', [
        'Benchy: https://www.printables.com/de/model/3161-3d-benchy/files\nhttps://www.thingiverse.com/thing:42 https://www.thingiverse.com/thing:42\nhttps://example.com/x'
      ])
    ).result || {};
  check(
    'Add Links finds the links in pasted text, once each',
    (linkCheck.links || []).map((l) => `${l.site}:${l.id}`).join() === 'printables:3161,thingiverse:42' &&
      (linkCheck.unsupported || []).join() === 'https://example.com/x',
    JSON.stringify(linkCheck)
  );
  check(
    'Add Links knows a link already in the library',
    linkCheck.links?.[0]?.existing?.fileName === 'E2E Benchy' && linkCheck.links?.[1]?.existing === null,
    JSON.stringify(linkCheck.links)
  );
  const again = (await invoke(base, editor, 'import-model-link', ['printables.com/model/3161'])).result || {};
  check(
    'adding a link already in the library adds nothing',
    again.status === 'exists' && again.filePath === 'url::https://www.printables.com/model/3161',
    JSON.stringify(again)
  );
  check(
    'only model links are added',
    /Not a Printables, Thingiverse or MakerWorld model link/.test(
      (await invoke(base, editor, 'import-model-link', ['http://127.0.0.1:5000/api/health'])).error || ''
    )
  );

  // MakerWorld: details for everyone; sign-in and downloads for editors. Nothing here reaches MakerWorld.
  check(
    'site details are only for MakerWorld, Printables and Thingiverse links',
    (await invoke(base, viewer, 'get-site-details', ['https://example.com/model/3161'])).result === null
  );
  check(
    'viewers cannot sign in to MakerWorld or download',
    (await invoke(base, viewer, 'makerworld-download', [{ url: 'https://makerworld.com/en/models/1' }])).status === 403 &&
      (await invoke(base, viewer, 'makerworld-sign-in', [{ account: 'x' }])).status === 403
  );
  check('MakerWorld starts signed out', (await invoke(base, editor, 'makerworld-account-status')).result?.signedIn === false);
  // Downloads go to the Upload folder (8.4): one is set for this check.
  const mwUpload = fs.realpathSync(fs.mkdtempSync('/tmp/justtprint-e2e-mw-'));
  await invoke(base, admin, 'save-upload-folder', [mwUpload, '']);
  const mwResponse = await invoke(base, editor, 'makerworld-download', [{ url: 'https://makerworld.com/en/models/1', files: ['a.stl'] }]);
  const mwDownload = mwResponse.result || { status: mwResponse.status, error: mwResponse.error };
  await invoke(base, admin, 'save-upload-folder', ['', '']);
  fs.rmSync(mwUpload, { recursive: true, force: true });
  check('a download without a MakerWorld sign-in asks for one', mwDownload.signIn === true, JSON.stringify(mwDownload));
  check(
    'viewers cannot list site files; only admins set the Thingiverse token',
    (await invoke(base, viewer, 'list-site-files', ['https://www.printables.com/model/1'])).status === 403 &&
      (await invoke(base, editor, 'set-thingiverse-token', ['x'])).status === 403 &&
      (await invoke(base, editor, 'thingiverse-token-status')).result?.hasToken === false &&
      (await invoke(base, admin, 'get-setting', ['thingiverseToken'])).result === null
  );
  const mwSave = await invoke(base, admin, 'save-setting', ['makerWorldAccount', '{"accessToken":"x"}']);
  check(
    'the MakerWorld sign-in cannot be read or set through settings',
    (await invoke(base, admin, 'get-setting', ['makerWorldAccount'])).result === null &&
      mwSave.result !== true &&
      (await invoke(base, editor, 'makerworld-account-status')).result?.signedIn === false,
    JSON.stringify(mwSave)
  );

  // Display preferences are each user's own; the server-wide value is the default.
  const adminView = (await invoke(base, admin, 'get-setting', ['sortOption'])).result;
  check(
    'a user saves their own sort order',
    (await invoke(base, viewer, 'save-setting', ['sortOption', 'name-desc'])).result === true &&
      (await invoke(base, viewer, 'get-setting', ['sortOption'])).result === 'name-desc'
  );
  check(
    'another user keeps theirs',
    (await invoke(base, admin, 'get-setting', ['sortOption'])).result === adminView &&
      (await invoke(base, editor, 'get-setting', ['sortOption'])).result !== 'name-desc'
  );
  check(
    'everyone picks their own color scheme',
    (await invoke(base, viewer, 'save-setting', ['uiTheme', 'modern-green'])).result === true &&
      (await invoke(base, editor, 'get-setting', ['uiTheme'])).result !== 'modern-green' &&
      (await invoke(base, viewer, 'save-setting', ['uiColorScheme', 'light'])).result === true &&
      (await invoke(base, editor, 'get-setting', ['uiColorScheme'])).result !== 'light'
  );
  check('thumbnail colors stay for admins', /Only an admin/.test((await invoke(base, editor, 'save-setting', ['renderColor', '#ff0000'])).error || ''));

  console.log('\n# Uploads');
  // A library folder outside the app folder (the e2e library is inside it, and the app folder is never a destination).
  uploadLibrary = fs.realpathSync(fs.mkdtempSync('/tmp/justtprint-e2e-uploads-'));
  const folder = path.join(uploadLibrary, 'Designer A');
  fs.mkdirSync(folder);
  check('the upload library is scanned', (await invoke(base, admin, 'scan-directory', [uploadLibrary])).status === 200);
  const cubeBytes = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'library', 'Designer A', 'cube.stl'));
  const info = (await invoke(base, editor, 'get-upload-info')).result || {};
  check('upload info lists the scanned types', Array.isArray(info.extensions) && info.extensions.includes('.stl') && info.maxBytes > 0, JSON.stringify(info));
  check('viewers cannot upload', (await uploadAs(base, viewer, folder, 'nope.stl', cubeBytes)).status === 403);
  const first = await uploadAs(base, editor, folder, 'Uploaded Cube.stl', cubeBytes);
  check(
    'an editor uploads into a library folder',
    first.status === 200 && first.fileName === 'Uploaded Cube.stl' && fs.existsSync(path.join(folder, 'Uploaded Cube.stl')),
    JSON.stringify(first)
  );
  const second = await uploadAs(base, editor, folder, 'Uploaded Cube.stl', cubeBytes);
  check('a taken name gets a number, nothing is replaced', second.fileName === 'Uploaded Cube (2).stl', JSON.stringify(second));
  check('uploads outside the library refused', (await uploadAs(base, editor, '/tmp', 'x.stl', cubeBytes)).status === 403);
  check('upload names with folders refused', (await uploadAs(base, editor, folder, '../x.stl', cubeBytes)).status === 400);
  check('types the library does not scan refused', (await uploadAs(base, editor, folder, 'page.html', '<b>hi</b>')).status === 400);
  check('no temp files are left behind', !fs.readdirSync(folder).some((name) => name.endsWith('.justtprint-upload')));
  const added = await invoke(base, editor, 'add-uploaded-files', [folder, [first.filePath, second.filePath]]);
  check('the uploaded files are in the library', added.status === 200 && added.result.inLibrary === 2, JSON.stringify(added));

  // In pieces (what the browser does): order, resume, owner, finish.
  const api = async (session, method, urlPath, body, contentType = 'application/json') => {
    const response = await fetch(base + urlPath, {
      method,
      headers: { origin: base, cookie: session.cookie, ...(body !== undefined ? { 'content-type': contentType } : {}) },
      body
    });
    return { status: response.status, ...(await response.json().catch(() => ({}))) };
  };
  const started = await api(editor, 'POST', '/api/upload/sessions', JSON.stringify({ folder, name: 'Pieces.stl', size: cubeBytes.length }));
  check(
    'an upload in pieces starts with the piece size',
    started.status === 200 && started.received === 0 && started.chunkBytes > 0 && started.chunkBytes < cubeBytes.length,
    JSON.stringify(started)
  );
  const piece = started.chunkBytes;
  const put = (session, offset, bytes) => api(session, 'PUT', `/api/upload/sessions/${started.id}?offset=${offset}`, bytes, 'application/octet-stream');
  check('the first piece arrives', (await put(editor, 0, cubeBytes.subarray(0, piece))).received === piece);
  const running = ((await invoke(base, viewer, 'get-background-activity')).result || []).find((job) => job.kind === 'upload');
  check(
    'an upload shows in what runs in the background',
    !!running && running.done === piece && running.total === cubeBytes.length && running.detail === 'Pieces.stl',
    JSON.stringify(running)
  );
  const wrong = await put(editor, 0, cubeBytes.subarray(0, piece));
  check('a piece at the wrong offset says where to continue', wrong.status === 409 && wrong.received === piece, JSON.stringify(wrong));
  check('another user cannot add to the upload', (await put(admin, piece, cubeBytes.subarray(piece, 2 * piece))).status === 403);
  check('viewers cannot start uploads', (await api(viewer, 'POST', '/api/upload/sessions', JSON.stringify({ folder, name: 'x.stl', size: 1 }))).status === 403);
  check('finishing early is refused', (await api(editor, 'POST', `/api/upload/sessions/${started.id}/finish`)).status === 409);
  check('the status says how far it got (to resume)', (await api(editor, 'GET', `/api/upload/sessions/${started.id}`)).received === piece);
  check(
    'the unfinished upload is a hidden temp file',
    fs.readdirSync(folder).some((name) => name.endsWith('.justtprint-upload')) && !fs.existsSync(path.join(folder, 'Pieces.stl'))
  );
  let offset = piece;
  while (offset < cubeBytes.length) offset = (await put(editor, offset, cubeBytes.subarray(offset, offset + piece))).received;
  const finished = await api(editor, 'POST', `/api/upload/sessions/${started.id}/finish`);
  check(
    'a finished upload leaves it',
    !((await invoke(base, viewer, 'get-background-activity')).result || []).some((job) => job.kind === 'upload' && job.detail === 'Pieces.stl')
  );
  check('the pieces make the file', finished.status === 200 && fs.readFileSync(path.join(folder, 'Pieces.stl')).equals(cubeBytes), JSON.stringify(finished));
  check('no temp file is left', !fs.readdirSync(folder).some((name) => name.endsWith('.justtprint-upload')));
  const cancelled = await api(editor, 'POST', '/api/upload/sessions', JSON.stringify({ folder, name: 'Cancelled.stl', size: 10 }));
  await api(editor, 'DELETE', `/api/upload/sessions/${cancelled.id}`);
  check(
    'a cancelled upload leaves nothing behind',
    (await api(editor, 'GET', `/api/upload/sessions/${cancelled.id}`)).status === 404 &&
      !fs.readdirSync(folder).some((name) => name.endsWith('.justtprint-upload'))
  );
  check(
    'too large for the limit is refused before sending',
    (await api(editor, 'POST', '/api/upload/sessions', JSON.stringify({ folder, name: 'huge.stl', size: 1e15 }))).status === 413
  );
  await invoke(base, editor, 'add-uploaded-files', [folder, [finished.filePath]]);

  await modelFolderChecks(base, { admin, editor, viewer }, cubeBytes);

  console.log('\n# Statistics');
  const uploadedPath = path.join(folder, 'Uploaded Cube.stl');
  await invoke(base, editor, 'log-print-event', [{ filePath: uploadedPath, outcome: 'printed', quantity: 3 }]);
  await invoke(base, editor, 'log-print-event', [{ filePath: uploadedPath, outcome: 'failed' }]);
  const stats = (await invoke(base, viewer, 'get-print-statistics', [{ months: 12 }])).result || {};
  check(
    'viewers read the statistics',
    stats.totals && stats.totals.printed === 3 && stats.totals.failed === 1 && stats.totals.successRate === 0.75,
    JSON.stringify(stats.totals)
  );
  check('the month of the prints is counted', stats.byMonth?.length === 12 && stats.byMonth[11].printed === 3, JSON.stringify(stats.byMonth?.[11]));
  check('the most printed model is listed', stats.models?.[0]?.fileName === 'Uploaded Cube.stl');

  console.log('\n# Collections and share links');
  const made = await invoke(base, editor, 'create-collection', [{ name: 'E2E Gifts', description: 'For <b>friends</b>' }]);
  check('an editor makes a collection', made.status === 200 && made.result.name === 'E2E Gifts', JSON.stringify(made));
  const giftId = made.result.id;
  check('viewers cannot make collections', (await invoke(base, viewer, 'create-collection', [{ name: 'Nope' }])).status === 403);
  check('collection names are unique', (await invoke(base, editor, 'create-collection', [{ name: 'e2e gifts' }])).status === 500);
  const added2 = await invoke(base, editor, 'add-to-collection', [giftId, [uploadedPath, finished.filePath]]);
  check('models are added to a collection', added2.result?.added === 2, JSON.stringify(added2));
  check('paths outside the library are refused', (await invoke(base, editor, 'add-to-collection', [giftId, ['/etc/passwd']])).status === 403);
  const viewed = (await invoke(base, viewer, 'get-collection', [giftId])).result || {};
  check('viewers see collections and their models', viewed.models?.length === 2 && viewed.description === 'For <b>friends</b>');
  check('viewers cannot make share links', (await invoke(base, viewer, 'create-share-link', [{ kind: 'collection', targetId: giftId }])).status === 403);
  const link = (await invoke(base, editor, 'create-share-link', [{ kind: 'collection', targetId: giftId, allowDownload: true }])).result || {};
  check('an editor makes a share link', /^[A-Za-z0-9_-]{24}$/.test(link.token || ''), JSON.stringify(link));
  const publicPage = await fetch(`${base}/s/${link.token}`);
  const publicHtml = await publicPage.text();
  check('the shared page opens without logging in', publicPage.status === 200 && publicHtml.includes('E2E Gifts') && publicHtml.includes('Uploaded Cube'));
  check(
    'the shared page escapes text and shows no paths',
    publicHtml.includes('&lt;b&gt;friends&lt;/b&gt;') &&
      !publicHtml.includes(uploadLibrary) &&
      (publicHtml.match(/<script/gi) || []).length === 1 &&
      publicHtml.includes('<script type="module" src="/share-viewer/share-viewer.js"></script>')
  );
  check(
    'the shared page is not indexed or cached',
    /noindex/.test(publicPage.headers.get('x-robots-tag') || '') && publicPage.headers.get('cache-control') === 'no-store'
  );
  const sharedId = viewed.models[0].id;
  const sharedFile = await fetch(`${base}/s/${link.token}/file/${sharedId}`);
  check('shared models download when allowed', sharedFile.status === 200 && (await sharedFile.arrayBuffer()).byteLength === cubeBytes.length);
  const otherId = (((await invoke(base, admin, 'get-all-models')).result || []).find((m) => !viewed.models.some((v) => v.id === m.id)) || {}).id;
  check(
    'a link reaches only its own models',
    !!otherId &&
      (await fetch(`${base}/s/${link.token}/file/${otherId}`)).status === 404 &&
      (await fetch(`${base}/s/${link.token}/thumb/${otherId}`)).status === 404
  );
  // The 3D view (src/web/share/viewer.ts): on links with downloads, and on view-only links that allow it.
  check('a link with downloads offers a 3D view', publicHtml.includes(`data-mesh="/s/${link.token}/mesh/${sharedId}"`));
  const sharedMesh = await fetch(`${base}/s/${link.token}/mesh/${sharedId}`);
  check(
    'the 3D view gets the STL without a login',
    sharedMesh.status === 200 &&
      (await sharedMesh.arrayBuffer()).byteLength === cubeBytes.length &&
      /^inline/.test(sharedMesh.headers.get('content-disposition') || '')
  );
  const viewerScript = await fetch(`${base}/share-viewer/share-viewer.js`);
  // three.js is a chunk with a fingerprint in its name (vite.config.mjs), imported by the viewer.
  const threeChunk = ((await viewerScript.clone().text()).match(/three-[A-Za-z0-9_-]+\.js/) || [])[0] || 'three-missing.js';
  check(
    "the 3D view's script loads without a login, and nothing else of the app",
    viewerScript.status === 200 &&
      /javascript/.test(viewerScript.headers.get('content-type') || '') &&
      (await fetch(`${base}/share-viewer/${threeChunk}`)).status === 200 &&
      (await fetch(`${base}/share-viewer/app.js`)).status === 404
  );
  const viewOnly = (await invoke(base, editor, 'create-share-link', [{ kind: 'model', filePath: uploadedPath, allowDownload: false }])).result || {};
  const viewOnlyHtml = await (await fetch(`${base}/s/${viewOnly.token}`)).text();
  check(
    'a view-only link offers no downloads',
    !viewOnlyHtml.includes('/file/') && (await fetch(`${base}/s/${viewOnly.token}/file/${viewOnly.targetId}`)).status === 404
  );
  check(
    'a view-only link has no 3D view unless asked for',
    !viewOnlyHtml.includes('view3d') && !/<script/i.test(viewOnlyHtml) && (await fetch(`${base}/s/${viewOnly.token}/mesh/${viewOnly.targetId}`)).status === 404
  );
  // A 3MF of its own (the library was emptied before these checks).
  const box = path.join(folder, 'Shared Box.3mf');
  await uploadAs(base, editor, folder, 'Shared Box.3mf', fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'library', 'Designer B', 'box.3mf')));
  await invoke(base, editor, 'add-uploaded-files', [folder, [box]]);
  const boxModel = (((await invoke(base, admin, 'get-all-models')).result || []).find((m) => m.filePath === box) || {}).id;
  const previewOnly =
    (await invoke(base, editor, 'create-share-link', [{ kind: 'model', filePath: box, allowDownload: false, allowPreview: true }])).result || {};
  const previewOnlyHtml = await (await fetch(`${base}/s/${previewOnly.token}`)).text();
  const boxMesh = await fetch(`${base}/s/${previewOnly.token}/mesh/${boxModel}`);
  const boxJson = boxMesh.status === 200 ? await boxMesh.json().catch(() => null) : null;
  check(
    'a view-only link with a 3D preview shows a 3MF in 3D, without downloads',
    previewOnly.allowPreview === true &&
      previewOnlyHtml.includes('data-kind="3mf"') &&
      !previewOnlyHtml.includes('/file/') &&
      !!boxJson &&
      Array.isArray(boxJson.geometries) &&
      boxJson.geometries.length > 0,
    `${boxMesh.status} ${JSON.stringify(boxJson).slice(0, 120)}`
  );
  const sharePreviewPage = `${base}/s/${previewOnly.token}`;
  check(
    'the rest of the server still needs a login',
    (await fetch(`${base}/api/actions/get-collections`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' }))
      .status === 401
  );
  await invoke(base, editor, 'revoke-share-link', [viewOnly.token]);
  check('a turned-off link stops working', (await fetch(`${base}/s/${viewOnly.token}`)).status === 404);
  check(
    'Settings → Sharing lists the links',
    ((await invoke(base, editor, 'get-share-links', [])).result || []).some((l) => l.token === link.token && l.targetName === 'E2E Gifts')
  );

  console.log('\n# Guest access');
  const nobody = { origin: base };
  check('without guest access, nobody browses without a login', (await invoke(base, nobody, 'get-all-models')).status === 401);
  const editorGuest = await invoke(base, editor, 'save-setting', ['guestAccess', 'true']);
  check(
    'only admins turn on guest access',
    editorGuest.status !== 200 && (await invoke(base, nobody, 'get-all-models')).status === 401,
    JSON.stringify(editorGuest)
  );
  await invoke(base, admin, 'save-setting', ['guestAccess', 'true']);
  const guestModels = await invoke(base, nobody, 'get-all-models');
  check('with guest access, guests browse without a login', guestModels.status === 200 && Array.isArray(guestModels.result) && guestModels.result.length > 0);
  check('guests cannot edit', (await invoke(base, nobody, 'save-model', [{ filePath: uploadedPath, notes: 'guest was here' }])).status === 403);
  check('guests cannot change a password', (await invoke(base, nobody, 'set-server-password', ['x', 'y'])).status === 403);
  await invoke(base, nobody, 'save-setting', ['uiTheme', 'guest-theme']);
  check("a guest's display choices are not kept", (await invoke(base, admin, 'get-setting', ['uiTheme'])).result !== 'guest-theme');
  const guestStatus = await (await fetch(`${base}/api/auth/status`)).json();
  check(
    'the page knows it is a guest',
    guestStatus.authenticated === true && guestStatus.guest === true && guestStatus.user.roleLabel === 'Guest',
    JSON.stringify(guestStatus)
  );
  check('the login page offers to browse as a guest', (await (await fetch(`${base}/login`)).text()).includes('Browse as a guest'));
  const guestMcp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
  check('MCP still needs the API token', guestMcp.status === 401);

  console.log('\n# Open in OrcaSlicer (no helper)');
  const slicersBefore = (await invoke(base, admin, 'get-slicers')).result || [];
  check(
    'OrcaSlicer is added without a path',
    (
      await invoke(base, admin, 'clear-and-save-slicers', [
        [...slicersBefore.map((x) => ({ name: x.name, path: x.path })), { name: 'OrcaSlicer Link', path: 'orcaslicer://' }]
      ])
    ).result === true
  );
  const orca = (await invoke(base, viewer, 'open-file-in-slicer', [{ filePaths: [uploadedPath], slicerName: 'OrcaSlicer Link' }])).result || {};
  const orcaFile = orca.command?.files?.[0] || {};
  check('viewers get an OrcaSlicer link per file', orca.command?.type === 'open-in-orcaslicer' && orcaFile.name === 'Uploaded_Cube.stl', JSON.stringify(orca));
  const orcaDownload = await fetch(`${base}/api/slicer-file/${orcaFile.token}/${orcaFile.name}`);
  check(
    'OrcaSlicer downloads the file without a login',
    orcaDownload.status === 200 &&
      Buffer.from(await orcaDownload.arrayBuffer()).equals(cubeBytes) &&
      /Uploaded%20Cube\.stl/.test(orcaDownload.headers.get('content-disposition') || '')
  );
  check('a made-up token is refused', (await fetch(`${base}/api/slicer-file/AAAAAAAAAAAAAAAAAAAAAA/x.stl`)).status === 404);
  check(
    'files outside the library get no link',
    /outside the library/.test((await invoke(base, viewer, 'open-file-in-slicer', [{ filePaths: ['/etc/passwd'], slicerName: 'OrcaSlicer Link' }])).error || '')
  );
  check(
    'more than 10 files are refused with advice',
    /up to 10 files/.test(
      (await invoke(base, viewer, 'open-file-in-slicer', [{ filePaths: Array(11).fill(uploadedPath), slicerName: 'OrcaSlicer Link' }])).error || ''
    )
  );
  await invoke(base, admin, 'clear-and-save-slicers', [slicersBefore.map((x) => ({ name: x.name, path: x.path }))]);

  if (!CHROME) return;
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const errors = [];
    const open = async (username, password) => {
      const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
      page.on('pageerror', (error) => errors.push(`${username}: ${error.message}`));
      await page.goto(`${base}/`);
      await page.fill('#username', username);
      await page.fill('#password', password);
      await page.click('button[type=submit]');
      await page.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
      // The first-run welcome is per user: each new account sees it once.
      const welcome = await page.waitForSelector('#welcome-message[open]', { timeout: 5000 }).catch(() => null);
      if (username !== 'admin') check(`${username} gets the welcome on their first login`, !!welcome);
      if (welcome) {
        await page.click('#dismiss-welcome');
        // Get Started opens the Quick Start Guide; close it too.
        if (await page.waitForSelector('#quickstart-guide[open]', { timeout: 5000 }).catch(() => null)) {
          await page.keyboard.press('Escape');
          await page.waitForSelector('#quickstart-guide[open]', { state: 'detached', timeout: 5000 }).catch(() => {});
        }
      }
      return page;
    };

    // A guest in the browser (guest access is on): the library, and Log In instead of the account items.
    const guestPage = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    guestPage.on('pageerror', (error) => errors.push(`guest: ${error.message}`));
    await guestPage.goto(base + '/#/library');
    const guestIn = await guestPage
      .waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 })
      .then(
        () => true,
        () => false
      );
    check('a guest opens the library without logging in', guestIn && !guestPage.url().includes('/login'));
    check(
      'the account button says Guest',
      await guestPage.waitForSelector('#jp-account-who:has-text("Guest")', { timeout: 10000 }).then(
        () => true,
        () => false
      )
    );
    check('a guest sees no welcome', !(await guestPage.isVisible('#welcome-message')));
    await guestPage.click('.jp-account');
    check('a guest can go to Log In', await guestPage.isVisible('[role="menuitem"]:has-text("Log In")'));
    await guestPage.context().close();
    await invoke(base, admin, 'save-setting', ['guestAccess', 'false']);
    check('turning guest access off asks for a login again', (await invoke(base, { origin: base }, 'get-all-models')).status === 401);

    // The 3D view of a share page, for a visitor who is not logged in.
    const visitor = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
    visitor.on('pageerror', (error) => errors.push(`share page: ${error.message}`));
    await visitor.goto(sharePreviewPage);
    await visitor.click('button.view3d');
    const shown3d = await visitor.waitForSelector('dialog.viewer[data-ready="true"]', { timeout: 30000 }).then(
      () => true,
      () => false
    );
    check('a share page shows the model in 3D', shown3d && (await visitor.$$eval('dialog.viewer canvas', (list) => list.length)) === 1);
    await visitor.click('dialog.viewer .viewer-bar button');
    check('the 3D view closes', !(await visitor.isVisible('dialog.viewer')));
    await visitor.context().close();

    const editorPage = await open('maker', 'maker-password');
    check(
      'the account button shows the user and role',
      (await editorPage.waitForSelector('#jp-account-who:has-text("maker")', { timeout: 10000 }).then(
        () => true,
        () => false
      )) && (await editorPage.textContent('#jp-account-who')).includes('Editor')
    );
    check(
      'editors do not see admin pages',
      !(await editorPage.isVisible('.jp-sidebar .jp-nav__row:has-text("AI Tagging")')) &&
        (await editorPage.isVisible('.jp-sidebar .jp-nav__row:has-text("Organize")')) &&
        (await editorPage.isVisible('.jp-sidebar .jp-nav__row:has-text("Tags")'))
    );
    // Every upload goes to the Upload folder (8.4): without one, Upload asks for it in Settings → Scanning → Organize.
    await editorPage.evaluate(() => {
      window.location.hash = '#/library';
    });
    // Upload and Add Links are in the top bar's Add New Model menu (the library's toolbar has them on phones).
    await editorPage.waitForSelector('#jp-topbar-add-button', { timeout: 10000 });
    await editorPage.click('#jp-topbar-add-button');
    await editorPage.click('.jp-topbar [role="menuitem"]:has-text("Upload")');
    const askForInbox = await editorPage
      .waitForSelector('dialog[id^="browser-message-"][open]:has-text("Upload folder first")', { timeout: 10000 })
      .catch(() => null);
    check(
      'without an Upload folder, Upload asks for one first',
      !!askForInbox && /#\/settings\/organize$/.test(editorPage.url()) && !(await editorPage.isVisible('#jp-upload-input')),
      editorPage.url()
    );
    if (askForInbox) await editorPage.click('dialog[id^="browser-message-"][open] button:text-is("OK")');
    await invoke(base, admin, 'save-upload-folder', [folder, '']);
    await editorPage.evaluate(() => {
      window.location.hash = '#/library';
    });
    // Upload and Add Links are in the top bar's Add New Model menu (the library's toolbar has them on phones).
    await editorPage.waitForSelector('#jp-topbar-add-button', { timeout: 10000 });
    await editorPage.click('#jp-topbar-add-button');
    await editorPage.click('.jp-topbar [role="menuitem"]:has-text("Upload")');
    await editorPage.waitForSelector('#jp-upload-input', { state: 'attached', timeout: 5000 });
    check(
      'the dialog uploads into the Upload folder, with no other folder to choose',
      (await editorPage
        .waitForFunction((dir) => document.getElementById('jp-upload-folder')?.textContent === dir, folder, { timeout: 10000 })
        .then(
          () => true,
          () => false
        )) && !(await editorPage.$('#jp-upload-choose-folder'))
    );
    await editorPage.setInputFiles('#jp-upload-input', [
      { name: 'Browser Upload.stl', mimeType: 'application/octet-stream', buffer: cubeBytes },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('assembly notes') },
      { name: 'setup.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('not a model') }
    ]);
    check(
      'files of other types are skipped before sending',
      await editorPage.waitForSelector('.jp-upload__item.is-skipped:has-text("setup.exe")', { timeout: 5000 }).then(
        () => true,
        () => false
      )
    );
    await editorPage.click('#jp-upload-start');
    const summary = await editorPage
      .waitForFunction(() => /in the library|failed|Nothing/.test(document.getElementById('jp-upload-summary')?.textContent || ''), null, { timeout: 60000 })
      .then(
        () => editorPage.textContent('#jp-upload-summary'),
        () => editorPage.textContent('#jp-upload-summary').catch(() => '')
      );
    check('the dialog uploads in pieces and adds the model', /Uploaded 2 files into “Browser Upload”; all are in the library/.test(summary || ''), summary);
    const uploadedTo = (((await invoke(base, admin, 'get-all-models')).result || []).find((m) => m.fileName === 'Browser Upload.stl') || {}).filePath || '';
    check(
      'the browser upload went into a model folder in the Upload folder, whole, its document with it',
      path.dirname(uploadedTo) === path.join(folder, 'Browser Upload') &&
        fs.existsSync(uploadedTo) &&
        fs.readFileSync(uploadedTo).equals(cubeBytes) &&
        fs.existsSync(path.join(folder, 'Browser Upload', 'document', 'notes.txt')),
      uploadedTo
    );
    await editorPage.keyboard.press('Escape');
    // The model's page lists its document and reads it in the page.
    await editorPage.evaluate((file) => {
      window.location.hash = `#/model/${encodeURIComponent(file)}`;
    }, uploadedTo);
    const docButton = '#jp-media-documents li[data-name="notes.txt"] button';
    const docListed = await editorPage.waitForSelector(docButton, { timeout: 15000 }).then(
      () => true,
      () => false
    );
    if (docListed) await editorPage.click(docButton);
    const docRead = await editorPage
      .waitForFunction(() => /assembly notes/.test(document.querySelector('.jp-media-viewer .jp-doc-view__pre')?.textContent || ''), null, { timeout: 10000 })
      .then(
        () => true,
        () => false
      );
    check("a model's page lists its documents and opens them in the page", docListed && docRead, JSON.stringify({ docListed, docRead }));
    await editorPage.keyboard.press('Escape');

    // Upload on a model's page (8.4): anything into its folder, each file where it belongs.
    const modelDir = path.dirname(uploadedTo);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const pageMessage = 'dialog[id^="browser-message-"][open]';
    await editorPage.waitForSelector('#jp-model-more', { timeout: 10000 }).catch(() => {});
    await editorPage.setInputFiles('#jp-model-upload-file', [
      { name: 'Photo.png', mimeType: 'image/png', buffer: png },
      { name: 'Second part.stl', mimeType: 'application/octet-stream', buffer: cubeBytes },
      { name: 'Robot.step', mimeType: 'application/octet-stream', buffer: Buffer.from('ISO-10303-21;') }
    ]);
    const pageUploaded = await editorPage.waitForSelector(`${pageMessage}:has-text("Added to the model's folder")`, { timeout: 60000 }).then(
      (el) => el.textContent(),
      () => ''
    );
    if (pageUploaded) await editorPage.click(`${pageMessage} button:text-is("OK")`);
    check(
      "a model page's Upload puts each file where it belongs in the model's folder",
      /1 picture, 1 other file, 1 model file/.test(pageUploaded || '') &&
        fs.existsSync(path.join(modelDir, 'image', 'Photo.png')) &&
        fs.existsSync(path.join(modelDir, 'Second part.stl')) &&
        fs.existsSync(path.join(modelDir, 'other', 'Robot.step')),
      pageUploaded
    );
    const otherListed = await editorPage.waitForSelector('#jp-media-other li[data-name="Robot.step"]', { timeout: 15000 }).then(
      () => true,
      () => false
    );
    const otherFile = await fetch(`${base}/api/media/${encodeURIComponent(path.join(modelDir, 'other', 'Robot.step'))}`, {
      headers: { cookie: editor.cookie }
    });
    check(
      "other files are listed on the model's page and only ever downloaded",
      otherListed &&
        otherFile.status === 200 &&
        /attachment/.test(otherFile.headers.get('content-disposition') || '') &&
        /octet-stream/.test(otherFile.headers.get('content-type') || ''),
      JSON.stringify({ otherListed, status: otherFile.status, disposition: otherFile.headers.get('content-disposition') })
    );
    // A model file uploaded on a model's page is a part of that model: on its page, not in the library's lists.
    const partPath = path.join(modelDir, 'Second part.stl');
    const mainModel = (await invoke(base, admin, 'get-model', [uploadedTo])).result || {};
    const partModel = (await invoke(base, admin, 'get-model', [partPath])).result || {};
    const listed = ((await invoke(base, admin, 'get-models-filtered', [{}])).result || []).map((m) => m.filePath);
    const onItsPage = ((await invoke(base, admin, 'get-folder-models', [uploadedTo])).result || []).map((m) => m.filePath);
    check(
      "a model file uploaded on a model's page is its part: on its page, not a model of its own in the library",
      !!mainModel.id && partModel.partOf === mainModel.id && listed.includes(uploadedTo) && !listed.includes(partPath) && onItsPage.includes(partPath),
      JSON.stringify({ partOf: partModel.partOf, main: mainModel.id, listed: listed.includes(partPath), onItsPage })
    );
    // A part's page says so, and makes it a model of its own again; Make Parts (Multi-edit's action) puts it back.
    const isListed = async (p) => ((await invoke(base, admin, 'get-models-filtered', [{}])).result || []).some((m) => m.filePath === p);
    await editorPage.evaluate((file) => {
      window.location.hash = `#/model/${encodeURIComponent(file)}`;
    }, partPath);
    const separateButton = await editorPage.waitForSelector('#jp-model-unmerge', { timeout: 15000 }).catch(() => null);
    if (separateButton) await separateButton.click();
    const separated = await waitFor(async () => ((await isListed(partPath)) ? true : null), 10000, 'separated').catch(() => false);
    check("Un-merge on a merged model's page makes it a model of its own again", !!separateButton && separated === true);
    const madeParts = ((await invoke(base, editor, 'set-model-parts', [uploadedTo, [partPath]])).result || {}).changed;
    check('Merge merges the chosen models into one of them', madeParts === 1 && !(await isListed(partPath)));
    check('viewers cannot make parts', (await invoke(base, viewer, 'set-model-parts', [uploadedTo, [partPath]])).status === 403);

    // A model that shares its folder gets a folder of its own first.
    const shared = path.join(uploadLibrary, 'Shared');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'Gear.stl'), cubeBytes);
    fs.writeFileSync(path.join(shared, 'Spring.stl'), cubeBytes);
    await invoke(base, admin, 'scan-directory', [uploadLibrary]);
    await editorPage.evaluate(
      (file) => {
        window.location.hash = `#/model/${encodeURIComponent(file)}`;
      },
      path.join(shared, 'Gear.stl')
    );
    await editorPage.waitForSelector('#jp-model-more', { timeout: 15000 }).catch(() => {});
    await editorPage.setInputFiles('#jp-model-upload-file', [{ name: 'Gear notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }]);
    const askOwn = await editorPage.waitForSelector(`${pageMessage}:has-text("no folder of its own")`, { timeout: 15000 }).catch(() => null);
    if (askOwn) await editorPage.click(`${pageMessage} button:text-is("Make Its Folder")`);
    const ownDone = await editorPage.waitForSelector(`${pageMessage}:has-text("moved into its new folder")`, { timeout: 60000 }).catch(() => null);
    if (ownDone) await editorPage.click(`${pageMessage} button:text-is("OK")`);
    const gearNow = path.join(shared, 'Gear', 'Gear.stl');
    check(
      'Upload on a model that shares its folder moves it into a folder of its own first',
      !!askOwn &&
        !!ownDone &&
        fs.existsSync(gearNow) &&
        fs.existsSync(path.join(shared, 'Gear', 'document', 'Gear notes.pdf')) &&
        fs.existsSync(path.join(shared, 'Spring.stl')) &&
        (await editorPage
          .waitForFunction((file) => decodeURIComponent(window.location.hash) === `#/model/${file}`, gearNow, { timeout: 10000 })
          .then(
            () => true,
            () => false
          )),
      JSON.stringify({ askOwn: !!askOwn, ownDone: !!ownDone, url: editorPage.url() })
    );
    await invoke(base, admin, 'save-upload-folder', ['', '']);
    await editorPage.keyboard.press('Escape');
    await editorPage.evaluate(() => {
      window.location.hash = '#/library';
    });
    await editorPage.waitForSelector('#jp-topbar-add-button', { timeout: 10000 }).catch(() => {});

    // Add Links: pasted links are checked as you type.
    await editorPage.click('#jp-topbar-add-button');
    await editorPage.click('.jp-topbar [role="menuitem"]:has-text("Add Links")');
    await editorPage.fill(
      '#jp-links-text',
      'https://www.printables.com/model/3161-3d-benchy\nhttps://makerworld.com/en/models/1000000-lens-cap\nnot a link https://example.com/x'
    );
    check(
      'Add Links lists each link and what is already there',
      (await editorPage.waitForSelector('#jp-links-list .jp-upload__item.is-exists:has-text("E2E Benchy")', { timeout: 10000 }).then(
        () => true,
        () => false
      )) &&
        (await editorPage.isVisible('#jp-links-list .jp-upload__item.is-new:has-text("Lens Cap")')) &&
        /example\.com\/x/.test(await editorPage.textContent('#jp-links-unsupported'))
    );
    // With downloading on, an online model already in the library is offered too (to get its files).
    check(
      'Add Links offers the new ones, and online models when downloading',
      (await editorPage.textContent('#jp-links-start')) === 'Add 2 models' && (await editorPage.isChecked('#jp-links-download-toggle'))
    );
    await editorPage.uncheck('#jp-links-download-toggle');
    check('Add Links offers only the new ones without downloading', (await editorPage.textContent('#jp-links-start')) === 'Add 1 model');
    await editorPage.check('#jp-links-download-toggle');
    // Not signed in to MakerWorld: the dialog says so, with the steps; editors are not offered the admin-only settings.
    check(
      'Add Links says MakerWorld downloads need a sign-in, and how',
      (await editorPage.waitForSelector('#jp-site-setup:has-text("To download models from MakerWorld, you need to sign in")', { timeout: 10000 }).then(
        () => true,
        () => false
      )) &&
        (await editorPage.isVisible('#jp-site-setup a[href="https://makerworld.com/en"]')) &&
        !(await editorPage.isVisible('#jp-site-setup-open-makerworld'))
    );
    await editorPage.keyboard.press('Escape');

    await editorPage.evaluate(() => {
      window.location.hash = '#/stats';
    });
    check(
      'Statistics shows the prints',
      (await editorPage.waitForSelector('#jp-stats-tiles .jp-stat__value:text-is("3")', { timeout: 15000 }).then(
        () => true,
        () => false
      )) && (await editorPage.isVisible('#jp-stats-tiles :text("75%")'))
    );
    check(
      'the prints chart is drawn with a legend',
      (await editorPage.isVisible('.jp-chart svg[aria-label="Prints per month by outcome"]')) &&
        (await editorPage.isVisible('.jp-chart__legend :text("Failed")'))
    );
    await editorPage.click('button:has-text("Show table")', { timeout: 5000 }).catch(() => {});
    check('the chart has a table view', await editorPage.isVisible('.jp-stats__table'));

    // Collections page and the Share dialog with its QR code.
    await editorPage.evaluate((id) => {
      window.location.hash = `#/collections/${id}`;
    }, giftId);
    check(
      'a collection page lists its models',
      (await editorPage.waitForSelector('#jp-collection-models .jp-recent-card', { timeout: 15000 }).then(
        () => true,
        () => false
      )) && (await editorPage.textContent('#jp-collection-title')) === 'E2E Gifts'
    );
    await editorPage.click('#jp-share-collection');
    await editorPage.waitForSelector('#jp-share-create', { timeout: 5000 });
    await editorPage.click('#jp-share-create');
    check(
      'the Share dialog makes a link with a QR code',
      (await editorPage.waitForSelector('.jp-share__qr svg', { timeout: 10000 }).then(
        () => true,
        () => false
      )) && /\/s\/[A-Za-z0-9_-]{24}$/.test(await editorPage.inputValue('#jp-share-url'))
    );
    await editorPage.keyboard.press('Escape');

    const viewerPage = await open('kid', 'kid-password');
    await viewerPage.evaluate(() => {
      window.location.hash = '#/library';
    });
    await viewerPage.waitForTimeout(1500);
    check(
      'viewers have no Upload or Add Links button',
      !(await viewerPage.isVisible('#jp-upload-button')) && !(await viewerPage.isVisible('#jp-links-button'))
    );
    // A viewer's details panel shows the model but offers no edits.
    await viewerPage.click('.file-grid [data-filepath] .file-name', { timeout: 10000 }).catch(() => {});
    await viewerPage.waitForSelector('#model-details .jp-details__title', { timeout: 10000 }).catch(() => {});
    await viewerPage.waitForSelector('#model-details #model-print-status', { timeout: 10000 }).catch(() => {});
    check(
      "a viewer's details panel is read-only",
      (await viewerPage.isVisible('#model-details .jp-details__title')) &&
        !(await viewerPage.isVisible('#model-details #jp-details-edit')) &&
        !(await viewerPage.isVisible('#model-details #jp-model-notes button[aria-label="Edit your notes"]')) &&
        !(await viewerPage.isVisible('#jp-details-log-print')) &&
        (await viewerPage.isDisabled('#model-print-status')) &&
        !(await viewerPage.isVisible('#jp-edit-button'))
    );
    check('viewers still open models in a slicer from the details', await viewerPage.isVisible('#jp-details-open-slicer'));
    check(
      'viewers see no library tools in the sidebar',
      !(await viewerPage.isVisible('.jp-sidebar .jp-nav__row:has-text("Scan Library")')) &&
        (await viewerPage.isVisible('.jp-sidebar .jp-nav__row:has-text("Statistics")'))
    );
    await viewerPage.evaluate(() => {
      // Tags is an editor's page (Organize, the admin page this opened before 8.1, is no page now).
      window.location.hash = '#/tags';
    });
    check(
      'a page the account may not use, opened by its address, says so',
      await viewerPage.waitForSelector(':text("Not available to your account")', { timeout: 5000 }).then(
        () => true,
        () => false
      )
    );
    await viewerPage.evaluate(() => {
      window.location.hash = '#/settings/password';
    });
    await viewerPage.waitForSelector('.jp-settings-page', { timeout: 5000 });
    check(
      'viewers see only their settings',
      (await viewerPage.isVisible('.jp-settings-row:has-text("Change Password")')) &&
        !(await viewerPage.isVisible('#setting-users')) &&
        !(await viewerPage.isVisible('.jp-settings-index :text("Backup")'))
    );
    await viewerPage.click('.jp-settings-row:has-text("Change Password")');
    await viewerPage.fill('#change-password-current', 'kid-password');
    await viewerPage.fill('#change-password-new', 'kid-new-password');
    await viewerPage.fill('#change-password-confirm', 'kid-new-password');
    await viewerPage.click('#change-password-save');
    check(
      'a user changes their own password and is logged out',
      await viewerPage.waitForURL(/\/login/, { timeout: 20000 }).then(
        () => true,
        () => false
      )
    );
    check('the new password works', !!(await loginAs(base, 'kid', 'kid-new-password')) && !(await loginAs(base, 'kid', 'kid-password')));

    const adminPage = await open('admin', PASSWORD);
    await adminPage.evaluate(() => {
      window.location.hash = '#/settings/authentication';
    });
    await adminPage.waitForSelector('#users-list .users-row', { timeout: 15000 });
    await adminPage.fill('#users-new-name', 'guest-viewer');
    await adminPage.fill('#users-new-password', 'guest-password');
    await adminPage.click('#users-add');
    check(
      'Settings → Users adds a user',
      await adminPage.waitForSelector('.users-row[data-username="guest-viewer"]', { timeout: 10000 }).then(
        () => true,
        () => false
      )
    );
    await adminPage.selectOption('.users-row[data-username="guest-viewer"] select', 'editor');
    check(
      'Settings → Users changes a role',
      await waitFor(
        async () => (((await invoke(base, admin, 'list-users')).result || {}).users || []).some((u) => u.username === 'guest-viewer' && u.role === 'editor'),
        10000,
        'role change'
      ).catch(() => false)
    );
    check('the JUSTTPRINT_PASSWORD account cannot be changed here', await adminPage.isDisabled('.users-row[data-username="admin"] select'));
    // Edits from two browsers at once (src/core/edit-merge.js): live updates, conflicts, tag merges.
    const cardOf = (fp) => `.file-grid [data-filepath="${fp.replace(/"/g, '\\"')}"] .file-name`;
    for (const p of [editorPage, adminPage]) {
      await p.evaluate(() => {
        window.location.hash = '#/library';
      });
      await p.waitForSelector('.file-grid [data-filepath]', { timeout: 15000 }).catch(() => {});
      // The grid draws only the cards on screen: scroll down to the model's card.
      for (let i = 0; i < 20 && !(await p.$(cardOf(uploadedPath))); i++) {
        await p.evaluate(() => {
          for (let el = document.querySelector('.file-grid'); el; el = el.parentElement) {
            if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop += el.clientHeight;
          }
        });
        await p.waitForTimeout(300);
      }
      await p.click(cardOf(uploadedPath)).catch(() => {});
      await p.waitForSelector('#model-details .jp-details__title', { timeout: 10000 }).catch(() => {});
    }
    await invoke(base, admin, 'save-model', [{ filePath: uploadedPath, designer: 'Live Designer' }]);
    check(
      "a change made elsewhere shows up in another browser's details panel",
      await editorPage
        .waitForFunction(() => /By Live Designer/.test(document.querySelector('#model-details .jp-model-page__byline')?.textContent || ''), null, {
          timeout: 15000
        })
        .then(
          () => true,
          () => false
        )
    );
    const editNotes = '#model-details #jp-model-notes button[aria-label="Edit your notes"]';
    await editorPage.click(editNotes);
    await editorPage.waitForSelector('#model-details #jp-model-notes-input', { timeout: 10000 });
    await invoke(base, admin, 'save-model', [{ filePath: uploadedPath, notes: 'Their note' }]);
    await editorPage.fill('#model-details #jp-model-notes-input', 'My note');
    await editorPage.click('#model-details #jp-model-notes-save');
    const conflictBox = await editorPage
      .waitForSelector('dialog[id^="browser-message-"][open]:has-text("Changed by someone else")', { timeout: 10000 })
      .catch(() => null);
    check(
      'saving notes someone else changed meanwhile asks which to keep',
      !!conflictBox && /Their note/.test(await conflictBox.textContent()) && /My note/.test(await conflictBox.textContent())
    );
    if (conflictBox) await editorPage.click('dialog[id^="browser-message-"][open] button:text-is("Keep Both")');
    const keptBoth = await waitFor(
      async () => {
        const notes = ((await invoke(base, admin, 'get-model', [uploadedPath])).result || {}).notes || '';
        return /Their note/.test(notes) && /My note/.test(notes) ? notes : null;
      },
      10000,
      'both notes'
    ).catch(() => '');
    check('Keep Both keeps their notes and mine', !!keptBoth, keptBoth);
    // Tags: what each edit added or removed is applied to what is stored, so both changes stay.
    await invoke(base, admin, 'save-model', [{ filePath: uploadedPath, tags: ['red', 'toy'] }]);
    const merged = await invoke(base, editor, 'save-model', [{ filePath: uploadedPath, tags: ['toy', 'boat'], _base: { tags: ['toy'] } }]);
    const mergedTags = (((await invoke(base, admin, 'get-model', [uploadedPath])).result || {}).tags || [])
      .map((t) => t.name || t)
      .sort()
      .join(',');
    check('tags changed in two places keep both changes', merged.status === 200 && mergedTags === 'boat,red,toy', mergedTags);
    const stale = await invoke(base, editor, 'save-model', [{ filePath: uploadedPath, designer: 'Mine', _base: { designer: 'An old value' } }]);
    check(
      'a save from an old view reports the conflict and saves nothing',
      (stale.result?.conflicts || [])[0]?.field === 'designer' &&
        ((await invoke(base, admin, 'get-model', [uploadedPath])).result || {}).designer === 'Live Designer',
      JSON.stringify(stale)
    );
    // Undo (src/web/library/undo.ts): the notice's button, then Ctrl/Cmd+Z, after editing the notes in the sidebar.
    const notesNow = async () => ((await invoke(base, admin, 'get-model', [uploadedPath])).result || {}).notes || '';
    const notesBefore = await notesNow();
    await editorPage.evaluate(() => window.reloadShownModelDetails?.());
    for (const [how, typed] of [
      ['the Undo button', 'Undo button note'],
      ['Ctrl/Cmd+Z', 'Undo key note']
    ]) {
      await editorPage.click(editNotes);
      await editorPage.fill('#model-details #jp-model-notes-input', typed);
      await editorPage.click('#model-details #jp-model-notes-save');
      const saved = await waitFor(async () => (await notesNow()) === typed, 10000, 'notes saved').catch(() => false);
      const toast = await editorPage.waitForSelector('[data-testid="undo-toast"]:has-text("Changed the notes")', { timeout: 10000 }).catch(() => null);
      if (toast && how === 'the Undo button')
        check(
          'the Undo notice shows its text, not only the button',
          await editorPage.$eval('[data-testid="undo-toast"] .jp-undo-toast__text', (el) => el.getBoundingClientRect().width > 40).catch(() => false)
        );
      if (how === 'the Undo button') await editorPage.click('[data-testid="undo-toast"] button:text-is("Undo")').catch(() => {});
      else {
        // The shortcut is off while typing in a field: leave it first, as a person would.
        await editorPage.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
        await editorPage.keyboard.press('ControlOrMeta+z');
      }
      const undone = await waitFor(async () => (await notesNow()) === notesBefore, 10000, 'notes undone').catch(() => false);
      check(`${how} undoes a details edit`, saved && !!toast && undone, await notesNow());
    }
    check(
      'the details panel shows the undone value',
      await editorPage
        .waitForFunction(() => /Their note/.test(document.querySelector('#model-details #jp-model-notes')?.textContent || ''), null, { timeout: 10000 })
        .then(
          () => true,
          () => false
        )
    );
    check('no page errors for any account', errors.length === 0, errors.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
  }
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;
  const server = startServer(port);
  let exitCode = 1;
  try {
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 60000, 'server start');
    const session = await apiChecks(base, wsUrl);
    await browserChecks(base, wsUrl, session);
    await accountChecks(base, wsUrl, session);
    exitCode = failed ? 1 : 0;
  } catch (error) {
    console.log(`FAIL e2e run: ${error.message}`);
  } finally {
    if (browseDir) fs.rmSync(browseDir, { recursive: true, force: true });
    if (uploadLibrary) fs.rmSync(uploadLibrary, { recursive: true, force: true });
    await stopServer(server);
    const log = fs.readFileSync(path.join(WORK, 'server.log'), 'utf8');
    check('server closed the database on shutdown', log.includes('[Quit] Database closed'));
    if (failed) console.log(`\nServer log: ${path.relative(ROOT, path.join(WORK, 'server.log'))}`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : exitCode);
  }
}

main();
