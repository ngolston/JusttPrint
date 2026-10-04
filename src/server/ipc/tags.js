'use strict';

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const { createPuterIPCHandler, getAISettings } = require('./ai');
const { getThumbnailImagePayload } = require('../../core/thumbnails');
const { getModelByFilePath } = require('../../core/models');

function resolveTagForMcp(args) {
  if (!args) throw new Error('Provide tag id or name');
  if (args.id != null && args.id !== '') {
    const id = Number(args.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid tag id');
    const tag = database.db.prepare('SELECT id, name FROM tags WHERE id = ?').get(id);
    if (!tag) throw new Error(`Tag not found for id: ${id}`);
    return tag;
  }
  const name = String(args.name || '').trim();
  if (!name) throw new Error('Provide tag id or name');
  const tag = database.db.prepare('SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE').get(name);
  if (!tag) throw new Error(`Tag not found: ${name}`);
  return tag;
}

function renameTagForMcp(args) {
  const tag = resolveTagForMcp(args);
  const newName = String(args && args.newName || '').trim();
  if (!newName) throw new Error('newName is required');
  if (newName.toLowerCase() === String(tag.name).toLowerCase()) {
    if (newName !== tag.name) {
      database.db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(newName, tag.id);
    }
    return { success: true, id: tag.id, name: newName, merged: false };
  }
  const existing = database.db.prepare('SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE').get(newName);
  if (existing && existing.id !== tag.id) {
    database.db.transaction(() => {
      const rows = database.db.prepare('SELECT model_id FROM model_tags WHERE tag_id = ?').all(tag.id);
      const insert = database.db.prepare('INSERT OR IGNORE INTO model_tags (model_id, tag_id) VALUES (?, ?)');
      for (const row of rows) insert.run(row.model_id, existing.id);
      database.db.prepare('DELETE FROM model_tags WHERE tag_id = ?').run(tag.id);
      database.db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
      if (existing.name !== newName) {
        database.db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(newName, existing.id);
      }
    })();
    return { success: true, id: existing.id, name: newName, merged: true, deletedId: tag.id };
  }
  database.db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(newName, tag.id);
  return { success: true, id: tag.id, name: newName, merged: false };
}

async function getAllTagsHandler() {
  try {
    return database.db.prepare(`
      SELECT 
        t.id,
        t.name,
        COUNT(DISTINCT mt.model_id) as model_count
      FROM tags t
      LEFT JOIN model_tags mt ON t.id = mt.tag_id
      WHERE t.name != ''
      GROUP BY t.id, t.name
      ORDER BY t.name
    `).all();
  } catch (error) {
    console.error('Error getting tags:', error);
    throw error;
  }
}

ipcMain.handle('get-all-tags', getAllTagsHandler);

async function saveTagHandler(event, tagName) {
  try {
    database.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tagName);
    return database.db.prepare('SELECT id, name FROM tags WHERE name = ?').get(tagName);
  } catch (error) {
    console.error('Error saving tag:', error);
    throw error;
  }
}

ipcMain.handle('save-tag', saveTagHandler);

async function renameTagHandler(event, tagId, newName) {
  try {
    return renameTagForMcp({ id: tagId, newName });
  } catch (error) {
    console.error('Error renaming tag:', error);
    throw error;
  }
}

ipcMain.handle('rename-tag', renameTagHandler);

async function deleteTagHandler(event, tagId) {
  try {
    return database.db.transaction(() => {
      // First delete from model_tags (child table)
      database.db.prepare('DELETE FROM model_tags WHERE tag_id = ?').run(tagId);
          
          // Then delete the tag itself
      database.db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
      
      return true;
    })();
  } catch (error) {
    console.error('Error deleting tag:', error);
    throw error;
  }
}

ipcMain.handle('delete-tag', deleteTagHandler);

async function getTagModelCountHandler(event, tagId) {
  return new Promise((resolve, reject) => {
    const row = database.db.prepare('SELECT COUNT(*) as count FROM model_tags WHERE tag_id = ?').get(tagId);
    if (row) {
      resolve(row.count);
    } else {
      reject(new Error('Tag not found'));
    }
  });
}

ipcMain.handle('get-tag-model-count', getTagModelCountHandler);

// Update the handler name to match the convention
async function getModelTagsHandler(event, modelId) {
  try {
    return database.db.prepare(`
      SELECT t.* 
      FROM tags t 
      JOIN model_tags mt ON mt.tag_id = t.id 
      WHERE mt.model_id = ?
    `).all(modelId);
  } catch (error) {
    console.error('Error getting model tags:', error);
    throw error;
  }
}

ipcMain.handle('get-model-tags', getModelTagsHandler);

async function getGroupTagsHandler(event, modelIds) {
  try {
    const ids = (Array.isArray(modelIds) ? modelIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return database.db.prepare(`
      SELECT DISTINCT t.name AS name
      FROM tags t
      JOIN model_tags mt ON mt.tag_id = t.id
      WHERE mt.model_id IN (${placeholders})
      ORDER BY t.name COLLATE NOCASE
    `).all(...ids).map((row) => row.name).filter(Boolean);
  } catch (error) {
    console.error('Error getting group tags:', error);
    throw error;
  }
}

ipcMain.handle('get-group-tags', getGroupTagsHandler);

async function generateTagsHandler(event, filePath) {
  try {
    const aitagging = require('../../core/aitagging');
    const settings = getAISettings();
    
    // Create puter IPC handler if service is puter
    // Pass event so it can route to the correct client (WebSocket in server mode, IPC in normal mode)
    const puterIPCHandler = settings.aiService === 'puter' ? createPuterIPCHandler(event) : null;
    
    // Initialize OpenAI with the API key
    aitagging.initializeOpenAI(settings.apiKey, settings.apiEndpoint, settings.aiService, puterIPCHandler);
    
    // Get the model from the database to access its thumbnail
    const model = getModelByFilePath(filePath, { includeThumbnail: true });
    
    if (!model) {
      console.log(`Model not found in database: ${filePath}`);
      return [];
    }
    
    // Get the model tags from the database
    const modelTagRows = database.db.prepare(`
      SELECT t.name 
      FROM tags t
      JOIN model_tags mt ON mt.tag_id = t.id
      WHERE mt.model_id = ?
    `).all(model.id);
    
    const modelTags = modelTagRows.map(row => row.name);
    
    // Check if model already has the "AI Tagged" tag (unless retagging is allowed)
    if (!settings.aiTagAllowRetagging && modelTags.includes("AI Tagged")) {
      console.log(`Model ${filePath} already has AI Tagged tag, skipping generation`);
      return [];
    }
    
    // Prepare tag generation options (read aiTagPrompt from DB so we always have latest)
    const aiTagPromptValue = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiTagPrompt')?.value ?? null;
    const tagOptions = {
      maxTags: settings.aiTagMaxTags,
      useCategories: settings.aiTagUseCategories,
      useJsonResponse: settings.aiTagUseJsonResponse,
      detailLevel: settings.aiTagDetailLevel,
      folderLevels: settings.aiTagFolderLevels,
      notes: model.notes || '',
      customPrompt: (aiTagPromptValue != null && String(aiTagPromptValue).trim() !== '') ? String(aiTagPromptValue).trim() : null
    };

    if (!model.thumbnail) {
      // If no thumbnail exists, we need to generate one or use a default image
      console.log('No thumbnail found for model, using default image');
      try {
        const fs = require('fs').promises;
        const defaultImagePath = './logo.png'; // Use a default image that's guaranteed to be in PNG format
        const data = await fs.readFile(defaultImagePath, { encoding: 'base64' });
        const tags = await aitagging.generateTagsForImage(data, settings.aiModel, tagOptions, 2000, 5, filePath);
        return tags;
      } catch (error) {
        console.error(`Error generating tags with default image:`, error);
        // Re-throw rate limit errors so user is notified
        if (error.message && error.message.includes('Rate limit')) {
          throw error;
        }
        return []; // Return empty tags array instead of throwing
      }
    }
    
    // Use default thumb only — multi-thumb strings are joined with `::`
    const imagePayload = getThumbnailImagePayload(model.thumbnail);
    
    if (!imagePayload) {
      console.error('Invalid thumbnail format');
      return []; // Return empty tags instead of throwing
    }
    
    try {
      const tags = await aitagging.generateTagsForImage(
        imagePayload.base64,
        settings.aiModel,
        { ...tagOptions, mimeType: imagePayload.mimeType },
        2000,
        5,
        filePath
      );
      return tags;
    } catch (error) {
      console.error('Error generating tags:', error);
      // Re-throw rate limit errors so user is notified
      if (error.message && error.message.includes('Rate limit')) {
        throw error;
      }
      return []; // Return empty tags array instead of throwing
    }
  } catch (error) {
    console.error('Error generating tags:', error);
    throw error;
  }
}

ipcMain.handle('generate-tags', generateTagsHandler);

module.exports = { deleteTagHandler, generateTagsHandler, getAllTagsHandler, renameTagForMcp, resolveTagForMcp, saveTagHandler };
