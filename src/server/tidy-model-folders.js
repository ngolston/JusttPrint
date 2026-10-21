'use strict';

/**
 * Tidy Into Model Folders (Organize): give each model already in the library a folder of its
 * own, as uploads and downloads get (model-folders.js). A preview first, then the moves.
 *
 * A model is one file, or the files that belong together in one folder: the print profiles of one
 * site model (site_files), or the files with the same parent model. In each folder:
 * - a folder that is a model folder already is left alone;
 * - a folder holding one model only (and not a library folder itself) becomes that model's
 *   folder where it is, nothing moves;
 * - otherwise each model moves into a new folder named after it, next to where it was.
 * Pictures, videos and documents beside a model with its name ("Benchy.png" next to
 * "Benchy.stl") go along into its image, video and document folders. Files inside ZIP files and
 * links without a file are skipped. With `covers`, a model's first thumbnail is saved as
 * image/cover.<type> when its folder has no picture, and becomes the cover.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const database = require('../core/database');
const modelFolders = require('./model-folders');

const SAMPLE = 200;

const escapeLike = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
const stemOf = (name) => path.basename(name, path.extname(name));

/** The site model a file was downloaded for (site_files key), or null. */
function siteKeyOf(filePath) {
  try {
    const row = require('./site-details').siteFilesTable().prepare('SELECT key FROM site_files WHERE file_path = ?').get(filePath);
    return row ? row.key : null;
  } catch (_) {
    return null;
  }
}

/** A site model's title (English when kept), or null. */
function siteTitle(key) {
  try {
    const row = require('./site-details').siteFilesTable().prepare('SELECT data FROM site_details WHERE key = ?').get(key);
    const details = row ? JSON.parse(row.data) : null;
    return (details && (details.titleEnglish || details.title)) || null;
  } catch (_) {
    return null;
  }
}

/**
 * The plan: { groups: [{ id, name, folder, action: 'move' | 'register', files, media }], already,
 * skipped: { zip, link, missing } }. `files` are model files; `media` pictures, videos and
 * documents that go along. `under` limits it to one folder (and its subfolders).
 * @param {{ under?: string | null, roots?: string[] | null }} [options]
 */
function plan({ under = null, roots = null } = {}) {
  const libraryRoots = (roots || require('./path-context').networkPathContext().roots || []).map((root) => modelFolders.folderKey(root));
  const rows = database.db
    .prepare(
      under
        ? "SELECT filePath, fileName, parentModel FROM models WHERE filePath LIKE ? ESCAPE '\\' ORDER BY filePath"
        : 'SELECT filePath, fileName, parentModel FROM models ORDER BY filePath'
    )
    .all(...(under ? [`${escapeLike(modelFolders.folderKey(under))}${path.sep}%`] : []));
  const skipped = { zip: 0, link: 0, missing: 0 };
  /** @type {Map<string, any[]>} */
  const byFolder = new Map();
  for (const row of rows) {
    const filePath = String(row.filePath || '');
    if (filePath.startsWith('url::')) {
      skipped.link++;
      continue;
    }
    if (filePath.includes('::')) {
      skipped.zip++;
      continue;
    }
    if (!fs.existsSync(filePath)) {
      skipped.missing++;
      continue;
    }
    const dir = path.dirname(filePath);
    if (!byFolder.has(dir)) byFolder.set(dir, []);
    /** @type {any[]} */ (byFolder.get(dir)).push(row);
  }

  const groups = [];
  let already = 0;
  for (const [dir, files] of byFolder) {
    if (modelFolders.isModelFolder(dir) || modelFolders.isMediaFolder(dir)) {
      already += files.length;
      continue;
    }
    // The models in this folder: a site model's profiles, or files with one parent model, together.
    /** @type {Map<string, { name: string, files: string[] }>} */
    const models = new Map();
    for (const row of files) {
      const site = siteKeyOf(row.filePath);
      const parent = String(row.parentModel || '').trim();
      const key = site ? `site:${site}` : parent ? `parent:${parent.toLowerCase()}` : `file:${row.filePath}`;
      if (!models.has(key)) models.set(key, { name: (site && siteTitle(site)) || parent || stemOf(row.filePath), files: [] });
      /** @type {{ files: string[] }} */ (models.get(key)).files.push(row.filePath);
    }
    let onDisk = [];
    try {
      onDisk = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.startsWith('.'));
    } catch (_) {
      /* gone meanwhile */
    }
    const media = onDisk.map((entry) => entry.name).filter((name) => modelFolders.kindOf(name));
    const isRoot = libraryRoots.includes(modelFolders.folderKey(dir));
    if (models.size === 1 && !isRoot) {
      const [only] = models.values();
      groups.push({ id: idFor(dir, 'here'), name: path.basename(dir), folder: dir, action: 'register', files: only.files, media });
      continue;
    }
    // Several models (or a library folder): each into a folder of its own, beside where it was.
    const taken = new Set(onDisk.map((entry) => entry.name.toLowerCase()));
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) taken.add(entry.name.toLowerCase());
    const claimed = new Set();
    for (const [key, model] of models) {
      const stems = model.files.map((file) => stemOf(file).toLowerCase());
      const along = media.filter((name) => {
        const stem = stemOf(name).toLowerCase();
        return !claimed.has(name) && stems.some((s) => stem === s || stem.startsWith(`${s} `) || stem.startsWith(`${s}_`) || stem.startsWith(`${s}-`));
      });
      along.forEach((name) => claimed.add(name));
      groups.push({ id: idFor(dir, key), name: folderNameFor(model.name, taken), folder: dir, action: 'move', files: model.files, media: along });
    }
  }
  return { groups, already, skipped };
}

const idFor = (dir, key) => crypto.createHash('sha1').update(`${dir}\0${key}`).digest('hex').slice(0, 16);

/** A folder name not taken in the folder (and kept as taken). */
function folderNameFor(name, taken) {
  const { folderName } = require('../core/makerworld');
  const base = folderName(name) || 'Model';
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base} (${n})`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }
  return `${base} ${Date.now()}`;
}

/** The preview the page shows: counts and the first moves. */
function preview(options = {}) {
  const { groups, already, skipped } = plan(options);
  const moves = groups.filter((g) => g.action === 'move');
  const here = groups.filter((g) => g.action === 'register');
  return {
    moveCount: moves.length,
    registerCount: here.length,
    fileCount: groups.reduce((sum, g) => sum + g.files.length + g.media.length, 0),
    already,
    skipped,
    sample: groups.slice(0, SAMPLE).map((g) => ({
      id: g.id,
      action: g.action,
      from: g.folder,
      to: g.action === 'move' ? path.join(g.folder, g.name) : g.folder,
      files: g.files.map((f) => path.basename(f)),
      media: g.media
    }))
  };
}

/** Move a file without replacing anything; across disks by copying. Answers where it went. */
function moveFile(from, toFolder) {
  const { placeWithoutReplacing } = require('./uploads');
  fs.mkdirSync(toFolder, { recursive: true });
  const temp = path.join(toFolder, `.justtprint-tidy-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.renameSync(from, temp);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(from, temp);
    fs.unlinkSync(from);
  }
  return placeWithoutReplacing(temp, toFolder, path.basename(from));
}

/** A data URL as a file, or null when it is not a picture. */
function writeDataUrl(dataUrl, folder, stem) {
  const match = /^data:image\/(png|jpeg|webp|gif|avif|bmp);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!match) return null;
  const ext = match[1] === 'jpeg' ? '.jpg' : `.${match[1]}`;
  fs.mkdirSync(folder, { recursive: true });
  const { placeWithoutReplacing } = require('./uploads');
  const temp = path.join(folder, `.justtprint-cover-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(temp, Buffer.from(match[2], 'base64'));
  return path.basename(placeWithoutReplacing(temp, folder, `${stem}${ext}`));
}

/**
 * Carry out the plan (worked out again here, not taken from the browser): every model, or the
 * ones with the ids in `only`. Answers { moved, registered, files, failed: [{ name, error }] }.
 * @param {{ under?: string | null, only?: string[] | null, covers?: boolean, roots?: string[] | null }} [options]
 */
async function apply({ under = null, only = null, covers = false, roots = null } = {}) {
  const { groups } = plan({ under, roots });
  const wanted = Array.isArray(only) ? new Set(only.map(String)) : null;
  const result = { moved: 0, registered: 0, files: 0, folders: /** @type {string[]} */ ([]), failed: /** @type {{ name: string, error: string }[]} */ ([]) };
  const updatePath = database.db.prepare('UPDATE models SET filePath = ?, fileName = ? WHERE filePath = ?');
  const siteFiles = require('./site-details').siteFilesTable();
  const updateSite = siteFiles.prepare('UPDATE site_files SET file_path = ? WHERE file_path = ?');
  const todo = groups.filter((group) => !wanted || wanted.has(group.id));
  const activity = require('./activity');
  const jobId = activity.start('move', 'Tidying into model folders', { unit: 'models', total: todo.length });
  let doneCount = 0;
  for (const group of todo) {
    activity.update(jobId, { done: doneCount++, detail: group.name });
    try {
      const target = group.action === 'move' ? modelFolders.makeFolder(group.folder, group.name) : modelFolders.register(group.folder);
      if (group.action === 'move') {
        for (const filePath of group.files) {
          const to = moveFile(filePath, target);
          // Right after the move, so a rescan (folder watching) finds the model where it went.
          database.db.transaction(() => {
            updatePath.run(to, path.basename(to), filePath);
            updateSite.run(to, filePath);
          })();
          result.files++;
        }
      }
      for (const name of group.media) {
        const kind = /** @type {'image' | 'video' | 'document'} */ (modelFolders.kindOf(name));
        moveFile(path.join(group.folder, name), path.join(target, modelFolders.KINDS[kind].dir));
        result.files++;
      }
      if (covers && !modelFolders.getMedia(target).image.length) {
        const row = database.db.prepare('SELECT thumbnail FROM models WHERE filePath = ?').get(path.join(target, path.basename(group.files[0])));
        const first = row && row.thumbnail ? String(row.thumbnail).split('::')[0] : null;
        if (first) writeDataUrl(first, path.join(target, 'image'), 'cover');
      }
      await modelFolders.coverIfNone(target).catch(() => {});
      result.folders.push(target);
      if (group.action === 'move') result.moved++;
      else result.registered++;
    } catch (error) {
      result.failed.push({ name: group.name, error: error.message });
    }
  }
  activity.finish(jobId);
  const events = require('./events');
  events.broadcast('refresh-grid');
  console.log(`[Tidy] ${result.moved} model(s) moved into folders of their own, ${result.registered} kept where they are, ${result.failed.length} failed`);
  return result;
}

/**
 * A model page's Upload: the model's own folder, made first when it has none (the same as Tidy for
 * this one model: kept where it is when alone in its folder, else moved into a new folder named
 * after it, with the files that belong to it). Answers { folder, filePath: where the model is now, moved }.
 * @param {string} filePath
 * @param {{ roots?: string[] | null }} [options]
 */
async function ownFolder(filePath, { roots = null } = {}) {
  const text = String(filePath || '');
  if (!text || text.startsWith('url::') || text.includes('::'))
    throw new Error('Only a model with a file of its own can have a folder (not a link, not a file inside a ZIP)');
  const already = modelFolders.folderOfFile(text);
  if (already) return { folder: already, filePath: text, moved: false };
  if (!fs.existsSync(text)) throw new Error(`The model's file is missing: ${text}`);
  const dir = path.dirname(text);
  const group = plan({ under: dir, roots }).groups.find((g) => g.folder === dir && g.files.includes(text));
  if (!group) throw new Error('This model cannot have a folder of its own here');
  const result = await apply({ under: dir, only: [group.id], roots });
  if (result.failed.length || !result.folders.length) throw new Error((result.failed[0] && result.failed[0].error) || 'Could not make a folder for the model');
  const folder = result.folders[0];
  const moved = group.action === 'move';
  return { folder, filePath: moved ? path.join(folder, path.basename(text)) : text, moved };
}

module.exports = { apply, ownFolder, plan, preview };
