'use strict';

/**
 * Fast model lists on large libraries (9.7). A model's pictures (base64 data URLs, often several
 * hundred KB) live in models.thumbnail. SQLite stores a row's columns in order, so reading any
 * column stored after a large picture (title, size, license, date added, rating, …) walks through
 * that picture first: on a 2,000-model library a page of the Library took ~100 ms, a search or a
 * sort by name ~120 ms, growing with the library.
 *
 * - thumbnail is kept as the last column of models: the table is rebuilt once when it is not (also
 *   after a later version adds a column, which SQLite puts at the end).
 * - has_thumb and multi_thumb say whether a model has a picture and several, kept by triggers on
 *   every write, so lists do not read the pictures for that either.
 * - idx_models_thumbnail, an index that held a second copy of every picture, is dropped.
 *
 * Old versions still work with the table (same columns, two more).
 */

const fs = require('fs');
const path = require('path');

/** A picture is set: not empty and not the "render one" placeholder. */
const HAS = (col) => `(CASE WHEN ${col} IS NOT NULL AND ${col} != '' AND ${col} != '3d.png' THEN 1 ELSE 0 END)`;
/** Several pictures, joined with '::'. */
const MULTI = (col) => `(CASE WHEN ${col} IS NOT NULL AND INSTR(${col}, '::') > 0 THEN 1 ELSE 0 END)`;

/** @type {[string, string, (col: string) => string][]} */
const FLAGS = [
  ['has_thumb', 'INTEGER NOT NULL DEFAULT 0', HAS],
  ['multi_thumb', 'INTEGER NOT NULL DEFAULT 0', MULTI]
];
const TABLE_CONSTRAINT = /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i;

/** The column definitions of a CREATE TABLE statement, split at its top-level commas. */
function columnDefinitions(createSql) {
  const start = createSql.indexOf('(');
  const end = createSql.lastIndexOf(')');
  const body = createSql.slice(start + 1, end);
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const char of body) {
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === "'" || char === '"' || char === '`' || char === '[') {
      quote = char === '[' ? ']' : char;
    } else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const nameOf = (definition) => definition.replace(/^["`[]?([^"`\]\s]+)["`\]]?[\s\S]*$/, '$1');

/** Whether the table already has the flags and keeps thumbnail last. */
function inShape(db) {
  const columns = db.prepare('PRAGMA table_info(models)').all();
  if (!columns.length) return true;
  const names = columns.map((c) => c.name);
  return names[names.length - 1] === 'thumbnail' && FLAGS.every(([name]) => names.includes(name));
}

/** The triggers that keep has_thumb and multi_thumb right on every insert and picture change. */
function ensureFlagTriggers(db) {
  const set = FLAGS.map(([name, , expr]) => `${name} = ${expr('NEW.thumbnail')}`).join(', ');
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS models_thumb_flags_insert AFTER INSERT ON models
      BEGIN UPDATE models SET ${set} WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS models_thumb_flags_update AFTER UPDATE OF thumbnail ON models
      WHEN OLD.thumbnail IS NOT NEW.thumbnail
      BEGIN UPDATE models SET ${set} WHERE id = NEW.id; END;
  `);
}

/** Bytes free on the disk that holds the database (Infinity when unknown). */
function freeDiskBytes(dbPath) {
  try {
    const stats = fs.statfsSync(path.dirname(dbPath));
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (_) {
    return Infinity;
  }
}

/**
 * Bring the models table into shape (see the top). Safe to call on every start: it only rebuilds
 * when needed. Returns 'ok' (nothing to do), 'rebuilt', or 'skipped' (not enough free disk space;
 * the old layout keeps working, only slower).
 * @param {import('better-sqlite3').Database} db
 * @param {{ dbPath?: string, log?: (message: string) => void, freeBytes?: number }} [options]
 */
function ensureThumbnailLast(db, { dbPath = '', log = (message) => console.log(message), freeBytes } = {}) {
  db.exec('DROP INDEX IF EXISTS idx_models_thumbnail');
  const exists = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'models'").get();
  if (!exists) return 'ok';
  if (inShape(db)) {
    ensureFlagTriggers(db);
    return 'ok';
  }

  // Room for a copy of the table: what is in use, less the pages free inside the file already.
  const pageSize = db.pragma('page_size', { simple: true });
  const pages = db.pragma('page_count', { simple: true });
  const freePages = db.pragma('freelist_count', { simple: true });
  const needed = (pages - freePages) * pageSize - freePages * pageSize;
  const available = freeBytes ?? (dbPath ? freeDiskBytes(dbPath) : Infinity);
  if (needed > 0 && available < needed * 1.05) {
    log(
      `[Database] Not enough free disk space to reorganize the models table (needs about ${Math.round(needed / 1048576)} MB, ${Math.round(available / 1048576)} MB free). Lists stay slower on a large library until there is room.`
    );
    ensureFlagTriggersIfColumns(db);
    return 'skipped';
  }

  const started = Date.now();
  log('[Database] Reorganizing the models table so lists and searches stay fast (once; can take a few minutes on a large library)...');
  const definitions = columnDefinitions(exists.sql);
  const constraints = definitions.filter((d) => TABLE_CONSTRAINT.test(d));
  const columns = definitions.filter((d) => !TABLE_CONSTRAINT.test(d));
  const thumbnailDef = columns.find((d) => nameOf(d) === 'thumbnail') || 'thumbnail TEXT';
  const others = columns.filter((d) => nameOf(d) !== 'thumbnail' && !FLAGS.some(([name]) => nameOf(d) === name));
  const flagDefs = FLAGS.map(([name, type]) => `${name} ${type}`);
  const copied = others.map(nameOf);

  const dependents = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'models' AND type IN ('index', 'trigger') AND sql IS NOT NULL")
    .all()
    .filter((row) => row.name !== 'idx_models_thumbnail');
  // The id counter (AUTOINCREMENT), when the database has one.
  const hasSequence = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get();
  const sequence = hasSequence ? db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'models'").get() : null;

  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS models_reorganized');
      db.exec(`CREATE TABLE models_reorganized (\n  ${[...others, ...flagDefs, thumbnailDef, ...constraints].join(',\n  ')}\n)`);
      db.exec(
        `INSERT INTO models_reorganized (${[...copied, ...FLAGS.map(([name]) => name), 'thumbnail'].join(', ')})
         SELECT ${[...copied, ...FLAGS.map(([, , expr]) => expr('thumbnail')), 'thumbnail'].join(', ')} FROM models`
      );
      db.exec('DROP TABLE models');
      db.exec('ALTER TABLE models_reorganized RENAME TO models');
      for (const row of dependents) db.exec(row.sql);
      if (sequence) db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'models'").run(sequence.seq);
      ensureFlagTriggers(db);
    })();
  } finally {
    db.pragma('legacy_alter_table = OFF');
    if (foreignKeys) db.pragma('foreign_keys = ON');
  }
  log(`[Database] Models table reorganized in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  return 'rebuilt';
}

/** Without room to rebuild: add the flags at the end (still cheaper than reading the pictures) and their triggers. */
function ensureFlagTriggersIfColumns(db) {
  const names = db
    .prepare('PRAGMA table_info(models)')
    .all()
    .map((c) => c.name);
  for (const [name, type, expr] of FLAGS) {
    if (names.includes(name)) continue;
    db.exec(`ALTER TABLE models ADD COLUMN ${name} ${type}`);
    db.exec(`UPDATE models SET ${name} = ${expr('thumbnail')}`);
  }
  ensureFlagTriggers(db);
}

module.exports = { ensureThumbnailLast, columnDefinitions, inShape, HAS, MULTI };
