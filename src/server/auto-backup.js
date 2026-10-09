'use strict';

/**
 * Automatic database backups (Settings → Backup). Off until switched on. Every N hours the
 * server copies the live database with SQLite's online backup into a folder (default: backups/
 * on the data volume), checks the copy, then keeps only the newest K automatic backups. Only
 * files named like justtprint-auto-<UTC time>.db are ever deleted.
 */

const fs = require('fs');
const path = require('path');
const database = require('../core/database');
const { checkBackupFile } = require('../core/backup-check');
const { ENV_SETTINGS } = require('../core/env-settings');
const { getSettingValueOr, persistSetting } = require('../core/settings');
const { app } = require('./runtime');
const { isInsideOrSame, isSystemDirectory } = require('./server-paths');

const AUTO_BACKUP_FILE = /^justtprint-auto-\d{8}-\d{6}(-\d+)?\.db$/;
const PARTIAL_SUFFIX = '.partial';
const HOUR = 60 * 60 * 1000;
/** Wait this long after the server starts before an overdue backup, so startup work goes first. */
const STARTUP_DELAY_MS = 2 * 60 * 1000;
/** After a failed backup, try again after this long (or the interval, if shorter). */
const RETRY_MS = HOUR;
/** Timers are re-armed at least this often (setTimeout cannot wait more than ~24 days). */
const MAX_TIMER_MS = 6 * HOUR;

const SETTING_KEYS = ['autoBackupEnabled', 'autoBackupIntervalHours', 'autoBackupKeep', 'autoBackupDirectory'];
const DEFAULTS = { intervalHours: 24, keep: 7 };

/** justtprint-auto-20261007-030000.db (UTC, so names sort by time). */
function backupFileName(date) {
  const iso = new Date(date).toISOString();
  return `justtprint-auto-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}.db`;
}

/** The automatic backups in a folder, newest first. Other files are never listed. */
function listBackups(dir, fileSystem = fs) {
  let names;
  try {
    names = fileSystem.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const backups = [];
  for (const name of names) {
    if (!AUTO_BACKUP_FILE.test(name)) continue;
    try {
      const stat = fileSystem.statSync(path.join(dir, name));
      if (stat.isFile()) backups.push({ name, path: path.join(dir, name), size: stat.size, date: stat.mtime.toISOString() });
    } catch (_) {
      /* removed meanwhile */
    }
  }
  return backups.sort((a, b) => {
    const [stampA, countA] = sortKey(a.name);
    const [stampB, countB] = sortKey(b.name);
    return stampA === stampB ? countB - countA : stampA < stampB ? 1 : -1;
  });
}

/** Time stamp and same-second counter (…-030405.db is 0, …-030405-1.db is 1). */
function sortKey(name) {
  const match = /^justtprint-auto-(\d{8}-\d{6})(?:-(\d+))?\.db$/.exec(name);
  return match ? [match[1], Number(match[2] || 0)] : ['', 0];
}

/** Delete automatic backups beyond the newest `keep`. Returns the deleted names. */
function pruneBackups(dir, keep, fileSystem = fs) {
  const removed = [];
  for (const backup of listBackups(dir, fileSystem).slice(Math.max(1, keep))) {
    try {
      fileSystem.rmSync(backup.path, { force: true });
      removed.push(backup.name);
    } catch (error) {
      console.warn(`[Backup] Could not delete old backup ${backup.name}:`, error.message);
    }
  }
  return removed;
}

/** When an automatic backup was taken, from its name (ms since epoch), or NaN. */
function backupTime(name) {
  const match = /^justtprint-auto-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(name || ''));
  return match ? Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`) : NaN;
}

/**
 * When the next backup is due (ms since epoch), or null when they are off. Counted from the
 * newest backup in the folder, so a new or emptied folder gets one right away. After a failure:
 * in an hour (or the interval, if shorter).
 */
function nextRunAt({ enabled, intervalHours, newestBackup, lastAttempt, lastError }) {
  if (!enabled) return null;
  const interval = Math.max(1, Number(intervalHours) || DEFAULTS.intervalHours) * HOUR;
  const success = Date.parse(newestBackup || '');
  const attempt = Date.parse(lastAttempt || '');
  const due = Number.isFinite(success) ? success + interval : 0;
  if (lastError && Number.isFinite(attempt) && (!Number.isFinite(success) || attempt > success)) {
    return Math.max(due, attempt + Math.min(interval, RETRY_MS));
  }
  return due;
}

/**
 * Why a folder cannot hold backups, or '' when it can. The data folder is fine (in Docker it is
 * under /root, a system folder); other system folders and the app folder are not.
 */
function folderProblem(dir, { appDir = '', dataDir = '' } = {}) {
  const text = String(dir || '');
  if (!text.startsWith('/')) return `Use an absolute folder path, such as /mnt/backups (got "${text}").`;
  if (dataDir && isInsideOrSame(text, dataDir)) return '';
  if (isSystemDirectory(text)) return `Backups cannot go into the system folder ${text}.`;
  if (appDir && isInsideOrSame(text, appDir)) return 'Backups cannot go into the app folder.';
  return '';
}

const appDir = path.join(__dirname, '..', '..');

function defaultDirectory() {
  return path.join(app.getPath('userData'), 'backups');
}

/** Settings with defaults, the folder resolved, and which ones the container's environment sets. */
function readConfig() {
  const keep = parseInt(getSettingValueOr('autoBackupKeep', ''), 10);
  const hours = parseInt(getSettingValueOr('autoBackupIntervalHours', ''), 10);
  const directorySetting = String(getSettingValueOr('autoBackupDirectory', '')).trim();
  const envKeys = new Set(ENV_SETTINGS.filter(([name]) => String(process.env[name] || '').trim()).map(([, key]) => key));
  return {
    enabled: getSettingValueOr('autoBackupEnabled', '0') === '1',
    intervalHours: hours > 0 ? hours : DEFAULTS.intervalHours,
    keep: keep > 0 ? keep : DEFAULTS.keep,
    directory: directorySetting || defaultDirectory(),
    customDirectory: directorySetting,
    defaultDirectory: defaultDirectory(),
    lastRun: getSettingValueOr('autoBackupLastRun', ''),
    newestBackup: newestBackupDate(directorySetting || defaultDirectory()),
    lastAttempt: getSettingValueOr('autoBackupLastAttempt', ''),
    lastError: getSettingValueOr('autoBackupLastError', ''),
    setByEnvironment: SETTING_KEYS.filter((key) => envKeys.has(key))
  };
}

function newestBackupDate(dir) {
  const time = backupTime(listBackups(dir)[0]?.name);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

let running = null;
let timer = null;

/** Back up now. Resolves to { success, backup?, removed?, message? }; never runs two at once. */
function runBackup(reason = 'manual') {
  if (running) return running;
  running = (async () => {
    const config = readConfig();
    const started = new Date();
    try {
      persistSetting('autoBackupLastAttempt', started.toISOString());
      const problem = folderProblem(config.directory, { appDir, dataDir: app.getPath('userData') });
      if (problem) throw new Error(problem);
      if (!database.db || !database.db.open) throw new Error('The database is not open.');
      await fs.promises.mkdir(config.directory, { recursive: true });
      // A stopped container can leave an unfinished copy behind.
      for (const name of await fs.promises.readdir(config.directory)) {
        if (name.endsWith(PARTIAL_SUFFIX) && AUTO_BACKUP_FILE.test(name.slice(0, -PARTIAL_SUFFIX.length))) {
          await fs.promises.rm(path.join(config.directory, name), { force: true });
        }
      }
      let name = backupFileName(started);
      for (let n = 1; fs.existsSync(path.join(config.directory, name)); n++) name = backupFileName(started).replace(/\.db$/, `-${n}.db`);
      const target = path.join(config.directory, name);
      const partial = target + PARTIAL_SUFFIX;
      try {
        await database.db.backup(partial);
        checkBackupFile(partial);
        await fs.promises.rename(partial, target);
      } catch (error) {
        await fs.promises.rm(partial, { force: true });
        throw error;
      }
      const removed = pruneBackups(config.directory, config.keep);
      persistSetting('autoBackupLastRun', new Date().toISOString());
      persistSetting('autoBackupLastError', '');
      const size = fs.statSync(target).size;
      console.log(`[Backup] ${reason}: ${target} (${size} bytes)${removed.length ? `, removed ${removed.length} old` : ''}`);
      return { success: true, backup: { name, path: target, size }, removed };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      try {
        persistSetting('autoBackupLastError', message);
      } catch (_) {
        /* database closed */
      }
      console.error(`[Backup] ${reason} backup failed:`, message);
      return { success: false, message };
    }
  })().finally(() => {
    running = null;
    schedule();
  });
  return running;
}

function isRunning() {
  return !!running;
}

/** Arm the timer for the next due backup (called at start, after each run and when settings change). */
function schedule({ startup = false } = {}) {
  if (timer) clearTimeout(timer);
  timer = null;
  let due;
  try {
    due = nextRunAt(readConfig());
  } catch (error) {
    console.warn('[Backup] Could not read the backup settings:', error.message);
    return;
  }
  if (due === null || running) return;
  const wait = Math.min(Math.max(due - Date.now(), startup ? STARTUP_DELAY_MS : 5000), MAX_TIMER_MS);
  timer = setTimeout(() => {
    timer = null;
    const config = readConfig();
    const now = nextRunAt(config);
    if (now !== null && now <= Date.now() + 1000) runBackup('scheduled');
    else schedule();
  }, wait);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** What Settings → Backup shows. */
function status() {
  const config = readConfig();
  const next = nextRunAt(config);
  return {
    ...config,
    running: isRunning(),
    nextRun: next === null ? null : new Date(Math.max(next, Date.now())).toISOString(),
    backups: listBackups(config.directory).map(({ name, path: filePath, size, date }) => ({ name, path: filePath, size, date })),
    folderProblem: folderProblem(config.directory, { appDir, dataDir: app.getPath('userData') })
  };
}

/**
 * Save the settings the page sends. Values the container's environment sets are left alone
 * (the environment wins at every start). Returns the new status.
 */
function saveSettings(input = {}) {
  const config = readConfig();
  const locked = new Set(config.setByEnvironment);
  const updates = {};
  if ('enabled' in input) updates.autoBackupEnabled = input.enabled ? '1' : '0';
  if ('intervalHours' in input) {
    const hours = Number(input.intervalHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 8760) throw new Error('Back up every 1 to 8760 hours.');
    updates.autoBackupIntervalHours = String(hours);
  }
  if ('keep' in input) {
    const keep = Number(input.keep);
    if (!Number.isInteger(keep) || keep < 1 || keep > 1000) throw new Error('Keep 1 to 1000 backups.');
    updates.autoBackupKeep = String(keep);
  }
  if ('directory' in input) {
    const dir = String(input.directory || '')
      .trim()
      .replace(/\/+$/, '');
    if (dir) {
      const problem = folderProblem(dir, { appDir, dataDir: app.getPath('userData') });
      if (problem) throw new Error(problem);
    }
    updates.autoBackupDirectory = dir;
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!locked.has(key)) persistSetting(key, value);
  }
  schedule();
  return status();
}

/** An automatic backup in the current folder, by file name (for Download and Restore). */
function findBackup(name) {
  const text = String(name || '');
  if (!AUTO_BACKUP_FILE.test(text)) throw new Error(`Not an automatic backup: ${text}`);
  const found = listBackups(readConfig().directory).find((backup) => backup.name === text);
  if (!found) throw new Error(`Backup not found: ${text}`);
  return found;
}

/** The folder whose justtprint-auto-*.db files /api/download may serve. */
function downloadFolder() {
  try {
    return readConfig().directory;
  } catch (_) {
    return '';
  }
}

module.exports = {
  AUTO_BACKUP_FILE,
  backupFileName,
  listBackups,
  pruneBackups,
  nextRunAt,
  backupTime,
  folderProblem,
  runBackup,
  isRunning,
  schedule,
  stop,
  status,
  saveSettings,
  findBackup,
  downloadFolder
};
