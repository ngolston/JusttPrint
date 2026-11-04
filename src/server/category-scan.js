'use strict';

/**
 * Categorize Library (the Categories page): gives every model without one its place, a Category
 * and a Subcategory (categories.js). First the category its site gives it (MakerWorld uses this
 * very list, so its models are placed for free). Then, with the AI, the AI service set up for AI
 * Tagging looks at each remaining model's picture and picks its Category and Subcategory, saved
 * right away; models placed earlier by a guess from words are looked at again. Without the AI,
 * the list's words in folder names, tags and model names place what they can ("Other …" when only
 * the Category is clear). `again` sorts every model again, except places a person chose. One run
 * at a time; every open page follows its progress. A run started on the Categories page (`move`)
 * then moves the model folders Organize made into the folders of their places
 * (upload-inbox.js moveToPlaces), the Uncategorized ones it just placed among them.
 */

const path = require('path');
const events = require('./events');
const database = require('../core/database');
const categories = require('../core/categories');
const { linkKey, parseModelLink } = require('../core/link-import');

/** Site details fetched at once (the rest of the free step is quick). */
const SITE_CONCURRENCY = 4;

/** @type {any} */
let job = null;
let nextId = 1;

/** What every page shows (the AI's picks go with snapshot()). */
function summary() {
  if (!job) return null;
  return {
    id: job.id,
    by: job.by,
    running: job.running,
    stopping: job.stopping,
    phase: job.phase,
    useAi: job.useAi,
    total: job.total,
    processed: job.processed,
    placed: job.placed,
    left: job.left,
    aiTotal: job.aiTotal,
    aiDone: job.aiDone,
    aiPlacedCount: job.aiPlaced.length,
    noPicture: job.noPicture,
    again: job.again,
    moved: job.moved,
    moveFailed: job.moveFailed,
    error: job.error
  };
}

let lastAnnounce = 0;
function announce(force = false) {
  if (!force && Date.now() - lastAnnounce < 300) return;
  lastAnnounce = Date.now();
  events.broadcast('category-scan', summary());
}

/** The run with what the AI placed: { ...summary, aiPlaced: [{ filePath, fileName, category, subcategory }] }, or null. */
function snapshot() {
  if (!job) return null;
  return { ...summary(), aiPlaced: job.aiPlaced.map((s) => ({ ...s })) };
}

const running = () => !!(job && job.running);

/** Whether the AI service in Settings → AI Tagging can be asked (a key where one is needed). */
function aiReady() {
  try {
    const settings = require('./ipc/ai').getAISettings();
    const aitagging = require('../core/aitagging');
    return !aitagging.requiresApiKey(settings.aiService, settings.apiEndpoint) || !!String(settings.apiKey || '').trim();
  } catch (_) {
    return false;
  }
}

/** The categories a model's site gives it: kept details, else fetched (without translating file names). */
async function siteCategories(model, fetchImpl) {
  const link = parseModelLink(model.source || '') || (model.filePath.startsWith('url::') ? parseModelLink(model.filePath.slice(5)) : null);
  if (!link) return [];
  const siteDetails = require('./site-details');
  const row = siteDetails.siteFilesTable().prepare('SELECT data FROM site_details WHERE key = ?').get(linkKey(link));
  try {
    if (row) return JSON.parse(row.data).categories || [];
    const result = await siteDetails.getDetails(link.url, { translate: false, ...(fetchImpl ? { fetchImpl } : {}) });
    return (result && result.details && result.details.categories) || [];
  } catch (_) {
    return [];
  }
}

/** Run `work` over `items`, `limit` at a time, until done or stopped. */
async function eachLimited(items, limit, work) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !job.stopping) {
      const item = items[next++];
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** At most this many of the AI's places are listed on the Categories page (to check them). */
const MAX_LISTED = 500;

/** The free step: the site's category, and without the AI the list's words. Answers the models left for the AI. */
async function freeStep(models, list, fetchImpl) {
  const tagsOf = database.db.prepare('SELECT t.name FROM model_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = ?');
  const left = [];
  await eachLimited(models, SITE_CONCURRENCY, async (model) => {
    const hint = model.hint ? categories.findCategory(model.hint, list) : null;
    let match = categories.freeMatches(
      {
        siteCategories: await siteCategories(model, fetchImpl),
        filePath: model.filePath,
        fileName: model.fileName,
        tags: tagsOf.all(model.id).map((row) => row.name)
      },
      list,
      { words: !job.useAi }
    );
    // A Category a person chose stays: only its Subcategories count.
    if (match && hint && match.category.id !== hint.id) match = null;
    let place = match ? match.subcategory : null;
    const source = match ? match.source : null;
    if (!place && match && !job.useAi) {
      // Only the Category is clear: its "Other …" Subcategory.
      place = categories.otherOf(match.category, list);
    }
    if (place) {
      categories.setModelPlace(model.id, place.name, source);
      job.placed[source] = (job.placed[source] || 0) + 1;
    } else {
      left.push({ ...model, main: (match && match.category) || hint || null });
    }
    job.processed++;
    announce();
  });
  return left;
}

const AI_PROMPT =
  'You are sorting 3D printable models in a library. Look at this picture of a model and name what it is in one or two words in the "tags" list. ';

/** A folder (or ZIP file) with at least this many models to sort is asked about once, as one kit. */
const KIT_MIN = 3;
/** Kit files named in the question (the rest are counted). */
const KIT_NAMES = 15;
/** The AI's answer when a folder's files are different models, not one kit. */
const SEPARATE = 'separate';

/** The folder a model is in (its ZIP file for a ZIP entry): the files of one kit share it. */
function kitKey(filePath) {
  return filePath.includes('::') ? filePath.split('::')[0] : path.dirname(filePath);
}

/**
 * The models in kits and alone: [{ key, members }]. A folder with KIT_MIN or more models to sort
 * (all with the same Category a person chose, or none) is one kit; the rest are asked about one
 * by one.
 */
function kitsOf(models) {
  const byKey = new Map();
  for (const model of models) {
    const key = model.filePath.startsWith('url::') ? `model:${model.id}` : kitKey(model.filePath);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(model);
  }
  const out = [];
  for (const [key, members] of byKey) {
    const mains = new Set(members.map((m) => (m.main ? m.main.id : null)));
    if (members.length >= KIT_MIN && mains.size === 1 && !key.startsWith('model:')) out.push({ key, members });
    else for (const model of members) out.push({ key: null, members: [model] });
  }
  return out;
}

const kitPrompt = (key, members) => {
  const folder = path.basename(key);
  const parent = path.basename(path.dirname(key));
  const names = members.slice(0, KIT_NAMES).map((m) => `"${m.fileName || path.basename(m.filePath)}"`);
  const more = members.length > KIT_NAMES ? ` and ${members.length - KIT_NAMES} more` : '';
  return (
    `You are sorting 3D printable models in a library. These ${members.length} files are in one folder, "${folder}"` +
    `${parent && parent !== '.' && parent !== '/' ? ` (inside "${parent}")` : ''}: ${names.join(', ')}${more}. The picture shows one of them. ` +
    `If the files are the parts of one model or kit, sort the whole model (not just the part in the picture) and name what the model is in one or two words in the "tags" list. ` +
    `If they are clearly different, unrelated models, answer the category "${SEPARATE}". `
  );
};

async function aiStep(models, list, event, ask) {
  const settings = require('./ipc/ai').getAISettings();
  const aitagging = require('../core/aitagging');
  const { getThumbnailImagePayload } = require('../core/thumbnails');
  const { getModelByFilePath } = require('../core/models');
  if (!ask) {
    const puter = settings.aiService === 'puter' ? require('./ipc/ai').createPuterIPCHandler(event || {}) : null;
    aitagging.initializeOpenAI(settings.apiKey, settings.apiEndpoint, settings.aiService, puter);
    ask = (base64, options, filePath) => aitagging.generateTagsForImage(base64, settings.aiModel, options, 1000, 3, filePath);
  }
  const byId = new Map(list.map((c) => [c.id, c]));
  const concurrency = Math.max(1, Math.min(Number(settings.aiTagConcurrency) || 3, 10));

  /** Save the AI's place for these models; answers whether it named one. */
  const place = (members, answer) => {
    const main = members[0].main;
    const sub = categories.matchAiCategory(answer && answer.category, list);
    if (!sub || (main && sub.parent_id !== main.id)) return false;
    for (const model of members) {
      categories.setModelPlace(model.id, sub.name, 'ai');
      job.placed.ai = (job.placed.ai || 0) + 1;
      if (job.aiPlaced.length < MAX_LISTED) {
        job.aiPlaced.push({
          filePath: model.filePath,
          fileName: model.fileName || model.filePath.split(/[\\/]/).pop(),
          category: byId.get(sub.parent_id).name,
          subcategory: sub.name
        });
      }
    }
    return true;
  };
  const pictureOf = (model) => {
    const full = getModelByFilePath(model.filePath, { includeThumbnail: true });
    const picture = full && full.thumbnail ? getThumbnailImagePayload(full.thumbnail) : null;
    return picture ? { picture, notes: full.notes || '' } : null;
  };
  const askAbout = async (prompt, found, choices, filePath) =>
    ask(
      found.picture.base64,
      {
        customPrompt: prompt,
        maxTags: 2,
        useJsonResponse: true,
        mimeType: found.picture.mimeType,
        folderLevels: filePath ? settings.aiTagFolderLevels : 0,
        notes: found.notes,
        categoryChoices: choices
      },
      filePath
    );
  const failed = (error, what) => {
    // A rate limit or a failed sign-in stops the AI step; what was placed so far stays.
    if (/rate limit|authentication|api key/i.test(error.message || '') || require('../core/aitagging').PUTER_STOP.test(error.message || ''))
      job.error = error.message;
    else console.warn(`[Categories] AI could not categorize ${what}: ${error.message}`);
  };

  const one = async (model) => {
    const found = pictureOf(model);
    if (!found) {
      job.noPicture++;
    } else {
      try {
        place([model], await askAbout(AI_PROMPT, found, categories.aiChoices(list, model.main), model.filePath));
      } catch (error) {
        failed(error, model.filePath);
      }
    }
    job.aiDone++;
    announce();
  };

  await eachLimited(kitsOf(models), concurrency, async (kit) => {
    if (job.error) return;
    if (!kit.key) {
      await one(kit.members[0]);
      return;
    }
    // A kit: one question about the folder, with the picture of a part (the one named like the folder, else the first with a picture).
    const folderName = path.basename(kit.key).toLowerCase();
    const ordered = [...kit.members].sort(
      (a, b) => Number(path.basename(b.filePath).toLowerCase().includes(folderName)) - Number(path.basename(a.filePath).toLowerCase().includes(folderName))
    );
    /** @type {{ picture: { base64: string, mimeType: string }, notes: string } | null} */
    let found = null;
    for (const model of ordered) if (!found) found = pictureOf(model);
    let placed = false;
    if (found) {
      try {
        placed = place(
          kit.members,
          await askAbout(kitPrompt(kit.key, kit.members), found, [...categories.aiChoices(list, kit.members[0].main), SEPARATE], null)
        );
      } catch (error) {
        failed(error, kit.key);
      }
    }
    if (placed) {
      job.aiDone += kit.members.length;
      announce();
      return;
    }
    // Different models (or no answer): one by one.
    for (const model of kit.members) {
      if (job.error || job.stopping) break;
      await one(model);
    }
  });
}

/**
 * The models a run looks at: without a Subcategory; with the AI also those placed by a guess from
 * words; with `again` every model except the ones a person placed. `hint` is a Category a person
 * chose alone. `only` limits it to those model ids.
 * @param {{ useAi: boolean, again: boolean, only?: Set<number> | null }} options
 */
function modelsToSort({ useAi, again, only = null }) {
  categories.ensureTables();
  const places = new Map();
  for (const row of database.db
    .prepare('SELECT mc.model_id, c.name, c.parent_id, mc.source FROM model_categories mc JOIN categories c ON c.id = mc.category_id')
    .all()) {
    const place = places.get(row.model_id) || { main: null, sub: null, source: null };
    if (row.parent_id) place.sub = row.name;
    else place.main = row.name;
    place.source = row.source;
    places.set(row.model_id, place);
  }
  return database.db
    .prepare('SELECT id, filePath, fileName, source FROM models')
    .all()
    .filter((model) => {
      if (only && !only.has(model.id)) return false;
      const place = places.get(model.id);
      if (!place || !place.sub) {
        model.hint = place && place.source === 'manual' ? place.main : null;
        return true;
      }
      if (place.source === 'manual') return false;
      if (again) return true;
      return useAi && categories.GUESSES.includes(place.source);
    });
}

/**
 * Start a run: { useAi } asks the AI about the models the free step leaves, { again } sorts every
 * model again (not the places a person chose). Answers the summary, or null while another run is
 * going. `only` (model ids) sorts just those models (Organize Uploads). `deps.fetchImpl` and
 * `deps.ask` replace the network and the AI service (tests).
 * @param {{ by?: string | null, useAi?: boolean, again?: boolean, only?: number[] | null, event?: any, move?: boolean }} [options]
 * @param {{ fetchImpl?: Function, ask?: Function }} [deps]
 */
function start({ by = null, useAi = false, again = false, only = null, event = null, move = false } = {}, deps = {}) {
  if (running()) return null;
  const models = modelsToSort({ useAi, again, only: only ? new Set(only) : null });
  job = {
    id: nextId++,
    by,
    useAi: !!useAi,
    again: !!again,
    running: true,
    stopping: false,
    phase: 'free',
    total: models.length,
    processed: 0,
    placed: {},
    left: 0,
    aiTotal: 0,
    aiDone: 0,
    noPicture: 0,
    aiPlaced: [],
    moved: 0,
    moveFailed: /** @type {{ name: string, error: string }[]} */ ([]),
    error: null
  };
  const current = job;
  const list = categories.listCategories();
  job.promise = (async () => {
    try {
      const left = await freeStep(models, list, deps.fetchImpl);
      current.left = left.length;
      if (current.useAi && left.length && !current.stopping) {
        current.phase = 'ai';
        current.aiTotal = left.length;
        announce(true);
        await aiStep(left, list, event, deps.ask);
        current.left = categories.uncategorizedCount();
      }
      // Organize's model folders go where their places are now (not while Organize itself runs).
      if (move && !only && !current.stopping && !require('./upload-inbox').running()) {
        current.phase = 'move';
        current.processed = 0;
        announce(true);
        const result = await require('./upload-inbox').moveToPlaces({
          shouldStop: () => current.stopping,
          onProgress: (done, total) => {
            current.processed = done;
            current.total = total;
            announce();
          }
        });
        current.moved = result.moved.length;
        current.moveFailed = result.failed;
        // The AI's picks shown for review follow their files to the new folders.
        for (const { from, to } of result.moved)
          for (const pick of current.aiPlaced)
            if (String(pick.filePath).startsWith(from + path.sep)) pick.filePath = to + String(pick.filePath).slice(from.length);
      }
    } catch (error) {
      console.error('[Categories] Categorize Library failed:', error);
      current.error = error.message;
    } finally {
      current.running = false;
      current.phase = 'done';
      announce(true);
      events.broadcast('refresh-grid');
      events.broadcast('categories-changed');
    }
  })();
  announce(true);
  return summary();
}

function stop() {
  if (!running()) return false;
  job.stopping = true;
  announce(true);
  return true;
}

/** Close a finished run. */
function dismiss() {
  if (!job || job.running) return false;
  job = null;
  announce(true);
  return true;
}

/**
 * After the list changed (an update), sort every model once with what is free (no AI: it costs);
 * the Categories page offers the AI for the rest.
 */
async function resortIfPending() {
  const row = database.db && database.db.prepare("SELECT value FROM settings WHERE key = 'categoriesResort'").get();
  if (!row || row.value !== '1' || running()) return false;
  const started = start({ by: 'JusttPrint', useAi: false });
  if (!started) return false;
  await job.promise;
  database.db.prepare("DELETE FROM settings WHERE key = 'categoriesResort'").run();
  console.log(`[Categories] Sorted the library into the new categories: ${JSON.stringify(job.placed)}; ${job.left} left for the AI`);
  return true;
}

module.exports = { aiReady, dismiss, resortIfPending, snapshot, start, stop, running, summary, _job: () => job };
