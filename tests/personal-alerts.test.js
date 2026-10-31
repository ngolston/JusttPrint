#!/usr/bin/env node
'use strict';

// 10.2 Phase 9 (docs/plan-10.1.md): alerts each person chooses: the bell, their own email and
// Discord, quiet hours, the checks (runs out soon, used up, drying done) and the weekly digest.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jp-personal-alerts-')));
process.env.JUSTTPRINT_DB_PATH = path.join(tmp, 'justtprint.db');
process.env.JUSTTPRINT_USER_DATA = tmp;
const database = require('../src/core/database');
const { initializeDatabase } = require('../src/core/db-init');
const alerts = require('../src/server/personal-alerts');
const notifications = require('../src/server/notifications');
const spools = require('../src/core/spools');
const drying = require('../src/core/drying');
const printEvents = require('../src/core/print-events');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const log = console.log;
console.log = () => {};
try {
  initializeDatabase();
} finally {
  console.log = log;
}
const db = database.db;
db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, role TEXT NOT NULL,
  session_key TEXT NOT NULL, created_at TEXT NOT NULL, last_login_at TEXT, can_delete_files INTEGER NOT NULL DEFAULT 0)`);
const user = (name, role) =>
  Number(
    db.prepare("INSERT INTO users (username, password_hash, role, session_key, created_at) VALUES (?, 'x', ?, 'k', 'now')").run(name, role).lastInsertRowid
  );
const ada = user('ada', 'admin');
const ed = user('ed', 'editor');
const vic = user('vic', 'viewer');
const sent = [];
alerts.setSendersForTest({
  email: async (to, message) => sent.push(['email', to, message.subject]),
  discord: async (url, message) => sent.push(['discord', url.slice(-6), message.subject])
});
const WEBHOOK = 'https://discord.com/api/webhooks/123/abcdef';

test('choices: checked, the webhook never shown back, kept when left out', () => {
  assert.deepStrictEqual(alerts.prefsFor(ed).kinds.lowStock, { bell: true, email: false, discord: false }, 'the default: the bell only');
  assert.strictEqual(alerts.prefsFor(ada).email, null, 'an admin who chose nothing gets no email (the role filter below includes admins)');
  assert.throws(() => alerts.savePrefs(ed, { email: 'not mail' }), /not an email address/);
  assert.throws(() => alerts.savePrefs(ed, { discordWebhook: 'https://example.com/hook' }), /discord\.com\/api\/webhooks/);
  assert.throws(() => alerts.savePrefs(ed, { quietHours: { from: '25:00', to: '07:00' } }), /Quiet hours/);
  assert.throws(() => alerts.savePrefs(0, {}), /Only an account/);
  const saved = alerts.savePrefs(ed, {
    email: 'ed@example.com',
    discordWebhook: WEBHOOK,
    kinds: { lowStock: { bell: false, email: true, discord: true }, printFailed: { email: true }, nonsense: { email: true } },
    weeklyDigest: true
  });
  assert.strictEqual(saved.discordSet, true);
  assert.ok(!JSON.stringify(saved).includes('abcdef'), 'the webhook stays on the server');
  assert.deepStrictEqual(saved.kinds.lowStock, { bell: false, email: true, discord: true });
  assert.ok(!('nonsense' in saved.kinds));
  alerts.savePrefs(ed, { ...saved, weeklyDigest: true });
  assert.strictEqual(alerts.prefsFor(ed).discordWebhook, WEBHOOK, 'left out: kept');
  assert.deepStrictEqual(alerts.mutedKinds(ed), ['lowStock']);
});

test('the bell leaves out the kinds a person turned off', () => {
  notifications.notify({ title: 'E2E low', kind: 'lowStock', minRole: 'viewer' });
  notifications.notify({ title: 'Plain', minRole: 'viewer' });
  const titles = (id, role) => notifications.listFor({ id, role }).items.map((n) => n.title);
  assert.ok(!titles(ed, 'editor').includes('E2E low') && titles(ed, 'editor').includes('Plain'), 'ed turned low stock off');
  assert.ok(titles(vic, 'viewer').includes('E2E low'), 'vic did not');
});

test('quiet hours hold email and Discord until they end, across midnight too', () => {
  const prefs = { ...alerts.defaultPrefs(), quietHours: { from: '22:00', to: '07:00' } };
  const at = (h, m = 0) => new Date(2026, 9, 30, h, m);
  assert.strictEqual(alerts.sendAfter(prefs, at(12)).getTime(), at(12).getTime(), 'daytime: now');
  assert.strictEqual(alerts.sendAfter(prefs, at(23)).getTime(), new Date(2026, 9, 31, 7, 0).getTime(), 'late: next morning');
  assert.strictEqual(alerts.sendAfter(prefs, at(3)).getTime(), at(7).getTime(), 'early: this morning');
  const day = { ...alerts.defaultPrefs(), quietHours: { from: '12:00', to: '13:30' } };
  assert.strictEqual(alerts.sendAfter(day, at(12, 15)).getTime(), at(13, 30).getTime());
});

test('an alert reaches who asked, by role; quiet hours hold it, then it goes', async () => {
  sent.length = 0;
  alerts.savePrefs(vic, { email: 'vic@example.com', kinds: { printFailed: { email: true }, lowStock: { email: true } } });
  await alerts.alert('printFailed', { title: 'Benchy failed', minRole: 'viewer', bell: false, now: new Date(2026, 9, 30, 12) });
  assert.deepStrictEqual(sent.map((s) => s.slice(0, 2)).sort(), [
    ['email', 'ed@example.com'],
    ['email', 'vic@example.com']
  ]);
  sent.length = 0;
  await alerts.alert('lowStock', { title: 'Black is low', minRole: 'editor', bell: false, now: new Date(2026, 9, 30, 12) });
  assert.deepStrictEqual(sent.map((s) => s[0] + ':' + s[1]).sort(), ['discord:abcdef', 'email:ed@example.com'], 'vic is a viewer: not for editor alerts');
  sent.length = 0;
  alerts.savePrefs(ed, { ...alerts.publicPrefs(alerts.prefsFor(ed)), quietHours: { from: '22:00', to: '07:00' } });
  const night = new Date(2026, 9, 30, 23, 30);
  const results = await alerts.alert('printFailed', { title: 'Night fail', minRole: 'editor', bell: false, now: night });
  assert.deepStrictEqual([results, sent.length], [['held'], 0]);
  assert.strictEqual(await alerts.flushOutbox(new Date(2026, 9, 31, 6, 59)), 0, 'not yet');
  assert.strictEqual(await alerts.flushOutbox(new Date(2026, 9, 31, 7, 1)), 1);
  assert.deepStrictEqual(sent[0], ['email', 'ed@example.com', 'JusttPrint: Night fail']);
});

test('the checks: runs out soon, used up and drying done are told once', async () => {
  alerts.savePrefs(ed, {
    ...alerts.publicPrefs(alerts.prefsFor(ed)),
    quietHours: null,
    kinds: { runsOutSoon: { email: true }, usedUp: { email: true }, dryingDone: { email: true } }
  });
  sent.length = 0;
  const model = Number(db.prepare("INSERT INTO models (filePath, fileName, dateAdded) VALUES ('/lib/a.3mf', 'a.3mf', '2026-01-01')").run().lastInsertRowid);
  const soon = spools.saveSpool(db, { name: 'Going', material: 'PLA', initial_weight: 1000, remaining: 300, status: 'active' });
  printEvents.logPrintEvent(db, {
    modelId: model,
    outcome: 'printed',
    printedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    spools: [{ spoolId: soon.id, grams: 250 }]
  });
  const gone = spools.saveSpool(db, { name: 'Gone', material: 'PLA', initial_weight: 1000, remaining: 0, status: 'active' });
  const wet = spools.saveSpool(db, { name: 'Wet', material: 'PETG', initial_weight: 1000, remaining: 800 });
  const session = drying.startDrying(db, wet.id, { drying_temp: 65, target_hours: 4 });
  db.prepare('UPDATE drying_sessions SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 5 * 3600000).toISOString(), session.id);
  const told = await alerts.check();
  const subjects = sent.map((s) => s[2]);
  assert.ok(
    subjects.some((s) => /Going runs out in about \d+ days/.test(s)),
    subjects.join(' | ')
  );
  assert.ok(subjects.includes('JusttPrint: Gone is used up'));
  assert.ok(subjects.includes('JusttPrint: Wet is dry'));
  assert.strictEqual(told, 3);
  assert.strictEqual(await alerts.check(), 0, 'told once');
  spools.weighSpool(db, gone.id, { weight: 500, withSpool: false });
  await alerts.check();
  spools.saveSpool(db, { id: gone.id, name: 'Gone', material: 'PLA', remaining: 0 });
  sent.length = 0;
  await alerts.check();
  assert.deepStrictEqual(
    sent.map((s) => s[2]),
    ['JusttPrint: Gone is used up'],
    'refilled, then empty again: told again'
  );
});

test('the weekly digest: Monday from 9:00, once a week, to those who want it', async () => {
  sent.length = 0;
  const monday = new Date(2026, 10, 2, 9, 30);
  assert.strictEqual(await alerts.sendDigests(new Date(2026, 10, 2, 8, 0)), 0, 'before 9');
  assert.strictEqual(await alerts.sendDigests(new Date(2026, 10, 3, 10, 0)), 0, 'Tuesday');
  assert.strictEqual(await alerts.sendDigests(monday), 1, 'ed asked for it; vic did not');
  assert.deepStrictEqual(sent[0].slice(0, 3), ['email', 'ed@example.com', 'JusttPrint: your week']);
  assert.strictEqual(await alerts.sendDigests(new Date(2026, 10, 2, 15, 0)), 0, 'once a week');
  assert.match(alerts.digestText(db, monday), /^Last week: \d+ prints?/);
  assert.strictEqual(alerts.weekOf(new Date(2026, 10, 8, 20)), '2026-11-02', 'a Sunday belongs to the week that began on Monday');
});

(async () => {
  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`ok ${name}`);
      } catch (err) {
        console.error(`FAIL ${name}:`, err.stack || err.message);
        process.exitCode = 1;
      }
    }
  } finally {
    alerts.stop();
    if (database.db && database.db.open) database.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
