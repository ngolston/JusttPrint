#!/usr/bin/env node
'use strict';

/**
 * End-to-end test: starts the server on plain Node with a fresh data folder and a copy of
 * tests/fixtures/library, then checks the API, security rules and the web UI in a browser.
 *
 *   npm run test:e2e
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
const PASSWORD = 'e2e-test-password';
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
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.js')], {
    cwd: ROOT,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      JUSTTPRINT_USER_DATA: DATA,
      JUSTTPRINT_PORT: String(port),
      JUSTTPRINT_PASSWORD: PASSWORD,
      JUSTTPRINT_ENABLE_ZIP: 'true',
      STL_HOME: LIBRARY,
      // Keep Move to Trash inside the work folder (the home trash is the fallback on a single-drive machine).
      XDG_DATA_HOME: path.join(WORK, 'share'),
      ...(CHROME ? { JUSTTPRINT_CHROMIUM: CHROME } : {})
    }
  });
  return child;
}

function stopServer(child) {
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
async function invoke(base, { cookie, origin }, channel, args = []) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
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

async function apiChecks(base, wsUrl) {
  const anon = client(base);
  const http = client(base);
  const file = (p) => `/api/file/${encodeURIComponent(p)}`;
  const download = (p) => `/api/download/${encodeURIComponent(p)}`;
  const cube = path.join(LIBRARY, 'Designer A', 'cube.stl');
  const box = path.join(LIBRARY, 'Designer B', 'box.3mf');

  console.log('\n# HTTP and login');
  check('health without login', (await anon.request('/api/health')).status === 200);
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
  check('home after login', (await http.request('/')).status === 200);
  check('web asset served', (await http.request('/renderer.js')).status === 200);
  for (const hidden of ['/main.js', '/spoolman.js', '/src/core/spoolman.js', '/package.json', '/node_modules/express/package.json', '/src/server/index.js']) {
    check(`${hidden} not served`, (await http.request(hidden)).status === 404);
  }

  console.log('\n# Security headers');
  const health = await http.request('/api/health');
  check('nosniff', health.headers.get('x-content-type-options') === 'nosniff');
  check('frame-ancestors', /frame-ancestors 'self'/.test(health.headers.get('content-security-policy') || ''));
  check('CSP allows only script files from this server', /script-src 'self' 'wasm-unsafe-eval';/.test(health.headers.get('content-security-policy') || '') && !/unsafe-inline/.test(health.headers.get('content-security-policy') || ''));
  const cspOf = async (urlPath) => (await http.request(urlPath)).headers.get('content-security-policy') || '';
  check('page scripts may not eval', !/'unsafe-eval'/.test(await cspOf('/renderer.js')));
  check('only the parse worker may eval (STEP library)', /'unsafe-eval'/.test(await cspOf('/web-build/parse-worker.js')));
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
  for (const channel of ['getSetting', 'saveSetting', 'quitApp', 'open-path', 'fetch-makerworld-page', 'puter-ai-chat', 'is-server-mode']) {
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
  const thangs = await invoke(base, { cookie, origin }, 'fetch-thangs-page', ['http://127.0.0.1/']);
  check('page fetch outside Thangs refused', /Only https links to thangs\.com/.test(thangs.error || ''), JSON.stringify(thangs));
  check('scan of the app folder refused', refused(await invoke(base, { cookie, origin }, 'scan-directory', [path.join(ROOT, 'src')]), /cannot be scanned/));
  check('move out of library refused', refused(await invoke(base, { cookie, origin }, 'move-files', [[cube], '/tmp']), /outside the library/));
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
  const filament = (await ask('save-filament', [{ name: 'E2E PLA', material: 'PLA', color_hex: 'ff0000' }])).result;
  check('filament saved and listed', !!filament && ((await ask('get-all-filaments')).result || []).some((f) => f.id === filament.id && f.name === 'E2E PLA'));
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

    await page.goto(base + '/');
    check('browser lands on login page', page.url().includes('/login'));
    await page.fill('#password', 'wrong-password');
    await page.click('button[type=submit]');
    check('wrong password shows an error', await page.isVisible('.error'));
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    await page.waitForTimeout(3000);

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
      check('details add a new designer', designerSaved === true && await page.inputValue('#model-designer') === 'E2E Panel Designer'
        && /E2E Panel Designer/.test(await page.textContent(`${card} .designer-info`).catch(() => '')));
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
        && await page.waitForFunction((sel) => document.querySelector(`${sel} .print-status`)?.textContent === 'Queued', card, { timeout: 10000 }).then(() => true, () => false));
      const printsBefore = Number((await panelModel()).print_count) || 0;
      await page.click('#log-print-button');
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
      // Filaments in the details panel (React, src/web/details/DetailsFilaments.tsx).
      const hasPanelFilament = async () => ((await panelModel()).filaments || []).some((f) => f.name === 'E2E PLA');
      const filamentChip = '#model-filaments .filament-chip:has(.filament-chip-text:text-is("E2E PLA (PLA)"))';
      await page.waitForSelector('#filament-select option:text-is("E2E PLA (PLA)")', { state: 'attached', timeout: 10000 }).catch(() => {});
      await page.selectOption('#filament-select', { label: 'E2E PLA (PLA)' }).catch(() => {});
      check('details add a filament from the picker', await waitFor(async () => ((await hasPanelFilament()) ? true : null), 10000, 'filament added').catch(() => false) === true
        && await page.isVisible(filamentChip)
        && !(await page.$('#filament-select option:text-is("E2E PLA (PLA)")')));
      await page.click(`${filamentChip} .filament-chip-remove`);
      check('details remove a filament', await waitFor(async () => (!(await hasPanelFilament()) ? true : null), 10000, 'filament removed').catch(() => false) === true
        && !(await page.isVisible(filamentChip)));
      await page.click('.form-group:has(#filament-select) .list-button');
      const filamentItem = await page.waitForSelector('#searchable-list-dialog[open] li:text-is("E2E PLA (PLA)")', { timeout: 10000 }).catch(() => null);
      if (filamentItem) await filamentItem.click();
      else await page.evaluate(() => document.getElementById('searchable-list-dialog')?.close());
      check('details pick a filament from the list', !!filamentItem
        && await waitFor(async () => ((await hasPanelFilament()) ? true : null), 10000, 'filament picked').catch(() => false) === true
        && await page.waitForSelector(filamentChip, { timeout: 10000 }).then(() => true, () => false));
      await page.click(`${filamentChip} .filament-chip-remove`);
      await waitFor(async () => (!(await hasPanelFilament()) ? true : null), 10000, 'filament cleanup').catch(() => {});
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
      check('Reveal in folders opens the tree at the model\'s folder',
        await page.waitForSelector(`${treeRow('#folder-tree-popover')}.is-selected`, { timeout: 10000 }).then(() => true, () => false));
      await page.click('#folder-tree-button');
      check('the ☰ button closes the folder popover', await page.waitForSelector('#folder-tree-popover', { state: 'detached', timeout: 5000 }).then(() => true, () => false));
      await page.selectOption('#folder-select', '');
      check('"All folders" clears the folder', await page.waitForFunction(() => window.currentDirectoryFilter === '', null, { timeout: 10000 }).then(() => true, () => false));
      await page.click('#folder-tree-button');
      await page.fill('#folder-tree-search', path.basename(cardDir));
      await page.click(treeRow('#folder-tree-popover'));
      check('picking a folder in the popover shows it and closes the popover',
        await page.waitForFunction((dir) => window.currentDirectoryFilter === dir, cardDir, { timeout: 10000 }).then(() => true, () => false)
        && !(await page.isVisible('#folder-tree-popover')));
      await page.click('#folder-rail-toggle');
      check('the Folders toggle opens the rail beside the grid',
        await page.waitForSelector(`${treeRow('#folder-rail')}.is-selected`, { timeout: 10000 }).then(() => true, () => false)
        && await page.evaluate(() => document.body.classList.contains('folder-rail-open')));
      await page.click('#folder-rail-close');
      const railSetting = await waitFor(async () => ((await invoke(base, session, 'get-setting', ['folderRailOpen'])).result === 'false' ? true : null), 5000, 'rail setting').catch(() => false);
      check('closing the rail hides it and saves that', railSetting === true && !(await page.isVisible('#folder-rail')));
      const handle = await page.locator('#sidebar-resize-handle').boundingBox();
      const widthBefore = await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).width);
      if (handle) {
        await page.mouse.move(handle.x + handle.width / 2, handle.y + 200);
        await page.mouse.down();
        await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + 200, { steps: 4 });
        await page.mouse.up();
      }
      const savedWidth = await waitFor(async () => (await invoke(base, session, 'get-setting', ['sidebarWidth'])).result || null, 5000, 'sidebar width').catch(() => null);
      check('dragging the sidebar edge resizes it and saves the width', !!handle && Number(savedWidth) > parseInt(widthBefore, 10) - 5
        && (await page.evaluate(() => document.documentElement.style.getPropertyValue('--sidebar-width'))) === `${savedWidth}px`, `${widthBefore} → ${savedWidth}`);
      await page.evaluate(() => document.documentElement.style.removeProperty('--sidebar-width'));
      // Sidebar actions (React, src/web/filters/SidebarActions.tsx): counts, Scan Directory, View Entire Library.
      const totalModels = (await invoke(base, session, 'getTotalModelCount', [])).result;
      const counted = await page.waitForFunction((n) => document.getElementById('total-count')?.textContent === `${n} model${n === 1 ? '' : 's'} total`
        && /^\d+ models? in view$/.test(document.getElementById('view-count')?.textContent || ''), totalModels, { timeout: 10000 }).then(() => true, () => false);
      check('the sidebar shows the models in view and in total', counted, await page.textContent('.model-stats'));
      await page.click('#scan-directory-button');
      const scanPrompt = await page.waitForSelector('dialog.browser-input-dialog[open]:has-text("Scan Directory")', { timeout: 10000 }).catch(() => null);
      if (scanPrompt) await page.click('dialog.browser-input-dialog[open] button:text-is("Cancel")');
      check('Scan Directory asks for a container folder; Cancel scans nothing', !!scanPrompt && await page.isEnabled('#scan-directory-button')
        && !(await page.isVisible('dialog.browser-input-dialog[open]')));
      await page.click('#view-library-button');
      check('View Entire Library leaves the folder', await page.waitForFunction(() => window.currentDirectoryFilter === '', null, { timeout: 10000 }).then(() => true, () => false));
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
      await invoke(base, session, 'update-models-batch', [[{ filePath: cardPath, designer: null, source: null }, { filePath: listedOn, designer: null }]]);
      await page.click(`${card} .model-star[data-star="3"]`);
      const rated = await waitFor(async () => (((await invoke(base, session, 'get-model', [cardPath])).result || {}).rating === 3 ? true : null), 10000, 'rating').catch(() => false);
      check('a card saves its star rating', rated === true && (await page.locator(`${card} .model-star.is-filled`).count()) === 3);
      await page.click(`${card} .model-favorite-btn`);
      const favorited = await waitFor(async () => (((await invoke(base, session, 'get-model', [cardPath])).result || {}).favorite ? true : null), 10000, 'favorite').catch(() => false);
      check('a card saves its favorite', favorited === true && await page.isVisible(`${card} .model-favorite-btn.is-favorited`));
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
      await page.click('#roulette-button');
      const rouletteDone = await page.waitForSelector('dialog[id^="browser-message-"][open]:has-text("Print Roulette") button', { timeout: 20000 }).catch(() => null);
      const picked = await selectedPaths();
      check('Print Roulette picks one model and shows it', !!rouletteDone && picked.length === 1
        && await page.getAttribute('#path-tree-container', 'data-file-path') === picked[0], JSON.stringify(picked));
      if (rouletteDone) await rouletteDone.click();

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
      // "More filters" folds away while a details panel is open.
      if (!(await page.isVisible('#designer-select'))) await page.click('#filter-stack-toggle');
      await page.selectOption('#designer-select', 'E2E Sidebar Designer');
      const byDesigner = await waitShown([other]);
      check('the designer filter narrows the grid and shows in the filter strip', byDesigner === true
        && /Showing 1 models.*Designer: E2E Sidebar Designer/.test(await stripText()), `${byDesigner} ${await stripText()}`);
      await page.click('#current-filter-body .filter-pill:has-text("Designer:") .filter-remove');
      check('removing a filter chip shows the library again', await waitShown([cardPath, other, third]) === true && !(await page.isVisible('#current-filter-body .filter-pill')));
      const cardName = path.basename(cardPath);
      await page.fill('#search-filter-input', cardName);
      await page.press('#search-filter-input', 'Enter');
      check('a search narrows the grid and becomes a chip', await waitShown([cardPath]) === true && await page.inputValue('#search-filter-input') === ''
        && (await stripText()).includes(`Search: "${cardName}"`));
      await page.click('#search-add-or-btn');
      const awaitingHint = await page.isVisible('#search-boolean-hint');
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
      await page.selectOption('#sort-select', 'name-asc');
      const savedSort = await waitFor(async () => ((await invoke(base, session, 'get-setting', ['sortOption'])).result === 'name-asc' ? true : null), 10000, 'sort saved').catch(() => false);
      const sortedNames = await page.$$eval('.file-grid .file-item-detailed .file-name', (els) => els.map((el) => el.textContent.trim().toLowerCase()));
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
      const petg = (await invoke(base, session, 'save-filament', [{ name: 'E2E PETG', material: 'PETG', color_hex: '00ff00' }])).result;
      await invoke(base, session, 'update-models-batch', [[{ filePath: cardPath, filaments: [petg.id] }]]);
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
      await page.selectOption('#multi-filament-select', { label: 'E2E PLA (PLA)' }).catch(() => {});
      const filamentNames = (m) => (m.filaments || []).map((f) => f.name);
      const plaOnBoth = await waitFor(async () => ((await pairModels()).every((m) => filamentNames(m).includes('E2E PLA')) ? true : null), 10000, 'multi filament').catch(() => false);
      check('multi-edit adds a filament to every selected model', plaOnBoth === true && await page.isVisible('#multi-filaments .filament-chip:has-text("E2E PLA")'));
      await page.waitForSelector('#multi-filament-remove-select option:text-is("E2E PLA (PLA)")', { state: 'attached', timeout: 10000 }).catch(() => {});
      await page.selectOption('#multi-filament-remove-select', { label: 'E2E PLA (PLA)' }).catch(() => {});
      const plaRemoved = await waitFor(async () => {
        const [first, second] = await pairModels();
        return !filamentNames(first).includes('E2E PLA') && !filamentNames(second).includes('E2E PLA') && filamentNames(first).includes('E2E PETG') ? true : null;
      }, 10000, 'multi filament removed').catch(async () => JSON.stringify((await pairModels()).map(filamentNames)));
      check('multi-edit removes one filament and keeps the others', plaRemoved === true, String(plaRemoved));
      await invoke(base, session, 'update-models-batch', [pairBefore.map((m) => ({ filePath: m.filePath, designer: m.designer || null, tags: m.tags || [], filaments: [] }))]);
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
    await page.click('.view-button[data-view="preview"]');

    // CSP (script-src 'self'): controls that used inline onclick="" still work.
    await page.evaluate(() => document.getElementById('searchable-list-dialog').showModal());
    await page.click('#searchable-list-dialog [data-close-dialog="searchable-list-dialog"]');
    check('data-close-dialog button closes its dialog', await page.evaluate(() => !document.getElementById('searchable-list-dialog').open));
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
    await page.evaluate(() => window.electron.send('open-metadata-editor'));
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
        check('designer renamed on the server', renamed === true);
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
    await page.evaluate(() => window.electron.send('open-tag-manager'));
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

    // Filament Manager (React): Spoolman panel, add with a color, remove.
    const serverFilaments = async () => (await invoke(base, session, 'get-all-filaments')).result || [];
    await page.evaluate(() => window.openFilamentManager());
    check('Filament Manager opens', await page.isVisible('#filament-manager-dialog'));
    await page.click('#spoolman-setup-toggle');
    await page.fill('#spoolman-url', '');
    await page.click('#spoolman-test-button');
    await page.waitForSelector('#spoolman-setup-status:has-text("Enter a Spoolman URL first")', { timeout: 10000 }).catch(() => {});
    check('Spoolman setup asks for a URL', /Enter a Spoolman URL first/.test(await page.textContent('#spoolman-setup-status')));
    await page.click('#spoolman-setup-toggle');
    check('Spoolman panel hides', !(await page.isVisible('#spoolman-setup-panel')));
    await page.click('#filament-toggle-add-btn');
    await page.fill('#new-filament-name', 'E2E Galaxy Black');
    await page.fill('#new-filament-vendor', 'E2E Vendor');
    await page.fill('#new-filament-material', 'PLA');
    await page.fill('#new-filament-color', '1a2b3c');
    check('typing a hex color updates the picker', (await page.inputValue('#new-filament-color-picker')) === '#1a2b3c');
    await page.click('#add-filament-manager-button');
    const filamentRow = await page.waitForSelector('#filament-manager-list .filament-manager-item:has-text("E2E Galaxy Black")', { timeout: 10000 }).catch(() => null);
    const filament = (await serverFilaments()).find((f) => f.name === 'E2E Galaxy Black');
    check('Filament Manager adds a filament', !!filamentRow && filament && filament.color_hex === '1A2B3C' && filament.material === 'PLA' && filament.diameter === 1.75, JSON.stringify(filament));
    check('filament status is shown after adding', /Added E2E Galaxy Black/.test(await page.textContent('#filament-manager-status')));
    if (filament) {
      const added = await page.evaluate((id) => [...document.querySelectorAll('#filament-select option')].some((o) => o.value === String(id)), filament.id);
      check('new filament appears in the model filament picker', added);
      await page.click(`#filament-manager-list .filament-manager-item[data-filament-id="${filament.id}"] .filament-remove`);
      const confirmRemove = await page.waitForSelector('dialog[open]:has-text("Remove Filament") button:text-is("Remove")', { timeout: 10000 }).catch(() => null);
      if (confirmRemove) await confirmRemove.click();
      await page.waitForSelector(`#filament-manager-list .filament-manager-item[data-filament-id="${filament.id}"]`, { state: 'detached', timeout: 10000 }).catch(() => {});
      check('Filament Manager removes a filament after asking', !!confirmRemove && !(await serverFilaments()).some((f) => f.id === filament.id));
    }
    await page.click('#filament-manager-close');
    check('Filament Manager closes', !(await page.isVisible('#filament-manager-dialog')));

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

    // Library Stats (React): counts match get-stats, and both charts draw.
    const serverStats = (await invoke(base, session, 'get-stats')).result || {};
    // Opened from the menu bar (React, src/web/shell/MenuBar.tsx).
    await page.click('#server-menu-bar .server-menu-button:text-is("Help")');
    await page.click('#server-menu-bar .server-menu-item:text-is("Library Stats")');
    check('Library Stats opens from the Help menu', await page.isVisible('#stats-dialog') && !(await page.isVisible('#server-menu-bar .server-menu-dropdown')));
    const shownTotal = await page.waitForFunction((total) => {
      const text = document.getElementById('stats-total-models')?.textContent;
      return text === total ? text : null;
    }, String(serverStats.totalModels || 0), { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => null);
    check('Library Stats shows the model count', shownTotal !== null, `${shownTotal} vs ${serverStats.totalModels}`);
    check('Library Stats draws its charts', await page.isVisible('#stats-dialog .stats-pie svg') && (await page.locator('#stats-dialog .stats-bar-row').count()) === 4);
    await page.click('#stats-dialog .dialog-buttons button');
    check('Library Stats closes', !(await page.isVisible('#stats-dialog')));
    await page.click('#server-menu-bar .server-menu-button:text-is("Tools")');
    await page.hover('#server-menu-bar .server-menu-item-has-submenu:has-text("MCP Server")');
    check('a menu submenu opens on hover', await page.isVisible('#server-menu-bar .server-menu-subitem:text-is("HTTPS / SSL")'));
    await page.click('main');
    check('a click outside closes the menu', !(await page.isVisible('#server-menu-bar .server-menu-dropdown')));

    // Phone layout (React, src/web/shell/MobileShell.tsx), same session at phone size.
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      storageState: await page.context().storageState() })).newPage();
    phone.on('pageerror', (error) => errors.push(`phone: ${error.message}`));
    await phone.goto(base + '/');
    await phone.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    const phoneTile = await phone.waitForSelector('.file-grid [data-filepath]', { timeout: 30000 }).catch(() => null);
    check('the phone layout shows the app bar and bottom nav instead of the menu bar', await phone.isVisible('#mobile-app-bar') && await phone.isVisible('#mobile-bottom-nav')
      && !(await phone.isVisible('#server-menu-bar')) && (await phone.textContent('#mobile-bar-title')) === 'Library'
      && /^\d+ models?$/.test(await phone.textContent('#mobile-bar-count')));
    check('the phone shows the wall, not the detailed cards', await phone.waitForSelector('.view-button.active[data-view="preview"]', { state: 'attached', timeout: 10000 }).then(() => true, () => false)
      && await phone.isVisible('#mobile-app-bar [data-mobile-view="preview"].is-active'));
    await phone.tap('#mobile-nav-filters');
    check('Filters opens the sidebar as a sheet', await phone.evaluate(() => document.body.classList.contains('mobile-sidebar-open'))
      && await phone.isVisible('#mobile-drawer-head') && await phone.isVisible('#mobile-nav-filters.is-active'));
    await phone.tap('#mobile-drawer-done');
    check('Done closes the Filters sheet', !(await phone.evaluate(() => document.body.classList.contains('mobile-sidebar-open'))) && !(await phone.isVisible('#mobile-ui-overlay')));
    await phone.tap('#mobile-nav-more');
    check('More lists the tools and the rest of the menu', await phone.isVisible('#mobile-more-sheet .mobile-tool[data-menu-label="Tag Manager"]')
      && await phone.isVisible('#mobile-more-sections .mobile-more-row:text-is("Theme")')
      && !(await phone.isVisible('#mobile-more-sections .mobile-more-row:text-is("Tag Manager")')));
    await phone.tap('#mobile-more-sections .mobile-more-row:text-is("MCP Server")');
    check('a submenu opens as its own page', (await phone.textContent('#mobile-more-title')) === 'MCP Server' && await phone.isVisible('#mobile-more-drill .mobile-more-row:text-is("HTTPS / SSL")'));
    await phone.tap('#mobile-more-back');
    await phone.tap('#mobile-more-sections .mobile-more-row:text-is("Library Stats")');
    check('a More action closes the sheet and opens its screen', await phone.waitForSelector('#stats-dialog[open]', { timeout: 10000 }).then(() => true, () => false)
      && !(await phone.isVisible('#mobile-more-sheet')));
    await phone.click('#stats-dialog .dialog-buttons button');
    if (phoneTile) {
      await phoneTile.tap();
      const phoneDetails = await phone.waitForFunction(() => document.body.classList.contains('mobile-details-open'), null, { timeout: 10000 }).then(() => true, () => false);
      check('tapping a model opens its details as a sheet with its name', phoneDetails
        && (await phone.textContent('#mobile-details-name')).trim().length > 0 && await phone.isVisible('#mobile-details-open-preview'));
      await phone.tap('#model-details .mobile-panel-close');
      check('× closes the details sheet', await phone.waitForFunction(() => !document.body.classList.contains('mobile-details-open'), null, { timeout: 5000 }).then(() => true, () => false));
    }
    await phone.close();

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
    await page.evaluate(() => window.openBackupRestore());
    check('Backup/Restore opens', await page.isVisible('#backup-restore-dialog'));
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
    await page.click('#save-backup-restore');
    check('Backup/Restore closes', !(await page.isVisible('#backup-restore-dialog')));

    // Keyboard Shortcuts and About (React).
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+?' : 'Control+Shift+?');
    check('Ctrl+Shift+? opens Keyboard Shortcuts', await page.isVisible('#keyboard-shortcuts-dialog')
      && (await page.locator('#keyboard-shortcuts-dialog .shortcut-row').count()) === 12);
    await page.click('#keyboard-shortcuts-dialog .dialog-buttons button');
    check('Keyboard Shortcuts closes', !(await page.isVisible('#keyboard-shortcuts-dialog')));
    // Shortcuts (React, src/web/shortcuts.ts).
    const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modKey}+/`);
    check('Ctrl+/ focuses the search box', await page.evaluate(() => document.activeElement?.id === 'search-filter-input'));
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
    const mcpConfig = await page.waitForFunction(() => {
      const text = document.getElementById('mcp-server-config')?.textContent || '';
      return text.includes('Bearer') ? text : null;
    }, null, { timeout: 10000 }).then((h) => h.jsonValue()).catch(() => '');
    let parsedConfig = null;
    try { parsedConfig = JSON.parse(mcpConfig).mcpServers.justtprint; } catch (_) { /* checked below */ }
    check('MCP client config has the URL and API token', !!parsedConfig && parsedConfig.url === `${base}/mcp`
      && parsedConfig.headers && parsedConfig.headers.Authorization === `Bearer ${apiToken}`, mcpConfig.slice(0, 200));
    check('MCP settings list the tools', /search_models/.test(await page.textContent('#mcp-server-tools').catch(() => '')));
    await page.click('#cancel-mcp-server-settings');
    check('MCP Server settings closes', !(await page.isVisible('#mcp-server-settings-dialog')));

    // Browser Extension settings (React): Import now reports, Save stores the path mapping.
    await page.evaluate(() => window.openBrowserExtensionSettings());
    await page.waitForSelector('#browser-extension-settings-dialog[open]', { timeout: 10000 }).catch(() => {});
    check('Browser Extension settings opens', await page.isVisible('#browser-extension-settings-dialog'));
    await page.click('#import-extension-inbox-now');
    const inboxStatus = await page.waitForFunction(() => {
      const text = document.getElementById('extension-inbox-last-status')?.textContent || '';
      return /just now|already running/.test(text) ? text : null;
    }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null);
    check('Import now reports the result', !!inboxStatus, inboxStatus);
    await page.fill('#extension-client-path-prefix', '  C:\\Downloads  ');
    await page.click('#save-browser-extension-settings');
    await page.waitForSelector('#browser-extension-settings-dialog', { state: 'hidden', timeout: 10000 }).catch(() => {});
    check('Browser Extension settings saves (trimmed)', (await invoke(base, session, 'get-setting', ['extensionClientPathPrefix'])).result === 'C:\\Downloads'
      && !(await page.isVisible('#browser-extension-settings-dialog')));
    await invoke(base, session, 'save-setting', ['extensionClientPathPrefix', '']);

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

    // Theme settings (React): saving a theme applies its accent color without a regenerate prompt.
    const savedTheme = (await invoke(base, session, 'get-setting', ['uiTheme'])).result;
    await page.evaluate(() => window.openThemeSettings());
    await page.waitForSelector('#settings-dialog[open]', { timeout: 10000 }).catch(() => {});
    check('Theme settings opens with the saved theme', await page.inputValue('#ui-theme') === (savedTheme || 'modern-cyan'));
    await page.selectOption('#ui-theme', 'modern-purple');
    await page.click('#save-settings');
    await page.waitForSelector('#settings-dialog', { state: 'hidden', timeout: 10000 }).catch(() => {});
    const accent = await page.evaluate(() => document.documentElement.style.getPropertyValue('--primary-accent').trim());
    check('Theme settings saves and applies the theme', (await invoke(base, session, 'get-setting', ['uiTheme'])).result === 'modern-purple'
      && accent === '#a855f7' && !(await page.isVisible('dialog[open]:has-text("Regenerate Thumbnails")')), accent);
    await invoke(base, session, 'save-setting', ['uiTheme', savedTheme || 'modern-cyan']);

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
    check('Scan STL Home button hides with no directories', await page.waitForSelector('#scan-stl-home-button', { state: 'hidden', timeout: 10000 }).then(() => true).catch(() => false));
    for (const key of stlHomeKeys) await invoke(base, session, 'save-setting', [key, savedStlHome[key] == null ? '' : savedStlHome[key]]);
    await page.evaluate(() => window.updateScanStlHomeButtonVisibility?.());

    // Organize Library (React): source picker, folder structure, preview, and a stale preview after a change. Not run.
    const savedLayers = (await invoke(base, session, 'get-setting', ['organizeLibraryLayers'])).result;
    await page.evaluate(() => window.openOrganizeLibrary());
    await page.waitForSelector('#organize-library-dialog[open]', { timeout: 10000 }).catch(() => {});
    check('Organize Library lists the scanned folders', await page.isEnabled('#organize-source-button'));
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
    await page.click('#organize-close-button');
    check('Organize Library closes', !(await page.isVisible('#organize-library-dialog')));
    await invoke(base, session, 'save-setting', ['organizeLibraryLayers', savedLayers == null ? '' : savedLayers]);

    // De-Dup (React): a copy of cube.stl shows as a duplicate; Easy with a preferred directory keeps the original; Delete removes the copy.
    const dedupOriginal = path.join(LIBRARY, 'Designer A', 'cube.stl');
    const dedupCopy = path.join(LIBRARY, 'Designer A', 'cube copy.stl');
    fs.copyFileSync(dedupOriginal, dedupCopy);
    await invoke(base, session, 'save-model', [{ filePath: dedupCopy, fileName: 'cube copy.stl' }]);
    await invoke(base, session, 'calculate-file-hash', [dedupOriginal]);
    await invoke(base, session, 'calculate-file-hash', [dedupCopy]);
    await page.click('#dup-button');
    const copyRow = `#dedup-dialog input[data-filepath="${dedupCopy}"]`;
    const originalRow = `#dedup-dialog input[data-filepath="${dedupOriginal}"]`;
    const dedupGroup = await page.waitForSelector(copyRow, { timeout: 30000 }).catch(() => null);
    check('De-Dup lists the duplicate pair', !!dedupGroup && await page.isVisible(originalRow));
    check('De-Dup scope: entire library without filters', await page.isChecked('#dedup-scope-entire') && await page.isDisabled('#dedup-scope-current'));
    await page.fill('#dedup-preferred-directory-input', path.join(LIBRARY, 'Designer A'));
    await page.press('#dedup-preferred-directory-input', 'Enter');
    check('Easy with a preferred directory keeps the original', await page.isChecked(copyRow) && !(await page.isChecked(originalRow))
      && (await page.locator('#dedup-dialog .preferred-directory-badge').count()) >= 2);
    check('De-Dup saves the preferred directory', (await invoke(base, session, 'get-setting', ['dedupPreferredDirectory'])).result === path.join(LIBRARY, 'Designer A'));
    await page.click('#dedup-clear-button');
    check('Clear unselects everything', !(await page.isChecked(copyRow)));
    await page.check(copyRow);
    await page.click('#delete-selected');
    const confirmDedupDelete = await page.waitForSelector('dialog[open]:has-text("Confirm Delete") button:text-is("Yes")', { timeout: 10000 }).catch(() => null);
    if (confirmDedupDelete) await confirmDedupDelete.click();
    const copyGone = await page.waitForSelector(copyRow, { state: 'detached', timeout: 15000 }).then(() => true).catch(() => false);
    check('Delete Selected removes the copy from disk and the list', !!confirmDedupDelete && copyGone && !fs.existsSync(dedupCopy) && fs.existsSync(dedupOriginal));
    await page.click('#close-dedup');
    check('De-Dup closes', !(await page.isVisible('#dedup-dialog')));
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

    // Purge Models (React). Empties the library, so it runs last among the library checks.
    await page.evaluate(() => window.openPurgeModels());
    check('Purge Models opens', await page.isVisible('#purge-models-dialog'));
    await page.click('#cancel-purge-button');
    check('Cancel keeps the models', ((await invoke(base, session, 'get-stats')).result || {}).totalModels > 0);
    await page.evaluate(() => window.openPurgeModels());
    await page.click('#confirm-purge-button');
    const purged = await page.waitForSelector('dialog[open]:has-text("All models have been purged") button:text-is("OK")', { timeout: 15000 }).catch(() => null);
    if (purged) await purged.click();
    check('Purge Models empties the library and the grid', !!purged && ((await invoke(base, session, 'get-stats')).result || {}).totalModels === 0
      && (await page.$$('.file-grid [data-filepath], .file-grid [data-file-path]')).length === 0);

    await page.evaluate(() => window.openServerAccess());
    check('Server Access dialog opens', await page.isVisible('#server-access-dialog'));
    const shownToken = await page.waitForFunction(() => document.getElementById('server-access-api-token')?.value, null, { timeout: 10000 })
      .then((handle) => handle.jsonValue()).catch(() => '');
    check('API token shown', String(shownToken).startsWith('pv_'), shownToken);
    // The e2e server's password comes from JUSTTPRINT_PASSWORD, so the dialog explains that instead of a form.
    check('password set by environment: no change form', await page.isVisible('text=JUSTTPRINT_PASSWORD') && !(await page.isVisible('#server-access-new-password')));
    await page.click('#close-server-access');
    check('Close closes Server Access', !(await page.isVisible('#server-access-dialog')));
    await page.evaluate(() => window.openServerAccess());
    check('Server Access reopens', await page.isVisible('#server-access-dialog'));
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
    exitCode = failed ? 1 : 0;
  } catch (error) {
    console.log(`FAIL e2e run: ${error.message}`);
  } finally {
    await stopServer(server);
    const log = fs.readFileSync(path.join(WORK, 'server.log'), 'utf8');
    check('server closed the database on shutdown', log.includes('[Quit] Database closed'));
    if (failed) console.log(`\nServer log: ${path.relative(ROOT, path.join(WORK, 'server.log'))}`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : exitCode);
  }
}

main();
