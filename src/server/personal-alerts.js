'use strict';

/**
 * Alerts each person chooses (docs/plan-10.1.md, Phase 9). Five kinds: a spool runs low, runs out
 * within a week (filament-forecast.js), is used up, drying is done, a print failed. Each goes to
 * the bell (unless someone turned that kind off there), and by email and Discord to each person
 * who asked for it, at their own address and Discord webhook, through the library's email server
 * (alert-delivery.js). During someone's quiet hours their email and Discord wait until the end
 * (alert_outbox). A weekly digest by email on Monday morning, for those who want it.
 *
 * Choices are per account (user_alert_prefs); a Discord webhook is shown back only to its owner.
 */

const database = require('../core/database');

const KINDS = {
  lowStock: 'A spool runs low',
  runsOutSoon: 'A spool runs out within a week',
  usedUp: 'A spool is used up',
  dryingDone: 'Drying is done',
  printFailed: 'A print failed',
  // From Bambu printers followed live (printer-jobs.js).
  printFinished: 'A print finished',
  printPaused: 'A print paused',
  // From the failure detector watching the camera (failure-detection.js).
  printFailing: 'A print looks like it is failing'
};
const CHANNELS = ['bell', 'email', 'discord'];
const RUNS_OUT_DAYS = 7;
const DISCORD_WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** @type {any} */
let tablesDb = null;
function tables() {
  const db = database.db;
  if (tablesDb !== db) {
    db.exec(`CREATE TABLE IF NOT EXISTS user_alert_prefs (user_id INTEGER PRIMARY KEY, prefs TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alert_fired (kind TEXT NOT NULL, ref TEXT NOT NULL, fired_at TEXT NOT NULL, PRIMARY KEY (kind, ref));
      CREATE TABLE IF NOT EXISTS alert_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channel TEXT NOT NULL, payload TEXT NOT NULL, send_after TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alert_digest_sent (user_id INTEGER PRIMARY KEY, week TEXT NOT NULL);`);
    tablesDb = db;
  }
  return db;
}

/**
 * @typedef {{ email: string | null, discordWebhook: string | null, kinds: Record<string, { bell: boolean, email: boolean, discord: boolean }>, quietHours: { from: string, to: string } | null, weeklyDigest: boolean }} AlertPrefs
 */

/**
 * Everyone's starting point: every kind in the bell, nothing by email or Discord.
 * @returns {AlertPrefs}
 */
function defaultPrefs() {
  return {
    email: null,
    discordWebhook: null,
    kinds: Object.fromEntries(Object.keys(KINDS).map((kind) => [kind, { bell: true, email: false, discord: false }])),
    quietHours: null,
    weeklyDigest: false
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A person's choices, each part checked; what is missing is the default. */
function clean(input) {
  const out = defaultPrefs();
  const value = input && typeof input === 'object' ? input : {};
  if (typeof value.email === 'string' && EMAIL.test(value.email.trim())) out.email = value.email.trim().slice(0, 200);
  if (typeof value.discordWebhook === 'string' && DISCORD_WEBHOOK.test(value.discordWebhook.trim())) out.discordWebhook = value.discordWebhook.trim();
  for (const kind of Object.keys(KINDS)) {
    const k = value.kinds && value.kinds[kind];
    if (k && typeof k === 'object') for (const channel of CHANNELS) if (typeof k[channel] === 'boolean') out.kinds[kind][channel] = k[channel];
  }
  if (value.quietHours && TIME.test(value.quietHours.from) && TIME.test(value.quietHours.to) && value.quietHours.from !== value.quietHours.to) {
    out.quietHours = { from: value.quietHours.from, to: value.quietHours.to };
  }
  out.weeklyDigest = value.weeklyDigest === true;
  return out;
}

/** A person's choices (the defaults until they save some). */
function prefsFor(userId) {
  const row = tables().prepare('SELECT prefs FROM user_alert_prefs WHERE user_id = ?').get(Number(userId));
  if (!row) return defaultPrefs();
  try {
    return clean(JSON.parse(row.prefs));
  } catch (_) {
    return defaultPrefs();
  }
}

/** The choices as their owner's page shows them: the Discord webhook only as set or not. */
function publicPrefs(prefs) {
  const { discordWebhook, ...rest } = prefs;
  return { ...rest, discordSet: !!discordWebhook };
}

/**
 * Save the caller's choices. An email or Discord address that is not one is refused; a webhook
 * left out keeps the one saved, null or '' clears it.
 */
function savePrefs(userId, input) {
  const id = Number(userId);
  if (!(id > 0)) throw new Error('Only an account can choose its alerts');
  const value = input && typeof input === 'object' ? input : {};
  if (value.email && !EMAIL.test(String(value.email).trim())) throw new Error('That is not an email address');
  if (value.discordWebhook && !DISCORD_WEBHOOK.test(String(value.discordWebhook).trim())) {
    throw new Error('A Discord webhook looks like https://discord.com/api/webhooks/…');
  }
  if (value.quietHours && (!TIME.test(value.quietHours.from) || !TIME.test(value.quietHours.to)))
    throw new Error('Quiet hours are two times, such as 22:00 and 07:00');
  const before = prefsFor(id);
  const next = clean({ ...value, discordWebhook: value.discordWebhook === undefined ? before.discordWebhook : value.discordWebhook || null });
  tables().prepare('INSERT OR REPLACE INTO user_alert_prefs (user_id, prefs) VALUES (?, ?)').run(id, JSON.stringify(next));
  return publicPrefs(next);
}

/** The kinds a person turned off in the bell (notifications.js leaves them out of their list). */
function mutedKinds(userId) {
  const prefs = prefsFor(userId);
  return Object.keys(KINDS).filter((kind) => !prefs.kinds[kind].bell);
}

// ---- Quiet hours ----

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** When a message to this person may go: now, or the end of their quiet hours (server time). */
function sendAfter(prefs, now = new Date()) {
  if (!prefs.quietHours) return now;
  const from = minutesOf(prefs.quietHours.from);
  const to = minutesOf(prefs.quietHours.to);
  const minute = now.getHours() * 60 + now.getMinutes();
  const quiet = from < to ? minute >= from && minute < to : minute >= from || minute < to;
  if (!quiet) return now;
  const end = new Date(now);
  end.setHours(Math.floor(to / 60), to % 60, 0, 0);
  if (end <= now) end.setDate(end.getDate() + 1);
  return end;
}

// ---- Sending ----

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 };

/** The accounts at or above a role. */
function accountsFor(minRole) {
  try {
    const rank = ROLE_RANK[/** @type {keyof typeof ROLE_RANK} */ (minRole)] ?? 0;
    return database.db
      .prepare('SELECT id, username, role FROM users')
      .all()
      .filter((u) => (ROLE_RANK[/** @type {keyof typeof ROLE_RANK} */ (u.role)] ?? -1) >= rank);
  } catch (_) {
    return [];
  }
}

/** @type {{ email: Function, discord: Function } | null} Tests replace the senders. */
let testSenders = null;
/** For tests: capture messages instead of sending them (null: send for real). */
function setSendersForTest(senders) {
  testSenders = senders;
}

/** Send one message now (email or Discord), to one person. */
async function deliverNow(prefs, channel, message) {
  if (testSenders) {
    if (channel === 'email' && prefs.email) await testSenders.email(prefs.email, message);
    if (channel === 'discord' && prefs.discordWebhook) await testSenders.discord(prefs.discordWebhook, message);
    return;
  }
  const delivery = require('./alert-delivery');
  if (channel === 'email' && prefs.email) await delivery.sendEmail({ subject: message.subject, text: message.text, html: message.html }, null, prefs.email);
  if (channel === 'discord' && prefs.discordWebhook) {
    await delivery.sendDiscord(
      {
        username: 'JusttPrint',
        embeds: [{ title: message.subject.slice(0, 250), description: message.text.slice(0, 4000), color: message.color || 0xea6450 }]
      },
      fetch,
      prefs.discordWebhook
    );
  }
}

/** Email and Discord for one person, now or after their quiet hours. */
async function deliver(userId, prefs, channel, message, now = new Date()) {
  const when = sendAfter(prefs, now);
  if (when > now) {
    tables()
      .prepare('INSERT INTO alert_outbox (user_id, channel, payload, send_after) VALUES (?, ?, ?, ?)')
      .run(userId, channel, JSON.stringify(message), when.toISOString());
    return 'held';
  }
  await deliverNow(prefs, channel, message).catch((error) => console.warn(`[Alerts] ${channel} to account ${userId}: ${error.message}`));
  return 'sent';
}

/** Send what waited for quiet hours to end. */
async function flushOutbox(now = new Date()) {
  const db = tables();
  const due = db.prepare('SELECT * FROM alert_outbox WHERE send_after <= ? ORDER BY id').all(now.toISOString());
  for (const row of due) {
    db.prepare('DELETE FROM alert_outbox WHERE id = ?').run(row.id);
    try {
      await deliverNow(prefsFor(row.user_id), row.channel, JSON.parse(row.payload));
    } catch (error) {
      console.warn(`[Alerts] Held ${row.channel} to account ${row.user_id}: ${error.message}`);
    }
  }
  return due.length;
}

/**
 * One alert: the bell (kind-tagged, so people who turned the kind off do not see it), then email
 * and Discord to each person who asked for this kind. `bell: false` when the bell already has it
 * (the low-stock check adds its own).
 * @param {keyof typeof KINDS} kind
 * @param {{ title: string, body?: string, link?: string, level?: string, minRole?: string, key?: string | null, bell?: boolean, now?: Date }} alert
 */
async function alert(kind, alert) {
  const now = alert.now || new Date();
  const minRole = alert.minRole || 'viewer';
  if (alert.bell !== false) {
    require('./notifications').notify({
      title: alert.title,
      body: alert.body || null,
      level: alert.level || 'warning',
      link: alert.link || null,
      minRole,
      key: alert.key || null,
      kind,
      now
    });
  }
  const message = {
    subject: `JusttPrint: ${alert.title}`,
    text: alert.body ? `${alert.title}\n\n${alert.body}` : alert.title,
    color: alert.level === 'error' ? 0xd23b3b : 0xea6450
  };
  const results = [];
  for (const account of accountsFor(minRole)) {
    const prefs = prefsFor(account.id);
    for (const channel of /** @type {const} */ (['email', 'discord'])) {
      if (prefs.kinds[kind] && prefs.kinds[kind][channel]) results.push(await deliver(account.id, prefs, channel, message, now));
    }
  }
  return results;
}

// ---- The checks: runs out soon, used up, drying done ----

/** Mark `ref` told for `kind`; false when it already was. */
function fire(kind, ref, now) {
  return tables().prepare('INSERT OR IGNORE INTO alert_fired (kind, ref, fired_at) VALUES (?, ?, ?)').run(kind, String(ref), now.toISOString()).changes > 0;
}
/** Forget the `kind` alerts whose ref is no longer in `still` (told again when it comes back). */
function forgetExcept(kind, still) {
  const keep = new Set([...still].map(String));
  for (const row of tables().prepare('SELECT ref FROM alert_fired WHERE kind = ?').all(kind)) {
    if (!keep.has(row.ref)) tables().prepare('DELETE FROM alert_fired WHERE kind = ? AND ref = ?').run(kind, row.ref);
  }
}

/** Check the spools and the dryer, and alert what is new. Returns how many alerts went out. */
async function check(now = new Date()) {
  const db = database.db;
  if (!db || !db.open) return 0;
  let told = 0;
  const spools = require('../core/spools').listSpools(db, { includeArchived: false });
  const grams = (n) => require('../core/units').formatWeight(n, require('../core/units').readUnits(db).weight);

  const soon = spools.filter((s) => s.forecast && s.forecast.daysLeft <= RUNS_OUT_DAYS && s.remaining > 0);
  for (const spool of soon) {
    if (!fire('runsOutSoon', spool.id, now)) continue;
    told += 1;
    await alert('runsOutSoon', {
      title: `${spool.display_name} runs out in about ${Math.max(1, Math.round(spool.forecast.daysLeft))} days`,
      body: `${grams(spool.remaining)} left, at about ${grams(spool.forecast.perDay)} a day.`,
      link: `#/filament/${spool.id}`,
      minRole: 'editor',
      now
    });
  }
  forgetExcept(
    'runsOutSoon',
    soon.map((s) => s.id)
  );

  const empty = spools.filter((s) => s.remaining <= 0);
  for (const spool of empty) {
    if (!fire('usedUp', spool.id, now)) continue;
    told += 1;
    await alert('usedUp', {
      title: `${spool.display_name} is used up`,
      body: 'Archive it, or weigh it if some is left.',
      link: `#/filament/${spool.id}`,
      minRole: 'editor',
      now
    });
  }
  forgetExcept(
    'usedUp',
    empty.map((s) => s.id)
  );

  for (const session of require('../core/drying').listActiveDrying(db)) {
    const hours = Number(session.target_hours);
    if (!(hours > 0) || Date.parse(session.started_at) + hours * 3600 * 1000 > now.getTime()) continue;
    if (!fire('dryingDone', session.id, now)) continue;
    told += 1;
    await alert('dryingDone', {
      title: `${session.spool_name || session.profile_name || 'A spool'} is dry`,
      body: `Its ${hours} h of drying are up: take it out and finish drying on the Filament page.`,
      link: '#/filament',
      level: 'success',
      minRole: 'editor',
      now
    });
  }
  return told;
}

// ---- The weekly digest ----

/** Monday of this week (server time), "2026-10-26". */
function weekOf(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The digest's text: what runs low or out soon, and last week's prints and filament. */
function digestText(db, now = new Date()) {
  const units = require('../core/units');
  const unit = units.readUnits(db).weight;
  const grams = (n) => units.formatWeight(n, unit);
  const low = require('../core/low-stock').reorderList(db);
  const spools = require('../core/spools').listSpools(db, { includeArchived: false });
  const soon = spools.filter((s) => s.forecast && s.forecast.daysLeft <= 14).sort((a, b) => a.forecast.daysLeft - b.forecast.daysLeft);
  const since = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
  let prints = { n: 0, failed: 0 };
  let used = 0;
  try {
    prints = db
      .prepare(
        "SELECT COALESCE(SUM(quantity), 0) AS n, COALESCE(SUM(CASE WHEN outcome = 'failed' THEN quantity ELSE 0 END), 0) AS failed FROM print_events WHERE printed_at >= ?"
      )
      .get(since);
    used = db
      .prepare('SELECT COALESCE(SUM(pes.grams), 0) AS g FROM print_event_spools pes JOIN print_events pe ON pe.id = pes.event_id WHERE pe.printed_at >= ?')
      .get(since).g;
  } catch (_) {
    /* no print log */
  }
  const lines = [
    `Last week: ${prints.n} ${prints.n === 1 ? 'print' : 'prints'}${prints.failed ? ` (${prints.failed} failed)` : ''}, ${grams(used)} of filament.`
  ];
  lines.push('', low.length ? 'Running low:' : 'No spool is running low.');
  for (const s of low.slice(0, 15)) lines.push(`- ${s.name}${s.brand ? ` (${s.brand})` : ''}: ${grams(s.remaining)} left (${s.pct}%)`);
  if (soon.length) {
    lines.push('', 'Runs out within two weeks:');
    for (const s of soon.slice(0, 15)) lines.push(`- ${s.display_name}: about ${Math.max(1, Math.round(s.forecast.daysLeft))} days`);
  }
  return lines.join('\n');
}

/** On Monday from 9:00 (server time): the digest to each person who wants it, once a week. */
async function sendDigests(now = new Date()) {
  if (now.getDay() !== 1 || now.getHours() < 9) return 0;
  const db = database.db;
  if (!db || !db.open) return 0;
  const week = weekOf(now);
  let sent = 0;
  for (const account of accountsFor('viewer')) {
    const prefs = prefsFor(account.id);
    if (!prefs.weeklyDigest || !prefs.email) continue;
    const row = tables().prepare('SELECT week FROM alert_digest_sent WHERE user_id = ?').get(account.id);
    if (row && row.week === week) continue;
    tables().prepare('INSERT OR REPLACE INTO alert_digest_sent (user_id, week) VALUES (?, ?)').run(account.id, week);
    await deliverNow(prefs, 'email', { subject: 'JusttPrint: your week', text: digestText(db, now) }).catch((error) =>
      console.warn(`[Alerts] Digest to account ${account.id}: ${error.message}`)
    );
    sent += 1;
  }
  return sent;
}

/** A test message to the caller's own email and Discord (My alerts → Send a test). */
async function sendTest(userId) {
  const prefs = prefsFor(userId);
  if (!prefs.email && !prefs.discordWebhook) throw new Error('Enter your email address or Discord webhook first');
  const message = { subject: 'JusttPrint: a test alert', text: 'Your alerts reach you here.' };
  const sent = [];
  if (prefs.email) {
    await deliverNow(prefs, 'email', message);
    sent.push('email');
  }
  if (prefs.discordWebhook) {
    await deliverNow(prefs, 'discord', message);
    sent.push('discord');
  }
  return { sent };
}

// ---- Scheduling ----

/** @type {NodeJS.Timeout | null} */
let timer = null;
/** @type {NodeJS.Timeout | null} */
let soonTimer = null;

/** Check, flush held messages and send digests every 10 minutes. */
function start() {
  if (timer) return;
  const tick = () => {
    check()
      .then(() => flushOutbox())
      .then(() => sendDigests())
      .catch((error) => console.warn(`[Alerts] ${error.message}`));
  };
  timer = setInterval(tick, 10 * 60 * 1000);
  if (timer.unref) timer.unref();
  soonTimer = setTimeout(tick, 90 * 1000);
  if (soonTimer.unref) soonTimer.unref();
}

/** Check again shortly (spools or drying changed). */
function soon(delay = 5000) {
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = setTimeout(() => {
    soonTimer = null;
    check().catch((error) => console.warn(`[Alerts] ${error.message}`));
  }, delay);
  if (soonTimer.unref) soonTimer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  if (soonTimer) clearTimeout(soonTimer);
  timer = null;
  soonTimer = null;
}

module.exports = {
  KINDS,
  defaultPrefs,
  clean,
  prefsFor,
  publicPrefs,
  savePrefs,
  mutedKinds,
  sendAfter,
  alert,
  flushOutbox,
  check,
  digestText,
  sendDigests,
  weekOf,
  sendTest,
  start,
  soon,
  stop,
  setSendersForTest
};
