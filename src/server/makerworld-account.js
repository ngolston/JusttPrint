'use strict';

/**
 * The MakerWorld sign-in JusttPrint downloads with: one Bambu Lab account for the whole server,
 * kept in the makerWorldAccount setting (never readable through the settings API). Browsers only
 * learn whether it is signed in and as whom; the token stays on the server.
 *
 * Sign-in goes through Bambu Lab's account API, as Bambu Studio does: email and password, then
 * the code Bambu Lab emails when it asks for one (or the authenticator code with two-factor sign-in).
 */

const database = require('../core/database');
const { httpsFetch, readLimited, USER_AGENT } = require('./link-import');

const KEY = 'makerWorldAccount';
const API = 'https://api.bambulab.com';
const TIMEOUT_MS = 20000;
// When Bambu Lab does not say how long a token lasts.
const DEFAULT_TOKEN_SECONDS = 30 * 24 * 3600;

function read() {
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
    return row && row.value ? JSON.parse(row.value) : null;
  } catch (_) {
    return null;
  }
}

function write(account) {
  if (!account) database.db.prepare('DELETE FROM settings WHERE key = ?').run(KEY);
  else database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(account));
}

/** What a browser may know: signed in or not, and as whom. */
function status() {
  const account = read();
  if (!account || !account.accessToken) return { signedIn: false, account: null, name: null, expires: null };
  return { signedIn: true, account: account.account || null, name: account.name || null, expires: account.expiresAt || null };
}

/**
 * @param {string} path
 * @param {any} body
 * @param {Function} fetchImpl
 * @param {{ base?: string, token?: string }} [options]
 */
async function call(path, body, fetchImpl, { base = API, token } = {}) {
  const response = await fetchImpl(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = (await readLimited(response, 256 * 1024)).toString('utf8');
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    if (/Just a moment/i.test(text)) throw new Error('Bambu Lab asked for a browser check and did not answer. Try again later', { cause: error });
    throw new Error(`Bambu Lab answered ${response.status}`, { cause: error });
  }
  const cookie = response.headers.get('set-cookie') || '';
  return { status: response.status, ok: response.ok, json, cookieToken: (/(?:^|[;,]\s*)token=([^;,\s]+)/.exec(cookie) || [])[1] || null };
}

/** The signed-in account's name, when Bambu Lab tells (it does not matter if it does not). */
async function accountName(token, fetchImpl) {
  try {
    const { ok, json } = await call('/v1/design-user-service/my/preference', undefined, fetchImpl, { token });
    return ok ? json.name || json.handle || null : null;
  } catch (_) {
    return null;
  }
}

async function keep(account, tokens, fetchImpl) {
  const seconds = Number(tokens.expiresIn) > 0 ? Number(tokens.expiresIn) : DEFAULT_TOKEN_SECONDS;
  const saved = {
    account,
    name: await accountName(tokens.accessToken, fetchImpl),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || null,
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString()
  };
  write(saved);
  return { done: true, ...status() };
}

const loginError = (json, status) => new Error(json.error || json.message || (status === 400 ? 'Incorrect email or password' : `Bambu Lab answered ${status}`));

/**
 * One step of signing in. `{ account, password }` first; Bambu Lab may then want an emailed code
 * (answer `{ next: 'code' }`, send `{ account, code }`) or an authenticator code (answer
 * `{ next: 'tfa', tfaKey }`, send `{ account, tfaKey, tfaCode }`). Ends with `{ done: true, … }`.
 */
async function signIn(input, fetchImpl = httpsFetch) {
  const account = String((input && input.account) || '').trim();
  if (!account) throw new Error('Enter the email of your Bambu Lab account');

  if (input.tfaKey) {
    const {
      ok,
      status: code,
      json,
      cookieToken
    } = await call('/api/sign-in/tfa', { tfaKey: String(input.tfaKey), tfaCode: String(input.tfaCode || '').trim() }, fetchImpl, {
      base: 'https://bambulab.com'
    });
    const accessToken = json.accessToken || json.token || cookieToken;
    if (!ok || !accessToken) {
      if (/csrf/i.test(json.error || ''))
        throw new Error('Bambu Lab does not let JusttPrint finish two-factor sign-in. Turn on sign-in with an email code for your account instead');
      throw loginError(json, code);
    }
    return keep(account, { accessToken, refreshToken: json.refreshToken, expiresIn: json.expiresIn }, fetchImpl);
  }

  const body = input.code ? { account, code: String(input.code).trim() } : { account, password: String(input.password || '') };
  if (!body.code && !body.password) throw new Error('Enter your password');
  const { ok, status: code, json } = await call('/v1/user-service/user/login', body, fetchImpl);
  if (!ok) throw loginError(json, code);
  if (json.accessToken) return keep(account, json, fetchImpl);
  if (json.loginType === 'verifyCode') {
    const sent = await call('/v1/user-service/user/sendemail/code', { email: account, type: 'codeLogin' }, fetchImpl);
    if (!sent.ok) throw loginError(sent.json, sent.status);
    return { done: false, next: 'code' };
  }
  if (json.loginType === 'tfa' && json.tfaKey) return { done: false, next: 'tfa', tfaKey: json.tfaKey };
  throw new Error('Bambu Lab did not sign you in');
}

function signOut() {
  write(null);
  return status();
}

/** A new token from the refresh token, when the old one stopped working. False when there is none. */
async function refresh(fetchImpl = httpsFetch) {
  const account = read();
  if (!account || !account.refreshToken) return false;
  try {
    const { ok, json } = await call('/v1/user-service/user/refreshtoken', { refreshToken: account.refreshToken }, fetchImpl);
    if (!ok || !json.accessToken) return false;
    await keep(account.account, { refreshToken: account.refreshToken, ...json }, fetchImpl);
    return true;
  } catch (_) {
    return false;
  }
}

/** The headers MakerWorld wants for a signed-in request, or null when not signed in. */
function authHeaders() {
  const account = read();
  if (!account || !account.accessToken) return null;
  return { authorization: `Bearer ${account.accessToken}`, cookie: `token=${account.accessToken}` };
}

module.exports = { authHeaders, refresh, signIn, signOut, status };
