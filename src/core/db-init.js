'use strict';

const database = require('./database');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { deriveBundleFromFilePath } = require('../../bundle-keys');
const printEvents = require('../../print-events');
const printerManager = require('../../printer-manager');
const { repairModelTagsTable } = require('./models');
const { ensureSlicersTableExists } = require('../server/ipc/slicers');
const { getDatabasePath } = require('./db-path');
const { version } = require('../../package.json');

// Add this function to initialize the database
function initializeDatabase() {
  try {
    const dbPath = getDatabasePath();
    console.log(`Initializing database at ${dbPath}`);
    
    // Create database directory if it doesn't exist
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    // Initialize database
    database.db = new Database(dbPath);
    
    // Enable foreign keys
    database.db.pragma('foreign_keys = ON');
    
    // Create tables in sequence
    database.db.transaction(() => {
      // Create models table
      database.db.prepare(`CREATE TABLE IF NOT EXISTS models (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filePath TEXT UNIQUE,
          fileName TEXT,
          designer TEXT,
          source TEXT,
          notes TEXT,
          printed INTEGER,
          print_status TEXT DEFAULT 'unprinted',
          print_count INTEGER DEFAULT 0,
          last_printed_at DATETIME,
          thumbnail TEXT,
          parentModel TEXT,
          hash TEXT,
          size INTEGER,
          license TEXT,
          modifiedDate DATETIME,
          dateAdded DATETIME,
          isNew INTEGER DEFAULT 1,
          rating INTEGER DEFAULT 0,
          favorite INTEGER DEFAULT 0,
          bundleKey TEXT,
          bundleLabel TEXT,
          bundleKind TEXT
      )`).run();

      // Create tags table
      database.db.prepare(`CREATE TABLE IF NOT EXISTS tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE
      )`).run();

      // Create model_tags table
      database.db.prepare(`CREATE TABLE IF NOT EXISTS model_tags (
          model_id INTEGER,
          tag_id INTEGER,
          FOREIGN KEY(model_id) REFERENCES models(id),
          FOREIGN KEY(tag_id) REFERENCES tags(id),
          PRIMARY KEY(model_id, tag_id)
      )`).run();
      
      // Create settings table
      database.db.prepare(`CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT
      )`).run();
      
      // Create slicers table
      database.db.prepare(`CREATE TABLE IF NOT EXISTS slicers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          path TEXT NOT NULL
      )`).run();
      
      // Create indexes for better performance
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_filepath ON models(filePath)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_filename ON models(fileName)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_designer ON models(designer)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_model_tags_tag_id ON model_tags(tag_id)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_model_tags_model_id ON model_tags(model_id)').run();

      database.db.prepare(`CREATE TABLE IF NOT EXISTS filaments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          vendor TEXT,
          material TEXT,
          color_hex TEXT,
          diameter REAL,
          spoolman_id INTEGER UNIQUE,
          source TEXT NOT NULL DEFAULT 'manual'
      )`).run();
      database.db.prepare(`CREATE TABLE IF NOT EXISTS model_filaments (
          model_id INTEGER,
          filament_id INTEGER,
          FOREIGN KEY(model_id) REFERENCES models(id),
          FOREIGN KEY(filament_id) REFERENCES filaments(id),
          PRIMARY KEY(model_id, filament_id)
      )`).run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_filaments_name ON filaments(name)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_filaments_spoolman_id ON filaments(spoolman_id)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_model_filaments_filament_id ON model_filaments(filament_id)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_model_filaments_model_id ON model_filaments(model_id)').run();
      
      // Single-column indexes for sorting and filtering
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_size ON models(size)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_modifieddate ON models(modifiedDate)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_license ON models(license)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_parentmodel ON models(parentModel)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_printed ON models(printed)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_hash ON models(hash)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_thumbnail ON models(thumbnail)').run();
      
      // Composite indexes for common query patterns
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_designer_filename ON models(designer, fileName)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_license_modifieddate ON models(license, modifiedDate)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_printed_modifieddate ON models(printed, modifiedDate)').run();
      database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_parentmodel_modifieddate ON models(parentModel, modifiedDate)').run();
    })();
    
    // Migrate existing database: add dateAdded column if it doesn't exist
    // This must run before creating indexes on dateAdded
    migrateDateAddedColumn();
    migrateIsNewColumn();
    migrateRatingFavoriteColumns();
    migrateBundleColumns();
    migratePrintLifecycleColumns();
    clearFailurePlaceholderThumbnails();
    
    // Create index for dateAdded after migration (in case it was just added)
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_dateadded ON models(dateAdded)').run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_isnew ON models(isNew)').run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_rating ON models(rating)').run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_favorite ON models(favorite)').run();
    
    // Clean up any database objects that reference models_old (from old migrations)
    cleanupModelsOldReferences();
    
    // Repair model_tags table to fix any foreign key issues
    repairModelTagsTable();
    
    // Check and create slicers table if it doesn't exist
    ensureSlicersTableExists();
    ensureFilamentsTablesExist();
    ensurePartsTablesExist();
    
    // Initialize default settings
    initializeDefaultSettings();

    // Integrity / orphan cleanup: deferred in app.whenReady so startup is not blocked (see setTimeout there)

    return true;
  } catch (err) {
    console.error('Error initializing database:', err);
    console.error(`Database Error: failed to initialize the database at ${getDatabasePath()}: ${err.message}. Check that the data folder is writable (PUID/PGID).`);
    return false;
  }
}

// Add migration function for dateAdded column
function migrateDateAddedColumn() {
  try {
    console.log('Checking for dateAdded column migration...');
    
    // Check if dateAdded column exists
    const tableInfo = database.db.prepare("PRAGMA table_info(models)").all();
    const hasDateAdded = tableInfo.some(col => col.name === 'dateAdded');
    
    if (!hasDateAdded) {
      console.log('dateAdded column not found. Adding it...');
      
      // Add the column
      database.db.prepare('ALTER TABLE models ADD COLUMN dateAdded DATETIME').run();
      
      // For existing records, set dateAdded = modifiedDate as fallback, or current timestamp if modifiedDate is null
      database.db.prepare(`
        UPDATE models 
        SET dateAdded = COALESCE(modifiedDate, datetime('now'))
        WHERE dateAdded IS NULL
      `).run();
      
      console.log('dateAdded column added and existing records updated');
    } else {
      console.log('dateAdded column already exists');
    }
    
    return true;
  } catch (error) {
    console.error('Error migrating dateAdded column:', error);
    return false;
  }
}

/** Add isNew column for "new until edited" badge; existing rows are not new. */
function migrateIsNewColumn() {
  try {
    console.log('Checking for isNew column migration...');
    const tableInfo = database.db.prepare('PRAGMA table_info(models)').all();
    const hasIsNew = tableInfo.some(col => col.name === 'isNew');
    if (!hasIsNew) {
      console.log('isNew column not found. Adding it...');
      database.db.prepare('ALTER TABLE models ADD COLUMN isNew INTEGER DEFAULT 1').run();
      database.db.prepare('UPDATE models SET isNew = 0').run();
      console.log('isNew column added; existing models marked as not new');
    } else {
      console.log('isNew column already exists');
    }
    return true;
  } catch (error) {
    console.error('Error migrating isNew column:', error);
    return false;
  }
}

/** Add rating (0-5) and favorite (0/1) columns for model engagement. */
function migrateRatingFavoriteColumns() {
  try {
    console.log('Checking for rating/favorite column migration...');
    const tableInfo = database.db.prepare('PRAGMA table_info(models)').all();
    const hasRating = tableInfo.some(col => col.name === 'rating');
    const hasFavorite = tableInfo.some(col => col.name === 'favorite');
    if (!hasRating) {
      console.log('rating column not found. Adding it...');
      database.db.prepare('ALTER TABLE models ADD COLUMN rating INTEGER DEFAULT 0').run();
      database.db.prepare('UPDATE models SET rating = 0 WHERE rating IS NULL').run();
    }
    if (!hasFavorite) {
      console.log('favorite column not found. Adding it...');
      database.db.prepare('ALTER TABLE models ADD COLUMN favorite INTEGER DEFAULT 0').run();
      database.db.prepare('UPDATE models SET favorite = 0 WHERE favorite IS NULL').run();
    }
    return true;
  } catch (error) {
    console.error('Error migrating rating/favorite columns:', error);
    return false;
  }
}

function migratePrintLifecycleColumns() {
  try {
    printEvents.migratePrintLifecycle(database.db);
    printerManager.ensurePrinterSchema(database.db);
    return true;
  } catch (error) {
    console.error('Error migrating print lifecycle columns:', error);
    return false;
  }
}

/** Zip bundle columns for grouped browsing (folder siblings are not bundled). */
function migrateBundleColumns() {
  try {
    console.log('Checking for bundle column migration...');
    const tableInfo = database.db.prepare('PRAGMA table_info(models)').all();
    const names = new Set(tableInfo.map((col) => col.name));
    const additions = [
      ['bundleKey', 'TEXT'],
      ['bundleLabel', 'TEXT'],
      ['bundleKind', 'TEXT'],
    ];
    for (const [col, ddl] of additions) {
      if (!names.has(col)) {
        database.db.prepare(`ALTER TABLE models ADD COLUMN ${col} ${ddl}`).run();
        console.log(`Added models.${col}`);
      }
    }
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_models_bundlekey ON models(bundleKey)').run();

    // After the one-shot zip-only migration, skip the heavy folder-clear + backfill work.
    // New scans/saves already persist bundle fields; remaining NULL keys are intentional for non-zips.
    const migrationDone = database.db.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).get('bundleMigrationZipOnlyComplete')?.value;
    if (migrationDone === '1') {
      return true;
    }

    // Clear legacy folder bundles — only ZIP archives should group via bundle fields.
    const cleared = database.db.prepare(`
      UPDATE models
      SET bundleKey = NULL, bundleLabel = NULL, bundleKind = NULL
      WHERE bundleKind = 'folder'
         OR (bundleKey IS NOT NULL AND lower(bundleKey) LIKE 'folder:%')
    `).run();
    if (cleared.changes > 0) {
      console.log(`Cleared folder bundle fields for ${cleared.changes} model(s)`);
    }

    // Only backfill zip entries still missing keys. Non-zip models correctly stay NULL;
    // selecting all NULL rows re-wrote the whole library on every cold start.
    const rows = database.db.prepare(`
      SELECT id, filePath FROM models
      WHERE (bundleKey IS NULL OR bundleKey = '')
        AND instr(filePath, '::') > 0
        AND filePath NOT LIKE 'url::%'
    `).all();
    if (rows.length > 0) {
      const update = database.db.prepare(
        'UPDATE models SET bundleKey = ?, bundleLabel = ?, bundleKind = ? WHERE id = ?'
      );
      const backfill = database.db.transaction(() => {
        for (const row of rows) {
          const bundle = deriveBundleFromFilePath(row.filePath);
          if (!bundle.bundleKey) continue;
          update.run(bundle.bundleKey, bundle.bundleLabel || null, bundle.bundleKind || null, row.id);
        }
      });
      backfill();
      console.log(`Backfilled bundle fields for ${rows.length} zip model(s)`);
    }

    database.db.prepare(
      `INSERT INTO settings (key, value) VALUES ('bundleMigrationZipOnlyComplete', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();
    return true;
  } catch (error) {
    console.error('Error migrating bundle columns:', error);
    return false;
  }
}

/**
 * One-shot: clear tiny data-URL thumbs left by Docker/server load failures.
 * Failure placeholders (typed "STL" / "Model may be corrupted") are ~2–8KB data URLs;
 * real WebGL renders are almost always larger. Resetting to 3d.png clears hasThumbnail
 * so the grid can regenerate.
 */
function clearFailurePlaceholderThumbnails() {
  try {
    const done = database.db.prepare(
      'SELECT value FROM settings WHERE key = ?'
    ).get('failurePlaceholderThumbCleanupComplete')?.value;
    if (done === '1') return true;

    console.log('Clearing likely failure-placeholder thumbnails (one-shot)...');
    const cleared = database.db.prepare(`
      UPDATE models
      SET thumbnail = '3d.png'
      WHERE thumbnail IS NOT NULL
        AND thumbnail LIKE 'data:image%'
        AND length(thumbnail) < 12000
    `).run();
    if (cleared.changes > 0) {
      console.log(`Reset ${cleared.changes} small data-URL thumbnail(s) to 3d.png for regeneration`);
    }

    database.db.prepare(
      `INSERT INTO settings (key, value) VALUES ('failurePlaceholderThumbCleanupComplete', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run();
    return true;
  } catch (error) {
    console.error('Error clearing failure-placeholder thumbnails:', error);
    return false;
  }
}

// Add this function to clean up any database objects referencing models_old
function cleanupModelsOldReferences() {
  try {
    console.log('Checking for database objects referencing models_old...');
    
    // Check for triggers that reference models_old
    const triggers = database.db.prepare(`
      SELECT name, sql 
      FROM sqlite_master 
      WHERE type='trigger' 
      AND (sql LIKE '%models_old%' OR sql LIKE '%modelsOld%')
    `).all();
    
    if (triggers.length > 0) {
      console.log(`Found ${triggers.length} trigger(s) referencing models_old. Removing them...`);
      for (const trigger of triggers) {
        try {
          database.db.prepare(`DROP TRIGGER IF EXISTS ${trigger.name}`).run();
          console.log(`Removed trigger: ${trigger.name}`);
        } catch (error) {
          console.error(`Error removing trigger ${trigger.name}:`, error);
        }
      }
    }
    
    // Check for views that reference models_old
    const views = database.db.prepare(`
      SELECT name, sql 
      FROM sqlite_master 
      WHERE type='view' 
      AND (sql LIKE '%models_old%' OR sql LIKE '%modelsOld%')
    `).all();
    
    if (views.length > 0) {
      console.log(`Found ${views.length} view(s) referencing models_old. Removing them...`);
      for (const view of views) {
        try {
          database.db.prepare(`DROP VIEW IF EXISTS ${view.name}`).run();
          console.log(`Removed view: ${view.name}`);
        } catch (error) {
          console.error(`Error removing view ${view.name}:`, error);
        }
      }
    }
    
    // Check for indexes that reference models_old (unlikely but possible)
    const indexes = database.db.prepare(`
      SELECT name 
      FROM sqlite_master 
      WHERE type='index' 
      AND name LIKE '%models_old%'
    `).all();
    
    if (indexes.length > 0) {
      console.log(`Found ${indexes.length} index(es) referencing models_old. Removing them...`);
      for (const index of indexes) {
        try {
          database.db.prepare(`DROP INDEX IF EXISTS ${index.name}`).run();
          console.log(`Removed index: ${index.name}`);
        } catch (error) {
          console.error(`Error removing index ${index.name}:`, error);
        }
      }
    }
    
    console.log('Finished cleaning up models_old references');
    return true;
  } catch (error) {
    console.error('Error cleaning up models_old references:', error);
    return false;
  }
}

// Add this function after repairModelTagsTable
function initializeDefaultSettings() {
  try {
    console.log('Initializing default settings...');
    
    // Check if settings table exists
    const tableExists = database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
    if (!tableExists) {
      database.db.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)').run();
    }

    // Define default settings
    const defaultSettings = [
      { key: 'tosAcceptedDate', value: null },
      { key: 'theme', value: 'light' },
      { key: 'apiKey', value: null },
      { key: 'aiModel', value: 'gpt-5-nano' },
      { key: 'maxThumbnailSize', value: '300' },
      { key: 'maxConcurrentRenders', value: '3' },
      { key: 'lastVersionCheck', value: new Date().toISOString() },
      { key: 'currentVersion', value: version }, // Use imported version from package.json
      { key: 'versionCheckPerformedOnStartup', value: 'false' }, // New setting for version check tracking
      { key: 'autoUpdateCheck', value: '1' }, // '0' turns off the automatic version check
      { key: 'enableZipArchives', value: '0' }, // ZIP archive support disabled by default
      { key: 'scanAdditionalFileTypes', value: '[]' }, // JSON array of catalog ids for additional scan types (e.g. ["obj","step"])
      { key: 'scanExcludeFolders', value: '' }, // Extra folder names to skip while scanning, one per line
      { key: 'stlHomeDirectories', value: '[]' }, // JSON array of directories scanned as STL Home
      { key: 'stlHomeExcludeDirectories', value: '[]' }, // JSON array of directories skipped by STL Home scans
      { key: 'aiTagFolderLevels', value: '2' }, // Parent folders sent to AI tagging and used by Tag from Folder
      { key: 'autoTagFromFolderOnScan', value: '0' }, // Add folder-name tags to files a scan newly inserts. No AI.
      { key: 'aiTagMaxTags', value: '10' }, // Maximum number of AI-generated tags
      { key: 'aiTagUseCategories', value: '0' }, // Use category-based tagging
      { key: 'aiTagMergeStrategy', value: 'merge' }, // How to merge AI tags: 'replace', 'merge', 'append'
      { key: 'aiTagAllowRetagging', value: '0' }, // Allow re-tagging even if "AI Tagged" exists
      { key: 'aiTagConcurrency', value: '3' }, // Number of concurrent tag generation requests
      { key: 'enableBrowserExtension', value: '0' }, // Legacy: extension no longer starts the local HTTP server
      { key: 'browserExtensionPort', value: '5000' }, // Port for MCP local server (default 5000)
      { key: 'extensionInboxDirectory', value: '' }, // Empty = Downloads/PrintventoryInbox
      { key: 'extensionInboxLastStatus', value: '' },
      { key: 'enableMcpServer', value: '0' }, // MCP listener disabled by default in desktop mode
      { key: 'spoolmanUrl', value: '' },
      { key: 'spoolmanApiToken', value: '' },
      { key: 'tlsMode', value: 'off' },
      { key: 'tlsCertPath', value: '' },
      { key: 'tlsKeyPath', value: '' },
      { key: 'tlsCaPath', value: '' },
      { key: 'tlsDomain', value: '' },
      { key: 'tlsEmail', value: '' },
      { key: 'tlsAgreeTos', value: '0' },
      { key: 'tlsUseStaging', value: '0' },
      { key: 'tlsRedirectHttp', value: '0' },
    ];
    
    // Insert default settings if they don't exist
    const insertStmt = database.db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    
    for (const setting of defaultSettings) {
      insertStmt.run(setting.key, setting.value);
    }

    // Usage tracking was removed; drop its settings from older databases.
    database.db.prepare("DELETE FROM settings WHERE key IN ('CollectUsage', 'ClientId')").run();

    console.log('Default settings initialized');
    return true;
  } catch (error) {
    console.error('Error initializing default settings:', error);
    return false;
  }
}

function ensurePartsTablesExist() {
  try {
    printEvents.ensurePartsSchema(database.db);
    return true;
  } catch (error) {
    console.error('Error ensuring parts tables exist:', error);
    return false;
  }
}

function ensureFilamentsTablesExist() {
  try {
    database.db.prepare(`CREATE TABLE IF NOT EXISTS filaments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        vendor TEXT,
        material TEXT,
        color_hex TEXT,
        diameter REAL,
        spoolman_id INTEGER UNIQUE,
        source TEXT NOT NULL DEFAULT 'manual'
    )`).run();
    database.db.prepare(`CREATE TABLE IF NOT EXISTS model_filaments (
        model_id INTEGER,
        filament_id INTEGER,
        FOREIGN KEY(model_id) REFERENCES models(id),
        FOREIGN KEY(filament_id) REFERENCES filaments(id),
        PRIMARY KEY(model_id, filament_id)
    )`).run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_filaments_name ON filaments(name)').run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_filaments_spoolman_id ON filaments(spoolman_id)').run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_model_filaments_filament_id ON model_filaments(filament_id)').run();
    database.db.prepare('CREATE INDEX IF NOT EXISTS idx_model_filaments_model_id ON model_filaments(model_id)').run();
    return true;
  } catch (error) {
    console.error('Error ensuring filaments tables exist:', error);
    return false;
  }
}

// Register save-model for Chrome extension (WebSocket works in normal and server mode)


// Add this function before saveModel
function verifyDatabaseIntegrity() {
  try {
    console.log('Verifying database integrity...');
    
    // Check if foreign keys are enabled
    const foreignKeysEnabled = database.db.pragma('foreign_keys');
    console.log(`Foreign keys enabled: ${foreignKeysEnabled}`);
    
    // Run integrity check
    const integrityCheck = database.db.pragma('integrity_check');
    console.log(`Integrity check result: ${JSON.stringify(integrityCheck)}`);
    
    repairModelTagsTable();
    
    return true;
  } catch (error) {
    console.error('Database integrity check failed:', error);
    return false;
  }
}

module.exports = { initializeDatabase, verifyDatabaseIntegrity };
