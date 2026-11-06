'use strict';

/**
 * A fake Bambu Lab printer for the end-to-end checks: MQTT over TLS with a certificate of its own,
 * as a real printer's LAN mode (src/server/bambu-live.js). It records what JusttPrint sends and
 * sends reports when told.
 */

const tls = require('tls');
const mqtt = require('../../src/server/mqtt-client');

async function startFakeBambu({ host = '127.0.0.1', accessCode, serial }) {
  const selfsigned = require('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'bambu-e2e' }], { days: 1, keySize: 2048 });
  const received = [];
  const sockets = new Set();
  const server = tls.createServer({ key: pems.private, cert: pems.cert }, (socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const read = mqtt.readPackets(buffer);
      buffer = Buffer.from(read.rest);
      for (const { type, body } of read.packets) {
        if (type === mqtt.CONNECT) {
          const strings = [];
          for (let at = 10; at < body.length;) {
            const length = body.readUInt16BE(at);
            strings.push(body.subarray(at + 2, at + 2 + length).toString());
            at += 2 + length;
          }
          received.push({ type: 'connect', username: strings[1], password: strings[2] });
          socket.write(mqtt.packet(mqtt.CONNACK, 0, Buffer.from([0, strings[2] === accessCode ? 0 : 5])));
        } else if (type === mqtt.SUBSCRIBE) {
          const length = body.readUInt16BE(2);
          received.push({ type: 'subscribe', topic: body.subarray(4, 4 + length).toString() });
          socket.write(mqtt.packet(mqtt.SUBACK, 0, Buffer.concat([body.subarray(0, 2), Buffer.from([0])])));
        } else if (type === mqtt.PUBLISH) {
          const length = body.readUInt16BE(0);
          let payload = null;
          try {
            payload = JSON.parse(body.subarray(2 + length).toString());
          } catch (_) {
            /* not JSON */
          }
          received.push({ type: 'publish', topic: body.subarray(2, 2 + length).toString(), payload });
        } else if (type === mqtt.PINGREQ) {
          socket.write(mqtt.packet(mqtt.PINGRESP, 0, Buffer.alloc(0)));
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  return {
    port: server.address().port,
    received,
    connected: () => sockets.size > 0,
    report(print) {
      const payload = mqtt.packet(mqtt.PUBLISH, 0, Buffer.concat([mqtt.text(`device/${serial}/report`), Buffer.from(JSON.stringify({ print }))]));
      for (const socket of sockets) socket.write(payload);
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  };
}

/** A fake P1 camera on `port`: checks the sign-in packet, then sends `jpeg` once a second. */
async function startFakeCamera({ host = '127.0.0.1', port, accessCode, jpeg }) {
  const selfsigned = require('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'bambu-e2e-camera' }], { days: 1, keySize: 2048 });
  const sockets = new Set();
  const signIns = [];
  const server = tls.createServer({ key: pems.private, cert: pems.cert }, (socket) => {
    sockets.add(socket);
    let timer = null;
    socket.once('data', (auth) => {
      const code = auth.subarray(48, 80).toString('ascii').replace(/\0+$/, '');
      signIns.push({ user: auth.subarray(16, 48).toString('ascii').replace(/\0+$/, ''), ok: code === accessCode });
      if (code !== accessCode) return socket.destroy();
      const send = () => {
        const header = Buffer.alloc(16);
        header.writeUInt32LE(jpeg.length, 0);
        socket.write(Buffer.concat([header, jpeg]));
      };
      send();
      timer = setInterval(send, 1000);
    });
    socket.on('close', () => {
      if (timer) clearInterval(timer);
      sockets.delete(socket);
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    signIns,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  };
}

/**
 * A fake printer's storage (src/server/bambu-ftps.js): FTP over TLS from the first byte, user
 * bblp and the access code, a passive data connection that turns TLS after STOR, as a Bambu
 * printer's. Keeps what was uploaded: files[name] is a Buffer.
 */
async function startFakeFtps({ host = '127.0.0.1', port = 0, accessCode, noCard = false }) {
  const net = require('net');
  const selfsigned = require('selfsigned');
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'bambu-e2e-ftps' }], { days: 1, keySize: 2048 });
  const files = {};
  const sockets = new Set();
  const server = tls.createServer({ key: pems.private, cert: pems.cert }, (control) => {
    sockets.add(control);
    let user = '';
    let signedIn = false;
    /** @type {import('net').Server | null} */
    let passive = null;
    /** @type {import('net').Socket | null} */
    let pending = null;
    const reply = (line) => control.write(`${line}\r\n`);
    reply('220 Bambu FTP ready');
    let buffer = '';
    control.on('data', (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [verb, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        const command = verb.toUpperCase();
        if (command === 'USER') {
          user = arg;
          reply('331 Password required');
        } else if (command === 'PASS') {
          signedIn = user === 'bblp' && arg === accessCode;
          reply(signedIn ? '230 Logged in' : '530 Login incorrect');
        } else if (!signedIn) reply('530 Please log in');
        else if (command === 'TYPE' || command === 'PBSZ' || command === 'PROT') reply('200 OK');
        else if (command === 'PASV') {
          passive = net.createServer((socket) => {
            pending = socket;
          });
          passive.listen(0, host, () => {
            const p = /** @type {import('net').AddressInfo} */ (passive.address()).port;
            reply(`227 Entering Passive Mode (192,168,9,9,${Math.floor(p / 256)},${p % 256})`);
          });
        } else if (command === 'STOR' || command === 'RETR' || command === 'LIST') {
          const name = arg.replace(/^\//, '');
          // A P1 without a microSD card has nowhere to store it.
          if (command === 'STOR' && noCard) {
            reply('553 Could not create file.');
            if (pending) pending.destroy();
            if (passive) passive.close();
            passive = null;
            pending = null;
            continue;
          }
          if (command === 'RETR' && !files[name]) {
            reply('550 Failed to open file.');
            continue;
          }
          const wait = () => {
            if (!pending) return setTimeout(wait, 10);
            reply('150 Opening data connection');
            const data = new tls.TLSSocket(pending, { isServer: true, key: pems.private, cert: pems.cert });
            const done = () => {
              reply('226 Transfer complete');
              if (passive) passive.close();
              passive = null;
              pending = null;
            };
            data.on('error', () => {});
            if (command === 'STOR') {
              const parts = [];
              data.on('data', (part) => parts.push(part));
              data.on('end', () => {
                files[name] = Buffer.concat(parts);
                data.end();
                done();
              });
            } else {
              data.once('secure', () => {
                const body =
                  command === 'RETR'
                    ? files[name]
                    : Buffer.from(
                        Object.entries(files)
                          .map(([file, bytes]) => `-rw-r--r--    1 root     root     ${String(bytes.length).padStart(8)} Nov 05 12:34 ${file}`)
                          .concat(['drwxr-xr-x    2 root     root            0 Nov 01  2025 timelapse'])
                          .join('\r\n') + '\r\n'
                      );
                data.end(body, done);
              });
            }
          };
          wait();
        } else if (command === 'DELE') {
          const name = arg.replace(/^\//, '');
          if (files[name]) {
            delete files[name];
            reply('250 Delete operation successful.');
          } else reply('550 Delete operation failed.');
        } else if (command === 'QUIT') {
          reply('221 Bye');
          control.end();
        } else reply('502 Not here');
      }
    });
    control.on('close', () => sockets.delete(control));
    control.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    port: /** @type {import('net').AddressInfo} */ (server.address()).port,
    files,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  };
}

module.exports = { startFakeBambu, startFakeCamera, startFakeFtps };
