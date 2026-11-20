#!/usr/bin/env node
'use strict';

/**
 * Which pictures a collection page asks for: starts the server on plain Node with a library of
 * 300 small STL files, each with its own picture, puts them all in one collection, opens it in
 * a browser and counts the getThumbnail calls (on their own or inside /api/batch).
 *
 *   CHROME_PATH=/path/to/chrome npm run build:web && node tests/perf/collection-pictures.js
 *   JUSTTPRINT_THUMBNAIL_FILES=true ...     the same with the pictures kept as files
 *
 * Checks: opening the page asks only for the cards near the view, each picture at most once;
 * scrolling to the end asks for the cards it reaches; every card shows the picture the server
 * answers for it; the library grid with the same models asks each picture at most once.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const MODELS = 300;
const PASSWORD = 'collection-pictures-123';
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME = process.env.CHROME_PATH || (fs.existsSync(MAC_CHROME) ? MAC_CHROME : '');
/** A card counts as near the view up to this far below or above it (the page may load a little ahead). */
const NEAR_PX = 900;

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

/** A small PNG of noise, different for each seed, as a data URL. */
function noisePng(width, height, seed) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let state = seed >>> 0 || 1;
  for (let i = 0; i < raw.length; i++) raw[i] = i % (width * 3 + 1) === 0 ? 0 : (state = (Math.imul(state, 1103515245) + 12345) >>> 0) >>> 24;
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
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
  header[8] = 8;
  header[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
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

/**
 * The cards of the collection page, what picture they show and where they are: `top` and `bottom`
 * from the top of the part of the page that shows them (the box that scrolls, below the top bar),
 * `view` that part's height.
 */
const tiles = (page) =>
  page.evaluate(() => {
    const list = document.getElementById('jp-collection-models');
    let box = list && list.parentElement;
    while (box && box !== document.body && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    const shown = box && box !== document.body ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const top = Math.max(0, shown.top);
    const view = Math.min(window.innerHeight, shown.bottom) - top;
    return [...document.querySelectorAll('#jp-collection-models [data-filepath]')].map((card) => {
      const rect = card.getBoundingClientRect();
      return {
        filePath: card.dataset.filepath,
        top: rect.top - top,
        bottom: rect.bottom - top,
        view,
        src: card.querySelector('img')?.getAttribute('src') || ''
      };
    });
  });

async function main() {
  if (!CHROME) throw new Error('Google Chrome not found: set CHROME_PATH');
  if (!fs.existsSync(path.join(ROOT, 'web-build'))) throw new Error('No web-build: run npm run build:web first');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-collection-pictures-'));
  const files = [];
  for (let i = 0; i < MODELS; i++) {
    const file = path.join(work, 'library', `Designer ${i % 10}`, `part-${String(i).padStart(4, '0')}.stl`);
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
    // The pictures come from here, not the renderer.
    await ask('cancel-server-thumbnail-job').catch(() => {});
    await waitFor(async () => (await ask('get-server-thumbnail-job-status')).status === 'idle', 60000, 'the thumbnail job to stop');
    await sleep(1000);
    await ask('save-setting', ['hasRunBefore', 'true']);
    for (let i = 0; i < files.length; i++) await ask('save-thumbnail', [files[i], noisePng(32, 32, i + 1)]);
    if (/^(1|true|yes|on)$/i.test(process.env.JUSTTPRINT_THUMBNAIL_FILES || '')) {
      const kept = fs.readdirSync(path.join(work, 'data'), { recursive: true }).filter((name) => /photos[/\\]model[/\\].+\.png$/.test(String(name)));
      check('the pictures are kept as files', kept.length === MODELS, `${kept.length} files`);
    }
    const collection = await ask('create-collection', [{ name: 'Pictures' }]);
    await ask('add-to-collection', [collection.id, files]);

    const { chromium } = require('@playwright/test');
    browser = await chromium.launch({ executablePath: CHROME });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const [name, value] = cookie.split('=');
    await context.addCookies([{ name, value, url: base }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // Every picture asked for, in order (a batch carries several).
    const asked = [];
    page.on('request', (request) => {
      const url = request.url();
      let body;
      try {
        body = JSON.parse(request.postData() || 'null');
      } catch (_) {
        return;
      }
      if (url.endsWith('/api/actions/getThumbnail')) asked.push(body?.args?.[0]);
      else if (url.endsWith('/api/batch')) for (const call of body?.calls || []) if (call.name === 'getThumbnail') asked.push(call.args?.[0]);
    });
    const duplicates = () => asked.filter((file, i) => asked.indexOf(file) !== i);
    const settle = async (want) => {
      await waitFor(async () => (await tiles(page)).filter(want).every((tile) => tile.src.startsWith('data:image')), 30000, 'the pictures in view');
      await sleep(1500); // anything still to be asked for
    };
    const inView = (tile) => tile.bottom > 0 && tile.top < tile.view;
    const nearView = (tile) => tile.bottom > -NEAR_PX && tile.top < tile.view + NEAR_PX;

    await page.goto(`${base}/#/collections/${collection.id}`);
    await waitFor(async () => (await tiles(page)).length === MODELS, 60000, 'the collection page');
    await settle(inView);
    let shown = await tiles(page);
    const near = new Set(shown.filter(nearView).map((tile) => tile.filePath));
    console.log(`  opening: ${asked.length} pictures asked for, ${shown.filter(inView).length} cards in view, ${near.size} near it, ${MODELS} in all`);
    check(
      'opening the collection asks for the pictures of the cards in view',
      shown.filter(inView).every((tile) => asked.includes(tile.filePath))
    );
    check(
      'opening the collection asks for no picture of a card far from the view',
      asked.every((file) => near.has(file)),
      `${asked.filter((file) => !near.has(file)).length} of ${asked.length} far away`
    );
    check('opening the collection asks for each picture once', duplicates().length === 0, `${duplicates().length} asked again`);

    const before = asked.length;
    await page.evaluate(() => [...document.querySelectorAll('#jp-collection-models [data-filepath]')].pop().scrollIntoView({ block: 'end' }));
    await settle(inView);
    shown = await tiles(page);
    const reached = shown.filter(inView);
    console.log(`  after scrolling to the end: ${asked.length - before} more asked for, ${asked.length} in all`);
    check('scrolling to the end asks for the pictures it reaches', reached.length > 0 && reached.every((tile) => asked.includes(tile.filePath)));
    check('scrolling asks for no picture of the cards it jumped over', asked.length < MODELS, `${asked.length} of ${MODELS}`);
    await page.evaluate(() => document.querySelector('#jp-collection-models [data-filepath]').scrollIntoView({ block: 'start' }));
    for (const element of await page.$$('#jp-collection-models [data-filepath]')) await element.evaluate((card) => card.scrollIntoView({ block: 'nearest' }));
    await sleep(1500);
    check('scrolling back and through asks for each picture once', duplicates().length === 0, `${duplicates().length} asked again`);

    // Every card that shows a picture shows the server's picture for its model.
    shown = await tiles(page);
    const wrong = [];
    for (const tile of shown.filter((t) => t.src.startsWith('data:image')))
      if (tile.src !== (await ask('getThumbnail', [tile.filePath]))) wrong.push(tile.filePath);
    console.log(`  ${shown.filter((t) => t.src.startsWith('data:image')).length} cards show a picture`);
    check('each card shows the picture the server keeps for its model', wrong.length === 0, `${wrong.length} differ`);

    // The library grid with the same models: each picture at most once.
    asked.length = 0;
    await page.goto(`${base}/#/models`);
    await page.reload();
    await page.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    await waitFor(() => page.evaluate(() => document.querySelectorAll('.file-grid .thumbnail-container img').length > 3), 30000, 'the grid');
    await sleep(3000);
    console.log(`  library grid: ${asked.length} pictures asked for`);
    check('the library grid asks for each picture once', asked.length > 0 && duplicates().length === 0, `${duplicates().length} asked again`);
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
