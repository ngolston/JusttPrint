#!/usr/bin/env node
'use strict';

// Several MakerWorld accounts: signing in with another one keeps the one before, and switching
// back needs no password. Downloads use one at a time, and no token leaves through the actions.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const account = require('../src/server/makerworld-account');
const { SECRET_SETTING_KEYS } = require('../src/server/server-auth');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-accounts-')));
database.db = new Database(path.join(tmp, 'test.db'));
database.db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');

// A pretend Bambu Lab: any password signs in with a token of who asked.
const bambu = async (url, options) => {
  const body = options.body ? JSON.parse(options.body) : null;
  const json = (status, value) => new Response(JSON.stringify(value), { status });
  if (url.endsWith('/user/login')) return json(200, { accessToken: `TOKEN-${body.account}`, refreshToken: `REFRESH-${body.account}`, expiresIn: 3600 });
  if (url.endsWith('/my/preference')) return json(200, { name: options.headers.authorization.replace('Bearer TOKEN-', 'Name ') });
  throw new Error(`unexpected ${url}`);
};
const signIn = (email) => account.signIn({ account: email, password: 'x' }, bambu);
const token = () => (account.authHeaders() || {}).authorization || null;
const summary = (list = account.accounts()) => list.map((a) => `${a.account}${a.active ? '*' : ''}`);

(async () => {
  assert.ok(SECRET_SETTING_KEYS.has('makerWorldSavedAccounts'), 'saved accounts never leave through the settings API');
  assert.deepStrictEqual(account.accounts(), []);

  await signIn('a@x.com');
  assert.deepStrictEqual(summary(), ['a@x.com*']);
  await signIn('b@x.com');
  assert.deepStrictEqual(summary(), ['b@x.com*', 'a@x.com'], 'signing in with another account keeps the one before');
  assert.strictEqual(token(), 'Bearer TOKEN-b@x.com', 'downloads use the last one signed in');

  assert.deepStrictEqual(summary(account.activate('A@X.com')), ['a@x.com*', 'b@x.com']);
  assert.strictEqual(token(), 'Bearer TOKEN-a@x.com', 'switching needs no password and uses the kept token');
  assert.strictEqual(account.status().name, 'Name a@x.com');

  await signIn('a@x.com');
  assert.deepStrictEqual(summary(), ['a@x.com*', 'b@x.com'], 'signing in again with the same account does not repeat it');

  account.signOut();
  assert.strictEqual(account.authHeaders(), null, 'after Sign Out downloads ask for a sign-in');
  assert.deepStrictEqual(summary(), ['b@x.com'], 'Sign Out forgets the one in use and leaves the others');
  account.activate('b@x.com');
  assert.strictEqual(token(), 'Bearer TOKEN-b@x.com');

  await signIn('a@x.com');
  assert.deepStrictEqual(summary(), ['a@x.com*', 'b@x.com'], 'signing in with a saved one takes it off the saved list');

  assert.throws(() => account.activate('c@x.com'), /not saved/);
  assert.deepStrictEqual(summary(account.forget('b@x.com')), ['a@x.com*']);
  assert.deepStrictEqual(account.forget('a@x.com'), []);
  assert.strictEqual(account.authHeaders(), null, 'forgetting the one in use takes it off downloads');

  await signIn('a@x.com');
  await signIn('b@x.com');
  const visible = JSON.stringify([account.accounts(), account.status()]);
  assert.ok(!/TOKEN|REFRESH/.test(visible), `no token leaves through the actions: ${visible}`);
  console.log('ok several MakerWorld accounts');
})()
  .catch((error) => {
    console.error('FAIL', error);
    process.exitCode = 1;
  })
  .finally(() => {
    database.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
