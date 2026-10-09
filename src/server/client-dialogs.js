'use strict';

/**
 * Dialogs the server asks a browser to show: a request goes over that browser's WebSocket
 * and the server waits for the answer. Replaces Electron's native message boxes.
 *
 * Server -> browser: { type: 'event', channel: 'server-dialog-request', args: [id, kind, options] }
 * Browser -> server: { type: 'event', channel: 'server-dialog-response', args: [id, result] }
 *
 * Without a browser to ask (background work, closed tab, no answer in time) a dialog
 * resolves the way Cancel would.
 */

const REQUEST_CHANNEL = 'server-dialog-request';
const RESPONSE_CHANNEL = 'server-dialog-response';
const OPEN = 1; // WebSocket.OPEN

/** Index of the button that means Cancel: cancelId, else the last of several buttons, else 0. */
function cancelResponse(options) {
  const opts = options || {};
  const buttons = Array.isArray(opts.buttons) ? opts.buttons : [];
  if (Number.isInteger(opts.cancelId)) return opts.cancelId;
  return buttons.length > 1 ? buttons.length - 1 : 0;
}

/** Only plain, serializable fields go to the browser. */
function messageOptions(options) {
  const opts = options || {};
  return {
    type: opts.type || 'info',
    title: opts.title ? String(opts.title) : '',
    message: opts.message ? String(opts.message) : '',
    detail: opts.detail ? String(opts.detail) : '',
    buttons: Array.isArray(opts.buttons) && opts.buttons.length ? opts.buttons.map(String) : ['OK'],
    defaultId: Number.isInteger(opts.defaultId) ? opts.defaultId : 0,
    cancelId: cancelResponse(opts)
  };
}

function inputOptions(options) {
  const opts = options || {};
  return {
    title: opts.title ? String(opts.title) : '',
    message: opts.message ? String(opts.message) : '',
    defaultValue: opts.defaultValue ? String(opts.defaultValue) : '',
    placeholder: opts.placeholder ? String(opts.placeholder) : ''
  };
}

/**
 * @param {object} [settings]
 * @param {number} [settings.timeoutMs] How long to wait for an answer (default 10 minutes).
 * @param {{warn: Function}} [settings.logger]
 */
function createClientDialogs({ timeoutMs = 10 * 60 * 1000, logger = console } = {}) {
  const pending = new Map(); // id -> { ws, settle }
  let counter = 0;

  function ask(event, kind, options, fallback) {
    const ws = event && event.wsClient;
    if (!ws || ws.readyState !== OPEN) {
      logger.warn(`[Dialogs] No browser to ask "${options.title || options.message || kind}"; answering Cancel`);
      return Promise.resolve(fallback);
    }
    const id = `dlg_${Date.now()}_${++counter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(fallback), timeoutMs);
      function settle(result) {
        if (!pending.has(id)) return;
        clearTimeout(timer);
        pending.delete(id);
        resolve(result);
      }
      pending.set(id, { ws, settle, fallback });
      try {
        ws.send(JSON.stringify({ type: 'event', channel: REQUEST_CHANNEL, args: [id, kind, options] }));
      } catch (error) {
        logger.warn('[Dialogs] Could not reach the browser:', error.message);
        settle(fallback);
      }
    });
  }

  /** Same result shape as Electron's dialog.showMessageBox: { response, checkboxChecked }. */
  async function messageBox(event, options) {
    const opts = messageOptions(options);
    const fallback = { response: opts.cancelId, checkboxChecked: false };
    const answer = await ask(event, 'message', opts, fallback);
    const response =
      answer && Number.isInteger(answer.response) && answer.response >= 0 && answer.response < opts.buttons.length ? answer.response : opts.cancelId;
    return { response, checkboxChecked: !!(answer && answer.checkboxChecked) };
  }

  /** Text prompt. Resolves to the entered text, or null when cancelled. */
  async function input(event, options) {
    const answer = await ask(event, 'input', inputOptions(options), { value: null });
    return answer && typeof answer.value === 'string' ? answer.value : null;
  }

  /** Called by the WebSocket dispatcher for server-dialog-response messages. */
  function handleResponse(ws, id, result) {
    const entry = pending.get(id);
    if (!entry || entry.ws !== ws) return false; // only the browser that was asked may answer
    entry.settle(result || entry.fallback);
    return true;
  }

  /** A browser disconnected: everything it was asked resolves as Cancel. */
  function dropClient(ws) {
    for (const entry of [...pending.values()]) {
      if (entry.ws === ws) entry.settle(entry.fallback);
    }
  }

  return { messageBox, input, handleResponse, dropClient, pendingCount: () => pending.size };
}

module.exports = { createClientDialogs, cancelResponse, REQUEST_CHANNEL, RESPONSE_CHANNEL };
