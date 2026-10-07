'use strict';

const events = require('../events');

const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const path = require('path');
const { getModelByFilePath } = require('../../core/models');
const { clientDialogs } = require('../dialogs');
const { extract3MFMetadata, filter3MFMetadataBySettings } = require('../../core/three-mf');

ipcMain.handle('get-all-metadata', async () => {
  try {
    return database.db.prepare(`
      SELECT 'designer' as type, designer as name, COUNT(*) as model_count 
      FROM models 
      WHERE designer IS NOT NULL AND designer != '' 
      GROUP BY designer
      UNION ALL
      SELECT 'parentModel' as type, parentModel as name, COUNT(*) as model_count 
      FROM models 
      WHERE parentModel IS NOT NULL AND parentModel != '' 
      GROUP BY parentModel
      UNION ALL
      SELECT 'license' as type, license as name, COUNT(*) as model_count 
      FROM models 
      WHERE license IS NOT NULL AND license != '' 
      GROUP BY license
      ORDER BY type, name
    `).all();
  } catch (error) {
    console.error('Error getting metadata:', error);
    throw error;
  }
});

ipcMain.handle('rename-metadata', async (event, type, oldName, newName) => {
  try {
    if (!oldName || !newName || oldName.trim() === '' || newName.trim() === '') {
      throw new Error('Name cannot be empty');
    }

    // Validate type
    const validTypes = ['designer', 'parentModel', 'license'];
    if (!validTypes.includes(type)) {
      throw new Error('Invalid metadata type');
    }

    // Check if new name already exists for this type (for merge information)
    const existing = database.db.prepare(`
      SELECT COUNT(*) as count 
      FROM models 
      WHERE ${type} = ? AND ${type} IS NOT NULL AND ${type} != ''
    `).get(newName.trim());
    
    const existingCount = existing ? existing.count : 0;
    const isMerge = existingCount > 0;

    // Update all models with the old name to the new name (merge if new name exists)
    const result = database.db.prepare(`
      UPDATE models 
      SET ${type} = ? 
      WHERE ${type} = ?
    `).run(newName.trim(), oldName.trim());

    return { 
      success: true, 
      updated: result.changes,
      merged: isMerge,
      existingCount: existingCount
    };
  } catch (error) {
    console.error('Error renaming metadata:', error);
    throw error;
  }
});

ipcMain.handle('delete-metadata', async (event, type, name) => {
  try {
    if (!name || name.trim() === '') {
      throw new Error('Name cannot be empty');
    }

    // Validate type
    const validTypes = ['designer', 'parentModel', 'license'];
    if (!validTypes.includes(type)) {
      throw new Error('Invalid metadata type');
    }

    // Set the field to NULL for all models with that value
    const result = database.db.prepare(`
      UPDATE models 
      SET ${type} = NULL 
      WHERE ${type} = ?
    `).run(name.trim());

    return { success: true, updated: result.changes };
  } catch (error) {
    console.error('Error deleting metadata:', error);
    throw error;
  }
});

// Handler to pull metadata from 3MF files
ipcMain.handle('pull-3mf-metadata', async (event, filePaths) => {
  try {
    const filePathsArray = Array.isArray(filePaths) ? filePaths : [filePaths];
    
    // Filter to only 3MF files
    const threeMFFiles = filePathsArray.filter(fp => {
      const ext = path.extname(fp).toLowerCase();
      // Handle zip entries - check the entry path extension
      if (fp.includes('::')) {
        const entryPath = fp.split('::')[1];
        return path.extname(entryPath).toLowerCase() === '.3mf';
      }
      return ext === '.3mf';
    });
    
    if (threeMFFiles.length === 0) {
      throw new Error('No 3MF files selected');
    }
    
    // Check existing models to see if any have data that will be overwritten
    const modelsWithData = [];
    for (const filePath of threeMFFiles) {
      const model = getModelByFilePath(filePath, { includeThumbnail: true });
      if (model) {
        const hasData = (model.designer && model.designer.trim()) ||
                       (model.parentModel && model.parentModel.trim()) ||
                       (model.notes && model.notes.trim()) ||
                       (model.license && model.license.trim());
        if (hasData) {
          modelsWithData.push({
            filePath,
            fileName: model.fileName || path.basename(filePath),
            designer: model.designer,
            parentModel: model.parentModel,
            notes: model.notes,
            license: model.license
          });
        }
      }
    }
    
    // Show confirmation dialog if any models have existing data
    if (modelsWithData.length > 0) {
      const message = modelsWithData.length === 1
        ? `This will overwrite existing metadata for:\n\n${modelsWithData[0].fileName}\n\nExisting data:\n${modelsWithData[0].designer ? `Designer: ${modelsWithData[0].designer}\n` : ''}${modelsWithData[0].parentModel ? `Parent Model: ${modelsWithData[0].parentModel}\n` : ''}${modelsWithData[0].notes ? `Notes: ${modelsWithData[0].notes.substring(0, 50)}${modelsWithData[0].notes.length > 50 ? '...' : ''}\n` : ''}${modelsWithData[0].license ? `License: ${modelsWithData[0].license}\n` : ''}\n\nContinue?`
        : `This will overwrite existing metadata for ${modelsWithData.length} model(s).\n\nContinue?`;

      const confirm = await clientDialogs.messageBox(event, {
        type: 'warning',
        title: 'Confirm Metadata Overwrite',
        message: message,
        buttons: ['Yes', 'No'],
        defaultId: 1,
        cancelId: 1
      });

      if (confirm.response !== 0) {
        return { success: false, cancelled: true };
      }
    }
    
    // Process each file
    const results = [];
    let successCount = 0;
    let errorCount = 0;
    let noMetadataCount = 0;
    
    for (const filePath of threeMFFiles) {
      try {
        const metadata = await extract3MFMetadata(filePath);
        
        // Filter metadata based on user settings
        const filteredMetadata = filter3MFMetadataBySettings(metadata);
        
        if (filteredMetadata && (filteredMetadata.designer || filteredMetadata.parentModel || filteredMetadata.notes || filteredMetadata.license)) {
          // Get or create model in database
          let existingModel = getModelByFilePath(filePath, { includeThumbnail: true });
          
          if (!existingModel) {
            // Create new model entry
            const fileName = path.basename(filePath);
            const finalFileName = filePath.includes('::') 
              ? filePath.split('::').pop() 
              : fileName;
            const dateAdded = new Date().toISOString();
            
            database.db.prepare(`
              INSERT INTO models (filePath, fileName, designer, parentModel, notes, license, dateAdded, isNew)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            `).run(
              filePath,
              finalFileName,
              filteredMetadata.designer || null,
              filteredMetadata.parentModel || null,
              filteredMetadata.notes || null,
              filteredMetadata.license || null,
              dateAdded
            );
            
            results.push({ filePath, success: true, action: 'created' });
            successCount++;
          } else {
            // Update existing model - overwrite all fields
            database.db.prepare(`
              UPDATE models 
              SET designer = ?, parentModel = ?, notes = ?, license = ?
              WHERE filePath = ?
            `).run(
              filteredMetadata.designer || null,
              filteredMetadata.parentModel || null,
              filteredMetadata.notes || null,
              filteredMetadata.license || null,
              filePath
            );
            
            results.push({ filePath, success: true, action: 'updated' });
            successCount++;
          }
        } else {
          results.push({ filePath, success: false, error: 'No metadata found in 3MF file' });
          noMetadataCount++;
        }
      } catch (error) {
        console.error(`Error processing ${filePath}:`, error);
        results.push({ filePath, success: false, error: error.message });
        errorCount++;
      }
    }
    
    // Refresh the grid
    events.broadcast('refresh-grid');
    
    return {
      success: true,
      processed: threeMFFiles.length,
      successCount,
      errorCount,
      noMetadataCount,
      results
    };
  } catch (error) {
    console.error('Error pulling 3MF metadata:', error);
    throw error;
  }
});
