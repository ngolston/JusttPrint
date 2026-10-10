'use strict';

/**
 * Categorize Library (the Categories page): puts the models that are in no category yet into
 * categories. First what the models themselves say, which is free: the category their site gives
 * them (MakerWorld, Printables, Thingiverse), else a category's words in their folders, tags or
 * name. Those placements are saved right away. Then, when asked, the AI service set up for AI
 * Tagging looks at the picture of each model still left and picks from the list; its picks wait
 * for a review on the Categories page. One run at a time; every open page follows its progress.
 */

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
    suggestions: job.suggestions.length,
    noPicture: job.noPicture,
    error: job.error
  };
}

let lastAnnounce = 0;
function announce(force = false) {
  if (!force && Date.now() - lastAnnounce < 300) return;
  lastAnnounce = Date.now();
  events.broadcast('category-scan', summary());
}

/** The run with the AI's picks: { ...summary, suggestions: [{ filePath, fileName, categories }] }, or null. */
function snapshot() {
  if (!job) return null;
  return { ...summary(), suggestions: job.suggestions.map((s) => ({ ...s })) };
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

async function freeStep(models, list, fetchImpl) {
  const tagsOf = database.db.prepare('SELECT t.name FROM model_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.model_id = ?');
  const left = [];
  await eachLimited(models, SITE_CONCURRENCY, async (model) => {
    const matches = categories.freeMatches(
      {
        siteCategories: await siteCategories(model, fetchImpl),
        filePath: model.filePath,
        fileName: model.fileName,
        tags: tagsOf.all(model.id).map((row) => row.name)
      },
      list
    );
    if (matches.length) {
      for (const match of matches) categories.addModelCategories(model.id, [match.id], match.source);
      const source = matches[0].source;
      job.placed[source] = (job.placed[source] || 0) + 1;
    } else {
      left.push(model);
    }
    job.processed++;
    announce();
  });
  return left;
}

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
  const prompt = categories.aiPrompt(list);
  const concurrency = Math.max(1, Math.min(Number(settings.aiTagConcurrency) || 3, 10));
  await eachLimited(models, concurrency, async (model) => {
    if (job.error) return;
    const full = getModelByFilePath(model.filePath, { includeThumbnail: true });
    const picture = full && full.thumbnail ? getThumbnailImagePayload(full.thumbnail) : null;
    if (!picture) {
      job.noPicture++;
    } else {
      try {
        const answer = await ask(
          picture.base64,
          {
            customPrompt: prompt,
            maxTags: 3,
            useJsonResponse: true,
            mimeType: picture.mimeType,
            folderLevels: settings.aiTagFolderLevels,
            notes: full.notes || ''
          },
          model.filePath
        );
        const ids = categories.matchAiAnswer(answer, list);
        if (ids.length) {
          job.suggestions.push({
            filePath: model.filePath,
            fileName: model.fileName || model.filePath.split(/[\\/]/).pop(),
            categories: list.filter((c) => ids.includes(c.id)).map((c) => c.name)
          });
        }
      } catch (error) {
        // A rate limit or a failed sign-in stops the AI step; the picks so far stay.
        if (/rate limit|authentication|api key/i.test(error.message || '')) job.error = error.message;
        else console.warn(`[Categories] AI could not categorize ${model.filePath}: ${error.message}`);
      }
    }
    job.aiDone++;
    announce();
  });
}

/**
 * Start a run: { useAi } asks the AI about the models the free step leaves. Answers the summary,
 * or null while another run is going. `deps.fetchImpl` and `deps.ask` replace the network and the
 * AI service (tests).
 */
function start({ by = null, useAi = false, event = null } = {}, deps = {}) {
  if (running()) return null;
  categories.ensureTables();
  const models = database.db.prepare('SELECT id, filePath, fileName, source FROM models WHERE id NOT IN (SELECT model_id FROM model_categories)').all();
  job = {
    id: nextId++,
    by,
    useAi: !!useAi,
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
    suggestions: [],
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
      }
    } catch (error) {
      console.error('[Categories] Categorize Library failed:', error);
      current.error = error.message;
    } finally {
      current.running = false;
      current.phase = 'done';
      announce(true);
      events.broadcast('refresh-grid');
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

/**
 * Accept the AI's picks: [{ filePath, categories: names }] (what the person kept ticked). The
 * reviewed models leave the list. Answers how many models got categories.
 */
function apply(picks) {
  const byPath = database.db.prepare('SELECT id FROM models WHERE filePath = ?');
  const ids = new Map(categories.listCategories().map((c) => [categories.normalize(c.name), c.id]));
  let placed = 0;
  for (const pick of Array.isArray(picks) ? picks : []) {
    const model = pick && typeof pick.filePath === 'string' ? byPath.get(pick.filePath) : null;
    if (!model) continue;
    const chosen = (Array.isArray(pick.categories) ? pick.categories : []).map((name) => ids.get(categories.normalize(name))).filter(Boolean);
    if (chosen.length && categories.addModelCategories(model.id, chosen, 'ai')) placed++;
  }
  if (job) {
    const done = new Set((Array.isArray(picks) ? picks : []).map((pick) => pick && pick.filePath));
    job.suggestions = job.suggestions.filter((s) => !done.has(s.filePath));
    announce(true);
  }
  if (placed) events.broadcast('refresh-grid');
  return placed;
}

/** Close a finished run and drop the picks not reviewed. */
function dismiss() {
  if (!job || job.running) return false;
  job = null;
  announce(true);
  return true;
}

module.exports = { aiReady, apply, dismiss, snapshot, start, stop, running, summary, _job: () => job };
