'use strict';

/**
 * Uploads in pieces, so files of many gigabytes get through reverse proxies (Cloudflare takes at
 * most 100 MB per request, nginx 1 MB by default) and resume after a dropped connection.
 *
 * A session is one file on its way into a library folder: a hidden temp file next to its
 * destination, and how many bytes have arrived. Pieces must come in order (each at the offset
 * the last one ended); a piece that fails is cut off again, so the temp file always holds whole
 * pieces. Sessions are kept in a small JSON file in the data folder, so an upload continues
 * after a server restart (the temp file's size says how far it got). Sessions idle for a day
 * are deleted with their temp file.
 *
 * Only the user who started a session may add to it, finish it or cancel it.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 20;
/** Room left on the disk besides the file itself. */
const FREE_SPACE_MARGIN = 64 * 1024 * 1024;
const TEMP_SUFFIX = '.justtprint-upload';

function httpError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

/** Free bytes on the disk that holds `dir` (null when the system cannot say). */
function freeBytesOn(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch (_) {
    return null;
  }
}

const formatGb = (bytes) => `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;

/**
 * Copy `input` into `output`, failing when more than `maxBytes` arrive. Resolves with the bytes
 * written once `output` has flushed them.
 */
function pipeLimited(input, output, maxBytes, tooLarge) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      input.unpipe(output);
      output.destroy();
      reject(error);
    };
    input.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) fail(tooLarge());
    });
    input.on('aborted', () => fail(httpError(499, 'The upload was cancelled')));
    input.on('error', fail);
    output.on('error', fail);
    output.on('finish', () => {
      if (!failed) resolve(size);
    });
    input.pipe(output);
  });
}

/**
 * @param {object} options
 * @param {string} options.stateFile JSON file that lists the open sessions.
 * @param {(tempPath: string, folder: string, name: string) => string} options.place Gives the
 *   finished temp file its name without replacing a file; returns the final path.
 * @param {() => number} [options.now]
 * @param {number} [options.idleMs] Sessions without a piece for this long are deleted.
 * @param {(dir: string) => (number|null)} [options.freeBytes]
 * @param {{ warn: Function }} [options.logger]
 */
function createUploadSessions({ stateFile, place, now = Date.now, idleMs = DEFAULT_IDLE_MS, freeBytes = freeBytesOn, logger = console }) {
  const sessions = new Map();
  let loaded = false;

  function save() {
    const list = [...sessions.values()].map(({ busy, ...rest }) => rest);
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const temp = `${stateFile}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(list));
      fs.renameSync(temp, stateFile);
    } catch (error) {
      logger.warn(`[Upload] Could not save the open uploads: ${error.message}`);
    }
  }

  /** Read the sessions saved before a restart; their temp files say how far each got. */
  function load() {
    if (loaded) return;
    loaded = true;
    let list;
    try {
      list = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (_) {
      return;
    }
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.tempPath !== 'string') continue;
      try {
        const received = fs.statSync(entry.tempPath).size;
        if (received > entry.size) continue;
        sessions.set(entry.id, { ...entry, received, busy: false });
      } catch (_) {
        /* temp file gone */
      }
    }
  }

  function publicSession(session) {
    return { id: session.id, fileName: session.name, folder: session.folder, size: session.size, received: session.received };
  }

  function owned(id, user) {
    load();
    const session = sessions.get(String(id || ''));
    if (!session) throw httpError(404, 'This upload no longer exists. Upload the file again.');
    if (!user || session.userId !== user.id) throw httpError(403, 'This upload belongs to another user');
    return session;
  }

  function drop(session) {
    sessions.delete(session.id);
    try {
      fs.unlinkSync(session.tempPath);
    } catch (_) {
      /* already gone */
    }
  }

  /**
   * Begin an upload of `size` bytes as `name` into `folder` (both already checked by the caller).
   * @returns {{ id: string, fileName: string, folder: string, size: number, received: number }}
   */
  function start({ user, folder, name, size, maxBytes }) {
    load();
    if (!Number.isSafeInteger(size) || size < 0) throw httpError(400, 'The file size is missing');
    if (size > maxBytes) {
      throw httpError(413, `The file is larger than the upload limit (${formatGb(maxBytes)}). Raise JUSTTPRINT_MAX_UPLOAD_MB to upload it.`);
    }
    const mine = [...sessions.values()].filter((session) => session.userId === user.id);
    if (mine.length >= MAX_SESSIONS_PER_USER) {
      throw httpError(429, 'Too many unfinished uploads. Finish or cancel some first.');
    }
    const free = freeBytes(folder);
    // Space the other unfinished uploads into the same disk still need is not counted: they may never finish.
    if (free != null && free < size + FREE_SPACE_MARGIN) {
      throw httpError(507, `Not enough free space for ${name}: it needs ${formatGb(size)}, the disk has ${formatGb(Math.max(0, free))} free`);
    }
    const id = crypto.randomBytes(16).toString('hex');
    const tempPath = path.join(folder, `.${id}${TEMP_SUFFIX}`);
    fs.writeFileSync(tempPath, '', { flag: 'wx', mode: 0o644 });
    const session = {
      id,
      userId: user.id,
      username: user.username,
      folder,
      name,
      size,
      received: 0,
      tempPath,
      startedAt: now(),
      touchedAt: now(),
      busy: false
    };
    sessions.set(id, session);
    save();
    return publicSession(session);
  }

  function status(id, user) {
    const session = owned(id, user);
    return publicSession(session);
  }

  /**
   * Add the piece in `input` at `offset`. The offset must be where the upload stands (the answer
   * to a wrong offset says where that is, so the browser can continue from there).
   */
  async function writePiece(id, user, offset, input, { maxPieceBytes }) {
    const session = owned(id, user);
    if (session.busy) throw httpError(409, 'A piece of this upload is still arriving', { received: session.received });
    if (!Number.isSafeInteger(offset) || offset !== session.received) {
      throw httpError(409, `Expected the piece at ${session.received}`, { received: session.received });
    }
    session.busy = true;
    try {
      const output = fs.createWriteStream(session.tempPath, { flags: 'r+', start: offset });
      const room = Math.min(maxPieceBytes, session.size - offset);
      const written = await pipeLimited(input, output, room, () =>
        session.size - offset < maxPieceBytes
          ? httpError(400, 'The piece goes past the end of the file')
          : httpError(413, `A piece may be at most ${maxPieceBytes} bytes`)
      );
      session.received = offset + written;
      session.touchedAt = now();
      return { received: session.received, size: session.size };
    } catch (error) {
      // Keep only whole pieces: cut off what arrived of this one.
      try {
        fs.truncateSync(session.tempPath, session.received);
      } catch (_) {
        /* gone */
      }
      throw error;
    } finally {
      session.busy = false;
    }
  }

  /** All pieces are in: give the file its name. */
  function finish(id, user) {
    const session = owned(id, user);
    if (session.busy) throw httpError(409, 'A piece of this upload is still arriving', { received: session.received });
    if (session.received !== session.size) {
      throw httpError(409, `The upload is not complete (${session.received} of ${session.size} bytes)`, { received: session.received });
    }
    const filePath = place(session.tempPath, session.folder, session.name);
    sessions.delete(session.id);
    save();
    return { fileName: path.basename(filePath), filePath, size: session.size };
  }

  function abort(id, user) {
    const session = owned(id, user);
    drop(session);
    save();
    return { success: true };
  }

  /** Delete sessions that had no piece for `idleMs`. Returns how many. */
  function sweep() {
    load();
    let removed = 0;
    for (const session of [...sessions.values()]) {
      if (session.busy || now() - session.touchedAt < idleMs) continue;
      drop(session);
      removed++;
    }
    if (removed) save();
    return removed;
  }

  return { start, status, writePiece, finish, abort, sweep, load, size: () => sessions.size };
}

module.exports = { createUploadSessions, freeBytesOn, pipeLimited, httpError, TEMP_SUFFIX };
