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
} = require('../src/server/server-auth');
const { createMemoryUserStore, createSqliteUserStore, roleAllows } = require('../src/server/users');

function test(name, fn) {
  try {
    fn();
    console.log('ok ' + name);
  } catch (err) {
    console.error('FAIL ' + name + ':', err.message);
    process.exitCode = 1;
  }
}

function makeAuth({ env = {}, clock = { t: 1_000_000 }, users } = {}) {
  const settings = new Map();
  const warnings = [];
  const logs = [];
  const auth = createServerAuth({
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => settings.set(key, value),
    users,
    env,
    logger: { log: (msg) => logs.push(msg), warn: (msg) => warnings.push(msg) },
    now: () => clock.t
  });
  return { auth, settings, warnings, logs, clock };
}

/** An auth whose admin ("admin") has the given password, from JUSTTPRINT_PASSWORD or stored. */
function withAdmin(password = 'library-pass', options = {}) {
  const made = makeAuth(options);
  made.auth.ensureCredentials();
  const admin = made.auth.listUsers()[0];
  made.auth.updateUser(admin.id, { password });
  return { ...made, admin };
}

function req({ cookie, authorization, origin, host = 'nas.local:5000', query, method = 'GET', path = '/' } = {}) {
  const headers = { host };
  if (cookie) headers.cookie = cookie;
  if (authorization) headers.authorization = authorization;
  if (origin) headers.origin = origin;
  return { headers, query: query || {}, method, path, originalUrl: path };
}

function routesOf(auth) {
  const routes = {};
  const app = { get: (p, ...h) => { routes['GET ' + p] = h.pop(); }, post: (p, ...h) => { routes['POST ' + p] = h.pop(); } };
  auth.registerRoutes(app, { urlencoded: () => null, json: () => null });
  return routes;
}

function fakeRes() {
  return { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; }, status(c) { this.statusCode = c; return this; }, redirect() {} };
}

/** Log in through the real route and return the response (Set-Cookie in headers). */
function login(auth, password, username) {
  const res = fakeRes();
  const body = username === undefined ? { password } : { username, password };
  routesOf(auth)['POST /api/auth/login']({ body, headers: { 'content-type': 'application/json', host: 'nas.local:5000' }, ip: '10.0.0.2', socket: {} }, res);
  return res;
}

const cookieOf = (res) => res.headers['Set-Cookie'].split(';')[0];

test('password hashes verify only the right password', () => {
  const stored = hashPassword('correct horse');
  assert.ok(verifyPasswordHash('correct horse', stored));
  assert.ok(!verifyPasswordHash('wrong horse', stored));
  assert.ok(!verifyPasswordHash('anything', 'not-a-hash'));
});

test('first start makes the admin account with a generated password, printed once', () => {
  const { auth, warnings } = makeAuth();
  const result = auth.ensureCredentials();
  assert.strictEqual(result.source, 'generated');
  assert.strictEqual(result.username, 'admin');
  assert.strictEqual(auth.verifyLogin('admin', result.password).role, 'admin');
  assert.ok(warnings.join('\n').includes(result.password));
  assert.strictEqual(auth.ensureCredentials().source, 'stored');
  assert.strictEqual(auth.listUsers().length, 1);
});

test('JUSTTPRINT_PASSWORD sets the admin password, JUSTTPRINT_USERNAME its name', () => {
  const { auth } = makeAuth({ env: { JUSTTPRINT_PASSWORD: 'from-the-env', JUSTTPRINT_USERNAME: 'Nick' } });
  assert.strictEqual(auth.ensureCredentials().source, 'env');
  assert.ok(auth.verifyLogin('nick', 'from-the-env'), 'user names ignore case');
  assert.ok(!auth.verifyLogin('admin', 'from-the-env'));
  assert.deepStrictEqual(auth.listUsers().map((u) => [u.username, u.role, u.fromEnv]), [['Nick', 'admin', true]]);
});

test('a changed JUSTTPRINT_PASSWORD replaces the old one and logs that user out', () => {
  const env = { JUSTTPRINT_PASSWORD: 'first-password' };
  const { auth } = makeAuth({ env });
  auth.ensureCredentials();
  const cookie = cookieOf(login(auth, 'first-password'));
  env.JUSTTPRINT_PASSWORD = 'second-password';
  auth.ensureCredentials();
  assert.ok(auth.verifyLogin('admin', 'second-password'));
  assert.ok(!auth.isAuthenticated(req({ cookie })));
});

test('upgrading: the old single password becomes the admin account', () => {
  const { auth, settings, logs } = makeAuth();
  settings.set('serverPasswordHash', hashPassword('the-old-password'));
  assert.strictEqual(auth.ensureCredentials().source, 'stored');
  assert.ok(auth.verifyLogin('admin', 'the-old-password'));
  assert.strictEqual(settings.get('serverPasswordHash'), '', 'the old hash is cleared');
  assert.ok(logs.join('\n').includes('admin account'));
});

test('short passwords and bad user names are rejected', () => {
  const { auth } = withAdmin();
  assert.throws(() => auth.createUser({ username: 'kid', password: 'short', role: 'viewer' }), /at least 8/);
  assert.throws(() => auth.createUser({ username: 'has space', password: 'long-enough', role: 'viewer' }), /User names/);
  assert.throws(() => auth.createUser({ username: '.hidden', password: 'long-enough', role: 'viewer' }), /User names/);
  assert.throws(() => auth.createUser({ username: 'kid', password: 'long-enough', role: 'owner' }), /Choose a role/);
  auth.createUser({ username: 'kid', password: 'long-enough', role: 'viewer' });
  assert.throws(() => auth.createUser({ username: 'KID', password: 'long-enough', role: 'viewer' }), /already a user/);
});

test('login sets a session cookie that authenticates requests as that user', () => {
  const { auth } = withAdmin();
  auth.createUser({ username: 'maker', password: 'maker-pass', role: 'editor' });
  const res = login(auth, 'maker-pass', 'maker');
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.user.role, 'editor');
  const setCookie = res.headers['Set-Cookie'];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = cookieOf(res);
  assert.deepStrictEqual(auth.authenticate(req({ cookie })), { id: res.body.user.id, username: 'maker', role: 'editor' });
  assert.ok(!auth.isAuthenticated(req()));
  assert.ok(auth.listUsers().find((u) => u.username === 'maker').lastLoginAt, 'the login time is kept');
});

test('a login without a user name is the admin (scripts from before accounts)', () => {
  const { auth } = withAdmin('admin-pass');
  assert.strictEqual(login(auth, 'admin-pass').body.user.username, 'admin');
});

test('a role change applies to sessions straight away', () => {
  const { auth } = withAdmin();
  const user = auth.createUser({ username: 'maker', password: 'maker-pass', role: 'editor' });
  const cookie = cookieOf(login(auth, 'maker-pass', 'maker'));
  auth.updateUser(user.id, { role: 'viewer' });
  assert.strictEqual(auth.authenticate(req({ cookie })).role, 'viewer');
});

test('logins keep working while the database cannot be read (restore)', () => {
  const settings = new Map();
  const store = createMemoryUserStore();
  let readable = true;
  const guarded = (fn) => (...args) => {
    if (!readable) throw new Error('The database is not open');
    return fn(...args);
  };
  const users = Object.fromEntries(Object.entries(store).map(([key, fn]) => [key, guarded(fn)]));
  const auth = createServerAuth({
    getSetting: guarded((key) => settings.get(key)),
    setSetting: guarded((key, value) => settings.set(key, value)),
    users,
    env: { JUSTTPRINT_PASSWORD: 'restore-test-pw' },
    logger: { log() {}, warn() {} }
  });
  auth.ensureCredentials();
  const cookie = cookieOf(login(auth, 'restore-test-pw'));
  const token = auth.apiToken();
  const secretBefore = settings.get('serverSessionSecret');
  readable = false;
  assert.ok(auth.isAuthenticated(req({ cookie })), 'session still valid');
  assert.ok(auth.isAuthenticated(req({ authorization: `Bearer ${token}` })), 'API token still valid');
  assert.strictEqual(login(auth, 'restore-test-pw').statusCode, 200, 'logging in still works');
  readable = true;
  assert.strictEqual(settings.get('serverSessionSecret'), secretBefore, 'no new signing secret was written');
});

test('regenerating the API token replaces the remembered one', () => {
  const { auth } = makeAuth({ env: { JUSTTPRINT_PASSWORD: 'token-test-pw' } });
  auth.ensureCredentials();
  const before = auth.apiToken();
  const after = auth.regenerateApiToken();
  assert.notStrictEqual(before, after);
  assert.strictEqual(auth.apiToken(), after);
  assert.ok(!auth.isAuthenticated(req({ authorization: `Bearer ${before}` })));
  assert.ok(auth.isAuthenticated(req({ authorization: `Bearer ${after}` })));
});

test('wrong passwords and unknown users do not log in, and repeated failures are blocked', () => {
  const { auth } = withAdmin();
  for (let i = 0; i < 5; i++) assert.strictEqual(login(auth, 'nope').statusCode, 401);
  for (let i = 0; i < 5; i++) assert.strictEqual(login(auth, 'library-pass', 'nobody').statusCode, 401);
  assert.strictEqual(login(auth, 'library-pass').statusCode, 429);
});

test('changing your password logs out your sessions, not other users\' sessions', () => {
  const { auth, admin } = withAdmin();
  auth.createUser({ username: 'maker', password: 'maker-pass', role: 'editor' });
  const mine = cookieOf(login(auth, 'library-pass'));
  const theirs = cookieOf(login(auth, 'maker-pass', 'maker'));
  assert.throws(() => auth.changeOwnPassword(admin, 'wrong-current', 'another-pass'), /Current password is wrong/);
  auth.changeOwnPassword(admin, 'library-pass', 'another-pass');
  assert.ok(!auth.isAuthenticated(req({ cookie: mine })));
  assert.ok(auth.isAuthenticated(req({ cookie: theirs })));
  assert.ok(auth.verifyLogin('admin', 'another-pass'));
});

test('an admin resetting a password or deleting a user ends that user\'s sessions', () => {
  const { auth, admin } = withAdmin();
  const user = auth.createUser({ username: 'maker', password: 'maker-pass', role: 'editor' });
  let cookie = cookieOf(login(auth, 'maker-pass', 'maker'));
  auth.updateUser(user.id, { password: 'reset-by-admin' });
  assert.ok(!auth.isAuthenticated(req({ cookie })));
  cookie = cookieOf(login(auth, 'reset-by-admin', 'maker'));
  auth.deleteUser(admin, user.id);
  assert.ok(!auth.isAuthenticated(req({ cookie })));
  assert.strictEqual(login(auth, 'reset-by-admin', 'maker').statusCode, 401);
});

test('the last admin cannot be demoted or deleted, nor yourself deleted', () => {
  const { auth, admin } = withAdmin();
  assert.throws(() => auth.updateUser(admin.id, { role: 'editor' }), /only admin/);
  const other = auth.createUser({ username: 'second', password: 'second-pass', role: 'admin' });
  assert.throws(() => auth.deleteUser(admin, admin.id), /your own account/);
  auth.updateUser(admin.id, { role: 'editor' });
  assert.throws(() => auth.deleteUser(admin, other.id), /only admin/);
});

test('the JUSTTPRINT_PASSWORD account stays an admin and keeps its password', () => {
  const { auth } = makeAuth({ env: { JUSTTPRINT_PASSWORD: 'from-the-env' } });
  auth.ensureCredentials();
  const envUser = auth.listUsers()[0];
  const other = auth.createUser({ username: 'second', password: 'second-pass', role: 'admin' });
  assert.throws(() => auth.updateUser(envUser.id, { role: 'viewer' }), /stays an admin/);
  assert.throws(() => auth.updateUser(envUser.id, { password: 'something-else' }), /JUSTTPRINT_PASSWORD/);
  assert.throws(() => auth.deleteUser(other, envUser.id), /cannot be deleted/);
  assert.throws(() => auth.changeOwnPassword(envUser, 'from-the-env', 'something-else'), /JUSTTPRINT_PASSWORD/);
});

test('sessions expire after 30 days', () => {
  const { auth, clock } = withAdmin();
  const cookie = cookieOf(login(auth, 'library-pass'));
  clock.t += 31 * 24 * 60 * 60 * 1000;
  assert.ok(!auth.isAuthenticated(req({ cookie })));
});

test('a tampered session cookie is rejected', () => {
  const { auth } = withAdmin();
  auth.createUser({ username: 'kid', password: 'kid-password', role: 'viewer' });
  const cookie = cookieOf(login(auth, 'kid-password', 'kid'));
  const [name, value] = cookie.split('=');
  const parts = decodeURIComponent(value).split('.');
  const later = [...parts];
  later[2] = String(Number(parts[2]) + 1e12);
  assert.ok(!auth.isAuthenticated(req({ cookie: `${name}=${later.join('.')}` })), 'longer expiry');
  const otherUser = [...parts];
  otherUser[1] = '1';
  assert.ok(!auth.isAuthenticated(req({ cookie: `${name}=${otherUser.join('.')}` })), 'someone else\'s id');
});

test('session cookies from before accounts are no longer accepted', () => {
  const { auth, settings } = withAdmin();
  auth.issueDownloadToken(); // makes the signing secret
  const secret = settings.get('serverSessionSecret');
  const crypto = require('crypto');
  const body = `session.${Date.now() + 1e9}`;
  const legacy = `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
  assert.ok(!auth.isAuthenticated(req({ cookie: `${SESSION_COOKIE}=${legacy}` })));
});

test('the API token and the server\'s own session act as an admin', () => {
  const { auth } = makeAuth();
  const token = auth.apiToken();
  assert.ok(token.startsWith('pv_'));
  assert.strictEqual(auth.authenticate(req({ authorization: `Bearer ${token}` })).role, 'admin');
  const system = auth.issueSessionToken();
  assert.strictEqual(auth.authenticate(req({ cookie: `${SESSION_COOKIE}=${system}` })).role, 'admin');
  const next = auth.regenerateApiToken();
  assert.ok(!auth.isAuthenticated(req({ authorization: `Bearer ${token}` })));
  assert.ok(auth.isAuthenticated(req({ authorization: `Bearer ${next}` })));
});

test('download tokens work only for downloads and expire after 15 minutes', () => {
  const { auth, clock } = makeAuth();
  const token = auth.issueDownloadToken();
  assert.ok(auth.isDownloadAuthorized(req({ query: { token } })));
  assert.ok(!auth.isAuthenticated(req({ query: { token } })));
  const download = req({ query: { token }, path: '/api/download//lib/a.stl' });
  let passed = false;
  auth.requireAuth(download, fakeRes(), () => { passed = true; });
  assert.ok(passed);
  assert.strictEqual(download.user.role, 'viewer', 'a download link only reads');
  clock.t += 16 * 60 * 1000;
  assert.ok(!auth.isDownloadAuthorized(req({ query: { token } })));
});

test('the status route says who is logged in', () => {
  const { auth } = withAdmin();
  auth.createUser({ username: 'kid', password: 'kid-password', role: 'viewer' });
  const cookie = cookieOf(login(auth, 'kid-password', 'kid'));
  const res = fakeRes();
  routesOf(auth)['GET /api/auth/status'](req({ cookie }), res);
  assert.deepStrictEqual(res.body, { authenticated: true, user: { id: res.body.user.id, username: 'kid', role: 'viewer', roleLabel: 'Viewer' } });
  const anon = fakeRes();
  routesOf(auth)['GET /api/auth/status'](req(), anon);
  assert.deepStrictEqual(anon.body, { authenticated: false });
});

test('the SQLite user store keeps users in a users table', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  const store = createSqliteUserStore(() => db);
  const id = store.insert({ username: 'Maker', passwordHash: 'x', role: 'editor', now: '2026-10-07T00:00:00.000Z' });
  assert.strictEqual(store.findByName('maker').id, id, 'names ignore case');
  assert.throws(() => store.insert({ username: 'MAKER', passwordHash: 'y', role: 'viewer', now: 'n' }), /UNIQUE/);
  const key = store.findById(id).session_key;
  store.update(id, { role: 'admin', resetSessions: true });
  assert.strictEqual(store.findById(id).role, 'admin');
  assert.notStrictEqual(store.findById(id).session_key, key);
  assert.strictEqual(store.countRole('admin'), 1);
  store.remove(id);
  assert.strictEqual(store.count(), 0);
  db.close();
  assert.throws(() => store.count(), /not open/);
});

test('roles rank viewer < editor < admin', () => {
  assert.ok(roleAllows('admin', 'editor') && roleAllows('editor', 'editor') && roleAllows('editor', 'viewer'));
  assert.ok(!roleAllows('viewer', 'editor') && !roleAllows('editor', 'admin') && !roleAllows('nobody', 'viewer'));
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
  const { auth } = withAdmin();
  const cookie = cookieOf(login(auth, 'library-pass'));
  assert.strictEqual(auth.verifyUpgrade(req({ origin: 'https://evil.example' })).status, 403);
  assert.strictEqual(auth.verifyUpgrade(req({ origin: 'https://evil.example', cookie })).status, 403);
  assert.strictEqual(auth.verifyUpgrade(req({ origin: 'http://nas.local:5000' })).status, 401);
  const upgrade = auth.verifyUpgrade(req({ origin: 'http://nas.local:5000', cookie }));
  assert.ok(upgrade.ok);
  assert.strictEqual(upgrade.user.username, 'admin', 'the socket knows its user');
});

test('origin checks accept this host, the forwarded host and extras', () => {
  assert.ok(originAllowed(req()));
  assert.ok(originAllowed(req({ origin: 'http://nas.local:5000' })));
  assert.ok(!originAllowed(req({ origin: 'http://nas.local:5001' })));
  const proxied = req({ origin: 'https://library.example.com', host: 'justtprint:5000' });
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

test('JUSTTPRINT_TRUST_PROXY parses hops, true, and address lists', () => {
  const { parseTrustProxy } = require('../src/server/server-auth');
  assert.strictEqual(parseTrustProxy(undefined), false);
  assert.strictEqual(parseTrustProxy('false'), false);
  assert.strictEqual(parseTrustProxy('0'), false);
  assert.strictEqual(parseTrustProxy('1'), 1);
  assert.strictEqual(parseTrustProxy('true'), true);
  assert.deepStrictEqual(parseTrustProxy('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
});
