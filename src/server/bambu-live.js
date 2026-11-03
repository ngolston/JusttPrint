'use strict';

/**
 * Bambu Lab live status over the printer's LAN connection (MQTT on port 8883, user bblp, the
 * printer's access code). For every printer whose connection is Bambu Lab and that has an
 * address, a serial number and an access code: its state, progress, time left, layer and
 * temperatures for browsers ('printer-live'), its status in Printers, and its AMS slots kept in
 * line with the trays (src/core/printer-ams.js `syncFromPrinter`).
 *
 * It only reads. The one thing it sends is "pushall", the request for the printer's whole state;
 * no print job, no setting, nothing that moves the printer.
 */

const { MqttClient } = require('./mqtt-client');

const RETRY_MS = [5000, 15000, 30000, 60000, 120000];
const PUSHALL_EVERY_MS = 10 * 60 * 1000;
const BROADCAST_MS = 1500;
const SEEN_EVERY_MS = 60 * 1000;
const NO_RFID = /^0+$/;

/** The printer's address as typed (192.168.1.40, 192.168.1.40:8883, mqtts://host): host and port. */
function parseAddress(value) {
  let textValue = String(value || '').trim();
  if (!textValue) return null;
  textValue = textValue.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(textValue);
  if (ipv6) return { host: ipv6[1], port: Number(ipv6[2]) || 8883 };
  const m = /^([^:]+)(?::(\d+))?$/.exec(textValue);
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) || 8883 };
}

const num = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/** Bambu sends changes only (P1, A1): they are merged into what it said before. Lists of things with an id merge by id. */
function merge(into, from) {
  if (Array.isArray(from)) {
    if (Array.isArray(into) && from.every((item) => item && typeof item === 'object' && 'id' in item)) {
      const out = into.slice();
      for (const item of from) {
        const at = out.findIndex((old) => old && old.id === item.id);
        if (at === -1) out.push(item);
        else out[at] = merge(out[at], item);
      }
      return out;
    }
    return from;
  }
  if (from && typeof from === 'object') {
    const out = into && typeof into === 'object' && !Array.isArray(into) ? { ...into } : {};
    for (const [key, value] of Object.entries(from)) out[key] = merge(out[key], value);
    return out;
  }
  return from;
}

/** A tray as printer-ams.js takes it: null when empty. */
function trayOf(raw, exists) {
  if (!raw || typeof raw !== 'object') return exists ? { type: null, color: null, uuid: null } : null;
  const type = String(raw.tray_type || '').trim() || null;
  if (!type && !exists) return null;
  const color = /^[0-9a-f]{6}/i.test(String(raw.tray_color || '')) ? `#${String(raw.tray_color).slice(0, 6).toLowerCase()}` : null;
  const uuid = String(raw.tray_uuid || '').trim();
  return { type, color, uuid: uuid && !NO_RFID.test(uuid) ? uuid : null };
}

/**
 * The AMS units and the holder in a printer's (merged) report, for printer-ams.js.
 * `external` is undefined when the printer did not say.
 */
function amsFromReport(print) {
  const ams = print && print.ams;
  const bits = ams && typeof ams.tray_exist_bits === 'string' && /^[0-9a-f]+$/i.test(ams.tray_exist_bits) ? parseInt(ams.tray_exist_bits, 16) : null;
  const units = (Array.isArray(ams && ams.ams) ? ams.ams : [])
    .map((unit) => {
      const id = num(unit && unit.id);
      if (id === null) return null;
      const trays = Array.isArray(unit.tray) ? unit.tray : [];
      const count = Math.max(trays.length ? Math.max(...trays.map((tray) => (num(tray && tray.id) ?? 0) + 1)) : 0, id >= 128 ? 1 : 4);
      const list = [];
      for (let index = 0; index < count; index++) {
        const raw = trays.find((tray) => num(tray && tray.id) === index);
        // tray_exist_bits: one bit per slot of the first four units (bit 4 × unit + slot).
        const exists = bits !== null && id < 4 ? Boolean(bits & (1 << (id * 4 + index))) : Boolean(raw && raw.tray_type);
        list.push(trayOf(raw, exists));
      }
      const humidity = num(unit.humidity_raw);
      return {
        id,
        name: id >= 128 ? `AMS HT ${id - 127}` : null,
        humidity: humidity !== null && humidity >= 0 && humidity <= 100 ? humidity : null,
        trays: list
      };
    })
    .filter(Boolean);
  const vt = print && print.vt_tray;
  return { units, external: vt && typeof vt === 'object' ? trayOf(vt, false) : undefined };
}

const STATES = {
  RUNNING: 'printing',
  PREPARE: 'printing',
  SLICING: 'printing',
  PAUSE: 'paused',
  FINISH: 'finished',
  FAILED: 'failed',
  IDLE: 'idle'
};

/** Printers.status from the live state. */
const STATUS = { printing: 'printing', paused: 'paused', finished: 'idle', failed: 'idle', idle: 'idle', offline: 'offline' };

/**
 * What browsers see of a printer: no access code, no address.
 * @param {{ printerId: number, connected: boolean, error: string | null, print: any, updatedAt: string | null, model: { filePath: string, title: string } | null }} entry
 */
function summarize(entry) {
  const print = entry.print || {};
  const state = entry.connected ? STATES[String(print.gcode_state || '').toUpperCase()] || (print.gcode_state ? 'idle' : null) : 'offline';
  const active = state === 'printing' || state === 'paused';
  const { units, external } = amsFromReport(print);
  const rawUnits = Array.isArray(print.ams && print.ams.ams) ? print.ams.ams : [];
  const trayNow = num(print.ams && print.ams.tray_now);
  return {
    printerId: entry.printerId,
    connected: entry.connected,
    error: entry.error,
    state,
    job: active || state === 'finished' || state === 'failed' ? String(print.subtask_name || print.gcode_file || '').trim() || null : null,
    model: active || state === 'finished' || state === 'failed' ? entry.model : null,
    progress: active || state === 'finished' ? num(print.mc_percent) : null,
    remainingMinutes: active ? num(print.mc_remaining_time) : null,
    layer: active ? num(print.layer_num) : null,
    totalLayers: active ? num(print.total_layer_num) : null,
    nozzle: num(print.nozzle_temper),
    nozzleTarget: num(print.nozzle_target_temper),
    bed: num(print.bed_temper),
    bedTarget: num(print.bed_target_temper),
    // Which tray feeds the printer now: 'A1'…, 'Holder' (254 or 255 with no AMS), or null.
    feeding:
      trayNow === null || trayNow === 255
        ? null
        : trayNow === 254
          ? 'Holder'
          : trayNow < 64
            ? `${String.fromCharCode(65 + Math.floor(trayNow / 4))}${(trayNow % 4) + 1}`
            : null,
    ams: units.map((unit) => {
      const raw = rawUnits.find((item) => num(item && item.id) === unit.id) || {};
      return {
        id: unit.id,
        humidity: unit.humidity,
        // The AMS humidity level (1 to 5, as the printer's screen shows it), from units that give no percentage.
        humidityLevel: num(raw.humidity),
        temperature: num(raw.temp),
        trays: unit.trays.map((tray, index) => {
          const rawTray = (Array.isArray(raw.tray) ? raw.tray : []).find((item) => num(item && item.id) === index) || {};
          const remain = num(rawTray.remain);
          return tray
            ? {
                type: tray.type,
                name: String(rawTray.tray_sub_brands || '').trim() || tray.type,
                color: tray.color,
                remain: remain !== null && remain >= 0 ? remain : null
              }
            : null;
        })
      };
    }),
    external: external ? { type: external.type, color: external.color } : null,
    // The printer's errors now, in plain words where Bambu's list has them (bambu-hms.js).
    errors: entry.connected ? require('./bambu-hms').errorsOf(print) : [],
    updatedAt: entry.updatedAt
  };
}

/**
 * The live connections. `connect(options)` makes an MqttClient (tests give their own); `db()`
 * answers the database; `broadcast(channel, data)` tells browsers.
 * `jobs` watches prints start and end (printer-jobs.js); tests give their own.
 * @param {{ db: () => any, broadcast?: (channel: string, ...args: any[]) => void, connect?: (options: any) => any, secure?: boolean, now?: () => number, log?: (message: string) => void, jobs?: { observe: (entry: any, before: string | null, summary: any) => void } }} deps
 */
function createLive(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || ((message) => console.log(`[Bambu live] ${message}`));
  const broadcast = deps.broadcast || (() => {});
  const jobs = deps.jobs || require('./printer-jobs').createJobs({ db: deps.db, now, afterLogged: (payload) => afterLogged(payload) });

  /** What Log Print does after a print is logged: alerts, webhooks, Home Assistant, other browsers. */
  function afterLogged(payload) {
    for (const [module, fn] of [
      ['./low-stock-alerts', 'soon'],
      ['./personal-alerts', 'soon'],
      ['./home-assistant', 'pushSoon'],
      // Maintenance by print hours may be due now.
      ['./notifications', 'checkDueReminders']
    ]) {
      try {
        require(module)[fn]();
      } catch (_) {
        /* not set up */
      }
    }
    try {
      void require('./webhooks').deliver('print.logged', {
        filePaths: [payload.filePath],
        outcome: payload.outcome,
        quantity: payload.quantity,
        spools: payload.spools
      });
    } catch (_) {
      /* none */
    }
    broadcast('models-changed', { filePaths: [payload.filePath], by: null });
    broadcast('filament-check-changed');
  }
  const connect = deps.connect || ((options) => new MqttClient(options).connect());
  /** @type {Map<number, any>} */
  const entries = new Map();
  /** @type {NodeJS.Timeout | null} */
  let broadcastTimer = null;
  let stopped = false;

  const announce = () => {
    if (broadcastTimer || stopped) return;
    const timer = setTimeout(() => {
      broadcastTimer = null;
      broadcast('printer-live', list());
    }, BROADCAST_MS);
    timer.unref?.();
    broadcastTimer = timer;
  };

  function list() {
    return [...entries.values()].map(summarize);
  }

  function setStatus(entry, state) {
    const status = STATUS[state] || null;
    const db = deps.db();
    if (!db) return;
    const at = now();
    if (status === entry.savedStatus && at - entry.savedAt < SEEN_EVERY_MS) return;
    try {
      if (status === 'offline') db.prepare('UPDATE printers SET status = ? WHERE id = ?').run(status, entry.printerId);
      else
        db.prepare('UPDATE printers SET status = COALESCE(?, status), last_seen_at = ? WHERE id = ?').run(status, new Date(at).toISOString(), entry.printerId);
      entry.savedStatus = status;
      entry.savedAt = at;
    } catch (error) {
      log(`could not save the status of printer ${entry.printerId}: ${error.message}`);
    }
  }

  function findModel(entry) {
    const name = String((entry.print && (entry.print.subtask_name || entry.print.gcode_file)) || '').trim();
    if (name === entry.modelFor) return;
    entry.modelFor = name;
    entry.model = null;
    if (!name) return;
    const base = name
      .replace(/^.*[\\/]/, '')
      .replace(/\.gcode$/i, '')
      .replace(/\.(3mf|gcode|stl|step)$/i, '');
    try {
      const rows = deps
        .db()
        .prepare("SELECT filePath, fileName, title FROM models WHERE filePath NOT LIKE 'url::%' AND (fileName LIKE ? OR title = ?) LIMIT 20")
        .all(`${base}.%`, base);
      const row =
        rows.find(
          (r) =>
            String(r.fileName || '')
              .replace(/\.gcode\.3mf$/i, '')
              .replace(/\.[^.]+$/, '') === base
        ) || rows.find((r) => r.title === base);
      entry.model = row ? { filePath: row.filePath, title: row.title || row.fileName } : null;
    } catch (_) {
      entry.model = null;
    }
  }

  function syncAms(entry) {
    const report = amsFromReport(entry.print);
    const signature = JSON.stringify(report);
    if (signature === entry.amsSignature) return;
    entry.amsSignature = signature;
    try {
      const changed = require('../core/printer-ams').syncFromPrinter(deps.db(), entry.printerId, report);
      if (changed || entry.firstAms) broadcast('filament-check-changed');
      entry.firstAms = false;
      if (changed) {
        try {
          require('./home-assistant').pushSoon();
        } catch (_) {
          /* not set up */
        }
      }
    } catch (error) {
      log(`could not update the AMS of printer ${entry.printerId}: ${error.message}`);
    }
  }

  function onMessage(entry, payload) {
    let message;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch (_) {
      return;
    }
    if (!message || typeof message.print !== 'object' || !message.print) return;
    entry.print = merge(entry.print || {}, message.print);
    entry.updatedAt = new Date(now()).toISOString();
    entry.error = null;
    findModel(entry);
    const summary = summarize(entry);
    setStatus(entry, summary.state);
    if (message.print.ams || message.print.vt_tray) syncAms(entry);
    const before = entry.lastState ?? null;
    entry.lastState = summary.state;
    try {
      jobs.observe(entry, before, summary);
    } catch (error) {
      log(`could not follow the print on printer ${entry.printerId}: ${error.message}`);
    }
    announce();
  }

  function open(entry) {
    if (stopped) return;
    const { config } = entry;
    const client = connect({
      host: config.host,
      port: config.port,
      username: 'bblp',
      password: config.secret,
      clientId: `justtprint-${entry.printerId}-${Math.random().toString(16).slice(2, 8)}`,
      secure: deps.secure !== false
    });
    entry.client = client;
    client.on('connect', () => {
      entry.connected = true;
      entry.error = null;
      entry.retry = 0;
      entry.firstAms = true;
      log(`connected to printer ${entry.printerId} (${config.host})`);
      client.subscribe(`device/${config.serial}/report`);
      const pushall = () =>
        client.publish(`device/${config.serial}/request`, { pushing: { sequence_id: '0', command: 'pushall', version: 1, push_target: 1 } });
      pushall();
      entry.pushTimer = setInterval(pushall, PUSHALL_EVERY_MS);
      entry.pushTimer.unref?.();
      announce();
    });
    client.on('message', (topic, payload) => {
      if (topic === `device/${config.serial}/report`) onMessage(entry, payload);
    });
    client.on('close', (error) => {
      if (entry.client !== client) return;
      if (entry.pushTimer) clearInterval(entry.pushTimer);
      entry.pushTimer = null;
      const was = entry.connected;
      entry.connected = false;
      entry.client = null;
      // Hung up (closed or reset) after signing in, before saying anything: a topic it refuses,
      // which is a serial number it does not know.
      const hungUp = was && !entry.updatedAt && (!error || /ECONNRESET|EPIPE|socket hang up/i.test(`${error.code || ''} ${error.message}`));
      entry.error = hungUp
        ? 'the printer closed the connection right after signing in: check the serial number (as Bambu Studio or Bambu Handy shows it)'
        : error
          ? error.message
          : was
            ? 'the printer closed the connection'
            : 'could not connect';
      if (was || entry.retry === 0) log(`printer ${entry.printerId} (${config.host}): ${entry.error}`);
      setStatus(entry, 'offline');
      announce();
      if (stopped || !entries.has(entry.printerId)) return;
      const wait = RETRY_MS[Math.min(entry.retry, RETRY_MS.length - 1)];
      entry.retry++;
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        open(entry);
      }, wait);
      entry.retryTimer.unref?.();
    });
  }

  function close(entry) {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    if (entry.pushTimer) clearInterval(entry.pushTimer);
    entry.retryTimer = null;
    entry.pushTimer = null;
    const client = entry.client;
    entry.client = null;
    if (client) client.close();
  }

  /** The printers to follow, from the database: { printerId, host, port, serial, secret }. */
  function wanted() {
    const db = deps.db();
    if (!db) return [];
    let rows;
    try {
      rows = db
        .prepare(
          "SELECT id, serial_number, api_url, api_secret FROM printers WHERE connection_type = 'bambu' AND serial_number IS NOT NULL AND api_url IS NOT NULL AND api_secret IS NOT NULL"
        )
        .all();
    } catch (_) {
      return []; // before the 10.0 columns
    }
    return rows
      .map((row) => {
        const address = parseAddress(row.api_url);
        // Bambu serial numbers are capitals; the printer hangs up on a topic with any other spelling.
        const serial = String(row.serial_number || '')
          .trim()
          .toUpperCase();
        if (!address || !serial || !/^[A-Za-z0-9_-]+$/.test(serial)) return null;
        return { printerId: row.id, host: address.host, port: address.port, serial, secret: String(row.api_secret) };
      })
      .filter(Boolean);
  }

  /** Follow the printers set up now: new ones connect, changed ones reconnect, removed ones stop. */
  function refresh() {
    if (stopped) return;
    const next = wanted();
    const ids = new Set(next.map((config) => config.printerId));
    for (const [id, entry] of entries) {
      if (!ids.has(id)) {
        close(entry);
        entries.delete(id);
      }
    }
    for (const config of next) {
      const key = JSON.stringify(config);
      const old = entries.get(config.printerId);
      if (old && old.key === key) continue;
      if (old) close(old);
      const entry = {
        printerId: config.printerId,
        key,
        config,
        connected: false,
        error: null,
        print: null,
        updatedAt: null,
        model: null,
        modelFor: '',
        retry: 0,
        client: null,
        retryTimer: null,
        pushTimer: null,
        amsSignature: null,
        firstAms: true,
        savedStatus: undefined,
        savedAt: 0
      };
      entries.set(config.printerId, entry);
      open(entry);
    }
    announce();
  }

  function stop() {
    stopped = true;
    if (broadcastTimer) clearTimeout(broadcastTimer);
    broadcastTimer = null;
    for (const entry of entries.values()) close(entry);
    entries.clear();
  }

  /** The address and access code of a followed printer, for its camera (bambu-camera.js). */
  function cameraConfig(printerId) {
    const entry = entries.get(Number(printerId));
    return entry ? { host: entry.config.host, secret: entry.config.secret } : null;
  }

  return { refresh, stop, list, cameraConfig, _entries: entries };
}

/** @type {ReturnType<typeof createLive> | null} */
let live = null;

/** Start following the server's Bambu printers (app.js). */
function start() {
  if (live) return live;
  live = createLive({
    db: () => require('../core/database').db,
    broadcast: (channel, ...args) => require('./events').broadcastRaw(channel, ...args)
  });
  live.refresh();
  return live;
}

/** After printers change (saved, removed, imported). */
function printersChanged() {
  if (live) live.refresh();
}

function stop() {
  if (live) live.stop();
  live = null;
}

/** What browsers see: one entry per followed printer. */
const status = () => (live ? live.list() : []);

/** For the camera: the followed printer's address and access code, or null. */
const cameraConfig = (printerId) => (live ? live.cameraConfig(printerId) : null);

module.exports = { start, stop, printersChanged, status, cameraConfig, createLive, summarize, amsFromReport, merge, parseAddress };
