import { Fragment, useEffect, useRef } from 'react';
import { ModalDialog } from './components/ModalDialog';
import { viewEntireLibrary } from './filters/SidebarActions';
import { exposeGlobal } from './page';
import { scanDirectory } from './scan/scan';
import { SHORTCUT_HELP, shortcutFor, type ShortcutAction } from './shortcuts';

/** What the shortcuts need from renderer.js (multi-edit mode, the details panel, the selection). */
export interface ShortcutHost {
  multiEdit(): boolean;
  exitMultiEdit(): void;
  /** Show the next or previous model in the details panel; false when there is none. */
  navigate(direction: 'next' | 'previous'): boolean;
  /** Ctrl/Cmd+E: from the details panel, start multi-edit with its model; else toggle. */
  toggleMultiEdit(fromDetails: boolean): void;
  /** Select every model the filters show, and open multi-edit. */
  selectAll(): Promise<void>;
}

declare global {
  interface Window {
    openKeyboardShortcuts?: () => void;
    shortcutHost?: ShortcutHost;
  }
}

function inFormControl(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
}

function run(action: ShortcutAction, host: ShortcutHost, detailsVisible: boolean): boolean {
  switch (action) {
    case 'exitMultiEdit': host.exitMultiEdit(); return true;
    case 'focusSearch': {
      const input = document.getElementById('search-filter-input') as HTMLInputElement | null;
      input?.focus();
      input?.select();
      return true;
    }
    case 'showShortcuts': window.openKeyboardShortcuts?.(); return true;
    case 'next': case 'previous': return host.navigate(action);
    case 'scan': scanDirectory(); return true;
    case 'clearFilters': viewEntireLibrary(); return true;
    case 'roulette': window.electron?.send?.('start-print-roulette'); return true;
    case 'toggleMultiEdit': host.toggleMultiEdit(detailsVisible); return true;
    case 'selectAll': host.selectAll(); return true;
  }
}

/** The app's keyboard shortcuts (src/web/shortcuts.ts). */
export function KeyboardShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const host = window.shortcutHost;
      if (!host) return;
      const details = document.getElementById('model-details');
      const detailsVisible = !!details && !details.classList.contains('hidden');
      const action = shortcutFor(event, { inInput: inFormControl(), detailsVisible, multiEdit: host.multiEdit() });
      if (action && run(action, host, detailsVisible)) event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return null;
}

/** Help → Keyboard Shortcuts (also Ctrl+Shift+?). Registers window.openKeyboardShortcuts. */
export function KeyboardShortcutsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => exposeGlobal('openKeyboardShortcuts', () => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }), []);

  return (
    <ModalDialog id="keyboard-shortcuts-dialog" title="Keyboard Shortcuts" dialogRef={dialogRef}
      description={<p className="keyboard-shortcuts-intro">Power-user and accessibility shortcuts. Use <kbd>Ctrl</kbd> on Windows/Linux and <kbd>⌘</kbd> on Mac unless noted.</p>}>
      <div className="keyboard-shortcuts-list">
        {SHORTCUT_HELP.map(([action, alternatives]) => (
          <div key={action} className="shortcut-row">
            <span className="shortcut-action">{action}</span>
            {alternatives.map((keys, index) => (
              <Fragment key={keys.join('+')}>
                {index > 0 && ' or '}
                {keys.map((key, keyIndex) => <Fragment key={key}>{keyIndex > 0 && '+'}<kbd>{key}</kbd></Fragment>)}
              </Fragment>
            ))}
          </div>
        ))}
      </div>
    </ModalDialog>
  );
}
