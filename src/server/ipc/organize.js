'use strict';

const events = require('../events');
const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const fs = require('fs');
const path = require('path');
const { deriveBundleFromFilePath } = require('../../core/bundle-keys');
const { buildFolderForest } = require('../../core/folder-tree-lib');
const { readScannedDirectorySetting, readStlHomeDirectories, assertContainerPath } = require('../../core/library-paths');
const { planOrganize, withFreeSpace, readFreeBytes, runOrganizePlan, pathsAreSame } = require('../../core/organize-library');

function inspectOrganizeDirectory(dirPath, allowMissing) {
  const target = String(dirPath || '').trim();
  if (!target) {
    return { ok: false, error: 'Choose a source directory and a destination directory.' };
  }
  try {
    assertContainerPath(target, 'organize-library');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try {
    const st = fs.statSync(target);
    if (!st.isDirectory()) return { ok: false, error: `"${target}" is not a folder.` };
    return { ok: true, path: target, created: false };
  } catch (err) {
    if (err && err.code === 'ENOENT' && allowMissing) return { ok: true, path: target, created: true };
    if (err && err.code === 'ENOENT') return { ok: false, error: `Folder not found: ${target}` };
    return { ok: false, error: err.message || 'Could not read that folder.' };
  }
}

function statOrganizeFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { size: st.size, isFile: st.isFile() };
  } catch (_) {
    return null;
  }
}

function directoryExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

function listOrganizeSources() {
  const saved = readScannedDirectorySetting();
  const homes = readStlHomeDirectories();
  let lastScan;
  try {
    lastScan = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('directoryPath')?.value || '';
  } catch (_) {
    lastScan = '';
  }
  let forestRoots = [];
  try {
    const rows = database.db.prepare('SELECT filePath FROM models').all();
    const forest = buildFolderForest(rows.map((row) => row.filePath).filter(Boolean), {
      stlHome: homes[0] || '',
      roots: [...saved, ...homes, lastScan].filter(Boolean)
    });
    forestRoots = Array.isArray(forest.roots) ? forest.roots : [];
  } catch (error) {
    console.error('Could not list scanned directories:', error);
  }

  const items = [];
  const add = (dir) => {
    const folder = String(dir || '').trim();
    if (!folder || folder.includes('::') || !directoryExists(folder)) return;
    const normalized = path.normalize(folder);
    if (items.some((item) => pathsAreSame(item.path, normalized))) return;
    items.push({ path: normalized, label: normalized });
  };

  for (const node of forestRoots) {
    if (!node || node.isBundle) continue;
    add(node.path);
  }
  for (const dir of saved) add(dir);
  for (const dir of homes) add(dir);
  if (lastScan) add(lastScan);

  items.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  return items;
}

function zipArchivesEnabled() {
  try {
    const row = database.db.prepare('SELECT value FROM settings WHERE key = ?').get('enableZipArchives');
    return !!(row && row.value === '1');
  } catch (_) {
    return false;
  }
}

function buildOrganizePlan(sourceDir, destDir, includeZips, layers) {
  const source = inspectOrganizeDirectory(sourceDir, false);
  if (!source.ok) {
    return {
      ok: false,
      error: source.error,
      moves: [],
      skipped: [],
      sample: [],
      copyCount: 0,
      resumeCount: 0,
      copyBytes: 0,
      noParentCount: 0,
      reasonCounts: {}
    };
  }
  const dest = inspectOrganizeDirectory(destDir, true);
  if (!dest.ok) {
    return { ok: false, error: dest.error, moves: [], skipped: [], sample: [], copyCount: 0, resumeCount: 0, copyBytes: 0, noParentCount: 0, reasonCounts: {} };
  }
  const rows = database.db.prepare('SELECT id, filePath, fileName, designer, parentModel, license, source, print_status, size FROM models').all();
  const plan = planOrganize(rows, source.path, dest.path, {
    sourceStat: statOrganizeFile,
    destStat: statOrganizeFile,
    includeZips: includeZips === true && zipArchivesEnabled(),
    layers: Array.isArray(layers) ? layers : undefined,
    allowedRoots: listOrganizeSources().map((item) => item.path)
  });
  return Object.assign(plan, {
    destWillBeCreated: !!dest.created,
    sourceDir: source.path,
    destDir: dest.path
  });
}

function publicOrganizePreview(plan) {
  return {
    ok: !!plan.ok,
    error: plan.error || null,
    spaceError: plan.spaceError || null,
    enoughSpace: !!plan.enoughSpace,
    freeBytes: plan.freeBytes == null ? null : plan.freeBytes,
    marginBytes: plan.marginBytes,
    copyBytes: plan.copyBytes || 0,
    copyCount: plan.copyCount || 0,
    resumeCount: plan.resumeCount || 0,
    zipCount: plan.zipCount || 0,
    zipEntryCount: plan.zipEntryCount || 0,
    noParentCount: plan.noParentCount || 0,
    emptyLayers: Array.isArray(plan.emptyLayers) ? plan.emptyLayers : [],
    layers: Array.isArray(plan.layers) ? plan.layers : [],
    skippedCount: Array.isArray(plan.skipped) ? plan.skipped.length : 0,
    reasonCounts: plan.reasonCounts || {},
    sample: plan.sample || [],
    skipped: Array.isArray(plan.skipped) ? plan.skipped.slice(0, 40) : [],
    destWillBeCreated: !!plan.destWillBeCreated,
    sourceDir: plan.sourceDir || '',
    destDir: plan.destDir || ''
  };
}

/** The progress dialog goes to the browser that started Organize; the grid refresh to every browser. */
function sendOrganizeEvent(event, channel, data) {
  if (channel === 'refresh-grid') events.broadcast(channel);
  else events.toCaller(event, channel, data);
}

ipcMain.handle('list-organize-sources', async () => {
  try {
    return listOrganizeSources();
  } catch (error) {
    console.error('Could not list organize sources:', error);
    return [];
  }
});

ipcMain.handle('organize-library-preview', async (event, payload) => {
  try {
    const sourceDir = payload && payload.sourceDir;
    const destDir = payload && payload.destDir;
    const plan = buildOrganizePlan(sourceDir, destDir, payload && payload.includeZips, payload && payload.layers);
    /** @type {number | null} */
    let free = null;
    const spacePath = plan.destDir || destDir;
    if (spacePath) {
      try {
        free = await readFreeBytes(spacePath);
      } catch (_) {
        free = null;
      }
    }
    return publicOrganizePreview(withFreeSpace(plan, free));
  } catch (err) {
    console.error('Organize library preview failed:', err);
    return {
      ok: false,
      error: err.message || 'Could not preview the organize job.',
      enoughSpace: false,
      sample: [],
      skipped: [],
      copyCount: 0,
      resumeCount: 0
    };
  }
});

ipcMain.handle('organize-library-run', async (event, payload) => {
  let progressOpen = false;
  try {
    const sourceDir = payload && payload.sourceDir;
    const destDir = payload && payload.destDir;
    /** @type {number | null} */
    let free = null;
    try {
      free = await readFreeBytes(destDir);
    } catch (_) {
      free = null;
    }
    const plan = withFreeSpace(buildOrganizePlan(sourceDir, destDir, payload && payload.includeZips, payload && payload.layers), free);
    if (!plan.ok) return { ok: false, error: plan.error || 'Could not organize that folder.' };
    if (!plan.enoughSpace) return { ok: false, error: plan.spaceError || 'Not enough free disk space.' };
    const total = (plan.copyCount || 0) + (plan.resumeCount || 0);
    if (!total) return { ok: false, error: 'Nothing to move.' };
    if (plan.destWillBeCreated) {
      await fs.promises.mkdir(plan.destDir, { recursive: true });
    }
    sendOrganizeEvent(event, 'show-progress-dialog', {
      title: 'Organize Library',
      message: 'Copying models...',
      total
    });
    progressOpen = true;
    const updatePath = database.db.prepare('UPDATE models SET filePath = ?, fileName = ? WHERE filePath = ?');
    const updateZipEntry = database.db.prepare('UPDATE models SET filePath = ?, bundleKey = ?, bundleLabel = ?, bundleKind = ? WHERE filePath = ?');
    const updateZipEntries = database.db.transaction((rows) => {
      for (const row of rows) {
        const bundle = deriveBundleFromFilePath(row.to);
        const info = updateZipEntry.run(row.to, bundle.bundleKey || null, bundle.bundleLabel || null, bundle.bundleKind || null, row.from);
        if (!info.changes) throw new Error('Library record was not updated');
      }
    });
    const results = await runOrganizePlan(plan, {
      updateFilePath: (from, to) => {
        const info = updatePath.run(to, path.basename(to), from);
        if (!info.changes) throw new Error('Library record was not updated');
      },
      updateLibrary: (updates) => updateZipEntries(updates),
      onProgress: (current, count, move) => {
        sendOrganizeEvent(event, 'update-progress', {
          current,
          total: count,
          message: move ? path.basename(move.to) : 'Finishing...'
        });
      }
    });
    sendOrganizeEvent(event, 'close-progress-dialog');
    progressOpen = false;
    sendOrganizeEvent(event, 'refresh-grid');
    return {
      ok: results.failed.length === 0,
      moved: results.moved,
      resumed: results.resumed,
      failed: results.failed.slice(0, 20),
      failedCount: results.failed.length,
      warnings: results.warnings.slice(0, 20),
      warningCount: results.warnings.length,
      skipped: results.skipped,
      zipModels: results.zipModels || 0
    };
  } catch (err) {
    console.error('Organize library run failed:', err);
    if (progressOpen) sendOrganizeEvent(event, 'close-progress-dialog');
    sendOrganizeEvent(event, 'refresh-grid');
    return { ok: false, error: err.message || 'Organize failed.' };
  }
});
