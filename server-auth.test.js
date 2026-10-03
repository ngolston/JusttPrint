#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  createServerAuth,
  hashPassword,
  verifyPasswordHash,
  originAllowed,
  parseCookies,
  safeNextPath,
  SESSION_COOKIE
} = require('./server-auth');

function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    console.error('FAIL ' + name + ':', err.message);
    process.exitCode = 1;
  }
}

function makeAuth({ env = {}, clock = { t: 1_000_000 } } = {}) {
  const settings = new Map();
  const warnings = [];
  const auth = createServerAuth({
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => settings.set(key, value),
    env,
    logger: { log() {}, warn: (msg) => warnings.push(msg) },
    now: () => clock.t
  });
  return { auth, settings, warnings, clock };
}

function req({ cookie, authorization, origin, host = 'nas.local:5000', query, method = 'GET', path = '/' } = {}) {
  const headers = { host };
  if (cookie) headers.cookie = cookie;
  if (authorization) headers.authorization = authorization;
  if (origin) headers.origin = origin;
  return { headers, query: query || {}, method, path, originalUrl: path };
}

/** Log in through the real route and return the Set-Cookie value. */
function login(auth, password) {
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h.pop(); }, post: (p, ...h) => { routes['POST ' + p] = h.pop(); } };
  const express = { urlencoded: () => null, json: () => null };
  auth.registerRoutes(app, express);
  const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; }, status(c) { this.statusCode = c; return this; }, redirect() {} };
  routes['POST /api/auth/login']({ body: { password }, headers: { 'content-type': 'application/json', host: 'nas.local:5000' }, ip: '10.0.0.2', socket: {} }, res);
  return res;
}

test('password hashes verify only the right password', () => {
  const stored = hashPassword('correct horse');
  assert.ok(verifyPasswordHash('correct horse', stored));
  assert.ok(!verifyPasswordHash('wrong horse', stored));
  assert.ok(!verifyPasswordHash('anything', 'not-a-hash'));
});

test('first start generates a password and prints it once', () => {
  const { auth, warnings } = makeAuth();
  const result = auth.ensureCredentials();
  assert.strictEqual(result.source, 'generated');
  assert.ok(auth.verifyPassword(result.password));
  assert.ok(warnings.join('\n').includes(result.password));
  assert.strictEqual(auth.ensureCredentials().source, 'stored');
});

test('PRINTVENTORY_PASSWORD sets the password', () => {
  const { auth } = makeAuth({ env: { PRINTVENTORY_PASSWORD: 'from-the-env' } });
  assert.strictEqual(auth.ensureCredentials().source, 'env');
  assert.ok(auth.verifyPassword('from-the-env'));
});

test('short passwords are rejected', () => {
  const { auth } = makeAuth();
  assert.throws(() => auth.setPassword('short'), /at least 8/);
});

test('login sets a session cookie that authenticates requests', () => {
  const { auth } = makeAuth();
  auth.setPassword('library-pass');
  const res = login(auth, 'library-pass');
  assert.deepStrictEqual(res.body, { success: true });
  const setCookie = res.headers['Set-Cookie'];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = setCookie.split(';')[0];
  assert.ok(auth.isAuthenticated(req({ cookie })));
  assert.ok(!auth.isAuthenticated(req()));
});

test('wrong password does not log in, and repeated failures are blocked', () => {
  const { auth } = makeAuth();
  auth.setPassword('library-pass');
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(login(auth, 'nope').statusCode, 401);
  }
  assert.strictEqual(login(auth, 'library-pass').statusCode, 429);
});

test('changing the password logs out existing sessions', () => {
  const { auth } = makeAuth();
  auth.setPassword('library-pass');
  const cookie = login(auth, 'library-pass').headers['Set-Cookie'].split(';')[0];
  auth.setPassword('another-pass');
  assert.ok(!auth.isAuthenticated(req({ cookie })));
});

test('sessions expire after 30 days', () => {
  const { auth, clock } = makeAuth();
  auth.setPassword('library-pass');
  const cookie = login(auth, 'library-pass').headers['Set-Cookie'].split(';')[0];
  clock.t += 31 * 24 * 60 * 60 * 1000;
  assert.ok(!auth.isAuthenticated(req({ cookie })));
});

test('a tampered session cookie is rejected', () => {
  const { auth } = makeAuth();
  auth.setPassword('library-pass');
  const cookie = login(auth, 'library-pass').headers['Set-Cookie'].split(';')[0];
  const [name, value] = cookie.split('=');
  const parts = decodeURIComponent(value).split('.');
  parts[1] = String(Number(parts[1]) + 1e12);
  assert.ok(!auth.isAuthenticated(req({ cookie: `${name}=${parts.join('.')}` })));
});

test('the API token authenticates as a bearer token and can be regenerated', () => {
  const { auth } = makeAuth();
  const token = auth.apiToken();
  assert.ok(token.startsWith('pv_'));
  assert.ok(auth.isAuthenticated(req({ authorization: `Bearer ${token}` })));
  const next = auth.regenerateApiToken();
  assert.ok(!auth.isAuthenticated(req({ authorization: `Bearer ${token}` })));
  assert.ok(auth.isAuthenticated(req({ authorization: `Bearer ${next}` })));
});

test('download tokens work only for downloads and expire after 15 minutes', () => {
  const { auth, clock } = makeAuth();
  const token = auth.issueDownloadToken();
  assert.ok(auth.isDownloadAuthorized(req({ query: { token } })));
  assert.ok(!auth.isAuthenticated(req({ query: { token } })));
  clock.t += 16 * 60 * 1000;
  assert.ok(!auth.isDownloadAuthorized(req({ query: { token } })));
});

test('requireAuth lets public paths through and blocks the rest', () => {
  const { auth } = makeAuth();
  let passed = 0;
  const next = () => { passed++; };
  const res = { redirect(code, to) { this.redirected = to; }, status(c) { this.code = c; return this; }, json() {} };
  auth.requireAuth(req({ path: '/login' }), res, next);
  auth.requireAuth(req({ path: '/api/health' }), res, next);
  assert.strictEqual(passed, 2);
  auth.requireAuth(req({ path: '/api/file//etc/passwd' }), res, next);
  assert.strictEqual(passed, 2);
  assert.strictEqual(res.code, 401);
  const page = req({ path: '/' });
  page.headers.accept = 'text/html';
  auth.requireAuth(page, res, next);
  assert.strictEqual(res.redirected, '/login?next=%2F');
});

test('WebSocket upgrades need a session and the same origin', () => {
  const { auth } = makeAuth();
  auth.setPassword('library-pass');
  const cookie = login(auth, 'library-pass').headers['Set-Cookie'].split(';')[0];
  assert.strictEqual(auth.verifyUpgrade(req({ origin: 'https://evil.example' })).status, 403);
  assert.strictEqual(auth.verifyUpgrade(req({ origin: 'https://evil.example', cookie })).status, 403);
  assert.strictEqual(auth.verifyUpgrade(req({ origin: 'http://nas.local:5000' })).status, 401);
  assert.ok(auth.verifyUpgrade(req({ origin: 'http://nas.local:5000', cookie })).ok);
});

test('origin checks accept this host, the forwarded host and extras', () => {
  assert.ok(originAllowed(req()));
  assert.ok(originAllowed(req({ origin: 'http://nas.local:5000' })));
  assert.ok(!originAllowed(req({ origin: 'http://nas.local:5001' })));
  const proxied = req({ origin: 'https://library.example.com', host: 'printventory:5000' });
  proxied.headers['x-forwarded-host'] = 'library.example.com';
  assert.ok(originAllowed(proxied));
  assert.ok(originAllowed(req({ origin: 'http://127.0.0.1:61234' }), ['http://127.0.0.1:61234']));
  assert.ok(!originAllowed(req({ origin: 'not a url' })));
});

test('post-login redirects stay on this site', () => {
  assert.strictEqual(safeNextPath('/library?x=1'), '/library?x=1');
  assert.strictEqual(safeNextPath('https://evil.example'), '/');
  assert.strictEqual(safeNextPath('//evil.example'), '/');
  assert.strictEqual(safeNextPath('/\\evil.example'), '/');
});

test('cookies parse with encoded values', () => {
  assert.deepStrictEqual(parseCookies(`a=1; ${SESSION_COOKIE}=x%2Ey`), { a: '1', [SESSION_COOKIE]: 'x.y' });
});

test('PRINTVENTORY_TRUST_PROXY parses hops, true, and address lists', () => {
  const { parseTrustProxy } = require('./server-auth');
  assert.strictEqual(parseTrustProxy(undefined), false);
  assert.strictEqual(parseTrustProxy('false'), false);
  assert.strictEqual(parseTrustProxy('0'), false);
  assert.strictEqual(parseTrustProxy('1'), 1);
  assert.strictEqual(parseTrustProxy('true'), true);
  assert.deepStrictEqual(parseTrustProxy('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
});
