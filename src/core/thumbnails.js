'use strict';

const database = require('./database');
const { compressThumbnailBlob, THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS } = require('./thumbnail-compress');

function getThumbnailStoredLength(filePath) {
  if (!database.db || !filePath) return 0;
  const row = database.db.prepare('SELECT LENGTH(thumbnail) AS len FROM models WHERE filePath = ?').get(filePath);
  return row?.len ?? 0;
}

function readThumbnailColumn(filePath, { allowOversized = false } = {}) {
  if (!database.db || !filePath) return null;
  const storedLength = getThumbnailStoredLength(filePath);
  if (storedLength <= 0) return null;
  if (!allowOversized && storedLength > THUMBNAIL_ABSOLUTE_MAX_LOAD_CHARS) {
    return null;
  }
  try {
    const row = database.db.prepare('SELECT thumbnail FROM models WHERE filePath = ?').get(filePath);
    return row?.thumbnail ?? null;
  } catch (error) {
    console.error(`Failed to read thumbnail for ${filePath}:`, error);
    return null;
  }
}

function ensureThumbnailCompressedOnLoad(filePath, thumbnailString) {
  try {
    const { value, changed } = compressThumbnailBlob(thumbnailString);
    if (changed) {
      database.db.prepare('UPDATE models SET thumbnail = ? WHERE filePath = ?').run(value, filePath);
    }
    return value;
  } catch (error) {
    console.error(`Failed to compress thumbnail for ${filePath}:`, error);
    return thumbnailString;
  }
}

function loadThumbnailForModel(filePath) {
  try {
    const thumbnail = readThumbnailColumn(filePath);
    if (!thumbnail) return null;
    return ensureThumbnailCompressedOnLoad(filePath, thumbnail);
  } catch (error) {
    console.error(`Failed to load thumbnail for ${filePath}:`, error);
    return null;
  }
}

function applyThumbnailFlags(row) {
  if (!row) return row;
  const t = row.thumbnail;
  row.hasThumbnail = !!(t && t !== '' && t !== '3d.png');
  row.hasMultipleThumbnails = !!(t && typeof t === 'string' && t.includes('::'));
  return row;
}

// Helper functions for managing multiple thumbnails
function parseThumbnails(thumbnailString) {
  if (!thumbnailString || thumbnailString === '3d.png' || !thumbnailString.includes('::')) {
    return [thumbnailString].filter(Boolean);
  }
  return thumbnailString.split('::').filter(Boolean);
}

function getDefaultThumbnail(thumbnailString, defaultIndex = 0) {
  const thumbnails = parseThumbnails(thumbnailString);
  if (thumbnails.length === 0) return null;
  const index = Math.max(0, Math.min(defaultIndex, thumbnails.length - 1));
  return thumbnails[index];
}

/** First stored thumbnail as { base64, mimeType } for AI tagging (handles multi-thumb `::` joins). */
function getThumbnailImagePayload(thumbnailString) {
  const thumb = getDefaultThumbnail(thumbnailString);
  if (!thumb || typeof thumb !== 'string' || !thumb.startsWith('data:image')) {
    return null;
  }
  const commaIndex = thumb.indexOf(',');
  if (commaIndex === -1) return null;
  const header = thumb.slice(0, commaIndex);
  const base64 = thumb.slice(commaIndex + 1).replace(/\s/g, '');
  if (!base64) return null;
  const mimeMatch = header.match(/^data:([^;]+)/i);
  return {
    base64,
    mimeType: (mimeMatch && mimeMatch[1]) || 'image/png'
  };
}

module.exports = { applyThumbnailFlags, getDefaultThumbnail, getThumbnailImagePayload, loadThumbnailForModel, parseThumbnails, readThumbnailColumn };
