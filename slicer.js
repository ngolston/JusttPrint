// slicer.js
// This module handles the Slicer Settings panel in the renderer process

let slicerEntries = [];

function normalizeSlicerPathKey(slicerPath) {
  return String(slicerPath || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

function suggestSlicerNameFromPath(slicerPath) {
  const base = String(slicerPath || '').split(/[/\\]/).pop() || '';
  const withoutExt = base.replace(/\.(exe|app|appimage|dmg)$/i, '');
  const spaced = withoutExt.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!spaced) return '';
  return spaced.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function applySlicerPathToEntry(entryEl, filePath) {
  if (!entryEl || !filePath) return;
  const pathInput = entryEl.querySelector('.slicer-path');
  const nameInput = entryEl.querySelector('.slicer-name');
  if (pathInput) pathInput.value = filePath;
  if (nameInput && !nameInput.value.trim()) {
    nameInput.value = suggestSlicerNameFromPath(filePath);
  }
}

async function createSlicerEntry(slicer = { name: '', path: '' }) {
  const template = document.getElementById('slicer-entry-template');
  if (!template) {
    console.error('Slicer entry template not found');
    return null;
  }

  const entry = template.content.cloneNode(true);
  const container = entry.querySelector('.slicer-entry');
  const nameInput = entry.querySelector('.slicer-name');
  const pathInput = entry.querySelector('.slicer-path');
  
  // Generate unique IDs for the inputs to avoid conflicts
  const uniqueId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
  nameInput.id = `slicer-name-${uniqueId}`;
  pathInput.id = `slicer-path-${uniqueId}`;
  
  // Set initial values and store them in data attributes
  nameInput.value = slicer.name || '';
  pathInput.value = slicer.path || '';
  nameInput.dataset.originalValue = slicer.name || '';
  pathInput.dataset.originalValue = slicer.path || '';
  
  // Always make both fields editable (never readonly) - users should be able to type name before path
  nameInput.removeAttribute('readonly');
  nameInput.disabled = false;
  pathInput.removeAttribute('readonly');
  pathInput.disabled = false;
  
  // Check if we're in server mode
  const serverMode = await window.electron.isServerMode().catch(() => false);
  
  // Update placeholder for path field in server mode
  if (serverMode) {
    pathInput.placeholder = 'Enter slicer path on your workstation';
  }

  // If user pastes/types a path first, fill an empty name from the executable
  pathInput.addEventListener('change', () => {
    if (!nameInput.value.trim() && pathInput.value.trim()) {
      nameInput.value = suggestSlicerNameFromPath(pathInput.value.trim());
    }
  });
  
  // Add browse button handler
  const browseButton = entry.querySelector('.browse-slicer-button');
  browseButton.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    // The browser only reveals the file name, not its full path on this computer.
    // IMPORTANT: Must be triggered directly from user click, not in setTimeout, to satisfy browser security
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    
    // Set accept filter based on platform
    // On Windows, filter for .exe files
    // On macOS, we can't easily filter for .app (they're directories), so accept all
    // On Linux, accept all files (executables typically have no extension)
    if (navigator.platform.toLowerCase().includes('win')) {
      fileInput.accept = '.exe,application/x-msdownload';
    } else {
      // For macOS and Linux, accept all files
      fileInput.accept = '*/*';
    }
    
    let fileSelected = false;
    
    fileInput.addEventListener('change', (event) => {
      fileSelected = true;
      const file = event.target.files[0];
      if (file) {
        // Browsers only give the file name; the user completes the path on this computer.
        const thisEntry = pathInput.closest('.slicer-entry');
        applySlicerPathToEntry(thisEntry, file.name);
        const message = 'Browser security only provides the filename. ' +
          'If the path shown is incomplete, please manually enter the full path to the slicer executable.\n\n' +
          'Example: C:\\Program Files\\PrusaSlicer\\prusa-slicer.exe';
        setTimeout(() => {
          alert(message);
        }, 100);
      }
      // Clean up
      setTimeout(() => {
        if (fileInput.parentNode) {
          fileInput.parentNode.removeChild(fileInput);
        }
      }, 100);
    });
    
    // Add to DOM immediately
    document.body.appendChild(fileInput);
    
    // Trigger click immediately (must be synchronous with user event handler)
    // Try direct click first, then fallback to requestAnimationFrame if needed
    try {
      // Direct click - this must happen synchronously in the user event handler
      fileInput.click();
    } catch (error) {
      console.error('Error triggering file input directly:', error);
      // Fallback: try with requestAnimationFrame (may not work due to browser security)
      requestAnimationFrame(() => {
        try {
          fileInput.click();
        } catch (error2) {
          console.error('Error triggering file input:', error2);
          // If click fails, show message to user
          alert('Unable to open file dialog. Please manually enter the slicer path in the input field.\n\n' +
            'Example: C:\\Program Files\\PrusaSlicer\\prusa-slicer.exe');
        }
      });
    }
    
    // Clean up if no file is selected after a reasonable time (user cancelled)
    setTimeout(() => {
      if (!fileSelected && fileInput.parentNode) {
        fileInput.parentNode.removeChild(fileInput);
      }
    }, 500);
  });
  
  // Both fields are already made editable above, but ensure they remain editable
  // (This is a safety check in case something else tries to disable them)
  nameInput.removeAttribute('readonly');
  nameInput.disabled = false;
  pathInput.removeAttribute('readonly');
  pathInput.disabled = false;
  
  // Add remove button handler
  const removeButton = entry.querySelector('.remove-slicer-button');
  removeButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const thisEntry = e.target.closest('.slicer-entry');
    if (thisEntry) {
      thisEntry.remove();
    }
  });
  
  return container;
}

function updateSlicerHelperNote(serverMode) {
  const panel = document.getElementById('slicer-helper-install');
  const insecureRow = document.getElementById('slicer-helper-insecure-row');
  if (panel) panel.hidden = !serverMode;
  if (insecureRow) insecureRow.hidden = window.location.protocol !== 'https:';
}

function downloadSlicerHelper(event) {
  event.preventDefault();
  event.stopPropagation();
  const insecure = document.getElementById('slicer-helper-insecure')?.checked;
  const link = document.createElement('a');
  link.href = '/api/helper/bundle' + (insecure ? '?insecure=1' : '');
  link.download = 'JusttPrint-Helper.zip';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function openSlicerSettings() {
  const serverMode = await window.electron?.isServerMode?.().catch(() => false);
  updateSlicerHelperNote(serverMode);

  const dialog = document.getElementById('slicer-dialog');
  if (!dialog) return;
  
  const slicerList = dialog.querySelector('#slicer-list');
  if (!slicerList) return;
  
  // Prevent form submission
  const form = dialog.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
  });
  
  slicerList.innerHTML = '';
  
  // Load existing slicers
  window.electron.getSlicers()
    .then(async (slicers) => {
      if (slicers && slicers.length > 0) {
        for (const slicer of slicers) {
          const entry = await createSlicerEntry(slicer);
          if (entry) {
            slicerList.appendChild(entry);
          }
        }
      }
    })
    .catch(err => {
      console.error('Error loading slicers:', err);
    });
  
  dialog.showModal();
}

function duplicateSlicerMessage(slicers) {
  const names = new Set();
  const paths = new Set();
  for (const slicer of slicers) {
    const nameKey = slicer.name.toLowerCase();
    if (names.has(nameKey)) {
      return `"${slicer.name}" is already used. Each slicer needs its own name.`;
    }
    names.add(nameKey);
    const pathKey = normalizeSlicerPathKey(slicer.path);
    if (paths.has(pathKey)) {
      return `"${slicer.path}" is already used. Each slicer needs its own path.`;
    }
    paths.add(pathKey);
  }
  return '';
}

function friendlySlicerSaveError(err) {
  const message = String(err && err.message ? err.message : err);
  const named = message.match(/"[^"]+" is already used\. Each slicer needs its own (?:name|path)\./);
  if (named) return named[0];
  if (/slicers\.name/i.test(message)) {
    return 'That slicer name is already used. Each slicer needs its own name.';
  }
  if (/slicers\.path/i.test(message)) {
    return 'That slicer path is already used. Each slicer needs its own path.';
  }
  return 'Error saving slicer settings: ' + message;
}

function saveSlicerSettings() {
  const entries = document.querySelectorAll('.slicer-entry');
  const slicers = Array.from(entries).map(entry => ({
    name: entry.querySelector('.slicer-name').value.trim(),
    path: entry.querySelector('.slicer-path').value.trim()
  }));
  
  // Validate entries
  const invalidEntries = slicers.filter(s => !s.name || !s.path);
  if (invalidEntries.length > 0) {
    alert('Please fill in both name and path for all slicers.');
    return;
  }

  const duplicateMessage = duplicateSlicerMessage(slicers);
  if (duplicateMessage) {
    alert(duplicateMessage);
    return;
  }
  
  // Save all slicers - drop and recreate
  window.electron.clearAndSaveSlicers(slicers)
    .then(() => {
      alert('Slicer settings saved successfully.');
      document.getElementById('slicer-dialog').close();
    })
    .catch(err => {
      alert(friendlySlicerSaveError(err));
      console.error('Error saving slicer settings:', err);
    });
}

document.addEventListener('DOMContentLoaded', () => {
  const dialog = document.getElementById('slicer-dialog');
  if (!dialog) return;

  // Prevent form submission
  const form = dialog.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
  });
  
  // Add new slicer button handler
  document.getElementById('add-slicer-button')?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const slicerList = document.getElementById('slicer-list');
    const entry = await createSlicerEntry();
    if (entry) {
      slicerList.appendChild(entry);
      // Name is editable immediately — focus it so users can type before picking a path
      const nameInput = entry.querySelector('.slicer-name');
      if (nameInput) {
        requestAnimationFrame(() => nameInput.focus());
      }
    }
  });
  
  document.getElementById('download-slicer-helper')?.addEventListener('click', downloadSlicerHelper);

  // Add save button handler
  document.getElementById('save-slicer-settings')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    saveSlicerSettings();
  });
  
  // Add cancel button handler
  document.getElementById('cancel-slicer-settings')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('slicer-dialog').close();
  });
  
  // Listen for the event from main process
  window.electron.onOpenSlicerSettings(() => {
    openSlicerSettings();
  });

  window.openSlicerSettings = openSlicerSettings;
});
