#!/usr/bin/env node
'use strict';

/**
 * Server mode on plain Node. Every require('electron') gets the stand-in from
 * electron-shim.js, then main.js runs as it does under Electron with --server.
 *
 *   node src/server/index.js
 */

const Module = require('module');

const shimPath = require.resolve('./electron-shim');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveElectron(request, ...rest) {
  if (request === 'electron') return shimPath;
  return resolveFilename.call(this, request, ...rest);
};

if (!process.argv.includes('--server')) process.argv.push('--server');

require('../../main.js');
