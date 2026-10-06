/**
 * The library grid's layout, without the DOM: which records to show (models, ZIP bundles and
 * parent-model groups, expanded or not), how they fall into rows for each view, and where each
 * cell goes.
 */

export type GridView = 'detailed' | 'preview' | 'list';
export type PreviewTileSize = 's' | 'm' | 'l';

/** A model as the grid gets it from the server (only the fields the layout reads are typed). */
export interface GridModel {
  id?: number | string | null;
  filePath: string;
  parentModel?: string | null;
  bundleKey?: string | null;
  bundleLabel?: string | null;
  bundleKind?: string | null;
  [field: string]: unknown;
}

export interface ModelRecord {
  type: 'model';
  key: string;
  model: GridModel;
  /** Set on the children of an expanded group. */
  parentGroupKey?: string;
}

export interface GroupRecord {
  type: 'group';
  key: string;
  groupKind: 'bundle' | 'parentModel';
  groupKey: string;
  groupLabel: string;
  children: GridModel[];
  expanded: boolean;
}

export type DisplayRecord = ModelRecord | GroupRecord;

export interface LayoutRow {
  /** 'group' rows span the width (list view); 'models' rows hold up to `columns` cells. */
  type: 'models' | 'group';
  key: string;
  records: DisplayRecord[];
  height: number;
  top: number;
  bottom: number;
}

export interface Layout {
  rows: LayoutRow[];
  totalHeight: number;
}

// ---- Paths and keys --------------------------------------------------------------------------

/** Compare form of a path: decoded, forward slashes, trimmed, Windows drive letter upper-cased. */
export function normalizePath(path: string | null | undefined): string {
  if (!path) return '';
  let normalized = path;
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Not valid URL encoding: keep it.
  }
  normalized = normalized.replace(/\\/g, '/').trim();
  if (/^[a-zA-Z]:\//.test(normalized)) normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  return normalized;
}

const hasId = (model: GridModel) => model.id != null && model.id !== '';

/** One grid cell per file: the same path listed twice is shown once. */
export function dedupeKey(model: GridModel | null | undefined): string {
  if (!model) return '';
  const path = normalizePath(model.filePath);
  if (path) return `p:${path}`;
  return hasId(model) ? `id:${model.id}` : '';
}

/** Drops repeated paths, keeping the copy that has a database id. */
export function dedupeModels(models: GridModel[]): GridModel[] {
  if (!models || models.length < 2) return models || [];
  const seen = new Map<string, GridModel>();
  const out: GridModel[] = [];
  for (const model of models) {
    if (!model) continue;
    const key = dedupeKey(model);
    if (!key) {
      out.push(model);
      continue;
    }
    const keeper = seen.get(key);
    if (!keeper) {
      seen.set(key, model);
      out.push(model);
    } else if (!hasId(keeper) && hasId(model)) {
      out[out.indexOf(keeper)] = model;
      seen.set(key, model);
    }
  }
  return out;
}

export function renderKey(model: GridModel): string {
  return hasId(model) ? `id:${model.id}` : `path:${model.filePath || ''}`;
}

/** Models inside a ZIP archive are bundled under the archive. */
export function isZipBundleModel(model: GridModel): boolean {
  const kind = String(model.bundleKind || '').trim().toLowerCase();
  if (kind === 'zip') return true;
  if (kind === 'folder') return false;
  const key = String(model.bundleKey || '').trim().toLowerCase();
  if (key.startsWith('zip:')) return true;
  if (key.startsWith('folder:')) return false;
  const filePath = model.filePath || '';
  return filePath.includes('::') && !filePath.startsWith('url::');
}

function zipBundleFields(model: GridModel): { key: string; label: string } {
  const zipPath = (model.filePath || '').split('::')[0];
  const normalized = normalizePath(zipPath).toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  return { key: `zip:${normalized}`, label: parts.length ? parts[parts.length - 1] : zipPath };
}

export function bundleLabel(model: GridModel): string {
  if (!isZipBundleModel(model)) return '';
  return model.bundleLabel ? String(model.bundleLabel).trim() : zipBundleFields(model).label;
}

export function bundleKey(model: GridModel): string {
  if (!isZipBundleModel(model)) return '';
  return model.bundleKey ? String(model.bundleKey).trim().toLowerCase() : zipBundleFields(model).key;
}

export const parentModelLabel = (model: GridModel) => (model.parentModel ? String(model.parentModel).trim() : '');
export const parentModelKey = (label: string) => String(label || '').trim().toLocaleLowerCase();

// ---- Display records -------------------------------------------------------------------------

interface GroupingOptions {
  groupKind: GroupRecord['groupKind'];
  keyPrefix: string;
  expanded: ReadonlySet<string>;
  label: (model: GridModel) => string;
  key: (model: GridModel) => string;
}

/**
 * Collapses models that share a group key into one group record at the first member's place.
 * A "group" of one stays a plain model; an expanded group is followed by its children.
 */
export function groupRecords(records: DisplayRecord[], options: GroupingOptions): DisplayRecord[] {
  type Pending = ModelRecord | { type: 'group'; key: string; groupKey: string; groupLabel: string; children: GridModel[] };
  const grouped: (Pending | DisplayRecord)[] = [];
  const indexByGroup = new Map<string, number>();

  for (const record of records) {
    if (!record || record.type !== 'model') {
      grouped.push(record);
      continue;
    }
    const label = options.label(record.model);
    const rawKey = options.key(record.model);
    if (!label || !rawKey) {
      grouped.push(record);
      continue;
    }
    const groupKey = `${options.keyPrefix}:${rawKey}`;
    const index = indexByGroup.get(groupKey);
    if (index == null) {
      grouped.push(record);
      indexByGroup.set(groupKey, grouped.length - 1);
      continue;
    }
    const existing = grouped[index];
    if (existing.type === 'model') {
      // Labelled as the first member spells it.
      grouped[index] = { type: 'group', key: `group:${groupKey}`, groupKey, groupLabel: options.label(existing.model), children: [existing.model, record.model] };
    } else {
      existing.children.push(record.model);
    }
  }

  const out: DisplayRecord[] = [];
  for (const record of grouped) {
    if (record.type !== 'group' || 'groupKind' in record) {
      out.push(record as DisplayRecord);
      continue;
    }
    if (record.children.length <= 1) {
      const only = record.children[0];
      if (only) out.push({ type: 'model', key: `model:${renderKey(only)}`, model: only });
      continue;
    }
    const expanded = options.expanded.has(record.groupKey);
    out.push({ ...record, groupKind: options.groupKind, expanded });
    if (expanded) {
      for (const model of record.children) {
        out.push({ type: 'model', key: `child:${record.groupKey}:${renderKey(model)}`, model, parentGroupKey: record.groupKey });
      }
    }
  }
  return out;
}

export interface ExpandedGroups {
  bundles: ReadonlySet<string>;
  parentModels: ReadonlySet<string>;
}

/** The grid's records: each file once, ZIP entries bundled, then models grouped by parent model. */
export function buildDisplayRecords(models: GridModel[], expanded: ExpandedGroups): DisplayRecord[] {
  const records: DisplayRecord[] = [];
  const seen = new Set<string>();
  models.forEach((model, index) => {
    const key = dedupeKey(model) || `__row__:${index}`;
    if (seen.has(key)) return;
    seen.add(key);
    records.push({ type: 'model', key: `model:${renderKey(model)}`, model });
  });
  const bundled = groupRecords(records, {
    groupKind: 'bundle', keyPrefix: 'bundle', expanded: expanded.bundles, label: bundleLabel, key: bundleKey
  });
  return groupRecords(bundled, {
    groupKind: 'parentModel', keyPrefix: 'parent', expanded: expanded.parentModels,
    label: parentModelLabel, key: (model) => parentModelKey(parentModelLabel(model))
  });
}

// ---- Rows and cells --------------------------------------------------------------------------

/** Cells per row; in list view a group is its own full-width row. */
export function buildLayoutRows(
  records: DisplayRecord[], columns: number, view: GridView,
  itemHeight: number, groupHeight: number, paddingVertical: number, verticalGap: number
): Layout {
  const rows: Omit<LayoutRow, 'top' | 'bottom'>[] = [];
  let current: DisplayRecord[] = [];
  const flush = () => {
    if (!current.length) return;
    rows.push({ type: 'models', key: `models:${current.map((record) => record.key).join('|')}`, records: current, height: itemHeight });
    current = [];
  };
  for (const record of records) {
    if (record.type === 'group' && view === 'list') {
      flush();
      rows.push({ type: 'group', key: record.key, records: [record], height: groupHeight });
      continue;
    }
    current.push(record);
    if (current.length >= columns) flush();
  }
  flush();

  let top = paddingVertical;
  const placed = rows.map((row, index) => {
    const placedRow = { ...row, top, bottom: top + row.height };
    top = placedRow.bottom + (index < rows.length - 1 ? verticalGap : 0);
    return placedRow;
  });
  const totalHeight = placed.length ? placed[placed.length - 1].bottom + paddingVertical : paddingVertical * 2;
  return { rows: placed, totalHeight };
}

export const PREVIEW_TILE_PX: Record<PreviewTileSize, number> = { s: 140, m: 180, l: 240 };
export const PREVIEW_COLUMNS: Record<PreviewTileSize, number> = { s: 10, m: 6, l: 4 };
export const PREVIEW_COLUMNS_NARROW: Record<PreviewTileSize, number> = { s: 4, m: 3, l: 2 };

export interface ViewOptions {
  view: GridView;
  /** The grid's inner width in pixels. */
  width: number;
  previewSize: PreviewTileSize;
  /** Columns on the phone layout (2 or 3), or 0 on the desktop layout. */
  mobileColumns: number;
}

export interface ViewMetrics {
  columns: number;
  /** Cell size; list cells are full width (cellWidth is then the inner width). */
  cellWidth: number;
  cellHeight: number;
  groupHeight: number;
  paddingVertical: number;
  paddingHorizontal: number;
  verticalGap: number;
  horizontalGap: number;
  /** Extra left offset that centers detailed-view rows. */
  centeredOffset: number;
  /** List view: the column header's height above the first row. */
  headerOffset: number;
}

const DETAILED = { width: 300, height: 490, groupHeight: 450 };

/**
 * JusttPrint 5 model cards on the desktop (spec §16): as many columns of at least minWidth as
 * fit (four at 1536 px beside the details panel), stretched to fill the row. The preview is
 * previewRatio of the card's width; the footer holds the title, designer and badges.
 */
export const CARD = { minWidth: 200, gap: 16, padding: 24, paddingTop: 4, footer: 96, previewRatio: 0.75 };
/** Narrow grids (phones): smaller cards and spacing, so two fit side by side (spec §36). */
export const CARD_COMPACT = { width: 640, minWidth: 150, gap: 12, padding: 12 };

/** Preview height of a card of the given width. */
export const cardPreviewHeight = (cellWidth: number) => Math.round(cellWidth * CARD.previewRatio);
const LIST_ROW = { height: 52, gap: 4, headerOffset: 40 };
const MOBILE_LIST_ROW = { height: 64, gap: 12, headerOffset: 52 };

/** Columns, cell sizes and spacing for a view at a width. */
export function viewMetrics({ view, width, previewSize, mobileColumns }: ViewOptions): ViewMetrics {
  const mobile = mobileColumns > 0;
  if (view === 'list') {
    const row = mobile ? MOBILE_LIST_ROW : LIST_ROW;
    return {
      columns: 1, cellWidth: Math.max(0, width - 40), cellHeight: row.height, groupHeight: row.height,
      paddingVertical: 10, paddingHorizontal: 20, verticalGap: row.gap, horizontalGap: 0, centeredOffset: 0, headerOffset: row.headerOffset
    };
  }
  if (view === 'preview') {
    // Narrow screens get fewer, larger tiles.
    const narrow = width > 0 && width < CARD_COMPACT.width ? PREVIEW_COLUMNS_NARROW : PREVIEW_COLUMNS;
    const columns = mobile ? mobileColumns : narrow[previewSize] || narrow.m;
    const gap = 2;
    const tile = Math.max(1, Math.floor((Math.max(0, width) - (columns - 1) * gap) / columns));
    return {
      columns, cellWidth: tile, cellHeight: tile, groupHeight: tile,
      paddingVertical: 8, paddingHorizontal: 0, verticalGap: gap, horizontalGap: gap, centeredOffset: 0, headerOffset: 0
    };
  }
  if (mobile) {
    const pad = 8;
    const gap = 8;
    const available = Math.max(0, width - pad * 2);
    const cellWidth = Math.max(96, Math.floor((available - gap * (mobileColumns - 1)) / mobileColumns));
    const thumb = Math.max(80, cellWidth - 12);
    return {
      columns: mobileColumns, cellWidth, cellHeight: thumb + 40, groupHeight: DETAILED.groupHeight,
      paddingVertical: 8, paddingHorizontal: pad, verticalGap: gap, horizontalGap: gap, centeredOffset: 0, headerOffset: 0
    };
  }
  const compact = width > 0 && width < CARD_COMPACT.width;
  const { minWidth, gap, padding } = compact ? CARD_COMPACT : CARD;
  const available = Math.max(0, width - padding * 2);
  const columns = Math.max(1, Math.floor((available + gap) / (minWidth + gap)));
  const cellWidth = Math.max(1, Math.floor((available - gap * (columns - 1)) / columns));
  const cellHeight = cardPreviewHeight(cellWidth) + CARD.footer;
  return {
    columns, cellWidth, cellHeight, groupHeight: cellHeight,
    paddingVertical: CARD.paddingTop, paddingHorizontal: padding, verticalGap: gap, horizontalGap: gap, centeredOffset: 0, headerOffset: 0
  };
}

/** Where a cell sits inside the scrolled content. */
export function cellPosition(row: LayoutRow, column: number, metrics: ViewMetrics, view: GridView) {
  if (view === 'list' || row.type === 'group') {
    return { top: row.top, left: metrics.paddingHorizontal, width: metrics.cellWidth, height: row.height };
  }
  const left = column * (metrics.cellWidth + metrics.horizontalGap) + metrics.paddingHorizontal + metrics.centeredOffset;
  return { top: row.top, left, width: metrics.cellWidth, height: row.height };
}

/** Rows that overlap the viewport, plus a buffer of about two rows on each side. */
export function visibleRows(layout: Layout, scrollTop: number, viewportHeight: number, buffer: number): LayoutRow[] {
  return layout.rows.filter((row) => row.bottom >= scrollTop - buffer && row.top <= scrollTop + viewportHeight + buffer);
}

/** Scroll position that centers the first selected model (or the group holding it), or null. */
export function scrollTopForSelection(layout: Layout, viewportHeight: number, isSelected: (filePath: string) => boolean): number | null {
  let modelRow: LayoutRow | null = null;
  let groupRow: LayoutRow | null = null;
  for (const row of layout.rows) {
    for (const record of row.records) {
      if (record.type === 'model' && isSelected(record.model.filePath)) {
        modelRow = row;
        break;
      }
      if (!groupRow && record.type === 'group' && record.children.some((child) => isSelected(child.filePath))) groupRow = row;
    }
    if (modelRow) break;
  }
  const row = modelRow || groupRow;
  if (!row) return null;
  const centered = row.top - Math.max(0, (viewportHeight - row.height) / 2);
  return Math.max(0, Math.min(centered, Math.max(0, layout.totalHeight - viewportHeight)));
}

/**
 * Thumbnail queue priority for a cell: on-screen cells by distance from the top of the view,
 * then cells below the view, then cells above it. Lower runs first.
 */
export function thumbnailPriority(scrollTop: number, viewportHeight: number, itemTop: number, itemHeight: number, column = 0): number {
  const EPS = 1;
  if (itemTop + itemHeight <= scrollTop + EPS) return 3e9 + itemTop + column * 1e-6;
  if (itemTop >= scrollTop + viewportHeight - EPS) return 2e9 + itemTop + column * 1e-6;
  return itemTop - scrollTop + column * 1e-6;
}

/** CSS classes that join the children of an expanded group into one band. */
export function groupBandClasses(records: DisplayRecord[], index: number): string[] {
  const record = records[index];
  const key = record?.type === 'model' ? record.parentGroupKey : undefined;
  if (!key) return [];
  const sameGroup = (other: DisplayRecord | undefined) => other?.type === 'model' && other.parentGroupKey === key;
  const before = sameGroup(records[index - 1]);
  const after = sameGroup(records[index + 1]);
  const position = !before && !after ? 'single' : !before ? 'start' : !after ? 'end' : 'middle';
  return ['parent-model-group-child', `parent-model-group-child-${position}`];
}
