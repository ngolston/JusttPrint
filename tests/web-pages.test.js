'use strict';

const assert = require('assert');
const { siteUrl } = require('../src/server/ipc/web-pages');

const thangs = ['thangs.com'];
assert.strictEqual(siteUrl('https://thangs.com/designer/x/3d-model/y-123', thangs).hostname, 'thangs.com');
assert.strictEqual(siteUrl('https://www.thangs.com/m/1', thangs).hostname, 'www.thangs.com');

for (const bad of [
  'http://thangs.com/m/1', // not https
  'file:///etc/passwd',
  'https://thangs.com.evil.example/m/1',
  'https://evilthangs.com/m/1',
  'https://127.0.0.1/',
  'https://localhost:5000/api/health',
  'not a url',
  ''
]) {
  assert.throws(() => siteUrl(bad, thangs), `${bad} should be refused`);
}

console.log('web-pages tests passed');
