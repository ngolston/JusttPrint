#!/usr/bin/env node
'use strict';

// Phase 8 (docs/merge-10.md): low-stock rules, alerts told once per breach, the reorder list,
// signed webhooks and where alerts go (the secrets stay on the server).

const assert = require('assert');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const database = require('../src/core/database');
const { ensureFilamentSchema } = require('../src/core/filament-schema');
const lowStock = require('../src/core/low-stock');
const spools = require('../src/core/spools');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const fresh = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(
    'CREATE TABLE models (id INTEGER PRIMARY KEY AUTOINCREMENT, print_status TEXT, dateAdded TEXT); CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'
  );
  const log = console.log;
  console.log = () => {};
  try {
    ensureFilamentSchema(db);
  } finally {
    console.log = log;
  }
  database.db = db;
  return db;
};
const spool = (db, material, remaining, extra = {}) => spools.saveSpool(db, { material, initial_weight: 1000, remaining, ...extra });

test('rules: low above critical, a material by its base, the default when there are none', () => {
  const db = fresh();
  assert.deepStrictEqual(
    lowStock.activeRules(db).map((r) => r.name),
    ['Low stock']
  );
  assert.throws(() => lowStock.saveRule(db, { low_threshold_pct: 10, critical_threshold_pct: 20 }), /Critical must be below low/);
  const petg = lowStock.saveRule(db, { name: 'PETG', low_threshold_pct: 30, critical_threshold_pct: 5, material_filter: 'PETG HF', notify_discord: true });
  assert.strictEqual(petg.material_filter, 'PETG');
  assert.deepStrictEqual(
    lowStock.activeRules(db).map((r) => r.name),
    ['PETG'],
    'with a rule, the default no longer applies'
  );
  assert.strictEqual(lowStock.severityFor(petg, { material: 'PLA', pct: 1 }), null);
  assert.strictEqual(lowStock.severityFor(petg, { material: 'PETG', pct: 4 }), 'critical');
  assert.strictEqual(lowStock.severityFor(petg, { material: 'petg', pct: 25 }), 'low');
  assert.strictEqual(lowStock.severityFor(petg, { material: 'PETG', pct: 31 }), null);
});

test('alerts are told once per breach, again when worse, and again after a refill', () => {
  const db = fresh();
  const rule = lowStock.saveRule(db, { name: 'All', low_threshold_pct: 20, critical_threshold_pct: 10 });
  const black = spool(db, 'PLA', 150);
  spool(db, 'PLA', 800);
  let groups = lowStock.evaluate(db);
  assert.deepStrictEqual(
    groups.map((g) => [g.rule.id, g.alerts.map((a) => [a.spool.id, a.severity])]),
    [[rule.id, [[black.id, 'low']]]]
  );
  assert.deepStrictEqual(lowStock.evaluate(db), [], 'nothing new');
  spools.saveSpool(db, { id: black.id, material: 'PLA', remaining: 50 });
  groups = lowStock.evaluate(db);
  assert.deepStrictEqual(
    groups[0].alerts.map((a) => a.severity),
    ['critical'],
    'worse: told again'
  );
  spools.weighSpool(db, black.id, { weight: 1000, withSpool: false });
  assert.deepStrictEqual(lowStock.evaluate(db), [], 'refilled: nothing to tell');
  spools.saveSpool(db, { id: black.id, material: 'PLA', remaining: 100 });
  assert.strictEqual(lowStock.evaluate(db).length, 1, 'low again after the refill: told again');
});

test('the default rule remembers what it told (in settings) and archived spools are left out', () => {
  const db = fresh();
  spool(db, 'PLA', 100);
  spool(db, 'PLA', 50, { status: 'archived' });
  assert.strictEqual(lowStock.evaluate(db)[0].alerts.length, 1);
  assert.deepStrictEqual(lowStock.evaluate(db), []);
});

test('the reorder list: most urgent first, with where to buy', () => {
  const db = fresh();
  spool(db, 'PLA', 150, { name: 'Low white', supplier: 'Amazon', product_url: 'https://example.com/white', purchase_price: 19.99 });
  spool(db, 'PLA', 30, { name: 'Critical black' });
  spool(db, 'PLA', 900, { name: 'Fine' });
  const list = lowStock.reorderList(db);
  assert.deepStrictEqual(
    list.map((s) => [s.name, s.severity]),
    [
      ['Critical black', 'critical'],
      ['Low white', 'low']
    ]
  );
  assert.deepStrictEqual([list[1].supplier, list[1].productUrl, list[1].price, list[1].pct], ['Amazon', 'https://example.com/white', 19.99, 15]);
});

test('webhooks: signed deliveries to the ones that want the event; the secret never leaves', async () => {
  const db = fresh();
  const webhooks = require('../src/server/webhooks');
  const all = webhooks.save({ name: 'All', url: 'https://hooks.example.com/all', secret: 's3cret' }, {}, db);
  webhooks.save({ name: 'Prints only', url: 'https://hooks.example.com/prints', events: ['print.logged', 'nonsense'] }, {}, db);
  webhooks.save({ name: 'Off', url: 'https://hooks.example.com/off', is_active: false }, {}, db);
  assert.strictEqual(all.secret, undefined);
  assert.strictEqual(all.has_secret, true);
  assert.deepStrictEqual(
    webhooks.list(db).map((w) => [w.name, w.events]),
    [
      ['All', []],
      ['Off', []],
      ['Prints only', ['print.logged']]
    ]
  );
  assert.throws(() => webhooks.save({ name: 'Bad', url: 'ftp://x' }, {}, db), /http/);
  const sent = [];
  const fetchImpl = async (url, options) => {
    sent.push({ url, options });
    return { status: 204 };
  };
  await webhooks.deliver('spool.low_stock', { spools: [] }, { fetchImpl, db });
  assert.deepStrictEqual(
    sent.map((s) => s.url),
    ['https://hooks.example.com/all']
  );
  const { body, headers } = sent[0].options;
  assert.strictEqual(headers['x-justtprint-event'], 'spool.low_stock');
  assert.strictEqual(headers['x-justtprint-signature'], `sha256=${crypto.createHmac('sha256', 's3cret').update(body).digest('hex')}`);
  assert.strictEqual(JSON.parse(body).event, 'spool.low_stock');
  assert.strictEqual(webhooks.list(db).find((w) => w.name === 'All').last_status_code, 204);
  sent.length = 0;
  await webhooks.deliver('print.logged', {}, { fetchImpl, db });
  assert.deepStrictEqual(sent.map((s) => s.url).sort(), ['https://hooks.example.com/all', 'https://hooks.example.com/prints']);
  assert.ok(!('x-justtprint-signature' in sent.find((s) => s.url.endsWith('/prints')).options.headers), 'no secret, no signature');
  assert.strictEqual(
    await webhooks.test(all.id, {
      fetchImpl: async () => {
        throw new Error('down');
      },
      db
    }),
    0
  );
});

test('alert delivery: Discord and email settings, the password and address never shown', async () => {
  fresh();
  const delivery = require('../src/server/alert-delivery');
  assert.throws(() => delivery.save({ discordWebhookUrl: 'http://discord.com/api/webhooks/1/x' }), /https/);
  assert.throws(() => delivery.save({ discordWebhookUrl: 'https://example.com/hook' }), /Discord webhook/);
  assert.throws(() => delivery.save({ smtp: { to: 'not an address' } }), /not an email address/);
  const status = delivery.save({
    discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc',
    smtp: { host: 'smtp.example.com', port: 587, user: 'me', password: 'pw', from: 'me@example.com', to: 'a@example.com; b@example.com' }
  });
  assert.deepStrictEqual(status, {
    discord: { set: true },
    email: {
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'me',
      from: 'me@example.com',
      to: 'a@example.com, b@example.com',
      passwordSet: true,
      ready: true
    }
  });
  assert.ok(!JSON.stringify(status).includes('abc') && !JSON.stringify(status).includes('"pw"'));
  delivery.save({ smtp: { host: 'smtp2.example.com' } });
  assert.strictEqual(delivery.status().email.passwordSet, true, 'the password stays when not given');
  const sent = [];
  await delivery.sendEmail({ subject: 'Hi', text: 'x' }, (options) => ({ sendMail: async (mail) => sent.push({ options, mail }) }));
  assert.deepStrictEqual([sent[0].options.host, sent[0].options.auth.pass, sent[0].mail.to], ['smtp2.example.com', 'pw', 'a@example.com, b@example.com']);
  let posted = null;
  await delivery.sendDiscord({ content: 'x' }, async (url, options) => {
    posted = { url, body: options.body };
    return { ok: true, status: 204 };
  });
  assert.deepStrictEqual(posted, { url: 'https://discord.com/api/webhooks/1/abc', body: '{"content":"x"}' });
});

test("the alert's Discord message and email list the spools, critical in red", () => {
  const { discordPayload, emailMessage } = require('../src/server/low-stock-alerts');
  const group = {
    rule: { name: 'Low stock' },
    alerts: [{ severity: 'critical', spool: { name: 'Black <PLA>', brand: 'Bambu', remaining: 18, pct: 1.8, productUrl: 'https://example.com/b' } }]
  };
  const discord = discordPayload(group);
  assert.strictEqual(discord.embeds[0].color, 0xd23b3b);
  assert.match(discord.embeds[0].description, /Critical: Black <PLA> \(Bambu\), 18 g left \(1.8%\)/);
  const mail = emailMessage(group);
  assert.strictEqual(mail.subject, 'JusttPrint: 1 spool running low');
  assert.match(mail.html, /Black &lt;PLA&gt;/);
  assert.match(mail.html, /href="https:\/\/example.com\/b"/);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}:`, err.stack || err.message);
      process.exitCode = 1;
    }
  }
})();
