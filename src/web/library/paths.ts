/** How a model's location reads in the grid, the list and the details panel. */
export { formatFileSize } from '../StatsDialog';

/**
 * The folder a model is in (a ZIP entry: the archive's folder). A file at a drive or file
 * system root gives the root ("E:\", "/"), so a removable drive is obvious.
 */
export function parentDirectory(filePath: string | null | undefined): string {
  if (!filePath || filePath.startsWith('url::')) return '';
  const path = filePath.split('::')[0];
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  if (cut < 0) return '';
  const parent = path.slice(0, cut);
  if (/^[A-Za-z]:$/.test(parent)) return parent + (path[cut] || '\\');
  if (parent === '') return path[cut];
  return parent;
}

/** The folder label: the full parent path; for a ZIP entry, "<archive> → <folder inside>". */
export function directoryLabel(filePath: string | null | undefined): string {
  if (!filePath) return '';
  if (filePath.startsWith('url::')) return 'Open in browser';
  if (!filePath.includes('::')) return parentDirectory(filePath);
  const [zipPath, entryPath] = filePath.split('::');
  const zipName = zipPath.split(/[/\\]/).pop() || zipPath;
  const zipParent = parentDirectory(zipPath);
  const entryDir = (entryPath || '').split(/[/\\]/).slice(0, -1).join('/') || 'root';
  const sep = zipPath.includes('\\') ? '\\' : '/';
  const zipLabel = zipParent ? (/[\\/]$/.test(zipParent) ? `${zipParent}${zipName}` : `${zipParent}${sep}${zipName}`) : zipName;
  return `${zipLabel} → ${entryDir}`;
}

/** The folder filter for a model (a ZIP entry: its folder inside the archive, or the archive). */
export function folderFilterFor(filePath: string): string {
  if (filePath.includes('::')) {
    const [zipPath, entryPath] = filePath.split('::');
    const entryParent = entryPath.split(/[/\\]/).slice(0, -1).join('/');
    return entryParent ? `${zipPath}::${entryParent}` : zipPath;
  }
  const cut = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
  return cut > 0 ? filePath.slice(0, cut) : '';
}

/**
 * The breadcrumb for a model's folder: the folders below the library root it is in, each with its
 * whole path (to filter by). A folder outside every root gives just its own name; the root itself, none.
 */
export function folderCrumbs(folder: string, roots: string[]): { label: string; path: string }[] {
  if (!folder) return [];
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  const trim = (dir: string) => dir.replace(/[\\/]+$/, '');
  const norm = (dir: string) => trim(dir).replace(/\\/g, '/').toLowerCase();
  const target = norm(folder);
  const root = roots
    .filter((candidate) => candidate && (target === norm(candidate) || target.startsWith(`${norm(candidate)}/`)))
    .sort((a, b) => norm(b).length - norm(a).length)[0];
  if (!root) {
    const name = trim(folder).split(/[\\/]/).filter(Boolean).pop() || folder;
    return [{ label: name, path: trim(folder) }];
  }
  const crumbs: { label: string; path: string }[] = [];
  let path = trim(folder).slice(0, trim(root).length);
  for (const part of trim(folder).slice(path.length).split(/[\\/]/).filter(Boolean)) {
    path = `${path}${sep}${part}`;
    crumbs.push({ label: part, path });
  }
  return crumbs;
}
