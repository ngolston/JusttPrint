'use strict';

/**
 * Low-stock alerts (docs/merge-10.md, Phase 8): check the rules (src/core/low-stock.js) every
 * hour and soon after spools change (a weighing, a logged print, an import), and tell each new
 * breach: a JusttPrint notification for editors, and, when the rule asks for them, Discord and
 * email (alert-delivery.js), plus the spool.low_stock webhooks. A failed delivery is logged; the
 * others still go.
 */

const database = require('../core/database');
const { evaluate } = require('../core/low-stock');

const AFTER_CHANGE_MS = 30 * 1000;
/** @type {NodeJS.Timeout | null} */
let timer = null;
/** @type {NodeJS.Timeout | null} */
let hourly = null;

/** One spool's alert, its weight in the library's unit (core/units.js; grams by default). */
const line = (alert, unit = 'g') =>
  `${alert.severity === 'critical' ? 'Critical' : 'Low'}: ${alert.spool.name}${alert.spool.brand ? ` (${alert.spool.brand})` : ''}, ${require('../core/units').formatWeight(alert.spool.remaining, unit)} left (${alert.spool.pct}%)`;

/** The Discord message for a rule's alerts (one embed, critical first). */
function discordPayload(group, unit = 'g') {
  const critical = group.alerts.some((alert) => alert.severity === 'critical');
  return {
    embeds: [
      {
        title: `${group.rule.name}: ${group.alerts.length} ${group.alerts.length === 1 ? 'spool' : 'spools'} running low`,
        description: group.alerts
          .map((alert) => `${alert.severity === 'critical' ? '🔴' : '🟡'} ${line(alert, unit)}`)
          .join('\n')
          .slice(0, 4000),
        color: critical ? 0xd23b3b : 0xe8a33c
      }
    ]
  };
}

/** The email for a rule's alerts: { subject, text, html }. */
function emailMessage(group, unit = 'g') {
  const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const subject = `JusttPrint: ${group.alerts.length} ${group.alerts.length === 1 ? 'spool' : 'spools'} running low`;
  const text = `${group.rule.name}\n\n${group.alerts.map((alert) => line(alert, unit)).join('\n')}\n`;
  const html = `<p><strong>${escape(group.rule.name)}</strong></p><ul>${group.alerts
    .map((alert) => `<li>${escape(line(alert, unit))}${alert.spool.productUrl ? ` · <a href="${escape(alert.spool.productUrl)}">reorder</a>` : ''}</li>`)
    .join('')}</ul>`;
  return { subject, text, html };
}

/** Check now and tell what is new. Resolves to how many spools were told about. */
async function run() {
  const db = database.db;
  if (!db || !db.open) return 0;
  let groups;
  let unit = 'g';
  try {
    groups = evaluate(db);
    unit = require('../core/units').readUnits(db).weight;
  } catch (error) {
    console.warn(`[Low stock] Check failed: ${error instanceof Error ? error.message : error}`);
    return 0;
  }
  const notifications = require('./notifications');
  const delivery = require('./alert-delivery');
  let told = 0;
  for (const group of groups) {
    told += group.alerts.length;
    const critical = group.alerts.some((alert) => alert.severity === 'critical');
    notifications.notify({
      level: critical ? 'error' : 'warning',
      title: group.alerts.length === 1 ? `${group.alerts[0].spool.name} is running low` : `${group.alerts.length} spools are running low`,
      body: group.alerts.map((alert) => line(alert, unit)).join('\n'),
      link: '#/filament',
      minRole: 'editor'
    });
    if (group.rule.notify_discord) {
      await delivery.sendDiscord(discordPayload(group, unit)).catch((error) => console.warn(`[Low stock] Discord: ${error.message}`));
    }
    if (group.rule.notify_email) {
      await delivery.sendEmail(emailMessage(group, unit)).catch((error) => console.warn(`[Low stock] Email: ${error.message}`));
    }
    void require('./webhooks').deliver('spool.low_stock', {
      rule: { id: group.rule.id || null, name: group.rule.name },
      spools: group.alerts.map((alert) => ({
        id: alert.spool.id,
        name: alert.spool.name,
        brand: alert.spool.brand,
        material: alert.spool.material,
        grams: alert.spool.remaining,
        percent: alert.spool.pct,
        severity: alert.severity
      }))
    });
  }
  return told;
}

/** Check soon (spools changed); repeated calls meanwhile make one check. */
function soon(delay = AFTER_CHANGE_MS) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, delay);
  timer.unref?.();
}

/** Check after startup and every hour. */
function start() {
  soon(60 * 1000);
  if (hourly) clearInterval(hourly);
  hourly = setInterval(() => void run(), 3600 * 1000);
  hourly.unref?.();
}

function stop() {
  if (timer) clearTimeout(timer);
  if (hourly) clearInterval(hourly);
  timer = null;
  hourly = null;
}

module.exports = { run, soon, start, stop, discordPayload, emailMessage };
