'use strict';

/**
 * User accounts: who may log in, and what each role may do.
 *
 * - viewer: browse, preview and download.
 * - editor: also change the library (metadata, tags, uploads, moves, print log).
 * - admin: also settings, server access, backups and the accounts themselves.
 *
 * Deleting files from disk is for admins, and for the editors an admin allows it
 * (can_delete_files); everyone else who may change the library removes models from it instead.
 *
 * Two stores share one interface: SQLite (the `users` table, made on first use so a restored
 * older database gets it too) and memory (tests). Each user has a random session key that
 * signs their session cookies; replacing it logs that user out everywhere.
 */

const crypto = require('crypto');

const ROLES = ['viewer', 'editor', 'admin'];
const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 };
const ROLE_LABELS = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' };
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

function isRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, role);
}

/** True when `role` is at least `required` (viewer < editor < admin). */
function roleAllows(role, required) {
  return isRole(role) && isRole(required) && ROLE_RANK[role] >= ROLE_RANK[required];
}

function newSessionKey() {
  return crypto.randomBytes(16).toString('base64url');
}

/** True when the user may delete files from disk: an admin, or an editor allowed to. */
function canDeleteFiles(user) {
  if (!user || !isRole(user.role)) return false;
  return user.role === 'admin' || (user.role === 'editor' && !!(user.canDeleteFiles ?? user.can_delete_files));
}

/** What the API hands out about a user: never the hash or session key. */
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    canDeleteFiles: canDeleteFiles(row),
    createdAt: row.created_at || null,
    lastLoginAt: row.last_login_at || null,
    twoFactor: !!row.totp_enabled
  };
}

const COLUMNS =
  'id, username, password_hash, role, can_delete_files, session_key, created_at, last_login_at, totp_secret, totp_enabled, totp_last_step, recovery_codes';

/**
 * The account fields `update` changes (10.2 adds two-factor sign-in: docs/plan-10.1.md, Phase 12).
 * @typedef {{ passwordHash?: string, role?: string, canDeleteFiles?: boolean, resetSessions?: boolean, totpSecret?: string | null, totpEnabled?: boolean, totpLastStep?: number | null, recoveryCodes?: string[] | null }} UserChanges
 */

/** @param {() => import('better-sqlite3').Database} getDb */
function createSqliteUserStore(getDb) {
  let readyDb = null;

  function db() {
    const current = getDb();
    if (!current || !current.open) throw new Error('The database is not open');
    if (readyDb !== current) {
      current
        .prepare(
          `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        session_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      )`
        )
        .run();
      const columns = current.prepare('PRAGMA table_info(users)').all();
      if (!columns.some((column) => column.name === 'can_delete_files')) {
        current.prepare('ALTER TABLE users ADD COLUMN can_delete_files INTEGER NOT NULL DEFAULT 0').run();
      }
      // Two-factor sign-in, the sessions and the API keys of each account (10.2).
      for (const [column, definition] of [
        ['totp_secret', 'TEXT'],
        ['totp_enabled', 'INTEGER NOT NULL DEFAULT 0'],
        ['totp_last_step', 'INTEGER'],
        ['recovery_codes', 'TEXT']
      ]) {
        if (!columns.some((c) => c.name === column)) current.prepare(`ALTER TABLE users ADD COLUMN ${column} ${definition}`).run();
      }
      current.exec(`CREATE TABLE IF NOT EXISTS user_sessions (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          user_agent TEXT,
          ip TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
        CREATE TABLE IF NOT EXISTS user_api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          prefix TEXT NOT NULL,
          hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          last_used_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_user_api_keys_user ON user_api_keys(user_id);`);
      readyDb = current;
    }
    return current;
  }

  return {
    count: () => db().prepare('SELECT COUNT(*) AS n FROM users').get().n,
    countRole: (role) => db().prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get(role).n,
    list: () => db().prepare(`SELECT ${COLUMNS} FROM users ORDER BY username COLLATE NOCASE`).all(),
    findById: (id) => db().prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) || null,
    findByName: (username) => db().prepare(`SELECT ${COLUMNS} FROM users WHERE username = ? COLLATE NOCASE`).get(String(username)) || null,
    insert({ username, passwordHash, role, canDeleteFiles = false, now }) {
      const info = db()
        .prepare('INSERT INTO users (username, password_hash, role, can_delete_files, session_key, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(username, passwordHash, role, canDeleteFiles ? 1 : 0, newSessionKey(), now);
      return Number(info.lastInsertRowid);
    },
    /**
     * @param {number} id
     * @param {UserChanges} changes
     */
    update(id, { passwordHash, role, canDeleteFiles, resetSessions, totpSecret, totpEnabled, totpLastStep, recoveryCodes }) {
      const sets = [];
      const values = [];
      if (totpSecret !== undefined) {
        sets.push('totp_secret = ?');
        values.push(totpSecret);
      }
      if (typeof totpEnabled === 'boolean') {
        sets.push('totp_enabled = ?');
        values.push(totpEnabled ? 1 : 0);
      }
      if (totpLastStep !== undefined) {
        sets.push('totp_last_step = ?');
        values.push(totpLastStep);
      }
      if (recoveryCodes !== undefined) {
        sets.push('recovery_codes = ?');
        values.push(recoveryCodes ? JSON.stringify(recoveryCodes) : null);
      }
      if (passwordHash) {
        sets.push('password_hash = ?');
        values.push(passwordHash);
      }
      if (role) {
        sets.push('role = ?');
        values.push(role);
      }
      if (typeof canDeleteFiles === 'boolean') {
        sets.push('can_delete_files = ?');
        values.push(canDeleteFiles ? 1 : 0);
      }
      if (resetSessions) {
        sets.push('session_key = ?');
        values.push(newSessionKey());
      }
      if (!sets.length) return;
      db()
        .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
        .run(...values, id);
    },
    touchLogin: (id, now) => {
      db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, id);
    },
    remove: (id) => {
      db().prepare('DELETE FROM user_sessions WHERE user_id = ?').run(id);
      db().prepare('DELETE FROM user_api_keys WHERE user_id = ?').run(id);
      db().prepare('DELETE FROM users WHERE id = ?').run(id);
    },
    // Sessions: each sign-in, so an account can see and end them (10.2).
    createSession: ({ id, userId, createdAt, expiresAt, userAgent, ip }) => {
      db()
        .prepare('INSERT INTO user_sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, userId, createdAt, createdAt, expiresAt, userAgent || null, ip || null);
    },
    findSession: (id) => db().prepare('SELECT * FROM user_sessions WHERE id = ?').get(String(id)) || null,
    touchSession: (id, at) => {
      db().prepare('UPDATE user_sessions SET last_seen_at = ? WHERE id = ?').run(at, String(id));
    },
    listSessions: (userId) => db().prepare('SELECT * FROM user_sessions WHERE user_id = ? ORDER BY last_seen_at DESC').all(userId),
    deleteSession: (userId, id) => db().prepare('DELETE FROM user_sessions WHERE user_id = ? AND id = ?').run(userId, String(id)).changes > 0,
    deleteSessions: (userId, exceptId = null) =>
      db()
        .prepare('DELETE FROM user_sessions WHERE user_id = ? AND id != ?')
        .run(userId, String(exceptId || '')).changes,
    pruneSessions: (now) => {
      db().prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(now);
    },
    // API keys of each account, kept as hashes (10.2).
    createApiKey: ({ userId, name, role, prefix, hash, createdAt }) =>
      Number(
        db()
          .prepare('INSERT INTO user_api_keys (user_id, name, role, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(userId, name, role, prefix, hash, createdAt).lastInsertRowid
      ),
    findApiKeyByHash: (hash) => db().prepare('SELECT * FROM user_api_keys WHERE hash = ?').get(hash) || null,
    listApiKeys: (userId) =>
      db().prepare('SELECT id, user_id, name, role, prefix, created_at, last_used_at FROM user_api_keys WHERE user_id = ? ORDER BY id').all(userId),
    deleteApiKey: (userId, id) => db().prepare('DELETE FROM user_api_keys WHERE user_id = ? AND id = ?').run(userId, Number(id)).changes > 0,
    touchApiKey: (id, at) => {
      db().prepare('UPDATE user_api_keys SET last_used_at = ? WHERE id = ?').run(at, id);
    }
  };
}

function createMemoryUserStore() {
  const rows = new Map();
  const sessions = new Map();
  const apiKeys = new Map();
  let nextId = 1;
  let nextKeyId = 1;
  const byName = (username) => [...rows.values()].find((row) => row.username.toLowerCase() === String(username).toLowerCase()) || null;
  const copy = (row) => (row ? { ...row } : null);
  return {
    count: () => rows.size,
    countRole: (role) => [...rows.values()].filter((row) => row.role === role).length,
    list: () => [...rows.values()].map(copy).sort((a, b) => a.username.localeCompare(b.username)),
    findById: (id) => copy(rows.get(Number(id))),
    findByName: (username) => copy(byName(username)),
    insert({ username, passwordHash, role, canDeleteFiles = false, now }) {
      if (byName(username)) throw new Error('UNIQUE constraint failed: users.username');
      const id = nextId++;
      rows.set(id, {
        id,
        username,
        password_hash: passwordHash,
        role,
        can_delete_files: canDeleteFiles ? 1 : 0,
        session_key: newSessionKey(),
        created_at: now,
        last_login_at: null,
        totp_secret: null,
        totp_enabled: 0,
        totp_last_step: null,
        recovery_codes: null
      });
      return id;
    },
    /**
     * @param {number} id
     * @param {UserChanges} changes
     */
    update(id, { passwordHash, role, canDeleteFiles, resetSessions, totpSecret, totpEnabled, totpLastStep, recoveryCodes }) {
      const row = rows.get(Number(id));
      if (!row) return;
      if (totpSecret !== undefined) row.totp_secret = totpSecret;
      if (typeof totpEnabled === 'boolean') row.totp_enabled = totpEnabled ? 1 : 0;
      if (totpLastStep !== undefined) row.totp_last_step = totpLastStep;
      if (recoveryCodes !== undefined) row.recovery_codes = recoveryCodes ? JSON.stringify(recoveryCodes) : null;
      if (passwordHash) row.password_hash = passwordHash;
      if (role) row.role = role;
      if (typeof canDeleteFiles === 'boolean') row.can_delete_files = canDeleteFiles ? 1 : 0;
      if (resetSessions) row.session_key = newSessionKey();
    },
    touchLogin: (id, now) => {
      const row = rows.get(Number(id));
      if (row) row.last_login_at = now;
    },
    remove: (id) => {
      rows.delete(Number(id));
      for (const [key, session] of sessions) if (session.user_id === Number(id)) sessions.delete(key);
      for (const [key, apiKey] of apiKeys) if (apiKey.user_id === Number(id)) apiKeys.delete(key);
    },
    createSession: ({ id, userId, createdAt, expiresAt, userAgent, ip }) => {
      sessions.set(String(id), {
        id: String(id),
        user_id: userId,
        created_at: createdAt,
        last_seen_at: createdAt,
        expires_at: expiresAt,
        user_agent: userAgent || null,
        ip: ip || null
      });
    },
    findSession: (id) => (sessions.has(String(id)) ? { ...sessions.get(String(id)) } : null),
    touchSession: (id, at) => {
      const session = sessions.get(String(id));
      if (session) session.last_seen_at = at;
    },
    listSessions: (userId) =>
      [...sessions.values()]
        .filter((s) => s.user_id === userId)
        .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
        .map((s) => ({ ...s })),
    deleteSession: (userId, id) => {
      const session = sessions.get(String(id));
      if (!session || session.user_id !== userId) return false;
      sessions.delete(String(id));
      return true;
    },
    deleteSessions: (userId, exceptId = null) => {
      let n = 0;
      for (const [key, session] of sessions) {
        if (session.user_id === userId && key !== String(exceptId || '')) {
          sessions.delete(key);
          n += 1;
        }
      }
      return n;
    },
    pruneSessions: (now) => {
      for (const [key, session] of sessions) if (session.expires_at < now) sessions.delete(key);
    },
    createApiKey: ({ userId, name, role, prefix, hash, createdAt }) => {
      const id = nextKeyId++;
      apiKeys.set(id, { id, user_id: userId, name, role, prefix, hash, created_at: createdAt, last_used_at: null });
      return id;
    },
    findApiKeyByHash: (hash) => {
      const found = [...apiKeys.values()].find((k) => k.hash === hash);
      return found ? { ...found } : null;
    },
    listApiKeys: (userId) => [...apiKeys.values()].filter((k) => k.user_id === userId).map(({ hash: _hash, ...k }) => ({ ...k })),
    deleteApiKey: (userId, id) => {
      const key = apiKeys.get(Number(id));
      if (!key || key.user_id !== userId) return false;
      apiKeys.delete(Number(id));
      return true;
    },
    touchApiKey: (id, at) => {
      const key = apiKeys.get(Number(id));
      if (key) key.last_used_at = at;
    }
  };
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  USERNAME_PATTERN,
  isRole,
  roleAllows,
  canDeleteFiles,
  publicUser,
  createSqliteUserStore,
  createMemoryUserStore
};
