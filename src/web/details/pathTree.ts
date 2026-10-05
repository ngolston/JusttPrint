/**
 * The details panel's path row: one row per folder, then the file. Inside a ZIP the archive is
 * its own row and the folders inside it follow. Each folder row carries the directory filter
 * that shows that folder in the grid (the same form the folder tree and card links use).
 */

export interface PathRow {
  depth: number;
  kind: 'folder' | 'zip' | 'file';
  label: string;
  /** Directory filter for this row (folders and the ZIP itself). */
  directory?: string;
}

/** Each path segment and the index just past it in the original string. */
function segments(path: string): { label: string; end: number }[] {
  return Array.from(path.matchAll(/[^\\/]+/g), (match) => ({ label: match[0], end: (match.index ?? 0) + match[0].length }));
}

export function pathTreeRows(filePath: string | null | undefined): PathRow[] {
  if (!filePath) return [];
  if (filePath.startsWith('url::')) return [{ depth: 0, kind: 'file', label: 'Online model' }];

  const separator = filePath.indexOf('::');
  if (separator < 0) {
    const parts = segments(filePath);
    return parts.map((part, index) => (index === parts.length - 1
      ? { depth: index, kind: 'file', label: part.label }
      : { depth: index, kind: 'folder', label: part.label, directory: filePath.slice(0, part.end) }));
  }

  const zipPath = filePath.slice(0, separator);
  const entryPath = filePath.slice(separator + 2);
  const zipParts = segments(zipPath);
  const rows: PathRow[] = zipParts.map((part, index) => (index === zipParts.length - 1
    ? { depth: index, kind: 'zip', label: part.label, directory: zipPath }
    : { depth: index, kind: 'folder', label: part.label, directory: zipPath.slice(0, part.end) }));
  const entryParts = segments(entryPath);
  entryParts.forEach((part, index) => {
    const depth = zipParts.length + index;
    rows.push(index === entryParts.length - 1
      ? { depth, kind: 'file', label: part.label }
      : { depth, kind: 'folder', label: part.label, directory: `${zipPath}::${entryPath.slice(0, part.end)}` });
  });
  return rows;
}
