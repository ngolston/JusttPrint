/**
 * Which details panel is showing (#model-details, #bundle-details or #multi-edit-panel) and
 * the model in #model-details. library/details.ts shows and hides the panels with the `hidden`
 * class and keeps the model's path on #path-tree-container; this watches both.
 */
import { useSyncExternalStore } from 'react';

export type DetailsPanel = 'model' | 'bundle' | 'multi';

export interface DetailsVisibility {
  panel: DetailsPanel | null;
  /** The model shown in #model-details ('' when none). */
  filePath: string;
}

const PANEL_IDS: [DetailsPanel, string][] = [['multi', 'multi-edit-panel'], ['bundle', 'bundle-details'], ['model', 'model-details']];

let state: DetailsVisibility = { panel: null, filePath: '' };
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

const shown = (id: string) => {
  const el = document.getElementById(id);
  return !!el && !el.classList.contains('hidden');
};

function read(): DetailsVisibility {
  const filePath = document.getElementById('path-tree-container')?.getAttribute('data-file-path') || '';
  const panel = PANEL_IDS.find(([, id]) => shown(id))?.[0] ?? null;
  return { panel, filePath };
}

function sync() {
  const next = read();
  if (next.panel === state.panel && next.filePath === state.filePath) return;
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(sync);
    for (const [, id] of PANEL_IDS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
    const pathTree = document.getElementById('path-tree-container');
    if (pathTree) observer.observe(pathTree, { attributes: true, attributeFilter: ['data-file-path'] });
    sync();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      observer?.disconnect();
      observer = null;
    }
  };
}

export function useDetailsVisibility(): DetailsVisibility {
  return useSyncExternalStore(subscribe, () => state);
}

/** A details panel is open (#model-details only counts with a model in it). */
export function detailsAreOpen(v: DetailsVisibility): boolean {
  return v.panel === 'multi' || v.panel === 'bundle' || (v.panel === 'model' && !!v.filePath);
}

/** Hide every details panel (the drawer's close; the selection stays). */
export function hideDetailsPanels() {
  for (const [, id] of PANEL_IDS) document.getElementById(id)?.classList.add('hidden');
}
