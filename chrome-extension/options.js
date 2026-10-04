'use strict';

function setFolderStatus(kind, text) {
  const el = document.getElementById('folderStatus');
  el.className = 'folder-status' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

function refreshFolderStatus() {
  chrome.storage.local.get(
    { justtprintFolderConfigured: false, justtprintFolderName: '', justtprintFolderHasDb: false },
    (items) => {
      if (!items.justtprintFolderConfigured) {
        setFolderStatus('', 'No folder selected yet. Inbox files will go to Downloads until you choose one.');
        return;
      }
      const name = items.justtprintFolderName || 'selected folder';
      if (items.justtprintFolderHasDb) {
        setFolderStatus('ok', 'Using “' + name + '” (found justtprint.db). Inbox: ' + name + '\\JusttPrintInbox');
      } else {
        setFolderStatus('warn', 'Using “' + name + '”, but justtprint.db was not in that folder. JusttPrint must watch this same path, or pick the data folder that contains the database.');
      }
    }
  );
}

async function chooseFolder() {
  if (!window.showDirectoryPicker) {
    setFolderStatus('err', 'This browser cannot pick a folder. Use Chrome or Edge.');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ id: 'pv-justtprint-dir', mode: 'readwrite' });
    const granted = await JusttPrintFolder.ensureWritePermission(handle);
    if (!granted) {
      setFolderStatus('err', 'Permission was not granted for that folder.');
      return;
    }
    const hasDb = await JusttPrintFolder.folderHasDatabase(handle);
    await JusttPrintFolder.setDirectoryHandle(handle);
    chrome.storage.local.set({
      justtprintFolderConfigured: true,
      justtprintFolderName: handle.name,
      justtprintFolderHasDb: hasDb
    }, refreshFolderStatus);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    setFolderStatus('err', err && err.message ? err.message : String(err));
  }
}

document.getElementById('chooseFolder').addEventListener('click', chooseFolder);

document.getElementById('clearFolder').addEventListener('click', async () => {
  await JusttPrintFolder.clearDirectoryHandle();
  chrome.storage.local.set({
    justtprintFolderConfigured: false,
    justtprintFolderName: '',
    justtprintFolderHasDb: false
  }, refreshFolderStatus);
});

document.getElementById('extensionDebug').addEventListener('change', () => {
  const debug = document.getElementById('extensionDebug').checked;
  if (typeof pvSetDebug === 'function') pvSetDebug(debug);
  chrome.storage.sync.set({ extensionDebug: debug });
});

chrome.storage.sync.get({ extensionDebug: false }, (items) => {
  document.getElementById('extensionDebug').checked = !!items.extensionDebug;
  if (typeof pvSetDebug === 'function') pvSetDebug(!!items.extensionDebug);
});

refreshFolderStatus();
