#!/usr/bin/env node
'use strict';

// The bell's notifications (src/server/notifications.js) on an in-memory database.

const assert = require('assert');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const events = require('../src/server/events');
const notifications = require('../src/server/notifications');

function test(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

const pings = [];
events.setBroadcaster((channel) => pings.push(channel));
database.db = new Database(':memory:');

const admin = { id: 1, username: 'admin', role: 'admin' };
const editor = { id: 2, username: 'ed', role: 'editor' };
const viewer = { id: 3, username: 'kid', role: 'viewer' };
const guest = { id: 0, username: 'guest', role: 'viewer', guest: true };

test('each role sees its notifications and the ones below it', () => {
  notifications.notify({ title: 'For everyone', level: 'success' });
  notifications.notify({ title: 'For editors', minRole: 'editor' });
  notifications.notify({ title: 'For admins', minRole: 'admin', level: 'error' });
  const titles = (user) => notifications.listFor(user).items.map((item) => item.title);
  assert.deepStrictEqual(titles(admin), ['For admins', 'For editors', 'For everyone'], 'newest first');
  assert.deepStrictEqual(titles(editor), ['For editors', 'For everyone']);
  assert.deepStrictEqual(titles(viewer), ['For everyone']);
  assert.deepStrictEqual(notifications.listFor(guest), { items: [], unread: 0 }, 'guests have no list');
  assert.ok(pings.includes(notifications.CHANGED), 'open browsers are pinged');
});

test('each account keeps how far it has read', () => {
  assert.strictEqual(notifications.listFor(admin).unread, 3);
  const newest = notifications.listFor(admin).items[0].id;
  notifications.markRead(admin, newest);
  assert.strictEqual(notifications.listFor(admin).unread, 0);
  assert.ok(notifications.listFor(admin).items.every((item) => !item.unread));
  assert.strictEqual(notifications.listFor(editor).unread, 2, 'others still have theirs');
  notifications.markRead(admin, 1);
  assert.strictEqual(notifications.listFor(admin).unread, 0, 'reading never goes backwards');
  assert.deepStrictEqual(notifications.markRead(guest, newest), { success: false });
});

test('a key makes a notification once-only', () => {
  const first = notifications.notify({ title: 'Due', key: 'reminder:9:2026-10-09' });
  const again = notifications.notify({ title: 'Due', key: 'reminder:9:2026-10-09' });
  assert.ok(first);
  assert.strictEqual(again, null);
});

test('an empty title adds nothing; a bad level or role is made safe', () => {
  assert.strictEqual(notifications.notify({ title: '  ' }), null);
  notifications.notify({ title: 'Odd', level: 'shout', minRole: 'superuser' });
  const odd = notifications.listFor(admin).items.find((item) => item.title === 'Odd');
  assert.strictEqual(odd.level, 'info');
  assert.ok(!notifications.listFor(editor).items.some((item) => item.title === 'Odd'), 'an unknown role is admins only');
});

test('only the newest 200 and the last 30 days are kept', () => {
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  notifications.notify({ title: 'Ancient', now: old });
  for (let i = 0; i < 210; i++) notifications.notify({ title: `Many ${i}` });
  const count = database.db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n;
  assert.strictEqual(count, 200);
  assert.ok(!notifications.listFor(admin, { limit: 200 }).items.some((item) => item.title === 'Ancient'));
});

test('maintenance that is due is told once, to editors, with a link to the printer', () => {
  database.db.exec(`CREATE TABLE printers (id INTEGER PRIMARY KEY, nickname TEXT);
    CREATE TABLE printer_maintenance_reminders (id INTEGER PRIMARY KEY, printer_id INTEGER, title TEXT, due_date TEXT, status TEXT);
    INSERT INTO printers VALUES (5, 'Voron 2.4');
    INSERT INTO printer_maintenance_reminders VALUES (1, 5, 'Tension belts', '2026-10-01T12:00:00.000Z', 'pending');
    INSERT INTO printer_maintenance_reminders VALUES (2, 5, 'Grease rails', '2026-12-01T12:00:00.000Z', 'pending');
    INSERT INTO printer_maintenance_reminders VALUES (3, 5, 'Done already', '2026-10-01T12:00:00.000Z', 'completed');`);
  const now = new Date('2026-10-09T12:00:00Z');
  assert.strictEqual(notifications.checkDueReminders(now), 1);
  assert.strictEqual(notifications.checkDueReminders(now), 0, 'not again');
  const due = notifications.listFor(editor).items.find((item) => item.title === 'Voron 2.4: Tension belts');
  assert.ok(due && due.level === 'warning' && due.link === '#/printers/5' && /overdue/i.test(due.body), JSON.stringify(due));
  assert.ok(!notifications.listFor(viewer).items.some((item) => /Voron/.test(item.title)), 'viewers do not log maintenance');
});
