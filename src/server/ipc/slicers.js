'use strict';

const events = require('../events');
const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const fs = require('fs');
const { buildSlicerSpawnSpec, launchSlicerProcess, invalidSlicerPathError } = require('../slicer-launch');
const { isUrlModel, parseZipPath } = require('../../core/library-paths');
const { scheduleExtractTempCleanupMany } = require('../../core/extract-temp');
const { clientDialogs } = require('../dialogs');
const { getServerAuth } = require('../auth');
const { extractModelFromZip, isMacOsResourceForkEntry } = require('../../core/zip-entries');

// Check if running in Docker container
function isDockerContainer() {
  // Check for Docker environment indicators
  const hasDockerenv = fs.existsSync('/.dockerenv');
  const hasCgroup = fs.existsSync('/proc/self/cgroup');
  const cgroupContainsDocker = hasCgroup && fs.readFileSync('/proc/self/cgroup', 'utf8').includes('docker');
  const result = hasDockerenv || cgroupContainsDocker;
  return result;
}

async function resolveModelPathsForSlicer(filePaths) {
  const rawPaths = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  const resolved = [];

  for (const fp of rawPaths) {
    if (typeof fp !== 'string' || isUrlModel(fp)) continue;

    const pathInfo = parseZipPath(fp);
    if (pathInfo.isZipEntry) {
      if (isMacOsResourceForkEntry(pathInfo.entryPath)) continue;
      resolved.push(await extractModelFromZip(pathInfo.zipPath, pathInfo.entryPath));
    } else if (fs.existsSync(fp)) {
      resolved.push(fp);
    }
  }

  return resolved;
}

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

function runSlicerWithModelPaths(slicer, modelPaths) {
  if (!modelPaths.length) {
    return Promise.reject(new Error('No model files to open in slicer'));
  }

  const invalid = invalidSlicerPathError(slicer.path, slicer.name);
  if (invalid) return Promise.reject(invalid);

  const inDocker = isDockerContainer();
  if (inDocker && (/^[A-Za-z]:[\\/]/.test(slicer.path) || /^\\\\/.test(slicer.path))) {
    return Promise.reject(new Error(
      `The slicer path "${slicer.path}" is a Windows path, but the application is running in a Docker container (Linux). ` +
      'Use a Linux slicer path or run Printventory in normal mode.'
    ));
  }

  const spec = buildSlicerSpawnSpec(slicer.path, modelPaths);
  console.log('[Slicer] Launching', spec.command, spec.args.join(' '));
  // Resolve when the process starts. Slicers that are already open often hand the
  // file to the existing window and exit non-zero; that is still a successful launch.
  return launchSlicerProcess(spec, { name: slicer.name, slicerPath: slicer.path }).then(
    () => {
      scheduleExtractTempCleanupMany(modelPaths);
      return { success: true, count: modelPaths.length };
    },
    (error) => {
      scheduleExtractTempCleanupMany(modelPaths, 0);
      throw error;
    }
  );
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
      const pathKey = slicerPath.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
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
      slicersArray.forEach(slicer => {
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

const openFileInSlicerHandler = async (event, options = {}) => {
  const { filePaths, slicerId, slicerName } = options || {};
  const paths = Array.isArray(filePaths) ? filePaths : (filePaths ? [filePaths] : []);
  if (!paths.length) {
    throw new Error('No file paths provided');
  }

  ensureSlicersTableExists();
  const slicers = database.db.prepare('SELECT * FROM slicers').all();
  const slicer = getSlicerBySelection(slicers, { slicerId, slicerName });
  if (!slicer) {
    throw new Error('No slicer configured. Add a slicer in Settings.');
  }

  const invalidSlicer = invalidSlicerPathError(slicer.path, slicer.name);
  {
    const firstPath = paths[0];
    const pathInfo = parseZipPath(firstPath);
    const commandPayload = {
      type: 'open-in-slicer',
      filePaths: paths,
      filePath: firstPath,
      slicerName: slicer.name,
      slicerPath: slicer.path,
      downloadToken: getServerAuth().issueDownloadToken(),
      isZipEntry: pathInfo.isZipEntry,
      zipPath: pathInfo.isZipEntry ? pathInfo.zipPath : null,
      entryPath: pathInfo.isZipEntry ? pathInfo.entryPath : null
    };

    events.broadcast('execute-client-command', commandPayload);
    return { success: true, serverMode: true, count: paths.length };
  }

  const modelPaths = await resolveModelPathsForSlicer(paths);
  if (!modelPaths.length) {
    throw new Error('No valid local model files to open in slicer');
  }

  try {
    return await runSlicerWithModelPaths(slicer, modelPaths);
  } catch (error) {
    // Launch failed — remove any extracts we just created
    scheduleExtractTempCleanupMany(modelPaths, 0);
    console.error('Error opening file in slicer:', error);
    clientDialogs.messageBox(event, { type: 'error', title: 'Send to Slicer', message: error.message });
    throw error;
  }
};

ipcMain.handle('open-file-in-slicer', openFileInSlicerHandler);

// Add this function to check and create the slicers table if it doesn't exist
function ensureSlicersTableExists() {
  try {
    console.log('Checking if slicers table exists...');
    
    // Check if the slicers table exists
    const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
    
    if (!tableExists) {
      console.log('Slicers table does not exist. Creating it...');
      
      // Create the slicers table
      database.db.prepare(`CREATE TABLE IF NOT EXISTS slicers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          path TEXT NOT NULL
      )`).run();
      
      console.log('Slicers table created successfully');
    } else {
      console.log('Slicers table already exists');
    }
    
    return true;
  } catch (error) {
    console.error('Error ensuring slicers table exists:', error);
    return false;
  }
}

// Add this new IPC handler



// IPC handler for executing commands on client machine (for server mode Electron clients)
// Note: In server mode, browser clients receive this as an event and handle it in renderer.js
const executeClientCommandHandler = async (event, commandData) => {
  try {
    if (!commandData || !commandData.type) {
      throw new Error('Invalid command data');
    }

    const { type, filePath, slicerName, slicerPath, isZipEntry, zipPath, entryPath } = commandData;

    if (type === 'open-file') {
      // The file is on the server; the browser downloads it instead.
      return { success: false, error: 'Download the file to open it on this computer.' };
    } else if (type === 'open-in-slicer') {
      const invalidSlicer = invalidSlicerPathError(slicerPath, slicerName);
      if (invalidSlicer) {
        return { success: false, error: invalidSlicer.message };
      }

      const rawPaths = Array.isArray(commandData.filePaths) && commandData.filePaths.length
        ? commandData.filePaths
        : (filePath ? [filePath] : []);

      let modelPaths = [];
      try {
        modelPaths = await resolveModelPathsForSlicer(rawPaths);
      } catch (error) {
        return { success: false, error: error.message };
      }

      if (!modelPaths.length) {
        const detail = isZipEntry && zipPath && entryPath
          ? `To open ${entryPath} from ${zipPath}:\n\n1. Extract ${entryPath} from the ZIP file\n2. Open the extracted file in ${slicerName}`
          : `Could not resolve local model paths for the slicer.`;
        clientDialogs.messageBox(event, {
          type: 'info',
          title: 'Send to Slicer',
          message: 'Cannot open these models in slicer from here',
          detail
        });
        return { success: false, message: 'No resolvable model paths' };
      }

      try {
        await runSlicerWithModelPaths({ name: slicerName, path: slicerPath }, modelPaths);
        return { success: true, count: modelPaths.length };
      } catch (error) {
        console.error('Error executing slicer command on client:', error);
        return { success: false, error: error.message };
      }
    }
    
    return { success: false, error: 'Unknown command type' };
  } catch (error) {
    console.error('Error executing client command:', error);
    throw error;
  }
};

ipcMain.handle('execute-client-command', executeClientCommandHandler);

module.exports = { ensureSlicersTableExists, isDockerContainer, openFileInSlicerHandler, resolveModelPathsForSlicer, runSlicerWithModelPaths };
