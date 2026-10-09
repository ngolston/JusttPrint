'use strict';

/**
 * The thumbnail worker: headless Chromium running the web UI as a worker client
 * (`/?pv-thumbnail-worker=1`). It renders thumbnails with WebGL and connects back over the
 * WebSocket like a browser, identified by a secret cookie.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const { parseCookies, SESSION_COOKIE } = require('./server-auth');
const { jsonStringifyForWs } = require('./ws-json');

const COOKIE = 'pv_worker';
const OPEN = 1; // WebSocket.OPEN
const RESTART_DELAY_MS = 10000;
const secret = crypto.randomBytes(24).toString('hex');

/** @type {import('ws').WebSocket | null} */
let socket = null;
/** @type {import('puppeteer').Browser | null} */
let browser = null;
/** The worker page, for questions about the Chromium that renders (its WebGL). */
/** @type {import('puppeteer').Page | null} */
let workerPage = null;
/** @type {NodeJS.Timeout | undefined} */
let restartTimer;
let stopped = false;

/** True for the WebSocket upgrade request that carries the worker's cookie. */
function isWorkerRequest(req) {
  const value = parseCookies(req && req.headers && req.headers.cookie)[COOKIE];
  return !!value && value.length === secret.length && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(secret));
}

/** The WebSocket server calls these when the worker connects and when any socket closes. */
function attach(ws) {
  socket = ws;
}
function detach(ws) {
  if (socket === ws) socket = null;
}

function ready() {
  return !!(socket && socket.readyState === OPEN);
}

function send(channel, ...args) {
  if (!socket || !ready()) throw new Error('Thumbnail worker is not connected yet');
  socket.send(jsonStringifyForWs({ type: 'event', channel, args }));
}

/** Chromium flags: software WebGL (SwiftShader) unless JUSTTPRINT_CHROMIUM_ARGS replaces them. */
function chromiumArgs() {
  const custom = String(process.env.JUSTTPRINT_CHROMIUM_ARGS || '').trim();
  const gpu = custom ? custom.split(/\s+/) : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  return [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--mute-audio',
    '--disable-crash-reporter',
    `--crash-dumps-dir=${path.join(chromiumHome(), 'crashes')}`,
    ...gpu
  ];
}

/**
 * Chromium's own writable folders. In the container XDG_CONFIG_HOME is /root/.config (the app's
 * data path), which the PUID user cannot write: Chromium then has nowhere for its crash database
 * and, on some hosts, fails to start ("chrome_crashpad_handler: --database is required").
 */
function chromiumHome() {
  const dir = path.join(os.tmpdir(), 'justtprint-chromium');
  for (const sub of ['config', 'cache', 'crashes']) {
    try {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    } catch (_) {
      /* reported by the launch */
    }
  }
  return dir;
}

/** Launch attempts after a failure before giving up until the next server start. */
const LAUNCH_RETRIES = 5;
const LAUNCH_RETRY_MS = 60 * 1000;
let launchFailures = 0;

/**
 * Start Chromium and open the worker page. Restarts itself if Chromium dies, until stop().
 * @param {object} options
 * @param {() => string|null} options.origin Server origin, e.g. http://127.0.0.1:5000 (null: not listening).
 * @param {() => string} options.sessionToken A fresh login session for the worker.
 */
async function start(options) {
  if (browser || stopped) return;
  const origin = options.origin();
  if (!origin) return;
  try {
    const executablePath = process.env.JUSTTPRINT_CHROMIUM || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    const launched = await puppeteer.launch({
      headless: true,
      executablePath,
      acceptInsecureCerts: true,
      args: chromiumArgs(),
      env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(chromiumHome(), 'config'),
        XDG_CACHE_HOME: path.join(chromiumHome(), 'cache')
      }
    });
    launchFailures = 0;
    browser = launched;
    launched.on('disconnected', () => {
      browser = null;
      workerPage = null;
      socket = null;
      if (stopped) return;
      console.warn('[Thumbnail worker] Chromium stopped; restarting in 10 seconds');
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        start(options).catch((error) => console.error('[Thumbnail worker] restart:', error.message));
      }, RESTART_DELAY_MS);
    });
    const page = await launched.newPage();
    page.on('pageerror', (error) => console.error('[Thumbnail worker] page error:', error instanceof Error ? error.message : String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('[Thumbnail worker]', message.text().slice(0, 300));
    });
    await launched.setCookie(
      { name: SESSION_COOKIE, value: options.sessionToken(), domain: '127.0.0.1', path: '/', httpOnly: true },
      { name: COOKIE, value: secret, domain: '127.0.0.1', path: '/', httpOnly: true }
    );
    await page.goto(`${origin}/?pv-thumbnail-worker=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    workerPage = page;
    console.log('[Thumbnail worker] Headless Chromium started');
  } catch (error) {
    browser = null;
    launchFailures++;
    console.error('[Thumbnail worker] Could not start Chromium:', error.message);
    if (launchFailures === LAUNCH_RETRIES + 1)
      require('./notifications').notify({
        level: 'error',
        title: 'Thumbnail renderer could not start',
        body: `Chromium did not start (${error.message}). Thumbnails are still made in open browsers. See the server log.`,
        minRole: 'admin',
        key: `chromium:${new Date().toISOString().slice(0, 10)}`
      });
    if (launchFailures <= LAUNCH_RETRIES && !stopped) {
      console.warn(`[Thumbnail worker] Trying again in a minute (${launchFailures} of ${LAUNCH_RETRIES}). Thumbnails still render in open browsers.`);
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        start(options).catch((retryError) => console.error('[Thumbnail worker] retry:', retryError.message));
      }, LAUNCH_RETRY_MS);
    }
  }
}

/** Stop Chromium for good (server shutdown). */
function stop() {
  stopped = true;
  clearTimeout(restartTimer);
  const current = browser;
  browser = null;
  if (current) {
    try {
      const child = current.process();
      if (child) child.kill('SIGKILL');
    } catch (_) {
      /* already gone */
    }
  }
}

/**
 * What the Chromium that renders thumbnails reports for WebGL: { vendor, renderer, version,
 * shadingLanguage, maxTextureSize, webgl2 }, or null when it is not running. This is the GPU the
 * server's thumbnails actually use (System Report).
 */
async function webglInfo() {
  const page = workerPage;
  if (!page || page.isClosed()) return null;
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2');
    const gl = gl2 || canvas.getContext('webgl');
    if (!gl) return { vendor: null, renderer: null, version: null, shadingLanguage: null, maxTextureSize: null, webgl2: false };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: String(debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
      renderer: String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
      version: String(gl.getParameter(gl.VERSION)),
      shadingLanguage: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      webgl2: !!gl2
    };
  });
}

/**
 * A smaller copy of an image (a data URL): at most `maxDimension` px on its longest side, as WebP
 * (it keeps transparency). Answers { width, height, dataUrl } with the original's size, or null
 * when Chromium is not running. Throws when the image cannot be decoded.
 */
async function resizeImage(dataUrl, maxDimension, quality) {
  const page = workerPage;
  if (!page || page.isClosed()) return null;
  return page.evaluate(
    async (src, max, q) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      const scale = Math.min(1, max / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const bitmap = await createImageBitmap(image, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d')).drawImage(bitmap, 0, 0);
      bitmap.close();
      return { width, height, dataUrl: canvas.toDataURL('image/webp', q) };
    },
    dataUrl,
    maxDimension,
    quality
  );
}

module.exports = { COOKIE, isWorkerRequest, attach, detach, ready, send, start, stop, webglInfo, resizeImage };
