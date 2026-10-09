/**
 * The folder tree's data: the forest from get-folder-tree (src/core/folder-tree-lib.js) and the
 * plain functions the sidebar's folder controls use on it.
 */

export interface FolderNode {
  path: string;
  label: string;
  tooltip?: string;
  count: number;
  isBundle?: boolean;
  children?: FolderNode[];
}

export interface FolderForest {
  roots: FolderNode[];
}

/** A recently picked folder (saved in the recentFolderFilters setting). */
export interface RecentFolder {
  path: string;
  label: string;
  isBundle?: boolean;
}

export const MAX_RECENT = 8;

export function normalizePath(p: string | null | undefined): string {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

export function pathsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

/** The directory filter for a node: a ZIP on disk filters to its entries (`zip::`). */
export function toDirectoryFilter(node: { path: string; isBundle?: boolean } | null | undefined): string {
  if (!node) return '';
  if (node.isBundle && node.path && !node.path.includes('::')) return `${node.path}::`;
  return node.path;
}

/** The folder a model file is in; for a ZIP entry, its folder inside the archive. */
export function directoryOfFile(filePath: string | null | undefined): string {
  const raw = String(filePath || '');
  if (!raw || raw.startsWith('url::')) return '';
  if (raw.includes('::')) {
    const [zipPath, entryPath] = raw.split('::');
    const entryDir = String(entryPath || '')
      .replace(/\\/g, '/')
      .replace(/\/[^/]+$/, '');
    return entryDir && entryDir !== entryPath ? `${zipPath}::${entryDir}` : `${zipPath}::`;
  }
  const n = raw.replace(/\\/g, '/');
  const i = n.lastIndexOf('/');
  return i > 0 ? n.slice(0, i) : n;
}

/** Does this node stand for the given path or directory filter? */
export function nodeIs(node: FolderNode, path: string): boolean {
  return pathsEqual(node.path, path) || pathsEqual(toDirectoryFilter(node), path);
}

/** The node for a path or directory filter, with its ancestors (outermost first). */
export function findWithAncestors(roots: FolderNode[], path: string): { node: FolderNode; ancestors: FolderNode[] } | null {
  for (const node of roots) {
    if (nodeIs(node, path)) return { node, ancestors: [] };
    const inner = findWithAncestors(node.children || [], path);
    if (inner) return { node: inner.node, ancestors: [node, ...inner.ancestors] };
  }
  return null;
}

export function findNode(roots: FolderNode[], path: string): FolderNode | null {
  return findWithAncestors(roots, path)?.node ?? null;
}

/** The node itself or one of its descendants matches the search text (label or path). */
export function matchesQuery(node: FolderNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (node.label.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)) return true;
  return (node.children || []).some((child) => matchesQuery(child, q));
}

/** A short name for a directory filter that is not in the tree. */
export function folderName(directory: string): string {
  return directory.replace(/::$/, '').split(/[/\\]/).filter(Boolean).pop() || directory;
}

/** The recent list after picking a folder: newest first, no duplicates, at most MAX_RECENT. */
export function pushRecent(list: RecentFolder[], picked: RecentFolder): RecentFolder[] {
  const entry = { path: picked.path, label: picked.label, isBundle: !!picked.isBundle };
  return [entry, ...list.filter((item) => !pathsEqual(item.path, picked.path))].slice(0, MAX_RECENT);
}

export function parseRecent(raw: string | null | undefined): RecentFolder[] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.path === 'string') : [];
  } catch {
    return [];
  }
}
