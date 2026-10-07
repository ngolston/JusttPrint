#!/usr/bin/env node
'use strict';

/**
 * JusttPrint server entry point.
 *
 *   node src/server/index.js     (npm start)
 */

// Log levels and timestamps first (JUSTTPRINT_LOG_LEVEL, src/core/log.js).
require('../core/log').install();
require('./app');
