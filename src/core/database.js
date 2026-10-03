'use strict';

/**
 * The open SQLite connection (better-sqlite3), shared by every module.
 * It is replaced when a backup is restored, so read `database.db` each time
 * instead of keeping your own reference.
 */
module.exports = { db: null };
