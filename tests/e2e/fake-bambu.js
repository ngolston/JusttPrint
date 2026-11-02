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

module.exports = { startFakeBambu };
