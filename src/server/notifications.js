'use strict';

/**
 * Notifications for the bell in the top bar: what finished or went wrong in the background while
 * nobody was watching (scans that added models, thumbnail and AI tagging jobs, the same-geometry
 * search, automatic backups, printer maintenance coming due).
 *
 * Kept in the database, the newest 200 and at most 30 days. Each one is for a minimum role (a
 * failed backup is for admins). Every account keeps how far it has read. Browsers only get a
 * 'notifications-changed' ping and read the list through the API, which leaves out what their
 * role may not see. Guests have no list.
 */

const database = require('../core/database');
const events = require('./events');

const KEEP = 200;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const LEVELS = new Set(['info', 'success', 'warning', 'error']);
const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 };
const CHANGED = 'notifications-changed';

/** @type {any} */
let tableDb = null;
function table() {
  const db = database.db;
  if (tableDb !== db) {
    db.prepare(
      `CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT,
        link TEXT,
        min_role TEXT NOT NULL DEFAULT 'viewer',
        dedupe_key TEXT UNIQUE
      )`
    ).run();
    db.prepare('CREATE TABLE IF NOT EXISTS notification_reads (user_id INTEGER PRIMARY KEY, last_read_id INTEGER NOT NULL DEFAULT 0)').run();
    tableDb = db;
  }
  return db;
}

const rankOf = (role) => ROLE_RANK[/** @type {keyof typeof ROLE_RANK} */ (role)] ?? -1;
/** An account that keeps a read position: logged in, not a guest (API tokens act as user 0). */
const accountId = (user) => (user && !user.guest && Number.isInteger(Number(user.id)) ? Number(user.id) : null);

/**
 * Add a notification and tell the open browsers. `key` makes it once-only (a reminder that came
 * due is told about once). Never throws: a notification must not break what it reports on.
 * @param {{ title: string, body?: string | null, level?: string, link?: string | null, minRole?: string, key?: string | null, now?: Date }} notice
 * @returns {number | null} the new notification's id, or null (not added)
 */
function notify({ title, body = null, level = 'info', link = null, minRole = 'viewer', key = null, now = new Date() }) {
  try {
    const db = table();
    const text = String(title || '').trim();
    if (!text) return null;
    const result = db
      .prepare('INSERT OR IGNORE INTO notifications (created_at, level, title, body, link, min_role, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        now.toISOString(),
        LEVELS.has(level) ? level : 'info',
        text.slice(0, 200),
        body ? String(body).slice(0, 1000) : null,
        link ? String(link).slice(0, 500) : null,
        rankOf(minRole) >= 0 ? minRole : 'admin',
        key
      );
    if (!result.changes) return null;
    prune(now);
    events.broadcast(CHANGED);
    return Number(result.lastInsertRowid);
  } catch (error) {
    console.warn(`[Notifications] Could not add "${title}": ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/** Drop notifications past 30 days, and all but the newest 200. */
function prune(now = new Date()) {
  const db = table();
  db.prepare('DELETE FROM notifications WHERE created_at < ?').run(new Date(now.getTime() - MAX_AGE_MS).toISOString());
  db.prepare('DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT ?)').run(KEEP);
}

/** The roles at or below the caller's (a viewer sees viewer notifications, an admin all of them). */
function visibleRoles(user) {
  const rank = rankOf(user && user.role);
  return Object.keys(ROLE_RANK).filter((role) => rankOf(role) <= rank);
}

/**
 * The newest notifications the caller may see, and how many of those are unread.
 * @returns {{ items: { id: number, createdAt: string, level: string, title: string, body: string | null, link: string | null, unread: boolean }[], unread: number }}
 */
function listFor(user, { limit = 50 } = {}) {
  const id = accountId(user);
  if (id === null) return { items: [], unread: 0 };
  const db = table();
  const roles = visibleRoles(user);
  if (!roles.length) return { items: [], unread: 0 };
  const marks = roles.map(() => '?').join(',');
  const lastRead = (db.prepare('SELECT last_read_id AS lastRead FROM notification_reads WHERE user_id = ?').get(id) || { lastRead: 0 }).lastRead;
  const rows = db
    .prepare(`SELECT id, created_at, level, title, body, link FROM notifications WHERE min_role IN (${marks}) ORDER BY id DESC LIMIT ?`)
    .all(...roles, Math.max(1, Math.min(200, Number(limit) || 50)));
  const unread = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE min_role IN (${marks}) AND id > ?`).get(...roles, lastRead).n;
  return {
    items: rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      level: row.level,
      title: row.title,
      body: row.body,
      link: row.link,
      unread: row.id > lastRead
    })),
    unread
  };
}

/** Mark everything up to `upToId` read for the caller (their other browsers update too). */
function markRead(user, upToId) {
  const id = accountId(user);
  const upTo = Number(upToId);
  if (id === null || !Number.isInteger(upTo) || upTo <= 0) return { success: false };
  table()
    .prepare(
      `INSERT INTO notification_reads (user_id, last_read_id) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`
    )
    .run(id, upTo);
  events.broadcast(CHANGED);
  return { success: true };
}

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/**
 * Printer maintenance that is due (today or overdue) and not done: one notification per reminder
 * and due date, for editors (who log maintenance). Run at startup and every hour.
 */
function checkDueReminders(now = new Date()) {
  try {
    const db = database.db;
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'printer_maintenance_reminders'").get();
    if (!exists) return 0;
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    const due = db
      .prepare(
        `SELECT r.id, r.title, r.due_date AS dueDate, p.nickname AS printer, p.id AS printerId
         FROM printer_maintenance_reminders r JOIN printers p ON p.id = r.printer_id
         WHERE r.status != 'completed' AND r.due_date <= ?`
      )
      .all(endOfToday.toISOString());
    let added = 0;
    for (const reminder of due) {
      const overdue = new Date(reminder.dueDate).getTime() < new Date(now).setHours(0, 0, 0, 0);
      const id = notify({
        level: 'warning',
        title: `${reminder.printer}: ${reminder.title}`,
        body: overdue ? `Maintenance overdue since ${new Date(reminder.dueDate).toLocaleDateString('en-US')}.` : 'Maintenance is due today.',
        link: `#/printers/${reminder.printerId}`,
        minRole: 'editor',
        key: `reminder:${reminder.id}:${String(reminder.dueDate).slice(0, 10)}`,
        now
      });
      if (id) added++;
    }
    return added;
  } catch (error) {
    console.warn(`[Notifications] Reminder check failed: ${error instanceof Error ? error.message : error}`);
    return 0;
  }
}

/** @type {NodeJS.Timeout | null} */
let reminderTimer = null;

/** Check for due maintenance now and every hour (stop() on shutdown). */
function startReminderChecks() {
  checkDueReminders();
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = setInterval(() => checkDueReminders(), 3600 * 1000);
  reminderTimer.unref();
}

function stop() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = null;
}

module.exports = { notify, listFor, markRead, prune, checkDueReminders, startReminderChecks, stop, plural, CHANGED };
