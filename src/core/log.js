'use strict';

/**
 * Log levels for the server's console output (docker logs). install() wraps console once at
 * startup: every line gets a time and a level, and lines below JUSTTPRINT_LOG_LEVEL (error, warn,
 * info or debug; default info) are dropped. console.debug is for detail that only helps when
 * tracking down a problem (each query, each file, each click); console.log and console.info are
 * what a user reads in the log; console.warn and console.error stay as they are.
 */

const util = require('util');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LABELS = { error: 'ERROR', warn: 'WARN ', info: 'INFO ', debug: 'DEBUG' };

/** "debug", " INFO " … → a known level name; anything else → "info". */
function parseLevel(value) {
  const name = String(value || '').trim().toLowerCase();
  if (name === 'warning') return 'warn';
  return Object.prototype.hasOwnProperty.call(LEVELS, name) ? name : 'info';
}

const INSTALLED = Symbol.for('justtprint.log.installed');

/**
 * Wrap a console (the real one by default). Safe to call twice: the second call only changes
 * the level. Returns the level in use.
 */
function install(target = console, { level = process.env.JUSTTPRINT_LOG_LEVEL, timestamps = true } = {}) {
  const current = parseLevel(level);
  if (target[INSTALLED]) {
    target[INSTALLED].level = current;
    return current;
  }
  const state = { level: current };
  const original = {
    log: target.log.bind(target),
    error: target.error.bind(target)
  };
  const writer = (name, write) => (...args) => {
    if (LEVELS[name] > LEVELS[state.level]) return;
    const prefix = timestamps ? `${new Date().toISOString()} ${LABELS[name]}` : LABELS[name].trim();
    write(`${prefix} ${util.format(...args)}`);
  };
  target.error = writer('error', original.error);
  target.warn = writer('warn', original.error);
  target.info = writer('info', original.log);
  target.log = writer('info', original.log);
  target.debug = writer('debug', original.log);
  Object.defineProperty(target, INSTALLED, { value: state, enumerable: false });
  return current;
}

module.exports = { install, parseLevel, LEVELS };
