'use strict';

/**
 * A Bambu Lab printer's storage (its microSD card on a P1 or A1), as Bambu Studio and OrcaSlicer
 * reach it in LAN mode: upload (Send, bambu-send.js), list, download and delete (printer-files.js).
 * FTP over TLS from the first byte (implicit FTPS, port 990), user bblp, the printer's access code.
 * The data connection is TLS too, reusing the control connection's session (the printer refuses
 * a data connection without it). Printers have their own certificates, so none is checked, as
 * the live status (bambu-live.js) does.
 */

const fs = require('fs');
const net = require('net');
const tls = require('tls');

const PORT = 990;
const TIMEOUT_MS = 30000;

/** Reads FTP replies ("230 Logged in", or "220-…" lines ending with "220 …") from a connection. */
function replies(socket) {
  let buffer = '';
  let lines = [];
  const ready = [];
  const waiting = [];
  let failure = null;
  const settle = () => {
    while (ready.length && waiting.length) waiting.shift().resolve(ready.shift());
    if (failure) while (waiting.length) waiting.shift().reject(failure);
  };
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      lines.push(line);
      const m = /^(\d{3})([ -])/.exec(line);
      // A reply ends with its code and a space; "123-" starts one of several lines.
      if (m && m[2] === ' ' && (lines.length === 1 || lines[0].startsWith(m[1]))) {
        ready.push({ code: Number(m[1]), text: lines.join('\n') });
        lines = [];
      }
    }
    settle();
  });
  const fail = (error) => {
    failure = failure || error;
    settle();
  };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('The printer closed the connection')));
  return {
    next(timeoutMs = TIMEOUT_MS) {
      if (ready.length) return Promise.resolve(ready.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The printer did not answer in time')), timeoutMs);
        waiting.push({
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
    }
  };
}

/** Throws unless the reply's code is one of `codes`, with what the printer said. */
function expect(reply, codes, what) {
  if (codes.includes(reply.code)) return reply;
  if (reply.code === 530) throw new Error('The printer refused the access code: check it in Printers (the printer shows it under Settings → Network)');
  throw new Error(`${what}: the printer answered "${reply.text.split('\n').pop()}"`);
}

function once(emitter, okEvent, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${what}: no answer from the printer`));
    }, timeoutMs);
    const ok = (value) => {
      cleanup();
      resolve(value);
    };
    const bad = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(okEvent, ok);
      emitter.off('error', bad);
    };
    emitter.on(okEvent, ok);
    emitter.on('error', bad);
  });
}

/** A path on the printer: "/", "/timelapse", "/Robot.gcode.3mf"; no "..", no line breaks. */
function printerPath(value) {
  const text = `/${String(value || '').replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/';
  if (/[\r\n\0]/.test(text) || text.split('/').some((part) => part === '..')) throw new Error('That is not a path on the printer');
  return text;
}

/**
 * The lines of a LIST reply ("-rw-r--r-- 1 root root 1234 Nov 05 12:34 Robot.gcode.3mf"):
 * [{ name, folder, size, modified }], "." and ".." left out.
 */
function parseListing(text, now = new Date()) {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([dl-])[rwxsStT-]{9}\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const name = m[6].replace(/ -> .*$/, '');
    if (name === '.' || name === '..') continue;
    const month = months.indexOf(m[3].toLowerCase());
    /** @type {string | null} */
    let modified = null;
    if (month >= 0) {
      if (m[5].includes(':')) {
        const [h, min] = m[5].split(':').map(Number);
        const date = new Date(now.getFullYear(), month, Number(m[4]), h, min);
        // "Nov 05 12:34" is this year, unless that is still to come: last year's.
        if (date.getTime() > now.getTime() + 86400000) date.setFullYear(date.getFullYear() - 1);
        modified = date.toISOString();
      } else modified = new Date(Number(m[5]), month, Number(m[4])).toISOString();
    }
    out.push({ name, folder: m[1] === 'd', size: Number(m[2]), modified });
  }
  return out;
}

/**
 * Open a session on the printer's storage: list, download, upload and delete, then close.
 * @param {{ host: string, port?: number, accessCode: string, timeoutMs?: number }} options
 */
async function openSession({ host, port = PORT, accessCode, timeoutMs = TIMEOUT_MS }) {
  const servername = net.isIP(host) ? undefined : host;
  const control = tls.connect({ host, port, rejectUnauthorized: false, servername });
  const answers = replies(control);
  /** @type {Set<import('net').Socket>} the data connections, closed with the session whatever happens */
  const sockets = new Set();
  const send = async (line, codes, what) => {
    control.write(`${line}\r\n`);
    return expect(await answers.next(timeoutMs), codes, what);
  };
  const close = () => {
    for (const socket of sockets) socket.destroy();
    control.destroy();
  };
  try {
    await once(control, 'secureConnect', timeoutMs, 'Connecting to the printer');
    expect(await answers.next(timeoutMs), [220], 'Connecting to the printer');
    await send('USER bblp', [230, 331], 'Signing in');
    await send(`PASS ${accessCode}`, [230], 'Signing in');
    await send('TYPE I', [200], 'Preparing');
    await send('PBSZ 0', [200], 'Preparing');
    await send('PROT P', [200], 'Preparing');
  } catch (error) {
    close();
    throw error;
  }

  /**
   * A command with a data connection (LIST, RETR, STOR): opened before it, TLS after the
   * printer's 150. `upload` is sent; otherwise what comes back is answered.
   * @param {string} line
   * @param {string} what
   * @param {import('stream').Readable} [upload]
   */
  async function transfer(line, what, upload) {
    const passive = await send('PASV', [227], what);
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(passive.text);
    if (!m) throw new Error('The printer gave no address for the transfer');
    // The printer's own address, whatever it names (it may name another network's).
    const raw = net.connect({ host, port: Number(m[5]) * 256 + Number(m[6]) });
    sockets.add(raw);
    await once(raw, 'connect', timeoutMs, what);
    control.write(`${line}\r\n`);
    const started = await answers.next(timeoutMs);
    // A P1 or A1 keeps prints on its microSD card: without one there is nowhere to put the file.
    if (upload && started.code >= 550 && started.code <= 553) {
      throw new Error(`The printer could not store the file ("${started.text.split('\n').pop()}"): check that a microSD card is in the printer and has room`);
    }
    expect(started, [125, 150], what);
    const data = tls.connect({ socket: raw, session: control.getSession(), rejectUnauthorized: false, servername });
    await once(data, 'secureConnect', timeoutMs, what);
    const parts = [];
    await new Promise((resolve, reject) => {
      data.on('error', reject);
      data.on('close', resolve);
      if (upload) {
        upload.on('error', reject);
        upload.pipe(data);
      } else data.on('data', (chunk) => parts.push(chunk));
    });
    expect(await answers.next(Math.max(timeoutMs, 120000)), [226, 250], what);
    return Buffer.concat(parts);
  }

  return {
    /** The folders and files in a folder of the printer's storage. */
    async list(dir = '/') {
      return parseListing((await transfer(`LIST ${printerPath(dir)}`, 'Listing the files')).toString('utf8'));
    },
    /** A file's bytes. */
    async download(path) {
      return transfer(`RETR ${printerPath(path)}`, 'Reading the file');
    },
    /** Upload a local file as `remoteName` in the top folder. */
    async upload(localPath, remoteName) {
      if (!/^[^/\\\r\n]+$/.test(remoteName)) throw new Error('The file name for the printer is not valid');
      await transfer(`STOR ${remoteName}`, 'Uploading', fs.createReadStream(localPath));
    },
    /** Delete a file. */
    async remove(path) {
      await send(`DELE ${printerPath(path)}`, [250], 'Deleting the file');
    },
    close() {
      try {
        control.write('QUIT\r\n');
      } catch (_) {
        /* closed */
      }
      close();
    }
  };
}

/**
 * Run `work` with a session on the printer's storage, closed after.
 * @template T
 * @param {{ host: string, port?: number, accessCode: string, timeoutMs?: number }} options
 * @param {(session: Awaited<ReturnType<typeof openSession>>) => Promise<T>} work
 * @returns {Promise<T>}
 */
async function withPrinterFiles(options, work) {
  const session = await openSession(options);
  try {
    return await work(session);
  } finally {
    session.close();
  }
}

/**
 * Upload `localPath` to the printer's storage as `remoteName` (in its top folder).
 * @param {{ host: string, port?: number, accessCode: string, localPath: string, remoteName: string, timeoutMs?: number }} options
 */
async function uploadToPrinter({ host, port = PORT, accessCode, localPath, remoteName, timeoutMs = TIMEOUT_MS }) {
  if (!/^[^/\\\r\n]+$/.test(remoteName)) throw new Error('The file name for the printer is not valid');
  const size = (await fs.promises.stat(localPath)).size;
  await withPrinterFiles({ host, port, accessCode, timeoutMs }, (session) => session.upload(localPath, remoteName));
  return { size };
}

module.exports = { uploadToPrinter, withPrinterFiles, openSession, parseListing, printerPath, replies };
