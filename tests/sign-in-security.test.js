#!/usr/bin/env node
'use strict';

// 10.2 Phase 12 (docs/plan-10.1.md): two-factor sign-in with recovery codes, each sign-in's
// session (list, end one, end the others), per-person API keys, and requiring two-factor sign-in.

const assert = require('assert');
const { createServerAuth } = require('../src/server/server-auth');
const { createMemoryUserStore } = require('../src/server/users');
const totp = require('../src/server/totp');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function setup() {
  const settings = new Map();
  const clock = { t: Date.parse('2026-10-31T12:00:00Z') };
  const auth = createServerAuth({
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => settings.set(key, value),
    users: createMemoryUserStore(),
    env: {},
    logger: { log() {}, warn() {} },
    now: () => clock.t
  });
  auth.ensureCredentials();
  const admin = auth.listUsers()[0];
  auth.updateUser(admin.id, { password: 'admin-pass' });
  const maker = auth.createUser({ username: 'maker', password: 'maker-pass', role: 'editor' });
  return { auth, settings, clock, admin, maker };
}

function routesOf(auth) {
  const routes = {};
  const app = {
    get: (p, ...h) => {
      routes[`GET ${p}`] = h.pop();
    },
    post: (p, ...h) => {
      routes[`POST ${p}`] = h.pop();
    }
  };
  auth.registerRoutes(app, { urlencoded: () => null, json: () => null });
  return routes;
}
const fakeRes = () => ({
  headers: {},
  statusCode: 200,
  setHeader(k, v) {
    this.headers[k] = v;
  },
  json(b) {
    this.body = b;
  },
  status(c) {
    this.statusCode = c;
    return this;
  },
  type() {
    return this;
  },
  send(html) {
    this.html = html;
  },
  redirect() {}
});
const call = async (auth, route, body, { ip = '10.0.0.2', agent = 'Test browser' } = {}) => {
  const res = fakeRes();
  await routesOf(auth)[route]({ body, headers: { 'content-type': 'application/json', host: 'nas.local:5000', 'user-agent': agent }, ip, socket: {} }, res);
  return res;
};
const cookieOf = (res) => res.headers['Set-Cookie'].split(';')[0];
const req = (cookie, authorization) => ({
  headers: { host: 'nas.local:5000', ...(cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}) },
  query: {},
  method: 'GET',
  path: '/'
});

test('codes match RFC 6238, the clock may be one step off, a code works once', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.strictEqual(totp.base32Decode(secret).toString(), '12345678901234567890');
  assert.deepStrictEqual([totp.codeAt(secret, 1), totp.codeAt(secret, 37037036), totp.codeAt(secret, 66666666)], ['287082', '081804', '279037']);
  const now = 59 * 1000;
  assert.strictEqual(totp.verify(secret, '287082', { now }), 1);
  assert.strictEqual(totp.verify(secret, '287 082', { now: now + 30000 }), 1, 'one step late is fine');
  assert.strictEqual(totp.verify(secret, '287082', { now: now + 90000 }), null, 'three steps late is not');
  assert.strictEqual(totp.verify(secret, '287082', { now, after: 1 }), null, 'used once already');
  assert.strictEqual(totp.verify(secret, 'abcdef', { now }), null);
  const { codes, hashes } = totp.newRecoveryCodes();
  assert.strictEqual(new Set(codes).size, 10);
  assert.match(codes[0], /^[a-z0-9x]{4}-[a-z0-9x]{4}-[a-z0-9x]{4}$/);
  const left = totp.useRecoveryCode(hashes, codes[3].toUpperCase());
  assert.strictEqual(left.length, 9);
  assert.strictEqual(totp.useRecoveryCode(left, codes[3]), null, 'a recovery code works once');
  assert.match(totp.otpauthUrl('ABC', 'maker'), /^otpauth:\/\/totp\/JusttPrint%3Amaker\?secret=ABC&issuer=JusttPrint/);
});

test('two-factor sign-in: set up with a code, then sign-in asks for one; recovery codes work once', async () => {
  const { auth, clock, maker } = setup();
  const who = { id: maker.id, role: 'editor' };
  const started = await auth.startTwoFactor(who);
  assert.match(started.qrSvg, /^<svg/);
  assert.throws(() => auth.enableTwoFactor(who, '000000'), /not right/);
  const step = totp.stepOf(clock.t);
  const { recoveryCodes } = auth.enableTwoFactor(who, totp.codeAt(started.secret, step));
  assert.strictEqual(recoveryCodes.length, 10);
  assert.deepStrictEqual(auth.twoFactorStatus(who), { enabled: true, recoveryCodesLeft: 10, required: false });
  assert.ok(auth.listUsers().find((u) => u.id === maker.id).twoFactor);

  const first = await call(auth, 'POST /api/auth/login', { username: 'maker', password: 'maker-pass' });
  assert.deepStrictEqual([first.body.twoFactor, first.headers['Set-Cookie']], ['code', undefined], 'no session before the code');
  const wrong = await call(auth, 'POST /api/auth/login/code', { pending: first.body.pending, code: '000000' });
  assert.strictEqual(wrong.statusCode, 401);
  const reused = await call(auth, 'POST /api/auth/login/code', { pending: first.body.pending, code: totp.codeAt(started.secret, step) });
  assert.strictEqual(reused.statusCode, 401, 'the code that turned it on cannot sign in again');
  clock.t += 30 * 1000;
  const ok = await call(auth, 'POST /api/auth/login/code', { pending: first.body.pending, code: totp.codeAt(started.secret, step + 1) });
  assert.strictEqual(ok.body.success, true);
  assert.strictEqual(auth.authenticate(req(cookieOf(ok))).username, 'maker');

  const second = await call(auth, 'POST /api/auth/login', { username: 'maker', password: 'maker-pass' });
  const rescued = await call(auth, 'POST /api/auth/login/code', { pending: second.body.pending, code: recoveryCodes[0] });
  assert.strictEqual(rescued.body.success, true, 'a recovery code instead');
  assert.strictEqual(auth.twoFactorStatus(who).recoveryCodesLeft, 9);
  const third = await call(auth, 'POST /api/auth/login', { username: 'maker', password: 'maker-pass' });
  assert.strictEqual((await call(auth, 'POST /api/auth/login/code', { pending: third.body.pending, code: recoveryCodes[0] })).statusCode, 401, 'once');

  clock.t += 11 * 60 * 1000;
  assert.strictEqual(
    (await call(auth, 'POST /api/auth/login/code', { pending: third.body.pending, code: totp.codeAt(started.secret, totp.stepOf(clock.t)) })).statusCode,
    401,
    'the pending sign-in expires'
  );
  assert.strictEqual(
    (await call(auth, 'POST /api/auth/login/code', { pending: 'p2.1.9999999999999.forged', code: '123456' })).statusCode,
    401,
    'a forged token is refused'
  );

  assert.throws(() => auth.disableTwoFactor(who, 'wrong'), /password is wrong/);
  assert.strictEqual(auth.newRecoveryCodes(who, 'maker-pass').recoveryCodes.length, 10);
  auth.disableTwoFactor(who, 'maker-pass');
  assert.strictEqual(
    (await call(auth, 'POST /api/auth/login', { username: 'maker', password: 'maker-pass' })).body.success,
    true,
    'off: the password alone again'
  );
});

test('sessions: each sign-in listed; end one, or all the others; signing out ends it', async () => {
  const { auth, maker } = setup();
  const a = cookieOf(await call(auth, 'POST /api/auth/login', { username: 'maker', password: 'maker-pass' }, { agent: 'Laptop', ip: '10.0.0.5' }));
  const b = cookieOf(await call(auth, 'POST /api/auth/login', { username: 'maker', password: 'maker-pass' }, { agent: 'Phone' }));
  const c = cookieOf(await call(auth, 'POST /api/auth/login', { username: 'maker', password: 'maker-pass' }, { agent: 'Tablet' }));
  const me = auth.authenticate(req(a));
  const list = auth.listSessions(me);
  assert.deepStrictEqual(list.map((s) => s.userAgent).sort(), ['Laptop', 'Phone', 'Tablet']);
  assert.deepStrictEqual(
    list.filter((s) => s.current).map((s) => [s.userAgent, s.ip]),
    [['Laptop', '10.0.0.5']]
  );
  const phone = list.find((s) => s.userAgent === 'Phone');
  assert.deepStrictEqual(auth.endSession(me, phone.id), { ended: true });
  assert.strictEqual(auth.authenticate(req(b)), null, 'the phone must sign in again');
  assert.strictEqual(auth.endSession({ id: 1, role: 'admin' }, list.find((s) => s.userAgent === 'Tablet').id).ended, false, "not someone else's");
  assert.deepStrictEqual(auth.endOtherSessions(me), { ended: 1 });
  assert.strictEqual(auth.authenticate(req(c)), null);
  assert.strictEqual(auth.authenticate(req(a)).username, 'maker', 'this browser stays');
  const res = fakeRes();
  routesOf(auth)['POST /api/auth/logout']({ headers: { cookie: a, host: 'nas.local:5000' }, body: {} }, res);
  assert.strictEqual(auth.authenticate(req(a)), null, 'signed out: the session is gone');
  auth.changeOwnPassword(me, 'maker-pass', 'maker-pass-2');
  assert.deepStrictEqual(auth.listSessions(me), [], 'a new password ends every session');
  assert.strictEqual(maker.username, 'maker');
});

test('API keys: shown once, act as their account with a role no higher; deleted, they stop', () => {
  const { auth, maker } = setup();
  const who = { id: maker.id, role: 'editor' };
  assert.throws(() => auth.createApiKey(who, { name: 'Sneaky', role: 'admin' }), /cannot do more/);
  assert.throws(() => auth.createApiKey(who, { name: ' ' }), /name/);
  const { key, token } = auth.createApiKey(who, { name: 'Home script', role: 'viewer' });
  assert.match(token, /^jpk_/);
  assert.ok(!JSON.stringify(auth.listApiKeys(who)).includes(token), 'only its start is listed');
  assert.strictEqual(key.prefix, token.slice(0, 10));
  const caller = auth.authenticate(req(null, `Bearer ${token}`));
  assert.deepStrictEqual([caller.username, caller.role, caller.apiKey], ['maker', 'viewer', key.id]);
  assert.throws(() => auth.createApiKey(caller, { name: 'More' }), /API key cannot/, 'a key cannot make keys');
  assert.throws(() => auth.endOtherSessions(caller), /API key cannot/);
  const full = auth.createApiKey(who, { name: 'Editor key' });
  assert.strictEqual(auth.authenticate(req(null, `Bearer ${full.token}`)).role, 'editor', 'no role: the account’s');
  auth.updateUser(maker.id, { role: 'viewer' });
  assert.strictEqual(auth.authenticate(req(null, `Bearer ${full.token}`)).role, 'viewer', 'never more than the account now has');
  assert.strictEqual(auth.authenticate(req(null, 'Bearer jpk_not-a-key')), null);
  assert.deepStrictEqual(auth.deleteApiKey(who, key.id), { deleted: true });
  assert.strictEqual(auth.authenticate(req(null, `Bearer ${token}`)), null);
  assert.ok(
    auth.listApiKeys(who).every((k) => k.lastUsedAt),
    'used keys say when'
  );
});

test('requiring two-factor: the admin needs it first; others are signed out and set it up at sign-in', async () => {
  const { auth, clock, admin, maker } = setup();
  const adminWho = { id: admin.id, role: 'admin' };
  const makerCookie = cookieOf(await call(auth, 'POST /api/auth/login', { username: 'maker', password: 'maker-pass' }));
  assert.throws(() => auth.setRequireTwoFactor(adminWho, true), /your own account first/);
  assert.throws(() => auth.setRequireTwoFactor({ id: maker.id, role: 'editor' }, true), /Only an admin/);
  const { secret } = await auth.startTwoFactor(adminWho);
  auth.enableTwoFactor(adminWho, totp.codeAt(secret, totp.stepOf(clock.t)));
  assert.deepStrictEqual(auth.setRequireTwoFactor(adminWho, true), { required: true, signedOut: ['maker'] });
  assert.strictEqual(auth.authenticate(req(makerCookie)), null, 'signed out');

  const start = await call(auth, 'POST /api/auth/login', { username: 'maker', password: 'maker-pass' });
  assert.strictEqual(start.body.twoFactor, 'setup');
  assert.strictEqual(start.headers['Set-Cookie'], undefined, 'no session until it is set up');
  const done = await call(auth, 'POST /api/auth/login/setup', { pending: start.body.pending, code: totp.codeAt(start.body.secret, totp.stepOf(clock.t)) });
  assert.strictEqual(done.body.success, true);
  assert.strictEqual(done.body.recoveryCodes.length, 10);
  assert.ok(auth.listUsers().find((u) => u.username === 'maker').twoFactor);
  assert.throws(() => auth.disableTwoFactor({ id: maker.id, role: 'editor' }, 'maker-pass'), /requires two-factor/);

  auth.resetTwoFactor(adminWho, maker.id);
  assert.ok(!auth.listUsers().find((u) => u.username === 'maker').twoFactor, 'an admin turns it off (a lost phone)');
  assert.deepStrictEqual(auth.setRequireTwoFactor(adminWho, false), { required: false, signedOut: [] });
});

test('JUSTTPRINT_RESET_TWO_FACTOR turns two-factor sign-in off for an account (the way back in)', async () => {
  const settings = new Map();
  const users = createMemoryUserStore();
  const warnings = [];
  const make = (env) =>
    createServerAuth({
      getSetting: (k) => settings.get(k),
      setSetting: (k, v) => settings.set(k, v),
      users,
      env,
      logger: { log() {}, warn: (m) => warnings.push(m) }
    });
  const auth = make({ JUSTTPRINT_PASSWORD: 'admin-pass-1' });
  auth.ensureCredentials();
  const admin = auth.listUsers()[0];
  const { secret } = await auth.startTwoFactor({ id: admin.id, role: 'admin' });
  auth.enableTwoFactor({ id: admin.id, role: 'admin' }, totp.codeAt(secret, totp.stepOf(Date.now())));
  assert.ok(auth.listUsers()[0].twoFactor);
  make({ JUSTTPRINT_PASSWORD: 'admin-pass-1', JUSTTPRINT_RESET_TWO_FACTOR: 'ADMIN' }).ensureCredentials();
  assert.ok(!auth.listUsers()[0].twoFactor, 'off after a restart with the variable');
  assert.ok(warnings.some((w) => /two-factor sign-in is off for admin/.test(w)));
  make({ JUSTTPRINT_RESET_TWO_FACTOR: 'nobody' }).ensureCredentials();
  assert.ok(warnings.some((w) => /no account called nobody/.test(w)));
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}:`, err.stack || err.message);
      process.exitCode = 1;
    }
  }
})();
