/**
 * The folder tree for the page: the forest, which folders are expanded, the recent picks, and
 * whether the rail (beside the grid) and the popover (under the sidebar's ☰) are open. The
 * folder shown in the grid is the filter store's `directory`.
 */
import { folders as folderApi, settings } from '../api';
import { runSearch } from '../filters/search';
import { filterActions } from '../filters/store';
import { gridViewActions } from '../grid/view';
import {
  directoryOfFile, findNode, findWithAncestors, parseRecent, pushRecent, toDirectoryFilter,
  type FolderForest, type FolderNode, type RecentFolder
} from './tree';

const RECENT_SETTING = 'recentFolderFilters';
const RAIL_SETTING = 'folderRailOpen';

export interface FolderTreeState {
  forest: FolderForest;
  /** Node paths shown expanded. */
  expanded: ReadonlySet<string>;
  recent: RecentFolder[];
  railOpen: boolean;
  popoverOpen: boolean;
  /** A node to scroll into view (Reveal in folders); bumped with `revealSeq`. */
  reveal: string | null;
  revealSeq: number;
}

let state: FolderTreeState = {
  forest: { roots: [] }, expanded: new Set(), recent: [], railOpen: false, popoverOpen: false, reveal: null, revealSeq: 0
};
const listeners = new Set<() => void>();

export function getFolderTreeState(): FolderTreeState {
  return state;
}

export function subscribeFolderTree(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(patch: Partial<FolderTreeState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

async function loadForest() {
  let forest: FolderForest;
  try {
    forest = (await folderApi.tree()) || { roots: [] };
  } catch (error) {
    console.error('Error loading folder tree:', error);
    forest = { roots: [] };
  }
  // The roots start expanded.
  const expanded = state.expanded.size ? state.expanded : new Set(forest.roots.map((root) => root.path));
  set({ forest: { roots: forest.roots || [] }, expanded });
}

/** Show a folder in the grid ('' for every folder), and remember it as a recent pick. */
export async function showFolder(directory: string, node?: FolderNode | RecentFolder | null) {
  filterActions.setDirectory(directory);
  if (directory) {
    const picked = node || findNode(state.forest.roots, directory);
    if (picked) {
      const recent = pushRecent(state.recent, picked);
      set({ recent });
      settings.save(RECENT_SETTING, JSON.stringify(recent)).catch(() => {});
    }
  }
  await gridViewActions.applyFolderView(directory);
  await runSearch();
}

export const folderTreeActions = {
  refresh: loadForest,

  toggleExpanded(path: string) {
    const expanded = new Set(state.expanded);
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    set({ expanded });
  },

  pick(node: FolderNode) {
    set({ popoverOpen: false });
    return showFolder(toDirectoryFilter(node), node);
  },

  async setRailOpen(open: boolean) {
    if (open) await loadForest();
    set({ railOpen: open });
    settings.save(RAIL_SETTING, open ? 'true' : 'false').catch(() => {});
  },

  async setPopoverOpen(open: boolean) {
    if (open) await loadForest();
    set({ popoverOpen: open });
  },

  /** Expand the tree down to a model's folder and scroll to it (in the rail, or else the popover). */
  async reveal(filePath: string) {
    const dir = directoryOfFile(filePath).replace(/::$/, '');
    if (!dir) return;
    await loadForest();
    const found = findWithAncestors(state.forest.roots, dir);
    const expanded = new Set(state.expanded);
    found?.ancestors.forEach((node) => expanded.add(node.path));
    if (found) expanded.add(found.node.path);
    set({ expanded, reveal: found?.node.path ?? dir, revealSeq: state.revealSeq + 1, popoverOpen: !state.railOpen });
  }
};

/** Read the recent picks and the rail setting, and load the tree. */
export async function initFolderTree() {
  try {
    const [recentRaw, railRaw] = await Promise.all([
      settings.get<string | null>(RECENT_SETTING),
      settings.get<string | null>(RAIL_SETTING)
    ]);
    set({ recent: parseRecent(recentRaw), railOpen: railRaw === 'true' });
  } catch (error) {
    console.error('Error loading folder settings:', error);
  }
  await loadForest();
}

declare global {
  interface Window {
    /** The folder tree for renderer.js: reload it after a scan, or show one folder in the grid. */
    folderTree?: { refresh: () => Promise<void>; show: (directory: string) => Promise<void> };
  }
}

if (typeof window !== 'undefined') {
  window.folderTree = { refresh: loadForest, show: (directory) => showFolder(directory) };
}
