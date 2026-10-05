/**
 * The list view's columns: which show, how wide, in what order (saved as listViewColumnLayout).
 * Rows and the header mark each column with data-list-col; applyColumns sizes and orders them
 * (CSS order, so React's children stay where React put them).
 */
import { settings } from '../api';

export type ColumnId = 'name' | 'size' | 'dateadded' | 'directory' | 'designer' | 'parentmodel' | 'printed' | 'tags' | 'archive';

export interface ColumnDef {
  id: ColumnId;
  label: string;
  defaultWidth: number;
  min: number;
  max: number;
  /** The sort for this column (`<key>-asc` / `<key>-desc`); none for tags and archive. */
  sortKey?: string;
  center?: boolean;
}

export const COLUMNS: ColumnDef[] = [
  { id: 'name', label: 'Name', defaultWidth: 140, min: 80, max: 800, sortKey: 'name' },
  { id: 'size', label: 'Size', defaultWidth: 75, min: 50, max: 200, sortKey: 'size', center: true },
  { id: 'dateadded', label: 'Date Added', defaultWidth: 110, min: 90, max: 240, sortKey: 'dateadded', center: true },
  { id: 'directory', label: 'Parent Directory', defaultWidth: 150, min: 90, max: 500, sortKey: 'directory' },
  { id: 'designer', label: 'Designer', defaultWidth: 120, min: 60, max: 400, sortKey: 'designer' },
  { id: 'parentmodel', label: 'Parent Model', defaultWidth: 120, min: 60, max: 400, sortKey: 'parentmodel' },
  { id: 'printed', label: 'Print Status', defaultWidth: 140, min: 100, max: 260, sortKey: 'printstatus', center: true },
  { id: 'tags', label: 'Tags', defaultWidth: 180, min: 80, max: 600 },
  { id: 'archive', label: 'Archive', defaultWidth: 100, min: 70, max: 200, center: true }
];

const DEFS = new Map(COLUMNS.map((col) => [col.id, col]));

export interface ColumnLayout {
  visibility: Record<ColumnId, boolean>;
  widths: Record<ColumnId, number>;
  order: ColumnId[];
}

export function defaultLayout(): ColumnLayout {
  return {
    visibility: Object.fromEntries(COLUMNS.map((c) => [c.id, true])) as Record<ColumnId, boolean>,
    widths: Object.fromEntries(COLUMNS.map((c) => [c.id, c.defaultWidth])) as Record<ColumnId, number>,
    order: COLUMNS.map((c) => c.id)
  };
}

/** Known ids once each, in the saved order, then any missing ones. */
export function normalizeOrder(saved: unknown): ColumnId[] {
  const order: ColumnId[] = [];
  if (Array.isArray(saved)) for (const id of saved) if (DEFS.has(id) && !order.includes(id)) order.push(id);
  for (const col of COLUMNS) if (!order.includes(col.id)) order.push(col.id);
  return order;
}

export const clampWidth = (id: ColumnId, width: number) => {
  const def = DEFS.get(id)!;
  return Math.round(Math.max(def.min, Math.min(def.max, width)));
};

/** A saved layout over the defaults: bad values are ignored, widths kept in range. */
export function mergeLayout(saved: unknown): ColumnLayout {
  const base = defaultLayout();
  if (!saved || typeof saved !== 'object') return base;
  const s = saved as { visibility?: Record<string, unknown>; widths?: Record<string, unknown>; order?: unknown };
  for (const col of COLUMNS) {
    if (typeof s.visibility?.[col.id] === 'boolean') base.visibility[col.id] = s.visibility[col.id] as boolean;
    const w = s.widths?.[col.id];
    if (typeof w === 'number' && Number.isFinite(w)) base.widths[col.id] = clampWidth(col.id, w);
  }
  base.order = normalizeOrder(s.order);
  // Before column order was saved, the default 100 px clipped "Print Status".
  if (!Array.isArray(s.order) && s.widths?.printed === 100) base.widths.printed = 130;
  return base;
}

/** The order after dragging `from` before or after `target`; null when nothing changes. */
export function reorder(order: ColumnId[], from: ColumnId, target: ColumnId, place: 'before' | 'after'): ColumnId[] | null {
  if (from === target) return null;
  const next = order.filter((id) => id !== from);
  let index = next.indexOf(target);
  if (index < 0) return null;
  if (place === 'after') index++;
  next.splice(index, 0, from);
  return next.every((id, i) => id === order[i]) ? null : next;
}

let layout = defaultLayout();
const listeners = new Set<() => void>();

export function getColumnLayout(): ColumnLayout {
  return layout;
}

export function subscribeColumns(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(next: ColumnLayout, save: boolean) {
  layout = next;
  listeners.forEach((listener) => listener());
  if (save) {
    settings.save('listViewColumnLayout', JSON.stringify(layout)).catch((error) => console.error('Error saving list view column layout:', error));
  }
}

export const columnActions = {
  setVisible(id: ColumnId, visible: boolean) {
    set({ ...layout, visibility: { ...layout.visibility, [id]: visible } }, true);
  },
  /** While dragging a column edge; `save` on release. */
  setWidth(id: ColumnId, width: number, save: boolean) {
    set({ ...layout, widths: { ...layout.widths, [id]: clampWidth(id, width) } }, save);
  },
  move(from: ColumnId, target: ColumnId, place: 'before' | 'after') {
    const order = reorder(layout.order, from, target, place);
    if (order) set({ ...layout, order }, true);
  }
};

export async function loadColumnLayout() {
  try {
    const raw = await settings.get<string | null>('listViewColumnLayout');
    set(raw ? mergeLayout(JSON.parse(raw)) : defaultLayout(), false);
  } catch (error) {
    console.warn('Error loading list view column layout:', error);
  }
}

/** Size, show or hide, and order every column cell under `root` (a row, the header, or the grid). */
export function applyColumns(root: ParentNode | null | undefined) {
  if (!root) return;
  const rank = new Map(layout.order.map((id, i) => [id, i]));
  root.querySelectorAll<HTMLElement>('[data-list-col]').forEach((el) => {
    const id = el.getAttribute('data-list-col') as ColumnId;
    if (!DEFS.has(id)) return;
    const s = el.style;
    if (layout.visibility[id] === false) {
      s.display = 'none';
      return;
    }
    const w = `${layout.widths[id]}px`;
    Object.assign(s, { display: 'flex', flex: `0 0 ${w}`, flexShrink: '0', width: w, minWidth: w, maxWidth: w, overflow: 'hidden', boxSizing: 'border-box' });
    s.order = String(rank.get(id) ?? 999);
  });
}
