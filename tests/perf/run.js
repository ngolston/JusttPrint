#!/usr/bin/env node
'use strict';

/**
 * Speed checks: starts the server on plain Node with a generated library (3,000 small STL files
 * in 30 folders by default, one large 3MF for the preview) and times what a large library makes
 * slow: the scan, the API's model list, the grid's first pictures, scrolling the grid, the grid
 * copies of large thumbnails and opening the 3D preview again and again.
 *
 *   npm run test:perf
 *   PERF_MODELS=10000 npm run test:perf     a larger library
 *
 * Each measure has a budget (a few times what a 2024 laptop takes: it catches a slowdown, not a
 * slow computer) and is compared
 * with the previous run (tests/perf/.work/last.json). Exits with 1 when a budget is broken.
 * Needs Google Chrome or CHROME_PATH, like the end-to-end checks.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const { zipSync, strToU8 } = require('fflate');

const ROOT = path.join(__dirname, '..', '..');
const WORK = path.join(__dirname, '.work');
const RUN = path.join(WORK, 'run');
const DATA = path.join(RUN, 'data');
const LIBRARY = path.join(RUN, 'library');
const LAST = path.join(WORK, 'last.json');
const PASSWORD = 'perf-password-123';
const MODELS = Math.max(100, Number.parseInt(process.env.PERF_MODELS || '3000', 10) || 3000);
const FOLDERS = 30;
/** Every 20th model gets a large picture (about 0.5 MB), the rest a small one. */
const LARGE_EVERY = 20;
const PREVIEW_TRIANGLES = 300000;
const PREVIEW_OPENS = 5;
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME = process.env.CHROME_PATH || (fs.existsSync(MAC_CHROME) ? MAC_CHROME : '');

/** name: [label, unit, budget (higher is worse)]. */
const MEASURES = {
  scanMs: ['Scan the library', 'ms', 60000],
  listMs: ['API: list every model (median of 5)', 'ms', 1000],
  searchMs: ['API: search (median of 5)', 'ms', 500],
  firstPicturesMs: ['Grid: first pictures after opening the library', 'ms', 5000],
  scrollFrameP95Ms: ['Grid scroll: 95th percentile frame', 'ms', 60],
  scrollLongFrames: ['Grid scroll: frames over 100 ms', 'frames', 5],
  picturesAfterScrollMs: ['Grid: pictures after scrolling to the end', 'ms', 3000],
  gridCopiesMs: ['Grid copies of the large thumbnails', 'ms', 60000],
  previewFirstMs: ['3D preview: first open (300k triangles)', 'ms', 10000],
  previewAgainMs: ['3D preview: later opens (median)', 'ms', 5000],
  previewHeapGrowthMb: ['3D preview: memory left after 5 opens', 'MB', 100]
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

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

/** A binary STL: a small box, different for each model (so files and hashes differ). */
function boxStl(i) {
  const s = 5 + (i % 17);
  const v = [
    [0, 0, 0],
    [s, 0, 0],
    [s, s, 0],
    [0, s, 0],
    [0, 0, s + (i % 7)],
    [s, 0, s + (i % 7)],
    [s, s, s + (i % 7)],
    [0, s, s + (i % 7)]
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

/** A 3MF holding a bumpy sheet of about `triangles` triangles. */
function large3mf(triangles) {
  const side = Math.ceil(Math.sqrt(triangles / 2)) + 1;
  const verts = [];
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) verts.push(`<vertex x="${x * 0.2}" y="${y * 0.2}" z="${(Math.sin(x / 9) * Math.cos(y / 7) * 4 + 5).toFixed(3)}"/>`);
  }
  const tris = [];
  for (let y = 0; y < side - 1; y++) {
    for (let x = 0; x < side - 1; x++) {
      const a = y * side + x;
      tris.push(`<triangle v1="${a}" v2="${a + 1}" v3="${a + side}"/>`, `<triangle v1="${a + 1}" v2="${a + side + 1}" v3="${a + side}"/>`);
    }
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  return Buffer.from(zipSync({ '3D/3dmodel.model': strToU8(xml) }));
}

/** A PNG of noise (it does not compress), as a data URL. */
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

function makeLibrary() {
  fs.rmSync(RUN, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const files = [];
  for (let i = 0; i < MODELS; i++) {
    const dir = path.join(LIBRARY, `Designer ${String(i % FOLDERS).padStart(2, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `part-${String(i).padStart(5, '0')}.stl`);
    fs.writeFileSync(file, boxStl(i));
    files.push(file);
  }
  const preview = path.join(LIBRARY, 'Preview', 'large-sheet.3mf');
  fs.mkdirSync(path.dirname(preview), { recursive: true });
  fs.writeFileSync(preview, large3mf(PREVIEW_TRIANGLES));
  return { files, preview };
}

function startServer(port) {
  const log = fs.openSync(path.join(RUN, 'server.log'), 'w');
  return spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.js')], {
    cwd: ROOT,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      JUSTTPRINT_USER_DATA: DATA,
      JUSTTPRINT_PORT: String(port),
      JUSTTPRINT_PASSWORD: PASSWORD,
      // The grid copies start right away (normally 20 s after the start).
      JUSTTPRINT_GRID_THUMBNAIL_DELAY_MS: '0',
      STL_HOME: LIBRARY,
      XDG_DATA_HOME: path.join(RUN, 'share'),
      ...(CHROME ? { JUSTTPRINT_CHROMIUM: CHROME } : {})
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

async function main() {
  if (!CHROME) throw new Error('Google Chrome not found: set CHROME_PATH');
  fs.mkdirSync(WORK, { recursive: true });
  console.log(`# Making a library of ${MODELS} models`);
  const { files, preview } = makeLibrary();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const results = {};
  const started = Date.now();
  const server = startServer(port);
  let browser = null;
  let page = null;
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
    const total = async () => {
      const counts = await ask('get-library-counts');
      return Number(counts && (counts.total ?? counts.models ?? counts.count)) || 0;
    };

    console.log('# Scan');
    await waitFor(async () => (await total()) >= MODELS + 1, MEASURES.scanMs[2] * 2, 'the scan');
    results.scanMs = Date.now() - started;
    // The pictures come from this script, not the renderer: stop its job and keep browsers from rendering.
    await ask('cancel-server-thumbnail-job').catch(() => {});
    await waitFor(async () => (await ask('get-server-thumbnail-job-status')).status === 'idle', 60000, 'the thumbnail job to stop');
    await sleep(1000); // A render that was under way is saved.
    await ask('save-setting', ['tosAcceptedDate', new Date().toISOString()]);
    await ask('save-setting', ['hasRunBefore', 'true']);

    console.log('# Pictures');
    const small = Array.from({ length: 8 }, (_, k) => noisePng(48, 48, k + 1));
    const large = Array.from({ length: 4 }, (_, k) => noisePng(400, 300, k + 100));
    const largeFiles = [];
    for (let i = 0; i < files.length; i++) {
      const isLarge = i % LARGE_EVERY === 0;
      if (isLarge) largeFiles.push(files[i]);
      await ask('save-thumbnail', [files[i], isLarge ? large[i % large.length] : small[i % small.length]]);
    }
    await ask('save-thumbnail', [preview, small[0]]);
    const copiesStarted = Date.now();

    console.log('# API');
    const timed = async (fn) => {
      const t = performance.now();
      await fn();
      return performance.now() - t;
    };
    const lists = [];
    const searches = [];
    for (let k = 0; k < 5; k++) {
      lists.push(await timed(() => ask('get-models-filtered', [{}])));
      searches.push(await timed(() => ask('get-models-filtered', [{ search: `part-0${k}` }])));
    }
    results.listMs = Math.round(median(lists));
    results.searchMs = Math.round(median(searches));

    console.log('# Browser');
    const { chromium } = require('@playwright/test');
    browser = await chromium.launch({ executablePath: CHROME, args: ['--js-flags=--expose-gc'] });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const [name, value] = cookie.split('=');
    await context.addCookies([{ name, value, url: base }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/#/library`);
    const opened = Date.now();
    await page.waitForFunction(() => window._electronBridgeReady === true, null, { timeout: 60000 });
    // Every card in view shows its picture (and there are some).
    const picturesShown = () =>
      page.evaluate(() => {
        const grid = document.querySelector('.file-grid');
        if (!grid) return false;
        const box = grid.getBoundingClientRect();
        const inView = [...grid.querySelectorAll('.thumbnail-container')].filter((card) => {
          const r = card.getBoundingClientRect();
          return r.bottom > box.top + 20 && r.top < box.bottom - 20;
        });
        return inView.length >= 3 && inView.every((card) => [...card.querySelectorAll('img')].some((img) => img.complete && img.naturalWidth > 0));
      });
    await waitFor(picturesShown, MEASURES.firstPicturesMs[2] * 2, 'the first pictures');
    results.firstPicturesMs = Date.now() - opened;

    console.log('# Scroll');
    // PERF_PROFILE=1: where the scroll spends its time (build with --minify false for names).
    const cdp = process.env.PERF_PROFILE ? await context.newCDPSession(page) : null;
    if (cdp) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
    }
    const scroll = await page.evaluate(async () => {
      const grid = document.querySelector('.file-grid');
      const frames = [];
      let last = performance.now();
      await new Promise((resolve) => {
        const step = (now) => {
          frames.push(now - last);
          last = now;
          grid.scrollTop += 900;
          if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 2) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      frames.shift();
      return { frames, height: grid.scrollHeight };
    });
    if (cdp) printProfile((await cdp.send('Profiler.stop')).profile);
    const sorted = [...scroll.frames].sort((a, b) => a - b);
    results.scrollFrameP95Ms = Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0);
    results.scrollLongFrames = scroll.frames.filter((ms) => ms > 100).length;
    const stopped = Date.now();
    await waitFor(picturesShown, MEASURES.picturesAfterScrollMs[2] * 2, 'the pictures after scrolling');
    results.picturesAfterScrollMs = Date.now() - stopped;
    console.log(`  ${scroll.frames.length} frames over ${Math.round(scroll.height / 1000)}k px`);

    console.log('# Grid copies');
    const isCopy = async (file) => String((await ask('getThumbnail', [file])) || '').startsWith('data:image/webp');
    await waitFor(
      async () => (await isCopy(largeFiles[0])) && (await isCopy(largeFiles[largeFiles.length - 1])),
      MEASURES.gridCopiesMs[2] * 2,
      'the grid copies'
    );
    results.gridCopiesMs = Date.now() - copiesStarted;

    console.log('# 3D preview');
    const heap = () =>
      page.evaluate(async () => {
        for (let k = 0; k < 3; k++) {
          window.gc?.();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return performance.memory ? performance.memory.usedJSHeapSize : 0;
      });
    const heapBefore = await heap();
    const opens = [];
    for (let k = 0; k < PREVIEW_OPENS; k++) {
      const ms = await page.evaluate(async (file) => {
        const t = performance.now();
        await window.openPreview(file);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return performance.now() - t;
      }, preview);
      opens.push(ms);
      const failed = await page.evaluate(() => !!document.querySelector('#preview-dialog .preview-error, #preview-dialog [role="alert"]'));
      if (failed) throw new Error('The preview showed an error');
      await page.evaluate(() => document.getElementById('preview-dialog').close());
      await sleep(300);
    }
    results.previewFirstMs = Math.round(opens[0]);
    results.previewAgainMs = Math.round(median(opens.slice(1)));
    results.previewHeapGrowthMb = Math.max(0, Math.round(((await heap()) - heapBefore) / 1024 / 1024));
    if (errors.length) throw new Error(`Page errors: ${errors.slice(0, 3).join(' | ')}`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(RUN, 'failure.png') }).catch(() => {});
    if (page && process.env.PERF_DEBUG)
      console.log(
        await page.evaluate(() => {
          const grid = document.querySelector('.file-grid');
          const box = grid && grid.getBoundingClientRect();
          const cards = grid ? [...grid.querySelectorAll('.thumbnail-container')] : [];
          return JSON.stringify({
            box,
            cards: cards.length,
            sample: cards.slice(0, 4).map((c) => ({ r: c.getBoundingClientRect().top, html: c.outerHTML.slice(0, 300) }))
          });
        })
      );
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
  }
  return results;
}

/** The functions that took the most time themselves in a CPU profile. */
function printProfile(profile) {
  const self = new Map();
  const dt = new Map();
  profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) || 0) + (profile.timeDeltas[i] || 0)));
  for (const node of profile.nodes) {
    const f = node.callFrame;
    const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (dt.get(node.id) || 0));
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  console.log('  Self time during the scroll:');
  for (const [key, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 20))
    console.log(`  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${Math.round(us / 1000)} ms  ${key}`);
}

function report(results) {
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(LAST, 'utf8'));
  } catch (_) {
    /* first run */
  }
  const comparable = previous && previous.models === MODELS ? previous.results : null;
  let broken = 0;
  console.log(`\n# Results (${MODELS} models)${comparable ? `, compared with ${previous.at}` : ''}`);
  for (const [key, [label, unit, budget]] of Object.entries(MEASURES)) {
    const value = results[key];
    if (value === undefined) continue;
    const over = value > budget;
    if (over) broken++;
    const before = comparable && comparable[key] !== undefined ? comparable[key] : null;
    const change =
      before === null
        ? ''
        : `  (was ${before}${before ? `, ${value >= before ? '+' : ''}${Math.round(((value - before) / Math.max(before, 1)) * 100)}%` : ''})`;
    console.log(`${over ? 'OVER' : 'ok  '} ${label}: ${value} ${unit} (budget ${budget})${change}`);
  }
  fs.writeFileSync(LAST, JSON.stringify({ at: new Date().toISOString(), models: MODELS, results }, null, 2) + '\n');
  return broken;
}

main()
  .then((results) => {
    const broken = report(results);
    console.log(broken ? `\n${broken} over budget` : '\nAll within budget');
    process.exit(broken ? 1 : 0);
  })
  .catch((error) => {
    console.error(`\nFAIL ${error.message}\n(server log: ${path.join(RUN, 'server.log')}; screenshot: failure.png there)`);
    process.exit(1);
  });
