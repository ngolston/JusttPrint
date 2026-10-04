'use strict';

// Every module in src/server/ipc must be loaded by src/server/ipc/index.js, or its channels never register.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'server', 'ipc');
const index = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
for (const file of fs.readdirSync(dir)) {
  if (!file.endsWith('.js') || file === 'index.js') continue;
  assert.ok(index.includes(`require('./${file.replace(/\.js$/, '')}')`), `${file} is not loaded by src/server/ipc/index.js`);
}
console.log('ipc index tests passed');
