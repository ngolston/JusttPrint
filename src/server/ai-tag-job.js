'use strict';

/**
 * The AI tagging run (Generate Tags in a model's menu). The JusttPrint backend keeps its state
 * so every open page can follow its progress, and the person who started it can close the
 * review or reload the page and pick the review up again. One run at a time; a finished run
 * stays until its review is applied or dismissed, or another run starts.
 */
const events = require('./events');

/** @type {null | { id: number, by: string|null, batch: boolean, filePaths: string[], results: Map<string, { tags: string[], error: string|null }>, running: boolean, stopping: boolean, startedAt: number }} */
let job = null;
let nextId = 1;

/** What every page shows: progress only (results go with get-ai-tag-job). */
function summary() {
  if (!job) return null;
  let withTags = 0;
  for (const result of job.results.values()) if (result.tags.length) withTags++;
  return {
    id: job.id, by: job.by, batch: job.batch, total: job.filePaths.length, processed: job.results.size,
    withTags, running: job.running, stopping: job.stopping
  };
}

const announce = () => events.broadcast('ai-tag-job', summary());

/** Start a run, or null while another is running. */
function start(by, filePaths) {
  if (job && job.running) return null;
  job = { id: nextId++, by: by || null, batch: filePaths.length > 1, filePaths: filePaths.slice(), results: new Map(), running: true, stopping: false, startedAt: Date.now() };
  announce();
  return job;
}

/** One model's suggestions (or why there are none). */
function record(id, filePath, tags, error) {
  if (!job || job.id !== id) return;
  job.results.set(filePath, { tags: Array.isArray(tags) ? tags.map(String) : [], error: error || null });
  announce();
}

function finish(id) {
  if (!job || job.id !== id) return;
  job.running = false;
  job.stopping = false;
  announce();
}

/** Ask the running run to stop: models not started yet are skipped. */
function stop() {
  if (!job || !job.running) return false;
  job.stopping = true;
  announce();
  return true;
}

function stopRequested(id) {
  return !!job && job.id === id && job.stopping;
}

/** Forget a finished run (its review was applied or closed). */
function dismiss(id) {
  if (!job || job.running || (id != null && job.id !== Number(id))) return false;
  job = null;
  announce();
  return true;
}

/** The run with every result so far, for the review. */
function snapshot() {
  if (!job) return null;
  return {
    ...summary(),
    filePaths: job.filePaths.slice(),
    results: [...job.results].map(([filePath, result]) => ({ filePath, tags: result.tags, error: result.error }))
  };
}

function running() {
  return !!job && job.running;
}

module.exports = { start, record, finish, stop, stopRequested, dismiss, snapshot, summary, running };
