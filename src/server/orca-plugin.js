'use strict';

/**
 * The routes the JusttPrint plugin for OrcaSlicer calls (orca-plugin/justtprint.py). The plugin
 * signs in with a person's API key (`Authorization: Bearer jpk_…`), so these are mounted after
 * requireAuth and act as that person, with their role:
 *
 *   GET  /api/orca/hello                        -> { version, username, role, slicedInbox, uploadFolder }
 *   GET  /api/orca/models?q=&sort=&status=&offset=&limit=
 *                                               -> { models: [{ id, name, fileName, designer, fileType, printStatus, printCount, thumbnail }], total, offset }
 *   GET  /api/orca/models/:id                   -> { model }  (modelDetail: what the website's Model Details shows, pictures, print history)
 *   GET  /api/orca/spools                       -> { spools: [{ id, name, brand, material, colors, initial, remaining, available, status, where, loaded }] }
 *   GET  /api/orca/spools/:id                   -> { spool }  (spoolDetail: what the website's spool window shows)
 *   POST /api/orca/models/:id/open              -> { links: [{ name, path }] }   (OrcaSlicer opens base + path)
 *   POST /api/orca/filament-check { needs }     -> filament-check.js checkNeeds: { ready, missing, needs }
 *   GET  /api/orca/printers                     -> { printers: [{ id, name, model, serial, logsItself, direct, units: [{ slots: [{ id, label, spool, tray }] }] }] }
 *   POST /api/orca/printers/load { slotId | printerId, spoolId }  -> { printers }  (editors; spoolId null empties it)
 *   POST /api/orca/print-started { needs, modelId, printerId, deviceId, name }
 *                                               -> { status: taken | auto, eventId, used: [{ spoolId, name, grams, left }], missing }  (editors)
 *   POST /api/orca/print-started/undo { eventId | used }  -> { undone }  (editors)
 *   POST /api/orca/sliced?name=&modelId=  body  -> { fileName, status, model }    (editors)
 *   POST /api/orca/project?name=  body          -> { fileName, filePath, added }   (editors)
 *   GET  /api/orca/plugin.py                    -> the plugin file, to install in OrcaSlicer
 *
 * Opening reuses the slicer links (slicer-links.js): OrcaSlicer plugins cannot put a file on the
 * plate themselves, so the plugin hands `orcaslicer://open?file=<base + path>` to the system and
 * OrcaSlicer downloads it as it does for Open in OrcaSlicer in the browser.
 *
 * A sliced file goes into the Sliced inbox folder (sliced-inbox.js), which files it beside its
 * model and queues it. When its name matches no model, the model the plugin opened (modelId) is
 * used; otherwise it waits in the inbox like any other export.
 *
 * A project goes into the Upload folder (upload-inbox.js) and is scanned there, so it shows up as
 * Not organized, like an upload from the browser.
 */

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const database = require('../core/database');
const { version } = require('../../package.json');

const PLUGIN_FILE = path.join(__dirname, '..', '..', 'orca-plugin', 'justtprint.py');
const SLICED = /\.gcode\.3mf$/i;
const MAX_RESULTS = 60;
const MAX_NEEDS = 32;
/** What OrcaSlicer opens on the plate: other files (archives, pictures, CAD it cannot read) are left out of the search. */
const SLICER_TYPES = ['.stl', '.3mf', '.obj', '.amf', '.step', '.stp', '.svg'];

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Run a route; errors answer { error } with their status (500 when they have none). */
const route = (fn) => (req, res) => {
  res.on('finish', () => console.log(`[Orca plugin] ${req.user ? req.user.username : '?'}: ${req.method} ${req.path} ${res.statusCode}`));
  Promise.resolve()
    .then(() => fn(req, res))
    .then((body) => {
      if (body !== undefined && !res.headersSent) res.json(body);
    })
    .catch((error) => {
      const status = error.status >= 400 && error.status < 600 ? error.status : 500;
      if (status >= 500) console.warn(`[Orca plugin] ${req.method} ${req.path}: ${error.message}`);
      if (res.headersSent) return;
      if (req.readable && !req.readableEnded) req.resume();
      res.status(status).json({ error: error.message });
    });
};

/** A plain file name ending in one of `pattern`, or throws 400. */
function plainName(name, pattern, what) {
  const text = String(name || '')
    .normalize('NFC')
    .trim();
  if (!text || /[/\\\0\x00-\x1f\x7f]/.test(text) || text.startsWith('.') || text.length > 200) throw httpError(400, `Not a plain file name: ${text}`);
  if (pattern && !pattern.test(text)) throw httpError(400, `${text} is not ${what}`);
  return text;
}

/** Stream the request body into `folder` under `name` without replacing a file there. Answers the path. */
async function saveBody(req, folder, name) {
  const { maxUploadBytes, placeWithoutReplacing, writeBody } = require('./uploads');
  const temp = path.join(folder, `.justtprint-orca-${crypto.randomBytes(6).toString('hex')}.part`);
  try {
    await writeBody(req, temp, maxUploadBytes());
    return placeWithoutReplacing(temp, folder, name);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

const SORTS = {
  newest: 'm.dateAdded DESC, m.id DESC',
  oldest: 'm.dateAdded ASC, m.id ASC',
  name: "lower(coalesce(nullif(m.title, ''), m.fileName)) ASC, m.id ASC"
};
const STATUSES = ['unprinted', 'queued', 'printing', 'printed'];

/**
 * The models the plugin lists, a page at a time: what a card shows, and a small picture.
 * `sort` is newest (default), oldest or name; `status` one of STATUSES (any when missing).
 * @param {any} db
 * @param {string} query
 * @param {number} limit
 * @param {{ offset?: number, sort?: string, status?: string }} [options]
 */
function searchModels(db, query, limit, options = {}) {
  const { gridImage } = require('./grid-thumbnails');
  const words = String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  const where = ["m.filePath NOT LIKE 'url::%'", `(${SLICER_TYPES.map(() => 'lower(m.fileName) LIKE ?').join(' OR ')})`];
  /** @type {(string | number)[]} */
  const params = SLICER_TYPES.map((ext) => `%${ext}`);
  for (const word of words) {
    where.push(
      "(lower(m.fileName) LIKE ? ESCAPE '\\' OR lower(coalesce(m.title, '')) LIKE ? ESCAPE '\\' OR lower(coalesce(m.designer, '')) LIKE ? ESCAPE '\\')"
    );
    const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, like);
  }
  if (options.status && STATUSES.includes(options.status)) {
    // A model nobody marked yet counts as not printed.
    where.push(options.status === 'unprinted' ? "coalesce(m.print_status, 'unprinted') = 'unprinted'" : 'm.print_status = ?');
    if (options.status !== 'unprinted') params.push(options.status);
  }
  try {
    where.push(require('../core/model-parts').notPartSql(db));
  } catch (_) {
    /* no parts table (tests) */
  }
  const order = SORTS[options.sort] || SORTS.newest;
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM models m WHERE ${where.join(' AND ')}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT m.id, m.filePath, m.fileName, m.title, m.designer, m.print_status AS printStatus, m.print_count AS printCount FROM models m
       WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  const thumb = db.prepare('SELECT thumbnail FROM models WHERE id = ?');
  const models = rows.map((row) => {
    /** @type {string | null} */
    let thumbnail = null;
    try {
      thumbnail = gridImage(row.filePath, () => (thumb.get(row.id) || {}).thumbnail || null);
    } catch (_) {
      /* no picture */
    }
    return {
      id: row.id,
      name: row.title || row.fileName.replace(/\.[^.]+$/, ''),
      fileName: row.fileName,
      designer: row.designer || null,
      fileType: path.extname(row.fileName).slice(1).toLowerCase(),
      printStatus: row.printStatus || 'unprinted',
      printCount: Number(row.printCount) || 0,
      thumbnail: typeof thumbnail === 'string' && thumbnail.startsWith('data:image') ? thumbnail : null
    };
  });
  return { models, total, offset };
}

/** Run `fn`; `fallback` when it throws (a table a JusttPrint version or a test database lacks). */
function maybe(fn, fallback) {
  try {
    return fn();
  } catch (_) {
    return fallback;
  }
}

const MAX_PICTURES = 6;

/**
 * One model for the plugin's details window: what the website's Model Details shows (file,
 * format, size, print status, rating, designer, source, license, tags, category, folder, added),
 * its description and notes, its pictures and its print history. Null when there is none.
 */
function modelDetail(db, id) {
  const row = db.prepare("SELECT * FROM models WHERE id = ? AND filePath NOT LIKE 'url::%'").get(id);
  if (!row) return null;
  const { parseThumbnails } = require('../core/thumbnails');
  let pictures = parseThumbnails(row.thumbnail || '').filter((p) => typeof p === 'string' && p.startsWith('data:image'));
  if (!pictures.length) {
    const grid = maybe(() => require('./grid-thumbnails').gridImage(row.filePath, () => row.thumbnail || null), null);
    if (typeof grid === 'string' && grid.startsWith('data:image')) pictures = [grid];
  }
  const tags = maybe(
    () =>
      db
        .prepare('SELECT t.name FROM tags t JOIN model_tags mt ON mt.tag_id = t.id WHERE mt.model_id = ? ORDER BY lower(t.name)')
        .all(row.id)
        .map((t) => t.name),
    []
  );
  const categories = maybe(() => require('../core/categories').modelCategoryNames(row.id), []);
  const history = maybe(() => require('../core/print-events').getPrintEvents(db, row.id), []).slice(0, 50);
  let size = Number(row.size) || 0;
  if (!size) size = maybe(() => fs.statSync(row.filePath).size, 0);
  return {
    id: row.id,
    name: row.title || row.fileName.replace(/\.[^.]+$/, ''),
    fileName: row.fileName,
    folder: path.dirname(row.filePath),
    fileType: path.extname(row.fileName).slice(1).toLowerCase(),
    size: size || null,
    designer: row.designer || null,
    source: row.source || null,
    license: row.license || null,
    description: row.description || null,
    notes: row.notes || null,
    rating: Math.max(0, Math.min(5, Math.round(Number(row.rating) || 0))),
    favorite: !!row.favorite,
    printStatus: row.print_status || 'unprinted',
    printCount: Number(row.print_count) || 0,
    lastPrinted: row.last_printed_at || null,
    dateAdded: row.dateAdded || null,
    tags,
    category: categories[0] || null,
    subcategory: categories[1] || null,
    pictures: pictures.slice(0, MAX_PICTURES),
    history: history.map((e) => ({
      id: e.id,
      printedAt: e.printed_at,
      outcome: e.outcome,
      quantity: Number(e.quantity) || 1,
      notes: e.notes || null,
      printer: e.printer_nickname || null,
      duration: Number(e.duration_seconds) || null,
      spools: (e.spools || []).map((s) => ({ name: s.name, color: s.color || null, grams: Math.round((Number(s.grams) || 0) * 10) / 10 }))
    })),
    // The model's page on the website (opened in the browser from the plugin).
    page: `#/model/${encodeURIComponent(row.filePath)}`
  };
}

/** A spool's photo as a data URL the plugin can show (it has no browser sign-in), or null. */
function spoolPhoto(spool) {
  if (spool.photo_file) {
    return maybe(() => {
      const { dirFor } = require('./photos');
      const file = path.join(dirFor('spool'), path.basename(spool.photo_file));
      if (fs.statSync(file).size > 3 * 1024 * 1024) return null;
      const ext = path.extname(file).slice(1).toLowerCase();
      const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext];
      return type ? `data:${type};base64,${fs.readFileSync(file).toString('base64')}` : null;
    }, null);
  }
  return null;
}

/**
 * One spool for the plugin's details window, as the website's spool window shows it: grams left,
 * where it is, brand, material, colors, the filament's temperatures, price and shop, its
 * weighings and drying, and when it runs out. Null when there is none.
 */
function spoolDetail(db, id) {
  const spool = require('../core/spools').getSpool(db, id);
  if (!spool) return null;
  const held = maybe(
    () =>
      require('../core/filament-check')
        .availableSpools(db)
        .find((s) => s.id === spool.id),
    null
  );
  const colors = [spool.color_hex, spool.color_hex_2, spool.color_hex_3, spool.color_hex_4].filter((c) => /^#[0-9a-f]{6}$/i.test(String(c || '')));
  const range = (min, max) => (min && max && min !== max ? `${min}–${max} °C` : min || max ? `${min || max} °C` : null);
  return {
    id: spool.id,
    name: spool.display_name,
    brand: spool.brand_name || null,
    material: spool.material || null,
    materialType: spool.material_type || null,
    colors,
    colorName: spool.color_name || null,
    profile: spool.profile_name || null,
    status: spool.status,
    initial: Math.round(Number(spool.initial_weight) || 0),
    remaining: Math.round(Number(spool.remaining) || 0),
    available: held ? Math.round(held.available) : Math.round(Number(spool.remaining) || 0),
    emptySpool: spool.spool_weight === null || spool.spool_weight === undefined ? null : Math.round(Number(spool.spool_weight)),
    place: spool.location_name || null,
    loadedIn: spool.loaded.map((p) => p.label),
    printTemp: range(spool.profile_print_temp_min, spool.profile_print_temp_max),
    bedTemp: range(spool.profile_bed_temp_min, spool.profile_bed_temp_max),
    dryingTemp: spool.profile_drying_temp ? `${spool.profile_drying_temp} °C${spool.profile_drying_hours ? `, ${spool.profile_drying_hours} h` : ''}` : null,
    price: spool.purchase_price === null || spool.purchase_price === undefined ? null : Number(spool.purchase_price),
    currency: require('../core/filament-stats').currency(db),
    supplier: spool.supplier || null,
    bought: spool.purchase_date || null,
    lot: spool.lot_nr || null,
    added: spool.registered_at || null,
    lastUsed: spool.last_used_at || null,
    productUrl: spool.product_url || null,
    notes: spool.notes || null,
    photo: spoolPhoto(spool),
    forecast: spool.forecast || null,
    drying: spool.drying ? { temp: spool.drying.drying_temp, hours: spool.drying.target_hours, startedAt: spool.drying.started_at } : null,
    weighings: spool.weighings.slice(0, 10).map((w) => ({ at: w.logged_at, grams: Math.round(Number(w.net_weight) || 0), notes: w.notes || null })),
    dryings: spool.dryings.slice(0, 10).map((d) => ({
      at: d.started_at,
      temp: d.drying_temp,
      hours: d.target_hours,
      finished: !!d.finished_at,
      humidityBefore: d.humidity_before ?? null,
      humidityAfter: d.humidity_after ?? null
    })),
    page: '#/filament'
  };
}

/**
 * Every spool that is not archived, for the plugin's Filament tab: color(s), brand, grams left and
 * available (less what queued prints hold), and where it is (loaded in a printer, or its shelf).
 */
function listSpools(db) {
  const { availableSpools } = require('../core/filament-check');
  const known = new Map(availableSpools(db).map((spool) => [spool.id, spool]));
  return db
    .prepare(
      `SELECT s.id, s.name, s.material, s.material_type, s.color_hex, s.color_hex_2, s.color_hex_3, s.color_hex_4, s.initial_weight, s.used_weight,
              s.status, s.last_used_at, b.name AS brand, p.name AS profile_name
       FROM spools s LEFT JOIN filament_brands b ON b.id = s.brand_id LEFT JOIN filament_profiles p ON p.id = s.profile_id
       WHERE s.status != 'archived' ORDER BY lower(coalesce(s.material, '')), lower(coalesce(s.name, p.name, '')), s.id`
    )
    .all()
    .map((row) => {
      const spool = known.get(row.id);
      const initial = Number(row.initial_weight) || 0;
      const remaining = Math.max(0, initial - (Number(row.used_weight) || 0));
      return {
        id: row.id,
        name: spool ? spool.name : row.name || row.profile_name || row.material || 'Spool',
        brand: row.brand || null,
        material: row.material || null,
        materialType: row.material_type || null,
        colors: [row.color_hex, row.color_hex_2, row.color_hex_3, row.color_hex_4].filter((c) => /^#[0-9a-f]{6}$/i.test(String(c || ''))),
        initial: Math.round(initial),
        remaining: Math.round(remaining),
        available: spool ? Math.round(spool.available) : Math.round(remaining),
        status: row.status,
        where: spool ? spool.where : null,
        loaded: !!(spool && spool.loadedIn.length),
        lastUsed: row.last_used_at || null
      };
    });
}

/** An IPC handler the browser uses (so its side effects happen too), or null (tests). */
function ipcHandler(name) {
  try {
    return require('./runtime').ipcMain._handlers.get(name) || null;
  } catch (_) {
    return null;
  }
}

const asEvent = (req) => ({ user: req.user, sender: { send() {} } });

/** A Bambu Lab printer JusttPrint follows live logs its prints by itself when they end (printer-jobs.js). */
function logsItself(row) {
  return row.connection_type === 'bambu' && !!row.serial_number && !!row.api_url && !!row.api_secret && Number(row.auto_log ?? 1) !== 0;
}

/** Printers with the columns the plugin uses; ones a JusttPrint version lacks are null. */
function printerRows(db, where = '', params = []) {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(printers)')
      .all()
      .map((c) => c.name)
  );
  const col = (name) => (columns.has(name) ? `p.${name}` : `NULL AS ${name}`);
  return db
    .prepare(
      `SELECT p.id, p.nickname, ${col('manufacturer')}, ${col('model')}, ${col('serial_number')}, ${col('connection_type')}, ${col('status')},
              ${col('auto_log')}, ${col('api_url')}, ${col('api_secret')} FROM printers p ${where} ORDER BY lower(p.nickname), p.id`
    )
    .all(...params);
}

const slotSpool = (spool) =>
  spool
    ? {
        id: spool.id,
        name: spool.name,
        brand: spool.brand_name || null,
        material: spool.material || null,
        color: spool.color_hex || null,
        remaining: Math.round(Number(spool.remaining) || 0),
        initial: Math.round(Number(spool.initial_weight) || 0)
      }
    : null;

/**
 * Every printer with what is loaded in it (printer-ams.js): the holder on the printer itself and
 * each AMS unit's slots, with the tray the printer last reported (Bambu live status).
 */
function listPrinters(db) {
  const loads = new Map(
    require('../core/printer-ams')
      .getPrinterLoads(db)
      .map((load) => [load.printerId, load])
  );
  return printerRows(db).map((row) => {
    const load = loads.get(row.id) || { direct: null, units: [] };
    return {
      id: row.id,
      name: row.nickname,
      model: [row.manufacturer, row.model].filter(Boolean).join(' ') || null,
      serial: row.serial_number || null,
      status: row.status || null,
      logsItself: logsItself(row),
      direct: slotSpool(load.direct),
      units: load.units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        humidity: unit.humidity ?? null,
        slots: unit.slots.map((slot) => ({ id: slot.id, label: slot.label, spool: slotSpool(slot.spool), tray: slot.printer_tray || null }))
      }))
    };
  });
}

/** The printer a print went to: by id, else by the serial OrcaSlicer knows it by (device_id). */
function findPrinter(db, printerId, deviceId) {
  const id = Number(printerId);
  if (Number.isInteger(id) && id > 0) {
    const [row] = printerRows(db, 'WHERE p.id = ?', [id]);
    if (row) return row;
  }
  const serial = String(deviceId || '').trim();
  if (serial) {
    try {
      const [row] = printerRows(db, 'WHERE lower(p.serial_number) = lower(?)', [serial]);
      if (row) return row;
    } catch (_) {
      /* no serial_number column */
    }
  }
  return null;
}

/** Take grams off spools without a print to log them on (a print of no library model). */
function takeOffSpools(db, usage, sign = 1) {
  const now = new Date().toISOString();
  const take = db.prepare(
    `UPDATE spools SET used_weight = MAX(0, used_weight + ?), updated_at = ?,
       last_used_at = CASE WHEN ? > 0 THEN ? ELSE last_used_at END, first_used_at = CASE WHEN ? > 0 THEN COALESCE(first_used_at, ?) ELSE first_used_at END,
       status = CASE WHEN ? > 0 AND status = 'storage' THEN 'active' ELSE status END WHERE id = ?`
  );
  db.transaction(() => {
    for (const { spoolId, grams } of usage) take.run(sign * grams, now, sign, now, sign, now, sign, spoolId);
  })();
}

function announceSpools() {
  try {
    const events = require('./events');
    events.broadcast('filament-check-changed');
    require('./home-assistant').pushSoon();
    require('./low-stock-alerts').soon();
  } catch (_) {
    /* tests */
  }
}

/**
 * A print OrcaSlicer just sent to a printer: take its filament off the spools. The spools are the
 * filament check's picks (spools loaded in that printer first). With a library model it is logged
 * in the print history (Undo deletes it, which gives the grams back); without one the grams are
 * taken off the spools alone. A printer that logs its prints by itself is left to do that.
 */
async function printStarted(req, db) {
  const body = req.body || {};
  const needs = needsFrom(body.needs).filter((need) => need.grams);
  if (!needs.length) throw httpError(400, 'Slice the plate first: the plugin takes off the grams the slice uses');
  const printer = findPrinter(db, body.printerId, body.deviceId);
  const id = Number(body.modelId);
  const model = Number.isInteger(id) && id > 0 ? db.prepare('SELECT id, filePath, fileName, title FROM models WHERE id = ?').get(id) : null;
  const printerOut = printer ? { id: printer.id, name: printer.nickname } : null;
  const modelOut = model ? { id: model.id, name: model.title || model.fileName.replace(/\.[^.]+$/, '') } : null;
  if (printer && model && logsItself(printer)) return { status: 'auto', printer: printerOut, model: modelOut, used: [], missing: [] };

  const { availableSpools, checkNeeds } = require('../core/filament-check');
  const check = checkNeeds(needs, availableSpools(db), { printerId: printer ? printer.id : null });
  const picked = check.needs.filter((need) => need.spool && need.grams);
  const missing = check.needs.filter((need) => !need.spool).map((need) => [need.material, need.colorName].filter(Boolean).join(' '));
  if (!picked.length) throw httpError(409, 'None of your spools match the filament of this print, so nothing was taken off');
  const usage = picked.map((need) => ({ spoolId: /** @type {any} */ (need.spool).id, grams: Number(need.grams) }));
  /** @type {number | null} */
  let eventId = null;
  if (model) {
    const name = typeof body.name === 'string' ? body.name.slice(0, 120) : '';
    const payload = {
      modelId: model.id,
      filePath: model.filePath,
      outcome: 'printed',
      quantity: 1,
      printerId: printer ? printer.id : null,
      spools: usage,
      notes: `Sent from OrcaSlicer${name ? `: ${name}` : ''}.`
    };
    const handler = ipcHandler('log-print-event');
    const result = handler ? await handler(asEvent(req), payload) : require('../core/print-events').logPrintEvent(db, payload);
    eventId = Number(result && result.eventId) || null;
  } else {
    takeOffSpools(db, usage);
    announceSpools();
  }
  const left = db.prepare('SELECT initial_weight, used_weight FROM spools WHERE id = ?');
  const used = picked.map((need) => {
    const spool = /** @type {any} */ (need.spool);
    const row = left.get(spool.id) || {};
    return {
      spoolId: spool.id,
      name: spool.name,
      color: spool.color || null,
      grams: Number(need.grams),
      left: Math.max(0, Math.round((Number(row.initial_weight) || 0) - (Number(row.used_weight) || 0)))
    };
  });
  console.log(
    `[Orca plugin] ${req.user.username} printed${modelOut ? ` ${modelOut.name}` : ''}: took ${used.map((u) => `${u.grams} g off ${u.name}`).join(', ')}`
  );
  return { status: 'taken', eventId, printer: printerOut, model: modelOut, used, missing };
}

/** Undo printStarted: delete its print (which gives the grams back), or give them back. */
async function undoPrint(req, db) {
  const body = req.body || {};
  const eventId = Number(body.eventId);
  if (Number.isInteger(eventId) && eventId > 0) {
    const handler = ipcHandler('delete-print-event');
    try {
      if (handler) await handler(asEvent(req), eventId);
      else require('../core/print-events').deletePrintEvent(db, eventId);
    } catch (error) {
      throw httpError(404, `That print is no longer in the history: ${error.message}`);
    }
    return { undone: true };
  }
  const usage = require('../core/spool-usage').normalizeSpoolUsage(body.used);
  if (!usage.length) throw httpError(400, 'Nothing to give back');
  takeOffSpools(db, usage, -1);
  announceSpools();
  return { undone: true };
}

/** What the plugin sends (one entry per filament it uses) as the filament check's needs. */
function needsFrom(raw) {
  if (!Array.isArray(raw) || !raw.length) throw httpError(400, 'Send the filaments to check as needs: [{ material, color, grams }]');
  if (raw.length > MAX_NEEDS) throw httpError(400, `At most ${MAX_NEEDS} filaments`);
  return raw.map((need, i) => {
    const item = need && typeof need === 'object' ? need : {};
    const color = /^#?[0-9a-f]{6}$/i.test(String(item.color || '')) ? `#${String(item.color).replace('#', '').toLowerCase()}` : null;
    const grams = Number(item.grams);
    return {
      slot: Number.isInteger(item.slot) ? item.slot : i + 1,
      material: typeof item.material === 'string' && item.material.trim() ? item.material.trim().slice(0, 40) : null,
      color,
      grams: Number.isFinite(grams) && grams > 0 ? Math.round(grams * 10) / 10 : null,
      preset: typeof item.preset === 'string' ? item.preset.slice(0, 120) : null
    };
  });
}

function registerOrcaPluginRoutes(expressApp, { requireRole, db = () => database.db }) {
  const editor = requireRole('editor');
  const json = express.json({ limit: '64kb' });

  expressApp.get(
    '/api/orca/hello',
    route((req) => {
      const sliced = require('./sliced-inbox').inboxFolder(db());
      let uploadFolder;
      try {
        uploadFolder = require('./upload-inbox').uploadFolder() || '';
      } catch (_) {
        uploadFolder = '';
      }
      return { version, username: req.user.username, role: req.user.role, slicedInbox: !!sliced, uploadFolder: !!uploadFolder };
    })
  );

  expressApp.get(
    '/api/orca/models',
    route((req) => {
      const limit = Math.max(1, Math.min(MAX_RESULTS, Number(req.query.limit) || 30));
      const { sort, status, offset } = req.query;
      return searchModels(db(), String(req.query.q || ''), limit, { sort: String(sort || ''), status: String(status || ''), offset: Number(offset) || 0 });
    })
  );

  expressApp.get(
    '/api/orca/spools',
    route(() => ({ spools: listSpools(db()) }))
  );

  expressApp.get(
    '/api/orca/spools/:id',
    route((req) => {
      const spool = Number.isInteger(Number(req.params.id)) ? spoolDetail(db(), Number(req.params.id)) : null;
      if (!spool) throw httpError(404, 'That spool is not in JusttPrint any more');
      return { spool };
    })
  );

  expressApp.get(
    '/api/orca/models/:id',
    route((req) => {
      const model = Number.isInteger(Number(req.params.id)) ? modelDetail(db(), Number(req.params.id)) : null;
      if (!model) throw httpError(404, 'That model is not in the library any more');
      return { model };
    })
  );

  expressApp.post(
    '/api/orca/models/:id/open',
    route((req) => {
      const id = Number(req.params.id);
      const model = Number.isInteger(id) ? db().prepare('SELECT id, filePath FROM models WHERE id = ?').get(id) : null;
      if (!model) throw httpError(404, 'That model is no longer in the library');
      if (String(model.filePath).startsWith('url::')) throw httpError(400, 'That model is a link to a site, with no file to open');
      const { issueSlicerFileLinks } = require('./slicer-links');
      const links = issueSlicerFileLinks([model.filePath]).map((link) => ({
        name: link.name,
        path: `/api/slicer-file/${link.token}/${encodeURIComponent(link.name)}`
      }));
      return { modelId: model.id, links };
    })
  );

  expressApp.post(
    '/api/orca/filament-check',
    json,
    route((req) => {
      const { availableSpools, checkNeeds } = require('../core/filament-check');
      const needs = needsFrom(req.body && req.body.needs);
      const spools = availableSpools(db());
      return { spools: spools.length, ...checkNeeds(needs, spools) };
    })
  );

  expressApp.get(
    '/api/orca/printers',
    route(() => ({ printers: listPrinters(db()) }))
  );

  expressApp.post(
    '/api/orca/printers/load',
    editor,
    json,
    route(async (req) => {
      const body = req.body || {};
      const where = Number(body.slotId) > 0 ? { slotId: Number(body.slotId) } : Number(body.printerId) > 0 ? { printerId: Number(body.printerId) } : null;
      if (!where) throw httpError(400, 'Say which slot (slotId) or printer holder (printerId)');
      const spoolId = Number(body.spoolId) > 0 ? Number(body.spoolId) : null;
      const handler = ipcHandler('set-loaded-spool');
      try {
        if (handler) await handler(asEvent(req), where, spoolId);
        else require('../core/printer-ams').loadSpool(db(), where, spoolId);
      } catch (error) {
        throw httpError(400, error.message);
      }
      return { printers: listPrinters(db()) };
    })
  );

  expressApp.post(
    '/api/orca/print-started',
    editor,
    json,
    route((req) => printStarted(req, db()))
  );
  expressApp.post(
    '/api/orca/print-started/undo',
    editor,
    json,
    route((req) => undoPrint(req, db()))
  );

  expressApp.post(
    '/api/orca/sliced',
    editor,
    route(async (req) => {
      const inbox = require('./sliced-inbox');
      const folder = inbox.inboxFolder(db());
      if (!folder) throw httpError(409, 'Choose the Sliced inbox folder in JusttPrint first: Print Queue → Sliced inbox');
      const name = plainName(req.query.name, SLICED, 'a sliced project (.gcode.3mf)');
      if (!fs.existsSync(folder)) throw httpError(409, `The Sliced inbox folder is missing: ${folder}`);
      const saved = await saveBody(req, folder, name);
      const fileName = path.basename(saved);
      console.log(`[Orca plugin] ${req.user.username} sent ${fileName} to the Sliced inbox`);
      // The file is whole: look now instead of waiting for it to settle.
      await inbox.checkInbox(db(), { now: Date.now() + 60 * 1000 });
      let row = db()
        .prepare("SELECT id, status, model_id FROM sliced_inbox WHERE file_name = ? AND status IN ('waiting', 'filed') ORDER BY id DESC")
        .get(fileName);
      const hint = Number(req.query.modelId);
      if (row && row.status === 'waiting' && Number.isInteger(hint) && hint > 0) {
        const model = db().prepare('SELECT filePath FROM models WHERE id = ?').get(hint);
        if (model) {
          try {
            await inbox.fileWaiting(db(), row.id, model.filePath);
            row = db().prepare('SELECT id, status, model_id FROM sliced_inbox WHERE id = ?').get(row.id) || row;
          } catch (error) {
            console.warn(`[Orca plugin] Could not file ${fileName} with model ${hint}: ${error.message}`);
          }
        }
      }
      const model = row && row.model_id ? db().prepare('SELECT id, fileName, title FROM models WHERE id = ?').get(row.model_id) : null;
      return {
        fileName,
        status: row ? row.status : 'waiting',
        model: model ? { id: model.id, name: model.title || model.fileName.replace(/\.[^.]+$/, '') } : null
      };
    })
  );

  expressApp.post(
    '/api/orca/project',
    editor,
    route(async (req) => {
      const { allowedUploadExtensions, checkUploadName } = require('./uploads');
      let folder;
      try {
        folder = require('./upload-inbox').requireUploadFolder();
      } catch (error) {
        throw httpError(409, error.message);
      }
      let name;
      try {
        name = checkUploadName(req.query.name, allowedUploadExtensions());
      } catch (error) {
        throw httpError(400, error.message);
      }
      const filePath = await saveBody(req, folder, name);
      console.log(`[Orca plugin] ${req.user.username} saved ${filePath} to the Upload folder`);
      let added = false;
      const scan = require('./runtime').ipcMain._handlers.get('add-uploaded-files');
      if (scan) {
        try {
          const result = await scan({ user: req.user, sender: { send() {} } }, folder, [filePath]);
          added = !!(result && result.inLibrary);
        } catch (error) {
          console.warn(`[Orca plugin] Scanning ${filePath}: ${error.message}`);
        }
      }
      return { fileName: path.basename(filePath), filePath, added };
    })
  );

  expressApp.get('/api/orca/plugin.py', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="justtprint.py"');
    res.type('text/x-python').sendFile(PLUGIN_FILE, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: 'The plugin file is missing from this install' });
    });
  });
}

module.exports = { registerOrcaPluginRoutes, needsFrom, plainName, searchModels, modelDetail, listSpools, spoolDetail, listPrinters };
