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
