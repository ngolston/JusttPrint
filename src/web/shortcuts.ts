/**
 * The app's keyboard shortcuts: which key does what (shortcutFor, tested), and the list the
 * Keyboard Shortcuts dialog shows. KeyboardShortcuts.tsx listens and runs them.
 */

export type ShortcutAction =
  | 'focusSearch' | 'showShortcuts' | 'exitMultiEdit' | 'next' | 'previous'
  | 'scan' | 'clearFilters' | 'roulette' | 'toggleMultiEdit' | 'selectAll' | 'undo';

export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface KeyContext {
  /** Focus is in a text field, select or contenteditable. */
  inInput: boolean;
  /** The single-model details panel is showing. */
  detailsVisible: boolean;
  multiEdit: boolean;
}

/** The action for a key press, or null. Next/previous may still fall through when there is no next model. */
export function shortcutFor(press: KeyPress, ctx: KeyContext): ShortcutAction | null {
  const mod = press.ctrlKey || press.metaKey;
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key;
  if ((key === 'Escape' || key === 'Esc') && ctx.multiEdit) return 'exitMultiEdit';
  // These work from anywhere, also while typing.
  if (mod && key === '/') return 'focusSearch';
  if (mod && press.shiftKey && key === '?') return 'showShortcuts';
  if (ctx.inInput) return null;
  if (ctx.detailsVisible && !mod && (key === 'ArrowDown' || key === 'j')) return 'next';
  if (ctx.detailsVisible && !mod && (key === 'ArrowUp' || key === 'k')) return 'previous';
  if (!mod) return null;
  if (press.shiftKey && key === 's') return 'scan';
  if (press.shiftKey && key === 'c') return 'clearFilters';
  if (press.shiftKey && key === 'r') return 'roulette';
  if (key === 'e') return 'toggleMultiEdit';
  if (key === 'a') return 'selectAll';
  if (key === 'z' && !press.shiftKey) return 'undo';
  return null;
}

/** For the dialog: each shortcut is a list of alternatives; each alternative a list of keys pressed together. */
export const SHORTCUT_HELP: [string, string[][]][] = [
  ['Focus search', [['Ctrl', '/']]],
  ['Scan directory', [['Ctrl', 'Shift', 'S']]],
  ['Clear all filters', [['Ctrl', 'Shift', 'C']]],
  ['Print Roulette', [['Ctrl', 'Shift', 'R']]],
  ['Toggle Multi-Edit mode', [['Ctrl', 'E']]],
  ['Select all (filtered) models', [['Ctrl', 'A']]],
  ['Undo the last metadata or tag edit', [['Ctrl', 'Z']]],
  ['Next model (detail view)', [['↓'], ['J']]],
  ['Previous model (detail view)', [['↑'], ['K']]],
  ['Exit Multi-Edit mode', [['Escape']]],
  ['Bold in notes', [['Ctrl', 'B']]],
  ['Italic in notes', [['Ctrl', 'I']]],
  ['Show this shortcuts dialog', [['Ctrl', 'Shift', '?']]]
];
