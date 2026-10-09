'use strict';

const path = require('path');
const events = require('../events');
const database = require('../../core/database');
const { getModelByFilePath } = require('../../core/models');
const { clientDialogs } = require('../dialogs');
const { extract3MFMetadata, filter3MFMetadataBySettings } = require('../../core/three-mf');

/** Context menu → Pull Metadata: reads the selected 3MF files' metadata into the library. */
async function pullMetadataFromMenu(event, filePaths) {
  try {
    // Filter to only 3MF files
    const threeMFFiles = filePaths.filter((fp) => {
      const ext = path.extname(fp).toLowerCase();
      if (fp.includes('::')) {
        const entryPath = fp.split('::')[1];
        return path.extname(entryPath).toLowerCase() === '.3mf';
      }
      return ext === '.3mf';
    });

    if (threeMFFiles.length === 0) {
      return;
    }

    // Check existing models to see if any have data that will be overwritten
    const modelsWithData = [];
    for (const filePath of threeMFFiles) {
      const model = getModelByFilePath(filePath, { includeThumbnail: true });
      if (model) {
        const hasData =
          (model.designer && model.designer.trim()) ||
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
      const message =
        modelsWithData.length === 1
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
        return; // User cancelled
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
            const finalFileName = filePath.includes('::') ? filePath.split('::').pop() : fileName;
            const dateAdded = new Date().toISOString();

            database.db
              .prepare(
                `
              INSERT INTO models (filePath, fileName, designer, parentModel, notes, license, dateAdded, isNew)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            `
              )
              .run(
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
            database.db
              .prepare(
                `
              UPDATE models 
              SET designer = ?, parentModel = ?, notes = ?, license = ?
              WHERE filePath = ?
            `
              )
              .run(
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

    // Show completion message
    let message = '';
    if (successCount > 0) {
      message = `Successfully pulled metadata from ${successCount} file(s).`;
    }

    const parts = [];
    if (noMetadataCount > 0) {
      parts.push(`${noMetadataCount} file(s) didn't have metadata`);
    }
    if (errorCount > 0) {
      parts.push(`${errorCount} file(s) had errors`);
    }

    if (parts.length > 0) {
      if (message) {
        message += '\n\n' + parts.join('.\n');
      } else {
        message = parts.join('.\n');
      }
    }

    if (!message) {
      message = 'No files processed.';
    }

    await clientDialogs.messageBox(event, {
      type: 'info',
      title: 'Metadata Pull Complete',
      message: message
    });
  } catch (error) {
    console.error('Error pulling metadata:', error);
    await clientDialogs.messageBox(event, {
      type: 'error',
      title: 'Error',
      message: 'Could not pull metadata',
      detail: error.message
    });
  }
}

module.exports = { pullMetadataFromMenu };
