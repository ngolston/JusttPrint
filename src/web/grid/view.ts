/**
 * How the grid shows models: detailed cards, the preview wall (with its tile size), or the list.
 * Saved as gridView and previewTileSize; with a folder shown, the view is also remembered for
 * that folder (perFolderView) and used again when the folder is picked.
 */
import { useSyncExternalStore } from 'react';
import { settings } from '../api';
import type { GridView, PreviewTileSize } from './layout';

const VIEWS: GridView[] = ['detailed', 'preview', 'list'];
const SIZES: PreviewTileSize[] = ['s', 'm', 'l'];

let state: { view: GridView; previewSize: PreviewTileSize } = { view: 'detailed', previewSize: 'm' };
const listeners = new Set<() => void>();

export function getGridView() {
  return state;
}

function set(next: Partial<typeof state>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
  // The grid lays itself out again for the new view or tile size.
  window.gridHost?.rebuild?.();
}

export function useGridView() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => state);
}

const isView = (v: unknown): v is GridView => VIEWS.includes(v as GridView);

async function folderViews(): Promise<Record<string, GridView>> {
  try {
    const parsed = JSON.parse(await settings.get<string | null>('perFolderView') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export const gridViewActions = {
  async setView(view: GridView) {
    if (view === state.view) return;
    set({ view });
    settings.save('gridView', view).catch((error) => console.warn('save gridView:', error));
    const folder = window.currentDirectoryFilter;
    if (folder && !window.viewingEntireLibrary) {
      const views = await folderViews();
      settings.save('perFolderView', JSON.stringify({ ...views, [folder]: view })).catch(() => {});
      settings.save('lastUsedView', view).catch(() => {});
    }
  },

  setPreviewSize(previewSize: PreviewTileSize) {
    if (previewSize === state.previewSize) return;
    set({ previewSize });
    settings.save('previewTileSize', previewSize).catch((error) => console.warn('save previewTileSize:', error));
  },

  /** A folder was picked: show it in the view saved for it (or the last one used). */
  async applyFolderView(folder: string) {
    if (!folder) return;
    const saved = (await folderViews())[folder];
    const fallback = await settings.get<string | null>('lastUsedView').catch(() => null);
    const view = isView(saved) ? saved : isView(fallback) ? fallback : null;
    if (view && view !== state.view) set({ view });
  }
};

/** The saved view and tile size. */
export async function loadGridView() {
  const [view, size] = await Promise.all([
    settings.get<string | null>('gridView').catch(() => null),
    settings.get<string | null>('previewTileSize').catch(() => null)
  ]);
  set({
    view: view === 'small' ? 'preview' : isView(view) ? view : state.view,
    previewSize: SIZES.includes(size as PreviewTileSize) ? size as PreviewTileSize : state.previewSize
  });
}

declare global {
  interface Window {
    currentDirectoryFilter?: string;
    viewingEntireLibrary?: boolean;
    /** For renderer.js: the current view and tile size. */
    getGridView?: typeof getGridView;
  }
}

if (typeof window !== 'undefined') window.getGridView = getGridView;
