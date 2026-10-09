'use strict';

/**
 * Login, API tokens and download tokens for the HTTP/WebSocket server.
 *
 * - Browsers log in with a user name and password (users.js) and get a signed session cookie.
 *   The cookie names the user and is signed with the server secret plus that user's session
 *   key, so changing a user's password or deleting the account logs them out everywhere.
 * - MCP clients and scripts send `Authorization: Bearer <api token>`; the token acts as an admin.
 * - The slicer helper gets a short-lived download token in its justtprint:// link.
 * - The thumbnail worker (started by the server) gets a system session that acts as an admin.
 *
 * The signing secret and API token live in the settings table. Before user accounts there was
 * one password (serverPasswordHash); the first start after upgrading turns it into the admin
 * account (JUSTTPRINT_USERNAME, default "admin").
 */

const crypto = require('crypto');
const { createMemoryUserStore, isRole, publicUser, ROLE_LABELS, USERNAME_PATTERN } = require('./users');

const SESSION_COOKIE = 'pv_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DOWNLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

const SETTING_KEYS = {
  /** The single password from before user accounts; moved into the users table on first start. */
  passwordHash: 'serverPasswordHash',
  signingSecret: 'serverSessionSecret',
  apiToken: 'serverApiToken',
  /** The MakerWorld (Bambu Lab) sign-in for downloads: makerworld-account.js. */
  makerWorldAccount: 'makerWorldAccount',
  /** The Thingiverse API token for downloads: site-files.js. */
  thingiverseToken: 'thingiverseToken'
};

/** Settings that must never be read or written through the generic settings API. */
const SECRET_SETTING_KEYS = new Set(Object.values(SETTING_KEYS));

const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/status',
  '/api/health',
  // Browsers ask for /favicon.ico on their own (http.js answers it from assets/).
  '/favicon.ico',
  '/manifest.webmanifest',
  '/sw.js',
  '/assets/favicon.ico',
  '/assets/logo.png',
  '/assets/pwa-icon-192.png',
  '/assets/pwa-icon-512.png',
  '/assets/pwa-maskable-192.png',
  '/assets/pwa-maskable-512.png',
  '/assets/apple-touch-icon.png'
]);

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPasswordHash(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

/** Who the API token, the server's own clients and download links act as. */
const SYSTEM_USER = Object.freeze({ id: 0, username: 'system', role: 'admin', system: true });
const API_TOKEN_USER = Object.freeze({ id: 0, username: 'API token', role: 'admin', system: true });
const DOWNLOAD_USER = Object.freeze({ id: 0, username: 'download link', role: 'viewer', system: true });
/**
 * Guest access (Settings → Users, or JUSTTPRINT_GUEST_ACCESS=true): requests without a login
 * browse as this user, like a Viewer. Guests keep no settings and change no password, and API
 * tokens and MCP never fall back to it.
 */
const GUEST_USER = Object.freeze({ id: 0, username: 'guest', role: 'viewer', guest: true });

function makeSignedToken(secret, kind, ttlMs, now) {
  const body = `${kind}.${now + ttlMs}`;
  return `${body}.${sign(secret, body)}`;
}

function checkSignedToken(secret, kind, token, now) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== kind) return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires < now) return false;
  return safeEqual(parts[2], sign(secret, `${parts[0]}.${parts[1]}`));
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch (_) {
      cookies[name] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

function bearerToken(req) {
  const header = String((req.headers && req.headers.authorization) || '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : '';
}

function requestIsHttps(req) {
  if (req.secure || (req.socket && req.socket.encrypted)) return true;
  const forwarded = String((req.headers && req.headers['x-forwarded-proto']) || '')
    .split(',')[0]
    .trim();
  return forwarded.toLowerCase() === 'https';
}

/** True when the Origin header (if any) is this server, or in the extra allowlist. */
function originAllowed(req, extraOrigins = []) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true; // Not a browser request (MCP client, curl, helper).
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (_) {
    return false;
  }
  if (extraOrigins.includes(parsed.origin)) return true;
  const hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean).map((value) => String(value).split(',')[0].trim().toLowerCase());
  return hosts.includes(parsed.host.toLowerCase());
}

/**
 * Value for Express "trust proxy" from JUSTTPRINT_TRUST_PROXY: a hop count ("1"),
 * "true", or addresses/subnets ("loopback, 10.0.0.0/8"). Unset or "false": trust no proxy.
 */
function parseTrustProxy(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.toLowerCase() === 'false' || text === '0') return false;
  if (text.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(text)) return Number(text);
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[ch]
  );
}

/** Only allow same-site relative redirects after login. */
function safeNextPath(value) {
  const next = String(value || '/');
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

function loginPageHtml(next, error, username = '', { guest = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JusttPrint Login</title>
<link rel="icon" href="/assets/favicon.ico">
<style>
  :root { color-scheme: light dark; --bg: #f4f5f7; --card: #fff; --text: #1e1e2e; --muted: #5b6070; --accent: #0891b2; --error: #b91c1c; --border: #d6d9e0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1e1e2e; --card: #2a2a3c; --text: #e6e6ef; --muted: #a3a6b8; --accent: #22d3ee; --error: #f87171; --border: #3d3d52; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
  form { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 28px; }
  img { display: block; width: 64px; height: 64px; margin: 0 auto 12px; border-radius: 14px; }
  h1 { font-size: 1.25rem; text-align: center; margin: 0 0 20px; }
  label { display: block; font-size: 0.875rem; color: var(--muted); margin: 12px 0 6px; }
  label:first-of-type { margin-top: 0; }
  input { width: 100%; padding: 10px 12px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--border); border-radius: 8px; }
  button { width: 100%; margin-top: 16px; padding: 10px; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
  .error { color: var(--error); font-size: 0.875rem; margin: 12px 0 0; }
  .hint { color: var(--muted); font-size: 0.8125rem; margin: 16px 0 0; }
  .hint.guest { text-align: center; font-size: 0.9375rem; }
  a { color: var(--accent); }
</style>
</head>
<body>
<form method="post" action="/api/auth/login">
  <img src="/assets/logo.png" alt="">
  <h1>JusttPrint</h1>
  <label for="username">User name</label>
  <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" value="${escapeHtml(username)}" ${username ? '' : 'autofocus '}required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" ${username ? 'autofocus ' : ''}required>
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <button type="submit">Log in</button>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
  ${guest ? `<p class="hint guest"><a href="${escapeHtml(next)}">Browse as a guest</a> (look and download, without an account)</p>` : ''}
  <p class="hint">First start: log in as <code>admin</code> with the password from the JusttPrint backend's log (<code>docker logs</code>), or the one in <code>JUSTTPRINT_PASSWORD</code>.</p>
</form>
</body>
</html>`;
}

/**
 * @param {object} deps
 * @param {(key: string) => (string|null|undefined)} deps.getSetting
 * @param {(key: string, value: string) => void} deps.setSetting
 * @param {ReturnType<typeof createMemoryUserStore>} [deps.users] User store (users.js); tests get a memory store.
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {{log: Function, warn: Function}} [deps.logger]
 * @param {() => number} [deps.now]
 * @param {() => string[]} [deps.extraOrigins] Origins allowed besides this server (e.g. the desktop UI).
 */
function createServerAuth({
  getSetting,
  setSetting,
  users = createMemoryUserStore(),
  env = process.env,
  logger = console,
  now = Date.now,
  extraOrigins = () => []
}) {
  const loginFailures = new Map();
  // The signing secret and API token are checked on every request: read them once, then keep them.
  const remembered = new Map();
  // Users by id, so sessions keep working while the database is closed (during a restore).
  const userCache = new Map();
  /** @type {string | null} */
  let dummyHash = null;

  /** @param {() => string} create */
  function rememberedSetting(key, create) {
    if (!remembered.has(key)) {
      let value = getSetting(key);
      if (!value) {
        value = create();
        setSetting(key, value);
      }
      remembered.set(key, value);
    }
    return remembered.get(key);
  }

  function storeRemembered(key, value) {
    setSetting(key, value);
    remembered.set(key, value);
  }

  function signingSecret() {
    return rememberedSetting(SETTING_KEYS.signingSecret, () => randomSecret());
  }

  const isoNow = () => new Date(now()).toISOString();

  /** The admin account JUSTTPRINT_PASSWORD belongs to, and the one made on first start. */
  function defaultUsername() {
    const name = String(env.JUSTTPRINT_USERNAME || '').trim();
    if (!name) return 'admin';
    if (!USERNAME_PATTERN.test(name)) {
      logger.warn(`JUSTTPRINT_USERNAME "${name}" is not a valid user name; using "admin".`);
      return 'admin';
    }
    return name;
  }

  /** The user whose password comes from JUSTTPRINT_PASSWORD (it cannot be changed in the web UI). */
  function envUsername() {
    return env.JUSTTPRINT_PASSWORD ? defaultUsername() : null;
  }

  function isEnvUser(row) {
    const name = envUsername();
    return !!row && !!name && row.username.toLowerCase() === name.toLowerCase();
  }

  function assertPassword(password) {
    if (String(password || '').length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }

  function loadUser(id) {
    try {
      const row = users.findById(id);
      if (row) userCache.set(row.id, row);
      else userCache.delete(Number(id));
      return row;
    } catch (_) {
      return userCache.get(Number(id)) || null;
    }
  }

  function forget(id) {
    userCache.delete(Number(id));
  }

  /**
   * Make sure an admin can log in. The first start (or the first after upgrading from the single
   * password) creates the admin account: with JUSTTPRINT_PASSWORD when set, else the old
   * password, else a random password printed once to the log. Later starts only make the
   * JUSTTPRINT_PASSWORD account match the variable.
   */
  function ensureCredentials() {
    const username = defaultUsername();
    const envPassword = env.JUSTTPRINT_PASSWORD;
    if (users.count() === 0) {
      const legacyHash = getSetting(SETTING_KEYS.passwordHash);
      let passwordHash;
      let source;
      let generated;
      if (envPassword) {
        assertPassword(envPassword);
        passwordHash = hashPassword(envPassword);
        source = 'env';
      } else if (legacyHash) {
        passwordHash = legacyHash;
        source = 'stored';
      } else {
        generated = randomSecret(12);
        passwordHash = hashPassword(generated);
        source = 'generated';
      }
      users.insert({ username, passwordHash, role: 'admin', now: isoNow() });
      if (legacyHash) {
        setSetting(SETTING_KEYS.passwordHash, '');
        logger.log(`[Auth] The old JusttPrint password is now the password of the admin account "${username}".`);
      }
      if (generated) {
        logger.warn(
          [
            '',
            '================================================================',
            ' JusttPrint admin login (shown once):',
            `   user name: ${username}`,
            `   password:  ${generated}`,
            ' Change it under Settings > Users, or set JUSTTPRINT_PASSWORD.',
            '================================================================',
            ''
          ].join('\n')
        );
      }
      return generated ? { source, username, password: generated } : { source, username };
    }
    if (envPassword) {
      const row = users.findByName(username);
      if (!row) {
        assertPassword(envPassword);
        users.insert({ username, passwordHash: hashPassword(envPassword), role: 'admin', now: isoNow() });
      } else {
        if (row.role !== 'admin') users.update(row.id, { role: 'admin' });
        if (!verifyPasswordHash(envPassword, row.password_hash)) {
          assertPassword(envPassword);
          users.update(row.id, { passwordHash: hashPassword(envPassword), resetSessions: true });
        }
        forget(row.id);
      }
      return { source: 'env', username };
    }
    return { source: 'stored', username };
  }

  /** A restored database from before user accounts has no users yet: make the admin first. */
  function ensureUsersExist() {
    try {
      if (users.count() === 0) ensureCredentials();
    } catch (error) {
      logger.warn(`[Auth] Could not check the user accounts: ${error.message}`);
    }
  }

  /** The user for a user name and password, or null. Unknown names cost as much as wrong passwords. */
  function verifyLogin(username, password) {
    const name = String(username || '').trim() || defaultUsername();
    let row;
    try {
      row = users.findByName(name);
    } catch (_) {
      row = [...userCache.values()].find((cached) => cached.username.toLowerCase() === name.toLowerCase()) || null;
    }
    if (!row) {
      if (!dummyHash) dummyHash = hashPassword(randomSecret());
      verifyPasswordHash(String(password || ''), dummyHash);
      return null;
    }
    if (!verifyPasswordHash(String(password || ''), row.password_hash)) return null;
    userCache.set(row.id, row);
    return row;
  }

  function apiToken() {
    return rememberedSetting(SETTING_KEYS.apiToken, () => `pv_${randomSecret()}`);
  }

  function regenerateApiToken() {
    const token = `pv_${randomSecret()}`;
    storeRemembered(SETTING_KEYS.apiToken, token);
    return token;
  }

  function userSessionToken(row) {
    const body = `u.${row.id}.${now() + SESSION_TTL_MS}`;
    return `${body}.${sign(signingSecret(), `${body}.${row.session_key}`)}`;
  }

  /** Session cookie value for a client the server starts itself (the thumbnail worker). */
  function issueSessionToken() {
    return makeSignedToken(signingSecret(), 'sys', SESSION_TTL_MS, now());
  }

  function issueDownloadToken() {
    return makeSignedToken(signingSecret(), 'dl', DOWNLOAD_TOKEN_TTL_MS, now());
  }

  /** Who a session cookie belongs to: { id, username, role }, the system user, or null. */
  function sessionUser(req) {
    const cookie = parseCookies(req.headers && req.headers.cookie)[SESSION_COOKIE];
    if (!cookie) return null;
    const parts = cookie.split('.');
    if (parts[0] === 'sys') return checkSignedToken(signingSecret(), 'sys', cookie, now()) ? SYSTEM_USER : null;
    if (parts[0] !== 'u' || parts.length !== 4) return null;
    const id = Number(parts[1]);
    const expires = Number(parts[2]);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(expires) || expires < now()) return null;
    const row = loadUser(id);
    if (!row || !isRole(row.role)) return null;
    if (!safeEqual(parts[3], sign(signingSecret(), `u.${parts[1]}.${parts[2]}.${row.session_key}`))) return null;
    return { id: row.id, username: row.username, role: row.role };
  }

  function hasValidApiToken(req) {
    const token = bearerToken(req);
    return !!token && safeEqual(token, apiToken());
  }

  /** The logged-in user of a request (session cookie or API token), or null. */
  function authenticate(req) {
    return sessionUser(req) || (hasValidApiToken(req) ? API_TOKEN_USER : null);
  }

  function isAuthenticated(req) {
    return !!authenticate(req);
  }

  /** Guest access is on (the setting, or JUSTTPRINT_GUEST_ACCESS=true). */
  function guestAccessOn() {
    return String(env.JUSTTPRINT_GUEST_ACCESS || '').toLowerCase() === 'true' || getSetting('guestAccess') === 'true';
  }

  /** The guest for a request without a login, when guest access is on. Not for API tokens or MCP. */
  function guestFor(req) {
    if (!guestAccessOn() || req.headers.authorization) return null;
    return /^\/mcp(\/|$)/.test(req.path || '') ? null : GUEST_USER;
  }

  function hasDownloadToken(req) {
    const token = req.query && typeof req.query.token === 'string' ? req.query.token : '';
    return !!token && checkSignedToken(signingSecret(), 'dl', token, now());
  }

  /** Download routes also accept ?token= so the slicer helper can fetch files. */
  function isDownloadAuthorized(req) {
    return isAuthenticated(req) || hasDownloadToken(req);
  }

  function sessionCookie(req, value, maxAgeMs) {
    const parts = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (requestIsHttps(req)) parts.push('Secure');
    return parts.join('; ');
  }

  function loginBlocked(ip) {
    const entry = loginFailures.get(ip);
    if (!entry) return false;
    if (now() - entry.first > LOGIN_WINDOW_MS) {
      loginFailures.delete(ip);
      return false;
    }
    return entry.count >= LOGIN_MAX_FAILURES;
  }

  function recordLoginFailure(ip) {
    const entry = loginFailures.get(ip);
    if (!entry || now() - entry.first > LOGIN_WINDOW_MS) {
      loginFailures.set(ip, { first: now(), count: 1 });
    } else {
      entry.count += 1;
    }
  }

  function isPublicPath(pathname) {
    return PUBLIC_PATHS.has(pathname);
  }

  function isDownloadPath(pathname) {
    return pathname.startsWith('/api/download/');
  }

  function wantsHtml(req) {
    return req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
  }

  /**
   * Express middleware: everything except PUBLIC_PATHS needs a session or API token.
   * Sets req.user to who is calling ({ id, username, role }).
   */
  function requireAuth(req, res, next) {
    if (isPublicPath(req.path)) return next();
    const user = authenticate(req) || (isDownloadPath(req.path) && hasDownloadToken(req) ? DOWNLOAD_USER : null) || guestFor(req);
    if (user) {
      req.user = user;
      return next();
    }
    if (wantsHtml(req)) {
      res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl || '/')}`);
      return;
    }
    res.status(401).json({ error: 'Login required' });
  }

  /** CORS: only answer for this server's own origin and the configured extras. */
  function cors(req, res, next) {
    const origin = req.headers.origin;
    if (origin && originAllowed(req, extraOrigins())) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Vary', 'Origin');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID'
      );
      res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(origin && !originAllowed(req, extraOrigins()) ? 403 : 204);
      return;
    }
    next();
  }

  /** Reject cross-site state-changing requests even when a cookie is present. */
  function rejectForeignOrigins(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req, extraOrigins())) {
      res.status(403).json({ error: 'Cross-site request blocked' });
      return;
    }
    next();
  }

  /** For WebSocket upgrades: same origin, plus a session or API token. */
  function verifyUpgrade(req) {
    if (!originAllowed(req, extraOrigins())) return { ok: false, status: 403, reason: 'Origin not allowed' };
    const user = authenticate(req) || guestFor(req);
    if (!user) return { ok: false, status: 401, reason: 'Login required' };
    return { ok: true, user };
  }

  // Accounts (Settings → Users). `actor` is who asks: { id, username, role }.

  function listUsers() {
    return users.list().map((row) => ({ ...publicUser(row), fromEnv: isEnvUser(row) }));
  }

  function findUserOrThrow(id) {
    const row = users.findById(Number(id));
    if (!row) throw new Error('That user no longer exists');
    return row;
  }

  function assertNotLastAdmin(row, message) {
    if (row.role === 'admin' && users.countRole('admin') <= 1) throw new Error(message);
  }

  /** @param {{ username?: string, password?: string, role?: string }} [input] */
  function createUser({ username, password, role } = {}) {
    const name = String(username || '').trim();
    if (!USERNAME_PATTERN.test(name)) {
      throw new Error('User names are 1 to 64 letters, digits, dots, dashes, underscores or @, starting with a letter or digit');
    }
    if (!isRole(role)) throw new Error('Choose a role: viewer, editor or admin');
    assertPassword(password);
    if (users.findByName(name)) throw new Error(`There is already a user named ${name}`);
    const id = users.insert({ username: name, passwordHash: hashPassword(password), role, now: isoNow() });
    return publicUser(users.findById(id));
  }

  /** Change a user's role and/or password. A new password logs that user out everywhere. */
  /**
   * @param {number} id
   * @param {{ role?: string, password?: string }} [changes]
   */
  function updateUser(id, { role, password } = {}) {
    const row = findUserOrThrow(id);
    if (role !== undefined && role !== null && role !== row.role) {
      if (!isRole(role)) throw new Error('Choose a role: viewer, editor or admin');
      if (isEnvUser(row)) throw new Error(`${row.username} is the JUSTTPRINT_PASSWORD account and stays an admin`);
      assertNotLastAdmin(row, 'This is the only admin. Make another user an admin first.');
      users.update(row.id, { role });
    }
    if (password !== undefined && password !== null && password !== '') {
      if (isEnvUser(row)) throw new Error('This password is set by JUSTTPRINT_PASSWORD. Change it there and restart.');
      assertPassword(password);
      users.update(row.id, { passwordHash: hashPassword(password), resetSessions: true });
    }
    forget(row.id);
    return publicUser(users.findById(row.id));
  }

  function deleteUser(actor, id) {
    const row = findUserOrThrow(id);
    if (actor && actor.id === row.id) throw new Error('You cannot delete your own account');
    if (isEnvUser(row)) throw new Error(`${row.username} is the JUSTTPRINT_PASSWORD account and cannot be deleted`);
    assertNotLastAdmin(row, 'This is the only admin and cannot be deleted');
    users.remove(row.id);
    forget(row.id);
    return { success: true };
  }

  /** A user changes their own password; logs them out everywhere. */
  function changeOwnPassword(actor, currentPassword, newPassword) {
    if (!actor || !actor.id) throw new Error('Only a logged-in user can change their password');
    const row = findUserOrThrow(actor.id);
    if (isEnvUser(row)) throw new Error('The password is set by JUSTTPRINT_PASSWORD. Change it there and restart.');
    if (!verifyPasswordHash(String(currentPassword || ''), row.password_hash)) throw new Error('Current password is wrong');
    assertPassword(newPassword);
    users.update(row.id, { passwordHash: hashPassword(newPassword), resetSessions: true });
    forget(row.id);
    return { success: true };
  }

  function registerRoutes(app, express) {
    const form = express.urlencoded({ extended: false, limit: '10kb' });

    app.get('/login', (req, res) => {
      if (sessionUser(req)) {
        res.redirect(302, safeNextPath(req.query.next));
        return;
      }
      const username = typeof req.query.user === 'string' ? req.query.user.slice(0, 64) : '';
      res
        .type('html')
        .send(loginPageHtml(safeNextPath(req.query.next), req.query.error ? 'Wrong user name or password.' : '', username, { guest: guestAccessOn() }));
    });

    app.post('/api/auth/login', form, express.json({ limit: '10kb' }), (req, res) => {
      const body = req.body || {};
      const next = safeNextPath(body.next);
      const isForm = !String(req.headers['content-type'] || '').includes('application/json');
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
      const username = typeof body.username === 'string' ? body.username.trim().slice(0, 64) : '';

      if (loginBlocked(ip)) {
        if (isForm) {
          res
            .status(429)
            .type('html')
            .send(loginPageHtml(next, 'Too many attempts. Try again in 15 minutes.', username));
        } else {
          res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
        }
        return;
      }
      ensureUsersExist();
      const row = verifyLogin(username, body.password);
      if (!row) {
        recordLoginFailure(ip);
        if (isForm) {
          res.redirect(303, `/login?error=1&next=${encodeURIComponent(next)}${username ? `&user=${encodeURIComponent(username)}` : ''}`);
        } else {
          res.status(401).json({ error: 'Wrong user name or password' });
        }
        return;
      }
      loginFailures.delete(ip);
      try {
        users.touchLogin(row.id, isoNow());
      } catch (_) {
        /* database closed during a restore */
      }
      res.setHeader('Set-Cookie', sessionCookie(req, userSessionToken(row), SESSION_TTL_MS));
      if (isForm) {
        res.redirect(303, next);
      } else {
        res.json({ success: true, user: { id: row.id, username: row.username, role: row.role } });
      }
    });

    app.post('/api/auth/logout', (req, res) => {
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
      res.json({ success: true });
    });

    app.get('/api/auth/status', (req, res) => {
      const user = authenticate(req);
      const guest = user ? null : guestFor(req);
      res.json(
        user
          ? { authenticated: true, user: { id: user.id, username: user.username, role: user.role, roleLabel: ROLE_LABELS[user.role] } }
          : guest
            ? { authenticated: true, guest: true, user: { id: 0, username: 'Guest', role: guest.role, roleLabel: 'Guest', guest: true } }
            : { authenticated: false }
      );
    });
  }

  return {
    ensureCredentials,
    verifyLogin,
    envUsername,
    apiToken,
    regenerateApiToken,
    issueDownloadToken,
    issueSessionToken,
    authenticate,
    isAuthenticated,
    guestAccessOn,
    isDownloadAuthorized,
    requireAuth,
    cors,
    rejectForeignOrigins,
    verifyUpgrade,
    registerRoutes,
    listUsers,
    createUser,
    updateUser,
    deleteUser,
    changeOwnPassword
  };
}

module.exports = {
  SESSION_COOKIE,
  SYSTEM_USER,
  API_TOKEN_USER,
  SETTING_KEYS,
  SECRET_SETTING_KEYS,
  MIN_PASSWORD_LENGTH,
  createServerAuth,
  hashPassword,
  verifyPasswordHash,
  originAllowed,
  parseCookies,
  parseTrustProxy,
  safeNextPath
};
