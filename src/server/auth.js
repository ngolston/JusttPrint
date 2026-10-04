'use strict';

const database = require('../core/database');
const { getSettingValueOr } = require('../core/settings');
const { createServerAuth } = require('./server-auth');

let serverAuth = null;

/** Login, API token and download tokens for the HTTP/WebSocket server. */
function getServerAuth() {
  if (!serverAuth) {
    serverAuth = createServerAuth({
      getSetting: (key) => getSettingValueOr(key, null),
      setSetting: (key, value) => {
        database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
      },
      extraOrigins: () => {
        const origins = String(process.env.JUSTTPRINT_ALLOWED_ORIGINS || '')
          .split(',').map((origin) => origin.trim()).filter(Boolean);
        return origins;
      }
    });
  }
  return serverAuth;
}

module.exports = { getServerAuth };
