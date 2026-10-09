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

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (_) { /* retry */ }
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
      JUSTTPRINT_ENABLE_ZIP: 'true',
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
    JUSTTPRINT_ENABLE_ZIP: 'true',
    JUSTTPRINT_UPLOAD_CHUNK_MB: '0.0001',
    STL_HOME: LIBRARY,
    XDG_DATA_HOME: path.join(WORK, 'share'),
    PUID: String(process.getuid()),
    PGID: String(process.getgid()),
    ...(process.env.JUSTTPRINT_LOG_LEVEL ? { JUSTTPRINT_LOG_LEVEL: process.env.JUSTTPRINT_LOG_LEVEL } : {})
  };
  const child = spawn('docker', ['run', '--rm', '--name', name, '-p', `127.0.0.1:${port}:${port}`, '--add-host', 'host.docker.internal:host-gateway',
    ...folders.flatMap((folder) => ['-v', `${folder}:${folder}`]),
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    DOCKER_IMAGE], { cwd: ROOT, stdio: ['ignore', log, log] });
  child.containerName = name;
  console.log(`# Server in Docker image ${DOCKER_IMAGE} (container ${name})`);
  return child;
}

function stopServer(child) {
  if (child && child.containerName) {
    return new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { spawn('docker', ['rm', '-f', child.containerName]); resolve(); }, 30000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      spawn('docker', ['stop', '-t', '15', child.containerName], { stdio: 'ignore' });
    });
  }
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 15000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
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
    const timer = setTimeout(() => { ws.terminate(); resolve({ error: 'timeout' }); }, 10000);
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
    ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); resolve({ rejected: res.statusCode }); });
    ws.on('error', (error) => { clearTimeout(timer); resolve({ error: error.message }); });
  });
}

/** A browser's event socket kept open: its client id and the event channels it receives. */
function listenEvents(wsUrl, { cookie, origin }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { Origin: origin, Cookie: cookie } });
    const channels = [];
    const timer = setTimeout(() => { ws.terminate(); resolve(null); }, 10000);
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello') {
        clearTimeout(timer);
        resolve({ clientId: message.clientId, channels, close: () => ws.close() });
      } else if (message.type === 'event') {
        channels.push(message.channel);
      }
    });
    ws.on('error', () => { clearTimeout(timer); resolve(null); });
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
  const imageType = async (p) => { const r = await anon.request(p); return r.status === 200 ? r.headers.get('content-type') || '' : `status ${r.status}`; };
  check('icons load without login, also /favicon.ico', /image\/png/.test(await imageType('/assets/logo.png')) && /image\/png/.test(await imageType('/assets/pwa-maskable-512.png'))
    && /icon/.test(await imageType('/favicon.ico')) && /icon/.test(await imageType('/assets/favicon.ico')));
  const home = await anon.request('/', { headers: { accept: 'text/html' } });
  check('home redirects to login', home.status === 302 && /\/login/.test(home.headers.get('location') || ''));
  check('API needs login', (await anon.request(file(cube))).status === 401);
  check('wrong password refused', (await anon.request('/api/auth/login', { method: 'POST', json: { password: 'nope-nope' } })).status === 401);
  check('login', (await http.request('/api/auth/login', { method: 'POST', json: { password: PASSWORD } })).status === 200);
  // The server scans STL Home in the background after it starts listening.
  const scanned = await waitFor(async () => {
    const stats = await invoke(base, { cookie: http.cookie(), origin: base }, 'get-stats');
    return stats.result && stats.result.totalModels === 4 ? 4 : null;
  }, 60000, 'STL Home scan').catch((error) => error.message);
  check('startup scan found the 4 fixture models', scanned === 4, scanned);
  // Folder watching (src/server/folder-watch.js): a file added to STL Home appears without a scan, a deleted one goes.
  const ctxCookie = () => ({ cookie: http.cookie(), origin: base });
  const watchStatus = (await invoke(base, ctxCookie(), 'get-folder-watch-status')).result || {};
  check('STL Home folders are watched', watchStatus.enabled === true && watchStatus.roots?.some((root) => root.path === LIBRARY && root.folders >= 4 && !root.error),
    JSON.stringify(watchStatus));
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
  check('a watched subfolder is not added to the scanned folders',
    !JSON.stringify((await invoke(base, ctxCookie(), 'get-setting', ['scannedDirectories'])).result || '').includes('Designer B'));
  check('home after login', (await http.request('/')).status === 200);
  check('web asset served', (await http.request('/page-init.js')).status === 200);
  for (const hidden of ['/main.js', '/spoolman.js', '/src/core/spoolman.js', '/package.json', '/node_modules/express/package.json', '/src/server/index.js']) {
    check(`${hidden} not served`, (await http.request(hidden)).status === 404);
  }

  console.log('\n# Security headers');
  const health = await http.request('/api/health');
  check('nosniff', health.headers.get('x-content-type-options') === 'nosniff');
  check('frame-ancestors', /frame-ancestors 'self'/.test(health.headers.get('content-security-policy') || ''));
  check('CSP allows only script files from this server', /script-src 'self' 'wasm-unsafe-eval';/.test(health.headers.get('content-security-policy') || '') && !/unsafe-inline/.test(health.headers.get('content-security-policy') || ''));
  const cspOf = async (urlPath) => (await http.request(urlPath)).headers.get('content-security-policy') || '';
  check('page scripts may not eval', !/'unsafe-eval'/.test(await cspOf('/page-init.js')));
  check('the parse worker may not eval either (STEP library built without it)', !/'unsafe-eval'/.test(await cspOf('/web-build/parse-worker.js'))
    && /'wasm-unsafe-eval'/.test(await cspOf('/web-build/parse-worker.js')));
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
  for (const channel of ['getSetting', 'saveSetting', 'quitApp', 'open-path', 'fetch-makerworld-page', 'puter-ai-chat', 'is-server-mode', 'import-extension-inbox', 'get-default-extension-inbox-directory']) {
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
  check('WS sends a client id', eventSocket.hello && eventSocket.hello.type === 'hello' && /^[0-9a-f]{32}$/.test(eventSocket.hello.clientId), JSON.stringify(eventSocket));
  check('WS no longer runs actions', eventSocket.reply && eventSocket.reply.type === 'error' && /api\/actions/.test(eventSocket.reply.error), JSON.stringify(eventSocket.reply));

  console.log('\n# Path guard');
  const refused = (res, pattern) => res.status === 403 && typeof res.error === 'string' && pattern.test(res.error);
  check('read /etc/passwd refused', refused(await invoke(base, { cookie, origin }, 'read-model-file', ['/etc/passwd']), /outside the library/));
  check('delete live database refused', refused(await invoke(base, { cookie, origin }, 'delete-file', [path.join(DATA, 'data', 'justtprint.db')]), /outside the library/));
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
  check('Choose Folder lists places and no folder yet', Array.isArray(placesOnly.result?.places) && placesOnly.result.path === null
    && !placesOnly.result.places.some((place) => place.path === '/' || place.path.startsWith(APP_DIR)), JSON.stringify(placesOnly).slice(0, 300));
  const browsed = (await invoke(base, { cookie, origin }, 'browse-folders', [browseDir])).result;
  check('Choose Folder lists subfolders only (no files or hidden folders)', browsed?.path === browseDir
    && JSON.stringify(browsed.folders.map((f) => f.name)) === '["Prints"]' && browsed.parent === path.dirname(browseDir), JSON.stringify(browsed));
  for (const [what, dir] of [['/etc', '/etc'], ['the app folder', APP_DIR], ['the data folder', DATA], ['/', '/']]) {
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
  check('MCP with token finds library models', mcp.status === 200 && mcpText.includes('cube.stl') && mcpText.includes('pack.zip::inner/widget.stl'));
  const mcpTool = async (name, args = {}) => {
    const res = await anon.request('/mcp', { method: 'POST', json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, useCookie: false, headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, text: await res.text() };
  };
  const mcpStats = await mcpTool('get_library_stats');
  check('MCP library stats', mcpStats.status === 200 && /totalModels/.test(mcpStats.text) && !/"isError":\s*true/.test(mcpStats.text), mcpStats.text.slice(0, 200));
  const mcpTree = await mcpTool('get_folder_tree');
  check('MCP folder tree', mcpTree.status === 200 && mcpTree.text.includes('Designer A') && !/"isError":\s*true/.test(mcpTree.text), mcpTree.text.slice(0, 200));
  const backupMcp = await anon.request('/mcp', {
    method: 'POST', useCookie: false, headers: { authorization: `Bearer ${token}` },
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
    check('printer maintenance log saved', logs.some((l) => l.title === 'Nozzle swap'));
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
  const names = async (filters) => ((await ask('get-models-filtered', [filters])).result || []).map((m) => m.fileName).sort().join(',');
  const term = (value) => ({ t: 'clause', field: 'all', value });
  check('search: one word', await names({ search: 'cube' }) === 'cube.stl', await names({ search: 'cube' }));
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
    check('Send to Slicer returns a helper command', command.type === 'open-in-slicer' && command.slicerPath === '/usr/bin/e2e-slicer' && command.filePaths[0] === cube && !!command.downloadToken, sent.error || JSON.stringify(sent.result));
    const helperDownload = await fetch(`${base}/api/download/${encodeURIComponent(cube)}?token=${encodeURIComponent(command.downloadToken || '')}`);
    check('helper can download with the command token (no login)', helperDownload.status === 200, helperDownload.status);
    const zipEntry = path.join(LIBRARY, 'Designer C', 'pack.zip') + '::inner/widget.stl';
    const zipCommand = ((await ask('open-file-in-slicer', [{ filePaths: [zipEntry], slicerId: slicer.id }])).result || {}).command || {};
    const zipDownload = await fetch(`${base}/api/download/${encodeURIComponent(zipEntry)}?token=${encodeURIComponent(zipCommand.downloadToken || '')}`);
    check('helper can download a ZIP entry', zipCommand.isZipEntry === true && zipDownload.status === 200 && (await zipDownload.arrayBuffer()).byteLength > 0, zipDownload.status);
    const menuWithSlicer = (await ask('show-context-menu', [[cube]])).result || {};
    const slicerItem = (menuWithSlicer.items || []).flatMap((i) => i.submenu || []).find((i) => i.clientAction);
    check('context menu slicer item carries a helper command', !!slicerItem && slicerItem.clientAction.slicerPath === '/usr/bin/e2e-slicer' && !!slicerItem.clientAction.downloadToken, JSON.stringify(slicerItem));
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
  check('System Report names the thumbnail renderer\'s GPU', typeof rendererGpu === 'string' && rendererGpu.length > 0, String(rendererGpu));
  const dbBench = await ask('benchmark-database');
  check('System Report database benchmark', !dbBench.error && !!dbBench.result, dbBench.error);

  const menu = (await ask('show-context-menu', [[cube]])).result || {};
  check('context menu built for a model', menu.type === 'html-menu' && Array.isArray(menu.items) && menu.items.some((i) => i.label), JSON.stringify(menu).slice(0, 200));

  const before = (await ask('get-model', [cube])).result;
  check('model loaded with tags', !!before && Array.isArray(before.tags), JSON.stringify(before).slice(0, 200));
  if (before) {
    const saved = await ask('save-model', [{ ...before, thumbnail: undefined, notes: 'e2e note', designer: 'E2E Designer', tags: ['e2e-model-tag'] }]);
    const after = (await ask('get-model', [cube])).result || {};
    check('model edits saved', !saved.error && after.notes === 'e2e note' && after.designer === 'E2E Designer' && (after.tags || []).includes('e2e-model-tag'), saved.error || JSON.stringify({ notes: after.notes, designer: after.designer, tags: after.tags }));
    check('designer list includes the edit', ((await ask('get-designers')).result || []).some((d) => JSON.stringify(d).includes('E2E Designer')));
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
  const previewReply = await ask('organize-library-preview', [{ sourceDir: LIBRARY, destDir: '/tmp/pv-e2e-organize-preview' /* preview only: never created */ }]);
  const preview = previewReply.result || {};
  check('organize preview plans copies', preview.ok === true && preview.copyCount > 0, previewReply.error || preview.error || JSON.stringify(preview).slice(0, 200));
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
  check('making a new download deletes ones older than an hour', !!freshExport.filePath && !fs.existsSync(staleDownload) && fs.existsSync(freshExport.filePath));
  const leftoverFile = path.join(DATA, 'data', 'justtprint-backup-2026-01-01T00-00-00-000Z.db');
  fs.writeFileSync(leftoverFile, 'old backup');
  const leftoverList = (await invoke(base, { cookie, origin }, 'get-leftover-downloads')).result || {};
  check('old backups in the data folder are listed', leftoverList.files?.length === 1 && leftoverList.files[0].name === path.basename(leftoverFile) && leftoverList.totalBytes === 10,
    JSON.stringify(leftoverList));
  const leftoverDeleted = (await invoke(base, { cookie, origin }, 'delete-leftover-downloads')).result || {};
  check('and deleted on request, leaving the database', leftoverDeleted.count === 1 && !fs.existsSync(leftoverFile) && fs.existsSync(path.join(DATA, 'data', 'justtprint.db')));
  const junk = await invoke(base, { cookie, origin }, 'restore-database', [{ base64: Buffer.from('not a database').toString('base64') }]);
  check('restore refuses a file that is not a backup', junk.result && junk.result.success === false && /Not a JusttPrint backup/.test(junk.result.message), JSON.stringify(junk));
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
  check('automatic backups are off by default and go to backups/ in the data folder', autoDefault.enabled === false
    && autoDefault.directory === path.join(DATA, 'backups') && Array.isArray(autoDefault.backups), JSON.stringify(autoDefault).slice(0, 300));
  check('automatic backups refuse a system folder', /system folder/.test((await act('save-auto-backup', { directory: '/etc/backups' })).error || ''));
  const autoDir = fs.realpathSync(fs.mkdtempSync('/tmp/justtprint-e2e-autobackup-'));
  fs.writeFileSync(path.join(autoDir, 'other.db'), 'not ours');
  const autoSaved = (await act('save-auto-backup', { enabled: true, keep: 2, intervalHours: 12, directory: autoDir })).result || {};
  check('automatic backup settings are saved', autoSaved.enabled === true && autoSaved.keep === 2 && autoSaved.intervalHours === 12 && autoSaved.directory === autoDir);
  const autoRuns = [];
  for (let n = 0; n < 3; n++) autoRuns.push((await act('run-auto-backup')).result || {});
  const autoAfter = autoRuns[2].status || {};
  check('Back Up Now writes checked backups and keeps the newest 2', autoRuns.every((r) => r.success) && autoAfter.backups.length === 2
    && autoAfter.lastError === '' && !!autoAfter.nextRun && fs.existsSync(path.join(autoDir, 'other.db')), JSON.stringify(autoRuns.map((r) => r.message || r.backup?.name)));
  const newest = autoAfter.backups[0];
  check('an automatic backup can be downloaded', !!newest && (await http.request(download(newest.path))).status === 200);
  check('other files in the backup folder cannot', (await http.request(download(path.join(autoDir, 'other.db')))).status !== 200);
  check('restore refuses a name that is not an automatic backup', /Not an automatic backup/.test(((await act('restore-auto-backup', '../other.db')).result || {}).message || ''));
  const autoRestored = (await act('restore-auto-backup', newest.name)).result || {};
  check('restore from an automatic backup', autoRestored.success === true && ((await act('get-stats')).result || {}).totalModels > 0, JSON.stringify(autoRestored));
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
  check('a scan\'s progress and "Removed" message go only to the browser that scanned',
    !!browserA && !!browserB && browserA.channels.includes('db-cleanup') && browserA.channels.includes('scan-progress')
      && !browserB.channels.includes('db-cleanup') && !browserB.channels.includes('scan-progress'),
    JSON.stringify({ a: browserA?.channels, b: browserB?.channels }));
  check('a library change still reaches every browser', !!browserA && !!browserB && browserA.channels.includes('refresh-grid') && browserB.channels.includes('refresh-grid'));
  fs.rmSync(ownDir, { recursive: true, force: true });
  // Scanning the deleted folder drops its models (the clean-up runs before the folder is read).
  await invoke(base, asA, 'scan-directory', [ownDir]);
  await invoke(base, { cookie, origin }, 'save-setting', ['scannedDirectories', scannedBefore || '[]']);
  browserA?.close();
  browserB?.close();
  check('the library is back to the fixture models', ((await invoke(base, { cookie, origin }, 'get-stats')).result || {}).totalModels === 4);

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
  const missing = await waitFor(async () => {
    const res = await invoke(base, session, 'get-models-with-default-thumbnails');
    return Array.isArray(res.result) && res.result.length === 0 ? 'done' : null;
  }, 120000, 'thumbnails').catch((error) => error.message);
  check('worker rendered all thumbnails', missing === 'done', missing);
  // The last thumbnail is saved just before the worker reports the job complete.
  const jobStatus = await waitFor(async () => {
    const status = (await invoke(base, session, 'get-server-thumbnail-job-status')).result || {};
    return status.status === 'idle' ? status : null;
  }, 30000, 'thumbnail job').catch((error) => ({ error: error.message }));
  check('thumbnail job finished', jobStatus.status === 'idle', JSON.stringify(jobStatus));
  const cubeThumbs = (await invoke(base, session, 'get-all-thumbnails', [path.join(LIBRARY, 'Designer A', 'cube.stl')])).result;
  check('rendered thumbnail stored for a model', JSON.stringify(cubeThumbs || '').includes('data:image'), JSON.stringify(cubeThumbs).slice(0, 120));
  await invoke(base, session, 'save-setting', ['tosAcceptedDate', new Date().toISOString()]);
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
    page.on('response', (response) => { if (response.status() >= 400) badResponses.push(`${response.status()} ${response.url()}`); });
    // The library's Filter popover (src/web/pages/LibraryPage.tsx) holds the old sidebar's filters.
    const openFilters = async () => {
      if (!(await page.isVisible('#jp-filter-popover'))) await page.click('#jp-filter-button');
      await page.waitForSelector('#jp-filter-popover', { state: 'visible', timeout: 5000 }).catch(() => {});
    };
    // A row of the Settings page (src/web/pages/SettingsPage.tsx); the old sidebar buttons live there now.
    const runSetting = async (label) => {
      await page.evaluate(() => { window.location.hash = '#/settings'; });
      await page.click(`.jp-settings-row:has-text("${label}")`);
    };
    const showLibrary = () => page.evaluate(() => { window.location.hash = '#/library'; });

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

    // Home dashboard (React, src/web/pages/HomeDashboard.tsx): the app opens on it, above the library.
    const libraryTotal = (await invoke(base, session, 'get-library-counts')).result || {};
    check('the app opens on Home with a greeting', await page.isVisible('.jp-sidebar .jp-nav__row[aria-current="page"]:has-text("Home")')
      && /^Good (morning|afternoon|evening)$/.test((await page.textContent('.jp-hero__title').catch(() => '')).trim()));
    check('the dashboard figures are the library counts', await page.waitForFunction((n) => document.querySelector('.jp-hero .jp-stat__value')?.textContent === String(n), libraryTotal.models, { timeout: 10000 }).then(() => true, () => false),
      `${await page.textContent('.jp-hero .jp-stat__value').catch(() => '')} vs ${libraryTotal.models}`);
    check('Recent Activity lists the models added', await page.waitForSelector('.jp-activity-list .jp-activity__title:has-text("new models added")', { timeout: 10000 }).then(() => true, () => false));
    check('Your Printers offers to add a printer', await page.isVisible('.jp-home__panel :text("No printers yet")') || await page.isVisible('.jp-printer-list'));
    check('the dashboard draws a library model', await page.waitForSelector('.jp-hero__render, .jp-hero__fallback', { timeout: 60000 }).then(() => true, () => false));
    check('Home lists the most recently added models', await page.waitForSelector('.jp-recent-grid .jp-recent-card', { timeout: 10000 }).then(() => true, () => false)
      && await page.isVisible('#jp-home-library-title'));
    await page.click('.jp-sidebar .jp-nav__row:has-text("Library")');
    check('Library shows the library without the dashboard', await page.waitForSelector('.jp-hero', { state: 'detached', timeout: 5000 }).then(() => true, () => false)
      && /#\/library$/.test(page.url()));

    const previewView = await page.$('.view-button[data-view="preview"]');
    if (previewView) {
      await previewView.click();
      await page.waitForTimeout(2000);
    }
    const tiles = await page.$$eval('[data-filepath], [data-file-path]', (els) => els.map((el) => el.getAttribute('data-filepath') || el.getAttribute('data-file-path')));
    // 4 scanned, minus the one moved to the trash in the API checks.
    check('grid shows the library (3 models)', tiles.length === 3, `${tiles.length} tiles`);

    for (const filePath of tiles) {
      const errorsBefore = errors.length;
      const tile = await page.$(`[data-filepath="${filePath.replace(/"/g, '\\"')}"], [data-file-path="${filePath.replace(/"/g, '\\"')}"]`);
      await tile.dblclick();
      const opened = await page.waitForFunction(
        () => [...document.querySelectorAll('canvas')].some((c) => c.width > 50 && c.offsetParent !== null),
        null, { timeout: 30000 }
      ).then(() => true, () => false);
      await page.waitForTimeout(1500);
      const loaded = await page.waitForFunction(() => /^Dimensions: [\d.]+ × [\d.]+ × [\d.]+ mm$/.test(document.getElementById('preview-dimensions')?.textContent || '')
        && getComputedStyle(document.getElementById('preview-loading')).display === 'none', null, { timeout: 30000 })
        .then(() => true, async () => page.textContent('#preview-loading').catch(() => ''));
      check(`3D preview opens: ${path.basename(filePath)}`, opened && loaded === true, [String(loaded), ...errors.slice(errorsBefore)].join(' | '));
      if (process.env.E2E_DEBUG) console.log(`     errors while open: ${errors.length - errorsBefore}`);
      if (filePath === tiles[0] && loaded === true) {
        // Studio (React, src/web/preview/PreviewDialog.tsx): settings apply and are saved; Save Image downloads a PNG.
        await page.click('#preview-toggle-studio');
        const studioOpen = await page.isVisible('#preview-studio-panel');
        await page.click('#preview-studio-backdrop [data-backdrop="mint"]');
        const savedBackdrop = await page.evaluate(() => JSON.parse(localStorage.getItem('justtprint.previewStudio.v5') || '{}').backdrop);
        check('the Studio panel opens and saves its settings', studioOpen && savedBackdrop === 'mint'
          && await page.getAttribute('#preview-studio-backdrop [data-backdrop="mint"]', 'aria-checked') === 'true', String(savedBackdrop));
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
    const firstCard = await page.waitForSelector('.file-grid .file-item-detailed', { timeout: 10000 }).catch(() => null);
    check('detailed view shows cards', !!firstCard && (await page.locator('.file-grid .file-item-detailed').count()) === 3);
    if (firstCard) {
      const cardPath = await firstCard.getAttribute('data-filepath');
      const card = `.file-grid .file-item-detailed[data-filepath="${cardPath.replace(/"/g, '\\"')}"]`;
      await page.click(`${card} .file-name`);
      check('clicking a card selects it and shows its details', await page.isVisible(`${card}.selected`) && await page.isVisible('#model-details'));
      // Details panel fields (React, src/web/details/DetailsFields.tsx).
      const panelModel = async () => (await invoke(base, session, 'get-model', [cardPath])).result || {};
      const shownName = await page.waitForFunction((name) => document.getElementById('model-name')?.value === name, path.basename(cardPath), { timeout: 10000 })
        .then(() => true).catch(async () => page.inputValue('#model-name').catch((e) => e.message));
      check('details show the model name', shownName === true, shownName);
      // The JusttPrint 5 panel (React, src/web/details/ModelDetailsPanel.tsx): title, Details list, slicer dropdown.
      const cardFile = path.basename(cardPath);
      check('the panel shows the name as its title and the file in the Details list',
        await page.waitForFunction((name) => document.querySelector('#model-details .jp-details__title')?.textContent === name.replace(/\.[^.]+$/, ''), cardFile, { timeout: 10000 }).then(() => true, () => false)
        && (await page.textContent('#model-details .jp-prop:has(.jp-prop__label:text-is("File")) .jp-prop__value')) === cardFile
        && await page.isVisible('#model-details .jp-props #model-designer') && await page.isVisible('#model-details .jp-details__tags #details-add-tag'));
      await page.click('#model-details .jp-split__more');
      check('Open in Slicer offers to set up a slicer when none is configured', await page.isVisible('.jp-menu [role="menuitem"]:has-text("Set up a slicer")'));
      await page.keyboard.press('Escape');
      await page.fill('#model-source', 'https://example.com/e2e-source');
      await page.press('#model-source', 'Enter');
      const savedSource = await waitFor(async () => ((await panelModel()).source === 'https://example.com/e2e-source' ? true : null), 10000, 'source').catch(async () => JSON.stringify({ shown: await page.inputValue('#model-source'), saved: (await panelModel()).source }));
      check('details save the source URL', savedSource === true, savedSource);
      await page.click('#details-add-designer');
      const designerPrompt = await page.waitForSelector('dialog.browser-input-dialog[open] input', { timeout: 10000 }).catch(() => null);
      if (designerPrompt) {
        await designerPrompt.fill('E2E Panel Designer');
        await page.click('dialog.browser-input-dialog[open] button[type=submit]');
      }
      const designerSaved = await waitFor(async () => ((await panelModel()).designer === 'E2E Panel Designer' ? true : null), 10000, 'designer').catch(() => false);
      // The panel and the card redraw after the save (the designer list reloads first), so wait for them.
      const designerShown = await page.waitForFunction((cardSelector) => document.getElementById('model-designer')?.value === 'E2E Panel Designer'
        && /E2E Panel Designer/.test(document.querySelector(`${cardSelector} .designer-info`)?.textContent || ''), card, { timeout: 10000 })
        .then(() => true).catch(async () => JSON.stringify({
          select: await page.inputValue('#model-designer').catch(() => null),
          card: await page.textContent(`${card} .designer-info`).catch(() => null)
        }));
      check('details add a new designer', designerSaved === true && designerShown === true, `saved: ${designerSaved}, shown: ${designerShown}`);
      await page.selectOption('#model-designer', '');
      await waitFor(async () => (!(await panelModel()).designer ? true : null), 10000, 'designer cleared').catch(() => {});
      // The list offers designers in use: give another model one to pick.
      const listedOn = (await page.$$eval('.file-grid [data-filepath]', (els) => els.map((el) => el.getAttribute('data-filepath')))).find((p) => p !== cardPath);
      await invoke(base, session, 'update-models-batch', [[{ filePath: listedOn, designer: 'E2E Listed Designer' }]]);
      await page.click('.form-group:has(#model-designer) .list-button');
      const listItem = await page.waitForSelector('#searchable-list-dialog[open] li:text-is("E2E Listed Designer")', { timeout: 10000 }).catch(() => null);
      if (listItem) await listItem.click();
      else await page.evaluate(() => document.getElementById('searchable-list-dialog')?.close());
      const pickSaved = await waitFor(async () => ((await panelModel()).designer === 'E2E Listed Designer' ? true : null), 10000, 'designer picked').catch(() => false);
      const pickShown = await page.waitForFunction(() => document.getElementById('model-designer')?.value === 'E2E Listed Designer', null, { timeout: 10000 })
        .then(() => true).catch(() => false);
      check('details pick a designer from the list', !!listItem && pickSaved === true && pickShown,
        JSON.stringify({ found: !!listItem, saved: pickSaved, shown: pickShown }));
      await page.click('#details-add-tag');
      const tagPrompt = await page.waitForSelector('dialog.browser-input-dialog[open] input', { timeout: 10000 }).catch(() => null);
      if (tagPrompt) {
        await tagPrompt.fill('e2e-panel-tag');
        await page.click('dialog.browser-input-dialog[open] button[type=submit]');
      }
      const hasPanelTag = async () => ((await panelModel()).tags || []).some((t) => (t.name || t) === 'e2e-panel-tag');
      check('details create and add a tag', await waitFor(async () => ((await hasPanelTag()) ? true : null), 10000, 'tag added').catch(() => false) === true
        && await page.isVisible('#model-tags .tag[data-tag-name="e2e-panel-tag"]'));
      await page.click('#model-tags .tag[data-tag-name="e2e-panel-tag"] .tag-remove');
      check('details remove a tag', await waitFor(async () => (!(await hasPanelTag()) ? true : null), 10000, 'tag removed').catch(() => false) === true
        && !(await page.isVisible('#model-tags .tag[data-tag-name="e2e-panel-tag"]')));
      // Print status and history in the details panel, and the Log Print dialog (React, src/web/print/PrintHistory.tsx).
      await page.selectOption('#model-print-status', 'queued');
      const queued = await waitFor(async () => ((await panelModel()).print_status === 'queued' ? true : null), 10000, 'status').catch(() => false);
      check('details set the print status', queued === true
        && await page.waitForFunction((sel) => document.querySelector(`${sel} .print-status`)?.textContent === 'In Queue', card, { timeout: 10000 }).then(() => true, () => false));
      const printsBefore = Number((await panelModel()).print_count) || 0;
      await page.click('#jp-details-log-print');
      const logDialog = await page.waitForSelector('#log-print-dialog[open]', { timeout: 10000 }).catch(() => null);
      check('log print dialog opens from the details panel', !!logDialog && await page.textContent('#log-print-title') === 'Log a print'
        && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(await page.inputValue('#log-print-when')));
      if (logDialog) {
        await page.fill('#log-print-quantity', '2');
        await page.fill('#log-print-notes', 'e2e log entry');
        await page.click('#log-print-save');
      }
      const loggedPrint = await waitFor(async () => (Number((await panelModel()).print_count) === printsBefore + 2 ? true : null), 10000, 'print logged')
        .catch(async () => `print_count ${(await panelModel()).print_count}, before ${printsBefore}`);
      const historyItem = '#print-history-list .print-history-item:has(.print-history-notes:text-is("e2e log entry"))';
      const historyShown = await page.waitForSelector(historyItem, { timeout: 10000 }).then(() => true, () => false);
      check('logging a print saves it and lists it in the history', loggedPrint === true && historyShown && !(await page.isVisible('#log-print-dialog'))
        && /×2/.test(await page.textContent(`${historyItem} .print-history-outcome`).catch(() => ''))
        && await page.inputValue('#model-print-status') === 'printed', String(loggedPrint));
      await page.click(`${historyItem} .print-history-delete`);
      const confirmDelete = await page.waitForSelector('dialog[id^="browser-message-"][open] button:text-is("Delete")', { timeout: 10000 }).catch(() => null);
      if (confirmDelete) await confirmDelete.click();
      const deletedPrint = await waitFor(async () => ((Number((await panelModel()).print_count) || 0) === printsBefore ? true : null), 10000, 'print deleted').catch(() => false);
      check('deleting a history entry removes it', !!confirmDelete && deletedPrint === true
        && await page.waitForSelector(historyItem, { state: 'detached', timeout: 10000 }).then(() => true, () => false));
      await page.click(`${card} .print-status`, { modifiers: ['Shift'] });
      const wantItem = await page.waitForSelector('.print-status-menu .print-status-menu-item:text-is("Want")', { timeout: 10000 }).catch(() => null);
      if (wantItem) await wantItem.click();
      const wanted = await waitFor(async () => ((await panelModel()).print_status === 'want' ? true : null), 10000, 'badge status').catch(() => false);
      check('shift-click on a card badge sets the status', !!wantItem && wanted === true && !(await page.isVisible('.print-status-menu'))
        && await page.waitForFunction(() => document.getElementById('model-print-status')?.value === 'want', null, { timeout: 10000 }).then(() => true, () => false));
      await invoke(base, session, 'set-print-status', [{ filePath: cardPath, printStatus: 'unprinted' }]);
      check('the details panel has no Filament section', !(await page.$('#filament-select')) && !(await page.$('#details-filaments-slot'))
        && !(await page.isVisible('#model-details .jp-details__heading:text-is("Filament")')));
      // Notes in the details panel and the Edit Notes dialog (React, src/web/details/DetailsNotes.tsx).
      const notesBefore = (await panelModel()).notes || '';
      await page.click('#model-notes-preview');
      const notesEditor = await page.waitForSelector('#notes-modal-dialog[open] #notes-richtext', { timeout: 10000 }).catch(() => null);
      check('clicking the notes preview opens the editor', !!notesEditor);
      if (notesEditor) {
        await page.evaluate(() => { document.getElementById('notes-richtext').innerHTML = ''; });
        await page.focus('#notes-richtext');
        await page.keyboard.type('Hello ');
        await page.click('#notes-modal-dialog .notes-toolbar [data-md="bold"]');
        await page.keyboard.type('world');
        await page.click('#save-notes-button');
      }
      const notesSaved = await waitFor(async () => ((await panelModel()).notes === 'Hello **world**' ? true : null), 10000, 'notes saved')
        .catch(async () => JSON.stringify((await panelModel()).notes));
      check('the notes editor saves Markdown and the preview renders it', notesSaved === true && !(await page.isVisible('#notes-modal-dialog'))
        && await page.isVisible('#model-notes-preview strong:text-is("world")'), String(notesSaved));
      await page.click('#open-notes-modal-button');
      await page.waitForSelector('#notes-modal-dialog[open]', { timeout: 10000 }).catch(() => {});
      const editorHtml = await page.innerHTML('#notes-richtext').catch(() => '');
      await page.focus('#notes-richtext');
      await page.keyboard.type(' discarded');
      await page.click('#cancel-notes-button');
      await page.waitForTimeout(500);
      check('cancel leaves the notes unchanged', /<strong>world<\/strong>/.test(editorHtml) && (await panelModel()).notes === 'Hello **world**'
        && !(await page.isVisible('#notes-modal-dialog')), editorHtml);
      await invoke(base, session, 'update-models-batch', [[{ filePath: cardPath, notes: notesBefore }]]);
      // Path row (React, src/web/details/DetailsPath.tsx): folders, then the file; a folder click filters the grid.
      const cardDir = path.dirname(cardPath);
      const pathFolder = `#path-tree-container .path-tree-folder[data-path="${cardDir.replace(/"/g, '\\"')}"]`;
      check('details show the path', await page.isVisible(`#path-tree-container .path-tree-file:text-is("${path.basename(cardPath)}")`)
        && await page.isVisible(pathFolder) && await page.getAttribute('#path-tree-container', 'data-file-path') === cardPath);
      await page.click(pathFolder);
      const folderFiltered = await page.waitForFunction((dir) => window.currentDirectoryFilter === dir, cardDir, { timeout: 10000 }).then(() => true, () => false);
      check('clicking a folder in the path shows that folder', folderFiltered);
      // Folder tree (React, src/web/folders/): the select, Reveal in folders, the popover, the rail and the panel widths.
      const treeRow = (scope) => `${scope} .folder-tree-row[data-path="${cardDir.replace(/"/g, '\\"')}"]`;
      check('the Folders select follows the folder shown', (await page.inputValue('#folder-select')) === cardDir);
      await page.click('#reveal-in-folders-button');
      check('Reveal in folders opens the folder panel at the model\'s folder',
        await page.waitForSelector(`${treeRow('#folder-rail')}.is-selected`, { timeout: 10000 }).then(() => true, () => false)
        && await page.evaluate(() => document.body.classList.contains('folder-rail-open')));
      await page.click('#folder-rail-close');
      const railSetting = await waitFor(async () => ((await invoke(base, session, 'get-setting', ['folderRailOpen'])).result === 'false' ? true : null), 5000, 'rail setting').catch(() => false);
      check('closing the folder panel hides it and saves that', railSetting === true && !(await page.isVisible('#folder-rail')));
      await openFilters();
      check('the Filter button opens the filters', await page.isVisible('#jp-filter-popover #folder-select') && await page.isVisible('#jp-filter-popover #sort-select'));
      await page.selectOption('#folder-select', '');
      check('"All folders" clears the folder', await page.waitForFunction(() => window.currentDirectoryFilter === '', null, { timeout: 10000 }).then(() => true, () => false));
      await page.click('#folder-tree-button');
      await page.waitForSelector('#folder-tree-popover', { timeout: 5000 }).catch(() => {});
      await page.click('#folder-tree-button');
      check('the ☰ button opens and closes the folder popover', await page.waitForSelector('#folder-tree-popover', { state: 'detached', timeout: 5000 }).then(() => true, () => false));
      await page.click('#folder-tree-button');
      await page.fill('#folder-tree-search', path.basename(cardDir));
      await page.click(treeRow('#folder-tree-popover'));
      check('picking a folder in the popover shows it and closes the popover',
        await page.waitForFunction((dir) => window.currentDirectoryFilter === dir, cardDir, { timeout: 10000 }).then(() => true, () => false)
        && !(await page.isVisible('#folder-tree-popover')));
      await page.keyboard.press('Escape');
      check('Escape closes the Filter popover', !(await page.isVisible('#jp-filter-popover')));
      await page.click('#folder-rail-toggle');
      check('the Folders button opens the folder panel beside the grid',
        await page.waitForSelector(`${treeRow('#folder-rail')}.is-selected`, { timeout: 10000 }).then(() => true, () => false)
        && await page.evaluate(() => document.body.classList.contains('folder-rail-open')));
      await page.click('#folder-rail-toggle');
      await page.waitForSelector('#folder-rail', { state: 'hidden', timeout: 5000 }).catch(() => {});
      // The details panels are the right column (src/web/styles/library-frame.css), at the spec's 360 px.
      const column = await page.locator('.sidebar').boundingBox();
      check('the details column sits at the right edge, 360 px wide', !!column && Math.round(column.width) === 360 && Math.round(column.x + column.width) === 1400, JSON.stringify(column));
      // Library header (src/web/pages/LibraryPage.tsx): the model count.
      const totalModels = (await invoke(base, session, 'getTotalModelCount', [])).result;
      const counted = await page.waitForFunction((n) => /^\d+ models?$/.test(document.getElementById('jp-library-count')?.textContent || '')
        && document.getElementById('jp-library-count')?.title === `${n} models in the library`, totalModels, { timeout: 10000 }).then(() => true, () => false);
      check('the header shows the models in view and in total', counted, await page.textContent('#jp-library-count'));
      await runSetting('Scan a Folder');
      const scanPicker = await page.waitForSelector('dialog.jp-folder-picker[open]:has-text("Scan Directory")', { timeout: 10000 }).catch(() => null);
      await page.fill('#folder-picker-path', browseDir);
      await page.press('#folder-picker-path', 'Enter');
      const pickerListed = await page.waitForSelector('#folder-picker-list .jp-folder-picker__folder:has-text("Prints")', { timeout: 10000 }).then(() => true, () => false);
      await page.click('#folder-picker-list .jp-folder-picker__folder:has-text("Prints")');
      const pickerOpened = await page.waitForFunction((dir) => document.getElementById('folder-picker-path')?.value === dir,
        path.join(browseDir, 'Prints'), { timeout: 10000 }).then(() => true, () => false);
      await page.fill('#folder-picker-path', '/etc');
      await page.press('#folder-picker-path', 'Enter');
      const pickerRefused = await page.waitForSelector('.jp-folder-picker__error:has-text("cannot be browsed")', { timeout: 10000 }).then(() => true, () => false)
        && await page.isVisible('#folder-picker-list .jp-folder-picker__folder:has-text("Benchy")');
      await page.click('dialog.jp-folder-picker[open] .jp-overlay__footer button:has-text("Cancel")');
      check('Scan a Folder opens Choose Folder: a typed path lists its folders, a click opens one, a system folder is refused, Cancel scans nothing',
        !!scanPicker && pickerListed && pickerOpened && pickerRefused && !(await page.isVisible('dialog.jp-folder-picker[open]')));
      await runSetting('View Entire Library');
      check('View Entire Library leaves the folder', await page.waitForFunction(() => window.currentDirectoryFilter === '', null, { timeout: 10000 }).then(() => true, () => false));
      await showLibrary();
      await page.evaluate(async () => { window.currentDirectoryFilter = ''; await window.performCombinedSearch?.(); });
      await page.waitForSelector(card, { timeout: 10000 }).catch(() => {});
      // Model menu (React, src/web/menus/ContextMenu.tsx): right-click, a destructive item asks first, Escape closes.
      await page.click(`${card} .file-name`, { button: 'right' });
      check('right-clicking a card shows the model menu', await page.waitForSelector('#html-context-menu .html-context-menu-item:text-is("Preview")', { timeout: 10000 }).then(() => true, () => false));
      await page.click('#html-context-menu .html-context-menu-item:text-is("Remove from Library")');
      const removeAsk = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("Confirm Remove") button:text-is("No")', { timeout: 10000 }).catch(() => null);
      if (removeAsk) await removeAsk.click();
      await page.waitForSelector('#html-context-menu', { state: 'detached', timeout: 5000 }).catch(() => {});
      check('Remove from Library asks first, and No keeps the model', !!removeAsk && !(await page.isVisible('#html-context-menu'))
        && !!(await invoke(base, session, 'get-model', [cardPath])).result);
      await page.click(`${card} .file-name`, { button: 'right' });
      await page.waitForSelector('#html-context-menu', { timeout: 10000 }).catch(() => {});
      await page.keyboard.press('Escape');
      check('Escape closes the model menu', await page.waitForSelector('#html-context-menu', { state: 'detached', timeout: 5000 }).then(() => true, () => false));
      // Copy Path and Download run in this browser; another open browser gets nothing.
      const secondPage = await page.context().newPage();
      const secondDownloads = [];
      secondPage.on('download', (download) => secondDownloads.push(download.suggestedFilename()));
      await secondPage.goto(base + '/');
      await secondPage.waitForSelector(card, { timeout: 30000 }).catch(() => {});
      await page.evaluate(() => {
        window.__copiedText = null;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copiedText = text; } } });
      });
      await page.click(`${card} .file-name`, { button: 'right' });
      await page.click('#html-context-menu .html-context-menu-item:text-is("Copy Path")');
      check('Copy Path copies the model\'s path', await page.waitForFunction((p) => window.__copiedText === p, cardPath, { timeout: 5000 }).then(() => true, () => false),
        await page.evaluate(() => window.__copiedText));
      await page.click(`${card} .file-name`, { button: 'right' });
      const [menuDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
        page.click('#html-context-menu .html-context-menu-item:text-is("Download")')
      ]);
      await secondPage.waitForTimeout(1500);
      check('Download saves the file in this browser only', menuDownload?.suggestedFilename() === path.basename(cardPath) && secondDownloads.length === 0,
        JSON.stringify({ here: menuDownload?.suggestedFilename(), secondPage: secondDownloads }));
      await secondPage.close();
      await invoke(base, session, 'update-models-batch', [[{ filePath: cardPath, designer: null, source: null }, { filePath: listedOn, designer: null }]]);
      await page.click(`${card} .model-star[data-star="3"]`);
      const rated = await waitFor(async () => (((await invoke(base, session, 'get-model', [cardPath])).result || {}).rating === 3 ? true : null), 10000, 'rating').catch(() => false);
      check('a card saves its star rating', rated === true && (await page.locator(`${card} .model-star.is-filled`).count()) === 3);
      await page.click(`${card} .model-favorite-btn`);
      const favorited = await waitFor(async () => (((await invoke(base, session, 'get-model', [cardPath])).result || {}).favorite ? true : null), 10000, 'favorite').catch(() => false);
      // The card redraws after the save, so wait for it rather than reading it once.
      check('a card saves its favorite', favorited === true && await page.waitForSelector(`${card} .model-favorite-btn.is-favorited`, { timeout: 5000 }).then(() => true, () => false));
      // The favorite redraws the grid; wait for the cards before picking a second one.
      await page.waitForFunction(() => document.querySelectorAll('.file-grid .file-item-detailed').length >= 2, null, { timeout: 10000 }).catch(() => {});
      const other = (await page.$$eval('.file-grid .file-item-detailed', (els) => els.map((el) => el.getAttribute('data-filepath')))).find((p) => p !== cardPath);
      // Selection (src/web/selection.ts): the cards follow it.
      const selectedPaths = () => page.$$eval('.file-grid .file-item.selected', (els) => els.map((el) => el.getAttribute('data-filepath')));
      await page.evaluate(() => window.selection.clear());
      await page.click(`${card} .file-name`);
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('ArrowDown');
      const movedTo = await page.waitForFunction((from) => {
        const path = document.getElementById('path-tree-container')?.getAttribute('data-file-path');
        return path && path !== from ? path : null;
      }, cardPath, { timeout: 10000 }).then((h) => h.jsonValue(), () => null);
      await page.evaluate(() => window.libraryGrid?.refresh());
      const afterArrow = await selectedPaths();
      check('arrow keys move the selection to the next model', !!movedTo && afterArrow.length === 1 && afterArrow[0] === movedTo, JSON.stringify({ movedTo, afterArrow }));
      await page.click(`.file-grid .file-item-detailed[data-filepath="${String(movedTo).replace(/"/g, '\\"')}"] .file-name`);
      await page.waitForTimeout(300);
      check('clicking the selected card again unselects it', (await selectedPaths()).length === 0 && !(await page.isVisible('#model-details')));
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
      const allSelected = await page.waitForFunction(() => document.querySelector('#multi-edit-panel .selected-count')?.textContent?.trim() === '3 models selected', null, { timeout: 10000 }).then(() => true, () => false);
      check('Ctrl/Cmd+A selects every model shown and opens multi-edit', allSelected && (await selectedPaths()).length === 3 && await page.isVisible('#multi-edit-panel'));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      check('Escape clears the selection', (await selectedPaths()).length === 0 && !(await page.isVisible('#multi-edit-panel')));
      await runSetting('Print Roulette');
      const rouletteDone = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("Print Roulette") button', { timeout: 20000 }).catch(() => null);
      const picked = await selectedPaths();
      check('Print Roulette picks one model and shows it', !!rouletteDone && picked.length === 1
        && await page.getAttribute('#path-tree-container', 'data-file-path') === picked[0], JSON.stringify(picked));
      if (rouletteDone) await rouletteDone.click();
      await showLibrary();

      // Sidebar filters (React, src/web/filters/): the grid, the filter strip and the saved settings follow them.
      const third = (await page.$$eval('.file-grid .file-item-detailed[data-filepath]', (els) => els.map((el) => el.getAttribute('data-filepath'))))
        .find((p) => p !== cardPath && p !== other);
      const shownPaths = () => page.$$eval('.file-grid .file-item-detailed[data-filepath]', (els) => els.map((el) => el.getAttribute('data-filepath')).sort());
      const waitShown = (paths) => page.waitForFunction((want) => {
        const have = [...document.querySelectorAll('.file-grid .file-item-detailed[data-filepath]')].map((el) => el.getAttribute('data-filepath')).sort();
        return JSON.stringify(have) === JSON.stringify([...want].sort());
      }, paths, { timeout: 10000 }).then(() => true, async () => JSON.stringify(await shownPaths()));
      const stripText = () => page.textContent('#current-filter-body').then((t) => t.replace(/\s+/g, ' ').trim());
      await invoke(base, session, 'update-models-batch', [[
        { filePath: other, designer: 'E2E Sidebar Designer', tags: ['e2e-s1'] },
        { filePath: third, tags: ['e2e-s1', 'e2e-s2'] }
      ]]);
      await page.evaluate(() => window.libraryFilters.reloadOptions());
      await page.waitForSelector('#designer-select option[value="E2E Sidebar Designer"]', { state: 'attached', timeout: 10000 }).catch(() => {});
      await openFilters();
      await page.selectOption('#designer-select', 'E2E Sidebar Designer');
      const byDesigner = await waitShown([other]);
      check('the designer filter narrows the grid and shows in the filter strip', byDesigner === true
        && /Showing 1 models.*Designer: E2E Sidebar Designer/.test(await stripText()), `${byDesigner} ${await stripText()}`);
      await page.click('#current-filter-body .filter-pill:has-text("Designer:") .filter-remove');
      check('removing a filter chip shows the library again', await waitShown([cardPath, other, third]) === true && !(await page.isVisible('#current-filter-body .filter-pill')));
      const cardName = path.basename(cardPath);
      await openFilters();
      await page.fill('#search-filter-input', cardName);
      await page.press('#search-filter-input', 'Enter');
      check('a search narrows the grid and becomes a chip', await waitShown([cardPath]) === true && await page.inputValue('#search-filter-input') === ''
        && (await stripText()).includes(`Search: "${cardName}"`));
      await page.click('#search-add-or-btn');
      const awaitingHint = await page.isVisible('#search-boolean-hint');
      await openFilters();
      await page.selectOption('#designer-select', 'E2E Sidebar Designer');
      const orResult = await waitShown([cardPath, other]);
      check('OR then a filter pick adds it to the query', awaitingHint && orResult === true
        && /Search: ".*".*OR.*Designer: E2E Sidebar Designer/.test(await stripText()) && await page.inputValue('#designer-select') === '',
        `${awaitingHint} ${orResult} ${await stripText()}`);
      await page.click('#invert-filter-button');
      const inverted = await waitShown([third]);
      check('Invert Filters inverts the query', inverted === true && (await stripText()).includes('NOT')
        && await page.getAttribute('#invert-filter-button', 'class') === 'active', `${inverted} ${await stripText()}`);
      await page.click('#clear-all-filters-button');
      check('Clear All Filters shows the whole library', await waitShown([cardPath, other, third]) === true
        && !(await page.isVisible('#clear-all-filters-button')) && !(await page.getAttribute('#invert-filter-button', 'class')));
      await openFilters();
      await page.selectOption('#tag-filter', 'e2e-s1');
      const oneTag = await waitShown([other, third]);
      await page.selectOption('#tag-filter', 'e2e-s2');
      const bothTags = await waitShown([third]);
      check('two tags must both match by default', oneTag === true && bothTags === true && await page.isVisible('#tags-combine-row')
        && (await page.locator('#tags-filter-chips .filter-value-chip').count()) === 2, `${oneTag} ${bothTags}`);
      await page.check('#tags-combine-row input[value="OR"]');
      check('Any tag matches either tag', await waitShown([other, third]) === true && (await stripText()).includes('(any)'));
      await page.click('#clear-all-filters-button');
      await waitShown([cardPath, other, third]);
      await openFilters();
      await page.selectOption('#sort-select', 'name-asc');
      const savedSort = await waitFor(async () => ((await invoke(base, session, 'get-setting', ['sortOption'])).result === 'name-asc' ? true : null), 10000, 'sort saved').catch(() => false);
      const sortedNames = await page.waitForFunction(() => {
        const names = [...document.querySelectorAll('.file-grid .file-item-detailed .file-name')].map((el) => el.textContent.trim().toLowerCase());
        return JSON.stringify(names) === JSON.stringify([...names].sort()) ? names : null;
      }, null, { timeout: 10000 }).then((h) => h.jsonValue(), async () => page.$$eval('.file-grid .file-item-detailed .file-name', (els) => els.map((el) => el.textContent.trim())));
      check('the sort order applies and is saved', savedSort === true && JSON.stringify(sortedNames) === JSON.stringify([...sortedNames].sort()), JSON.stringify(sortedNames));
      await page.selectOption('#sort-select', 'date-desc');
      await page.uncheck('#search-include-notes');
      const notesSettingSaved = await waitFor(async () => ((await invoke(base, session, 'get-setting', ['searchIncludeNotes'])).result === '0' ? true : null), 10000, 'notes saved').catch(() => false);
      check('the notes toggle is saved', notesSettingSaved === true);
      await page.check('#search-include-notes');
      await invoke(base, session, 'update-models-batch', [[{ filePath: other, designer: null, tags: [] }, { filePath: third, tags: [] }]]);
      await page.evaluate(() => window.libraryFilters.reloadOptions());
      // Ctrl-click is a right-click on macOS; the app takes Cmd there.
      const multiKey = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.click(`${card} .file-name`, { modifiers: [multiKey] });
      await page.click(`.file-grid .file-item-detailed[data-filepath="${other.replace(/"/g, '\\"')}"] .file-name`, { modifiers: [multiKey] });
      check('Ctrl/Cmd-click selects several cards for multi-edit', (await page.locator('.file-grid .file-item.selected').count()) === 2 && await page.isVisible('#multi-edit-panel'));
      // Multi-edit panel (React, src/web/details/MultiEditPanel.tsx): each change applies to both selected models.
      const pair = [cardPath, other];
      const pairModels = async () => Promise.all(pair.map(async (p) => (await invoke(base, session, 'get-model', [p])).result || {}));
      const pairBefore = await pairModels();
      check('the multi-edit panel counts the selection', /^2 models selected$/.test((await page.textContent('#multi-edit-panel .selected-count')).trim()));
      // The server asks every page to refresh its grid (after a scan, an MCP edit, ...): the selection stays.
      await page.evaluate(() => Promise.all(((window._electronEventListeners || {})['refresh-grid'] || []).map((listener) => listener())));
      await page.waitForTimeout(1000);
      check('a server grid refresh keeps the multi-edit selection', (await page.locator('.file-grid .file-item.selected').count()) === 2
        && await page.isVisible('#multi-edit-panel') && /^2 models selected$/.test((await page.textContent('#multi-edit-panel .selected-count')).trim()),
        JSON.stringify(await page.evaluate(() => ({ selected: window.selection.size, highlighted: document.querySelectorAll('.file-grid .file-item.selected').length }))));
      await page.click('#multi-designer-add');
      const multiPrompt = await page.waitForSelector('dialog.browser-input-dialog[open] input', { timeout: 10000 }).catch(() => null);
      if (multiPrompt) {
        await multiPrompt.fill('E2E Multi Designer');
        await page.click('dialog.browser-input-dialog[open] button[type=submit]');
      }
      const multiDesigner = await waitFor(async () => ((await pairModels()).every((m) => m.designer === 'E2E Multi Designer') ? true : null), 10000, 'multi designer').catch(() => false);
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
      await invoke(base, session, 'update-models-batch', [pairBefore.map((m) => ({ filePath: m.filePath, designer: m.designer || null, tags: m.tags || [] }))]);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      check('Escape leaves multi-edit', !(await page.isVisible('#multi-edit-panel')));
      await invoke(base, session, 'update-models-batch', [[{ filePath: cardPath, rating: 0, favorite: 0 }]]);

      // A model with several images shows a carousel; the image left showing becomes the default.
      const images = await page.evaluate(() => ['#d33', '#33d'].map((color) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 64, 64);
        return canvas.toDataURL('image/png');
      }));
      await invoke(base, session, 'add-multiple-thumbnails', [cardPath, images]);
      const total = ((await invoke(base, session, 'get-all-thumbnails', [cardPath])).result || []).length;
      await page.evaluate(() => window.performCombinedSearch({ force: true }));
      const badge = await page.waitForSelector(`${card} .thumbnail-count-badge`, { timeout: 15000 }).catch(() => null);
      check('a card with several images shows the carousel', !!badge && (await badge.textContent()).trim() === `1/${total}`, badge && await badge.textContent());
      if (badge) {
        await page.click(`${card} .thumbnail-nav-right`);
        check('the carousel steps to the next image', (await page.textContent(`${card} .thumbnail-count-badge`)).trim() === `2/${total}`);
        const second = await page.getAttribute(`${card} .thumbnail-container img`, 'src');
        const saved = await waitFor(async () => {
          const thumbnail = ((await invoke(base, session, 'get-model', [cardPath])).result || {}).thumbnail || '';
          return thumbnail.split('::')[0] === second ? true : null;
        }, 10000, 'default image').catch(() => false);
        check('the image left showing becomes the default', saved === true);
        // Manage Thumbnails (React, src/web/ManageThumbnailsDialog.tsx).
        const storedImages = async () => ((await invoke(base, session, 'get-all-thumbnails', [cardPath])).result || []).filter((t) => String(t).startsWith('data:image'));
        await page.evaluate((p) => window.openManageThumbnails(p), cardPath);
        const manage = await page.waitForSelector('#manage-thumbnails-dialog[open] .thumbnail-item', { timeout: 10000 }).catch(() => null);
        const beforeManage = await storedImages();
        check('Manage Thumbnails lists the images with the active one first', !!manage
          && (await page.locator('#manage-thumbnails-dialog .thumbnail-item').count()) === beforeManage.length
          && (await page.textContent('#manage-thumbnails-dialog .thumbnail-item.active .thumbnail-item-label')) === 'Active');
        await page.click('#manage-thumbnails-dialog .thumbnail-item[data-index="1"] .set-active', { force: true });
        const activated = await waitFor(async () => ((await storedImages())[0] === beforeManage[1] ? true : null), 10000, 'set active').catch(() => false);
        check('Manage Thumbnails sets another image as active', activated === true);
        await page.waitForSelector('#manage-thumbnails-dialog .thumbnail-item[data-index="1"] .delete:not([disabled])', { state: 'attached', timeout: 10000 }).catch(() => {});
        await page.click('#manage-thumbnails-dialog .thumbnail-item[data-index="1"] .delete', { force: true });
        const confirmThumbDelete = await page.waitForSelector('dialog[id^="browser-message-"][open] button:text-is("Delete")', { timeout: 10000 }).catch(() => null);
        if (confirmThumbDelete) await confirmThumbDelete.click();
        const deletedImage = await waitFor(async () => ((await storedImages()).length === beforeManage.length - 1 ? true : null), 10000, 'delete image').catch(() => false);
        const listShrunk = await page.waitForFunction((n) => document.querySelectorAll('#manage-thumbnails-dialog .thumbnail-item').length === n, beforeManage.length - 1, { timeout: 10000 }).then(() => true, () => false);
        check('Manage Thumbnails deletes an image after asking', !!confirmThumbDelete && deletedImage === true && listShrunk,
          JSON.stringify({ confirm: !!confirmThumbDelete, saved: deletedImage, listShrunk, before: beforeManage.length, after: (await storedImages()).length }));
        await page.click('#manage-thumbnails-dialog .dialog-buttons button');
        const cardShowsActive = await page.waitForFunction(([sel, src]) => document.querySelector(`${sel} .thumbnail-container img`)?.getAttribute('src') === src,
          [card, beforeManage[1]], { timeout: 10000 }).then(() => true, () => false);
        check('closing Manage Thumbnails redraws the card with the active image', !(await page.isVisible('#manage-thumbnails-dialog')) && cardShowsActive);
      }
    }
    // Group cards (React, GroupCard.tsx): two models with one parent model show as a group.
    const grouped = (await page.$$eval('.file-grid .file-item-detailed[data-filepath]', (els) => els.map((el) => el.getAttribute('data-filepath')))).slice(0, 2);
    await invoke(base, session, 'update-models-batch', [grouped.map((filePath) => ({ filePath, parentModel: 'E2E Group' }))]);
    await page.evaluate(() => window.performCombinedSearch({ force: true }));
    const groupCard = '.file-grid .parent-model-group-detailed[data-group-key="parent:e2e group"]';
    const groupShown = await page.waitForSelector(groupCard, { timeout: 15000 }).catch(() => null);
    check('models with one parent model show as a group card', !!groupShown && /2 models/.test(await page.textContent(`${groupCard} .parent-model-group-meta`)));
    if (groupShown) {
      await page.click(`${groupCard} .parent-model-group-meta`);
      const children = await page.waitForFunction(() => document.querySelectorAll('.file-grid .file-item.parent-model-group-child').length === 2, null, { timeout: 10000 })
        .then(() => true).catch(() => false);
      check('clicking a group expands it to its models', children && await page.isVisible(`${groupCard}.expanded`));
      await page.click(`${groupCard} .model-star[data-star="4"]`);
      const groupRated = await waitFor(async () => {
        const ratings = await Promise.all(grouped.map(async (filePath) => ((await invoke(base, session, 'get-model', [filePath])).result || {}).rating));
        return ratings.every((rating) => rating === 4) ? true : null;
      }, 10000, 'group rating').catch(() => false);
      check('rating a group rates every model in it', groupRated === true);
      await page.click(`${groupCard} .parent-model-group-chevron`);
      const collapsed = await page.waitForFunction(() => document.querySelectorAll('.file-grid .file-item.parent-model-group-child').length === 0, null, { timeout: 10000 })
        .then(() => true).catch(() => false);
      check('the chevron collapses the group', collapsed && !(await page.isVisible(`${groupCard}.expanded`)));
    }
    await invoke(base, session, 'update-models-batch', [grouped.map((filePath) => ({ filePath, parentModel: null, rating: 0 }))]);
    await page.evaluate(() => window.performCombinedSearch({ force: true }));

    // Wall view: a ZIP entry's Archive label sits beside its name, not on top of it.
    await page.click('.view-button[data-view="preview"]');
    const archiveOverlap = await page.waitForSelector('.file-grid .preview-tile .preview-tile-archive', { timeout: 10000 })
      .then(() => page.evaluate(() => {
        const badge = document.querySelector('.file-grid .preview-tile .preview-tile-archive').getBoundingClientRect();
        const name = document.querySelector('.file-grid .preview-tile .preview-tile-archive').closest('.preview-tile').querySelector('.preview-tile-name').getBoundingClientRect();
        return badge.right > name.left && badge.left < name.right && badge.bottom > name.top && badge.top < name.bottom;
      }), () => null);
    check('in the Wall view the Archive label does not cover the file name', archiveOverlap === false, String(archiveOverlap));
    // Grid toolbar and list view columns (React, src/web/grid/GridToolbar.tsx, ListHeader.tsx, columns.ts).
    await page.click('.view-button[data-view="list"]');
    const listShown = await page.waitForSelector('.file-grid .list-view-header [data-list-col="name"] .sortable-header', { timeout: 10000 }).then(() => true, () => false);
    const savedView = await waitFor(async () => ((await invoke(base, session, 'get-setting', ['gridView'])).result === 'list' ? true : null), 5000, 'gridView').catch(() => false);
    check('the List button shows the list with its column header, and is saved', listShown && savedView === true
      && await page.isVisible('#list-view-columns-toolbar-btn') && await page.isVisible('.view-button.active[data-view="list"]'));
    await page.click('.list-view-header [data-list-col="name"] .sortable-header');
    const sortedByName = await page.waitForFunction(() => window.libraryFilters.state().sort === 'name-asc'
      && document.querySelector('.list-view-header [data-list-col="name"] .sort-indicator')?.textContent === '↑', null, { timeout: 5000 }).then(() => true, () => false);
    await page.click('.list-view-header [data-list-col="name"] .sortable-header');
    const sortedDesc = await page.waitForFunction(() => window.libraryFilters.state().sort === 'name-desc', null, { timeout: 5000 }).then(() => true, () => false);
    check('clicking a column title sorts by it, and again the other way', sortedByName && sortedDesc);
    await page.evaluate(() => window.libraryFilters.setSort('dateAdded DESC'));
    await page.click('#list-view-columns-toolbar-btn');
    await page.uncheck('.list-view-columns-popover input[data-col-id="size"]');
    const sizeHidden = await page.waitForFunction(() => [...document.querySelectorAll('.file-grid [data-list-col="size"]')].every((el) => el.style.display === 'none'), null, { timeout: 5000 }).then(() => true, () => false);
    const layoutSaved = await waitFor(async () => {
      const raw = (await invoke(base, session, 'get-setting', ['listViewColumnLayout'])).result;
      return raw && JSON.parse(raw).visibility.size === false ? true : null;
    }, 5000, 'column layout').catch(() => false);
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
    check('dragging a column edge widens the column in the header and rows', !!nameCell && widened > nameCell.width + 40 && Math.abs(rowWidth - widened) < 2,
      `${nameCell && nameCell.width} -> ${widened} (row ${rowWidth})`);
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
      return left('.list-view-header [data-list-col="size"]') < left('.list-view-header [data-list-col="name"]')
        && left('.file-grid .file-info [data-list-col="size"]') < left('.file-grid .file-info [data-list-col="name"]');
    });
    check('dragging a column title moves the column in the header and rows, without sorting', moved
      && await page.evaluate(() => window.libraryFilters.state().sort) === 'dateAdded DESC');
    await dragColumn('name', 'size');
    await page.click('.view-button[data-view="preview"]');
    await page.click('#preview-size-switcher [data-preview-size="s"]');
    const smallTiles = await waitFor(async () => ((await invoke(base, session, 'get-setting', ['previewTileSize'])).result === 's' ? true : null), 5000, 'tile size').catch(() => false);
    check('the tile size switcher shows smaller tiles and saves the size', smallTiles === true
      && await page.isVisible('#preview-size-switcher [data-preview-size="s"].active') && !(await page.isVisible('.list-view-header')));
    await page.click('#preview-size-switcher [data-preview-size="m"]');

    // Searchable list (React, src/web/components/ListPicker.tsx): search narrows it, Cancel picks nothing.
    await openFilters();
    await page.click('#tag-filter + .list-button, .form-group:has(#tag-filter) .list-button');
    await page.waitForSelector('#searchable-list-dialog[open] li', { timeout: 10000 }).catch(() => {});
    const allTags = await page.locator('#searchable-list-dialog li').count();
    await page.fill('#searchable-list-search', 'e2e-model');
    const narrowed = await page.locator('#searchable-list-dialog li').count();
    await page.click('#searchable-list-cancel');
    check('the searchable list narrows as you type, and Cancel closes it without a pick', allTags > 1 && narrowed >= 1 && narrowed < allTags
      && !(await page.isVisible('#searchable-list-dialog')) && (await page.evaluate(() => window.libraryFilters.state().tags.length)) === 0, `${allTags} -> ${narrowed}`);
    await page.evaluate(() => document.getElementById('preview-dialog').showModal());
    await page.click('#preview-fullscreen-toggle');
    check('the preview goes full screen', await page.evaluate(() => document.getElementById('preview-dialog').classList.contains('modal-fullscreen')));
    await page.click('#preview-fullscreen-toggle');
    await page.evaluate(() => document.getElementById('preview-dialog').close());
    // STEP previews compile WebAssembly in the parse worker ('wasm-unsafe-eval').
    const stepResult = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const worker = new Worker(window.parseWorkerUrl);
      const reply = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ success: false, error: 'timeout' }), 60000);
        worker.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
        worker.onerror = (event) => { clearTimeout(timer); resolve({ success: false, error: event.message }); };
        worker.postMessage({ id: 1, fileExtension: 'stp', arrayBuffer: bytes.buffer }, [bytes.buffer]);
      });
      worker.terminate();
      return { success: reply.success, geometries: (reply.geometries || []).length, error: reply.error };
    }, fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'step-cube.stp')).toString('base64'));
    check('STEP preview parses in the browser (WebAssembly under CSP)', stepResult.success === true && stepResult.geometries > 0, JSON.stringify(stepResult));

    // Send to Slicer in the page: the server's command becomes a justtprint:// link for the helper.
    // Its own tab: on Linux, Chrome asks whether to open the unknown link in another app, and that
    // prompt blocks mouse and keyboard input to the tab until it is closed.
    await invoke(base, session, 'save-slicer', [{ name: 'Browser Slicer', path: '/usr/bin/browser-slicer' }]);
    const slicerPage = await page.context().newPage();
    await slicerPage.goto(base + '/');
    await slicerPage.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    const helperLink = await slicerPage.evaluate(async (file) => {
      const slicers = await window.electron.getSlicers();
      const slicer = slicers.find((s) => s.name === 'Browser Slicer');
      const result = await window.electron.openFileInSlicer({ filePaths: [file], slicerId: slicer.id });
      window.electron.launchSlicerCommand(result.command);
      const frame = [...document.querySelectorAll('iframe')].find((f) => String(f.src).startsWith('justtprint://'));
      return frame ? frame.src : null;
    }, path.join(LIBRARY, 'Designer A', 'cube.stl'));
    await slicerPage.close();
    check('Send to Slicer opens a helper link with a download token', /^justtprint:\/\/open\/\?.*token=/.test(helperLink || '') && helperLink.includes('browser-slicer'), helperLink);
    const browserSlicer = ((await invoke(base, session, 'get-slicers')).result || []).find((s) => s.name === 'Browser Slicer');
    if (browserSlicer) await invoke(base, session, 'delete-slicer', [browserSlicer.id]);

    // Rename a designer through the in-page input dialog (Metadata Manager).
    const cube = path.join(LIBRARY, 'Designer A', 'cube.stl');
    await invoke(base, session, 'update-models-batch', [[{ filePath: cube, designer: 'Old Designer' }]]);
    await page.evaluate(() => window.openMetadataEditor());
    await page.waitForSelector('#metadata-editor-dialog[open]', { timeout: 15000 }).catch(() => {});
    const renameButton = await page.waitForSelector(
      '#metadata-editor-dialog .metadata-item:has-text("Old Designer") .metadata-rename', { timeout: 15000 }
    ).catch(() => null);
    if (renameButton) {
      await renameButton.click();
      const prompt = await page.waitForSelector('dialog.browser-input-dialog[open] input', { timeout: 10000 }).catch(() => null);
      check('rename opens an in-page input dialog', !!prompt);
      if (prompt) {
        await prompt.fill('New Designer');
        await page.click('dialog.browser-input-dialog[open] button[type=submit]');
        const renamed = await waitFor(async () => {
          const model = await invoke(base, session, 'get-model', [cube]);
          return model.result && model.result.designer === 'New Designer';
        }, 15000, 'designer rename').catch(() => false);
        check('designer renamed in the JusttPrint backend', renamed === true);
        const listed = await page.waitForSelector('#metadata-editor-dialog .metadata-item:has-text("New Designer")', { timeout: 10000 }).catch(() => null);
        check('Metadata Manager list shows the new name', !!listed && !(await page.isVisible('#metadata-editor-dialog .metadata-item:has-text("Old Designer")')));
        await page.fill('#metadata-editor-search', 'zzz-no-match');
        check('Metadata Manager search filters the list', await page.isVisible('#metadata-editor-dialog .no-metadata'));
        await page.click('#clear-metadata-search');
        await page.click('#metadata-editor-dialog .metadata-item:has-text("New Designer") .metadata-delete');
        const confirmClear = await page.waitForSelector('dialog[open]:has-text("Delete Designer") button:text-is("Yes")', { timeout: 10000 }).catch(() => null);
        if (confirmClear) await confirmClear.click();
        const cleared = await waitFor(async () => {
          const model = await invoke(base, session, 'get-model', [cube]);
          return model.result && !model.result.designer;
        }, 15000, 'designer cleared').catch(() => false);
        check('Metadata Manager clears a designer after asking', !!confirmClear && cleared === true);
      }
    } else {
      check('Metadata Manager lists the designer', false, 'rename button not found');
    }
    await page.evaluate(() => document.getElementById('metadata-editor-dialog')?.close());

    // Server-initiated confirmation (Pull Metadata over existing details) shows in this browser.
    const box3mf = path.join(LIBRARY, 'Designer B', 'box.3mf');
    await invoke(base, session, 'update-models-batch', [[{ filePath: box3mf, designer: 'Keep Me' }]]);
    const pull = page.evaluate((file) => window.electron.pull3MFMetadata([file]), box3mf);
    const confirmDialog = await page.waitForSelector('dialog[open]:has-text("Confirm Metadata Overwrite") button:text-is("No")', { timeout: 15000 }).catch(() => null);
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
    check('a dialog opened in one tab stays in that tab', await page.isVisible('#tag-manager-dialog') && !(await otherTab.isVisible('#tag-manager-dialog')));
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
    }
    await page.click('#tag-manager-dialog .dialog-buttons button');
    check('Tag Manager closes', !(await page.isVisible('#tag-manager-dialog')));

    // Tags page (React, src/web/pages/TagsPage.tsx): create, rename, merge, show models, delete.
    const tagNamesNow = async () => ((await invoke(base, session, 'get-all-tags')).result || []).map((t) => t.name);
    await page.click('.jp-sidebar .jp-nav__row:has-text("Tags")');
    await page.fill('#jp-new-tag', 'e2e-page-tag');
    await page.click('.jp-tags__create button[type=submit]');
    const pageTagRow = (name) => `.jp-tag-row[data-tag-name="${name}"]`;
    check('the Tags page creates a tag', /#\/tags$/.test(page.url())
      && await page.waitForSelector(pageTagRow('e2e-page-tag'), { timeout: 10000 }).then(() => true, () => false)
      && (await tagNamesNow()).includes('e2e-page-tag'));
    await page.click(`${pageTagRow('e2e-page-tag')} button[aria-label^="Rename"]`);
    await page.fill(`${pageTagRow('e2e-page-tag')} .jp-tag-row__input`, 'e2e-page-renamed');
    await page.press(`${pageTagRow('e2e-page-tag')} .jp-tag-row__input`, 'Enter');
    check('renaming a tag on the page saves it', await page.waitForSelector(pageTagRow('e2e-page-renamed'), { timeout: 10000 }).then(() => true, () => false)
      && !(await tagNamesNow()).includes('e2e-page-tag'));
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
    const mergeAsk = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("Merge Tags") button:text-is("Merge")', { timeout: 10000 }).catch(() => null);
    if (mergeAsk) await mergeAsk.click();
    check('renaming onto an existing tag merges after asking', !!mergeAsk
      && await page.waitForSelector(pageTagRow('e2e-page-renamed'), { state: 'detached', timeout: 10000 }).then(() => true, () => false)
      && (await tagNamesNow()).filter((n) => n.toLowerCase() === 'e2e-page-other').length === 1);
    // The merged tag keeps the name as typed.
    const mergedName = (await tagNamesNow()).find((n) => n.toLowerCase() === 'e2e-page-other') || 'e2e-page-other';
    await page.click(`${pageTagRow(mergedName)} button[aria-label^="Show models"]`);
    check('a tag shows its models in the library', await page.waitForFunction((name) => JSON.stringify(window.libraryFilters.state().tags) === JSON.stringify([name]), mergedName, { timeout: 10000 }).then(() => true, () => false)
      && await page.waitForFunction((p) => [...document.querySelectorAll('.file-grid [data-filepath]')].map((el) => el.getAttribute('data-filepath')).join() === p, taggedModel, { timeout: 10000 }).then(() => true, () => false));
    await page.evaluate(() => window.clearAllLibraryFilters());
    await page.click('.jp-sidebar .jp-nav__row:has-text("Tags")');
    await page.click(`${pageTagRow(mergedName)} button[aria-label^="Delete"]`);
    const deleteTagAsk = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("Delete Tag") button:text-is("Yes")', { timeout: 10000 }).catch(() => null);
    if (deleteTagAsk) await deleteTagAsk.click();
    check('deleting a used tag asks first and removes it', !!deleteTagAsk
      && await page.waitForSelector(pageTagRow(mergedName), { state: 'detached', timeout: 10000 }).then(() => true, () => false)
      && !(await tagNamesNow()).includes(mergedName));
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
      check('Parts Manager saves an edit (Enter) and flags low stock', part && part.quantity === 1 && await page.isVisible(`${row}.is-low`), JSON.stringify(part));
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
    await page.evaluate(() => { window.location.hash = '#/filament'; });
    check('#/filament opens Home', await page.waitForSelector('.jp-hero', { timeout: 10000 }).then(() => true, () => false));
    check('no filament dialogs or filters', await page.evaluate(() => !document.querySelector('dialog.jp-add-filament, #filament-manager-dialog, #filament-filter')
      && !('openFilamentManager' in window)));
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
    check('Printer Manager adds a printer', !!printerCard && voron && voron.firmware_type === 'Marlin' && voron.web_url === 'http://voron.local', JSON.stringify(voron));
    if (voron) {
      const card = `#printer-cards-list .printer-card[data-printer-id="${voron.id}"]`;
      await page.click(`${card} .printer-action-btn:has-text("Edit")`);
      check('Edit fills the printer form', (await page.textContent('#printer-form-title')) === 'Edit Printer: E2E Voron' && (await page.inputValue('#printer-form-nickname')) === 'E2E Voron');
      await page.fill('#printer-form-model', '2.4r2');
      await page.click('#printer-form-submit');
      await page.waitForSelector(`${card}:has-text("2.4r2")`, { timeout: 10000 }).catch(() => {});
      voron = (await serverPrinters()).find((p) => p.id === voron.id);
      check('Printer Manager saves an edit', voron && voron.model === '2.4r2');
      await page.click(`${card} .printer-action-btn.maintenance`);
      check('Maintenance opens for that printer', await page.isVisible('#printer-view-maintenance') && (await page.inputValue('#maintenance-printer-select')) === String(voron.id));
      await page.fill('#reminder-form-title', 'E2E grease rails');
      await page.selectOption('#reminder-form-interval', '30');
      await page.click('#reminder-form button[type=submit]');
      const reminderItem = await page.waitForSelector('#maintenance-reminders-list .reminder-item:has-text("E2E grease rails")', { timeout: 10000 }).catch(() => null);
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
        const logs = await waitFor(async () => {
          const list = (await invoke(base, session, 'get-printer-maintenance-logs', [voron.id])).result || [];
          return list.length >= 2 ? list : null;
        }, 10000, 'completed reminder log').catch(() => []);
        check('completing a reminder asks for notes and records it', !!notesInput && logs.length >= 2, JSON.stringify(logs.map((l) => l.title)));
      }
      await page.click('#printer-tab-printers');
      await page.click(`${card} .printer-action-btn.danger`);
      const confirmDelete = await page.waitForSelector('dialog[open]:has-text("Delete Printer") button:text-is("Delete")', { timeout: 10000 }).catch(() => null);
      if (confirmDelete) await confirmDelete.click();
      await page.waitForSelector(card, { state: 'detached', timeout: 10000 }).catch(() => {});
      check('Printer Manager deletes a printer after asking', !!confirmDelete && !(await serverPrinters()).some((p) => p.id === voron.id));
    }
    await page.click('#printer-management-close');
    check('Printer Manager closes', !(await page.isVisible('#printer-management-dialog')));

    // Printers page (React, src/web/pages/PrintersPage.tsx): cards, the selected printer, Edit, a reminder, Delete.
    const pagePrinter = (await invoke(base, session, 'save-printer', [{ nickname: 'E2E Page Printer', manufacturer: 'Prusa', model: 'MK4', webUrl: 'mk4.local' }])).result;
    await invoke(base, session, 'save-printer-reminder', [{ printerId: pagePrinter.id, title: 'E2E clean nozzle', maintenanceType: 'Cleaning', dueDate: new Date(Date.now() - 86400000).toISOString(), intervalDays: 0, notes: null }]);
    await page.click('.jp-sidebar .jp-nav__row:has-text("Printers")');
    const pageCard = '.jp-printer-card:has-text("E2E Page Printer")';
    check('the Printers page lists the printer with its maintenance due', /#\/printers/.test(page.url())
      && await page.waitForSelector(`${pageCard} :text("Maintenance due")`, { timeout: 10000 }).then(() => true, () => false));
    await page.click(pageCard);
    check('selecting a printer shows its details and web page', await page.waitForSelector('.jp-printer-detail__name:text-is("E2E Page Printer")', { timeout: 10000 }).then(() => true, () => false)
      && await page.getAttribute('#jp-printer-open-web', 'href') === 'http://mk4.local' && new RegExp(`#/printers/${pagePrinter.id}$`).test(page.url()));
    await page.click('.jp-printer-detail__actions button:has-text("Edit")');
    check('Edit opens the Printer Manager form for that printer', await page.waitForFunction(() => document.getElementById('printer-form-title')?.textContent === 'Edit Printer: E2E Page Printer', null, { timeout: 10000 }).then(() => true, () => false));
    await page.click('#printer-management-close');
    await page.click('.jp-printer-detail__item:has-text("E2E clean nozzle") button:has-text("Done")');
    const doneAsk = await page.waitForSelector('dialog.browser-input-dialog[open] button[type=submit]', { timeout: 10000 }).catch(() => null);
    if (doneAsk) await doneAsk.click();
    const completedLog = await waitFor(async () => (((await invoke(base, session, 'get-printer-maintenance-logs', [pagePrinter.id])).result || []).length ? true : null), 10000, 'reminder done').catch(() => false);
    check('Done completes a reminder and logs it', !!doneAsk && completedLog === true
      && await page.waitForSelector('.jp-printer-detail__list--log :text("E2E clean nozzle")', { timeout: 10000 }).then(() => true, () => false));
    await page.click('.jp-printer-detail__actions button:has-text("Delete")');
    const deleteAsk = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("Delete Printer") button:text-is("Delete")', { timeout: 10000 }).catch(() => null);
    if (deleteAsk) await deleteAsk.click();
    check('Delete removes the printer after asking', !!deleteAsk
      && await waitFor(async () => (!((await invoke(base, session, 'get-all-printers')).result || []).some((p) => p.id === pagePrinter.id) ? true : null), 10000, 'printer deleted').then(() => true, () => false)
      && await page.waitForSelector(pageCard, { state: 'detached', timeout: 10000 }).then(() => true, () => false));

    // Library Stats (React): counts match get-stats, and both charts draw.
    const serverStats = (await invoke(base, session, 'get-stats')).result || {};
    // Opened from Settings in the JusttPrint 5 shell (src/web/shell/AppShell.tsx, src/web/pages/SettingsPage.tsx).
    await page.click('.jp-sidebar .jp-nav__row:has-text("Library")');
    await page.waitForSelector('.jp-page', { state: 'detached', timeout: 5000 }).catch(() => {});
    await page.click('.jp-sidebar .jp-nav__row:has-text("Settings")');
    await page.waitForSelector('.jp-page h1:text-is("Settings")', { timeout: 5000 }).catch(() => {});
    check('the sidebar opens Settings and marks it as the current page', /#\/settings$/.test(page.url())
      && await page.isVisible('.jp-page h1:text-is("Settings")')
      && await page.getAttribute('.jp-sidebar .jp-nav__row:has-text("Settings")', 'aria-current') === 'page');
    // Settings forms sit on the page (src/web/settings/EmbeddedDialog.tsx): the dialogs, opened in place.
    const formOpen = (selector) => page.waitForSelector(selector, { timeout: 10000 }).then(() => true, () => false);
    check('Settings shows the settings forms on the page', await formOpen('#setting-performance #performance-settings-dialog[open]')
      && await formOpen('#setting-stl-home #stl-home-dialog[open]') && await formOpen('#setting-mcp #mcp-server-settings-dialog[open]')
      && await page.evaluate(() => !document.querySelector('#performance-settings-dialog:modal')));
    check('Settings → MakerWorld shows the sign-in and the translation choice', await page.waitForSelector('#setting-makerworld #makerworld-settings-dialog[open] #makerworld-account-status', { timeout: 10000 }).then(() => true, () => false)
      && /Not signed in/.test(await page.textContent('#makerworld-account-status')) && (await page.inputValue('#makerworld-translation')) === 'free');
    const sizeBefore = (await invoke(base, session, 'get-setting', ['maxFileSizeMB'])).result;
    await page.fill('#max-file-size', '61');
    await page.click('#save-performance-settings');
    const inlineSaved = await page.waitForSelector('dialog[open]:has-text("Performance settings saved") button:text-is("OK")', { timeout: 10000 }).catch(() => null);
    if (inlineSaved) await inlineSaved.click();
    check('a settings form saves on the page and stays open', !!inlineSaved && (await invoke(base, session, 'get-setting', ['maxFileSizeMB'])).result === '61'
      && await page.waitForSelector('#setting-performance #performance-settings-dialog[open]', { timeout: 5000 }).then(() => true, () => false));
    await invoke(base, session, 'save-setting', ['maxFileSizeMB', sizeBefore == null ? '50' : sizeBefore]);
    await page.click('.jp-settings-index__link:text-is("Backup")');
    check('the index jumps to a group', await page.waitForFunction(() => {
      const group = document.getElementById('settings-backup')?.getBoundingClientRect();
      return !!group && group.top < window.innerHeight / 2 && group.top > 0;
    }, null, { timeout: 5000 }).then(() => true, () => false));
    await page.click('.jp-settings-row:has-text("Library Stats")');
    check('Library Stats opens from Settings', await page.isVisible('#stats-dialog'));
    const shownTotal = await page.waitForFunction((total) => {
      const text = document.getElementById('stats-total-models')?.textContent;
      return text === total ? text : null;
    }, String(serverStats.totalModels || 0), { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => null);
    check('Library Stats shows the model count', shownTotal !== null, `${shownTotal} vs ${serverStats.totalModels}`);
    check('Library Stats draws its charts', await page.isVisible('#stats-dialog .stats-pie svg') && (await page.locator('#stats-dialog .stats-bar-row').count()) === 4);
    await page.click('#stats-dialog .dialog-buttons button');
    check('Library Stats closes', !(await page.isVisible('#stats-dialog')));
    await page.goBack();
    check('Back returns to the library', !(await page.isVisible('.jp-page')) && !/#\/settings/.test(page.url()));
    check('leaving Settings returns its forms to dialogs', await page.evaluate(() => {
      const dialog = document.getElementById('performance-settings-dialog');
      return !!dialog && !dialog.open && !dialog.closest('.jp-settings-embed') && !dialog.classList.contains('is-embedded');
    }));

    // The rest of the shell: the old menu bar is gone, the account menu, search and the queue link.
    check('the shell replaces the old menu bar, logo and phone layout', await page.evaluate(() => !document.querySelector('#server-menu-bar, #logo, #mobile-app-bar, .sidebar-chrome'))
      && await page.isVisible('.jp-sidebar .jp-brand'));
    await page.click('.jp-account');
    check('the account menu offers JusttPrint Backend Access and Log Out', await page.isVisible('.jp-menu [role="menuitem"]:has-text("JusttPrint Backend Access")')
      && await page.isVisible('.jp-menu [role="menuitem"]:has-text("Log Out")'));
    await page.keyboard.press('Escape');
    check('Escape closes the account menu', !(await page.isVisible('.jp-menu')));
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    check('Ctrl/Cmd+K focuses the search', await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Search the library');
    await page.keyboard.type('cube');
    await page.keyboard.press('Enter');
    const searched = await page.waitForFunction(() => {
      const tokens = window.libraryFilters.state().tokens || [];
      return tokens.some((t) => JSON.stringify(t).includes('cube')) ? true : null;
    }, null, { timeout: 5000 }).then(() => true, () => false);
    check('the top bar search filters the library', searched && await page.inputValue('.jp-topbar input') === '');
    await page.evaluate(() => window.clearAllLibraryFilters());
    // Print Queue (React, src/web/pages/QueuePage.tsx): a queued model moves through the page with its status.
    const queuedModel = ((await invoke(base, session, 'get-all-models')).result || []).find((m) => !m.filePath.includes('::'))?.filePath;
    await invoke(base, session, 'set-print-status', [{ filePath: queuedModel, printStatus: 'queued' }]);
    await page.click('.jp-sidebar .jp-nav__row:has-text("Queue")');
    const queuedRow = `ol[aria-label="Up next"] .jp-queue__row:has(.jp-queue__title:text-is("${path.basename(queuedModel).replace(/\.[^.]+$/, '')}"))`;
    check('Queue opens the Print Queue with the queued model up next', /#\/queue$/.test(page.url())
      && await page.waitForSelector(queuedRow, { timeout: 10000 }).then(() => true, () => false));
    await page.click(`${queuedRow} button:has-text("Start")`);
    const startedRow = 'ul[aria-label="Printing now"] .jp-queue__row';
    const started = await page.waitForSelector(startedRow, { timeout: 10000 }).then(() => true, () => false);
    check('Start moves it to Printing now', started && (await invoke(base, session, 'get-model', [queuedModel])).result?.print_status === 'printing');
    await page.click(`${startedRow} button[aria-label="Back to the queue"]`);
    await page.waitForSelector(queuedRow, { timeout: 10000 }).catch(() => {});
    await page.click(`${queuedRow} button[aria-label="Remove from the queue"]`);
    check('Remove takes it off the queue', await page.waitForSelector('#jp-queue-next ~ * :text("The queue is empty"), .jp-queue__section:has(#jp-queue-next) :text("The queue is empty")', { timeout: 10000 }).then(() => true, () => false)
      && (await invoke(base, session, 'get-model', [queuedModel])).result?.print_status === 'unprinted');
    await page.click('.jp-queue__header button:has-text("Show in Library")');
    check('Show in Library opens the library\'s Queue tab', await page.waitForFunction(() => window.libraryFilters.state().printed === 'in-queue', null, { timeout: 5000 }).then(() => true, () => false)
      && await page.isVisible('.jp-library-header .jp-tab[aria-selected="true"]:has-text("Queue")'));
    await page.evaluate(() => window.clearAllLibraryFilters());
    const storageText = await page.textContent('.jp-storage').catch(() => '');
    check('the sidebar shows Library Storage', /Library Storage/.test(storageText) && /( of |in \d+ models)/.test(storageText), storageText);

    // Keyboard (spec §37): the skip link, a card as one Tab stop, Enter selects, focus follows the arrows.
    await page.evaluate(() => { window.location.hash = '#/library'; });
    await page.click('.view-button[data-view="detailed"]');
    await page.waitForSelector('.file-grid .jp-model-card', { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => { window.selection.clear(); document.activeElement?.blur(); });
    // The first element in Tab order (DOM order, tabbable, not inert or hidden).
    const firstStop = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')];
      const tabbable = candidates.find((el) => el.tabIndex >= 0 && !el.disabled && !el.closest('[inert], [hidden], dialog:not([open])')
        && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none');
      return tabbable?.textContent?.trim() || tabbable?.outerHTML.slice(0, 80);
    });
    await page.focus('.jp-skip');
    await page.keyboard.press('Enter');
    const skipped = await page.evaluate(() => !!document.activeElement?.matches('.file-grid .jp-model-card'));
    check('the first Tab stop is Skip to content, and it jumps to the first model', firstStop === 'Skip to content' && skipped, String(firstStop));
    await page.keyboard.press('Enter');
    const keyboardSelected = await page.waitForFunction(() => document.activeElement?.matches('.jp-model-card.selected')
      && document.activeElement.getAttribute('aria-label')?.endsWith('selected'), null, { timeout: 10000 }).then(() => true, () => false);
    check('Enter on a focused card selects it and opens its details', keyboardSelected
      && await page.waitForFunction(() => !!document.querySelector('#model-details .jp-details__title')?.textContent?.trim(), null, { timeout: 10000 }).then(() => true, () => false),
      JSON.stringify(await page.evaluate(() => ({ active: document.activeElement?.className, label: document.activeElement?.getAttribute('aria-label'),
        selected: document.querySelectorAll('.file-item.selected').length, panels: ['model-details', 'multi-edit-panel', 'bundle-details'].filter((id) => !document.getElementById(id)?.classList.contains('hidden')) }))));
    const focusedBefore = await page.evaluate(() => document.activeElement?.getAttribute('data-filepath'));
    await page.keyboard.press('ArrowDown');
    check('the arrow keys move the selection and the focus with it', await page.waitForFunction((before) => {
      const el = document.activeElement;
      return !!el && el.matches('.jp-model-card.selected') && el.getAttribute('data-filepath') !== before;
    }, focusedBefore, { timeout: 10000 }).then(() => true, () => false));
    await page.keyboard.press('Escape');
    await page.click('.jp-sidebar .jp-nav__row:has-text("Tags")');
    await page.waitForSelector('.jp-page h1:text-is("Tags")', { timeout: 10000 }).catch(() => {});
    const inertState = await page.evaluate(() => {
      const card = document.querySelector('.file-grid .file-item');
      card?.focus();
      return { card: !!card, focusedCard: document.activeElement === card, inert: !!document.querySelector('.file-grid')?.closest('[inert]'), hash: location.hash, dialogs: [...document.querySelectorAll('dialog[open]')].map((d) => d.id) };
    });
    check('a page covers the grid for the keyboard too (inert)', inertState.card && !inertState.focusedCard && inertState.inert, JSON.stringify(inertState));

    // Accessibility audit (axe-core): no serious or critical problems on the JusttPrint 5 pages.
    const auditContext = await browser.newContext({ viewport: { width: 1400, height: 900 }, bypassCSP: true, storageState: await page.context().storageState() });
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
        const result = await window.axe.run({ include: [['.jp-shell'], ['.grid-view-selector'], ['.file-grid'], ['#model-details']] }, { resultTypes: ['violations'] });
        return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`);
      });
      axeProblems.push(...found.map((problem) => `${hash} ${problem}`));
    }
    check('no serious or critical accessibility problems (axe) on the main pages', axeProblems.length === 0, axeProblems.slice(0, 6).join(' | '));
    // The older dialogs, drawn with the tokens since Phase 14, and the message box.
    const dialogProblems = [];
    const DIALOG_OPENERS = ['openAbout', 'openAiConfig', 'openBackupRestore', 'openFileTypeSettings', 'openHttpsSettings',
      'openKeyboardShortcuts', 'openMcpServerSettings', 'openMetadataEditor', 'openPartsStock', 'openPerformanceSettings', 'openPrinterManagement',
      'openPurgeModels', 'openServerAccess', 'openSlicerSettings', 'openStats', 'openStlHome', 'openSystemReport', 'openTagManager', 'openThemeSettings', 'showMessage'];
    for (const opener of DIALOG_OPENERS) {
      await audit.evaluate((name) => {
        if (name === 'showMessage') window.electron.showMessage('Check', 'A message.', ['OK', 'Cancel']);
        else window[name]?.();
      }, opener);
      const id = await audit.waitForFunction(() => [...document.querySelectorAll('dialog[open]')].pop()?.id || (document.querySelector('dialog.jp-message-dialog[open]') ? 'message' : null),
        null, { timeout: 10000 }).then((h) => h.jsonValue(), () => '');
      if (!id) { dialogProblems.push(`${opener}: did not open`); continue; }
      await audit.waitForTimeout(400);
      const found = await audit.evaluate(async () => {
        const dialog = [...document.querySelectorAll('dialog[open]')].pop();
        const result = await window.axe.run(dialog, { resultTypes: ['violations'] });
        return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`);
      });
      dialogProblems.push(...found.map((problem) => `${opener} ${problem}`));
      await audit.evaluate(() => document.querySelectorAll('dialog[open]').forEach((d) => (d.classList.contains('jp-message-dialog') ? d.querySelector('button')?.click() : d.close())));
    }
    check('no serious or critical accessibility problems (axe) in the dialogs', dialogProblems.length === 0, dialogProblems.slice(0, 6).join(' | '));
    await auditContext.close();

    // Phone layout (spec §36; src/web/shell/AppShell.tsx, styles/responsive.css), same session at phone size.
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      storageState: await page.context().storageState() })).newPage();
    phone.on('pageerror', (error) => errors.push(`phone: ${error.message}`));
    await phone.goto(base + '/');
    await phone.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    const phoneHome = {
      nav: await phone.waitForSelector('#jp-bottom-nav', { timeout: 10000 }).then(() => true, () => false),
      hero: await phone.waitForSelector('.jp-hero__title', { timeout: 10000 }).then(() => true, () => false),
      sidebarHidden: await phone.waitForSelector('#jp-sidebar', { state: 'hidden', timeout: 5000 }).then(() => true, () => false),
      noOldBar: !(await phone.isVisible('#mobile-app-bar'))
    };
    check('the phone opens Home with the bottom bar instead of the sidebar', Object.values(phoneHome).every(Boolean), JSON.stringify(phoneHome));
    await phone.tap('#jp-bottom-nav .jp-bottom-nav__item:has-text("Library")');
    // Earlier checks leave the wall or the list as the saved view.
    await phone.tap('.view-button[data-view="detailed"]');
    const phoneTile = await phone.waitForSelector('.file-grid .jp-model-card[data-filepath]', { timeout: 30000 }).catch(() => null);
    // Cards are redrawn while the library loads: wait for two side by side.
    const phoneColumns = await phone.waitForFunction(() => {
      const lefts = new Set([...document.querySelectorAll('.file-grid .jp-model-card[data-filepath]')].map((el) => Math.round(el.getBoundingClientRect().left)));
      return lefts.size >= 2 ? lefts.size : null;
    }, null, { timeout: 15000 }).then((h) => h.jsonValue(), () => 0);
    check('the phone library shows two columns of cards', !!phoneTile && phoneColumns === 2, String(phoneColumns));
    await phone.tap('.jp-topbar__menu');
    check('Menu opens the sidebar as a drawer', await phone.waitForFunction(() => document.body.classList.contains('jp-nav-open'), null, { timeout: 10000 }).then(() => true, () => false)
      && await phone.waitForSelector('#jp-sidebar .jp-nav__row:has-text("Duplicates")', { timeout: 5000 }).then(() => true, () => false),
      JSON.stringify(await phone.evaluate(() => ({ body: document.body.className, dialogs: [...document.querySelectorAll('dialog[open]')].map((d) => d.id) }))));
    await phone.tap('#jp-sidebar .jp-nav__row:has-text("Tags")');
    check('a page from the drawer opens and closes the drawer', await phone.waitForSelector('.jp-page h1:text-is("Tags")', { timeout: 10000 }).then(() => true, () => false)
      && !(await phone.evaluate(() => document.body.classList.contains('jp-nav-open'))));
    await phone.tap('#jp-bottom-nav .jp-bottom-nav__item:has-text("Library")');
    await phone.tap('#jp-filter-button');
    const sheet = await phone.locator('#jp-filter-popover').boundingBox();
    check('Filter opens the filters as a full-width sheet', !!sheet && Math.round(sheet.width) === 390 && await phone.isVisible('#jp-filter-popover #sort-select'));
    await phone.tap('#jp-filter-popover button[aria-label="Close filters"]');
    if (phoneTile) {
      // Touch screens (responsive.css): hover-only buttons show, and small controls are finger-sized.
      const cardAction = await phone.$eval('.file-grid .jp-model-card[data-filepath] .jp-model-card__action', (el) => ({ opacity: getComputedStyle(el).opacity, size: el.getBoundingClientRect().width }));
      check('on a touch screen card buttons show without hover, finger-sized', cardAction.opacity === '1' && cardAction.size >= 36, JSON.stringify(cardAction));
      await phone.tap('.file-grid .jp-model-card[data-filepath] .file-name');
      const phoneDetails = await phone.waitForFunction(() => document.body.classList.contains('jp-details-open'), null, { timeout: 10000 }).then(() => true, () => false);
      const drawer = await phone.locator('.sidebar').boundingBox();
      check('tapping a model opens its details full screen with its name', phoneDetails && !!drawer && Math.round(drawer.width) === 390
        && (await phone.textContent('#model-details .jp-details__title')).trim().length > 0);
      const sizes = await phone.evaluate(() => Object.fromEntries([['tag', '#details-add-tag'], ['slicer', '#model-details .jp-split__more'], ['designer', '#model-designer']]
        .map(([k, s]) => { const r = document.querySelector(s)?.getBoundingClientRect(); return [k, r ? [Math.round(r.width), Math.round(r.height)] : null]; })));
      check('the details buttons and fields are finger-sized', sizes.tag?.[0] >= 40 && sizes.tag?.[1] >= 40 && sizes.slicer?.[0] >= 40 && sizes.designer?.[1] >= 40, JSON.stringify(sizes));
      await phone.tap('#jp-details-close');
      check('× closes the details', await phone.waitForFunction(() => !document.body.classList.contains('jp-details-open'), null, { timeout: 5000 }).then(() => true, () => false));
    }
    await phone.close();

    // Tablet: the sidebar is an icon rail; laptop: the details are a drawer.
    const tablet = await (await browser.newContext({ viewport: { width: 900, height: 1000 }, storageState: await page.context().storageState() })).newPage();
    tablet.on('pageerror', (error) => errors.push(`tablet: ${error.message}`));
    await tablet.goto(base + '/#/library');
    await tablet.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    const rail = await tablet.waitForSelector('#jp-sidebar', { timeout: 10000 }).then(() => tablet.locator('#jp-sidebar').boundingBox(), () => null);
    check('a tablet shows the sidebar as an icon rail', !!rail && Math.round(rail.width) === 72 && !(await tablet.isVisible('#jp-sidebar .jp-storage')));
    const tabletCard = await tablet.waitForSelector('.file-grid .jp-model-card[data-filepath] .file-name', { timeout: 30000 }).catch(() => null);
    if (tabletCard) {
      await tabletCard.click();
      // Waits for the close button and backdrop too: they render after the drawer class is set.
      const drawerState = await tablet.waitForFunction(() => {
        const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        return document.body.classList.contains('jp-details-open') && visible(document.getElementById('jp-details-close'))
          && visible(document.querySelector('.jp-details-backdrop'));
      }, null, { timeout: 10000 }).then(() => true, () => false);
      check('below 1200 px the details open as a drawer over the grid', drawerState, JSON.stringify(await tablet.evaluate(() => ({
        open: document.body.classList.contains('jp-details-open'), close: !!document.getElementById('jp-details-close')?.getClientRects().length,
        backdrop: !!document.querySelector('.jp-details-backdrop')?.getClientRects().length
      }))));
      await tablet.click('.jp-details-backdrop', { position: { x: 300, y: 300 } });
      check('a click beside the drawer closes it', await tablet.waitForFunction(() => !document.body.classList.contains('jp-details-open'), null, { timeout: 5000 }).then(() => true, () => false));
    }
    await tablet.close();

    // First run (React, src/web/startup/FirstRun.tsx): the terms, then the welcome, then the guide.
    await invoke(base, session, 'save-setting', ['tosAcceptedDate', '']);
    await invoke(base, session, 'save-setting', ['hasRunBefore', '']);
    const fresh = await page.context().newPage();
    fresh.on('pageerror', (error) => errors.push(`first run: ${error.message}`));
    await fresh.goto(base + '/');
    check('a first visit asks to accept the terms', await fresh.waitForSelector('#terms-of-service-dialog[open] #accept-terms', { timeout: 30000 }).then(() => true, () => false)
      && !(await fresh.isVisible('#welcome-message')));
    await fresh.press('#terms-of-service-dialog', 'Escape');
    check('Escape does not skip the terms', await fresh.isVisible('#terms-of-service-dialog'));
    await fresh.click('#accept-terms');
    check('accepting saves it and shows the welcome', await fresh.waitForSelector('#welcome-message[open]', { timeout: 30000 }).then(() => true, () => false)
      && !!(await invoke(base, session, 'get-setting', ['tosAcceptedDate'])).result);
    await fresh.click('#dismiss-welcome');
    check('Get Started opens the Quick Start Guide', await fresh.waitForSelector('#quickstart-guide[open]', { timeout: 10000 }).then(() => true, () => false)
      && (await invoke(base, session, 'get-setting', ['hasRunBefore'])).result === 'true');
    await fresh.close();

    // Review Generated Tags (React, src/web/tags/TagPreviewDialog.tsx), driven by the events an AI run sends.
    const reviewPaths = (await page.$$eval('.file-grid [data-filepath]', (els) => els.map((el) => el.getAttribute('data-filepath')))).filter((p) => !p.includes('::')).slice(0, 2);
    if (reviewPaths.length === 2) {
      const [ra, rb] = reviewPaths;
      const tagNames = async (filePath) => (((await invoke(base, session, 'get-model', [filePath])).result || {}).tags || []).map((t) => (typeof t === 'string' ? t : t.name));
      const tagsBefore = await tagNames(ra);
      const emit = (...args) => page.evaluate((a) => window.electron.send(...a), args);
      await emit('start-batch-tag-generation', 2, [ra, rb, ra]);
      await page.waitForFunction(() => document.querySelectorAll('#tag-preview-container .tag-review-model').length === 2, null, { timeout: 10000 }).catch(() => {});
      check('a batch run lists each model once while it waits, with Apply off', await page.isVisible('#tag-preview-dialog')
        && (await page.locator('#tag-preview-container .tag-review-model').count()) === 2 && await page.isDisabled('#tag-preview-apply')
        && /\(0\/2 processed/.test(await page.textContent('#tag-preview-dialog h3')));
      await emit('tags-generated', ra, ['e2e-ai-a', 'e2e-ai-b'], null);
      await emit('tags-generated', rb, [], 'Rate limit exceeded: wait a minute');
      const limitNotice = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("Rate Limit Exceeded") button', { timeout: 10000 }).catch(() => null);
      if (limitNotice) await limitNotice.click();
      check('suggestions show as ticked boxes, and a rate limit is reported once', !!limitNotice
        && (await page.locator('#tag-preview-container input[type=checkbox]:checked').count()) === 2
        && /wait a minute/.test(await page.textContent('#tag-preview-container')));
      await emit('batch-tag-generation-complete');
      check('Apply turns on when the batch ends', await page.waitForSelector('#tag-preview-apply:not([disabled])', { timeout: 5000 }).then(() => true, () => false));
      await page.uncheck('#tag-preview-container input[value="e2e-ai-b"]');
      await page.click('#tag-preview-apply');
      const applied = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("Tags applied") button', { timeout: 15000 }).catch(() => null);
      if (applied) await applied.click();
      const tagsAfter = await tagNames(ra);
      check('Apply saves only the ticked tags, plus "AI Tagged"', !!applied && tagsAfter.includes('e2e-ai-a') && tagsAfter.includes('AI Tagged')
        && !tagsAfter.includes('e2e-ai-b') && !(await page.isVisible('#tag-preview-dialog')), JSON.stringify(tagsAfter));
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
          res.end(JSON.stringify({ id: 'e2e', object: 'chat.completion', created: 0, model: 'e2e',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"tags":["e2e-real-a","e2e-real-b"]}' } }] }));
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
      for (const [key, value] of [['aiService', 'custom'], ['apiEndpoint', `http://${HOST_FOR_SERVER}:${fakeAi.address().port}/v1`], ['aiModel', 'e2e'], ['aiTagConcurrency', '1'], ['aiTagAllowRetagging', '1']]) {
        await invoke(base, session, 'save-setting', [key, value]);
      }
      const runTags = async () => {
        const menu = (await invoke(base, session, 'show-context-menu', [[ra, rb]])).result || {};
        const item = (menu.items || []).find((i) => i.label === 'Generate Tags');
        return item ? invoke(base, session, 'execute-context-menu-action', [menu.requestId, item.index]) : null;
      };
      const job = async () => (await invoke(base, session, 'get-ai-tag-job')).result;
      check('Generate Tags starts a run the JusttPrint backend keeps', !!(await runTags()) && await waitFor(async () => (await job())?.running, 10000, 'run').catch(() => false));
      await page.waitForSelector('#tag-preview-dialog[open]', { timeout: 10000 }).catch(() => {});
      check('a second run waits for the first', ((await job()) || {}).total === 2 && !!(await runTags()) && ((await job()) || {}).total === 2);
      for (const dialog of await page.$$('dialog[id^="browser-message-"][open]:has-text("already running") button')) await dialog.click();
      check('the review offers Stop and Run in Background while the run goes on', await page.isVisible('#tag-preview-stop')
        && /Run in Background/.test(await page.textContent('#tag-preview-cancel')));
      await release();
      await waitFor(async () => ((await job()) || {}).processed === 1, 15000, 'first result').catch(() => {});
      await page.reload();
      await page.waitForSelector('.file-grid [data-filepath]', { timeout: 30000 }).catch(() => {});
      check('after a reload the sidebar still shows the run', await page.waitForFunction(
        () => /AI tagging: 1\/2/.test(document.getElementById('ai-tag-progress-text')?.textContent || ''), null, { timeout: 15000 }).then(() => true, () => false));
      await page.click('#ai-tag-review').catch(() => {});
      check('Review reopens it with the tags that came in', await page.waitForSelector(`#tag-preview-dialog[open] input[value="e2e-real-a"]`, { timeout: 10000 }).then(() => true, () => false)
        && /\(1\/2 processed/.test(await page.textContent('#tag-preview-dialog h3')));
      await release();
      const applyReady = await page.waitForSelector('#tag-preview-apply:not([disabled])', { timeout: 15000 * SLOW }).then(() => true, () => false);
      const tagInputs = await page.locator('#tag-preview-container input[value="e2e-real-a"]').count();
      check('the rest arrives in the reopened review', applyReady && tagInputs === 2, JSON.stringify({
        applyReady, tagInputs, title: await page.textContent('#tag-preview-dialog h3').catch(() => null), job: await job()
      }));
      await page.click('#tag-preview-cancel');
      check('closing a finished review forgets the run', await waitFor(async () => (await job()) === null, 10000, 'dismissed').catch(() => false)
        && await page.waitForSelector('#ai-tag-progress-container', { state: 'detached', timeout: 5000 }).then(() => true, () => false));
      // Stop: the model not started yet is skipped.
      await runTags();
      await page.waitForSelector('#tag-preview-stop', { timeout: 10000 }).catch(() => {});
      await page.click('#tag-preview-stop').catch(() => {});
      await waitFor(async () => (await job())?.stopping, 10000, 'stopping').catch(() => {});
      await release();
      const stopped = await waitFor(async () => { const j = await job(); return j && !j.running ? j : null; }, 15000, 'stopped').catch(() => null);
      check('Stop skips the models not started yet', !!stopped && stopped.processed === 2
        && stopped.results.some((r) => /Stopped before this model/.test(r.error || '')), JSON.stringify(stopped));
      await page.click('#tag-preview-cancel').catch(() => {});
      await waitFor(async () => (await job()) === null, 10000, 'dismissed').catch(() => {});
      for (const key of runKeys) await invoke(base, session, 'save-setting', [key, runSaved[key] ?? null]);
      held.splice(0).forEach((answer) => answer());
      fakeAi.close();
    }

    // System Report (React): every section finishes, and both benchmarks complete.
    await page.evaluate(() => window.openSystemReport());
    check('System Report opens', await page.isVisible('#system-report-dialog'));
    const reportDone = await page.waitForFunction(() => {
      const statuses = [...document.querySelectorAll('#system-report-dialog .system-report-section')]
        .map((section) => section.querySelector('[class^="system-report-status-"]')?.textContent || '');
      return statuses.length === 4 && statuses.every(Boolean) ? statuses : null;
    }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);
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
    const confirmLeftovers = await page.waitForSelector('dialog[open]:has-text("Delete Old Backup Files") button:text-is("Delete")', { timeout: 10000 }).catch(() => null);
    if (confirmLeftovers) await confirmLeftovers.click();
    const noticeGone = await page.waitForSelector('#leftover-downloads', { state: 'detached', timeout: 10000 }).then(() => true, () => false);
    check('the Backup page offers to delete old backup files, asks, and deletes them', !!leftoverNotice && !!confirmLeftovers && noticeGone && !fs.existsSync(uiLeftover));
    const backupDownload = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#backup-button')])
      .then(([download]) => download).catch(() => null);
    check('Create Backup downloads a .db file', !!backupDownload && /^justtprint-backup-.*\.db$/.test(backupDownload.suggestedFilename()), backupDownload && backupDownload.suggestedFilename());
    const exportDownload = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#export-library-button')])
      .then(([download]) => download).catch(() => null);
    const exportPath = exportDownload && await exportDownload.path().catch(() => null);
    const exported = exportPath ? JSON.parse(fs.readFileSync(exportPath, 'utf8')) : null;
    check('Export Library downloads the library', !!exported && Array.isArray(exported.models) && exported.models.length === 3, exported ? `${exported.models.length} models` : 'no file');
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
        check('Import Library merges the export', !!imported && /0 new models added, 3 models updated/.test(await imported.textContent()), imported && await imported.textContent());
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
    const autoDownload = firstAuto ? await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#auto-backup-list .auto-backup-download')])
      .then(([download]) => download).catch(() => null) : null;
    check('switching on Automatic Backups writes the first backup, shows when, and downloads it', !!firstAuto && /Last backup: .*Next: /.test(autoStatus)
      && /^justtprint-auto-\d{8}-\d{6}\.db$/.test(autoDownload?.suggestedFilename() || ''), `${autoStatus} / ${autoDownload?.suggestedFilename()}`);
    await page.uncheck('#auto-backup-enabled');
    await page.waitForFunction(() => !/Next:/.test(document.getElementById('auto-backup-status')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
    for (const name of fs.readdirSync(path.join(DATA, 'backups'))) if (/^justtprint-auto-/.test(name)) fs.rmSync(path.join(DATA, 'backups', name));
    await page.click('#save-backup-restore');
    check('Backup/Restore closes', !(await page.isVisible('#backup-restore-dialog')));

    // Keyboard Shortcuts and About (React).
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+?' : 'Control+Shift+?');
    check('Ctrl+Shift+? opens Keyboard Shortcuts', await page.isVisible('#keyboard-shortcuts-dialog')
      && (await page.locator('#keyboard-shortcuts-dialog .shortcut-row').count()) === 13);
    await page.click('#keyboard-shortcuts-dialog .dialog-buttons button');
    check('Keyboard Shortcuts closes', !(await page.isVisible('#keyboard-shortcuts-dialog')));
    // Installing (src/web/install.ts, pwa.js): the service worker is there for the browser, and Install App says how.
    check('the install service worker is active', await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.active, null, { timeout: 15000 }).then(() => true, () => false));
    await page.evaluate(() => window.openInstallApp());
    check('Install App shows the steps for this browser', await page.isVisible('#install-app-dialog')
      && ['prompt', 'browser-menu'].includes(await page.getAttribute('#install-app-steps', 'data-way')), await page.getAttribute('#install-app-steps', 'data-way').catch(() => ''));
    await page.click('#close-install-app');
    // Shortcuts (React, src/web/shortcuts.ts).
    const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modKey}+/`);
    check('Ctrl+/ focuses the search box', await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Search the library');
    await page.evaluate(() => document.activeElement?.blur());
    await page.evaluate(() => window.libraryFilters.setFromSelect('favorite-select', 'favorited'));
    await page.keyboard.press(`${modKey}+Shift+C`);
    check('Ctrl+Shift+C clears the filters', await page.waitForFunction(() => window.libraryFilters.state().favorite === 'all', null, { timeout: 5000 }).then(() => true, () => false));
    await page.evaluate(() => window.openAbout());
    const aboutVersion = await page.waitForFunction((version) => {
      const text = document.getElementById('about-version')?.textContent || '';
      return text.includes(version) ? text : null;
    }, require('../../package.json').version, { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => null);
    check('About shows the version', !!aboutVersion, aboutVersion);
    await page.uncheck('#auto-update-check');
    const updateSetting = await waitFor(async () => {
      const value = (await invoke(base, session, 'get-setting', ['autoUpdateCheck'])).result;
      return value === '0' ? value : null;
    }, 10000, 'autoUpdateCheck').catch(() => null);
    check('About saves the update check setting', updateSetting === '0');
    await page.check('#auto-update-check');
    await page.click('#about-dialog .about-close-x');
    check('About closes', !(await page.isVisible('#about-dialog')));

    // Performance Settings (React): loads the setting, refuses a bad value, saves a good one.
    const savedMaxSize = (await invoke(base, session, 'get-setting', ['maxFileSizeMB'])).result;
    await page.evaluate(() => window.openPerformanceSettings());
    await page.waitForSelector('#performance-settings-dialog[open]', { timeout: 10000 }).catch(() => {});
    check('Performance Settings opens with the saved value', await page.inputValue('#max-file-size') === (savedMaxSize || '50'), await page.inputValue('#max-file-size'));
    await page.fill('#max-file-size', '0');
    await page.click('#save-performance-settings');
    const badSize = await page.waitForSelector('dialog[open]:has-text("Invalid max file size") button:text-is("OK")', { timeout: 10000 }).catch(() => null);
    check('Performance Settings refuses 0 MB', !!badSize);
    if (badSize) await badSize.click();
    await page.fill('#max-file-size', '75');
    await page.click('#save-performance-settings');
    const sizeSaved = await page.waitForSelector('dialog[open]:has-text("Performance settings saved") button:text-is("OK")', { timeout: 10000 }).catch(() => null);
    if (sizeSaved) await sizeSaved.click();
    check('Performance Settings saves', !!sizeSaved && (await invoke(base, session, 'get-setting', ['maxFileSizeMB'])).result === '75'
      && !(await page.isVisible('#performance-settings-dialog')));
    await invoke(base, session, 'save-setting', ['maxFileSizeMB', savedMaxSize || '50']);

    // MCP Server settings (React): this page's URL, and a client config that carries the API token.
    const apiToken = ((await invoke(base, session, 'get-server-access-info')).result || {}).apiToken;
    await page.evaluate(() => window.openMcpServerSettings());
    check('MCP Server settings opens', await page.isVisible('#mcp-server-settings-dialog'));
    check('MCP URL is this server', await page.inputValue('#mcp-server-url') === `${base}/mcp`, await page.inputValue('#mcp-server-url'));
    // The setup shown for each app, with this page's URL and the API token filled in.
    const mcpSetupFor = async (client) => {
      await page.selectOption('#mcp-client-select', client);
      return page.waitForFunction(() => {
        const text = document.getElementById('mcp-server-config')?.textContent || '';
        return text.includes('Bearer pv_') ? text : null;
      }, null, { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => '');
    };
    const parse = (text) => { try { return JSON.parse(text); } catch (_) { return null; } };
    const mcpConfig = await mcpSetupFor('other');
    const parsedConfig = parse(mcpConfig)?.mcpServers?.justtprint;
    check('MCP client config has the URL and API token', !!parsedConfig && parsedConfig.url === `${base}/mcp`
      && parsedConfig.headers && parsedConfig.headers.Authorization === `Bearer ${apiToken}`, mcpConfig.slice(0, 200));
    const claudeCode = await mcpSetupFor('claude-code');
    check('MCP setup for Claude Code is one command', claudeCode === `claude mcp add --transport http justtprint ${base}/mcp --header "Authorization: Bearer ${apiToken}"`
      && /Copy command/.test(await page.textContent('#copy-mcp-server-config')), claudeCode);
    const vscode = parse(await mcpSetupFor('vscode'))?.servers?.justtprint;
    check('MCP setup for VS Code uses servers and type http', !!vscode && vscode.type === 'http' && vscode.url === `${base}/mcp`
      && vscode.headers.Authorization === `Bearer ${apiToken}`, JSON.stringify(vscode));
    const desktop = parse(await mcpSetupFor('claude-desktop'))?.mcpServers?.justtprint;
    check('MCP setup for Claude Desktop runs mcp-remote with the token', !!desktop && desktop.command === 'npx'
      && desktop.args.includes('mcp-remote') && desktop.args.includes(`${base}/mcp`) && desktop.env.AUTH_HEADER === `Bearer ${apiToken}`, JSON.stringify(desktop));
    const cursor = parse(await mcpSetupFor('cursor'))?.mcpServers?.justtprint;
    check('MCP setup for Cursor has the URL and token', !!cursor && cursor.url === `${base}/mcp` && cursor.headers.Authorization === `Bearer ${apiToken}`);
    check('MCP settings list the tools', /search_models/.test(await page.textContent('#mcp-server-tools').catch(() => '')));
    await page.click('#cancel-mcp-server-settings');
    check('MCP Server settings closes', !(await page.isVisible('#mcp-server-settings-dialog')));

    // The browser extension is removed: no menu item and no dialog.
    check('no Browser Extension dialog', await page.evaluate(() => typeof window.openBrowserExtensionSettings === 'undefined'
      && !document.getElementById('browser-extension-settings-dialog')));

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
    check('file type filter offers the new type', await page.waitForSelector('#filetype-select option[value="obj"]', { state: 'attached', timeout: 10000 }).then(() => true).catch(() => false));
    await invoke(base, session, 'save-setting', ['scanAdditionalFileTypes', savedTypes || '[]']);

    // HTTPS / SSL settings (React): status, mode panels and the redirect label. Not applied (that restarts the listener).
    await page.evaluate(() => window.openHttpsSettings());
    await page.waitForSelector('#https-settings-dialog[open]', { timeout: 10000 }).catch(() => {});
    check('HTTPS settings shows the status', /HTTP on port \d+/.test(await page.textContent('#https-settings-status').catch(() => '')));
    check('HTTPS settings starts in Off mode with no panels', await page.inputValue('#tls-mode') === 'off' && !(await page.isVisible('.tls-mode-panel')));
    await page.selectOption('#tls-mode', 'custom');
    check('Custom mode shows the certificate fields', await page.isVisible('#tls-cert-path') && !(await page.isVisible('#tls-domain')));
    await page.selectOption('#tls-mode', 'letsencrypt');
    check("Let's Encrypt mode shows domain and email", await page.isVisible('#tls-domain') && await page.isVisible('#tls-email'));
    await page.selectOption('#tls-mode', 'selfsigned');
    check('Self-signed mode shows the hostname', await page.isVisible('#tls-selfsigned-host') && !(await page.isVisible('#tls-cert-path')));
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
    check('choosing Claude fills its endpoint and model', await page.inputValue('#ai-endpoint') === 'https://api.anthropic.com/v1/'
      && await page.inputValue('#ai-model') === 'claude-haiku-4-5');
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
    check('Save stores the AI settings', aiAfter.aiService === 'custom' && aiAfter.apiEndpoint === 'http://ollama.local:11434/v1'
      && aiAfter.aiModel === 'llava' && aiAfter.aiTagMaxTags === '7', JSON.stringify(aiAfter));
    for (const key of aiKeys) await invoke(base, session, 'save-setting', [key, savedAi[key] == null ? '' : savedAi[key]]);

    // Puter.com: Puter.js runs only in the sign-in popup, which hands its login to the page. A stand-in
    // Puter.js (served as js.puter.com, so the popup's CSP is what allows it) and Puter proxy keep this offline.
    const puterContext = page.context();
    await puterContext.route('https://js.puter.com/**', (route) => route.fulfill({
      contentType: 'application/javascript',
      body: "window.puter = { authToken: 'e2e-puter-token', auth: { isSignedIn: () => true, signIn: async () => {}, signOut: () => { window.puter.authToken = null; } } };"
    }));
    // The popup can close before its URL is read, so record the page request instead.
    const signInPages = [];
    const recordSignInPage = (request) => { if (/\/puter-signin\.html/.test(request.url())) signInPages.push(request.url()); };
    puterContext.on('request', recordSignInPage);
    const puterRequests = [];
    await page.route('**/api/puter-ai/chat', (route) => {
      puterRequests.push(JSON.parse(route.request().postData() || '{}'));
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ response: 'dragon, toy' }) });
    });
    await page.evaluate(() => window.openAiConfig());
    await page.waitForSelector('#ai-config-dialog[open]', { timeout: 10000 }).catch(() => {});
    await page.selectOption('#ai-service-select', 'puter');
    check('Puter shows its account, not an API key', (await page.textContent('#puter-account-status')) === 'Not signed in' && !(await page.isVisible('#ai-api-key')));
    const signInPopup = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
    await page.click('#puter-sign-in');
    const popup = await signInPopup;
    check('Sign In opens the Puter sign-in page', !!popup && signInPages.length === 1, signInPages.join(', '));
    await page.waitForFunction(() => document.querySelector('#puter-account-status')?.textContent === 'Signed in', null, { timeout: 10000 }).catch(() => {});
    check('the popup hands the Puter login to the page', await page.evaluate(() => localStorage.getItem('justtprint.puterAuthToken')) === 'e2e-puter-token');
    check('the popup closes after signing in', !popup || await popup.waitForEvent('close', { timeout: 10000 }).then(() => true).catch(() => popup.isClosed()));
    await page.click('#test-ai-config');
    await page.waitForFunction(() => /Test (successful|failed)/.test(document.querySelector('#ai-config-result')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
    check('Puter test goes through the server proxy with the login', /Test successful/.test(await page.textContent('#ai-config-result'))
      && puterRequests.length > 0 && puterRequests[0].authToken === 'e2e-puter-token', `${await page.textContent('#ai-config-result')} ${JSON.stringify(puterRequests)}`);
    const signOutPopup = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
    await page.click('#puter-sign-out');
    await signOutPopup;
    check('Sign Out forgets the Puter login', (await page.textContent('#puter-account-status')) === 'Not signed in'
      && await page.evaluate(() => localStorage.getItem('justtprint.puterAuthToken')) === null);
    await page.click('#cancel-ai-config');
    // Cleanup: the sign-in popup's context may be closed already.
    await page.unroute('**/api/puter-ai/chat').catch(() => {});
    await puterContext.unroute('https://js.puter.com/**').catch(() => {});
    puterContext.off('request', recordSignInPage);

    // Theme settings (React): saving a theme applies its accent color without a regenerate prompt.
    const savedTheme = (await invoke(base, session, 'get-setting', ['uiTheme'])).result;
    await page.evaluate(() => window.openThemeSettings());
    await page.waitForSelector('#settings-dialog[open]', { timeout: 10000 }).catch(() => {});
    check('Theme settings opens with the saved theme', await page.inputValue('#ui-theme') === (savedTheme || 'modern-cyan'));
    await page.selectOption('#ui-theme', 'modern-purple');
    await page.click('#save-settings');
    await page.waitForSelector('#settings-dialog', { state: 'hidden', timeout: 10000 }).catch(() => {});
    const accent = await page.evaluate(() => ({ token: document.documentElement.style.getPropertyValue('--jp-accent').trim(),
      button: getComputedStyle(document.querySelector('.jp-tab.is-active, .jp-btn--primary') || document.body).backgroundColor }));
    check('Theme settings saves and applies the theme to the whole interface', (await invoke(base, session, 'get-setting', ['uiTheme'])).result === 'modern-purple'
      && accent.token === '#b47cfa' && !(await page.isVisible('dialog[open]:has-text("Regenerate Thumbnails")')), JSON.stringify(accent));
    // Startup (src/web/startup/start.ts) applies the saved theme after a reload.
    await page.reload();
    await page.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    const themed = await page.waitForFunction(() => document.body.getAttribute('data-theme') === 'modern-purple'
      && document.documentElement.style.getPropertyValue('--jp-accent').trim() === '#b47cfa', null, { timeout: 15000 }).then(() => true, () => false);
    check('the saved theme is applied when the page loads', themed);
    await invoke(base, session, 'save-setting', ['uiTheme', savedTheme || 'modern-cyan']);
    await page.waitForSelector('.file-grid [data-filepath]', { timeout: 30000 }).catch(() => {});

    // Tools → Clear New Flag (src/web/library/actions.ts).
    const flagged = (await page.$$eval('.file-grid [data-filepath]', (els) => els.map((el) => el.getAttribute('data-filepath')))).filter((p) => !p.includes('::'))[0];
    if (flagged) {
      const flaggedModel = (await invoke(base, session, 'get-model', [flagged])).result;
      await invoke(base, session, 'save-model', [{ ...flaggedModel, markAsNew: true }]);
      await page.click('.jp-sidebar .jp-nav__row:has-text("Settings")');
      await page.click('.jp-settings-row:has-text("Clear New Flag")');
      const askClear = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("clear the New flag") button:text-is("Yes")', { timeout: 10000 }).catch(() => null);
      if (askClear) await askClear.click();
      const doneDialog = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("Clear New Flag") button', { timeout: 10000 }).catch(() => null);
      const done = doneDialog && /Cleared the New flag from/.test(await page.textContent('dialog[id^="browser-message-"][open]'));
      if (doneDialog) await doneDialog.click();
      await page.click('.jp-sidebar .jp-nav__row:has-text("Library")');
      check('Clear New Flag asks, clears the flag and says how many', !!askClear && !!done
        && !((await invoke(base, session, 'get-model', [flagged])).result || {}).isNew);

      // Add Image (model menu → server → this page): pick a file, and it becomes another image of the model.
      const imagesBefore = ((await invoke(base, session, 'get-all-thumbnails', [flagged])).result || []).length;
      const chooser = page.waitForEvent('filechooser', { timeout: 10000 }).catch(() => null);
      await page.evaluate((p) => window.electron.send('add-image-request', p), flagged);
      const fileChooser = await chooser;
      if (fileChooser) await fileChooser.setFiles(path.join(ROOT, 'assets', 'logo.png'));
      const added = await waitFor(async () => (((await invoke(base, session, 'get-all-thumbnails', [flagged])).result || []).length > imagesBefore ? true : null), 15000, 'image added').catch(() => false);
      check('Add Image picks a file in the browser and adds it to the model', !!fileChooser && added === true);
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
    check('a typed path suggests a name', await newRow.locator('.slicer-name').inputValue() === 'Orca Slicer');
    const firstName = await page.inputValue('#slicer-dialog .slicer-name');
    await newRow.locator('.slicer-name').fill(firstName);
    await page.click('#save-slicer-settings');
    const duplicate = await page.waitForSelector('dialog[open]:has-text("is already used") button:text-is("OK")', { timeout: 10000 }).catch(() => null);
    check('Slicer settings refuses a duplicate name', !!duplicate);
    if (duplicate) await duplicate.click();
    await newRow.locator('.slicer-name').fill('Orca Slicer');
    await page.click('#save-slicer-settings');
    const slicersSaved = await page.waitForSelector('dialog[open]:has-text("Slicer settings saved") button:text-is("OK")', { timeout: 10000 }).catch(() => null);
    if (slicersSaved) await slicersSaved.click();
    const savedSlicers = (await invoke(base, session, 'get-slicers')).result || [];
    check('Slicer settings saves the list', !!slicersSaved && savedSlicers.length === slicerRows + 1
      && savedSlicers.some((s) => s.name === 'Orca Slicer' && s.path === '/opt/OrcaSlicer/orca-slicer'), JSON.stringify(savedSlicers));
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
    check('path options are grayed until enabled', await page.evaluate(() => document.getElementById('stl-home-path-metadata-options').classList.contains('grayed')));
    await page.check('#stl-home-path-metadata-enabled');
    await page.selectOption('#stl-home-path-direction', 'fromRoot');
    check('From Root explains its levels', /From Root: level 0/.test(await page.textContent('#stl-home-dialog .stl-home-path-direction-desc')));
    await page.click('#save-stl-home-button');
    await page.waitForSelector('#stl-home-dialog', { state: 'hidden', timeout: 10000 }).catch(() => {});
    const stlHomeAfter = {};
    for (const key of stlHomeKeys) stlHomeAfter[key] = (await invoke(base, session, 'get-setting', [key])).result;
    check('STL Home saves directories, exclusions and path options', stlHomeAfter.stlHomeDirectories === '[]' && !stlHomeAfter.stlHome
      && stlHomeAfter.stlHomeExcludeDirectories === '["Designer C"]' && stlHomeAfter.pathMetadataStlHomeEnabled === '1'
      && stlHomeAfter.pathMetadataStlHomeDirection === 'fromRoot', JSON.stringify(stlHomeAfter));
    for (const key of stlHomeKeys) await invoke(base, session, 'save-setting', [key, savedStlHome[key] == null ? '' : savedStlHome[key]]);
    await page.evaluate(() => window.updateScanStlHomeButtonVisibility?.());

    // Organize Library (React): source picker, folder structure, preview, and a stale preview after a change. Not run.
    const savedLayers = (await invoke(base, session, 'get-setting', ['organizeLibraryLayers'])).result;
    // A page on the desktop (#/organize); the Organize row in the sidebar opens it.
    await page.click('.jp-sidebar .jp-nav__row:has-text("Organize")');
    await page.waitForSelector('#organize-library-page', { timeout: 10000 }).catch(() => {});
    check('Organize opens the Organize Library page', /#\/organize$/.test(page.url()) && await page.isVisible('#organize-library-page h1:text-is("Organize Library")'));
    check('Organize Library lists the scanned folders', await page.waitForSelector('#organize-source-button:not([disabled])', { timeout: 10000 }).then(() => true, () => false));
    await page.click('#organize-source-button');
    await page.fill('#organize-source-search', 'zzz-no-match');
    check('source search filters the folders', await page.isVisible('#organize-source-empty'));
    await page.fill('#organize-source-search', LIBRARY);
    await page.press('#organize-source-search', 'Enter');
    check('Enter picks the matching folder', (await page.textContent('#organize-source-label')) === LIBRARY && !(await page.isVisible('#organize-source-menu')),
      await page.textContent('#organize-source-label'));
    await page.click('#organize-structure-add');
    check('structure preview lists the folders', /Root \/ \S.* \/ \S.* \/ file/.test(await page.textContent('#organize-structure-preview')));
    await page.fill('#organize-dest-input', '/tmp/pv-e2e-organize-preview');
    await page.click('#organize-preview-button');
    const planned = await page.waitForSelector('#organize-preview-summary:has-text("will be copied")', { timeout: 15000 }).catch(() => null);
    check('Organize preview plans copies and allows Copy', !!planned && await page.isEnabled('#organize-confirm-button'));
    await page.fill('#organize-dest-input', '/tmp/pv-e2e-organize-other');
    check('changing the job asks for a new preview', (await page.textContent('#organize-preview-summary')).includes('Preview again')
      && !(await page.isEnabled('#organize-confirm-button')));
    await page.click('.jp-sidebar .jp-nav__row:has-text("Library")');
    check('leaving the page closes Organize Library', await page.waitForSelector('#organize-library-page', { state: 'detached', timeout: 5000 }).then(() => true, () => false));
    await invoke(base, session, 'save-setting', ['organizeLibraryLayers', savedLayers == null ? '' : savedLayers]);

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
    check('Duplicates lists the pair side by side', !!dedupGroup && await page.isVisible(originalRow) && /#\/duplicates$/.test(page.url())
      && (await page.locator(`#dedup-page .jp-dup-group:has(input[data-filepath="${dedupCopy}"]) .jp-dup-copy`).count()) === 2);
    check('De-Dup scope: entire library without filters', await page.isChecked('#dedup-scope-entire') && await page.isDisabled('#dedup-scope-current'));
    await page.fill('#dedup-preferred-directory-input', path.join(LIBRARY, 'Designer A'));
    await page.press('#dedup-preferred-directory-input', 'Enter');
    check('Easy with a preferred directory keeps the original', await page.isChecked(copyRow) && !(await page.isChecked(originalRow))
      && (await page.locator('#dedup-page .preferred-directory-badge').count()) >= 2);
    check('De-Dup saves the preferred directory', (await invoke(base, session, 'get-setting', ['dedupPreferredDirectory'])).result === path.join(LIBRARY, 'Designer A'));
    await page.click('#dedup-clear-button');
    check('Clear unselects everything', !(await page.isChecked(copyRow)));
    await page.click(`#dedup-page .jp-dup-copy:has(input[data-filepath="${dedupOriginal}"]) button:has-text("Keep this")`);
    check('Keep this selects the other copy for deletion', await page.isChecked(copyRow) && !(await page.isChecked(originalRow)));
    await page.click(`#dedup-page .jp-dup-group:has(input[data-filepath="${dedupCopy}"]) button:has-text("Keep all")`);
    check('Keep all keeps every copy', !(await page.isChecked(copyRow)) && !(await page.isChecked(originalRow)));
    await page.check(copyRow);
    await page.click('#delete-selected');
    const confirmDedupDelete = await page.waitForSelector('dialog[open]:has-text("Confirm Delete") button:text-is("Yes")', { timeout: 10000 }).catch(() => null);
    if (confirmDedupDelete) await confirmDedupDelete.click();
    const copyGone = await page.waitForSelector(copyRow, { state: 'detached', timeout: 15000 }).then(() => true).catch(() => false);
    check('Delete Selected removes the copy from disk and the list', !!confirmDedupDelete && copyGone && !fs.existsSync(dedupCopy) && fs.existsSync(dedupOriginal));
    await page.click('.jp-sidebar .jp-nav__row:has-text("Library")');
    check('leaving the page closes Duplicates', await page.waitForSelector('#dedup-page', { state: 'detached', timeout: 5000 }).then(() => true, () => false));
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
      check('clicking a bundle shows the bundle panel', !!bundlePanel && await page.textContent('#bundle-details-title') === 'kit.zip'
        && /ZIP archive • 2 files/.test(await page.textContent('#bundle-details-subtitle'))
        && await page.inputValue('#bundle-details-path') === kitZip
        && (await page.locator('#bundle-contents-list .bundle-contents-list-item').count()) === 2
        && /2\s*models/.test(await page.textContent('#bundle-details-stats')));
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
      check('the bundle panel adds a tag to every model in it', tagAdded === true && await page.isVisible('#bundle-tags .tag[data-tag-name="e2e-bundle-tag"]'));
      await page.click('#bundle-tags .tag[data-tag-name="e2e-bundle-tag"] .tag-remove');
      const tagRemoved = await waitFor(async () => ((await kitTagged('e2e-bundle-tag')).every((v) => !v) ? true : null), 10000, 'bundle tag removed').catch(() => false);
      check('the bundle panel removes a tag from every model', tagRemoved === true && !(await page.isVisible('#bundle-tags .tag[data-tag-name="e2e-bundle-tag"]')),
        JSON.stringify({ saved: await kitTagged('e2e-bundle-tag'), chip: await page.isVisible('#bundle-tags .tag[data-tag-name="e2e-bundle-tag"]') }));
      // 3D preview of the whole bundle: parts laid out side by side, each one selectable.
      await page.evaluate(([zip]) => window.openBundlePreview({ groupLabel: 'kit.zip', children: [
        { filePath: `${zip}::kit/left.stl`, fileName: 'left.stl', bundleKind: 'zip' },
        { filePath: `${zip}::kit/right.stl`, fileName: 'right.stl', bundleKind: 'zip' }
      ] }), [kitZip]);
      const bundlePreview = await page.waitForFunction(() => document.getElementById('preview-file-type')?.textContent === 'ZIP bundle • 2 models'
        && getComputedStyle(document.getElementById('preview-loading')).display === 'none', null, { timeout: 30000 })
        .then(() => true, async () => page.textContent('#preview-dialog .preview-loading').catch(() => ''));
      const partNames = await page.$$eval('#preview-part-select option', (opts) => opts.map((o) => o.textContent));
      check('the bundle 3D preview lays out every model with a part picker', bundlePreview === true && await page.isVisible('#preview-part-picker')
        && JSON.stringify(partNames) === JSON.stringify(['All parts', 'left.stl', 'right.stl']), `${bundlePreview} ${JSON.stringify(partNames)}`);
      await page.selectOption('#preview-part-select', { label: 'right.stl' });
      check('picking a part focuses it', /^Dimensions: /.test(await page.textContent('#preview-dimensions')));
      await page.click('#close-preview');
      await page.click('#bundle-contents-list .bundle-contents-list-item:text-is("left.stl")');
      const openedChild = await page.waitForFunction(() => document.getElementById('path-tree-container')?.getAttribute('data-file-path')?.endsWith('::kit/left.stl')
        && !document.getElementById('model-details')?.classList.contains('hidden'), null, { timeout: 10000 }).then(() => true, () => false);
      check('a model in the bundle list opens its details', openedChild && await page.isHidden('#bundle-details'));
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
    const cardRender = await waitFor(async () => ((await storedThumb(cubePath)).startsWith('data:image') ? true : null), 60000, 'card render').catch(() => false);
    check('a card without a thumbnail renders one in the browser and saves it', cardRender === true);
    // Tools → Generate Missing Thumbnails runs the server job in the dialog.
    await invoke(base, session, 'save-thumbnail', [cubePath, '3d.png']);
    await page.evaluate(() => window.electron.send('generate-missing-thumbnails'));
    const askMissing = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("missing thumbnails") button:text-is("Yes")', { timeout: 10000 }).catch(() => null);
    if (askMissing) await askMissing.click();
    const jobDialog = await page.waitForSelector('#thumbnail-progress-overlay', { timeout: 10000 }).then(() => true, () => false);
    const jobDone = await page.waitForSelector('#thumbnail-progress-overlay', { state: 'detached', timeout: 120000 }).then(() => true, () => false);
    check('Generate Missing Thumbnails asks, shows the server job, and renders the model', !!askMissing && jobDialog && jobDone
      && (await storedThumb(cubePath)).startsWith('data:image'));
    // Regenerate in the background: the sidebar follows it, and its end is reported.
    await page.evaluate(() => window.electron.send('regenerate-thumbnails'));
    const askAll = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("regenerate thumbnails for all") button:text-is("Yes")', { timeout: 10000 }).catch(() => null);
    if (askAll) await askAll.click();
    await page.click('#thumbnail-progress-background', { timeout: 10000 }).catch(() => {});
    const inSidebar = await page.waitForSelector('.jp-sidebar .jp-jobs #render-progress-container', { timeout: 10000 }).then(() => true, () => false);
    const finishedNote = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("Thumbnail generation finished") button', { timeout: 120000 }).catch(() => null);
    if (finishedNote) await finishedNote.click();
    check('a background job shows in the sidebar and reports when it is done', !!askAll && inSidebar && !!finishedNote
      && !(await page.isVisible('#render-progress-container')));
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
    const offer = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("1 new model(s) found") button:text-is("Yes")', { timeout: 60000 }).catch(() => null);
    if (offer) await offer.click();
    const shownNew = await page.waitForFunction((p) => {
      const shown = [...document.querySelectorAll('.file-grid [data-filepath]')].map((el) => el.getAttribute('data-filepath'));
      return shown.length === 1 && shown[0].endsWith(p);
    }, path.basename(scannedModel), { timeout: 15000 }).then(() => true, () => false);
    const scannedThumb = await waitFor(async () => {
      const models = (await invoke(base, session, 'get-all-models')).result || [];
      const model = models.find((m) => m.filePath.endsWith('scanned-cube.stl'));
      return model && (await storedThumb(model.filePath)).startsWith('data:image') ? true : null;
    }, 120000, 'scanned thumbnail').catch(() => false);
    check('Scan Directory adds the new model, offers to show it, and its thumbnail is rendered', !!offer && shownNew && scannedThumb === true);
    fs.rmSync(scanDir, { recursive: true, force: true });
    await page.evaluate(async () => { window.clearAllLibraryFilters?.(); await window.performCombinedSearch({ force: true }); });

    // Purge Models (React). Empties the library, so it runs last among the library checks.
    // A late message from the scan or thumbnail jobs above (slow machines) would cover the
    // dialog: wait a moment, then note and answer any that is open.
    const dismissStrayMessages = async () => {
      await page.waitForTimeout(1000);
      const strays = await page.evaluate(() => [...document.querySelectorAll('dialog.jp-message-dialog[open]')].map((dialog) => {
        const text = dialog.textContent.replace(/\s+/g, ' ').trim().slice(0, 160);
        [...dialog.querySelectorAll('button')].pop()?.click();
        return text;
      }));
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
    const purged = await page.waitForSelector('dialog[open]:has-text("All models have been purged") button:text-is("OK")', { timeout: 15000 }).catch(() => null);
    if (purged) await purged.click();
    check('Purge Models empties the library and the grid', !!purged && ((await invoke(base, session, 'get-stats')).result || {}).totalModels === 0
      && (await page.$$('.file-grid [data-filepath], .file-grid [data-file-path]')).length === 0);

    await page.evaluate(() => window.openServerAccess());
    check('JusttPrint Backend Access dialog opens', await page.isVisible('#server-access-dialog'));
    const shownToken = await page.waitForFunction(() => document.getElementById('server-access-api-token')?.value, null, { timeout: 10000 })
      .then((handle) => handle.jsonValue()).catch(() => '');
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
    method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username, password })
  });
  if (!response.ok) return null;
  return { cookie: (response.headers.get('set-cookie') || '').split(';')[0], origin: base };
}

/** POST /api/upload as a session; resolves to { status, ...body }. */
async function uploadAs(base, session, folder, name, body) {
  const response = await fetch(`${base}/api/upload?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { origin: base, cookie: session.cookie, 'content-type': 'application/octet-stream' }, body
  });
  return { status: response.status, ...(await response.json().catch(() => ({}))) };
}

/**
 * User accounts, roles, uploads and the Statistics page. Runs after the browser checks, which end
 * with an empty library (Purge Models), so the uploads here do not change the counts above.
 */
async function accountChecks(base, wsUrl, admin) {
  console.log('\n# User accounts and roles');
  const status = await (await fetch(`${base}/api/auth/status`, { headers: { cookie: admin.cookie } })).json();
  check('the JUSTTPRINT_PASSWORD login is the admin account', status.user && status.user.username === 'admin' && status.user.role === 'admin', JSON.stringify(status));
  check('an admin adds an editor', (await invoke(base, admin, 'create-user', [{ username: 'maker', password: 'maker-password', role: 'editor' }])).status === 200);
  check('an admin adds a viewer', (await invoke(base, admin, 'create-user', [{ username: 'kid', password: 'kid-password', role: 'viewer' }])).status === 200);
  check('user names are unique (any case)', /already a user/.test((await invoke(base, admin, 'create-user', [{ username: 'KID', password: 'kid-password', role: 'viewer' }])).error || ''));
  check('wrong user name refused', (await loginAs(base, 'nobody', 'kid-password')) === null);
  const editor = await loginAs(base, 'maker', 'maker-password');
  const viewer = await loginAs(base, 'kid', 'kid-password');
  check('editor and viewer log in', !!editor && !!viewer);
  const users = (await invoke(base, admin, 'list-users')).result || {};
  check('the user list has all three, without password hashes', users.users?.length === 3 && !JSON.stringify(users).includes('scrypt'), JSON.stringify(users).slice(0, 200));
  check('viewers read the library', (await invoke(base, viewer, 'get-library-counts')).status === 200);
  const viewerEdit = await invoke(base, viewer, 'save-tag', ['nope']);
  check('viewers cannot edit', viewerEdit.status === 403 && /Viewer accounts cannot do this/.test(viewerEdit.error || ''), JSON.stringify(viewerEdit));
  check('editors edit the library', (await invoke(base, editor, 'save-tag', ['from-editor'])).status === 200);
  check('editors cannot change settings', /Only an admin/.test((await invoke(base, editor, 'save-setting', ['stlHomeDirectories', '[]'])).error || ''));
  check('editors may save display preferences', (await invoke(base, editor, 'save-setting', ['gridView', 'true'])).result === true);
  check('editors cannot see the API token', (await invoke(base, editor, 'get-server-access-info')).status === 403);
  check('editors cannot manage users', (await invoke(base, editor, 'list-users')).status === 403);
  check('viewers cannot use MCP', (await fetch(`${base}/mcp`, { method: 'POST', headers: { origin: base, cookie: viewer.cookie, 'content-type': 'application/json' }, body: '{}' })).status === 403);
  const viewerSocket = await openEvents(wsUrl, { cookie: viewer.cookie, origin: base });
  check('viewers get the event WebSocket', !!viewerSocket.hello);

  // Add Links: checking finds links already in the library (link-only models, and files whose source is the link).
  // Nothing here reaches the sites: links already in the library are answered without fetching.
  check('viewers cannot add links', (await invoke(base, viewer, 'check-model-links', ['https://www.printables.com/model/3161'])).status === 403
    && (await invoke(base, viewer, 'import-model-link', ['https://www.printables.com/model/3161'])).status === 403);
  await invoke(base, admin, 'save-model', [{ filePath: 'url::https://www.printables.com/model/3161', fileName: 'E2E Benchy', source: 'https://www.printables.com/model/3161' }]);
  const linkCheck = (await invoke(base, editor, 'check-model-links', ['Benchy: https://www.printables.com/de/model/3161-3d-benchy/files\nhttps://www.thingiverse.com/thing:42 https://www.thingiverse.com/thing:42\nhttps://example.com/x'])).result || {};
  check('Add Links finds the links in pasted text, once each', (linkCheck.links || []).map((l) => `${l.site}:${l.id}`).join() === 'printables:3161,thingiverse:42'
    && (linkCheck.unsupported || []).join() === 'https://example.com/x', JSON.stringify(linkCheck));
  check('Add Links knows a link already in the library', linkCheck.links?.[0]?.existing?.fileName === 'E2E Benchy' && linkCheck.links?.[1]?.existing === null, JSON.stringify(linkCheck.links));
  const again = (await invoke(base, editor, 'import-model-link', ['printables.com/model/3161'])).result || {};
  check('adding a link already in the library adds nothing', again.status === 'exists' && again.filePath === 'url::https://www.printables.com/model/3161', JSON.stringify(again));
  check('only model links are added', /Not a Printables, Thingiverse or MakerWorld model link/.test((await invoke(base, editor, 'import-model-link', ['http://127.0.0.1:5000/api/health'])).error || ''));

  // MakerWorld: details for everyone; sign-in and downloads for editors. Nothing here reaches MakerWorld.
  check('site details are only for MakerWorld, Printables and Thingiverse links', (await invoke(base, viewer, 'get-site-details', ['https://example.com/model/3161'])).result === null);
  check('viewers cannot sign in to MakerWorld or download', (await invoke(base, viewer, 'makerworld-download', [{ url: 'https://makerworld.com/en/models/1' }])).status === 403
    && (await invoke(base, viewer, 'makerworld-sign-in', [{ account: 'x' }])).status === 403);
  check('MakerWorld starts signed out', (await invoke(base, editor, 'makerworld-account-status')).result?.signedIn === false);
  const mwDownload = (await invoke(base, editor, 'makerworld-download', [{ url: 'https://makerworld.com/en/models/1', folder: LIBRARY, files: ['a.stl'] }])).result || {};
  check('a download without a MakerWorld sign-in asks for one', mwDownload.signIn === true, JSON.stringify(mwDownload));
  check('viewers cannot list site files; only admins set the Thingiverse token', (await invoke(base, viewer, 'list-site-files', ['https://www.printables.com/model/1'])).status === 403
    && (await invoke(base, editor, 'set-thingiverse-token', ['x'])).status === 403
    && (await invoke(base, editor, 'thingiverse-token-status')).result?.hasToken === false
    && (await invoke(base, admin, 'get-setting', ['thingiverseToken'])).result === null);
  const mwSave = await invoke(base, admin, 'save-setting', ['makerWorldAccount', '{"accessToken":"x"}']);
  check('the MakerWorld sign-in cannot be read or set through settings', (await invoke(base, admin, 'get-setting', ['makerWorldAccount'])).result === null
    && mwSave.result !== true && (await invoke(base, editor, 'makerworld-account-status')).result?.signedIn === false, JSON.stringify(mwSave));

  // Display preferences are each user's own; the server-wide value is the default.
  const adminView = (await invoke(base, admin, 'get-setting', ['sortOption'])).result;
  check('a user saves their own sort order', (await invoke(base, viewer, 'save-setting', ['sortOption', 'name-desc'])).result === true
    && (await invoke(base, viewer, 'get-setting', ['sortOption'])).result === 'name-desc');
  check('another user keeps theirs', (await invoke(base, admin, 'get-setting', ['sortOption'])).result === adminView
    && (await invoke(base, editor, 'get-setting', ['sortOption'])).result !== 'name-desc');
  check('everyone picks their own color scheme', (await invoke(base, viewer, 'save-setting', ['uiTheme', 'modern-green'])).result === true
    && (await invoke(base, editor, 'get-setting', ['uiTheme'])).result !== 'modern-green');
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
  check('an editor uploads into a library folder', first.status === 200 && first.fileName === 'Uploaded Cube.stl' && fs.existsSync(path.join(folder, 'Uploaded Cube.stl')), JSON.stringify(first));
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
    const response = await fetch(base + urlPath, { method, headers: { origin: base, cookie: session.cookie, ...(body !== undefined ? { 'content-type': contentType } : {}) }, body });
    return { status: response.status, ...(await response.json().catch(() => ({}))) };
  };
  const started = await api(editor, 'POST', '/api/upload/sessions', JSON.stringify({ folder, name: 'Pieces.stl', size: cubeBytes.length }));
  check('an upload in pieces starts with the piece size', started.status === 200 && started.received === 0 && started.chunkBytes > 0 && started.chunkBytes < cubeBytes.length, JSON.stringify(started));
  const piece = started.chunkBytes;
  const put = (session, offset, bytes) => api(session, 'PUT', `/api/upload/sessions/${started.id}?offset=${offset}`, bytes, 'application/octet-stream');
  check('the first piece arrives', (await put(editor, 0, cubeBytes.subarray(0, piece))).received === piece);
  const wrong = await put(editor, 0, cubeBytes.subarray(0, piece));
  check('a piece at the wrong offset says where to continue', wrong.status === 409 && wrong.received === piece, JSON.stringify(wrong));
  check('another user cannot add to the upload', (await put(admin, piece, cubeBytes.subarray(piece, 2 * piece))).status === 403);
  check('viewers cannot start uploads', (await api(viewer, 'POST', '/api/upload/sessions', JSON.stringify({ folder, name: 'x.stl', size: 1 }))).status === 403);
  check('finishing early is refused', (await api(editor, 'POST', `/api/upload/sessions/${started.id}/finish`)).status === 409);
  check('the status says how far it got (to resume)', (await api(editor, 'GET', `/api/upload/sessions/${started.id}`)).received === piece);
  check('the unfinished upload is a hidden temp file', fs.readdirSync(folder).some((name) => name.endsWith('.justtprint-upload')) && !fs.existsSync(path.join(folder, 'Pieces.stl')));
  let offset = piece;
  while (offset < cubeBytes.length) offset = (await put(editor, offset, cubeBytes.subarray(offset, offset + piece))).received;
  const finished = await api(editor, 'POST', `/api/upload/sessions/${started.id}/finish`);
  check('the pieces make the file', finished.status === 200 && fs.readFileSync(path.join(folder, 'Pieces.stl')).equals(cubeBytes), JSON.stringify(finished));
  check('no temp file is left', !fs.readdirSync(folder).some((name) => name.endsWith('.justtprint-upload')));
  const cancelled = await api(editor, 'POST', '/api/upload/sessions', JSON.stringify({ folder, name: 'Cancelled.stl', size: 10 }));
  await api(editor, 'DELETE', `/api/upload/sessions/${cancelled.id}`);
  check('a cancelled upload leaves nothing behind', (await api(editor, 'GET', `/api/upload/sessions/${cancelled.id}`)).status === 404
    && !fs.readdirSync(folder).some((name) => name.endsWith('.justtprint-upload')));
  check('too large for the limit is refused before sending', (await api(editor, 'POST', '/api/upload/sessions', JSON.stringify({ folder, name: 'huge.stl', size: 1e15 }))).status === 413);
  await invoke(base, editor, 'add-uploaded-files', [folder, [finished.filePath]]);

  console.log('\n# Statistics');
  const uploadedPath = path.join(folder, 'Uploaded Cube.stl');
  await invoke(base, editor, 'log-print-event', [{ filePath: uploadedPath, outcome: 'printed', quantity: 3 }]);
  await invoke(base, editor, 'log-print-event', [{ filePath: uploadedPath, outcome: 'failed' }]);
  const stats = (await invoke(base, viewer, 'get-print-statistics', [{ months: 12 }])).result || {};
  check('viewers read the statistics', stats.totals && stats.totals.printed === 3 && stats.totals.failed === 1 && stats.totals.successRate === 0.75, JSON.stringify(stats.totals));
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
  check('the shared page escapes text and shows no paths', publicHtml.includes('&lt;b&gt;friends&lt;/b&gt;') && !publicHtml.includes(uploadLibrary) && !/<script/i.test(publicHtml));
  check('the shared page is not indexed or cached', /noindex/.test(publicPage.headers.get('x-robots-tag') || '') && publicPage.headers.get('cache-control') === 'no-store');
  const sharedId = viewed.models[0].id;
  const sharedFile = await fetch(`${base}/s/${link.token}/file/${sharedId}`);
  check('shared models download when allowed', sharedFile.status === 200 && (await sharedFile.arrayBuffer()).byteLength === cubeBytes.length);
  const otherId = (((await invoke(base, admin, 'get-all-models')).result || []).find((m) => !viewed.models.some((v) => v.id === m.id)) || {}).id;
  check('a link reaches only its own models', !!otherId && (await fetch(`${base}/s/${link.token}/file/${otherId}`)).status === 404
    && (await fetch(`${base}/s/${link.token}/thumb/${otherId}`)).status === 404);
  const viewOnly = (await invoke(base, editor, 'create-share-link', [{ kind: 'model', filePath: uploadedPath, allowDownload: false }])).result || {};
  check('a view-only link offers no downloads', !(await (await fetch(`${base}/s/${viewOnly.token}`)).text()).includes('/file/')
    && (await fetch(`${base}/s/${viewOnly.token}/file/${viewOnly.targetId}`)).status === 404);
  check('the rest of the server still needs a login', (await fetch(`${base}/api/actions/get-collections`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' })).status === 401);
  await invoke(base, editor, 'revoke-share-link', [viewOnly.token]);
  check('a turned-off link stops working', (await fetch(`${base}/s/${viewOnly.token}`)).status === 404);
  check('Settings → Sharing lists the links', ((await invoke(base, editor, 'get-share-links', [])).result || []).some((l) => l.token === link.token && l.targetName === 'E2E Gifts'));

  console.log('\n# Open in OrcaSlicer (no helper)');
  const slicersBefore = (await invoke(base, admin, 'get-slicers')).result || [];
  check('OrcaSlicer is added without a path', (await invoke(base, admin, 'clear-and-save-slicers', [[...slicersBefore.map((x) => ({ name: x.name, path: x.path })), { name: 'OrcaSlicer Link', path: 'orcaslicer://' }]])).result === true);
  const orca = (await invoke(base, viewer, 'open-file-in-slicer', [{ filePaths: [uploadedPath], slicerName: 'OrcaSlicer Link' }])).result || {};
  const orcaFile = orca.command?.files?.[0] || {};
  check('viewers get an OrcaSlicer link per file', orca.command?.type === 'open-in-orcaslicer' && orcaFile.name === 'Uploaded_Cube.stl', JSON.stringify(orca));
  const orcaDownload = await fetch(`${base}/api/slicer-file/${orcaFile.token}/${orcaFile.name}`);
  check('OrcaSlicer downloads the file without a login', orcaDownload.status === 200 && Buffer.from(await orcaDownload.arrayBuffer()).equals(cubeBytes)
    && /Uploaded%20Cube\.stl/.test(orcaDownload.headers.get('content-disposition') || ''));
  check('a made-up token is refused', (await fetch(`${base}/api/slicer-file/AAAAAAAAAAAAAAAAAAAAAA/x.stl`)).status === 404);
  check('files outside the library get no link', /outside the library/.test((await invoke(base, viewer, 'open-file-in-slicer', [{ filePaths: ['/etc/passwd'], slicerName: 'OrcaSlicer Link' }])).error || ''));
  check('more than 10 files are refused with advice', /up to 10 files/.test((await invoke(base, viewer, 'open-file-in-slicer', [{ filePaths: Array(11).fill(uploadedPath), slicerName: 'OrcaSlicer Link' }])).error || ''));
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

    const editorPage = await open('maker', 'maker-password');
    check('the account button shows the user and role', await editorPage.waitForSelector('#jp-account-who:has-text("maker")', { timeout: 10000 }).then(() => true, () => false)
      && (await editorPage.textContent('#jp-account-who')).includes('Editor'));
    check('editors do not see admin pages', !(await editorPage.isVisible('.jp-sidebar .jp-nav__row:has-text("Organize")'))
      && await editorPage.isVisible('.jp-sidebar .jp-nav__row:has-text("Tags")'));
    // The dialog starts at the last folder used (kept in this browser).
    await editorPage.evaluate((dir) => { localStorage.setItem('justtprint.uploadFolder', dir); window.location.hash = '#/library'; }, folder);
    await editorPage.waitForSelector('#jp-upload-button', { timeout: 10000 });
    await editorPage.click('#jp-upload-button');
    await editorPage.waitForSelector('#jp-upload-input', { state: 'attached', timeout: 5000 });
    check('the dialog starts at the last folder used', await editorPage.waitForFunction((dir) => document.getElementById('jp-upload-folder')?.textContent === dir, folder, { timeout: 10000 }).then(() => true, () => false));
    await editorPage.click('#jp-upload-choose-folder');
    const picker = await editorPage.waitForSelector('#folder-picker-dialog[open], dialog[open]:has-text("Upload Into")', { timeout: 5000 }).catch(() => null);
    check('Choose Folder opens the folder picker', !!picker);
    if (picker) await editorPage.keyboard.press('Escape');
    await editorPage.setInputFiles('#jp-upload-input', [
      { name: 'Browser Upload.stl', mimeType: 'application/octet-stream', buffer: cubeBytes },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a model') }
    ]);
    check('files of other types are skipped before sending', await editorPage.waitForSelector('.jp-upload__item.is-skipped:has-text("notes.txt")', { timeout: 5000 }).then(() => true, () => false));
    await editorPage.click('#jp-upload-start');
    const summary = await editorPage.waitForFunction(() => /in the library|failed|Nothing/.test(document.getElementById('jp-upload-summary')?.textContent || ''), null, { timeout: 60000 })
      .then(() => editorPage.textContent('#jp-upload-summary'), () => editorPage.textContent('#jp-upload-summary').catch(() => ''));
    check('the dialog uploads in pieces and adds the model', /Uploaded 1 file; it is in the library/.test(summary || ''), summary);
    const uploadedTo = (((await invoke(base, admin, 'get-all-models')).result || []).find((m) => m.fileName === 'Browser Upload.stl') || {}).filePath || '';
    check('the browser upload went into the chosen folder, whole', path.dirname(uploadedTo) === folder && fs.existsSync(uploadedTo) && fs.readFileSync(uploadedTo).equals(cubeBytes), uploadedTo);
    await editorPage.keyboard.press('Escape');

    // Add Links: pasted links are checked as you type.
    await editorPage.click('#jp-links-button');
    await editorPage.fill('#jp-links-text', 'https://www.printables.com/model/3161-3d-benchy\nhttps://makerworld.com/en/models/1000000-lens-cap\nnot a link https://example.com/x');
    check('Add Links lists each link and what is already there', await editorPage.waitForSelector('#jp-links-list .jp-upload__item.is-exists:has-text("E2E Benchy")', { timeout: 10000 }).then(() => true, () => false)
      && await editorPage.isVisible('#jp-links-list .jp-upload__item.is-new:has-text("Lens Cap")')
      && /example\.com\/x/.test(await editorPage.textContent('#jp-links-unsupported')));
    // With downloading on, an online model already in the library is offered too (to get its files).
    check('Add Links offers the new ones, and online models when downloading', (await editorPage.textContent('#jp-links-start')) === 'Add 2 models'
      && await editorPage.isChecked('#jp-links-download-toggle'));
    await editorPage.uncheck('#jp-links-download-toggle');
    check('Add Links offers only the new ones without downloading', (await editorPage.textContent('#jp-links-start')) === 'Add 1 model');
    await editorPage.check('#jp-links-download-toggle');
    // Not signed in to MakerWorld: the dialog says so, with the steps; editors are not offered the admin-only settings.
    check('Add Links says MakerWorld downloads need a sign-in, and how', await editorPage.waitForSelector('#jp-site-setup:has-text("To download models from MakerWorld, you need to sign in")', { timeout: 10000 }).then(() => true, () => false)
      && await editorPage.isVisible('#jp-site-setup a[href="https://makerworld.com/en"]') && !(await editorPage.isVisible('#jp-site-setup-open-makerworld')));
    await editorPage.keyboard.press('Escape');

    await editorPage.evaluate(() => { window.location.hash = '#/stats'; });
    check('Statistics shows the prints', await editorPage.waitForSelector('#jp-stats-tiles .jp-stat__value:text-is("3")', { timeout: 15000 }).then(() => true, () => false)
      && await editorPage.isVisible('#jp-stats-tiles :text("75%")'));
    check('the prints chart is drawn with a legend', await editorPage.isVisible('.jp-chart svg[aria-label="Prints per month by outcome"]')
      && await editorPage.isVisible('.jp-chart__legend :text("Failed")'));
    await editorPage.click('button:has-text("Show table")', { timeout: 5000 }).catch(() => {});
    check('the chart has a table view', await editorPage.isVisible('.jp-stats__table'));

    // Collections page and the Share dialog with its QR code.
    await editorPage.evaluate((id) => { window.location.hash = `#/collections/${id}`; }, giftId);
    check('a collection page lists its models', await editorPage.waitForSelector('#jp-collection-models .jp-recent-card', { timeout: 15000 }).then(() => true, () => false)
      && (await editorPage.textContent('#jp-collection-title')) === 'E2E Gifts');
    await editorPage.click('#jp-share-collection');
    await editorPage.waitForSelector('#jp-share-create', { timeout: 5000 });
    await editorPage.click('#jp-share-create');
    check('the Share dialog makes a link with a QR code', await editorPage.waitForSelector('.jp-share__qr svg', { timeout: 10000 }).then(() => true, () => false)
      && /\/s\/[A-Za-z0-9_-]{24}$/.test(await editorPage.inputValue('#jp-share-url')));
    await editorPage.keyboard.press('Escape');

    const viewerPage = await open('kid', 'kid-password');
    await viewerPage.evaluate(() => { window.location.hash = '#/library'; });
    await viewerPage.waitForTimeout(1500);
    check('viewers have no Upload or Add Links button', !(await viewerPage.isVisible('#jp-upload-button')) && !(await viewerPage.isVisible('#jp-links-button')));
    // A viewer's details panel shows the model but offers no edits.
    await viewerPage.click('.file-grid [data-filepath] .file-name', { timeout: 10000 }).catch(() => {});
    await viewerPage.waitForSelector('#model-designer', { timeout: 10000 }).catch(() => {});
    check('a viewer\'s details panel is read-only', await viewerPage.isDisabled('#model-designer')
      && !(await viewerPage.isVisible('#tag-select')) && !(await viewerPage.isVisible('#open-notes-modal-button'))
      && !(await viewerPage.isVisible('#jp-details-log-print'))
      && await viewerPage.isDisabled('#model-print-status') && !(await viewerPage.isVisible('#edit-mode-toggle')));
    check('viewers still open models in a slicer from the details', await viewerPage.isVisible('#jp-details-open-slicer'));
    check('viewers see no library tools in the sidebar', !(await viewerPage.isVisible('.jp-sidebar .jp-nav__row:has-text("Scan Library")'))
      && await viewerPage.isVisible('.jp-sidebar .jp-nav__row:has-text("Statistics")'));
    await viewerPage.evaluate(() => { window.location.hash = '#/organize'; });
    check('an admin page opened by its address says so', await viewerPage.waitForSelector(':text("Not available to your account")', { timeout: 5000 }).then(() => true, () => false));
    await viewerPage.evaluate(() => { window.location.hash = '#/settings'; });
    await viewerPage.waitForSelector('.jp-settings-page', { timeout: 5000 });
    check('viewers see only their settings', await viewerPage.isVisible('.jp-settings-row:has-text("Change Password")')
      && !(await viewerPage.isVisible('#setting-users')) && !(await viewerPage.isVisible('.jp-settings-index :text("Backup")')));
    await viewerPage.click('.jp-settings-row:has-text("Change Password")');
    await viewerPage.fill('#change-password-current', 'kid-password');
    await viewerPage.fill('#change-password-new', 'kid-new-password');
    await viewerPage.fill('#change-password-confirm', 'kid-new-password');
    await viewerPage.click('#change-password-save');
    check('a user changes their own password and is logged out', await viewerPage.waitForURL(/\/login/, { timeout: 20000 }).then(() => true, () => false));
    check('the new password works', !!(await loginAs(base, 'kid', 'kid-new-password')) && !(await loginAs(base, 'kid', 'kid-password')));

    const adminPage = await open('admin', PASSWORD);
    await adminPage.evaluate(() => { window.location.hash = '#/settings/authentication'; });
    await adminPage.waitForSelector('#users-list .users-row', { timeout: 15000 });
    await adminPage.fill('#users-new-name', 'guest-viewer');
    await adminPage.fill('#users-new-password', 'guest-password');
    await adminPage.click('#users-add');
    check('Settings → Users adds a user', await adminPage.waitForSelector('.users-row[data-username="guest-viewer"]', { timeout: 10000 }).then(() => true, () => false));
    await adminPage.selectOption('.users-row[data-username="guest-viewer"] select', 'editor');
    check('Settings → Users changes a role', await waitFor(async () => (((await invoke(base, admin, 'list-users')).result || {}).users || [])
      .some((u) => u.username === 'guest-viewer' && u.role === 'editor'), 10000, 'role change').catch(() => false));
    check('the JUSTTPRINT_PASSWORD account cannot be changed here', await adminPage.isDisabled('.users-row[data-username="admin"] select'));
    // Edits from two browsers at once (src/core/edit-merge.js): live updates, conflicts, tag merges.
    const cardOf = (fp) => `.file-grid [data-filepath="${fp.replace(/"/g, '\\"')}"] .file-name`;
    for (const p of [editorPage, adminPage]) {
      await p.evaluate(() => { window.location.hash = '#/library'; });
      await p.waitForSelector(cardOf(uploadedPath), { timeout: 15000 }).catch(() => {});
      await p.click(cardOf(uploadedPath)).catch(() => {});
      await p.waitForSelector('#model-designer', { timeout: 10000 }).catch(() => {});
    }
    await invoke(base, admin, 'save-model', [{ filePath: uploadedPath, designer: 'Live Designer' }]);
    check('a change made elsewhere shows up in another browser\'s details panel', await editorPage.waitForFunction(
      () => document.getElementById('model-designer')?.value === 'Live Designer', null, { timeout: 15000 }).then(() => true, () => false));
    await editorPage.click('#model-notes-preview');
    await editorPage.waitForSelector('#notes-modal-dialog[open] #notes-richtext', { timeout: 10000 });
    await invoke(base, admin, 'save-model', [{ filePath: uploadedPath, notes: 'Their note' }]);
    await editorPage.fill('#notes-richtext', 'My note');
    await editorPage.click('#save-notes-button');
    const conflictBox = await editorPage.waitForSelector('dialog[id^="browser-message-"][open]:has-text("Changed by someone else")', { timeout: 10000 }).catch(() => null);
    check('saving notes someone else changed meanwhile asks which to keep', !!conflictBox
      && /Their note/.test(await conflictBox.textContent()) && /My note/.test(await conflictBox.textContent()));
    if (conflictBox) await editorPage.click('dialog[id^="browser-message-"][open] button:text-is("Keep Both")');
    const keptBoth = await waitFor(async () => {
      const notes = ((await invoke(base, admin, 'get-model', [uploadedPath])).result || {}).notes || '';
      return /Their note/.test(notes) && /My note/.test(notes) ? notes : null;
    }, 10000, 'both notes').catch(() => '');
    check('Keep Both keeps their notes and mine', !!keptBoth, keptBoth);
    // Tags: what each edit added or removed is applied to what is stored, so both changes stay.
    await invoke(base, admin, 'save-model', [{ filePath: uploadedPath, tags: ['red', 'toy'] }]);
    const merged = await invoke(base, editor, 'save-model', [{ filePath: uploadedPath, tags: ['toy', 'boat'], _base: { tags: ['toy'] } }]);
    const mergedTags = (((await invoke(base, admin, 'get-model', [uploadedPath])).result || {}).tags || []).map((t) => t.name || t).sort().join(',');
    check('tags changed in two places keep both changes', merged.status === 200 && mergedTags === 'boat,red,toy', mergedTags);
    const stale = await invoke(base, editor, 'save-model', [{ filePath: uploadedPath, designer: 'Mine', _base: { designer: 'An old value' } }]);
    check('a save from an old view reports the conflict and saves nothing', (stale.result?.conflicts || [])[0]?.field === 'designer'
      && ((await invoke(base, admin, 'get-model', [uploadedPath])).result || {}).designer === 'Live Designer', JSON.stringify(stale));
    // Undo (src/web/library/undo.ts): the notice's button, then Ctrl/Cmd+Z.
    const sourceNow = async () => ((await invoke(base, admin, 'get-model', [uploadedPath])).result || {}).source || '';
    const sourceBefore = await sourceNow();
    await editorPage.evaluate(() => window.reloadShownModelDetails?.());
    for (const [how, typed] of [['the Undo button', 'https://example.com/undo-button'], ['Ctrl/Cmd+Z', 'https://example.com/undo-key']]) {
      await editorPage.fill('#model-source', typed);
      await editorPage.press('#model-source', 'Enter');
      const saved = await waitFor(async () => (await sourceNow()) === typed, 10000, 'source saved').catch(() => false);
      const toast = await editorPage.waitForSelector('[data-testid="undo-toast"]:has-text("Changed the source")', { timeout: 10000 }).catch(() => null);
      if (how === 'the Undo button') await editorPage.click('[data-testid="undo-toast"] button:text-is("Undo")').catch(() => {});
      else {
        // The shortcut is off while typing in a field: leave it first, as a person would.
        await editorPage.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
        await editorPage.keyboard.press('ControlOrMeta+z');
      }
      const undone = await waitFor(async () => (await sourceNow()) === sourceBefore, 10000, 'source undone').catch(() => false);
      check(`${how} undoes a details edit`, saved && !!toast && undone, await sourceNow());
    }
    check('the details panel shows the undone value', await editorPage.waitForFunction(
      (v) => document.getElementById('model-source')?.value === v, sourceBefore, { timeout: 10000 }).then(() => true, () => false));
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
