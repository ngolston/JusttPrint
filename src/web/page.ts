/**
 * What the React screens use from the rest of the page (renderer.js and server-bridge.js),
 * typed in one place. Each hook disappears once the code behind it moves to React.
 */

declare global {
  interface Window {
    electron?: {
      /** In-page message dialog (server-bridge.js). Resolves to the clicked button's label. */
      showMessage?: (title: string, message: string, buttons?: string[]) => Promise<string>;
    };
    /** renderer.js: refresh tag pickers, the tag filter, the open model's tags and the grid. */
    refreshTagRelatedUi?: () => Promise<void>;
    /** renderer.js: the full refresh after the Tag Manager closed with changes (also redraws model cards). */
    refreshAfterTagManagerClose?: () => Promise<void>;
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

export async function refreshTagRelatedUi(): Promise<void> {
  await window.refreshTagRelatedUi?.();
}

export async function refreshAfterTagManagerClose(): Promise<void> {
  await window.refreshAfterTagManagerClose?.();
}

/** Make a function callable from the rest of the page as window[name] while a screen is mounted. */
export function exposeGlobal<K extends keyof Window>(name: K, fn: Window[K]): () => void {
  const globals = window as unknown as Record<string, unknown>;
  globals[name as string] = fn;
  return () => {
    if (globals[name as string] === fn) delete globals[name as string];
  };
}
