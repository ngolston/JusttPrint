/**
 * The Puter.com login. Puter.js never runs on the library page (its Content Security Policy only
 * allows this server's scripts); it runs on puter-signin.html, opened in a popup, which posts the
 * login token back here. The token is kept for the JusttPrint account on the server (so every
 * browser the person logs in with has it), with a copy in this browser, and sent with each Puter AI
 * request.
 *
 * Browsers only allow popups from a click. When a tagging request needs a login and the popup is
 * blocked, PuterSignInDialog asks for that click.
 */

import { callAction } from '../api';

export const SIGNIN_PAGE = 'puter-signin.html';
export const SIGNIN_MESSAGE = 'justtprint-puter-signin';
const TOKEN_KEY = 'justtprint.puterAuthToken';
/** Set once this browser's login has been handed to the account (a login from before 8.8 moves there once). */
const SYNCED_KEY = 'justtprint.puterAuthSynced';
const WINDOW_NAME = 'justtprint-puter-signin';
const WINDOW_FEATURES = 'popup,width=480,height=640';

/** The token from a sign-in popup message, or null for any other message. */
export function tokenFromMessage(data: unknown, origin: string, ownOrigin: string): string | null {
  if (origin !== ownOrigin || !data || typeof data !== 'object') return null;
  const { type, token } = data as { type?: unknown; token?: unknown };
  return type === SIGNIN_MESSAGE && typeof token === 'string' && token.trim() ? token.trim() : null;
}

export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/** Called when the login changes, or a sign-in starts or ends. Returns the unsubscribe. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Keep the login in this browser (and, unless it came from there, for the account). */
function storeToken(token: string | null, { toAccount = true } = {}) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the login lasts until the page closes */
  }
  memoryToken = token;
  changed();
  if (toAccount) void saveToAccount(token);
}
let memoryToken: string | null = null;

async function saveToAccount(token: string | null) {
  try {
    if (await callAction<boolean>('save-puter-login', token)) localStorage.setItem(SYNCED_KEY, '1');
  } catch {
    /* a guest, or offline: the login stays in this browser */
  }
}

/**
 * The account's login, read once when the page loads. The account's wins; without one, a login
 * this browser had before it was kept for the account moves there, and one the account signed
 * out of (on another device) is forgotten here too.
 */
async function loadFromAccount() {
  let token: string | null;
  try {
    token = (await callAction<{ token: string | null }>('get-puter-login')).token;
  } catch {
    return;
  }
  const local = storedToken();
  if (token) {
    if (token !== local) storeToken(token, { toAccount: false });
    try {
      localStorage.setItem(SYNCED_KEY, '1');
    } catch {
      /* private mode */
    }
    return;
  }
  if (!local) return;
  let synced = false;
  try {
    synced = localStorage.getItem(SYNCED_KEY) === '1';
  } catch {
    /* private mode */
  }
  if (synced) storeToken(null, { toAccount: false });
  else await saveToAccount(local);
}
let accountReady = true;
let accountLoaded: Promise<void> = Promise.resolve();
if (typeof window !== 'undefined' && typeof fetch === 'function') {
  accountReady = false;
  accountLoaded = loadFromAccount()
    .catch(() => {})
    .finally(() => {
      accountReady = true;
    });
}

export const currentToken = () => storedToken() || memoryToken;

interface Pending {
  promise: Promise<string>;
  resolve: (token: string) => void;
  reject: (error: Error) => void;
  /** The popup was blocked: PuterSignInDialog is asking for a click. */
  needsClick: boolean;
}
let pending: Pending | null = null;
let watchClosed: ReturnType<typeof setInterval> | null = null;
let signInLimit: ReturnType<typeof setTimeout> | null = null;

/** How long a request waits for a Puter sign-in before it gives up (and says why). */
export const SIGNIN_WAIT_MS = 120_000;

export const signInNeedsClick = () => !!pending?.needsClick;

function settle(token: string | null, error?: Error) {
  const current = pending;
  pending = null;
  if (watchClosed) clearInterval(watchClosed);
  watchClosed = null;
  if (signInLimit) clearTimeout(signInLimit);
  signInLimit = null;
  if (token) storeToken(token);
  else changed();
  if (!current) return;
  if (token) current.resolve(token);
  else current.reject(error || new Error('Puter sign-in was cancelled.'));
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    const token = tokenFromMessage(event.data, event.origin, window.location.origin);
    if (token) settle(token);
  });
}

function startPending(): Pending {
  if (pending) return pending;
  let resolve!: (token: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  pending = { promise, resolve, reject, needsClick: false };
  const current = pending;
  // Nobody signs in (a background run, a page left alone): give up, so the server is not kept waiting.
  signInLimit = setTimeout(() => {
    if (pending === current)
      settle(null, new Error('Not signed in to Puter: the sign-in was not finished within 2 minutes. Sign in under Settings → AI Tagging, then try again.'));
  }, SIGNIN_WAIT_MS);
  return pending;
}

/**
 * Open the sign-in popup. Call it straight from a click so the browser allows it.
 * Returns false when the popup was blocked.
 */
export function openSignInWindow(): boolean {
  const current = startPending();
  const popup = window.open(SIGNIN_PAGE, WINDOW_NAME, WINDOW_FEATURES);
  if (!popup) return false;
  current.needsClick = false;
  changed();
  if (watchClosed) clearInterval(watchClosed);
  // Closing the popup without signing in cancels; give a late message a moment to arrive.
  watchClosed = setInterval(() => {
    if (popup.closed)
      setTimeout(() => {
        if (pending === current) settle(null);
      }, 500);
  }, 500);
  return true;
}

/** A Puter login token: the saved one, or a new sign-in (shared by concurrent requests). */
export function ensureToken(): Promise<string> {
  // The account's login may still be on its way (the page just loaded). Once it is here, no waiting:
  // the sign-in popup must open straight from the click.
  if (!accountReady) return accountLoaded.then(() => ensureToken());
  const token = currentToken();
  if (token) return Promise.resolve(token);
  if (pending) return pending.promise;
  const current = startPending();
  if (!openSignInWindow()) {
    current.needsClick = true;
    changed();
  }
  return current.promise;
}

/** The user closed the "Sign in to Puter" prompt. */
export function cancelSignIn() {
  settle(null);
}

/** Forget a token Puter refused, so the next request signs in again (unless another request already replaced it). */
export function forgetToken(token: string) {
  if (currentToken() === token) storeToken(null);
}

/** Sign out here and in Puter.js (the popup signs out and closes). Call it from a click. */
export function signOut() {
  storeToken(null);
  window.open(`${SIGNIN_PAGE}?signout=1`, WINDOW_NAME, WINDOW_FEATURES);
}
