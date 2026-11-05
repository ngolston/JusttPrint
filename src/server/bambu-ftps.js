'use strict';

/**
 * Upload a file to a Bambu Lab printer's storage, as Bambu Studio and OrcaSlicer do in LAN mode:
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

/**
 * Upload `localPath` to the printer's storage as `remoteName` (in its top folder).
 * @param {{ host: string, port?: number, accessCode: string, localPath: string, remoteName: string, timeoutMs?: number }} options
 */
async function uploadToPrinter({ host, port = PORT, accessCode, localPath, remoteName, timeoutMs = TIMEOUT_MS }) {
  if (!/^[^/\\\r\n]+$/.test(remoteName)) throw new Error('The file name for the printer is not valid');
  const size = (await fs.promises.stat(localPath)).size;
  const control = tls.connect({ host, port, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host });
  const answers = replies(control);
  const send = async (line, codes, what) => {
    control.write(`${line}\r\n`);
    return expect(await answers.next(timeoutMs), codes, what);
  };
  /** @type {import('net').Socket | null} The data connection, closed with the control one whatever happens. */
  let raw = null;
  try {
    await once(control, 'secureConnect', timeoutMs, 'Connecting to the printer');
    expect(await answers.next(timeoutMs), [220], 'Connecting to the printer');
    await send('USER bblp', [230, 331], 'Signing in');
    await send(`PASS ${accessCode}`, [230], 'Signing in');
    await send('TYPE I', [200], 'Preparing the upload');
    await send('PBSZ 0', [200], 'Preparing the upload');
    await send('PROT P', [200], 'Preparing the upload');
    const passive = await send('PASV', [227], 'Preparing the upload');
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(passive.text);
    if (!m) throw new Error('The printer gave no address for the upload');
    // The printer's own address, whatever it names (it may name another network's).
    const dataPort = Number(m[5]) * 256 + Number(m[6]);
    raw = net.connect({ host, port: dataPort });
    await once(raw, 'connect', timeoutMs, 'Opening the upload');
    control.write(`STOR ${remoteName}\r\n`);
    const started = await answers.next(timeoutMs);
    // A P1 or A1 keeps prints on its microSD card: without one there is nowhere to put the file.
    if (started.code >= 550 && started.code <= 553) {
      throw new Error(`The printer could not store the file ("${started.text.split('\n').pop()}"): check that a microSD card is in the printer and has room`);
    }
    expect(started, [125, 150], 'Starting the upload');
    const data = tls.connect({ socket: raw, session: control.getSession(), rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host });
    await once(data, 'secureConnect', timeoutMs, 'Opening the upload');
    await new Promise((resolve, reject) => {
      const file = fs.createReadStream(localPath);
      file.on('error', reject);
      data.on('error', reject);
      data.on('close', resolve);
      file.pipe(data);
    });
    expect(await answers.next(Math.max(timeoutMs, 120000)), [226, 250], 'Finishing the upload');
    control.write('QUIT\r\n');
    return { size };
  } finally {
    if (raw) raw.destroy();
    control.destroy();
  }
}

module.exports = { uploadToPrinter, replies };
