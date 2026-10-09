/**
 * The page's link to the JusttPrint backend, besides the typed calls in api.ts: the WebSocket
 * that brings server events ('refresh-grid', progress, ...) and dialog requests, page events
 * between modules, and action calls for heavy file work (queued, with long timeouts, binary
 * results). main.tsx loads it first; it installs window.electron, the name the page has always
 * used for it (the e2e tests wait for window._electronBridgeReady).
 */
import { showBrowserInput, showBrowserMessage, type InputOptions } from './dialogs';

type Listener = (...args: any[]) => unknown;

declare global {
  interface Window {
    /** Listeners per event channel (the e2e tests call the refresh-grid ones). */
    _electronEventListeners?: Record<string, Listener[]>;
    _electronBridgeReady?: boolean;
    /** slicer-protocol.js: opens justtprint:// links for the Send to Slicer helper. */
    JusttPrintSlicerProtocol?: { launchFromCommand: (command: unknown) => void };
  }
}

const listeners: Record<string, Listener[]> = {};
// Events that arrive before anything listens for them wait for the first listener of their channel.
const pendingEvents: Record<string, unknown[][]> = {};

function dispatch(channel: string, args: unknown[] = []) {
  const list = listeners[channel] || [];
  if (!list.length) {
    const waiting = (pendingEvents[channel] ??= []);
    if (waiting.length < 50) waiting.push(args);
    return;
  }
  for (const listener of [...list]) {
    try {
      listener(...args);
    } catch (error) {
      console.error(`[Bridge] Error in a ${channel} listener:`, error);
    }
  }
}

/** Listen for a server event or a page event. */
export function on(channel: string, callback: Listener) {
  (listeners[channel] ??= []).push(callback);
  const waiting = pendingEvents[channel];
  if (waiting) {
    delete pendingEvents[channel];
    setTimeout(() => waiting.forEach((args) => dispatch(channel, args)), 0);
  }
}

export function off(channel: string, callback: Listener) {
  const list = listeners[channel];
  const index = list ? list.indexOf(callback) : -1;
  if (index !== -1) list.splice(index, 1);
}

// --- The WebSocket -----------------------------------------------------------------------------

let ws: WebSocket | null = null;
let connecting = false;
let reconnectAttempts = 0;
/** The id the server gave this page's socket; sent with API calls so the server can answer this page. */
let clientId: string | null = null;
let markReady: (() => void) | null = null;
let ready = new Promise<void>((resolve) => (markReady = resolve));

export const getClientId = () => clientId;
/** Resolves when the WebSocket is open (again, after a reconnect). */
export const whenConnected = () => ready;

/** The server refuses the WebSocket without a session (expired, or the password changed). */
function redirectToLoginIfLoggedOut() {
  if (!/^https?:$/.test(window.location.protocol)) return;
  fetch('/api/auth/status', { credentials: 'same-origin' })
    .then((response) => response.json())
    .then((status) => {
      if (status && status.authenticated === false)
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    })
    .catch(() => {
      /* server unreachable: keep reconnecting */
    });
}

function answerDialog(dialogId: unknown, kind: string, options: Record<string, any> = {}) {
  const answer =
    kind === 'input'
      ? showBrowserInput(options as InputOptions).then((value) => ({ value }))
      : showBrowserMessage(
          options.title || 'JusttPrint',
          [options.message, options.detail].filter(Boolean).join('\n\n'),
          options.buttons,
          options.cancelId
        ).then((result) => ({ response: result.index }));
  void answer.then((result) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'event', channel: 'server-dialog-response', args: [dialogId, result] }));
  });
}

function connect() {
  if (connecting || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
  connecting = true;
  const socket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`);
  ws = socket;
  socket.onopen = () => {
    if (ws !== socket) return socket.close();
    reconnectAttempts = 0;
    connecting = false;
    markReady?.();
    markReady = null;
  };
  socket.onmessage = (event) => {
    let data: { type?: string; clientId?: string; channel?: string; args?: unknown[] };
    try {
      data = JSON.parse(String(event.data));
    } catch (error) {
      console.error('[Bridge] Unreadable WebSocket message:', error);
      return;
    }
    if (data.type === 'hello') clientId = data.clientId || null;
    else if (data.type === 'event' && data.channel === 'server-dialog-request') {
      const [dialogId, kind, options] = data.args || [];
      answerDialog(dialogId, String(kind), (options as Record<string, any>) || {});
    } else if (data.type === 'event' && data.channel) dispatch(data.channel, data.args);
  };
  socket.onerror = () => {
    if (ws === socket) connecting = false;
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    connecting = false;
    ws = null;
    clientId = null;
    if (!markReady) ready = new Promise<void>((resolve) => (markReady = resolve));
    redirectToLoginIfLoggedOut();
    // Actions use HTTP; keep trying so events and dialogs come back after a restart.
    reconnectAttempts++;
    setTimeout(connect, Math.min(1000 * reconnectAttempts, 30000));
  };
}

/**
 * Raise a page event for its listeners ('open-tag-manager', 'refresh-grid', ...). The answer to
 * a Puter AI request is the one event that goes to the server, which waits for it.
 */
export function send(channel: string, ...args: unknown[]) {
  if (channel === 'puter-ai-chat-response') {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'event', channel, args }));
    else console.warn('[Bridge] Cannot answer the Puter AI request: not connected');
    return;
  }
  setTimeout(() => dispatch(channel, args), 0);
}

// --- Heavy action calls ------------------------------------------------------------------------

/** Browsers open at most 6 connections per server: more calls wait here, before their timeout starts. */
const MAX_IN_FLIGHT = 6;
let inFlight = 0;
const waiting: (() => void)[] = [];
const acquire = () =>
  new Promise<void>((resolve) => {
    if (inFlight < MAX_IN_FLIGHT) {
      inFlight++;
      resolve();
    } else waiting.push(resolve);
  });
const release = () => {
  const next = waiting.shift();
  if (next) next();
  else inFlight = Math.max(0, inFlight - 1);
};

/** File work can take minutes on network shares (parse + JSON); everything else gets 30 s. */
const TIMEOUTS: Record<string, number> = {
  'read-model-file': 180000,
  'extract-model-from-zip': 180000,
  'parse-3mf-preview': 300000,
  get3MFSTL: 180000,
  get3MFImages: 120000,
  getLYSImages: 120000,
  getF3DImages: 120000,
  getChituboxImages: 120000,
  getVoxlImages: 120000,
  'get-file-stats': 120000,
  'calculate-file-hash': 300000,
  'scan-directory': 600000
};

async function readResult(response: Response): Promise<unknown> {
  if (response.status === 401) redirectToLoginIfLoggedOut();
  if (response.ok && (response.headers.get('Content-Type') || '').startsWith('application/octet-stream')) return response.arrayBuffer();
  const text = await response.text();
  let data: { result?: any; error?: string };
  try {
    // Long calls start with keep-alive spaces; JSON.parse skips them.
    data = text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Unexpected response from the JusttPrint backend (HTTP ${response.status})`, { cause: error });
  }
  if (!response.ok || Object.prototype.hasOwnProperty.call(data, 'error')) throw new Error(data.error || `HTTP ${response.status}`);
  const result = data.result;
  // Binary results of long calls arrive as base64.
  if (result && result.__arrayBuffer === true) return Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)).buffer;
  return result;
}

/** Call a server action (POST /api/actions/<name>), queued, with the action's timeout. */
export async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  await acquire();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUTS[channel] || 30000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (clientId) headers['X-JusttPrint-Client'] = clientId;
    const response = await fetch(`/api/actions/${encodeURIComponent(channel)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ args }),
      signal: controller.signal
    });
    return await readResult(response);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`IPC call timeout: ${channel}`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    release();
  }
}

// --- Commands from the server, and window.electron ---------------------------------------------

/** Open the helper link for an open-in-slicer command from the server. */
function launchSlicerCommand(command: unknown) {
  if (!window.JusttPrintSlicerProtocol) {
    alert('Send to Slicer needs slicer-protocol.js, which did not load. Download the file and open it in your slicer.');
    return;
  }
  try {
    window.JusttPrintSlicerProtocol.launchFromCommand(command);
  } catch (error) {
    alert(`Could not send to slicer:\n${error instanceof Error ? error.message : String(error)}`);
  }
}

// Commands the server hands to this browser: files download here, and Send to Slicer opens a
// justtprint:// link for the helper on this computer.
on('execute-client-command', (command: { type?: string; filePath?: string } | null) => {
  if (!command || !command.type) return;
  if (command.type === 'open-file' && command.filePath) {
    const link = document.createElement('a');
    link.href = `/api/download/${encodeURIComponent(command.filePath)}`;
    link.download = '';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    setTimeout(() => link.remove(), 100);
  } else if (['open-in-slicer', 'open-in-orcaslicer', 'slicer-error'].includes(command.type)) {
    launchSlicerCommand(command);
  }
});

const openExternal = (url: string) => {
  window.open(url, '_blank', 'noopener');
  return Promise.resolve(true);
};

/** Actions the page calls by name through window.electron (preview, slicer, metadata). */
const CALLS = {
  getSetting: 'get-setting',
  getSlicers: 'get-slicers',
  openFileInSlicer: 'open-file-in-slicer',
  pull3MFMetadata: 'pull-3mf-metadata',
  readModelFile: 'read-model-file',
  parse3MFPreview: 'parse-3mf-preview',
  cancel3MFPreview: 'cancel-3mf-preview',
  getF3DImages: 'getF3DImages',
  getChituboxImages: 'getChituboxImages',
  getVoxlImages: 'getVoxlImages'
} as const;

window._electronEventListeners = listeners;
window.electron = {
  ...Object.fromEntries(Object.entries(CALLS).map(([method, channel]) => [method, (...args: unknown[]) => invoke(channel, ...args)])),
  on,
  off,
  send,
  invoke,
  whenConnected,
  getClientId,
  isServerMode: () => Promise.resolve(true),
  launchSlicerCommand,
  openExternal,
  showMessage: (title: string, message: string, buttons: string[] = ['OK']) => showBrowserMessage(title, message, buttons).then((result) => result.label),
  showInputDialog: (options?: InputOptions) => showBrowserInput(options || {})
};
window._electronBridgeReady = true;
connect();
