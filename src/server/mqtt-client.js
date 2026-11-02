'use strict';

/**
 * The little of MQTT 3.1.1 a Bambu Lab printer's LAN mode needs: connect with a user name and
 * password, subscribe, receive and send messages (QoS 0), keep the line alive. Over TLS by
 * default; printers use a certificate of their own, so it is not checked (`rejectUnauthorized`).
 */

const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');

const CONNECT = 1;
const CONNACK = 2;
const PUBLISH = 3;
const SUBSCRIBE = 8;
const SUBACK = 9;
const PINGREQ = 12;
const PINGRESP = 13;
const DISCONNECT = 14;

const MAX_PACKET = 8 * 1024 * 1024;

const REFUSED = {
  1: 'the printer does not speak this MQTT version',
  2: 'the printer refused the client name',
  3: 'the printer is not taking connections',
  4: 'wrong access code',
  5: 'wrong access code'
};

function encodeLength(length) {
  const bytes = [];
  do {
    let byte = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) byte |= 0x80;
    bytes.push(byte);
  } while (length > 0);
  return Buffer.from(bytes);
}

const text = (value) => {
  const body = Buffer.from(String(value), 'utf8');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length);
  return Buffer.concat([head, body]);
};

const packet = (type, flags, body) => Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body]);

/**
 * Packets in a stream of bytes: [{ type, flags, body }], and what is left over for next time.
 * @param {Buffer} buffer
 */
function readPackets(buffer) {
  const packets = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    let length = 0;
    let multiplier = 1;
    let index = offset + 1;
    let complete = false;
    for (let i = 0; i < 4 && index < buffer.length; i++) {
      const byte = buffer[index++];
      length += (byte & 0x7f) * multiplier;
      multiplier *= 128;
      if (!(byte & 0x80)) {
        complete = true;
        break;
      }
    }
    if (!complete) break;
    if (length > MAX_PACKET) throw new Error('The printer sent a message too large to read');
    if (buffer.length - index < length) break;
    packets.push({ type: buffer[offset] >> 4, flags: buffer[offset] & 0x0f, body: buffer.subarray(index, index + length) });
    offset = index + length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/**
 * One connection. Events: 'connect', 'message' (topic, Buffer), 'close' (Error | null).
 * @param {{ host: string, port?: number, username?: string, password?: string, clientId?: string, keepalive?: number, secure?: boolean, timeoutMs?: number }} options
 */
class MqttClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = { port: 8883, keepalive: 30, secure: true, timeoutMs: 15000, ...options };
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this.closed = false;
    this.nextId = 1;
    this.pingTimer = null;
    this.lastHeard = 0;
  }

  connect() {
    const { host, port, secure, timeoutMs } = this.options;
    const socket = secure ? tls.connect({ host, port, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
    this.socket = socket;
    socket.setTimeout(timeoutMs, () => this.close(new Error('the printer did not answer')));
    socket.on(secure ? 'secureConnect' : 'connect', () => socket.write(this.connectPacket()));
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', (error) => this.close(error));
    socket.on('close', () => this.close(null));
    return this;
  }

  connectPacket() {
    const { username, password, clientId, keepalive } = this.options;
    let flags = 0x02; // clean session
    if (username) flags |= 0x80;
    if (password) flags |= 0x40;
    const keep = Buffer.alloc(2);
    keep.writeUInt16BE(keepalive);
    const parts = [text('MQTT'), Buffer.from([4, flags]), keep, text(clientId || `justtprint-${Math.random().toString(16).slice(2, 10)}`)];
    if (username) parts.push(text(username));
    if (password) parts.push(text(password));
    return packet(CONNECT, 0, Buffer.concat(parts));
  }

  receive(chunk) {
    this.lastHeard = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let read;
    try {
      read = readPackets(this.buffer);
    } catch (error) {
      this.close(error);
      return;
    }
    this.buffer = Buffer.from(read.rest);
    for (const { type, flags, body } of read.packets) {
      if (this.closed) return;
      if (type === CONNACK) {
        const code = body[1];
        if (code !== 0) {
          this.close(new Error(REFUSED[code] || `the printer refused the connection (${code})`));
          return;
        }
        this.connected = true;
        this.socket?.setTimeout(0);
        this.startPing();
        this.emit('connect');
      } else if (type === PUBLISH) {
        const topicLength = body.readUInt16BE(0);
        const topic = body.subarray(2, 2 + topicLength).toString('utf8');
        const qos = (flags >> 1) & 0x03;
        const payload = body.subarray(2 + topicLength + (qos > 0 ? 2 : 0));
        this.emit('message', topic, payload);
      } else if (type === SUBACK || type === PINGRESP) {
        /* nothing to do */
      }
    }
  }

  startPing() {
    const every = Math.max(5, this.options.keepalive) * 1000;
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > every * 2) {
        this.close(new Error('the printer stopped answering'));
        return;
      }
      this.write(packet(PINGREQ, 0, Buffer.alloc(0)));
    }, every);
    this.pingTimer.unref?.();
  }

  write(buffer) {
    if (this.socket && !this.closed) this.socket.write(buffer);
  }

  subscribe(topic) {
    const id = Buffer.alloc(2);
    id.writeUInt16BE(this.nextId++ & 0xffff || 1);
    this.write(packet(SUBSCRIBE, 0x02, Buffer.concat([id, text(topic), Buffer.from([0])])));
  }

  publish(topic, payload) {
    this.write(packet(PUBLISH, 0, Buffer.concat([text(topic), Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')])));
  }

  /** @param {Error | null} [error] */
  close(error = null) {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        if (!error && !socket.destroyed) socket.write(packet(DISCONNECT, 0, Buffer.alloc(0)));
      } catch (_) {
        /* already gone */
      }
      socket.destroy();
    }
    this.emit('close', error);
  }
}

module.exports = { MqttClient, readPackets, packet, text, encodeLength, PUBLISH, CONNECT, CONNACK, SUBSCRIBE, SUBACK, PINGREQ, PINGRESP };
