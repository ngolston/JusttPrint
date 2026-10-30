'use strict';

/**
 * What runs in the background, for the progress bars above Library Storage: library scans, AI
 * Tagging, Categorize Library, thumbnails, duplicate checks, site downloads, uploads, backups and
 * moves. Each job is { id, kind, label, detail, done, total, unit, startedAt, etaMs }; `total`
 * null means its size is not known yet (the bar moves without a share). `etaMs` is how long it
 * should still take, from its pace so far (null until it can be told). Every browser gets the
 * list as 'background-activity' when it changes (at most a few times a second) and asks for it
 * with get-background-activity.
 *
 * Jobs that already tell the browsers their progress are followed from those events (fromEvent,
 * called by events.broadcast); the others call start / update / finish.
 */

/** @typedef {'scan' | 'ai-tagging' | 'categories' | 'thumbnails' | 'duplicates' | 'download' | 'upload' | 'backup' | 'move' | 'plates'} ActivityKind */

const SEND_EVERY_MS = 400;
/** No time left is told before this much of a job is done, or this long has passed. */
const ETA_MIN_SHARE = 0.03;
const ETA_MIN_MS = 3000;
/** A job followed from events that has said nothing for this long is gone (its end was missed). */
const STALE_MS = 3 * 60 * 1000;

/** @type {Map<string, { id: string, kind: ActivityKind, label: string, detail: string | null, done: number, total: number | null, unit: string, startedAt: number, updatedAt: number, fromEvents?: boolean }>} */
const jobs = new Map();
let nextId = 1;
/** @type {NodeJS.Timeout | null} */
let timer = null;
let lastSent = 0;

/** How long a job should still take, or null. */
function etaOf(job, now = Date.now()) {
  if (!job.total || job.done <= 0 || job.done >= job.total) return null;
  const elapsed = now - job.startedAt;
  if (elapsed < ETA_MIN_MS || job.done / job.total < ETA_MIN_SHARE) return null;
  return Math.round((elapsed / job.done) * (job.total - job.done));
}

/** Jobs whose end was missed go, checked every minute while there are jobs. */
const sweeper = setInterval(() => {
  const now = Date.now();
  let gone = false;
  for (const job of jobs.values()) {
    if (job.fromEvents && now - job.updatedAt > STALE_MS) {
      jobs.delete(job.id);
      gone = true;
    }
  }
  if (gone) send(true);
}, 60 * 1000);
if (sweeper.unref) sweeper.unref();

/** The running jobs, oldest first. */
function list(now = Date.now()) {
  for (const job of jobs.values()) if (job.fromEvents && now - job.updatedAt > STALE_MS) jobs.delete(job.id);
  return [...jobs.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((job) => ({
      id: job.id,
      kind: job.kind,
      label: job.label,
      detail: job.detail,
      done: job.done,
      total: job.total,
      unit: job.unit,
      startedAt: new Date(job.startedAt).toISOString(),
      etaMs: etaOf(job, now)
    }));
}

/** Tell the browsers (soon, so a burst of updates is one message). */
function send(force = false) {
  const wait = force ? 0 : Math.max(0, SEND_EVERY_MS - (Date.now() - lastSent));
  if (timer) {
    if (!force) return;
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = null;
    lastSent = Date.now();
    require('./events').broadcastRaw('background-activity', list());
  }, wait);
  if (timer.unref) timer.unref();
}

/**
 * A job starts (or starts again under the same `id`). Answers its id.
 * @param {ActivityKind} kind
 * @param {string} label What the bar says: "Scanning the library".
 * @param {{ id?: string, total?: number | null, unit?: string, detail?: string | null }} [options]
 */
function start(kind, label, { id = undefined, total = null, unit = 'items', detail = null } = {}) {
  const key = id || `${kind}-${nextId++}`;
  const now = Date.now();
  jobs.set(key, { id: key, kind, label, detail, done: 0, total: total ?? null, unit, startedAt: now, updatedAt: now });
  send(true);
  return key;
}

/**
 * A job moved on: { done, total, label, detail } (what is given changes).
 * @param {string} id
 * @param {{ done?: number, total?: number | null, label?: string, detail?: string | null }} changes
 */
function update(id, changes) {
  const job = jobs.get(id);
  if (!job) return;
  if (Number.isFinite(changes.done)) job.done = Math.max(0, Number(changes.done));
  if (changes.total !== undefined) job.total = changes.total && changes.total > 0 ? Number(changes.total) : null;
  if (changes.label) job.label = changes.label;
  if (changes.detail !== undefined) job.detail = changes.detail;
  job.updatedAt = Date.now();
  send();
}

function finish(id) {
  if (jobs.delete(id)) send(true);
}

/** Run `work` as a job: finished however it ends. `work` gets an update function. */
async function track(kind, label, options, work) {
  const id = start(kind, label, options);
  try {
    return await work((changes) => update(id, changes));
  } finally {
    finish(id);
  }
}

/**
 * Jobs that tell the browsers their own progress, followed from those events (events.broadcast
 * calls this for every event).
 */
function fromEvent(channel, payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const before = new Set(jobs.keys());
  followEvent(channel, p);
  for (const id of jobs.keys()) if (!before.has(id)) /** @type {any} */ (jobs.get(id)).fromEvents = true;
}

/** @param {string} channel @param {any} p */
function followEvent(channel, p) {
  switch (channel) {
    case 'ai-tag-job':
      if (p.running) {
        if (!jobs.has('ai-tagging')) start('ai-tagging', 'AI Tagging', { id: 'ai-tagging', unit: 'models' });
        update('ai-tagging', { done: p.processed, total: p.total });
      } else finish('ai-tagging');
      return;
    case 'category-scan':
      if (p.running) {
        const ai = p.phase === 'ai';
        if (!jobs.has('categories')) start('categories', 'Categorize Library', { id: 'categories', unit: 'models' });
        const job = /** @type {any} */ (jobs.get('categories'));
        // The AI step is a job of its own pace: its time left is counted from when it began.
        if (ai && job.detail !== 'Asking the AI') {
          job.startedAt = Date.now();
          job.done = 0;
        }
        update('categories', ai ? { done: p.aiDone, total: p.aiTotal, detail: 'Asking the AI' } : { done: p.processed, total: p.total, detail: null });
      } else finish('categories');
      return;
    case 'thumbnail-job-progress':
      if (!jobs.has('thumbnails')) start('thumbnails', 'Making thumbnails', { id: 'thumbnails', unit: 'models' });
      update('thumbnails', { done: p.processed, total: p.total || null });
      return;
    case 'thumbnail-job-complete':
    case 'thumbnail-job-error':
      finish('thumbnails');
      return;
    case 'hash-generation-progress':
      if (!jobs.has('hashes')) start('duplicates', 'Fingerprinting files', { id: 'hashes', unit: 'files' });
      update('hashes', { done: p.processed, total: p.total });
      return;
    case 'hash-generation-complete':
      finish('hashes');
      return;
    case 'geometry-progress':
      if (p.running) {
        if (!jobs.has('geometry')) start('duplicates', 'Measuring shapes', { id: 'geometry', unit: 'models' });
        update('geometry', { done: p.processed, total: p.total });
      } else finish('geometry');
      return;
    case 'geometry-complete':
      finish('geometry');
      return;
    default:
  }
}

/**
 * SQLite's online backup of the library database into `target`, as a job (better-sqlite3 tells
 * the pages copied).
 * @param {any} db
 * @param {string} target
 * @param {string} label
 */
function backupDatabase(db, target, label) {
  return track('backup', label, { unit: 'pages' }, (progressed) =>
    db.backup(target, {
      progress({ totalPages, remainingPages }) {
        progressed({ total: totalPages, done: totalPages - remainingPages });
        return 1000;
      }
    })
  );
}

/** A job that is dropped when it says nothing for a few minutes (one whose end may never come). */
function markIdleEnds(id) {
  const job = jobs.get(id);
  if (job) job.fromEvents = true;
}

/** Tests: forget every job. */
function reset() {
  jobs.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = { backupDatabase, etaOf, finish, fromEvent, list, markIdleEnds, reset, start, track, update };
