/*
 * Home's widgets (pages/HomeDashboard.tsx): which show, in what order and at what size. Each
 * person's own, in the per-person setting homeLayout; Edit Home changes it.
 */

/** Columns × rows on Home's four-column grid (rows are at least 210 px and grow with the content). */
export type WidgetSize = '1x1' | '2x1' | '1x2' | '2x2' | '4x1' | '4x2';

export const SIZE_LABELS: Record<WidgetSize, string> = {
  '1x1': 'Small',
  '2x1': 'Wide',
  '1x2': 'Tall',
  '2x2': 'Large',
  '4x1': 'Full width',
  '4x2': 'Full width, tall'
};

export interface WidgetInfo {
  id: string;
  name: string;
  description: string;
  /** The sizes it can have, the first the one it starts at. */
  sizes: WidgetSize[];
  /** On a new Home (and added to a saved one when it is new in JusttPrint). */
  shown: boolean;
}

export const HOME_WIDGETS: WidgetInfo[] = [
  {
    id: 'library',
    name: 'Your library',
    description: 'Models, printed, in the queue and printers, with a picture.',
    sizes: ['2x2', '4x2', '2x1'],
    shown: true
  },
  {
    id: 'needs-you',
    name: 'Needs you',
    description: 'Queued prints short of filament, maintenance due, nearly empty spools.',
    sizes: ['1x1', '2x1', '1x2'],
    shown: true
  },
  { id: 'spools', name: 'Spools', description: 'The grams on hand and the fullest spools.', sizes: ['1x2', '1x1', '2x2'], shown: true },
  {
    id: 'runs-out',
    name: 'Runs out soon',
    description: 'Spools that run out within 30 days at the rate you use them.',
    sizes: ['1x1', '2x1', '1x2'],
    shown: true
  },
  { id: 'up-next', name: 'Up next', description: 'The first print in the queue and whether the spools cover it.', sizes: ['1x1', '2x1'], shown: true },
  { id: 'printing', name: 'Printing now', description: 'Printers printing now, and models marked Printing.', sizes: ['2x1', '4x1', '2x2'], shown: true },
  { id: 'new', name: 'New in your library', description: 'The newest models, and how many came this week.', sizes: ['2x1', '4x1'], shown: true },
  { id: 'month', name: 'This month', description: 'Prints this month, how many worked, and the filament used.', sizes: ['1x1', '2x1'], shown: true },
  { id: 'printers', name: 'Printers', description: 'Each printer with what is loaded and what is due.', sizes: ['1x1', '2x1', '1x2'], shown: true },
  {
    id: 'camera',
    name: 'Camera',
    description: "A printer's camera, a new picture every couple of seconds (Bambu P1 and A1).",
    sizes: ['2x2', '1x1', '2x1', '4x2'],
    shown: true
  },
  {
    id: 'maintenance',
    name: 'Maintenance due',
    description: 'Printer reminders due soonest, by date or by print hours.',
    sizes: ['1x1', '2x1', '1x2'],
    shown: true
  },
  { id: 'reorder', name: 'Reorder list', description: 'Spools below your low-stock line, with where you bought them.', sizes: ['1x1', '2x1'], shown: true },
  {
    id: 'forgotten',
    name: 'Forgotten model',
    description: 'A model you have never printed, with Another and Queue It.',
    sizes: ['1x1', '2x1', '1x2'],
    shown: true
  },
  { id: 'quick-actions', name: 'Quick actions', description: 'Add Links, Upload, Scan Library and Log a Print.', sizes: ['1x1', '2x1', '4x1'], shown: true },
  { id: 'upload-inbox', name: 'Upload inbox', description: 'Models waiting in the Upload folder, with Organize.', sizes: ['1x1', '2x1'], shown: true },
  { id: 'tidy-up', name: 'Tidy up', description: 'Models without tags, a category, a license or a picture.', sizes: ['1x1', '2x1', '1x2'], shown: true },
  { id: 'duplicates', name: 'Duplicates found', description: 'Sets of identical files, for the Duplicates page.', sizes: ['1x1', '2x1'], shown: true },
  { id: 'spool-of-the-day', name: 'Spool of the day', description: 'A spool you have not used in a while.', sizes: ['2x1', '1x1'], shown: false },
  {
    id: 'color-wall',
    name: 'Color wall',
    description: 'Every color you have, by hue; find the closest to one you need.',
    sizes: ['2x1', '4x1', '2x2'],
    shown: false
  },
  { id: 'material-guide', name: 'Material guide', description: 'Typical settings and how each material prints.', sizes: ['2x1', '4x1', '2x2'], shown: false },
  { id: 'activity', name: 'Recent activity', description: 'What was added, printed and changed lately.', sizes: ['2x1', '1x1', '2x2', '4x1'], shown: true },
  { id: 'kits', name: 'Continue your kits', description: 'Kits with parts still to print.', sizes: ['1x1', '2x1', '1x2'], shown: true },
  {
    id: 'attention',
    name: 'Needs attention',
    description: "The library's loose ends: backups, duplicates, missing tags and more.",
    sizes: ['1x1', '2x1', '1x2'],
    shown: true
  },
  { id: 'recent', name: 'Recently added', description: 'The eight models added last.', sizes: ['4x1', '2x1', '2x2'], shown: true },
  { id: 'favorites', name: 'Favorites', description: 'Models you marked with a heart.', sizes: ['4x1', '2x1'], shown: true },
  { id: 'collections', name: 'Collections', description: 'Collections changed most recently.', sizes: ['4x1', '2x1'], shown: true },
  { id: 'categories', name: 'Browse by category', description: 'The categories your models are in.', sizes: ['4x1', '2x1'], shown: true }
];

const BY_ID = new Map(HOME_WIDGETS.map((widget) => [widget.id, widget]));
export const widgetInfo = (id: string) => BY_ID.get(id);

export interface LayoutItem {
  id: string;
  size: WidgetSize;
  /** The Camera's printer, when one was chosen. */
  printerId?: number;
}

export interface HomeLayout {
  items: LayoutItem[];
  /** Every widget the layout was made knowing about: one new in JusttPrint is added when shown by default. */
  known: string[];
}

export function defaultLayout(): HomeLayout {
  return { items: HOME_WIDGETS.filter((w) => w.shown).map((w) => ({ id: w.id, size: w.sizes[0] })), known: HOME_WIDGETS.map((w) => w.id) };
}

/** The saved layout, with widgets it does not know dropped, sizes it cannot have reset, and new widgets added. */
export function parseLayout(raw: string | null | undefined): HomeLayout {
  let value: { items?: unknown; known?: unknown } | null = null;
  try {
    value = JSON.parse(raw || 'null');
  } catch {
    value = null;
  }
  if (!value || !Array.isArray(value.items)) return defaultLayout();
  const seen = new Set<string>();
  const items: LayoutItem[] = [];
  for (const entry of value.items as unknown[]) {
    const item = entry as Partial<LayoutItem> | null;
    const info = item && typeof item.id === 'string' ? BY_ID.get(item.id) : undefined;
    if (!info || seen.has(info.id)) continue;
    seen.add(info.id);
    const size = info.sizes.includes(item!.size as WidgetSize) ? (item!.size as WidgetSize) : info.sizes[0];
    items.push({ id: info.id, size, ...(Number(item!.printerId) > 0 ? { printerId: Number(item!.printerId) } : {}) });
  }
  const known = new Set(Array.isArray(value.known) ? (value.known as unknown[]).map(String) : HOME_WIDGETS.map((w) => w.id));
  for (const widget of HOME_WIDGETS) if (!known.has(widget.id) && widget.shown && !seen.has(widget.id)) items.push({ id: widget.id, size: widget.sizes[0] });
  return { items, known: HOME_WIDGETS.map((w) => w.id) };
}

export const serializeLayout = (layout: HomeLayout) => JSON.stringify(layout);

/** Move the widget at `from` to `to` (both indexes in the list before the move). */
export function moveItem(layout: HomeLayout, from: number, to: number): HomeLayout {
  if (from === to || from < 0 || from >= layout.items.length) return layout;
  const items = layout.items.slice();
  const [item] = items.splice(from, 1);
  items.splice(Math.max(0, Math.min(items.length, to)), 0, item);
  return { ...layout, items };
}

/** Move `id` to where `target` is now (dragged onto it): before it going up, after it going down. */
export function dropOn(layout: HomeLayout, id: string, target: string): HomeLayout {
  const from = layout.items.findIndex((item) => item.id === id);
  const to = layout.items.findIndex((item) => item.id === target);
  return from < 0 || to < 0 ? layout : moveItem(layout, from, to);
}

export const updateItem = (layout: HomeLayout, id: string, changes: Partial<LayoutItem>): HomeLayout => ({
  ...layout,
  items: layout.items.map((item) => (item.id === id ? { ...item, ...changes } : item))
});

export const removeItem = (layout: HomeLayout, id: string): HomeLayout => ({ ...layout, items: layout.items.filter((item) => item.id !== id) });

export function addItem(layout: HomeLayout, id: string): HomeLayout {
  const info = BY_ID.get(id);
  if (!info || layout.items.some((item) => item.id === id)) return layout;
  return { ...layout, items: [...layout.items, { id, size: info.sizes[0] }] };
}

/** The widgets not on Home, to add. */
export const hiddenWidgets = (layout: HomeLayout) => HOME_WIDGETS.filter((widget) => !layout.items.some((item) => item.id === widget.id));

/** The grid span of a size: [columns, rows]. */
export function spanOf(size: WidgetSize): [number, number] {
  const [cols, rows] = size.split('x').map(Number);
  return [cols, rows];
}
