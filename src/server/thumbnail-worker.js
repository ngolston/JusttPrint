'use strict';

/**
 * The thumbnail worker: headless Chromium running the web UI as a worker client
 * (`/?pv-thumbnail-worker=1`). It renders thumbnails with WebGL and connects back over the
 * WebSocket like a browser, identified by a secret cookie.
 */
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const { parseCookies, SESSION_COOKIE } = require('./server-auth');
const { jsonStringifyForWs } = require('./ws-json');

const COOKIE = 'pv_worker';
const OPEN = 1; // WebSocket.OPEN
const RESTART_DELAY_MS = 10000;
const secret = crypto.randomBytes(24).toString('hex');

let socket = null;
let browser = null;
let restartTimer = null;
let stopped = false;

/** True for the WebSocket upgrade request that carries the worker's cookie. */
function isWorkerRequest(req) {
  const value = parseCookies(req && req.headers && req.headers.cookie)[COOKIE];
  return !!value && value.length === secret.length
    && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(secret));
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
  if (!ready()) throw new Error('Thumbnail worker is not connected yet');
  socket.send(jsonStringifyForWs({ type: 'event', channel, args }));
}

/** Chromium flags: software WebGL (SwiftShader) unless JUSTTPRINT_CHROMIUM_ARGS replaces them. */
function chromiumArgs() {
  const custom = String(process.env.JUSTTPRINT_CHROMIUM_ARGS || '').trim();
  const gpu = custom
    ? custom.split(/\s+/)
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  return ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', ...gpu];
}

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
      args: chromiumArgs()
    });
    browser = launched;
    launched.on('disconnected', () => {
      browser = null;
      socket = null;
      if (stopped) return;
      console.warn('[Thumbnail worker] Chromium stopped; restarting in 10 seconds');
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        start(options).catch((error) => console.error('[Thumbnail worker] restart:', error.message));
      }, RESTART_DELAY_MS);
    });
    const page = await launched.newPage();
    page.on('pageerror', (error) => console.error('[Thumbnail worker] page error:', error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('[Thumbnail worker]', message.text().slice(0, 300));
    });
    await launched.setCookie(
      { name: SESSION_COOKIE, value: options.sessionToken(), domain: '127.0.0.1', path: '/', httpOnly: true },
      { name: COOKIE, value: secret, domain: '127.0.0.1', path: '/', httpOnly: true }
    );
    await page.goto(`${origin}/?pv-thumbnail-worker=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    console.log('[Thumbnail worker] Headless Chromium started');
  } catch (error) {
    browser = null;
    console.error('[Thumbnail worker] Could not start Chromium:', error.message);
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
    } catch (_) { /* already gone */ }
  }
}

module.exports = { COOKIE, isWorkerRequest, attach, detach, ready, send, start, stop };
