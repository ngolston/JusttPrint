'use strict';

/**
 * A copy of the database before a major upgrade changes it (docs/merge-10.md, Phase 2): the first
 * time JusttPrint 10 opens a 9.x database, before any 10.0 table is added. The copy goes into the
 * automatic backups' folder as justtprint-before-<version>-<UTC time>.db. Automatic backups never
 * prune it (their pattern is justtprint-auto-…), and Settings → Backup can restore it like any
 * other backup file.
 */

const fs = require('fs');
const path = require('path');
const { checkBackupFile } = require('./backup-check');

/** justtprint-before-10.0-20261030-061500.db */
function upgradeBackupName(label, date = new Date()) {
  const iso = date.toISOString();
  return `justtprint-before-${label}-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}.db`;
}

/**
 * Does the database need the upgrade backup? Only an existing library (a models table) that has
 * not been upgraded yet (no `marker` table). A new, empty database has nothing to lose.
 */
function needsUpgradeBackup(db, marker) {
  const has = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return has('models') && !has(marker);
}

/**
 * Copy the open database into `directory` (VACUUM INTO: consistent, synchronous, checked before it
 * is kept). Returns the file's path. Throws when the copy cannot be made; the caller decides
 * whether to go on.
 */
function writeUpgradeBackup(db, directory, label, date = new Date()) {
  fs.mkdirSync(directory, { recursive: true });
  let name = upgradeBackupName(label, date);
  for (let n = 1; fs.existsSync(path.join(directory, name)); n++) name = upgradeBackupName(label, date).replace(/\.db$/, `-${n}.db`);
  const target = path.join(directory, name);
  const partial = `${target}.partial`;
  try {
    fs.rmSync(partial, { force: true });
    db.prepare('VACUUM INTO ?').run(partial);
    checkBackupFile(partial);
    fs.renameSync(partial, target);
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  return target;
}

module.exports = { upgradeBackupName, needsUpgradeBackup, writeUpgradeBackup };
