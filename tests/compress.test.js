#!/usr/bin/env node
'use strict';

// Compressed text files, their cache times, and compressed JSON answers (src/server/compress.js).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const express = require('express');
const { cacheControlFor, sendJsonText, sendStatic } = require('../src/server/compress');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-compress-'));
const big = 'console.log("JusttPrint");\n'.repeat(400);
fs.writeFileSync(path.join(dir, 'app-AbCdEf12.js'), big);
fs.writeFileSync(path.join(dir, 'sw.js'), big);
fs.writeFileSync(path.join(dir, 'small.js'), 'x');
fs.writeFileSync(path.join(dir, 'model.stl'), Buffer.alloc(4096, 1));

const app = express();
app.get('/files/:name', (req, res) => {
  const file = path.join(dir, req.params.name);
  if (!sendStatic(req, res, file)) res.sendFile(file);
});
app.get('/json/:size', (req, res) => sendJsonText(req, res, JSON.stringify({ result: 'x'.repeat(Number(req.params.size)) })));

function get(server, url, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: server.address().port, path: url, headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  let failed = false;
  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${name}:`, error.message);
    }
  };
  try {
    await test('fingerprinted files are kept a year; others are checked each time', async () => {
      assert.strictEqual(cacheControlFor('/web-build/app-AbCdEf12.js', {}), 'public, max-age=31536000, immutable');
      assert.strictEqual(cacheControlFor('/web-build/app.css', { v: '9.6.0-x' }), 'public, max-age=31536000, immutable');
      assert.strictEqual(cacheControlFor('/web-build/app.css', {}), 'no-cache');
      assert.strictEqual(cacheControlFor('/sw.js', {}), 'no-cache');
    });
    await test('a text file goes out with Brotli, or gzip, and comes back the same', async () => {
      const br = await get(server, '/files/app-AbCdEf12.js', { 'accept-encoding': 'gzip, deflate, br' });
      assert.strictEqual(br.headers['content-encoding'], 'br');
      assert.ok(br.body.length < big.length / 5, `${br.body.length} bytes`);
      assert.strictEqual(zlib.brotliDecompressSync(br.body).toString(), big);
      assert.match(br.headers['cache-control'], /immutable/);
      const gz = await get(server, '/files/sw.js', { 'accept-encoding': 'gzip' });
      assert.strictEqual(gz.headers['content-encoding'], 'gzip');
      assert.strictEqual(zlib.gunzipSync(gz.body).toString(), big);
      assert.strictEqual(gz.headers['cache-control'], 'no-cache');
      const again = await get(server, '/files/sw.js', { 'accept-encoding': 'gzip', 'if-none-match': gz.headers.etag });
      assert.strictEqual(again.status, 304, 'unchanged: not sent again');
    });
    await test('without Accept-Encoding, small files and model files go out as they are', async () => {
      const plain = await get(server, '/files/app-AbCdEf12.js');
      assert.strictEqual(plain.headers['content-encoding'], undefined);
      assert.strictEqual(plain.body.toString(), big);
      const small = await get(server, '/files/small.js', { 'accept-encoding': 'br' });
      assert.strictEqual(small.headers['content-encoding'], undefined);
      const stl = await get(server, '/files/model.stl', { 'accept-encoding': 'br' });
      assert.strictEqual(stl.headers['content-encoding'], undefined);
      assert.strictEqual(stl.body.length, 4096);
    });
    await test('JSON answers over 1 KB are gzipped; small ones are not', async () => {
      const large = await get(server, '/json/5000', { 'accept-encoding': 'gzip, br' });
      assert.strictEqual(large.headers['content-encoding'], 'gzip');
      assert.strictEqual(JSON.parse(zlib.gunzipSync(large.body).toString()).result.length, 5000);
      const small = await get(server, '/json/10', { 'accept-encoding': 'gzip' });
      assert.strictEqual(small.headers['content-encoding'], undefined);
      assert.strictEqual(JSON.parse(small.body.toString()).result.length, 10);
    });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
})();
