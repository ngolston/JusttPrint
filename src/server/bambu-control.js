'use strict';

/**
 * Printer controls for Bambu Lab printers on the network (the printer page's Live section and
 * Home's Printing now): pause, resume and stop the print, its speed, and the chamber light. Sent
 * over the live connection (bambu-live.js command), as Bambu Studio does in LAN mode.
 */

const live = require('./bambu-live');

/** 1 Silent, 2 Standard, 3 Sport, 4 Ludicrous. */
const SPEEDS = { 1: 'Silent', 2: 'Standard', 3: 'Sport', 4: 'Ludicrous' };

const sequence = () => String(Date.now() % 100000);

/**
 * The command for an action, or an error message when the printer cannot do it now.
 * @param {string} action pause, resume, stop, speed or light
 * @param {any} value the speed (1–4) or the light ('on' / 'off')
 * @param {{ state: string | null }} summary what the printer is doing (bambu-live.js summarize)
 * @returns {{ payload: object } | { error: string }}
 */
function commandFor(action, value, summary) {
  const state = summary && summary.state;
  const printing = state === 'printing' || state === 'paused';
  switch (action) {
    case 'pause':
      return state === 'printing'
        ? { payload: { print: { sequence_id: sequence(), command: 'pause', param: '' } } }
        : { error: 'Nothing is printing to pause' };
    case 'resume':
      return state === 'paused' ? { payload: { print: { sequence_id: sequence(), command: 'resume', param: '' } } } : { error: 'The print is not paused' };
    case 'stop':
      return printing ? { payload: { print: { sequence_id: sequence(), command: 'stop', param: '' } } } : { error: 'Nothing is printing to stop' };
    case 'speed': {
      const level = Number(value);
      if (!SPEEDS[level]) return { error: 'The speed is 1 (Silent) to 4 (Ludicrous)' };
      return printing
        ? { payload: { print: { sequence_id: sequence(), command: 'print_speed', param: String(level) } } }
        : { error: 'The speed changes only while printing' };
    }
    case 'light':
      if (value !== 'on' && value !== 'off') return { error: "The light is 'on' or 'off'" };
      return {
        payload: {
          system: {
            sequence_id: sequence(),
            command: 'ledctrl',
            led_node: 'chamber_light',
            led_mode: value,
            led_on_time: 500,
            led_off_time: 500,
            loop_times: 0,
            interval_time: 0
          }
        }
      };
    default:
      return { error: `Unknown printer control: ${action}` };
  }
}

/**
 * Send a control to a followed, connected Bambu Lab printer.
 * @param {number} printerId
 * @param {string} action
 * @param {any} [value]
 */
function controlPrinter(printerId, action, value) {
  const followed = live.target(printerId);
  if (!followed || !followed.summary.connected) throw new Error('The printer is not connected');
  const made = commandFor(String(action), value, followed.summary);
  if ('error' in made) throw new Error(made.error);
  if (!live.command(printerId, made.payload)) throw new Error('The printer went offline');
  return { ok: true };
}

module.exports = { commandFor, controlPrinter, SPEEDS };
