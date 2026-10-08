'use strict';

/**
 * Edits from two browsers at once. A browser saving a model field sends the value it showed when
 * the person started editing (the base). Compared with what is stored now:
 *
 * - stored == base: nobody else changed it, the edit applies;
 * - stored == the new value: both made the same change, nothing to decide;
 * - otherwise someone else changed it meanwhile: a conflict, and the person chooses.
 *
 * Tags never conflict: the tags this edit added and removed (new against base) are applied to the
 * stored list, so both people's tag changes are kept.
 */

/** Fields a save checks against its base (rating and favorite are single clicks: the last one counts). */
const CHECKED_FIELDS = ['designer', 'source', 'notes', 'parentModel', 'license'];

/** Empty, null and missing are the same value; surrounding spaces do not count. */
const norm = (value) => (value == null ? '' : String(value).trim());

/**
 * @param {object} stored The model as stored now.
 * @param {object} changes The fields being saved.
 * @param {object} base The value of each edited field when editing started.
 * @returns {{ field: string, theirs: string|null, yours: string|null }[]}
 */
function findConflicts(stored, changes, base) {
  const conflicts = [];
  if (!stored || !base || typeof base !== 'object') return conflicts;
  for (const field of CHECKED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(base, field) || changes[field] === undefined) continue;
    const now = norm(stored[field]);
    if (now === norm(base[field]) || now === norm(changes[field])) continue;
    conflicts.push({ field, theirs: stored[field] == null ? null : String(stored[field]), yours: changes[field] == null ? null : String(changes[field]) });
  }
  return conflicts;
}

const tagSet = (list) => new Set((Array.isArray(list) ? list : []).map((tag) => String(typeof tag === 'string' ? tag : tag?.name || '').trim()).filter(Boolean));

/** The stored tags with this edit's additions and removals applied (sorted). */
function mergeTagLists(stored, base, next) {
  const before = tagSet(base);
  const after = tagSet(next);
  const result = tagSet(stored);
  for (const tag of after) if (!before.has(tag)) result.add(tag);
  for (const tag of before) if (!after.has(tag)) result.delete(tag);
  return [...result].sort((a, b) => a.localeCompare(b));
}

module.exports = { CHECKED_FIELDS, findConflicts, mergeTagLists };
