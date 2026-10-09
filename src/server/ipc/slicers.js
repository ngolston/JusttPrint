'use strict';

const events = require('../events');
const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const { parseZipPath } = require('../../core/library-paths');
const { getServerAuth } = require('../auth');
const { isOrcaLinkSlicer, issueSlicerFileLinks } = require('../slicer-links');
const { libraryPathAllowed } = require('../path-context');

/*
 * Send to Slicer never runs anything on the server (a desktop slicer cannot open in a
 * headless container, and the server must not start programs a browser names). The server
 * builds an open-in-slicer command with a short-lived download token; the browser turns it
 * into a justtprint:// link, and the helper on the user's computer (helper/) downloads
 * the files and starts the slicer there.
 */

function getSlicerBySelection(slicers, { slicerId, slicerName } = {}) {
  if (!Array.isArray(slicers) || slicers.length === 0) return null;
  if (slicerId != null) {
    return slicers.find((slicer) => slicer.id === slicerId) || null;
  }
  if (slicerName) {
    return slicers.find((slicer) => slicer.name === slicerName) || null;
  }
  return slicers[0];
}

ipcMain.handle('get-slicers', () => {
  try {
    // Ensure the slicers table exists before querying it
    const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
    if (!tableExists) {
      ensureSlicersTableExists();
      return [];
    }
    return database.db.prepare('SELECT * FROM slicers').all();
  } catch (error) {
    console.error('Error getting slicers:', error);
    return [];
  }
});

ipcMain.handle('save-slicer', (event, { name, path }) => {
  try {
    // Ensure the slicers table exists before inserting
    const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
    if (!tableExists) {
      ensureSlicersTableExists();
    }
    database.db.prepare('INSERT OR REPLACE INTO slicers (name, path) VALUES (?, ?)').run(name, path);
    return true;
  } catch (error) {
    console.error('Error saving slicer:', error);
    throw error;
  }
});

ipcMain.handle('delete-slicer', (event, id) => {
  try {
    // Ensure the slicers table exists before deleting
    const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
    if (!tableExists) {
      ensureSlicersTableExists();
      return true; // Nothing to delete if table didn't exist
    }
    database.db.prepare('DELETE FROM slicers WHERE id = ?').run(id);
    return true;
  } catch (error) {
    console.error('Error deleting slicer:', error);
    throw error;
  }
});

const clearAndSaveSlicersHandler = async (event, slicers) => {
  try {
    // Ensure slicers is an array (WebSocket might wrap it in an array)
    let slicersArray = slicers;
    if (!Array.isArray(slicersArray)) {
      // If it's not an array, try to extract it
      if (Array.isArray(slicersArray) === false && slicersArray && typeof slicersArray === 'object') {
        // Might be wrapped: [slicers] -> slicers
        slicersArray = Array.isArray(slicersArray) ? slicersArray : [slicersArray];
      } else if (Array.isArray(slicersArray) && slicersArray.length === 1 && Array.isArray(slicersArray[0])) {
        // Unwrap if double-wrapped: [[slicers]] -> [slicers]
        slicersArray = slicersArray[0];
      } else {
        // Last resort: convert to array
        slicersArray = [slicersArray];
      }
    }

    // Validate that we have an array
    if (!Array.isArray(slicersArray)) {
      throw new Error('slicers parameter must be an array');
    }

    // Ensure the slicers table exists before clearing and saving
    const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
    if (!tableExists) {
      ensureSlicersTableExists();
    }

    const seenNames = new Set();
    const seenPaths = new Set();
    for (const slicer of slicersArray) {
      if (!slicer || typeof slicer !== 'object' || !slicer.name || !slicer.path) continue;
      const name = String(slicer.name).trim();
      const slicerPath = String(slicer.path).trim();
      const nameKey = name.toLowerCase();
      if (seenNames.has(nameKey)) {
        throw new Error(`"${name}" is already used. Each slicer needs its own name.`);
      }
      seenNames.add(nameKey);
      const pathKey = slicerPath
        .replace(/[\\/]+/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
      if (seenPaths.has(pathKey)) {
        throw new Error(`"${slicerPath}" is already used. Each slicer needs its own path.`);
      }
      seenPaths.add(pathKey);
    }

    // Use a transaction to ensure atomicity
    database.db.transaction(() => {
      // Drop all existing entries
      database.db.prepare('DELETE FROM slicers').run();

      // Insert new entries
      const insert = database.db.prepare('INSERT INTO slicers (name, path) VALUES (?, ?)');
      slicersArray.forEach((slicer) => {
        // Validate slicer object
        if (slicer && typeof slicer === 'object' && slicer.name && slicer.path) {
          insert.run(slicer.name, slicer.path);
        } else {
          console.warn('Invalid slicer object skipped:', slicer);
        }
      });
    })();

    return true;
  } catch (error) {
    console.error('Error clearing and saving slicers:', error);
    console.error('slicers parameter type:', typeof slicers, 'isArray:', Array.isArray(slicers), 'value:', slicers);
    const message = String(error && error.message ? error.message : error);
    if (/slicers\.name/i.test(message)) {
      throw new Error('That slicer name is already used. Each slicer needs its own name.');
    }
    if (/slicers\.path/i.test(message)) {
      throw new Error('That slicer path is already used. Each slicer needs its own path.');
    }
    throw error;
  }
};

ipcMain.handle('clear-and-save-slicers', clearAndSaveSlicersHandler);

/**
 * The open-in-slicer command the browser runs: for OrcaSlicer's own links (a slicer whose path is
 * orcaslicer://, slicer-links.js) one download address per file, else the helper's justtprint:// link.
 */
function slicerCommand(slicer, filePaths) {
  if (isOrcaLinkSlicer(slicer)) {
    for (const filePath of filePaths) {
      const archive = parseZipPath(filePath).isZipEntry ? parseZipPath(filePath).zipPath : filePath;
      if (!libraryPathAllowed(archive)) throw new Error(`Path is outside the library folders: ${filePath}`);
    }
    return { type: 'open-in-orcaslicer', slicerName: slicer.name, files: issueSlicerFileLinks(filePaths) };
  }
  const pathInfo = parseZipPath(filePaths[0]);
  return {
    type: 'open-in-slicer',
    filePaths: filePaths.slice(),
    filePath: filePaths[0],
    slicerName: slicer.name,
    slicerPath: slicer.path,
    downloadToken: getServerAuth().issueDownloadToken(),
    isZipEntry: pathInfo.isZipEntry,
    zipPath: pathInfo.isZipEntry ? pathInfo.zipPath : null,
    entryPath: pathInfo.isZipEntry ? pathInfo.entryPath : null
  };
}

/**
 * A browser gets the command back and launches the helper itself. MCP has no browser of its
 * own, so its command goes to the open browsers, which hand it to their helper.
 */
const openFileInSlicerHandler = async (event, options = {}) => {
  const { filePaths, slicerId, slicerName } = options || {};
  const paths = (Array.isArray(filePaths) ? filePaths : filePaths ? [filePaths] : []).filter(Boolean);
  if (!paths.length) {
    throw new Error('No file paths provided');
  }

  ensureSlicersTableExists();
  const slicers = database.db.prepare('SELECT * FROM slicers').all();
  const slicer = getSlicerBySelection(slicers, { slicerId, slicerName });
  if (!slicer) {
    throw new Error('No slicer configured. Add a slicer in Settings.');
  }

  const command = slicerCommand(slicer, paths);
  // A browser asked: it opens the command itself. MCP: send it to the open browsers.
  if (event && event.fromNetwork) {
    return { success: true, count: paths.length, command };
  }
  events.broadcast('execute-client-command', command);
  return { success: true, count: paths.length, sentToBrowsers: true };
};

ipcMain.handle('open-file-in-slicer', openFileInSlicerHandler);

// Add this function to check and create the slicers table if it doesn't exist
function ensureSlicersTableExists() {
  try {
    console.debug('Checking if slicers table exists...');

    // Check if the slicers table exists
    const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();

    if (!tableExists) {
      console.log('Slicers table does not exist. Creating it...');

      // Create the slicers table
      database.db
        .prepare(
          `CREATE TABLE IF NOT EXISTS slicers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          path TEXT NOT NULL
      )`
        )
        .run();

      console.log('Slicers table created successfully');
    } else {
      console.debug('Slicers table already exists');
    }

    return true;
  } catch (error) {
    console.error('Error ensuring slicers table exists:', error);
    return false;
  }
}

module.exports = { ensureSlicersTableExists, openFileInSlicerHandler, slicerCommand };
