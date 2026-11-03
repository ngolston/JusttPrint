'use strict';

/**
 * A startup safeguard: stored thumbnails too long to load (corrupt or runaway values) are cleared,
 * so the model gets a new one. Thumbnails are otherwise stored as they come; the grid gets small
 * copies of large ones (src/server/grid-thumbnails.js).
 *
 * A gallery over the load limit is not cleared: its pictures are reduced to fit
 * (src/server/oversized-thumbnails.js). Only a value over the runaway ceiling still is.
 */

const database = require('../core/database');
const { THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS } = require('../core/thumbnails');
const oversized = require('./oversized-thumbnails');

function purgeOversizedThumbnails(maxChars = THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS, { hardMax = oversized.HARD_MAX_CHARS } = {}) {
  if (!database.db) return 0;
  try {
    // One read of every model's pictures for both: clearing runaway values and marking large galleries.
    const { cleared, marked } = oversized.sortExisting(database.db, { limit: maxChars, hardMax });
    if (cleared > 0) {
      console.warn(`Cleared ${cleared} thumbnail(s) over ${hardMax} chars (corrupt/oversized safeguard)`);
    }
    if (marked > 0) {
      console.log(`[Oversized thumbnails] ${marked} model(s) with pictures over ${maxChars} chars: they are reduced to fit in the background`);
    }
    return cleared;
  } catch (error) {
    console.error('Failed to clear corrupt thumbnails:', error);
    return 0;
  }
}

module.exports = { purgeOversizedThumbnails };
