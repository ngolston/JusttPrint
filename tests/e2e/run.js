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
      messages.push(JSON.parse(String(raw)));
      if (messages.length === 1 && send) {
        ws.send(JSON.stringify(send));
        return;
      }
      clearTimeout(timer);
      ws.close();
      resolve({ hello: messages[0], reply: messages[1] });
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
  check('only the parse worker may eval (STEP library)', /'unsafe-eval'/.test(await cspOf('/parse-worker.js')));
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
    const restored = await invoke(base, { cookie, origin }, 'restore-database', [{ base64: fs.readFileSync(backupPath).toString('base64') }]);
    check('restore from a backup', restored.result && restored.result.success === true, JSON.stringify(restored));
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
      check(`3D preview opens: ${path.basename(filePath)}`, opened, errors.slice(errorsBefore).join(' | '));
      if (process.env.E2E_DEBUG) console.log(`     errors while open: ${errors.length - errorsBefore}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1500);
      if (process.env.E2E_DEBUG) console.log(`     errors after close: ${errors.length - errorsBefore}`);
    }

    // CSP (script-src 'self'): controls that used inline onclick="" still work.
    await page.evaluate(() => document.getElementById('about-dialog').showModal());
    await page.click('#about-dialog [data-close-dialog="about-dialog"]');
    check('data-close-dialog button closes its dialog', await page.evaluate(() => !document.getElementById('about-dialog').open));
    await page.evaluate(() => document.getElementById('tag-manager-dialog').showModal());
    await page.click('#tag-manager-fullscreen-toggle');
    check('data-action button calls its function', await page.evaluate(() => document.getElementById('tag-manager-dialog').classList.contains('modal-fullscreen')));
    await page.click('#tag-manager-fullscreen-toggle');
    await page.evaluate(() => document.getElementById('tag-manager-dialog').close());
    // STEP previews compile WebAssembly in the parse worker ('wasm-unsafe-eval').
    const stepResult = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const worker = new Worker('parse-worker.js');
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
    await invoke(base, session, 'save-slicer', [{ name: 'Browser Slicer', path: '/usr/bin/browser-slicer' }]);
    const helperLink = await page.evaluate(async (file) => {
      const slicers = await window.electron.getSlicers();
      const slicer = slicers.find((s) => s.name === 'Browser Slicer');
      const result = await window.electron.openFileInSlicer({ filePaths: [file], slicerId: slicer.id });
      window.electron.launchSlicerCommand(result.command);
      const frame = [...document.querySelectorAll('iframe')].find((f) => String(f.src).startsWith('justtprint://'));
      return frame ? frame.src : null;
    }, path.join(LIBRARY, 'Designer A', 'cube.stl'));
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
      }
    } else {
      check('Metadata Manager lists the designer', false, 'rename button not found');
    }
    await page.evaluate(() => document.getElementById('metadata-editor-dialog')?.close());

    // Server-initiated confirmation (Pull Metadata over existing details) shows in this browser.
    const box3mf = path.join(LIBRARY, 'Designer B', 'box.3mf');
    await invoke(base, session, 'update-models-batch', [[{ filePath: box3mf, designer: 'Keep Me' }]]);
    // Trace what the page sends on its WebSocket, to explain a failure below.
    await page.evaluate(() => {
      window.__wsSent = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) { window.__wsSent.push(String(data).slice(0, 160)); return send.call(this, data); };
      window.__clicks = [];
      for (const type of ['pointerdown', 'mousedown', 'click']) {
        document.addEventListener(type, (event) => {
          const t = event.target;
          window.__clicks.push(`${type}:${t.tagName}${t.id ? '#' + t.id : ''}${t.textContent && t.tagName === 'BUTTON' ? '(' + t.textContent + ')' : ''}@${event.clientX},${event.clientY}`);
        }, true);
      }
    });
    // Start the call without keeping page.evaluate waiting on it (on Linux CI, input does not reach the page meanwhile).
    await page.evaluate((file) => { window.__pull = window.electron.pull3MFMetadata([file]); }, box3mf);
    const pull = page.evaluate(() => window.__pull);
    const confirmDialog = await page.waitForSelector('dialog[open]:has-text("Confirm Metadata Overwrite") button:text-is("No")', { timeout: 15000 }).catch(() => null);
    const openDialogs = () => page.evaluate(() => [...document.querySelectorAll('dialog[open]')].map((d) => `${d.id || d.className}: ${d.textContent.trim().slice(0, 80)}`));
    check('server confirmation appears in the browser', !!confirmDialog, JSON.stringify(await openDialogs()));
    if (confirmDialog) {
      const before = await openDialogs();
      const noButton = 'dialog[open]:has-text("Confirm Metadata Overwrite") button:text-is("No")';
      const tried = [];
      const stillOpen = async () => (await openDialogs()).length > 0;
      const box0 = await confirmDialog.boundingBox();
      await page.mouse.click(box0.x + box0.width / 2, box0.y + box0.height / 2).catch((e) => tried.push('mouse error ' + e.message));
      tried.push(`mouse:${await stillOpen() ? 'open' : 'closed'}`);
      if (await stillOpen()) {
        await page.click(noButton, { timeout: 5000 }).catch((e) => tried.push('page.click error ' + e.message.split('\n')[0]));
        tried.push(`page.click:${await stillOpen() ? 'open' : 'closed'}`);
      }
      if (await stillOpen()) {
        await page.$eval(noButton, (b) => b.click()).catch((e) => tried.push('js error ' + e.message));
        tried.push(`js:${await stillOpen() ? 'open' : 'closed'}`);
      }
      const after = await openDialogs();
      const box = await confirmDialog.boundingBox();
      if (after.length) await page.screenshot({ path: path.join(WORK, 'confirm-dialog.png') }).catch(() => {});
      const pullResult = await pull.catch((error) => ({ error: error.message }));
      if (tried.length > 1) console.log(`     click attempts: ${tried.join(', ')}`);
      check('answering No cancels Pull Metadata', pullResult && pullResult.cancelled === true, `${JSON.stringify(pullResult)}; dialogs before click ${before.length}, after ${after.length}: ${JSON.stringify(after)}; sent: ${JSON.stringify(await page.evaluate(() => window.__wsSent))}; button at ${JSON.stringify(box)}; events: ${JSON.stringify(await page.evaluate(() => window.__clicks))}; tried: ${tried.join(', ')}`);
      const kept = await invoke(base, session, 'get-model', [box3mf]);
      check('existing designer kept', kept.result && kept.result.designer === 'Keep Me');
    }

    await page.evaluate(() => window.openServerAccess());
    check('Server Access dialog opens', await page.isVisible('#server-access-dialog'));
    check('API token shown', (await page.inputValue('#server-access-api-token')).startsWith('pv_'));
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
