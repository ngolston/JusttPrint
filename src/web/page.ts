/**
 * What the React screens use from the rest of the page (the page globals and window.electron,
 * the server connection in bridge/server.ts), typed in one place.
 */

/** The sidebar filters as the search builds them (src/web/filters/search.ts); passed to the server as-is. */
export type LibraryFilters = Record<string, unknown>;

declare global {
  interface Window {
    electron?: {
      /** In-page message dialog (bridge/dialogs.ts). Resolves to the clicked button's label. */
      showMessage?: (title: string, message: string, buttons?: string[]) => Promise<string>;
      /** In-page text prompt (bridge/dialogs.ts). Resolves to the text, or null when cancelled. */
      showInputDialog?: (options?: { title?: string; message?: string; defaultValue?: string; placeholder?: string }) => Promise<string | null>;
      /** Server events over the page's WebSocket, and page events. */
      on?: (channel: string, callback: (...args: any[]) => unknown) => void;
      off?: (channel: string, callback: (...args: any[]) => unknown) => void;
      /** Raise a page event ('open-tag-manager', 'start-print-roulette', ...) for its handler. */
      send?: (channel: string, ...args: unknown[]) => void;
      /** Open a link in a new tab. */
      openExternal?: (url: string) => Promise<unknown>;
      /** Id of this page's WebSocket, so the server can send events back to this page. */
      getClientId?: () => string | null;
      /** A server action, queued, with long timeouts for file work (binary results as ArrayBuffer). */
      invoke?: (channel: string, ...args: unknown[]) => Promise<any>;
      /** Resolves when the WebSocket is open. */
      whenConnected?: () => Promise<void>;
      /** Plus the actions of bridge/server.ts's call list (getSlicers, parse3MFPreview, ...). */
      [call: string]: unknown;
    };
    /** library/actions.ts: refresh tag pickers, the tag filter, the open model's tags and the grid. */
    refreshTagRelatedUi?: () => Promise<void>;
    /** library/actions.ts: the full refresh after the Tag Manager closed with changes (also redraws model cards). */
    refreshAfterTagManagerClose?: () => Promise<void>;
    /** library/hosts.ts: reload the models and redraw the grid. */
    refreshModelDisplay?: () => Promise<void>;
    /** library/actions.ts: rebuild the sidebar's file type filter from the enabled types. */
    populateFileTypeFilter?: () => Promise<void>;
    /** filters/search.ts: run the current search and filters again. */
    performCombinedSearch?: (options?: { force?: boolean; preserveScroll?: boolean }) => Promise<void>;
    /** library/actions.ts: empty the grid, counts and filters after every model was purged. */
    afterModelsPurged?: () => Promise<void>;
    /** startup/theme.ts: set the accent colors for a UI theme. */
    applyThemeColors?: (theme: string) => void;
    /** library/actions.ts: reload the designer, parent model and license pickers and filters, and the grid. */
    refreshAfterMetadataChange?: () => Promise<void>;
    /** filters/search.ts: the sidebar's current filters, whether any is set, and a short description of them. */
    getCurrentLibraryFilters?: () => LibraryFilters | null;
    libraryFiltersAreActive?: (filters: LibraryFilters | null) => boolean;
    describeLibraryFilters?: (filters: LibraryFilters | null) => string;
    /** library/actions.ts: after De-Dup deleted files, clear the grid selection and reload the grid. */
    refreshAfterDedupDelete?: () => Promise<void>;
    /** startup/start.ts loads them: model color and lighting used for new thumbnails. */
    currentRenderColor?: string;
    currentRenderLighting?: boolean;
  }
}

/** Ask with the page's in-page dialog. Resolves to the clicked button's label. */
export async function showMessage(title: string, message: string, buttons: string[] = ['OK']): Promise<string> {
  if (window.electron?.showMessage) return window.electron.showMessage(title, message, buttons);
  // Without the bridge (should not happen in the app): the browser's own dialogs.
  if (buttons.length < 2) {
    window.alert(`${title}\n\n${message}`);
    return buttons[0];
  }
  return window.confirm(`${title}\n\n${message}`) ? buttons[0] : buttons[buttons.length - 1];
}

/** Ask for a line of text with the page's in-page prompt. Resolves to null when cancelled. */
export async function askText(title: string, message: string, defaultValue = ''): Promise<string | null> {
  if (window.electron?.showInputDialog) return window.electron.showInputDialog({ title, message, defaultValue });
  return window.prompt(`${title}\n\n${message}`, defaultValue);
}

/**
 * Copy text to the clipboard. Over plain http on a LAN address the browser has no Clipboard API
 * (it needs https or localhost), so this falls back to copying from a hidden text field.
 * Resolves to false when neither works.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  Object.assign(field.style, { position: 'fixed', top: '0', left: '0', opacity: '0', pointerEvents: 'none' });
  const previous = document.activeElement as HTMLElement | null;
  document.body.appendChild(field);
  field.focus();
  field.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  field.remove();
  previous?.focus?.();
  return copied;
}

export async function refreshTagRelatedUi(): Promise<void> {
  await window.refreshTagRelatedUi?.();
}

export async function refreshAfterTagManagerClose(): Promise<void> {
  await window.refreshAfterTagManagerClose?.();
}

export async function refreshModelDisplay(): Promise<void> {
  await window.refreshModelDisplay?.();
}

/** Listen to a server event on this page's WebSocket. Returns the function that stops listening. */
export function onServerEvent(channel: string, callback: (...args: any[]) => void): () => void {
  window.electron?.on?.(channel, callback);
  return () => window.electron?.off?.(channel, callback);
}

/** Make a function callable from the rest of the page as window[name] while a screen is mounted. */
export function exposeGlobal<K extends keyof Window>(name: K, fn: Window[K]): () => void {
  const globals = window as unknown as Record<string, unknown>;
  globals[name as string] = fn;
  return () => {
    if (globals[name as string] === fn) delete globals[name as string];
  };
}
