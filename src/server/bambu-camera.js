'use strict';

/**
 * The camera of a Bambu Lab P1 or A1 printer over the LAN: TLS on port 6000, signed in with bblp
 * and the access code; the printer then sends JPEG pictures, about one a second, each after a
 * 16-byte header whose first four bytes (little-endian) are its length. (The X1 and H2 stream
 * RTSP on port 322 instead; that is not read here.)
 *
 * A camera is opened only while someone looks: each picture asked for keeps it open for
 * IDLE_MS, then it closes. Browsers get the latest picture at GET /api/printers/:id/camera.
 */

const tls = require('tls');
const net = require('net');

const PORT = 6000;
const IDLE_MS = 20 * 1000;
const RETRY_MS = 5000;
const MAX_FRAME = 4 * 1024 * 1024;

/** The sign-in packet: 0x40, 0x3000, two zeros, then the user and the access code, 32 bytes each. */
function authPacket(username, accessCode) {
  const packet = Buffer.alloc(80);
  packet.writeUInt32LE(0x40, 0);
  packet.writeUInt32LE(0x3000, 4);
  packet.write(String(username).slice(0, 32), 16, 'ascii');
  packet.write(String(accessCode).slice(0, 32), 48, 'ascii');
  return packet;
}

/** JPEG pictures in a stream of bytes, and what is left for next time. */
function readFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 16) {
    const size = buffer.readUInt32LE(offset);
    if (size <= 0 || size > MAX_FRAME) throw new Error('the camera sent something that is not a picture');
    if (buffer.length - offset - 16 < size) break;
    const jpeg = buffer.subarray(offset + 16, offset + 16 + size);
    offset += 16 + size;
    // A picture starts with FF D8; anything else is skipped.
    if (jpeg[0] === 0xff && jpeg[1] === 0xd8) frames.push(Buffer.from(jpeg));
  }
  return { frames, rest: buffer.subarray(offset) };
}

/**
 * The cameras. `config(printerId)` answers { host, secret } for a Bambu printer followed live, or
 * null. Tests give `connect` (and `port`, `secure`).
 * @param {{ config: (printerId: number) => { host: string, secret: string } | null, connect?: (options: any) => any, port?: number, secure?: boolean, now?: () => number }} deps
 */
function createCameras(deps) {
  const now = deps.now || Date.now;
  // JUSTTPRINT_BAMBU_CAMERA_PORT: another port, for the end-to-end checks' fake printer.
  const port = deps.port || Number(process.env.JUSTTPRINT_BAMBU_CAMERA_PORT) || PORT;
  /** @type {Map<number, any>} */
  const cameras = new Map();

  function open(camera) {
    const { host, secret } = camera.config;
    const options = { host, port, rejectUnauthorized: false };
    const socket = deps.connect ? deps.connect(options) : deps.secure === false ? net.connect(options) : tls.connect(options);
    camera.socket = socket;
    let buffer = Buffer.alloc(0);
    socket.setTimeout(15000, () => socket.destroy(new Error('the camera did not answer')));
    socket.on(deps.secure === false || deps.connect ? 'connect' : 'secureConnect', () => socket.write(authPacket('bblp', secret)));
    socket.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      let read;
      try {
        read = readFrames(buffer);
      } catch (error) {
        socket.destroy(error);
        return;
      }
      buffer = Buffer.from(read.rest);
      if (read.frames.length) {
        socket.setTimeout(30000);
        camera.frame = read.frames[read.frames.length - 1];
        camera.frameAt = now();
        camera.error = null;
        for (const waiter of camera.waiters.splice(0)) waiter(camera.frame);
      }
    });
    socket.on('error', (error) => {
      camera.error = error.code === 'ECONNREFUSED' ? 'the camera is off: turn on LAN Mode Liveview on the printer' : error.message;
    });
    socket.on('close', () => {
      if (camera.socket !== socket) return;
      camera.socket = null;
      if (!camera.frame && !camera.error)
        camera.error = 'the camera closed the connection: turn on LAN Mode Liveview on the printer, and check the access code';
      if (camera.wantedUntil > now() && !camera.stopped) {
        camera.retry = setTimeout(() => {
          camera.retry = null;
          if (camera.wantedUntil > now() && !camera.stopped) open(camera);
        }, RETRY_MS);
        camera.retry.unref?.();
      }
    });
  }

  function close(camera) {
    camera.stopped = true;
    if (camera.retry) clearTimeout(camera.retry);
    if (camera.idle) clearTimeout(camera.idle);
    const socket = camera.socket;
    camera.socket = null;
    if (socket) socket.destroy();
    for (const waiter of camera.waiters.splice(0)) waiter(null);
  }

  function cameraFor(printerId) {
    const config = deps.config(printerId);
    if (!config) return null;
    const key = `${config.host}|${config.secret}`;
    let camera = cameras.get(printerId);
    if (camera && camera.key !== key) {
      close(camera);
      cameras.delete(printerId);
      camera = undefined;
    }
    if (!camera) {
      camera = {
        printerId,
        key,
        config,
        socket: null,
        frame: null,
        frameAt: 0,
        error: null,
        waiters: [],
        wantedUntil: 0,
        retry: null,
        idle: null,
        stopped: false
      };
      cameras.set(printerId, camera);
    }
    return camera;
  }

  /** Keep the camera open a while longer (someone looks), opening it if needed. */
  function want(camera) {
    camera.wantedUntil = now() + IDLE_MS;
    camera.stopped = false;
    if (!camera.socket && !camera.retry) {
      if (camera.error) camera.error = null;
      open(camera);
    }
    if (camera.idle) clearTimeout(camera.idle);
    camera.idle = setTimeout(() => {
      close(camera);
      cameras.delete(camera.printerId);
    }, IDLE_MS);
    camera.idle.unref?.();
  }

  /**
   * The latest picture: { jpeg, at } once there is one (waiting up to `waitMs` for the first, or for
   * one newer than `newerThan`), else { error }. Null when the printer has no camera here.
   * @param {number} printerId
   * @param {{ waitMs?: number, newerThan?: number }} [options]
   */
  async function frame(printerId, options = {}) {
    const camera = cameraFor(printerId);
    if (!camera) return null;
    want(camera);
    const fresh = camera.frame && camera.frameAt > (options.newerThan || 0) && now() - camera.frameAt < 10000;
    if (!fresh) {
      const waitMs = options.waitMs ?? 8000;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          camera.waiters = camera.waiters.filter((w) => w !== done);
          resolve(null);
        }, waitMs);
        timer.unref?.();
        const done = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        camera.waiters.push(done);
      });
    }
    if (camera.frame && now() - camera.frameAt < 15000) return { jpeg: camera.frame, at: camera.frameAt };
    return { error: camera.error || 'no picture from the camera yet: turn on LAN Mode Liveview on the printer' };
  }

  function stop() {
    for (const camera of cameras.values()) close(camera);
    cameras.clear();
  }

  return { frame, stop, _cameras: cameras };
}

/** @type {ReturnType<typeof createCameras> | null} */
let cameras = null;

/** The server's cameras, for the printers bambu-live.js follows. */
function shared() {
  const made = cameras || createCameras({ config: (printerId) => require('./bambu-live').cameraConfig(printerId) });
  cameras = made;
  return made;
}

function stop() {
  if (cameras) cameras.stop();
  cameras = null;
}

/** GET /api/printers/:id/camera: the latest picture, for anyone signed in (http.js registers it after requireAuth). */
function registerCameraRoutes(app) {
  app.get('/api/printers/:id/camera', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).end();
    try {
      const picture = await shared().frame(id);
      res.set('Cache-Control', 'no-store');
      if (!picture) return res.status(404).type('text/plain').send('This printer has no camera JusttPrint can read');
      if (!picture.jpeg) return res.status(503).type('text/plain').send(picture.error);
      res.type('image/jpeg').send(picture.jpeg);
    } catch (error) {
      res.status(500).type('text/plain').send(error.message);
    }
  });
}

module.exports = { authPacket, readFrames, createCameras, shared, stop, registerCameraRoutes, PORT };
