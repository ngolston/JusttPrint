'use strict';

/**
 * Folder watching for STL Home: new, changed and deleted files show up within seconds instead
 * of at the next timed scan. Each folder gets its own non-recursive fs.watch (one inotify watch
 * per folder; Node's recursive mode on Linux polls every file with fs.watchFile, too heavy for
 * a large library). Changes are collected, wait until files stop changing (a copy in progress),
 * and then only the changed folders are rescanned. Network shares (SMB/NFS) and some Docker
 * Desktop mounts report no changes; the timed STL Home scan still covers them.
 */

const fs = require('fs');
const path = require('path');

/** Wait this long after the last change before scanning. */
const QUIET_MS = 5000;
/** ...but never longer than this after the first change (a folder that keeps changing). */
const MAX_WAIT_MS = 60 * 1000;
/** A file changed this recently is probably still being written: wait for it. */
const SETTLE_MS = 3000;
/** Give up waiting for files to settle after this long. */
const MAX_SETTLE_MS = 10 * 60 * 1000;
/** More changed folders than this under one root: scan the whole root instead. */
const MAX_FOLDERS = 20;
/** Changed file paths remembered for the settle check. */
const MAX_TRACKED_FILES = 500;

const isHidden = (name) => String(name).startsWith('.');

/** Folders without the ones inside another folder of the list (scanning the outer one covers them). */
function collapseFolders(folders) {
  const sorted = [...new Set(folders)].sort((a, b) => a.length - b.length);
  const kept = [];
  for (const folder of sorted) {
    if (!kept.some((outer) => folder === outer || folder.startsWith(outer.endsWith('/') ? outer : `${outer}/`))) kept.push(folder);
  }
  return kept.sort();
}

/**
 * Watches one root folder and its subfolders. `onChange(folder, changedPath)` gets the folder
 * whose contents changed (a new folder counts as changed itself).
 */
class TreeWatcher {
  /**
   * @param {object} options
   * @param {string} options.root
   * @param {(dirPath: string) => boolean} [options.isIgnoredDir] Excluded folders (hidden ones are always skipped).
   * @param {(folder: string, changedPath: string|null) => void} options.onChange
   * @param {typeof import('fs')} [options.fileSystem] fs (watch, promises.readdir, promises.stat), for tests.
   */
  constructor({ root, isIgnoredDir = () => false, onChange, fileSystem = fs }) {
    this.root = path.resolve(root);
    this.isIgnoredDir = isIgnoredDir;
    this.onChange = onChange;
    this.fs = fileSystem;
    this.watchers = new Map();
    this.error = '';
    this.closed = false;
  }

  /** Watch the root and every folder below it. Resolves when the walk is done. */
  async start() {
    await this.watchTree(this.root);
    if (!this.watchers.has(this.root) && !this.error) this.error = `Cannot watch ${this.root}`;
  }

  get folderCount() {
    return this.watchers.size;
  }

  async watchTree(dir) {
    const stack = [dir];
    let walked = 0;
    while (stack.length && !this.closed) {
      const current = stack.pop();
      if (this.watchers.has(current) || (current !== this.root && this.isIgnoredDir(current))) continue;
      if (!this.watchDir(current)) {
        if (this.error && /ENOSPC|EMFILE/.test(this.error)) return; // out of watches: stop trying
        continue;
      }
      let entries = [];
      try {
        entries = await this.fs.promises.readdir(current, { withFileTypes: true });
      } catch (_) {
        /* removed meanwhile, or unreadable */
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !isHidden(entry.name)) stack.push(path.join(current, entry.name));
      }
      // Let other requests run during a long walk.
      if (++walked % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  }

  watchDir(dir) {
    try {
      const watcher = this.fs.watch(dir, { persistent: false }, (eventType, name) => this.handle(dir, name));
      watcher.on('error', () => this.unwatchTree(dir));
      this.watchers.set(dir, watcher);
      return true;
    } catch (error) {
      const code = error && error.code ? error.code : '';
      if (dir === this.root || code === 'ENOSPC' || code === 'EMFILE') {
        this.error =
          code === 'ENOSPC'
            ? `The system ran out of folder watches after ${this.watchers.size} folders (raise fs.inotify.max_user_watches on the host).`
            : `Cannot watch ${dir}: ${code || error.message}`;
      }
      return false;
    }
  }

  unwatchTree(dir) {
    for (const [watched, watcher] of this.watchers) {
      if (watched === dir || watched.startsWith(`${dir}/`)) {
        try {
          watcher.close();
        } catch (_) {
          /* already closed */
        }
        this.watchers.delete(watched);
      }
    }
  }

  handle(dir, name) {
    if (this.closed) return;
    if (!name) {
      this.onChange(dir, null);
      return;
    }
    const text = String(name);
    if (text.split(/[\\/]/).some(isHidden)) return;
    const changed = path.join(dir, text);
    if (this.isIgnoredDir(changed)) return;
    this.onChange(dir, changed);
    // A new folder (created, or moved in with its contents): watch it and scan it; a removed one: stop.
    this.fs.promises
      .stat(changed)
      .then(
        (stat) => {
          if (!stat.isDirectory() || this.closed || this.watchers.has(changed)) return;
          this.onChange(changed, null);
          return this.watchTree(changed);
        },
        () => {
          if (this.watchers.has(changed)) this.unwatchTree(changed);
        }
      )
      .catch(() => {});
  }

  close() {
    this.closed = true;
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch (_) {
        /* already closed */
      }
    }
    this.watchers.clear();
  }
}

/**
 * Collects changes from TreeWatchers and calls `scan(root, folders)` once they have settled.
 * `scan` may return false (busy elsewhere): the folders are kept and tried again later.
 */
class ChangeQueue {
  /** @param {{ scan: Function, quietMs?: number, maxWaitMs?: number, settleMs?: number, maxSettleMs?: number, fileSystem?: typeof import('fs'), now?: () => number }} options */
  constructor({ scan, quietMs = QUIET_MS, maxWaitMs = MAX_WAIT_MS, settleMs = SETTLE_MS, maxSettleMs = MAX_SETTLE_MS, fileSystem = fs, now = Date.now }) {
    this.scan = scan;
    this.quietMs = quietMs;
    this.maxWaitMs = maxWaitMs;
    this.settleMs = settleMs;
    this.maxSettleMs = maxSettleMs;
    this.fs = fileSystem;
    this.now = now;
    this.pending = new Map(); // root -> Set(folder)
    this.files = new Set();
    this.firstChange = 0;
    this.timer = null;
    this.flushing = false;
    this.stopped = false;
  }

  add(root, folder, changedPath) {
    if (this.stopped) return;
    if (!this.pending.has(root)) this.pending.set(root, new Set());
    this.pending.get(root).add(folder);
    if (changedPath && this.files.size < MAX_TRACKED_FILES) this.files.add(changedPath);
    if (!this.firstChange) this.firstChange = this.now();
    this.arm(Math.min(this.quietMs, Math.max(0, this.firstChange + this.maxWaitMs - this.now())));
  }

  arm(wait) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((error) => console.error('[Watch] Rescan failed:', error));
    }, wait);
    if (this.timer.unref) this.timer.unref();
  }

  /** True while a recently changed file is still being written. */
  async stillWriting() {
    const recent = this.now() - this.settleMs;
    for (const file of this.files) {
      try {
        const stat = await this.fs.promises.stat(file);
        if (stat.isFile() && stat.mtimeMs > recent) return true;
      } catch (_) {
        /* deleted: settled */
      }
    }
    return false;
  }

  async flush() {
    if (this.flushing || this.stopped || !this.pending.size) return;
    if (this.now() - this.firstChange < this.maxSettleMs && (await this.stillWriting())) {
      this.arm(this.quietMs);
      return;
    }
    this.flushing = true;
    const batch = this.pending;
    this.pending = new Map();
    this.files = new Set();
    this.firstChange = 0;
    try {
      for (const [root, folders] of batch) {
        const list = collapseFolders([...folders]);
        const targets = list.length > MAX_FOLDERS ? [root] : list;
        let done = true;
        try {
          done = (await this.scan(root, targets)) !== false;
        } catch (error) {
          console.error(`[Watch] Rescan under ${root} failed:`, error.message);
        }
        if (!done) for (const folder of targets) this.add(root, folder, null);
      }
    } finally {
      this.flushing = false;
      if (this.pending.size && !this.timer) this.arm(this.quietMs);
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.files.clear();
  }
}

module.exports = { TreeWatcher, ChangeQueue, collapseFolders, QUIET_MS };
