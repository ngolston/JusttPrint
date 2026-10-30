'use strict';

/**
 * Where low-stock alerts go besides JusttPrint's notifications (docs/merge-10.md, Phase 8; after
 * FilamentHub's core/notifications.py): a Discord webhook and email through an SMTP server. Kept
 * in the alertDelivery setting, which the settings API never reads or writes (server-auth.js);
 * browsers learn what is set, never the Discord address or the email password.
 */

const database = require('../core/database');

const KEY = 'alertDelivery';
const TIMEOUT_MS = 15000;

function read() {
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
    return row && row.value ? JSON.parse(row.value) : {};
  } catch (_) {
    return {};
  }
}

function write(config) {
  database.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(config));
}

/** What a browser may know: the email settings without the password, and whether Discord is set. */
function status() {
  const config = read();
  const smtp = config.smtp || {};
  return {
    discord: { set: Boolean(config.discordWebhookUrl) },
    email: {
      host: smtp.host || '',
      port: smtp.port || null,
      secure: Boolean(smtp.secure),
      user: smtp.user || '',
      from: smtp.from || '',
      to: smtp.to || '',
      passwordSet: Boolean(smtp.password),
      ready: Boolean(smtp.host && smtp.to)
    }
  };
}

const httpsUrl = (value) => {
  const s = String(value || '').trim();
  if (!s) return '';
  let url;
  try {
    url = new URL(s);
  } catch (error) {
    throw new Error('That is not a web address', { cause: error });
  }
  if (url.protocol !== 'https:') throw new Error('Use an https:// address');
  return url.href;
};
const emails = (value) => {
  const list = String(value || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const address of list) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error(`${address} is not an email address`);
  return list.join(', ');
};

/**
 * Change the settings. `discordWebhookUrl` and `smtp.password` change only when given ('' clears).
 * @param {{ discordWebhookUrl?: string, smtp?: { host?: string, port?: number | string, secure?: boolean, user?: string, password?: string, from?: string, to?: string } }} input
 */
function save(input = {}) {
  const config = read();
  if (input.discordWebhookUrl !== undefined) {
    const url = httpsUrl(input.discordWebhookUrl);
    if (url && !/^https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(url))
      throw new Error('That is not a Discord webhook address (https://discord.com/api/webhooks/…)');
    config.discordWebhookUrl = url || undefined;
  }
  if (input.smtp) {
    const smtp = { ...(config.smtp || {}) };
    const given = input.smtp;
    if (given.host !== undefined)
      smtp.host = String(given.host || '')
        .trim()
        .slice(0, 255);
    if (given.port !== undefined) {
      const port = given.port === '' || given.port === null ? null : Number(given.port);
      if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('The port is a number from 1 to 65535');
      smtp.port = port;
    }
    if (given.secure !== undefined) smtp.secure = Boolean(given.secure);
    if (given.user !== undefined)
      smtp.user = String(given.user || '')
        .trim()
        .slice(0, 255);
    if (given.password !== undefined) smtp.password = String(given.password || '') || undefined;
    if (given.from !== undefined) smtp.from = emails(given.from).split(', ')[0] || '';
    if (given.to !== undefined) smtp.to = emails(given.to);
    config.smtp = smtp;
  }
  write(config);
  return status();
}

/** Post a Discord message with embeds. */
async function sendDiscord(payload, fetchImpl = fetch) {
  const url = read().discordWebhookUrl;
  if (!url) throw new Error('No Discord webhook is set');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'JusttPrint' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Discord answered ${response.status}`);
}

/**
 * Send an email to the alert addresses. `transportFactory` is for tests.
 * @param {{ subject: string, text: string, html?: string }} message
 * @param {Function | null} [transportFactory]
 */
async function sendEmail({ subject, text, html }, transportFactory = null) {
  const smtp = read().smtp || {};
  if (!smtp.host || !smtp.to) throw new Error('Set up the email server and who gets alerts first');
  const nodemailer = require('nodemailer');
  const transport = (transportFactory || nodemailer.createTransport)({
    host: smtp.host,
    port: smtp.port || (smtp.secure ? 465 : 587),
    secure: Boolean(smtp.secure),
    auth: smtp.user ? { user: smtp.user, pass: smtp.password || '' } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS
  });
  await transport.sendMail({ from: smtp.from || smtp.user || 'justtprint@localhost', to: smtp.to, subject, text, html });
}

module.exports = { status, save, sendDiscord, sendEmail, read };
