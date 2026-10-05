/**
 * What the React screens use from the rest of the page (renderer.js and server-bridge.js),
 * typed in one place. Each hook disappears once the code behind it moves to React.
 */

/** The sidebar filters as search.js builds them; passed to the server as-is. */
export type LibraryFilters = Record<string, unknown>;

declare global {
  interface Window {
    electron?: {
      /** In-page message dialog (server-bridge.js). Resolves to the clicked button's label. */
      showMessage?: (title: string, message: string, buttons?: string[]) => Promise<string>;
      /** In-page text prompt (server-bridge.js). Resolves to the text, or null when cancelled. */
      showInputDialog?: (options: { title?: string; message?: string; defaultValue?: string; placeholder?: string }) => Promise<string | null>;
      /** Server events over the page's WebSocket (server-bridge.js). */
      on?: (channel: string, callback: (...args: any[]) => void) => void;
      off?: (channel: string, callback: (...args: any[]) => void) => void;
      /** Open a link in a new tab (server-bridge.js). */
      openExternal?: (url: string) => Promise<unknown>;
      /** Id of this page's WebSocket (server-bridge.js), so the server can send events back to this page. */
      getClientId?: () => string | null;
    };
    /** renderer.js: refresh tag pickers, the tag filter, the open model's tags and the grid. */
    refreshTagRelatedUi?: () => Promise<void>;
    /** renderer.js: the full refresh after the Tag Manager closed with changes (also redraws model cards). */
    refreshAfterTagManagerClose?: () => Promise<void>;
    /** filament.js: refresh the filament pickers and the sidebar filament filter. */
    refreshFilamentPickers?: () => Promise<void>;
    /** filament.js: also reload the open model's filaments and the grid. */
    refreshAfterFilamentManagerClose?: () => Promise<void>;
    /** renderer.js: reload the models and redraw the grid. */
    refreshModelDisplay?: () => Promise<void>;
    /** renderer.js: use a new max file size (MB) for the browser's own size checks. */
    applyMaxFileSizeMB?: (mb: number) => void;
    /** renderer.js: rebuild the sidebar's file type filter from the enabled types. */
    populateFileTypeFilter?: () => Promise<void>;
    /** search.js: run the current search and filters again. */
    performCombinedSearch?: (options?: { force?: boolean; preserveScroll?: boolean }) => Promise<void>;
    /** renderer.js: empty the grid, counts and filters after every model was purged. */
    afterModelsPurged?: () => Promise<void>;
    /** renderer.js: set the accent colors for a UI theme. */
    applyThemeColors?: (theme: string) => void;
    /** renderer.js: re-render every thumbnail (after the model color or lighting changed). */
    regenerateAllThumbnails?: () => Promise<void>;
    /** renderer.js: reload the designer, parent model and license pickers and filters, and the grid. */
    refreshAfterMetadataChange?: () => Promise<void>;
    /** renderer.js STL Home scanning: show or hide the sidebar button, scan now, run on a timer. */
    updateScanStlHomeButtonVisibility?: () => Promise<void>;
    performSTLHomeScan?: (dirs: string[]) => Promise<void>;
    startPeriodicSTLHomeScan?: () => Promise<void>;
    stopPeriodicSTLHomeScan?: () => void;
    /** search.js: the sidebar's current filters, whether any is set, and a short description of them. */
    getCurrentLibraryFilters?: () => LibraryFilters | null;
    libraryFiltersAreActive?: (filters: LibraryFilters | null) => boolean;
    describeLibraryFilters?: (filters: LibraryFilters | null) => string;
    /** renderer.js: draw a model to a PNG data URL in this browser (for files without a stored thumbnail). */
    renderModelToPNG?: (filePath: string, container: HTMLElement) => Promise<string | null>;
    /** renderer.js: after De-Dup deleted files, clear the grid selection and reload the grid. */
    refreshAfterDedupDelete?: () => Promise<void>;
    /** renderer.js: model color and lighting used for new thumbnails. */
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

export async function refreshTagRelatedUi(): Promise<void> {
  await window.refreshTagRelatedUi?.();
}

export async function refreshAfterTagManagerClose(): Promise<void> {
  await window.refreshAfterTagManagerClose?.();
}

export async function refreshFilamentPickers(): Promise<void> {
  await window.refreshFilamentPickers?.();
}

export async function refreshAfterFilamentManagerClose(): Promise<void> {
  await window.refreshAfterFilamentManagerClose?.();
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
