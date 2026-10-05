import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { selection } from '../selection';
import { GroupCard, type GroupCardHost } from './GroupCard';
import { ModelCard, type CardHost } from './ModelCard';
import {
  buildDisplayRecords, buildLayoutRows, cellPosition, groupBandClasses, scrollTopForSelection, thumbnailPriority,
  viewMetrics, visibleRows, type DisplayRecord, type ExpandedGroups, type GridModel, type GridView, type GroupRecord,
  type PreviewTileSize, type ViewMetrics
} from './layout';

/**
 * What the grid needs from renderer.js while the cards are still built there. Each method
 * disappears as its part moves to React.
 */
export interface GridHost extends CardHost, GroupCardHost {
  /** The models on screen: renderer.js edits this array in place, then calls refresh(). */
  models(): GridModel[];
  view(): GridView;
  previewSize(): PreviewTileSize;
  /** Phone layout columns, or 0 on the desktop layout. */
  mobileColumns(): number;
  expanded(): ExpandedGroups;
  createListHeader(): HTMLElement & { updateSortIndicators?: () => void };
  isSelected(filePath: string): boolean;
  /** After cards were added or removed: drop jobs for gone cards, re-sort and run the queue. */
  afterPaint(): void;
  /** Bottom chrome height on phones (the tab bar), so the grid ends above it. */
  bottomChrome(): number;
}

export interface GridShowOptions {
  /** Rebuild every card (the model list, its order or the view changed). */
  rebuild: boolean;
  /** Scroll so the selected model is in view (after switching between detailed and preview). */
  focusSelection?: boolean;
}

declare global {
  interface Window {
    gridHost?: GridHost;
    /** The library grid: show() after the model list changed, refresh() after edits in place. */
    libraryGrid?: { show: (options: GridShowOptions) => void; refresh: () => void };
  }
}

/**
 * True from the grid's render until its last layout effect. Cards are built during that time,
 * and a refresh asked for then (flushSync inside a commit) is deferred instead.
 */
let committing = false;

const groupCardKey = (record: GroupRecord) => `${record.key}#${record.children.length}#${record.expanded ? 1 : 0}`;

/**
 * The library grid in .file-grid: lays the models out for the current view (tested in
 * layout.ts), renders only the rows near the viewport, and keeps them in place while scrolling.
 * renderer.js drives it through window.libraryGrid.
 */
export function LibraryGrid() {
  const [container] = useState(() => document.querySelector<HTMLElement>('.file-grid'));
  const [generation, setGeneration] = useState(0);
  const [tick, setTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [content, setContent] = useState<HTMLElement | null>(null);
  const headerHostRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef(false);
  const host = window.gridHost;

  // window.libraryGrid: updates are flushed at once, so a caller can set scrollTop right after.
  useEffect(() => {
    const update = (change: () => void) => {
      if (committing) queueMicrotask(() => flushSync(change));
      else flushSync(change);
    };
    const api = {
      show: (options: GridShowOptions) => {
        if (options.focusSelection) focusRef.current = true;
        update(() => {
          if (options.rebuild) setGeneration((value) => value + 1);
          else setTick((value) => value + 1);
        });
      },
      refresh: () => update(() => setTick((value) => value + 1))
    };
    window.libraryGrid = api;
    const pending = (window as unknown as { _pendingGridShow?: GridShowOptions })._pendingGridShow;
    if (pending) api.show(pending);
    // Cards draw their highlight from the selection.
    const unsubscribe = selection.subscribe(() => api.refresh());
    return () => {
      unsubscribe();
      if (window.libraryGrid === api) delete window.libraryGrid;
    };
  }, []);

  // Size and scroll position of the grid.
  useEffect(() => {
    if (!container) return undefined;
    let frame = 0;
    const measure = () => setSize({ width: container.clientWidth, height: container.clientHeight });
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrollTop(container.scrollTop);
      });
    };
    measure();
    const resize = new ResizeObserver(() => measure());
    resize.observe(container);
    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      resize.disconnect();
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [container]);

  const view = host?.view() ?? 'detailed';
  const width = size.width || container?.clientWidth || 0;
  const metrics: ViewMetrics = useMemo(
    () => viewMetrics({ view, width, previewSize: host?.previewSize() ?? 'm', mobileColumns: host?.mobileColumns() ?? 0 }),
    // tick/generation: the preview size, phone layout and view are read from renderer.js.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, width, host, tick, generation]
  );

  // Recomputed on every show/refresh: renderer.js edits the model array in place.
  const { records, layout } = useMemo(() => {
    const models = host?.models() ?? [];
    const built = buildDisplayRecords(models, host?.expanded() ?? { bundles: new Set(), parentModels: new Set() });
    return {
      records: built,
      layout: buildLayoutRows(built, metrics.columns, view, metrics.cellHeight, metrics.groupHeight, metrics.paddingVertical, metrics.verticalGap)
    };
  }, [host, metrics, view, tick, generation]);

  // Grid box: fills the window below its top edge; preview wall styles.
  useLayoutEffect(() => {
    if (!container) return;
    container.style.position = 'relative';
    container.style.overflowY = 'auto';
    container.style.overflowX = 'hidden';
    container.style.display = 'block';
    const top = container.getBoundingClientRect().top;
    const bottom = host?.bottomChrome() ?? 0;
    container.style.height = `calc(100vh - ${top}px - ${bottom}px)`;
    container.style.maxHeight = container.style.height;
    container.classList.toggle('preview-wall', view === 'preview');
    const grid = container as HTMLElement & { _previewTilePx?: number };
    if (view === 'preview') {
      container.style.setProperty('--preview-tile', `${metrics.cellWidth}px`);
      grid._previewTilePx = metrics.cellWidth;
    } else {
      container.style.removeProperty('--preview-tile');
      delete grid._previewTilePx;
    }
  }, [container, host, view, metrics, generation]);

  // The list view's column header, built by renderer.js, sits above the rows.
  useLayoutEffect(() => {
    const hostEl = headerHostRef.current;
    if (!hostEl || !host) return undefined;
    if (view !== 'list') return undefined;
    const header = host.createListHeader();
    hostEl.appendChild(header);
    header.updateSortIndicators?.();
    return () => header.remove();
  }, [host, view, generation]);

  // After switching between detailed and preview, bring the selection into view.
  useLayoutEffect(() => {
    if (!focusRef.current || !container || !host) return;
    focusRef.current = false;
    const target = scrollTopForSelection(layout, container.clientHeight, (path) => host.isSelected(path));
    if (target != null && container.scrollTop !== target) {
      container.scrollTop = target;
      setScrollTop(target);
    }
  }, [container, host, layout]);

  // Start each rebuilt grid at the top unless a caller scrolls it.
  useLayoutEffect(() => {
    if (container) setScrollTop(container.scrollTop);
  }, [container, generation]);

  useLayoutEffect(() => {
    committing = false;
    host?.afterPaint();
  });

  if (!container || !host) return null;
  committing = true;

  const viewportHeight = size.height || container.clientHeight;
  const rowHeight = view === 'preview' ? metrics.cellWidth : metrics.cellHeight;
  const buffer = Math.max(rowHeight, metrics.groupHeight) * 2;
  const shown = visibleRows(layout, scrollTop, viewportHeight, buffer);
  const indexByKey = new Map(records.map((record, index) => [record.key, index]));

  const cells = content ? shown.flatMap((row) => row.records.map((record, column) => {
    const index = indexByKey.get(record.key) ?? -1;
    const position = cellPosition(row, column, metrics, view);
    const priority = thumbnailPriority(scrollTop, viewportHeight, metrics.headerOffset + row.top, rowHeight, column);
    if (record.type === 'model') {
      return (
        <ModelCard key={`${generation}:${view}:${record.key}`} host={host} model={record.model} view={view} layoutKey={record.key}
          index={index} parentGroupKey={record.parentGroupKey} bandClasses={groupBandClasses(records, index)} position={position}
          fixedHeight={view === 'preview' || (view === 'detailed' && metrics.columns > 0 && host.mobileColumns() > 0)} priority={priority} />
      );
    }
    return (
      <GroupCard key={`${generation}:${view}:${groupCardKey(record)}`} host={host} record={record} view={view} index={index}
        position={position} fixedHeight={view === 'preview' || (view === 'detailed' && host.mobileColumns() > 0)} />
    );
  })) : null;

  return createPortal(
    <>
      <div ref={headerHostRef} className="list-view-header-host" style={{ display: 'contents' }} />
      <div className="virtual-spacer" style={{ width: '100%', position: 'relative', height: layout.totalHeight }} />
      <div ref={setContent} className="virtual-content"
        style={{ position: 'absolute', left: 0, width: '100%', height: '100%', top: view === 'list' ? metrics.headerOffset : 0, pointerEvents: 'none' }}>
        {cells}
      </div>
    </>,
    container
  );
}
