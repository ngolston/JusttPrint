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
      PRINTVENTORY_USER_DATA: DATA,
      PRINTVENTORY_PORT: String(port),
      PRINTVENTORY_PASSWORD: PASSWORD,
      PRINTVENTORY_ENABLE_ZIP: 'true',
      STL_HOME: LIBRARY,
      // Keep Move to Trash inside the work folder (the home trash is the fallback on a single-drive machine).
      XDG_DATA_HOME: path.join(WORK, 'share'),
      ...(CHROME ? { PRINTVENTORY_CHROMIUM: CHROME } : {})
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

/** One request over the IPC WebSocket. Resolves to { result } or { error } or { rejected: status }. */
function invoke(wsUrl, { cookie, origin }, channel, args = []) {
  return new Promise((resolve) => {
    const headers = { Origin: origin };
    if (cookie) headers.Cookie = cookie;
    const ws = new WebSocket(wsUrl, { headers });
    const timer = setTimeout(() => { ws.terminate(); resolve({ error: 'timeout' }); }, 30000);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, type: 'invoke', channel, args })));
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      resolve(message.type === 'error' ? { error: message.error } : { result: message.result });
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
    const stats = await invoke(wsUrl, { cookie: http.cookie(), origin: base }, 'get-stats');
    return stats.result && stats.result.totalModels === 4 ? 4 : null;
  }, 60000, 'STL Home scan').catch((error) => error.message);
  check('startup scan found the 4 fixture models', scanned === 4, scanned);
  check('home after login', (await http.request('/')).status === 200);
  check('web asset served', (await http.request('/renderer.js')).status === 200);
  for (const hidden of ['/main.js', '/package.json', '/node_modules/express/package.json', '/src/server/index.js']) {
    check(`${hidden} not served`, (await http.request(hidden)).status === 404);
  }

  console.log('\n# Security headers');
  const health = await http.request('/api/health');
  check('nosniff', health.headers.get('x-content-type-options') === 'nosniff');
  check('frame-ancestors', /frame-ancestors 'self'/.test(health.headers.get('content-security-policy') || ''));
  check('no X-Powered-By', !health.headers.get('x-powered-by'));

  console.log('\n# Library files');
  check('library STL served', (await http.request(file(cube))).status === 200);
  check('library 3MF download', (await http.request(download(box))).status === 200);
  check('/etc/passwd via file refused', (await http.request(file('/etc/passwd'))).status === 403);
  check('/etc/passwd via download refused', (await http.request(download('/etc/passwd'))).status === 403);
  check('traversal out of library refused', (await http.request(file(path.join(LIBRARY, '..', '..', 'package.json')))).status === 403);
  check('live database refused', (await http.request(download(path.join(DATA, 'data', 'printventory.db')))).status === 403);
  const crossSite = await http.request('/api/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example' } });
  check('cross-site POST refused', crossSite.status === 403);

  console.log('\n# WebSocket');
  const origin = base;
  const cookie = http.cookie();
  check('WS without login, other origin', (await invoke(wsUrl, { origin: 'https://evil.example' }, 'get-setting', ['currentVersion'])).rejected === 403);
  check('WS without login, same origin', (await invoke(wsUrl, { origin }, 'get-setting', ['currentVersion'])).rejected === 401);
  check('WS with login, other origin', (await invoke(wsUrl, { cookie, origin: 'https://evil.example' }, 'get-setting', ['currentVersion'])).rejected === 403);
  const version = require(path.join(ROOT, 'package.json')).version;
  check('WS with login, same origin', (await invoke(wsUrl, { cookie, origin }, 'get-setting', ['currentVersion'])).result === version);
  check('secret settings hidden', (await invoke(wsUrl, { cookie, origin }, 'get-setting', ['serverPasswordHash'])).result === null);

  console.log('\n# Path guard');
  const refused = (res, pattern) => typeof res.error === 'string' && pattern.test(res.error);
  check('read /etc/passwd refused', refused(await invoke(wsUrl, { cookie, origin }, 'read-model-file', ['/etc/passwd']), /outside the library/));
  check('delete live database refused', refused(await invoke(wsUrl, { cookie, origin }, 'delete-file', [path.join(DATA, 'data', 'printventory.db')]), /outside the library/));
  check('scan /etc refused', refused(await invoke(wsUrl, { cookie, origin }, 'scan-directory', ['/etc']), /cannot be scanned/));
  check('open-path refused', refused(await invoke(wsUrl, { cookie, origin }, 'open-path', [LIBRARY]), /desktop app/));
  check('move out of library refused', refused(await invoke(wsUrl, { cookie, origin }, 'move-files', [[cube], '/tmp']), /outside the library/));
  const read = await invoke(wsUrl, { cookie, origin }, 'read-model-file', [cube]);
  check('read library file allowed', !read.error, read.error);

  console.log('\n# MCP');
  const info = await invoke(wsUrl, { cookie, origin }, 'get-server-access-info');
  const token = info.result && info.result.apiToken;
  check('API token available', typeof token === 'string' && token.startsWith('pv_'));
  const mcpBody = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_models', arguments: { limit: 10 } } };
  check('MCP without token refused', (await anon.request('/mcp', { method: 'POST', json: mcpBody, useCookie: false })).status === 401);
  const mcp = await anon.request('/mcp', { method: 'POST', json: mcpBody, useCookie: false, headers: { authorization: `Bearer ${token}` } });
  const mcpText = await mcp.text();
  check('MCP with token finds library models', mcp.status === 200 && mcpText.includes('cube.stl') && mcpText.includes('pack.zip::inner/widget.stl'));
  const backupMcp = await anon.request('/mcp', {
    method: 'POST', useCookie: false, headers: { authorization: `Bearer ${token}` },
    json: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'backup_database', arguments: { destPath: '/etc/evil.db' } } }
  });
  check('MCP backup outside data folder refused', /Can only write/.test(await backupMcp.text()));

  console.log('\n# Inventory');
  const ask = (channel, args) => invoke(wsUrl, { cookie, origin }, channel, args);
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
  const logged = (await ask('log-print-event', [{ filePath: cube, outcome: 'printed', quantity: 1 }])).result;
  const events = logged && logged.eventId && (await ask('get-print-events', [logged.model && logged.model.id])).result;
  check('print event logged and listed', Array.isArray(events) && events.some((e) => e.id === logged.eventId), JSON.stringify(logged));

  console.log('\n# Backup and trash');
  const backup = await invoke(wsUrl, { cookie, origin }, 'backup-database');
  const backupPath = backup.result && backup.result.filePath;
  check('backup created', !!backupPath, backup.error);
  if (backupPath) check('backup downloadable', (await http.request(download(backupPath))).status === 200);
  const part = path.join(LIBRARY, 'Designer A', 'Benchy Pack', 'part one.stl');
  const trash = await invoke(wsUrl, { cookie, origin }, 'trash-file', [part]);
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
    const res = await invoke(wsUrl, session, 'get-models-with-default-thumbnails');
    return Array.isArray(res.result) && res.result.length === 0 ? 'done' : null;
  }, 120000, 'thumbnails').catch((error) => error.message);
  check('worker rendered all thumbnails', missing === 'done', missing);
  await invoke(wsUrl, session, 'save-setting', ['tosAcceptedDate', new Date().toISOString()]);
  await invoke(wsUrl, session, 'save-setting', ['hasRunBefore', 'true']);

  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    const errors = [];
    const badResponses = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
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

    // Rename a designer through the in-page input dialog (Metadata Manager).
    const cube = path.join(LIBRARY, 'Designer A', 'cube.stl');
    await invoke(wsUrl, session, 'update-models-batch', [[{ filePath: cube, designer: 'Old Designer' }]]);
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
          const model = await invoke(wsUrl, session, 'get-model', [cube]);
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
    await invoke(wsUrl, session, 'update-models-batch', [[{ filePath: box3mf, designer: 'Keep Me' }]]);
    const pull = page.evaluate((file) => window.electron.pull3MFMetadata([file]), box3mf);
    const confirmDialog = await page.waitForSelector('dialog[open] button:text-is("No")', { timeout: 15000 }).catch(() => null);
    check('server confirmation appears in the browser', !!confirmDialog);
    if (confirmDialog) {
      await confirmDialog.click();
      const pullResult = await pull.catch((error) => ({ error: error.message }));
      check('answering No cancels Pull Metadata', pullResult && pullResult.cancelled === true, JSON.stringify(pullResult));
      const kept = await invoke(wsUrl, session, 'get-model', [box3mf]);
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
