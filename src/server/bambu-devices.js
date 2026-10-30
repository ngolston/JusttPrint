'use strict';

/**
 * Bambu Lab printers from the cloud (docs/merge-10.md, Phase 5; after FilamentHub's
 * services/bambu.py): the printers bound to the Bambu Lab account JusttPrint is signed in with
 * (the same sign-in as MakerWorld downloads, makerworld-account.js), added to Printers or brought
 * up to date by serial number. A new one gets one AMS unit with 4 slots. Only the list: live
 * status over the printer's own connection (LAN mode, MQTT) is a later feature.
 */

const database = require('../core/database');
const account = require('./makerworld-account');
const { httpsFetch, readLimited, USER_AGENT } = require('./link-import');
const { addAmsUnit } = require('../core/printer-ams');

const DEVICES_URL = 'https://api.bambulab.com/v1/iot-service/api/user/bind';
const TIMEOUT_MS = 20000;

/** The device list for a token: [{ dev_id, name, dev_product_name, dev_model_name, online, print_status, nozzle_diameter }]. */
async function fetchDevices(headers, fetchImpl) {
  const response = await fetchImpl(DEVICES_URL, {
    method: 'GET',
    headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (response.status === 401) return { unauthorized: true, devices: [] };
  const text = (await readLimited(response, 512 * 1024)).toString('utf8');
  if (!response.ok) throw new Error(`Bambu Lab answered ${response.status} for the printer list`);
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error('Bambu Lab sent a printer list JusttPrint cannot read', { cause: error });
  }
  const devices = Array.isArray(json) ? json : Array.isArray(json.devices) ? json.devices : [];
  return { unauthorized: false, devices };
}

/** The signed-in account's printers. Refreshes the token once when it has expired. */
async function listDevices(fetchImpl = httpsFetch) {
  let headers = account.authHeaders();
  if (!headers) throw new Error('Sign in to your Bambu Lab account first (Settings → Integrations → MakerWorld)');
  let answer = await fetchDevices(headers, fetchImpl);
  if (answer.unauthorized && (await account.refresh(fetchImpl))) {
    headers = account.authHeaders();
    if (headers) answer = await fetchDevices(headers, fetchImpl);
  }
  if (answer.unauthorized) throw new Error('The Bambu Lab sign-in has expired: sign in again (Settings → Integrations → MakerWorld)');
  return answer.devices.map((device) => ({
    serial: String(device.dev_id || device.serial_number || device.sn || '').trim(),
    name: String(device.name || device.dev_product_name || '').trim(),
    product: String(device.dev_product_name || '').trim() || null,
    model: String(device.dev_model_name || device.model || '').trim() || null,
    online: device.online === undefined ? null : Boolean(device.online),
    nozzle: Number(device.nozzle_diameter) > 0 ? Number(device.nozzle_diameter) : null
  }));
}

/**
 * Add the devices to Printers, or update the name and model of those already there (same serial
 * number). Returns { created, updated, unchanged, total }.
 * @param {any} db
 * @param {Awaited<ReturnType<typeof listDevices>>} devices
 */
function importDevices(db, devices) {
  const summary = { created: 0, updated: 0, unchanged: 0, total: 0 };
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const device of devices) {
      if (!device.serial) continue;
      summary.total++;
      const name = device.name || `Bambu Lab ${device.product || device.serial.slice(0, 8)}`;
      const model = device.product || device.model || null;
      const existing = db.prepare("SELECT id, nickname, model FROM printers WHERE serial_number = ? AND connection_type = 'bambu'").get(device.serial);
      const status = device.online === null ? null : device.online ? 'idle' : 'offline';
      if (existing) {
        if (existing.nickname !== name || existing.model !== model) {
          db.prepare('UPDATE printers SET nickname = ?, model = ?, status = COALESCE(?, status), last_seen_at = ?, updated_at = ? WHERE id = ?').run(
            name,
            model,
            status,
            now,
            now,
            existing.id
          );
          summary.updated++;
        } else {
          db.prepare('UPDATE printers SET status = COALESCE(?, status), last_seen_at = ? WHERE id = ?').run(status, now, existing.id);
          summary.unchanged++;
        }
        continue;
      }
      const id = Number(
        db
          .prepare(
            `INSERT INTO printers (nickname, manufacturer, model, printer_type, firmware_type, is_klipper, connection_type, serial_number, status, last_seen_at, created_at, updated_at)
             VALUES (?, 'Bambu Lab', ?, 'FDM', 'Bambu OS', 0, 'bambu', ?, ?, ?, ?, ?)`
          )
          .run(name, model, device.serial, status, now, now, now).lastInsertRowid
      );
      addAmsUnit(db, id, { name: 'AMS 1', slots: 4 });
      summary.created++;
    }
  })();
  return summary;
}

/** List the account's printers and add or update them in Printers. */
async function importFromCloud(fetchImpl = httpsFetch) {
  const devices = await listDevices(fetchImpl);
  return importDevices(database.db, devices);
}

module.exports = { listDevices, importDevices, importFromCloud, DEVICES_URL };
