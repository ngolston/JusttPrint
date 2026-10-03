'use strict';

/**
 * Login, API tokens and download tokens for the HTTP/WebSocket server.
 *
 * - Browsers log in with the server password and get a signed session cookie.
 * - MCP clients and the desktop window send `Authorization: Bearer <api token>`.
 * - The slicer helper gets a short-lived download token in its printventory:// link.
 *
 * Secrets live in the settings table. Changing the password rotates the
 * signing secret, which logs out every session and voids download tokens.
 */

const crypto = require('crypto');

const SESSION_COOKIE = 'pv_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DOWNLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

const SETTING_KEYS = {
  passwordHash: 'serverPasswordHash',
  signingSecret: 'serverSessionSecret',
  apiToken: 'serverApiToken'
};

/** Settings that must never be read or written through the generic settings API. */
const SECRET_SETTING_KEYS = new Set(Object.values(SETTING_KEYS));

const PUBLIC_PATHS = new Set([
  '/login',
  '/api/auth/login',
  '/api/auth/status',
  '/api/health',
  '/favicon.ico',
  '/logo.png',
  '/manifest.webmanifest',
  '/sw.js',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/apple-touch-icon.png'
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
  const forwarded = String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim();
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
  const hosts = [req.headers.host, req.headers['x-forwarded-host']]
    .filter(Boolean)
    .map((value) => String(value).split(',')[0].trim().toLowerCase());
  return hosts.includes(parsed.host.toLowerCase());
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

/** Only allow same-site relative redirects after login. */
function safeNextPath(value) {
  const next = String(value || '/');
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

function loginPageHtml(next, error) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Printventory Login</title>
<link rel="icon" href="/favicon.ico">
<style>
  :root { color-scheme: light dark; --bg: #f4f5f7; --card: #fff; --text: #1e1e2e; --muted: #5b6070; --accent: #0891b2; --error: #b91c1c; --border: #d6d9e0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1e1e2e; --card: #2a2a3c; --text: #e6e6ef; --muted: #a3a6b8; --accent: #22d3ee; --error: #f87171; --border: #3d3d52; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
  form { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 28px; }
  img { display: block; width: 64px; height: 64px; margin: 0 auto 12px; }
  h1 { font-size: 1.25rem; text-align: center; margin: 0 0 20px; }
  label { display: block; font-size: 0.875rem; color: var(--muted); margin-bottom: 6px; }
  input { width: 100%; padding: 10px 12px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--border); border-radius: 8px; }
  button { width: 100%; margin-top: 16px; padding: 10px; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
  .error { color: var(--error); font-size: 0.875rem; margin: 12px 0 0; }
  .hint { color: var(--muted); font-size: 0.8125rem; margin: 16px 0 0; }
</style>
</head>
<body>
<form method="post" action="/api/auth/login">
  <img src="/logo.png" alt="">
  <h1>Printventory</h1>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <button type="submit">Log in</button>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
  <p class="hint">First start: the password is in the server log, or set <code>PRINTVENTORY_PASSWORD</code>.</p>
</form>
</body>
</html>`;
}

/**
 * @param {object} deps
 * @param {(key: string) => (string|null|undefined)} deps.getSetting
 * @param {(key: string, value: string) => void} deps.setSetting
 * @param {object} [deps.env]
 * @param {{log: Function, warn: Function}} [deps.logger]
 * @param {() => number} [deps.now]
 * @param {() => string[]} [deps.extraOrigins] Origins allowed besides this server (e.g. the desktop UI).
 */
function createServerAuth({ getSetting, setSetting, env = process.env, logger = console, now = Date.now, extraOrigins = () => [] }) {
  const loginFailures = new Map();

  function signingSecret() {
    let secret = getSetting(SETTING_KEYS.signingSecret);
    if (!secret) {
      secret = randomSecret();
      setSetting(SETTING_KEYS.signingSecret, secret);
    }
    return secret;
  }

  function setPassword(password) {
    if (String(password || '').length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    setSetting(SETTING_KEYS.passwordHash, hashPassword(password));
    setSetting(SETTING_KEYS.signingSecret, randomSecret());
  }

  function verifyPassword(password) {
    const stored = getSetting(SETTING_KEYS.passwordHash);
    return !!stored && verifyPasswordHash(password, stored);
  }

  /**
   * Make sure a password exists. PRINTVENTORY_PASSWORD wins when set; otherwise a
   * random password is generated once and printed to the log.
   */
  function ensureCredentials() {
    const envPassword = env.PRINTVENTORY_PASSWORD;
    if (envPassword) {
      if (!verifyPassword(envPassword)) setPassword(envPassword);
      return { source: 'env' };
    }
    if (getSetting(SETTING_KEYS.passwordHash)) return { source: 'stored' };
    const generated = randomSecret(12);
    setPassword(generated);
    logger.warn([
      '',
      '================================================================',
      ' Printventory server password (shown once):',
      `   ${generated}`,
      ' Change it under Tools > Server Access, or set PRINTVENTORY_PASSWORD.',
      '================================================================',
      ''
    ].join('\n'));
    return { source: 'generated', password: generated };
  }

  function apiToken() {
    let token = getSetting(SETTING_KEYS.apiToken);
    if (!token) {
      token = `pv_${randomSecret()}`;
      setSetting(SETTING_KEYS.apiToken, token);
    }
    return token;
  }

  function regenerateApiToken() {
    const token = `pv_${randomSecret()}`;
    setSetting(SETTING_KEYS.apiToken, token);
    return token;
  }

  function issueDownloadToken() {
    return makeSignedToken(signingSecret(), 'dl', DOWNLOAD_TOKEN_TTL_MS, now());
  }

  function hasValidSession(req) {
    const cookie = parseCookies(req.headers && req.headers.cookie)[SESSION_COOKIE];
    return !!cookie && checkSignedToken(signingSecret(), 'session', cookie, now());
  }

  function hasValidApiToken(req) {
    const token = bearerToken(req);
    return !!token && safeEqual(token, apiToken());
  }

  function isAuthenticated(req) {
    return hasValidSession(req) || hasValidApiToken(req);
  }

  /** Download routes also accept ?token= so the slicer helper can fetch files. */
  function isDownloadAuthorized(req) {
    if (isAuthenticated(req)) return true;
    const token = req.query && typeof req.query.token === 'string' ? req.query.token : '';
    return !!token && checkSignedToken(signingSecret(), 'dl', token, now());
  }

  function sessionCookie(req, value, maxAgeMs) {
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`
    ];
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

  /** Express middleware: everything except PUBLIC_PATHS needs a session or API token. */
  function requireAuth(req, res, next) {
    if (isPublicPath(req.path)) return next();
    if (isDownloadPath(req.path) ? isDownloadAuthorized(req) : isAuthenticated(req)) return next();
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
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID');
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
    if (!isAuthenticated(req)) return { ok: false, status: 401, reason: 'Login required' };
    return { ok: true };
  }

  function registerRoutes(app, express) {
    const form = express.urlencoded({ extended: false, limit: '10kb' });

    app.get('/login', (req, res) => {
      if (hasValidSession(req)) {
        res.redirect(302, safeNextPath(req.query.next));
        return;
      }
      res.type('html').send(loginPageHtml(safeNextPath(req.query.next), req.query.error ? 'Wrong password.' : ''));
    });

    app.post('/api/auth/login', form, express.json({ limit: '10kb' }), (req, res) => {
      const body = req.body || {};
      const next = safeNextPath(body.next);
      const isForm = !String(req.headers['content-type'] || '').includes('application/json');
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

      if (loginBlocked(ip)) {
        if (isForm) {
          res.status(429).type('html').send(loginPageHtml(next, 'Too many attempts. Try again in 15 minutes.'));
        } else {
          res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
        }
        return;
      }
      if (!verifyPassword(body.password)) {
        recordLoginFailure(ip);
        if (isForm) {
          res.redirect(303, `/login?error=1&next=${encodeURIComponent(next)}`);
        } else {
          res.status(401).json({ error: 'Wrong password' });
        }
        return;
      }
      loginFailures.delete(ip);
      res.setHeader('Set-Cookie', sessionCookie(req, makeSignedToken(signingSecret(), 'session', SESSION_TTL_MS, now()), SESSION_TTL_MS));
      if (isForm) {
        res.redirect(303, next);
      } else {
        res.json({ success: true });
      }
    });

    app.post('/api/auth/logout', (req, res) => {
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
      res.json({ success: true });
    });

    app.get('/api/auth/status', (req, res) => {
      res.json({ authenticated: isAuthenticated(req) });
    });
  }

  return {
    ensureCredentials,
    setPassword,
    verifyPassword,
    apiToken,
    regenerateApiToken,
    issueDownloadToken,
    isAuthenticated,
    isDownloadAuthorized,
    requireAuth,
    cors,
    rejectForeignOrigins,
    verifyUpgrade,
    registerRoutes
  };
}

module.exports = {
  SESSION_COOKIE,
  SETTING_KEYS,
  SECRET_SETTING_KEYS,
  MIN_PASSWORD_LENGTH,
  createServerAuth,
  hashPassword,
  verifyPasswordHash,
  originAllowed,
  parseCookies,
  safeNextPath
};
