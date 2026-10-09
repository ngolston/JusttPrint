'use strict';

/**
 * The open SQLite connection (better-sqlite3), shared by every module.
 * It is replaced when a backup is restored, so read `database.db` each time
 * instead of keeping your own reference.
 */
// better-sqlite3 has no type definitions, so the connection is `any`; typed so `db` is never null to the checker.
/** @type {{ db: any }} */
module.exports = { db: null };
