import { Fragment, useEffect, useRef } from 'react';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal } from './page';

declare global {
  interface Window {
    openKeyboardShortcuts?: () => void;
  }
}

/** Each shortcut is a list of alternatives; each alternative a list of keys pressed together. */
const SHORTCUTS: [string, string[][]][] = [
  ['Focus search', [['Ctrl', '/']]],
  ['Scan directory', [['Ctrl', 'Shift', 'S']]],
  ['Clear all filters', [['Ctrl', 'Shift', 'C']]],
  ['Print Roulette', [['Ctrl', 'Shift', 'R']]],
  ['Toggle Multi-Edit mode', [['Ctrl', 'E']]],
  ['Select all (filtered) models', [['Ctrl', 'A']]],
  ['Next model (detail view)', [['↓'], ['J']]],
  ['Previous model (detail view)', [['↑'], ['K']]],
  ['Exit Multi-Edit mode', [['Escape']]],
  ['Bold in notes', [['Ctrl', 'B']]],
  ['Italic in notes', [['Ctrl', 'I']]],
  ['Show this shortcuts dialog', [['Ctrl', 'Shift', '?']]]
];

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
        {SHORTCUTS.map(([action, alternatives]) => (
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
