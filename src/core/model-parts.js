'use strict';

/**
 * Parts: model files that belong to another model (models.partOf, its id), such as files uploaded
 * on a model's page. They are listed on their model's page, not in the library's lists.
 */

const known = new WeakMap();

/** Whether this database has models.partOf (a test's own table may not). */
function hasPartOf(db) {
  if (!known.has(db)) {
    let found = false;
    try {
      found = db
        .prepare('PRAGMA table_info(models)')
        .all()
        .some((column) => column.name === 'partOf');
    } catch (_) {
      /* no models table */
    }
    // Only remember a yes: the column may be added later (db-init.js).
    if (!found) return false;
    known.set(db, true);
  }
  return true;
}

/** SQL for "not a part", for the library's lists and counts. */
const notPartSql = (db, column = 'partOf') => (hasPartOf(db) ? `${column} IS NULL` : '1 = 1');

module.exports = { hasPartOf, notPartSql };
