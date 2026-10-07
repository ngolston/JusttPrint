'use strict';

/**
 * User accounts: who may log in, and what each role may do.
 *
 * - viewer: browse, preview and download.
 * - editor: also change the library (metadata, tags, uploads, moves, print log).
 * - admin: also settings, server access, backups and the accounts themselves.
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

/** What the API hands out about a user: never the hash or session key. */
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.created_at || null,
    lastLoginAt: row.last_login_at || null
  };
}

const COLUMNS = 'id, username, password_hash, role, session_key, created_at, last_login_at';

/** @param {() => import('better-sqlite3').Database} getDb */
function createSqliteUserStore(getDb) {
  let readyDb = null;

  function db() {
    const current = getDb();
    if (!current || !current.open) throw new Error('The database is not open');
    if (readyDb !== current) {
      current.prepare(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        session_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      )`).run();
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
    insert({ username, passwordHash, role, now }) {
      const info = db().prepare('INSERT INTO users (username, password_hash, role, session_key, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(username, passwordHash, role, newSessionKey(), now);
      return Number(info.lastInsertRowid);
    },
    update(id, { passwordHash, role, resetSessions }) {
      const sets = [];
      const values = [];
      if (passwordHash) { sets.push('password_hash = ?'); values.push(passwordHash); }
      if (role) { sets.push('role = ?'); values.push(role); }
      if (resetSessions) { sets.push('session_key = ?'); values.push(newSessionKey()); }
      if (!sets.length) return;
      db().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    },
    touchLogin: (id, now) => { db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, id); },
    remove: (id) => { db().prepare('DELETE FROM users WHERE id = ?').run(id); }
  };
}

function createMemoryUserStore() {
  const rows = new Map();
  let nextId = 1;
  const byName = (username) => [...rows.values()].find((row) => row.username.toLowerCase() === String(username).toLowerCase()) || null;
  const copy = (row) => (row ? { ...row } : null);
  return {
    count: () => rows.size,
    countRole: (role) => [...rows.values()].filter((row) => row.role === role).length,
    list: () => [...rows.values()].map(copy).sort((a, b) => a.username.localeCompare(b.username)),
    findById: (id) => copy(rows.get(Number(id))),
    findByName: (username) => copy(byName(username)),
    insert({ username, passwordHash, role, now }) {
      if (byName(username)) throw new Error('UNIQUE constraint failed: users.username');
      const id = nextId++;
      rows.set(id, { id, username, password_hash: passwordHash, role, session_key: newSessionKey(), created_at: now, last_login_at: null });
      return id;
    },
    update(id, { passwordHash, role, resetSessions }) {
      const row = rows.get(Number(id));
      if (!row) return;
      if (passwordHash) row.password_hash = passwordHash;
      if (role) row.role = role;
      if (resetSessions) row.session_key = newSessionKey();
    },
    touchLogin: (id, now) => { const row = rows.get(Number(id)); if (row) row.last_login_at = now; },
    remove: (id) => { rows.delete(Number(id)); }
  };
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  USERNAME_PATTERN,
  isRole,
  roleAllows,
  publicUser,
  createSqliteUserStore,
  createMemoryUserStore
};
