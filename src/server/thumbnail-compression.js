'use strict';

const database = require('../core/database');
const { readThumbnailColumn } = require('../core/thumbnails');
const { compressThumbnailBlob, needsCompression, THUMBNAIL_MAX_STORED_CHARS, THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS } = require('../core/thumbnail-compress');

let isCompressingThumbnailsBackground = false;

const THUMBNAIL_MIGRATION_DELAY_MS = Math.max(
  15000,
  Number.parseInt(process.env.JUSTTPRINT_THUMBNAIL_MIGRATION_DELAY_MS || '30000', 10) || 30000
);

const THUMBNAIL_MIGRATION_MAX_PER_SESSION = Math.max(
  25,
  Number.parseInt(process.env.JUSTTPRINT_THUMBNAIL_MIGRATION_MAX_PER_SESSION || '200', 10) || 200
);

const THUMBNAIL_MIGRATION_YIELD_MS = 25;

function scheduleBackgroundThumbnailCompression(reason) {
  setTimeout(() => {
    compressExistingThumbnailsInBackground(reason).catch((error) => {
      console.error('Background thumbnail compression failed:', error);
    });
  }, THUMBNAIL_MIGRATION_DELAY_MS);
}

function clearThumbnailForPath(filePath, reason) {
  if (!database.db || !filePath) return false;
  try {
    const result = database.db.prepare('UPDATE models SET thumbnail = NULL WHERE filePath = ?').run(filePath);
    if (result.changes > 0) {
      console.warn(`Cleared thumbnail for ${filePath}${reason ? ` (${reason})` : ''}`);
    }
    return result.changes > 0;
  } catch (error) {
    console.error(`Failed to clear thumbnail for ${filePath}:`, error);
    return false;
  }
}

function purgeCorruptThumbnailsOnly(maxChars = THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS) {
  if (!database.db) return 0;
  try {
    const result = database.db.prepare(`
      UPDATE models
      SET thumbnail = NULL
      WHERE thumbnail IS NOT NULL
        AND LENGTH(thumbnail) > ?
    `).run(maxChars);
    if (result.changes > 0) {
      console.warn(`Cleared ${result.changes} thumbnail(s) over ${maxChars} chars (corrupt/oversized safeguard)`);
    }
    return result.changes;
  } catch (error) {
    console.error('Failed to clear corrupt thumbnails:', error);
    return 0;
  }
}

async function compressExistingThumbnailsInBackground(reason) {
  if (isCompressingThumbnailsBackground || !database.db) return;
  isCompressingThumbnailsBackground = true;
  try {
    purgeCorruptThumbnailsOnly();

    const rows = database.db.prepare(`
      SELECT filePath, LENGTH(thumbnail) AS thumbLen
      FROM models
      WHERE thumbnail IS NOT NULL AND thumbnail != '' AND thumbnail != '3d.png'
        AND thumbnail LIKE 'data:image%'
        AND LENGTH(thumbnail) > ?
      ORDER BY LENGTH(thumbnail) DESC
    `).all(THUMBNAIL_MAX_STORED_CHARS);

    if (rows.length === 0) return;

    const batch = rows.slice(0, THUMBNAIL_MIGRATION_MAX_PER_SESSION);
    const remaining = rows.length - batch.length;
    console.log(
      `Migrating ${batch.length} legacy thumbnail(s) (${reason || 'startup'})` +
      (remaining > 0 ? `; ${remaining} deferred to a later session` : '') +
      '...'
    );

    let updated = 0;
    for (const row of batch) {
      try {
        const allowOversized = row.thumbLen > THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS;
        const thumbnail = readThumbnailColumn(row.filePath, { allowOversized });
        if (!thumbnail) continue;

        const parts = thumbnail.includes('::') ? thumbnail.split('::').filter(Boolean) : [thumbnail];
        const needsWork = parts.some((part) => needsCompression(part));
        if (!needsWork) continue;

        const { value, changed } = compressThumbnailBlob(thumbnail);
        if (changed) {
          database.db.prepare('UPDATE models SET thumbnail = ? WHERE filePath = ?').run(value, row.filePath);
          updated++;
        }
      } catch (rowError) {
        console.error(`Thumbnail migration failed for ${row.filePath}:`, rowError);
      }
      await new Promise((resolve) => setTimeout(resolve, THUMBNAIL_MIGRATION_YIELD_MS));
    }
    if (updated > 0) {
      console.log(`Thumbnail migration complete: ${updated}/${batch.length} model(s) updated`);
    }
  } finally {
    isCompressingThumbnailsBackground = false;
  }
}

module.exports = { scheduleBackgroundThumbnailCompression };
