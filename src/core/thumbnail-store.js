'use strict';

const database = require('./database');
const { parseThumbnails } = require('./thumbnails');
const { compressThumbnailBlob } = require('./thumbnail-compress');

function addThumbnailToModel(thumbnailString, newThumbnail) {
  if (!newThumbnail) return thumbnailString;
  const thumbnails = parseThumbnails(thumbnailString);
  thumbnails.push(newThumbnail);
  return thumbnails.join('::');
}

function setDefaultThumbnailIndex(thumbnailString, index) {
  const thumbnails = parseThumbnails(thumbnailString);
  if (thumbnails.length === 0 || index < 0 || index >= thumbnails.length) {
    return thumbnailString;
  }
  // Move the selected thumbnail to the front (making it the default)
  const selected = thumbnails[index];
  thumbnails.splice(index, 1);
  thumbnails.unshift(selected);
  return thumbnails.join('::');
}

async function saveThumbnail(filePath, thumbnail) {
  try {
    const { value } = compressThumbnailBlob(thumbnail);
    database.db.prepare('UPDATE models SET thumbnail = ? WHERE filePath = ?').run(value, filePath);
    return true;
  } catch (error) {
    console.error('Error saving thumbnail:', error);
    throw error;
  }
}

// Helper function to add multiple thumbnails at once
function addMultipleThumbnails(thumbnailString, newThumbnails) {
  if (!newThumbnails || newThumbnails.length === 0) return thumbnailString;
  const thumbnails = parseThumbnails(thumbnailString);

  // Add all new thumbnails, avoiding duplicates by checking the full string
  for (const newThumbnail of newThumbnails) {
    if (newThumbnail && typeof newThumbnail === 'string' && newThumbnail.length > 0) {
      // Check if this exact thumbnail already exists
      const exists = thumbnails.some((t) => t === newThumbnail);
      if (!exists) {
        thumbnails.push(newThumbnail);
      }
    }
  }
  return thumbnails.join('::');
}

module.exports = { addMultipleThumbnails, addThumbnailToModel, saveThumbnail, setDefaultThumbnailIndex };
