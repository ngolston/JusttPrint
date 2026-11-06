'use strict';

/**
 * The sliced-files inbox (the Print Queue page): a folder OrcaSlicer exports sliced projects to
 * (Export plate sliced file, or Export all sliced files). Each new .gcode.3mf there is matched to
 * its model by name, moved into the model's folder (where Send finds it, bambu-send.js
 * slicedFilesFor) and the model is queued. A file no model matches, or several do, waits in the
 * folder until someone chooses its model (or ignores it).
 *
 * OrcaSlicer names exports after the project, often with the plate, the filament and the print
 * time added ("Gear_plate_1.gcode.3mf", "Gear_PLA_1h23m.gcode.3mf"): the name is tried whole,
 * then with those endings taken off one at a time, and the first that names one model wins.
 *
 * The folder is watched (fs.watch) and read again every minute (network shares report no
 * changes). A file still being written (changed in the last few seconds) waits for the next look.
 */

const fs = require('fs');
const path = require('path');
const database = require('../core/database');

const FOLDER_SETTING = 'slicedInboxFolder';
const SLICED = /\.gcode\.3mf$/i;
/** A file changed this recently is probably still being written. */
const SETTLE_MS = 5000;
const POLL_MS = 60 * 1000;
/** Filed and ignored files listed, newest first. */
const KEEP_DONE = 30;
const MATERIALS = new Set([
  'pla',
  'petg',
  'pet',
  'abs',
  'asa',
  'tpu',
  'tpe',
  'pa',
  'pa6',
  'pa12',
  'paht',
  'pc',
  'pva',
  'bvoh',
  'hips',
  'pp',
  'ppa',
  'pps',
  'cf',
  'gf',
  'silk',
  'matte',
  'basic',
  'plus',
  'support',
  'generic'
]);
const TIME = /^(?=\d)(\d+d)?(\d+h)?(\d+m)?(\d+s)?$/;

const nowIso = () => new Date().toISOString();

/** Lower-case words: accents, punctuation and the extension gone ("Gear_v2 (1).stl" → "gear v2 1"). */
function words(name) {
  return String(name || '')
    .replace(SLICED, '')
    .replace(/\.(stl|3mf|obj|step|stp|amf|ply|zip)$/i, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The names to try for a sliced file, most exact first: the whole name, then without the
 * endings OrcaSlicer adds (plate, filament, print time, a copy number), one at a time.
 * @param {string} fileName
 */
function namesToTry(fileName) {
  const tokens = words(fileName).split(' ').filter(Boolean);
  const out = [];
  const add = () => {
    const name = tokens.join(' ');
    if (name && !out.includes(name)) out.push(name);
  };
  add();
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    const before = tokens[tokens.length - 2];
    if (/^plate\d+$/.test(last) || MATERIALS.has(last) || TIME.test(last)) tokens.pop();
    else if (/^\d+$/.test(last) && before === 'plate') tokens.splice(-2, 2);
    else if (/^\d+$/.test(last)) tokens.pop();
    else break;
    add();
  }
  return out;
}

/** The inbox folder (no trailing separator), or ''. */
function inboxFolder(db = database.db) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(FOLDER_SETTING);
    return row && row.value
      ? String(row.value)
          .trim()
          .replace(/[\\/]+$/, '')
      : '';
  } catch (_) {
    return '';
  }
}

const inside = (child, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * Choose the inbox folder ('' turns the inbox off). It must exist, and be outside the STL Home
 * folders (the library would scan the files waiting in it as models of their own).
 * @param {any} db
 * @param {string} folder
 * @param {{ homes?: string[] }} [options]
 */
function setInboxFolder(db, folder, options = {}) {
  const chosen = String(folder || '')
    .trim()
    .replace(/[\\/]+$/, '');
  if (chosen) {
    if (!path.isAbsolute(chosen)) throw new Error('Give the whole path of the folder, from the top (such as /sliced)');
    let stat;
    try {
      stat = fs.statSync(chosen);
    } catch (error) {
      throw new Error(`There is no folder ${chosen} here. In Docker, mount it into the container first.`, { cause: error });
    }
    if (!stat.isDirectory()) throw new Error(`${chosen} is a file, not a folder`);
    const homes = options.homes || require('../core/library-paths').readStlHomeDirectories();
    const home = homes.find((dir) => dir && (inside(chosen, dir) || inside(dir, chosen)));
    if (home) throw new Error(`Choose a folder outside your STL Home folder ${home}: the library would add the files waiting there as models.`);
  }
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(FOLDER_SETTING, chosen);
  restart();
  return { folder: chosen };
}

/**
 * The model a sliced file belongs to: { model } when one matches, else { model: null, why,
 * suggestions } (the closest models, for choosing).
 * @param {any} db
 * @param {string} fileName
 * @param {string} [folder] the inbox (models in it are not candidates)
 */
function matchModel(db, fileName, folder = '') {
  const tries = namesToTry(fileName);
  const rows = db
    .prepare(
      `SELECT m.id, m.filePath, m.fileName, m.title, m.print_status,
         EXISTS (SELECT 1 FROM print_queue q WHERE q.model_id = m.id) AS queued
       FROM models m WHERE m.filePath NOT LIKE '%::%'`
    )
    .all()
    .filter((row) => !folder || !inside(row.filePath, folder));
  /** @type {Map<string, any[]>} */
  const byName = new Map();
  for (const row of rows) {
    for (const name of new Set([words(row.fileName || path.basename(row.filePath)), words(row.title)])) {
      if (!name) continue;
      const list = byName.get(name) || [];
      list.push(row);
      byName.set(name, list);
    }
  }
  for (const name of tries) {
    let found = byName.get(name);
    if (!found || !found.length) continue;
    found = [...new Map(found.map((row) => [row.id, row])).values()];
    // A sliced file already filed beside a model is a model too: the model itself first.
    const plain = found.filter((row) => !SLICED.test(row.filePath));
    if (plain.length) found = plain;
    if (found.length > 1) {
      const queued = found.filter((row) => row.queued);
      if (queued.length === 1) found = queued;
    }
    if (found.length === 1) return { model: found[0] };
    return { model: null, why: `${found.length} models are named like it: choose one`, suggestions: found.slice(0, 8).map(choice) };
  }
  // The closest: models whose name starts the file's name, or is started by it.
  const base = tries[tries.length - 1];
  const close = [];
  for (const [name, list] of byName) {
    if (name.length >= 3 && (base.startsWith(`${name} `) || name.startsWith(`${base} `))) close.push(...list);
  }
  const suggestions = [...new Map(close.filter((row) => !SLICED.test(row.filePath)).map((row) => [row.id, row])).values()].slice(0, 8).map(choice);
  return { model: null, why: 'No model has this name: choose one', suggestions };
}

const choice = (row) => ({
  filePath: row.filePath,
  name: (row.title && String(row.title).trim()) || String(row.fileName || path.basename(row.filePath)).replace(/(\.gcode)?\.[^.]+$/i, '')
});

/** Up to 20 models whose title or file name has the text, for choosing one by hand. */
function findModels(db, text) {
  const needle = String(text || '').trim();
  if (needle.length < 2) return [];
  const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .prepare(
      `SELECT filePath, fileName, title FROM models
       WHERE filePath NOT LIKE '%::%' AND filePath NOT LIKE '%.gcode.3mf' AND (title LIKE ? ESCAPE '\\' OR fileName LIKE ? ESCAPE '\\')
       ORDER BY COALESCE(NULLIF(title, ''), fileName) COLLATE NOCASE LIMIT 20`
    )
    .all(like, like)
    .map(choice);
}

/** Move a file, copying across disks (a mounted share and the library may be different ones). */
async function moveFile(from, to) {
  try {
    await fs.promises.rename(from, to);
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
    await fs.promises.copyFile(from, to);
    await fs.promises.unlink(from);
  }
}

/**
 * Move a sliced file from the inbox into its model's folder (replacing an earlier export of the
 * same name) and queue the model, unless it already is. Returns the row's new fields.
 * @param {any} db
 * @param {string} source the file in the inbox
 * @param {{ id: number, filePath: string }} model
 */
async function fileInto(db, source, model) {
  const target = path.join(path.dirname(model.filePath), path.basename(source));
  await moveFile(source, target);
  let queued = 0;
  /** @type {string | null} */
  let message = null;
  const queue = require('../core/print-queue');
  if (db.prepare('SELECT 1 FROM print_queue WHERE model_id = ?').get(model.id)) {
    message = 'It was already in the queue';
  } else {
    let plate = null;
    try {
      const plates = await require('./bambu-send').slicedPlates(target);
      if (plates.length === 1) plate = plates[0].index;
    } catch (_) {
      /* unreadable: every plate */
    }
    try {
      queue.addToQueue(db, model.id, { plate });
    } catch (_) {
      queue.addToQueue(db, model.id, { plate: null });
    }
    queued = 1;
  }
  return { filed_path: target, queued, message };
}

function announce(db, row, modelRow) {
  try {
    require('./events').broadcast('models-changed', { filePaths: modelRow ? [modelRow.filePath] : [], by: null });
    require('./events').broadcast('sliced-inbox-changed');
  } catch (_) {
    /* no browsers */
  }
  try {
    const name = modelRow ? choice(modelRow).name : row.file_name;
    require('./notifications').notify({
      title: modelRow ? `Sliced and queued: ${name}` : `Choose the model for ${row.file_name}`,
      body: modelRow
        ? `${row.file_name} is filed beside the model${row.queued ? ' and the model is in the print queue' : ''}.`
        : 'It is waiting in the sliced-files inbox on the Print Queue page.',
      level: modelRow ? 'success' : 'info',
      link: '#/queue',
      minRole: 'editor',
      key: `sliced-inbox:${row.file_name}:${row.modified_ms}`
    });
  } catch (_) {
    /* notifications not ready */
  }
}

/** @type {Promise<{ filed: number, waiting: number }> | null} */
let running = null;

/**
 * Look at the inbox once: file every new sliced file that matches a model, list the others.
 * Returns { filed, waiting }.
 * @param {any} [db]
 * @param {{ now?: number }} [options]
 */
function checkInbox(db = database.db, options = {}) {
  if (running) return running;
  running = (async () => {
    try {
      return await check(db, options.now || Date.now());
    } finally {
      running = null;
    }
  })();
  return running;
}

async function check(db, now) {
  const folder = inboxFolder(db);
  if (!folder) return { filed: 0, waiting: 0 };
  let names;
  try {
    names = (await fs.promises.readdir(folder)).filter((name) => SLICED.test(name) && !name.startsWith('.'));
  } catch (error) {
    lastError = `Cannot read ${folder}: ${error.code || error.message}`;
    return { filed: 0, waiting: 0 };
  }
  lastError = null;
  const present = new Set(names);
  // Waiting files that are gone (moved or deleted by hand) leave the list.
  for (const row of db.prepare("SELECT id, file_name FROM sliced_inbox WHERE status = 'waiting'").all()) {
    if (!present.has(row.file_name)) db.prepare('DELETE FROM sliced_inbox WHERE id = ?').run(row.id);
  }
  let filed = 0;
  for (const name of names) {
    const source = path.join(folder, name);
    let stat;
    try {
      stat = await fs.promises.stat(source);
    } catch (_) {
      continue;
    }
    if (!stat.isFile() || now - stat.mtimeMs < SETTLE_MS) continue;
    const modified = Math.round(stat.mtimeMs);
    const known = db
      .prepare("SELECT id FROM sliced_inbox WHERE file_name = ? AND modified_ms = ? AND size = ? AND status IN ('waiting', 'ignored')")
      .get(name, modified, stat.size);
    if (known) continue;
    db.prepare("DELETE FROM sliced_inbox WHERE file_name = ? AND status IN ('waiting', 'ignored')").run(name);
    const match = matchModel(db, name, folder);
    /** @type {{ file_name: string, size: number, modified_ms: number, queued: number, message: string | null, filed_path?: string }} */
    const row = { file_name: name, size: stat.size, modified_ms: modified, queued: 0, message: null };
    if (!match.model) {
      row.message = match.why || null;
      db.prepare(
        "INSERT INTO sliced_inbox (file_name, size, modified_ms, status, message, seen_at) VALUES (@file_name, @size, @modified_ms, 'waiting', @message, @seen_at)"
      ).run({ ...row, seen_at: nowIso() });
      announce(db, row, null);
      continue;
    }
    try {
      Object.assign(row, await fileInto(db, source, match.model));
      db.prepare(
        `INSERT INTO sliced_inbox (file_name, size, modified_ms, status, model_id, filed_path, queued, message, seen_at, filed_at)
         VALUES (@file_name, @size, @modified_ms, 'filed', @model_id, @filed_path, @queued, @message, @at, @at)`
      ).run({ ...row, model_id: match.model.id, at: nowIso() });
      filed += 1;
      announce(db, row, match.model);
    } catch (error) {
      console.warn(`[Inbox] Could not file ${name}:`, error.message);
      db.prepare("INSERT INTO sliced_inbox (file_name, size, modified_ms, status, message, seen_at) VALUES (?, ?, ?, 'waiting', ?, ?)").run(
        name,
        stat.size,
        modified,
        `Could not move it beside ${choice(match.model).name}: ${error.message}`,
        nowIso()
      );
    }
  }
  prune(db);
  return { filed, waiting: db.prepare("SELECT COUNT(*) AS n FROM sliced_inbox WHERE status = 'waiting'").get().n };
}

function prune(db) {
  db.prepare(
    `DELETE FROM sliced_inbox WHERE status IN ('filed', 'ignored') AND id NOT IN (
       SELECT id FROM sliced_inbox WHERE status IN ('filed', 'ignored') ORDER BY id DESC LIMIT ${KEEP_DONE})`
  ).run();
}

/**
 * File a waiting file under the model chosen for it.
 * @param {any} db
 * @param {number} id
 * @param {string} modelPath
 */
async function fileWaiting(db, id, modelPath) {
  const row = db.prepare("SELECT * FROM sliced_inbox WHERE id = ? AND status = 'waiting'").get(Number(id));
  if (!row) throw new Error('That file is no longer waiting');
  const model = db.prepare("SELECT id, filePath, fileName, title FROM models WHERE filePath = ? AND filePath NOT LIKE '%::%'").get(String(modelPath || ''));
  if (!model) throw new Error('Choose a model in the library (not one inside a ZIP file)');
  const folder = inboxFolder(db);
  const source = path.join(folder, row.file_name);
  if (!folder || !fs.existsSync(source)) {
    db.prepare('DELETE FROM sliced_inbox WHERE id = ?').run(row.id);
    throw new Error(`${row.file_name} is no longer in the inbox folder`);
  }
  const done = await fileInto(db, source, model);
  db.prepare("UPDATE sliced_inbox SET status = 'filed', model_id = ?, filed_path = ?, queued = ?, message = ?, filed_at = ? WHERE id = ?").run(
    model.id,
    done.filed_path,
    done.queued,
    done.message,
    nowIso(),
    row.id
  );
  announce(db, { ...row, ...done }, model);
  return { ...done, model: choice(model) };
}

/** Leave a waiting file in the folder, off the list (until it changes). */
function ignoreWaiting(db, id) {
  const changes = db.prepare("UPDATE sliced_inbox SET status = 'ignored', filed_at = ? WHERE id = ? AND status = 'waiting'").run(nowIso(), Number(id)).changes;
  if (!changes) throw new Error('That file is no longer waiting');
  require('./events').broadcast('sliced-inbox-changed');
}

/** What the Print Queue page shows: the folder, and the files waiting and filed lately. */
function inboxStatus(db = database.db) {
  const folder = inboxFolder(db);
  const rows = db
    .prepare(
      `SELECT i.*, m.filePath, m.fileName, m.title FROM sliced_inbox i LEFT JOIN models m ON m.id = i.model_id
       WHERE i.status IN ('waiting', 'filed') ORDER BY i.status = 'waiting' DESC, i.id DESC LIMIT 40`
    )
    .all();
  return {
    folder,
    error: folder ? lastError : null,
    items: rows.map((row) => {
      /** @type {Record<string, any>} */
      const item = {
        id: row.id,
        fileName: row.file_name,
        status: row.status,
        message: row.message || null,
        queued: !!row.queued,
        at: row.filed_at || row.seen_at,
        model: row.filePath ? choice(row) : null,
        suggestions: []
      };
      if (row.status === 'waiting') item.suggestions = matchModel(db, row.file_name, folder).suggestions || [];
      return item;
    })
  };
}

// ---- Watching ----

/** @type {string | null} */
let lastError = null;
/** @type {fs.FSWatcher | null} */
let watcher = null;
/** @type {ReturnType<typeof setInterval> | null} */
let poll = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let soonTimer = null;

function soon(delay = SETTLE_MS + 1000) {
  if (soonTimer) clearTimeout(soonTimer);
  const timer = setTimeout(() => {
    soonTimer = null;
    checkInbox().catch((error) => console.warn('[Inbox]', error.message));
  }, delay);
  timer.unref?.();
  soonTimer = timer;
}

function start() {
  stop();
  const folder = inboxFolder();
  if (!folder) return;
  try {
    watcher = fs.watch(folder, { persistent: false }, (type, name) => {
      if (!name || SLICED.test(String(name))) soon();
    });
    watcher.on('error', () => {
      if (watcher) watcher.close();
      watcher = null;
    });
  } catch (_) {
    /* a share that reports nothing: the timed look covers it */
  }
  const every = setInterval(() => checkInbox().catch((error) => console.warn('[Inbox]', error.message)), POLL_MS);
  every.unref?.();
  poll = every;
  soon(2000);
}

function stop() {
  if (watcher) watcher.close();
  watcher = null;
  if (poll) clearInterval(poll);
  poll = null;
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = null;
}

function restart() {
  if (database.db) start();
}

module.exports = {
  FOLDER_SETTING,
  words,
  namesToTry,
  matchModel,
  findModels,
  inboxFolder,
  setInboxFolder,
  checkInbox,
  fileWaiting,
  ignoreWaiting,
  inboxStatus,
  start,
  stop
};
