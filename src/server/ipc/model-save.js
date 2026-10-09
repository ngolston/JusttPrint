'use strict';

/** Saving models: one (saveModel), a batch of new ones, and batch edits from the details panel. */

const database = require('../../core/database');
const fs = require('fs');
const path = require('path');
const { deriveBundleFromFilePath } = require('../../core/bundle-keys');
const printEvents = require('../../core/print-events');
const { MODEL_DETAIL_COLUMNS, getModelById, modelUserFieldsChanged, normalizeModelRating, repairModelTagsTable } = require('../../core/models');
const { scheduleBackgroundHashGeneration } = require('./hashes');
const { isMacOsResourceForkEntry } = require('../../core/zip-entries');
const { withZipFileLock } = require('../../core/zip-extract');

async function saveModelBatch(modelDataBatch) {
  try {
    if (!database.db) {
      console.error('Database not initialized');
      return false;
    }

    // Begin a transaction for better performance
    const transaction = database.db.transaction(() => {
      const stmt = database.db.prepare(`
        INSERT OR IGNORE INTO models 
        (filePath, fileName, hash, size, modifiedDate, dateAdded, isNew) 
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `);

      for (const modelData of modelDataBatch) {
        const dateAdded = new Date().toISOString();
        stmt.run(modelData.filePath, modelData.fileName, modelData.hash || '', modelData.size || 0, modelData.modifiedDate || dateAdded, dateAdded);
      }
    });

    transaction();
    scheduleBackgroundHashGeneration('save-model-batch');
    return true;
  } catch (error) {
    console.error('Error saving model batch:', error);
    return false;
  }
}

// Bulk update function for updating multiple models in a single transaction
async function updateModelsBatch(modelDataBatch) {
  try {
    if (!database.db) {
      console.error('Database not initialized');
      return false;
    }

    // Enable foreign key constraints
    database.db.pragma('foreign_keys = ON');

    // Use a transaction for better performance - update models and tags together
    const transaction = database.db.transaction(() => {
      const getExistingModelStmt = database.db.prepare(`SELECT ${MODEL_DETAIL_COLUMNS} FROM models WHERE filePath = ?`);
      const getExistingTagsStmt = database.db.prepare(`
        SELECT t.name FROM model_tags mt
        JOIN tags t ON mt.tag_id = t.id
        WHERE mt.model_id = ?
      `);
      const updateStmt = database.db.prepare(`
        UPDATE models SET 
          fileName = ?,
          designer = ?,
          source = ?,
          notes = ?,
          printed = ?,
          print_status = ?,
          print_count = ?,
          last_printed_at = ?,
          parentModel = ?,
          license = ?,
          rating = ?,
          favorite = ?,
          isNew = CASE WHEN ? THEN 0 ELSE isNew END
        WHERE filePath = ?
      `);

      const deleteTagsStmt = database.db.prepare('DELETE FROM model_tags WHERE model_id = ?');
      const getTagIdStmt = database.db.prepare('SELECT id FROM tags WHERE name = ?');
      const insertTagStmt = database.db.prepare('INSERT OR IGNORE INTO model_tags (model_id, tag_id) VALUES (?, ?)');
      const insertTagNameStmt = database.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
      const getTagIdAfterInsertStmt = database.db.prepare('SELECT id FROM tags WHERE name = ?');

      for (let i = 0; i < modelDataBatch.length; i++) {
        const modelData = modelDataBatch[i];
        const { filePath, fileName, designer, source, notes, printed, printStatus, parentModel, license, rating, favorite, tags } = modelData;

        console.debug(`[Batch ${i}] Processing model: ${filePath}`);
        console.debug(`[Batch ${i}] Field values:`, { fileName, designer, source, notes, printed, parentModel, license, tags });

        // Get existing model to preserve values that aren't being updated
        const existingModel = getExistingModelStmt.get(filePath);

        if (!existingModel) {
          console.warn(`[Batch ${i}] Model not found in database: ${filePath}`);
          continue; // Skip this model if it doesn't exist
        }

        console.debug(`[Batch ${i}] Found existing model with ID: ${existingModel.id}`);
        // Only update fields that are explicitly provided (not undefined)
        const finalFileName = fileName !== undefined ? fileName : existingModel.fileName;
        const finalDesigner = designer !== undefined ? designer || null : existingModel.designer;
        const finalSource = source !== undefined ? source || null : existingModel.source;
        const finalNotes = notes !== undefined ? notes || null : existingModel.notes;
        const printFields = printEvents.resolvePrintFieldsOnSave(existingModel, { printed, printStatus });
        const finalPrinted = printFields.printed;
        const finalPrintStatus = printFields.print_status;
        const finalPrintCount = printFields.print_count;
        const finalLastPrintedAt = printFields.last_printed_at;
        const finalParentModel = parentModel !== undefined ? parentModel || null : existingModel.parentModel;
        const finalLicense = license !== undefined ? license || null : existingModel.license;
        const finalRating = rating !== undefined ? normalizeModelRating(rating) : normalizeModelRating(existingModel.rating);
        const finalFavorite = favorite !== undefined ? (favorite ? 1 : 0) : existingModel.favorite ? 1 : 0;

        const finals = {
          fileName: finalFileName,
          designer: finalDesigner,
          source: finalSource,
          notes: finalNotes,
          printed: finalPrinted,
          print_status: finalPrintStatus,
          parentModel: finalParentModel,
          license: finalLicense
        };
        let clearIsNew = modelUserFieldsChanged(existingModel, finals);
        if (!clearIsNew && tags !== undefined && Array.isArray(tags)) {
          const existingTagRows = getExistingTagsStmt.all(existingModel.id).map((row) => row.name);
          clearIsNew = JSON.stringify(sortedTagNames(existingTagRows)) !== JSON.stringify(sortedTagNames(tags));
        }

        // Update model fields
        console.debug(`[Batch ${i}] Updating model with values:`, {
          finalFileName,
          finalDesigner,
          finalSource,
          finalNotes,
          finalPrinted,
          finalParentModel,
          finalLicense,
          filePath,
          clearIsNew
        });
        const updateResult = updateStmt.run(
          finalFileName,
          finalDesigner,
          finalSource,
          finalNotes,
          finalPrinted,
          finalPrintStatus,
          finalPrintCount,
          finalLastPrintedAt,
          finalParentModel,
          finalLicense,
          finalRating,
          finalFavorite,
          clearIsNew ? 1 : 0,
          filePath
        );
        console.debug(`[Batch ${i}] Update result:`, updateResult);

        // Replace the tags when a list is given; an empty list removes them all.
        if (Array.isArray(tags)) {
          const modelId = existingModel.id;

          // Delete existing tags
          deleteTagsStmt.run(modelId);

          // Insert new tags
          for (const tagName of tags) {
            if (!tagName || typeof tagName !== 'string' || tagName.trim() === '') continue;

            const trimmedTagName = tagName.trim();

            // Get or create tag
            let tagResult = getTagIdStmt.get(trimmedTagName);
            if (!tagResult) {
              // Tag doesn't exist, create it
              insertTagNameStmt.run(trimmedTagName);
              tagResult = getTagIdAfterInsertStmt.get(trimmedTagName);
            }

            if (tagResult) {
              insertTagStmt.run(modelId, tagResult.id);
            }
          }
        }
      }
    });

    transaction();

    return true;
  } catch (error) {
    console.error('Error updating models batch:', error);
    return false;
  }
}

function sortedTagNames(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => String(t).trim())
    .filter(Boolean)
    .sort();
}

// Add this function before the IPC handlers
async function saveModel(modelData) {
  try {
    console.debug('saveModel:', modelData?.filePath, modelData?.id != null ? `(id ${modelData.id})` : '');

    const {
      filePath: filePathIn,
      fileName,
      designer,
      source,
      notes,
      printed,
      printStatus,
      parentModel,
      license,
      rating,
      favorite,
      tags: rawTags,
      markAsNew
    } = modelData;

    const filePath = filePathIn;

    // Standalone .zip: only add if "Include zipped models" is enabled; add each STL/3MF inside (like scan)
    if (filePath && filePath.toLowerCase().endsWith('.zip') && !filePath.includes('::')) {
      const zipSetting = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enableZipArchives');
      const enableZipArchives = zipSetting && zipSetting.value === '1';
      if (!enableZipArchives) {
        throw new Error('ZIP archives are disabled. Enable "Include zipped models" in Settings to add .zip files.');
      }
      // List STL/3MF entries and save each as zipPath::entryPath (same as scan)
      if (!fs.existsSync(filePath)) {
        throw new Error(`ZIP file not found: ${filePath}`);
      }
      const entries = await withZipFileLock(filePath, async () => {
        const StreamZip = require('node-stream-zip');
        const zip = new StreamZip.async({ file: filePath });
        try {
          return await zip.entries();
        } finally {
          await zip.close();
        }
      });
      // Lazy: models.js loads this module.
      const modelExts = require('./models').getSupportedExtensionsForLibrary(database.db);
      const toAdd = Object.values(entries).filter(
        (e) => !e.isDirectory && modelExts.includes(path.extname(e.name).toLowerCase()) && !isMacOsResourceForkEntry(e.name)
      );
      if (toAdd.length === 0) {
        throw new Error('No supported model files found in the ZIP file. Enable additional file types in Settings > File Types if needed.');
      }
      const baseMeta = {
        designer,
        source,
        notes,
        printed,
        parentModel,
        license,
        rating,
        favorite,
        tags: rawTags,
        markAsNew
      };
      for (const entry of toAdd) {
        const entryPath = `${filePath}::${entry.name}`;
        const entryFileName = path.basename(entry.name);
        await saveModel({
          ...baseMeta,
          filePath: entryPath,
          fileName: entryFileName
        });
      }
      return { success: true, expanded: true, count: toAdd.length };
    }

    // Ensure tags is always an array, even if a single string was passed
    const tags = rawTags ? (Array.isArray(rawTags) ? rawTags : [rawTags]) : [];

    console.debug(`Processing notes field: "${notes}"`);

    // Enable foreign key constraints
    database.db.pragma('foreign_keys = ON');

    // First, handle the model data without tags
    let modelId;
    let insertedNewModel = false;
    try {
      // Check if the model exists first
      const existingModel = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get(filePath);

      if (existingModel) {
        // Update existing model
        console.debug(`Updating existing model with ID: ${existingModel.id}`);

        // Get existing model data to preserve values that aren't being updated
        const existingModelData = getModelById(existingModel.id);

        // Only update fields that are explicitly provided (not undefined)
        // Preserve existing values for fields that are undefined in the update
        const finalFileName = fileName !== undefined ? fileName : existingModelData.fileName;
        const finalDesigner = designer !== undefined ? designer || null : existingModelData.designer;
        const finalSource = source !== undefined ? source || null : existingModelData.source;
        const finalNotes = notes !== undefined ? notes || null : existingModelData.notes;
        const printFields = printEvents.resolvePrintFieldsOnSave(existingModelData, { printed, printStatus });
        const finalPrinted = printFields.printed;
        const finalPrintStatus = printFields.print_status;
        const finalPrintCount = printFields.print_count;
        const finalLastPrintedAt = printFields.last_printed_at;
        const finalParentModel = parentModel !== undefined ? parentModel || null : existingModelData.parentModel;
        const finalLicense = license !== undefined ? license || null : existingModelData.license;
        const finalRating = rating !== undefined ? normalizeModelRating(rating) : normalizeModelRating(existingModelData.rating);
        const finalFavorite = favorite !== undefined ? (favorite ? 1 : 0) : existingModelData.favorite ? 1 : 0;

        const finals = {
          fileName: finalFileName,
          designer: finalDesigner,
          source: finalSource,
          notes: finalNotes,
          printed: finalPrinted,
          print_status: finalPrintStatus,
          parentModel: finalParentModel,
          license: finalLicense
        };
        let clearIsNew = !markAsNew && modelUserFieldsChanged(existingModelData, finals);
        if (!markAsNew && !clearIsNew && rawTags !== undefined) {
          const existingTagRows = database.db
            .prepare(
              `
            SELECT t.name FROM model_tags mt
            JOIN tags t ON mt.tag_id = t.id
            WHERE mt.model_id = ?
          `
            )
            .all(existingModel.id)
            .map((row) => row.name);
          clearIsNew = JSON.stringify(sortedTagNames(existingTagRows)) !== JSON.stringify(sortedTagNames(tags));
        }
        const bundle = deriveBundleFromFilePath(filePath);

        // Use a simpler update approach to avoid foreign key issues
        const updateStmt = database.db.prepare(`
          UPDATE models SET 
            fileName = ?,
            designer = ?,
            source = ?,
            notes = ?,
            printed = ?,
            print_status = ?,
            print_count = ?,
            last_printed_at = ?,
            parentModel = ?,
            license = ?,
            rating = ?,
            favorite = ?,
            bundleKey = ?,
            bundleLabel = ?,
            bundleKind = ?,
            isNew = CASE WHEN ? THEN 1 WHEN ? THEN 0 ELSE isNew END
          WHERE id = ?
        `);

        updateStmt.run(
          finalFileName,
          finalDesigner,
          finalSource,
          finalNotes,
          finalPrinted,
          finalPrintStatus,
          finalPrintCount,
          finalLastPrintedAt,
          finalParentModel,
          finalLicense,
          finalRating,
          finalFavorite,
          bundle.bundleKey || null,
          bundle.bundleLabel || null,
          bundle.bundleKind || null,
          markAsNew ? 1 : 0,
          clearIsNew ? 1 : 0,
          existingModel.id
        );

        modelId = existingModel.id;
      } else {
        // Insert new model
        console.debug('Inserting new model');

        const printFields = printEvents.resolvePrintFieldsOnSave(null, { printed, printStatus });
        const dateAdded = new Date().toISOString();
        const bundle = deriveBundleFromFilePath(filePath);
        const insertStmt = database.db.prepare(`
          INSERT INTO models (
            filePath, fileName, designer, source, notes, printed, print_status, print_count, last_printed_at, parentModel, license,
            dateAdded, isNew, rating, favorite, bundleKey, bundleLabel, bundleKind
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        `);

        const result = insertStmt.run(
          filePath,
          fileName,
          designer || null,
          source || null,
          notes || null,
          printFields.printed,
          printFields.print_status,
          printFields.print_count,
          printFields.last_printed_at,
          parentModel || null,
          license || null,
          dateAdded,
          normalizeModelRating(rating),
          favorite ? 1 : 0,
          bundle.bundleKey || null,
          bundle.bundleLabel || null,
          bundle.bundleKind || null
        );

        modelId = result.lastInsertRowid;
        insertedNewModel = true;
      }

      console.debug(`Model saved with ID: ${modelId}`);
    } catch (modelError) {
      console.error('Error saving model data:', modelError);
      throw modelError;
    }

    // Now handle tags in a separate transaction if we have a valid model ID
    // Note: We need to process tags even if the array is empty (to remove all tags)
    if (modelId && tags && Array.isArray(tags)) {
      try {
        console.debug(`Processing ${tags.length} tags for model ID ${modelId}`);

        // Double-check that the model exists before proceeding
        const modelExists = database.db.prepare('SELECT 1 FROM models WHERE id = ?').get(modelId);
        if (!modelExists) {
          console.error(`Model ID ${modelId} does not exist in the database. This should not happen.`);
          return { success: true, modelId }; // Return success but skip tag processing
        }

        // Use a transaction to ensure atomicity and handle errors gracefully
        database.db.transaction(() => {
          // Remove all existing tags for this model
          const deleteResult = database.db.prepare('DELETE FROM model_tags WHERE model_id = ?').run(modelId);
          console.debug(`Deleted ${deleteResult.changes} existing tag relationships`);

          // Process each tag individually (only if there are tags to add)
          if (tags.length > 0) {
            for (const tagName of tags) {
              if (tagName && typeof tagName === 'string' && tagName.trim() !== '') {
                const trimmedTagName = tagName.trim();
                try {
                  console.debug(`Processing tag: "${trimmedTagName}"`);

                  // First ensure the tag exists in the tags table
                  database.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(trimmedTagName);

                  // Get the tag ID directly
                  const tagRow = database.db.prepare('SELECT id FROM tags WHERE name = ?').get(trimmedTagName);

                  if (tagRow && tagRow.id) {
                    console.debug(`Found tag ID ${tagRow.id} for "${trimmedTagName}"`);

                    // Now create the relationship with the known IDs
                    database.db.prepare('INSERT OR IGNORE INTO model_tags (model_id, tag_id) VALUES (?, ?)').run(modelId, tagRow.id);
                  } else {
                    console.warn(`Could not find tag ID for "${trimmedTagName}" after insertion`);
                  }
                } catch (singleTagError) {
                  console.error(`Error processing tag "${trimmedTagName}":`, singleTagError);
                  // Continue with other tags
                }
              }
            }
          } else {
            console.debug('Tags array is empty - all tags have been removed from this model');
          }
        })();
      } catch (tagError) {
        console.error('Error updating tags:', tagError);

        // models_old means model_tags still references the renamed parent table.
        // Repair outside this failed transaction, then retry the tag write.
        if (tagError.message && tagError.message.includes('models_old')) {
          console.log('Detected models_old error. Repairing model_tags and retrying...');
          try {
            repairModelTagsTable();
            // Retry the tag save operation in a new transaction
            database.db.transaction(() => {
              // Delete existing tags first
              database.db.prepare('DELETE FROM model_tags WHERE model_id = ?').run(modelId);

              // Re-insert the tags we were trying to save (only if there are tags)
              if (tags.length > 0) {
                for (const tagName of tags) {
                  if (tagName && typeof tagName === 'string' && tagName.trim() !== '') {
                    const trimmedTagName = tagName.trim();
                    try {
                      database.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(trimmedTagName);
                      const tagRow = database.db.prepare('SELECT id FROM tags WHERE name = ?').get(trimmedTagName);
                      if (tagRow && tagRow.id) {
                        database.db.prepare('INSERT OR IGNORE INTO model_tags (model_id, tag_id) VALUES (?, ?)').run(modelId, tagRow.id);
                      }
                    } catch (retryError) {
                      console.error(`Error retrying tag "${trimmedTagName}":`, retryError);
                    }
                  }
                }
              }
            })();
            console.log('Successfully retried tag save after repairing model_tags');
          } catch (cleanupError) {
            console.error('Error during cleanup and retry:', cleanupError);
            // Don't throw - we want to preserve the model save even if tags fail
          }
        }
        // Continue with the save even if tag update fails - don't throw to preserve model data
      }
    }

    if (insertedNewModel) {
      scheduleBackgroundHashGeneration('save-model');
    }
    return { success: true, modelId };
  } catch (error) {
    console.error('Error saving model:', error);
    throw error;
  }
}

module.exports = { saveModel, saveModelBatch, updateModelsBatch };
