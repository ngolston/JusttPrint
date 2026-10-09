'use strict';

const database = require('../core/database');
const { createServerAuth } = require('./server-auth');
const { createSqliteUserStore } = require('./users');

/** @type {ReturnType<typeof createServerAuth> | null} */
let serverAuth = null;

/**
 * Logins, user accounts, API token and download tokens for the HTTP/WebSocket server.
 * @returns {ReturnType<typeof createServerAuth>}
 */
function getServerAuth() {
  if (!serverAuth) {
    serverAuth = createServerAuth({
      // Unlike other settings, a closed database (during a restore) is an error here, not
      // "not set": otherwise a missing signing secret would be regenerated and log everyone out.
      getSetting: (key) => {
        if (!database.db || !database.db.open) throw new Error('The database is not open');
        const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row && row.value != null && row.value !== '' ? row.value : null;
      },
      setSetting: (key, value) => {
        database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
      },
      users: createSqliteUserStore(() => database.db),
      extraOrigins: () => {
        const origins = String(process.env.JUSTTPRINT_ALLOWED_ORIGINS || '')
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean);
        return origins;
      }
    });
  }
  return serverAuth;
}

module.exports = { getServerAuth };
