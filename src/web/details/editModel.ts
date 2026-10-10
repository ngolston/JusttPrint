/**
 * The Edit dialog of the details panel (EditModelDialog.tsx): splitting a model's name for editing,
 * lists typed as text, and what was changed.
 */

/** The model's name split for editing: the part to edit, the extension that stays, and why it cannot be renamed. */
export function nameParts(filePath: string, fileName: string | null | undefined): { stem: string; extension: string; locked: string | null } {
  const name = String(fileName || filePath.split(/[\\/]/).pop() || '');
  if (filePath.startsWith('url::')) return { stem: name, extension: '', locked: null };
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  if (filePath.includes('::')) return { stem, extension, locked: 'Files inside a zip file keep their names.' };
  if (extension.toLowerCase() === '.zip') return { stem, extension, locked: 'Zip files keep their names.' };
  return { stem, extension, locked: null };
}

/** "a, b, c" → ['a', 'b', 'c']: trimmed, no empty or repeated items. */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((item) => item.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
    )
  ];
}

export const listText = (items: string[]) => items.join(', ');

/** The fields whose value differs from the start (texts compared trimmed, lists by their items). */
export function changedFields<T extends object>(start: T, now: T): (keyof T)[] {
  const same = (a: unknown, b: unknown) => {
    if (Array.isArray(a) || Array.isArray(b)) {
      const x = Array.isArray(a) ? a : [];
      const y = Array.isArray(b) ? b : [];
      return x.length === y.length && x.every((item, i) => item === y[i]);
    }
    return String(a ?? '').trim() === String(b ?? '').trim();
  };
  return (Object.keys(now) as (keyof T)[]).filter((key) => !same(start[key], now[key]));
}
