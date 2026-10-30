'use strict';

/**
 * Webhooks (docs/merge-10.md, Phase 8; after FilamentHub's deliver_webhooks): an admin's list of
 * addresses that get a JSON POST when something happens. With a secret, each delivery is signed:
 * X-JusttPrint-Signature: sha256=<HMAC-SHA256 of the body with the secret>. The secret is never
 * sent to browsers. Deliveries run in the background and never hold up what they report on.
 *
 * Events: spool.low_stock, print.logged, models.added, and webhook.test (Send test).
 */

const crypto = require('crypto');
const database = require('../core/database');
const v = require('../core/filament-values');

const EVENTS = ['spool.low_stock', 'print.logged', 'models.added'];
const TIMEOUT_MS = 10000;

/** A webhook as browsers see it: has_secret instead of the secret. */
function publicWebhook(row) {
  if (!row) return row;
  const { secret, ...rest } = row;
  return {
    ...rest,
    events: String(row.events || '')
      .split(/\s+/)
      .filter(Boolean),
    has_secret: Boolean(secret),
    is_active: Boolean(row.is_active)
  };
}

function list(db = database.db) {
  return db.prepare('SELECT * FROM webhooks ORDER BY name COLLATE NOCASE, id').all().map(publicWebhook);
}

/**
 * Add a webhook (no id) or change one. `secret` changes only when given ('' clears). Events: a
 * list of EVENTS; none means every event.
 */
function save(input = {}, { userId = null } = {}, db = database.db) {
  const name = v.text(input.name, 100);
  if (!name) throw new Error('A webhook needs a name');
  let url;
  try {
    url = new URL(String(input.url || '').trim());
  } catch (error) {
    throw new Error('That is not a web address', { cause: error });
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Use an http:// or https:// address');
  const events = (Array.isArray(input.events) ? input.events : []).filter((event) => EVENTS.includes(event));
  const id = v.id(input.id);
  const values = { name, url: url.href, events: events.join(' '), active: input.is_active === false ? 0 : 1 };
  if (id) {
    if (!db.prepare('UPDATE webhooks SET name = @name, url = @url, events = @events, is_active = @active WHERE id = @id').run({ ...values, id }).changes) {
      throw new Error('That webhook no longer exists');
    }
  }
  const saved = id
    ? id
    : Number(
        db
          .prepare('INSERT INTO webhooks (name, url, events, is_active, created_by, created_at) VALUES (@name, @url, @events, @active, @createdBy, @at)')
          .run({ ...values, createdBy: v.id(userId), at: v.now() }).lastInsertRowid
      );
  if (Object.prototype.hasOwnProperty.call(input, 'secret')) {
    db.prepare('UPDATE webhooks SET secret = ? WHERE id = ?').run(String(input.secret || '').slice(0, 500) || null, saved);
  }
  return publicWebhook(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(saved));
}

function remove(id, db = database.db) {
  return db.prepare('DELETE FROM webhooks WHERE id = ?').run(id).changes > 0;
}

/** The signature header value for a body and secret. */
function signature(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** POST one delivery; records the answer's status (0 when there was none). Resolves to the status. */
async function post(row, event, data, fetchImpl = fetch, db = database.db) {
  const body = JSON.stringify({ event, at: new Date().toISOString(), data });
  const headers = { 'content-type': 'application/json', 'user-agent': 'JusttPrint', 'x-justtprint-event': event };
  if (row.secret) headers['x-justtprint-signature'] = signature(row.secret, body);
  let status = 0;
  try {
    const response = await fetchImpl(row.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    status = response.status;
  } catch (error) {
    console.warn(`[Webhooks] ${row.name}: ${error instanceof Error ? error.message : error}`);
  }
  try {
    db.prepare('UPDATE webhooks SET last_triggered_at = ?, last_status_code = ? WHERE id = ?').run(new Date().toISOString(), status, row.id);
  } catch (_) {
    /* the database closed meanwhile */
  }
  return status;
}

/** Send an event to every active webhook that wants it, in the background. */
function deliver(event, data, { fetchImpl = fetch, db = database.db } = {}) {
  let rows;
  try {
    rows = db.prepare('SELECT * FROM webhooks WHERE is_active = 1').all();
  } catch (_) {
    return Promise.resolve([]);
  }
  const wanted = rows.filter((row) => {
    const events = String(row.events || '')
      .split(/\s+/)
      .filter(Boolean);
    return !events.length || events.includes(event);
  });
  return Promise.all(wanted.map((row) => post(row, event, data, fetchImpl, db)));
}

/** Send webhook.test to one webhook now; resolves to the status its address answered (0: none). */
async function test(id, { fetchImpl = fetch, db = database.db } = {}) {
  const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
  if (!row) throw new Error('That webhook no longer exists');
  return post(row, 'webhook.test', { message: 'A test from JusttPrint' }, fetchImpl, db);
}

module.exports = { EVENTS, list, save, remove, deliver, test, signature, publicWebhook };
