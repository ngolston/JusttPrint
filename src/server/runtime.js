'use strict';

/**
 * Process services the server needs: data paths and lifecycle events (`app`), the IPC handler
 * registry that the WebSocket dispatcher calls (`ipcMain`), and Move to Trash (`shell.trashItem`).
 * The names match what the old Electron code used.
 *
 * nativeImage cannot decode images on Node, so stored thumbnails are not re-compressed.
 */

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'justtprint';

function configHome() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

class App extends EventEmitter {
  constructor() {
    super();
    this.isPackaged = false;
    this.commandLine = {
      appendSwitch() {},
      appendArgument() {},
      hasSwitch: () => false,
      getSwitchValue: () => ''
    };
    this._ready = false;
    this._quitting = false;
    // Like Electron: "ready" fires after the main script has finished loading.
    this._readyPromise = new Promise((resolve) => {
      setImmediate(() => {
        this._ready = true;
        this.emit('ready');
        resolve();
      });
    });
    process.on('SIGTERM', () => this.quit());
    process.on('SIGINT', () => this.quit());
  }

  whenReady() { return this._readyPromise; }
  isReady() { return this._ready; }
  getName() { return APP_NAME; }
  getVersion() { return require('../../package.json').version; }
  getAppPath() { return path.resolve(__dirname, '..', '..'); }

  getPath(name) {
    const userData = process.env.JUSTTPRINT_USER_DATA || path.join(configHome(), APP_NAME);
    switch (name) {
      case 'userData': return userData;
      case 'appData': return configHome();
      case 'logs': return path.join(userData, 'logs');
      case 'temp': return os.tmpdir();
      case 'exe': return process.execPath;
      case 'home':
      case 'desktop':
      case 'documents':
      case 'downloads':
        return os.homedir();
      default: return userData;
    }
  }

  setPath() {}
  getGPUInfo() { return Promise.resolve({}); }
  getGPUFeatureStatus() { return {}; }
  relaunch() {}
  focus() {}

  /** Same order as Electron: before-quit, will-quit (synchronous cleanup), quit, exit. */
  quit() {
    if (this._quitting) return;
    this._quitting = true;
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit('before-quit', event);
    this.emit('will-quit', event);
    this.emit('quit', event, 0);
    process.exit(0);
  }

  exit(code = 0) {
    process.exit(code);
  }
}

class IpcMain extends EventEmitter {
  constructor() {
    super();
    this._handlers = new Map();
  }

  handle(channel, handler) {
    this._handlers.set(channel, handler);
  }

  handleOnce(channel, handler) {
    this._handlers.set(channel, async (...args) => {
      this._handlers.delete(channel);
      return handler(...args);
    });
  }

  removeHandler(channel) {
    this._handlers.delete(channel);
  }
}

/** Top of the mount that holds this path (where the device number changes). */
function mountTop(dir) {
  let current = path.resolve(dir);
  const device = fs.statSync(current).dev;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    let parentDevice;
    try {
      parentDevice = fs.statSync(parent).dev;
    } catch (_) {
      return current;
    }
    if (parentDevice !== device) return current;
    current = parent;
  }
}

function makeTrashDirs(trash) {
  const filesDir = path.join(trash, 'files');
  const infoDir = path.join(trash, 'info');
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(infoDir, { recursive: true, mode: 0o700 });
  return { filesDir, infoDir };
}

/**
 * Trash folder on the same drive as the file, so the move is a rename (no copy of large
 * files) and file managers can restore it (freedesktop.org trash spec):
 * <mount>/.Trash-<uid> for mounted drives, else the home trash when it is on the same drive.
 */
function trashDirsFor(source) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const top = mountTop(path.dirname(source));
  if (top !== path.parse(top).root) {
    try {
      return makeTrashDirs(path.join(top, `.Trash-${uid}`));
    } catch (_) { /* read-only or no permission: try the home trash */ }
  }
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const homeTrash = path.join(dataHome, 'Trash');
  const dirs = makeTrashDirs(homeTrash);
  if (fs.statSync(homeTrash).dev !== fs.statSync(path.dirname(source)).dev) {
    throw new Error(`Cannot move ${source} to the trash: no trash folder on its drive`);
  }
  return dirs;
}

function trashItem(filePath) {
  return new Promise((resolve, reject) => {
    try {
      const source = path.resolve(filePath);
      fs.lstatSync(source);
      const { filesDir, infoDir } = trashDirsFor(source);

      const base = path.basename(source);
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      let name = base;
      for (let n = 2; fs.existsSync(path.join(filesDir, name)) || fs.existsSync(path.join(infoDir, `${name}.trashinfo`)); n++) {
        name = `${stem}.${n}${ext}`;
      }

      const deletedAt = new Date().toISOString().replace(/\.\d+Z$/, '');
      fs.writeFileSync(
        path.join(infoDir, `${name}.trashinfo`),
        `[Trash Info]\nPath=${encodeURI(source)}\nDeletionDate=${deletedAt}\n`
      );
      fs.renameSync(source, path.join(filesDir, name));
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}

const shell = { trashItem };

/** An image that never decodes; callers treat it like a file they cannot read. */
const emptyImage = {
  isEmpty: () => true,
  getSize: () => ({ width: 0, height: 0 }),
  hasAlpha: () => false,
  resize: () => emptyImage,
  toJPEG: () => Buffer.alloc(0),
  toPNG: () => Buffer.alloc(0),
  toDataURL: () => ''
};

const nativeImage = {
  createEmpty: () => emptyImage,
  createFromBuffer: () => emptyImage,
  createFromPath: () => emptyImage,
  createFromDataURL: () => emptyImage
};

module.exports = {
  app: new App(),
  ipcMain: new IpcMain(),
  shell,
  nativeImage,
  // Exposed for tests.
  _internal: { mountTop }
};
