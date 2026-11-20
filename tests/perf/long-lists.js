#!/usr/bin/env node
'use strict';

/**
 * The long pick lists (every tag, title and designer in the library): starts the server on plain
 * Node with 200 small STL files that carry 3,000 tags and 200 titles and designers, opens the
 * library in a browser, chooses one model, then Select All, and counts the <option> elements.
 *
 *   CHROME_PATH=/path/to/chrome npm run build:web && node tests/perf/long-lists.js
 *   LONG_LISTS_TAGS=20000 ...     more tags
 *
 * Checks: while closed, each long list draws only its first choice and the value it shows; a list
 * draws every value once it is focused or clicked, and only while it has the focus; picking from
 * the lists still sets the filter or the value on the chosen models.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MODELS = 200;
const TAGS = Math.max(MODELS, Number.parseInt(process.env.LONG_LISTS_TAGS || '3000', 10) || 3000);
const PASSWORD = 'long-lists-123';
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME = process.env.CHROME_PATH || (fs.existsSync(MAC_CHROME) ? MAC_CHROME : '');
/** The lists that hold every tag, title or designer of the library. */
const LONG = [
  'tag-filter',
  'designer-select',
  'title-select',
  'tag-select',
  'model-designer',
  'model-title',
  'multi-designer',
  'multi-title',
  'multi-tag-select'
];

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
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
    await sleep(250);
  }
}

/** A binary STL: a box, different for each model (so files and hashes differ). */
function boxStl(i) {
  const s = 5 + (i % 17);
  const h = s + (i % 7) + i / 1000;
  const v = [
    [0, 0, 0],
    [s, 0, 0],
    [s, s, 0],
    [0, s, 0],
    [0, 0, h],
    [s, 0, h],
    [s, s, h],
    [0, s, h]
  ];
  const faces = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7]
  ];
  const buf = Buffer.alloc(84 + faces.length * 50);
  buf.writeUInt32LE(faces.length, 80);
  faces.forEach((f, n) => f.forEach((vi, j) => v[vi].forEach((x, k) => buf.writeFloatLE(x, 84 + n * 50 + 12 + j * 12 + k * 4))));
  return buf;
}

function startServer(work, port) {
  const log = fs.openSync(path.join(work, 'server.log'), 'w');
  return spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.js')], {
    cwd: ROOT,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      JUSTTPRINT_USER_DATA: path.join(work, 'data'),
      JUSTTPRINT_PORT: String(port),
      JUSTTPRINT_PASSWORD: PASSWORD,
      STL_HOME: path.join(work, 'library'),
      XDG_DATA_HOME: path.join(work, 'share')
    }
  });
}

function stopServer(child) {
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

const pad = (n) => String(n).padStart(5, '0');

async function main() {
  if (!CHROME) throw new Error('Google Chrome not found: set CHROME_PATH');
  if (!fs.existsSync(path.join(ROOT, 'web-build'))) throw new Error('No web-build: run npm run build:web first');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-long-lists-'));
  const files = [];
  for (let i = 0; i < MODELS; i++) {
    const file = path.join(work, 'library', `part-${pad(i)}.stl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, boxStl(i));
    files.push(file);
  }
  fs.mkdirSync(path.join(work, 'data'), { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = startServer(work, port);
  let browser = null;
  try {
    await waitFor(async () => (await fetch(`${base}/api/health`)).ok, 60000, 'the server');
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ password: PASSWORD })
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const ask = async (channel, args = []) => {
      const response = await fetch(`${base}/api/actions/${channel}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, cookie },
        body: JSON.stringify({ args })
      });
      const data = await response.json();
      if ('error' in data) throw new Error(`${channel}: ${data.error}`);
      return data.result;
    };
    await waitFor(
      async () => {
        const counts = await ask('get-library-counts');
        return Number(counts && (counts.total ?? counts.models ?? counts.count)) >= MODELS;
      },
      120000,
      'the scan'
    );
    await ask('cancel-server-thumbnail-job').catch(() => {});
    await ask('save-setting', ['hasRunBefore', 'true']);
    await ask('save-setting', ['whatsNewSeen', require(path.join(ROOT, 'package.json')).version]);
    // Each model its own designer and title, and its share of the tags.
    const perModel = Math.ceil(TAGS / MODELS);
    await ask('update-models-batch', [
      files.map((filePath, i) => ({
        filePath,
        designer: `Designer ${pad(i)}`,
        title: `Title ${pad(i)}`,
        tags: Array.from({ length: perModel }, (_, k) => i * perModel + k)
          .filter((n) => n < TAGS)
          .map((n) => `tag-${pad(n)}`)
      }))
    ]);
    const tagCount = (await ask('get-all-tags')).length;
    check(`the library has ${TAGS} tags`, tagCount === TAGS, `${tagCount}`);

    const { chromium } = require('@playwright/test');
    browser = await chromium.launch({ executablePath: CHROME });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const [name, value] = cookie.split('=');
    await context.addCookies([{ name, value, url: base }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const options = () =>
      page.evaluate((ids) => {
        const out = { all: document.querySelectorAll('option').length, elements: document.getElementsByTagName('*').length };
        for (const id of ids) out[id] = document.querySelectorAll(`select#${CSS.escape(id)} option`).length;
        return out;
      }, LONG);

    await page.goto(`${base}/#/models`);
    await page.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    await page.click('.view-button[data-view="detailed"]');
    await waitFor(() => page.evaluate(() => document.querySelectorAll('.file-grid .file-item-detailed').length > 3), 60000, 'the grid');
    await sleep(3000);
    // Check one model (its details panel shows), then Select all.
    const checkCard = (n) => page.locator('.file-grid .jp-model-card__check').nth(n).click();
    // How long the main thread stays busy (a 10 ms timer late by over 50 ms) while models are chosen.
    await page.evaluate(() => {
      window.stalledMs = 0;
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        if (now - last > 60) window.stalledMs += now - last;
        last = now;
        setTimeout(tick, 10);
      };
      setTimeout(tick, 10);
    });
    await checkCard(0);
    await page.waitForSelector('#jp-select-all-button', { timeout: 10000 });
    await page.waitForSelector('#model-details:not(.hidden)', { timeout: 10000 });
    await sleep(2000);
    const busyOneMs = Math.round(await page.evaluate(() => window.stalledMs));
    const started = Date.now();
    await page.click('#jp-select-all-button');
    await page.waitForFunction((n) => (document.querySelector('#multi-edit-panel .selected-count')?.textContent || '').trim().startsWith(`${n} `), MODELS, {
      timeout: 60000
    });
    const selectAllMs = Date.now() - started;
    await sleep(5000); // the lists' values arrive
    const closed = await options();
    const busyAllMs = Math.round(await page.evaluate(() => window.stalledMs)) - busyOneMs;
    console.log(`  main thread busy: checking one model ${busyOneMs} ms, then Select all ${busyAllMs} ms (${MODELS} chosen after ${selectAllMs} ms)`);
    console.log(`  then ${closed.elements} elements, ${closed.all} <option>`);
    console.log(`  ${LONG.map((id) => `${id} ${closed[id]}`).join(', ')}`);
    check(
      'with every model chosen, each closed long list draws at most its first choice and the value it shows',
      LONG.every((id) => closed[id] <= 3),
      LONG.filter((id) => closed[id] > 3)
        .map((id) => `${id}: ${closed[id]}`)
        .join(', ')
    );
    check('the page holds fewer than 2,000 <option> elements', closed.all < 2000, `${closed.all}`);

    // Unchecking one shows Multi-edit for the rest.
    await checkCard(0);
    await page.waitForSelector('#multi-edit-panel:not(.hidden) #multi-tag-select', { timeout: 10000 });
    const chosen = await page.evaluate(() => window.selection.values());
    // Focus (keyboard or click) draws the whole list; leaving it draws it closed again.
    await page.focus('#multi-tag-select');
    check('a focused list draws every value', (await options())['multi-tag-select'] === TAGS + 1, `${(await options())['multi-tag-select']}`);
    await page.selectOption('#multi-tag-select', 'tag-00007');
    const hasTag = async (file) => ((await ask('get-model', [file])) || {}).tags?.some((t) => (t.name || t) === 'tag-00007');
    const tagged = await waitFor(async () => (await hasTag(chosen[0])) && (await hasTag(chosen[chosen.length - 1])), 20000, 'the tag').catch(() => false);
    check('picking from the list adds the tag to the chosen models', tagged === true);
    await page.focus('#multi-source');
    await sleep(300);
    check('a list draws closed again once it loses the focus', (await options())['multi-tag-select'] <= 3, `${(await options())['multi-tag-select']}`);
    await page.click('#multi-title');
    check('clicking a list draws every value', (await options())['multi-title'] === MODELS + 1, `${(await options())['multi-title']}`);
    await page.keyboard.press('Escape');
    await page.click('#jp-select-all-button');
    await page.keyboard.press('Escape'); // leave Edit mode

    // A sidebar filter keeps showing its value after the list closes.
    if (!(await page.isVisible('#jp-filter-popover'))) await page.click('#jp-filter-button');
    await page.waitForSelector('#designer-select', { state: 'visible', timeout: 10000 });
    await page.focus('#designer-select');
    await page.selectOption('#designer-select', 'Designer 00012');
    await page.locator('#designer-select').blur();
    await sleep(1500);
    const shown = await page.evaluate(() => {
      const select = document.querySelector('#designer-select');
      return { value: select.value, options: select.options.length, text: select.selectedOptions[0]?.textContent };
    });
    check(
      'a closed filter list still shows the chosen value',
      shown.value === 'Designer 00012' && shown.text === 'Designer 00012' && shown.options <= 3,
      JSON.stringify(shown)
    );
    check('the page logged no errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    if (!failed) fs.rmSync(work, { recursive: true, force: true });
    else console.log(`(server log: ${path.join(work, 'server.log')})`);
  }
}

main()
  .then(() => {
    console.log(failed ? `\n${failed} failed` : '\nAll passed');
    process.exit(failed ? 1 : 0);
  })
  .catch((error) => {
    console.error(`\nFAIL ${error.message}`);
    process.exit(1);
  });
