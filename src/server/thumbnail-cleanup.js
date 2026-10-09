'use strict';

/**
 * A startup safeguard: stored thumbnails too long to load (corrupt or runaway values) are cleared,
 * so the model gets a new one. Thumbnails are otherwise stored as they come; the grid gets small
 * copies of large ones (src/server/grid-thumbnails.js).
 */

const database = require('../core/database');
const { THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS } = require('../core/thumbnails');

function purgeOversizedThumbnails(maxChars = THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS) {
  if (!database.db) return 0;
  try {
    const result = database.db.prepare('UPDATE models SET thumbnail = NULL WHERE thumbnail IS NOT NULL AND octet_length(thumbnail) > ?').run(maxChars);
    if (result.changes > 0) {
      console.warn(`Cleared ${result.changes} thumbnail(s) over ${maxChars} chars (corrupt/oversized safeguard)`);
    }
    return result.changes;
  } catch (error) {
    console.error('Failed to clear corrupt thumbnails:', error);
    return 0;
  }
}

module.exports = { purgeOversizedThumbnails };
