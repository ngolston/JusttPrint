'use strict';
const events = require('../events');
const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const fs = require('fs');
const path = require('path');
const { isUrlModel, parseZipPath } = require('../../core/library-paths');
const { parseThumbnails, readThumbnailColumn } = require('../../core/thumbnails');
const { deleteModelJunctionRows, deleteModelsByFilePaths } = require('../../core/models');
const { clientDialogs } = require('../dialogs');
const { clampFolderLevels } = require('../../core/library-context');
const { applyFolderTagsToModels: applyFolderTagsInDb } = require('../../core/folder-tags');
const { getAISettings } = require('./ai');
require('../auth');
require('../../core/zip-entries');
const { ensureSlicersTableExists, slicerCommand } = require('./slicers');
const { generateTagsFromMenu } = require('./context-menu-generate-tags');
const { pullMetadataFromMenu } = require('./context-menu-pull-metadata');

// Store pending context menu actions for server mode (browser access)
const pendingContextMenus = new Map();

let contextMenuRequestIdCounter = 0;

function getPreviewableExtension(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  const pathForExt = filePath.includes('::') ? filePath.split('::')[1] || '' : filePath;
  return path.extname(pathForExt).toLowerCase();
}

function isPreviewableModelFile(filePath) {
  const ext = getPreviewableExtension(filePath);
  return (
    ext === '.stl' ||
    ext === '.3mf' ||
    ext === '.obj' ||
    ext === '.ply' ||
    ext === '.step' ||
    ext === '.stp' ||
    ext === '.lys' ||
    ext === '.igs' ||
    ext === '.iges' ||
    ext === '.f3d' ||
    ext === '.chitubox' ||
    ext === '.voxl'
  );
}

function sendPreviewBundleEvent(event, payload) {
  events.toCaller(event, 'preview-bundle-models', payload);
}

function sendPreviewModelEvent(event, filePath) {
  events.toCaller(event, 'preview-model', filePath);
}

/** Model menu items a viewer may use: they open, download or copy, and change nothing. */
const VIEWER_MENU_LABELS = new Set(['Preview', 'Download', 'Copy Path', 'Copy Paths', 'Open in Slicer']);

/** The viewer's menu: allowed items only, without leading, trailing or doubled separators. */
function viewerMenuItems(items) {
  const kept = [];
  for (const item of items) {
    if (item.type === 'separator') {
      if (kept.length && kept[kept.length - 1].type !== 'separator') kept.push(item);
    } else if (VIEWER_MENU_LABELS.has(item.label)) {
      kept.push(item);
    }
  }
  while (kept.length && kept[kept.length - 1].type === 'separator') kept.pop();
  return kept;
}

// Update the show-context-menu handler
ipcMain.handle('show-context-menu', async (event, fileIdentifier) => {
  let filePaths;
  let groupLabel = null;
  let previewAsBundle = false;
  if (fileIdentifier && typeof fileIdentifier === 'object' && !Array.isArray(fileIdentifier) && Array.isArray(fileIdentifier.filePaths)) {
    filePaths = fileIdentifier.filePaths.filter(Boolean);
    groupLabel = fileIdentifier.groupLabel || null;
    previewAsBundle = Boolean(fileIdentifier.previewAsBundle);
  } else {
    filePaths = Array.isArray(fileIdentifier) ? fileIdentifier : [fileIdentifier];
  }

  // In single edit mode, if exactly one file is right-clicked, instruct the renderer to select it.
  if (filePaths.length === 1) {
    events.toCaller(event, 'select-model-by-filepath', filePaths[0]);
  }

  // Check if any file is a zip entry
  const isZipEntry = filePaths.length === 1 && filePaths[0].includes('::');
  const pathInfo = filePaths.length === 1 ? parseZipPath(filePaths[0]) : null;

  let menuItems = [];

  // Add "Preview" option at the top (single model or full bundle/group)
  const previewablePaths = filePaths.filter((fp) => isPreviewableModelFile(fp));
  if (previewablePaths.length === 1 && !previewAsBundle) {
    const fp = previewablePaths[0];
    menuItems.push({
      label: 'Preview',
      click: async () => {
        try {
          console.debug('Preview clicked for file:', fp);
          sendPreviewModelEvent(event, fp);
        } catch (error) {
          console.error('Error triggering preview:', error);
          if (event && event.sender) {
            clientDialogs.messageBox(event, {
              type: 'error',
              title: 'Error',
              message: 'Could not preview file',
              detail: error.message
            });
          }
        }
      }
    });
    menuItems.push({ type: 'separator' });
  } else if (previewablePaths.length > 1 || (previewAsBundle && previewablePaths.length >= 1)) {
    const bundlePayload = {
      groupLabel: groupLabel || (previewablePaths.length > 1 ? 'Bundle' : 'Preview'),
      children: previewablePaths.map((fp) => ({
        filePath: fp,
        fileName: fp.includes('::') ? path.basename(fp.split('::')[1] || fp) : path.basename(fp)
      }))
    };
    menuItems.push({
      label: 'Preview',
      click: async () => {
        try {
          console.debug('Preview clicked for bundle/group:', bundlePayload.groupLabel, bundlePayload.children.length);
          sendPreviewBundleEvent(event, bundlePayload);
        } catch (error) {
          console.error('Error triggering bundle preview:', error);
          if (event && event.sender) {
            clientDialogs.messageBox(event, {
              type: 'error',
              title: 'Error',
              message: 'Could not preview bundle',
              detail: error.message
            });
          }
        }
      }
    });
    menuItems.push({ type: 'separator' });
  }

  // Download and Copy Path run in the browser that opened the menu (clientAction); the click
  // handlers are for callers that cannot.
  if (filePaths.length === 1) {
    menuItems.push({
      label: 'Download',
      clientAction: { type: 'download', filePath: filePaths[0] },
      click: async () => {
        events.toCaller(event, 'download-model', filePaths[0]);
      }
    });
  }
  if (filePaths.length >= 1) {
    menuItems.push({
      label: filePaths.length === 1 ? 'Copy Path' : 'Copy Paths',
      clientAction: { type: 'copy-paths', filePaths: filePaths.slice() },
      click: () => {}
    });
    menuItems.push({ type: 'separator' });
  }

  // Get all configured slicers from the database
  let slicers = [];
  try {
    // Ensure the slicers table exists before querying it
    const tableExists = database.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='slicers'`).get();
    if (tableExists) {
      slicers = database.db.prepare('SELECT * FROM slicers').all();
    } else {
      // Create the table if it doesn't exist
      ensureSlicersTableExists();
    }
  } catch (error) {
    console.error('Error getting slicers:', error);
  }

  // Send to Slicer hands the files to the helper on the user's computer (justtprint://).
  if (slicers.length > 0 && filePaths.length >= 1) {
    const slicerSubmenu = {
      label: 'Open in Slicer',
      submenu: slicers.map((slicer) => ({
        label: slicer.name,
        slicerName: slicer.name,
        slicerPath: slicer.path,
        // The browser launches straight from the menu item's clientAction; this only runs
        // when a client asks the server to run the item, and answers that browser alone.
        click: async () => {
          let command;
          try {
            command = slicerCommand(slicer, filePaths);
          } catch (error) {
            command = { type: 'slicer-error', message: error.message };
          }
          events.sendTo(event.wsClient, 'execute-client-command', command);
        }
      }))
    };
    menuItems.push(slicerSubmenu);
  }

  // Collections and share links: the browser that opened the menu shows the dialog.
  if (filePaths.length >= 1) {
    menuItems.push({
      label: 'Add to Collection…',
      click: async () => {
        events.toCaller(event, 'open-add-to-collection', filePaths.slice());
      }
    });
  }
  if (filePaths.length === 1 && !String(filePaths[0]).startsWith('url::')) {
    menuItems.push({
      label: 'Share…',
      click: async () => {
        events.toCaller(event, 'open-share-dialog', { kind: 'model', filePath: filePaths[0] });
      }
    });
  }

  menuItems.push({
    label: 'Tag from Folder',
    click: async () => {
      const configuredLevels = clampFolderLevels(getAISettings().aiTagFolderLevels);
      const levels = configuredLevels > 0 ? configuredLevels : 1;
      try {
        const result = applyFolderTagsToModels(filePaths, levels);
        events.broadcast('refresh-grid');
        const summary =
          result.tagsAdded > 0
            ? `Added ${result.tagsAdded} tag${result.tagsAdded === 1 ? '' : 's'} on ${result.updated} model${result.updated === 1 ? '' : 's'}.`
            : 'No new folder tags were added. Those tags may already be on the models, or the files have no usable parent folder.';
        console.log('[Tag from Folder]', summary);
      } catch (error) {
        console.error('Error tagging from folder:', error);
      }
    }
  });

  // Check if API key exists in settings
  const apiKeyRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey');
  const apiKey = apiKeyRow ? apiKeyRow.value : null;

  // Check AI service type
  const aiServiceRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('aiService');
  const aiService = aiServiceRow ? aiServiceRow.value : 'openai';
  const apiEndpointRow = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('apiEndpoint');
  const apiEndpoint = apiEndpointRow ? apiEndpointRow.value : null;
  const aitaggingForMenu = require('../../core/aitagging');

  // Add "Generate Tags" when a key is set, or when the selected service/endpoint does not need one
  // (Puter, Custom, and local OpenAI-compatible servers such as Ollama / LM Studio)
  if (apiKey || !aitaggingForMenu.requiresApiKey(aiService, apiEndpoint)) {
    // Capture event.sender for use in the click handler (needed for desktop mode)
    const sender = event.sender;
    menuItems.push({
      label: 'Generate Tags',
      // Remove the restriction to only one file
      click: (clickEvent) => generateTagsFromMenu(event, clickEvent, sender, filePaths)
    });
  }

  // Check if any selected files are 3MF files
  const has3MFFiles = filePaths.some((fp) => {
    const ext = path.extname(fp).toLowerCase();
    // Handle zip entries - check the entry path extension
    if (fp.includes('::')) {
      const entryPath = fp.split('::')[1];
      return path.extname(entryPath).toLowerCase() === '.3mf';
    }
    return ext === '.3mf';
  });

  // Add "Pull Metadata" option for 3MF files
  if (has3MFFiles) {
    menuItems.push({
      label: 'Pull Metadata',
      click: () => pullMetadataFromMenu(event, filePaths)
    });
  }

  // Add "Add Image" option for single or multi selection (same image added to all selected)
  if (filePaths.length >= 1) {
    menuItems.push({
      label: 'Add Image',
      click: async () => {
        try {
          events.toCaller(event, 'add-image-request', filePaths);
        } catch (error) {
          console.error('Error adding image:', error);
          clientDialogs.messageBox(event, {
            type: 'error',
            title: 'Error',
            message: 'Could not add image',
            detail: error.message
          });
        }
      }
    });
  }

  // Keep "Manage Thumbnails" visible in all modes for menu consistency.
  // It is only actionable for a single selected model.
  menuItems.push({
    label: 'Manage Thumbnails',
    enabled: filePaths.length === 1,
    click: async () => {
      if (filePaths.length !== 1) return;
      try {
        // Check if model has at least one thumbnail
        const storedThumbnail = readThumbnailColumn(filePaths[0]);
        const thumbnails = storedThumbnail
          ? parseThumbnails(storedThumbnail).filter((t) => t && t !== '3d.png' && t.length > 0 && t.startsWith('data:image'))
          : [];

        if (thumbnails.length === 0) {
          await clientDialogs.messageBox(event, {
            type: 'info',
            title: 'No Thumbnails',
            message: 'This model has no thumbnails to manage.',
            detail: 'Please add an image first using "Add Image".'
          });
          return;
        }

        events.toCaller(event, 'manage-thumbnails-request', filePaths[0]);
      } catch (error) {
        console.error('Error opening manage thumbnails:', error);
        clientDialogs.messageBox(event, {
          type: 'error',
          title: 'Error',
          message: 'Could not open thumbnail manager',
          detail: error.message
        });
      }
    }
  });

  // Add separator before file operations
  menuItems.push({ type: 'separator' });

  // Add Move and new file operations
  // Note: "Move" is excluded in server mode
  const fileOperationItems = [];

  menuItems.push(
    ...fileOperationItems,
    {
      label: 'Remove from Library',
      click: async () => {
        // In server mode (Docker/browser), no native dialog - proceed and broadcast refresh
        let confirmed = true;
        if (confirmed) {
          try {
            deleteModelsByFilePaths(filePaths);
            events.broadcast('refresh-grid');
          } catch (error) {
            console.error('Error removing from library:', error);
          }
        }
      }
    },
    {
      label: 'Delete from Disk', // Renamed from just "Delete"
      click: async () => {
        // In server mode (Docker/browser), no native dialog - proceed and broadcast refresh
        let confirmed = true;
        if (confirmed) {
          for (const fp of filePaths) {
            try {
              const success = await deleteFile(fp);
            } catch (error) {
              console.error('Error deleting file:', error);
            }
          }
          events.broadcast('refresh-grid');
        }
      }
    }
  );

  // Viewers only look: drop the items that change the library or files.
  if (event && event.user && event.user.role === 'viewer') menuItems = viewerMenuItems(menuItems);

  // The browser renders the menu; clicks come back through execute-context-menu-action.
  {
    // Generate unique request ID for this context menu
    const requestId = `ctx_${++contextMenuRequestIdCounter}_${Date.now()}`;

    // Store the menu items with their click handlers
    pendingContextMenus.set(requestId, {
      menuItems: menuItems,
      filePaths: filePaths,
      event: event,
      timestamp: Date.now()
    });

    // Clean up old menus (older than 5 minutes)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    for (const [id, menu] of pendingContextMenus.entries()) {
      if (menu.timestamp < fiveMinutesAgo) {
        pendingContextMenus.delete(id);
      }
    }

    // Serialize menu items for browser rendering
    const serializedItems = menuItems.map((item, index) => {
      if (item.type === 'separator') {
        return { type: 'separator' };
      }
      const serialized = {
        label: item.label,
        enabled: item.enabled !== false, // Default to true if not specified
        index: index
      };
      if (item.clientAction) serialized.clientAction = item.clientAction;
      // Handle submenus
      if (item.submenu) {
        serialized.submenu = item.submenu.map((subItem, subIndex) => {
          const entry = {
            label: subItem.label,
            enabled: subItem.enabled !== false,
            index: index,
            subIndex: subIndex
          };
          if (subItem.slicerPath) {
            try {
              entry.clientAction = slicerCommand({ name: subItem.slicerName || subItem.label, path: subItem.slicerPath }, filePaths);
            } catch (error) {
              // Too many files for OrcaSlicer's links, or a path outside the library: say so when clicked.
              entry.clientAction = { type: 'slicer-error', message: error.message };
            }
          }
          return entry;
        });
      }
      return serialized;
    });

    // Return menu items instead of showing native menu
    return {
      type: 'html-menu',
      requestId: requestId,
      items: serializedItems,
      filePaths: filePaths
    };
  }
});

// IPC handler to execute context menu actions (for server mode browser access)
const executeContextMenuActionHandler = async (event, requestId, itemIndex, subIndex) => {
  console.debug('[Context Menu] executeContextMenuActionHandler called, requestId:', requestId, 'itemIndex:', itemIndex, 'subIndex:', subIndex);
  const menuData = pendingContextMenus.get(requestId);
  if (!menuData) {
    throw new Error('Context menu request not found or expired');
  }

  const { menuItems, event: originalEvent } = menuData;
  // Only the user who opened a menu may run its items (request ids are guessable).
  const opener = originalEvent && originalEvent.user;
  const caller = event && event.user;
  if (opener && caller && opener.id !== caller.id) {
    throw new Error('Context menu request not found or expired');
  }
  const menuItem = menuItems[itemIndex];

  if (!menuItem) {
    throw new Error('Menu item not found');
  }

  console.debug('[Context Menu] Menu item label:', menuItem.label, 'has click:', !!menuItem.click, 'has submenu:', !!menuItem.submenu);

  // Handle submenu items
  if (subIndex !== undefined && subIndex !== null && menuItem.submenu) {
    const subMenuItem = menuItem.submenu[subIndex];
    if (!subMenuItem || !subMenuItem.click) {
      throw new Error('Submenu item not found or has no action');
    }

    // Use the event passed in (has proper WebSocket routing in server mode)
    // Fallback to originalEvent if event doesn't have sender (backward compatibility)
    // IMPORTANT: Preserve wsClient from the event parameter for Puter AI routing
    const mockEvent =
      event && event.sender
        ? {
            ...event,
            // Ensure wsClient is preserved
            wsClient: event.wsClient || null
          }
        : {
            sender: originalEvent.sender,
            wsClient: event?.wsClient || originalEvent?.wsClient || null
          };

    console.debug('[Context Menu] Created mockEvent for submenu click handler:', {
      hasSender: !!mockEvent.sender,
      hasWsClient: !!mockEvent.wsClient,
      true: true
    });

    // Execute the submenu item's click handler
    // Wrap in try-catch to handle errors gracefully
    console.debug('[Context Menu] Executing submenu item click handler:', subMenuItem.label);
    try {
      const result = subMenuItem.click(mockEvent);
      // If it returns a promise, don't await it to avoid IPC timeout
      // The handler should send events immediately (like dialog opening)
      if (result && typeof result.then === 'function') {
        // Async handler - let it run in background, return immediately
        result.catch((err) => {
          console.error('Error in async context menu click handler:', err);
        });
        pendingContextMenus.delete(requestId);
        return { success: true };
      } else {
        // Sync handler - already completed
        pendingContextMenus.delete(requestId);
        return { success: true };
      }
    } catch (err) {
      console.error('Error in context menu click handler:', err);
      pendingContextMenus.delete(requestId);
      throw err;
    }
  } else if (menuItem.click) {
    // Use the event passed in (has proper WebSocket routing in server mode)
    // Fallback to originalEvent if event doesn't have sender (backward compatibility)
    // IMPORTANT: Preserve wsClient from the event parameter for Puter AI routing
    const mockEvent =
      event && event.sender
        ? {
            ...event,
            // Ensure wsClient is preserved
            wsClient: event.wsClient || null
          }
        : {
            sender: originalEvent.sender,
            wsClient: event?.wsClient || originalEvent?.wsClient || null
          };

    console.debug('[Context Menu] Created mockEvent for click handler:', {
      hasSender: !!mockEvent.sender,
      hasWsClient: !!mockEvent.wsClient,
      true: true
    });

    // Execute the menu item's click handler
    // Wrap in try-catch to handle errors gracefully
    console.debug('[Context Menu] Executing menu item click handler:', menuItem.label);
    try {
      const result = menuItem.click(mockEvent);
      // If it returns a promise, don't await it to avoid IPC timeout
      // The handler should send events immediately (like dialog opening)
      if (result && typeof result.then === 'function') {
        // Async handler - let it run in background, return immediately
        result.catch((err) => {
          console.error('Error in async context menu click handler:', err);
        });
        pendingContextMenus.delete(requestId);
        return { success: true };
      } else {
        // Sync handler - already completed
        pendingContextMenus.delete(requestId);
        return { success: true };
      }
    } catch (err) {
      console.error('Error in context menu click handler:', err);
      pendingContextMenus.delete(requestId);
      throw err;
    }
  }

  // Clean up after execution
  pendingContextMenus.delete(requestId);

  return { success: true };
};

ipcMain.handle('execute-context-menu-action', executeContextMenuActionHandler);

// Update the deleteFile function
async function deleteFile(filePath) {
  try {
    if (!isUrlModel(filePath)) {
      // Delete the actual file
      await fs.promises.unlink(filePath);
    }

    // Use a transaction to handle database operations
    database.db.transaction(() => {
      // Get the model ID first
      const model = database.db.prepare('SELECT id FROM models WHERE filePath = ?').get(filePath);
      if (model) {
        deleteModelJunctionRows(model.id);
        database.db.prepare('DELETE FROM models WHERE id = ?').run(model.id);
      }
    })();

    return true;
  } catch (err) {
    console.error('Error deleting file:', err);
    console.error('Error details:', {
      message: err.message,
      code: err.code,
      path: filePath
    });
    return false;
  }
}

// Add this helper function (if it doesn't already exist) near the top of main.js
function applyFolderTagsToModels(filePaths, levels) {
  return applyFolderTagsInDb(database.db, filePaths, levels);
}

module.exports = { applyFolderTagsToModels, deleteFile, viewerMenuItems };
