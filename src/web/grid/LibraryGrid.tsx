import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFoldersAsModels } from '../library/folderMode';
import { createPortal, flushSync } from 'react-dom';
import { selection } from '../selection';
import { GroupCard, type GroupCardHost } from './GroupCard';
import { ModelCard, type CardHost } from './ModelCard';
import { afterGridPaint } from '../thumbnails/cards';
import { applyColumns, loadColumnLayout, subscribeColumns } from './columns';
import { ListHeader } from './ListHeader';
import { useGridView } from './view';
import {
  buildDisplayRecords,
  buildLayoutRows,
  cellPosition,
  groupBandClasses,
  scrollTopForSelection,
  thumbnailPriority,
  viewMetrics,
  visibleRows,
  type ExpandedGroups,
  type GridModel,
  type GroupRecord,
  type ViewMetrics
} from './layout';

/**
 * What the grid needs from the library (src/web/library/hosts.ts).
 */
export interface GridHost extends CardHost, GroupCardHost {
  /** The models on screen: the library edits this array in place, then calls refresh(). */
  models(): GridModel[];
  expanded(): ExpandedGroups;
  /** Lay the shown models out again (the view or tile size changed). */
  rebuild?(): void;
  isSelected(filePath: string): boolean;
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

/**
 * The grid scrolls with the page (10.5): the library header above it scrolls away, all but its
 * pinned bar (tabs, filters and chips), which stays under the top bar. What part of the grid shows
 * is measured from the page: `top` is how far into the grid the view starts (below the header's
 * bottom edge, which is the pinned bar once it sticks; negative while the grid starts lower down),
 * `height` how much of the window it has, down to the phone's tab bar.
 */
function gridView(container: HTMLElement, host: GridHost | undefined): { top: number; height: number } {
  const header = container.previousElementSibling?.getBoundingClientRect();
  const visibleFrom = Math.max(header ? header.bottom : 0, 0);
  const bottom = host?.bottomChrome() ?? 0;
  return { top: visibleFrom - container.getBoundingClientRect().top, height: Math.max(0, window.innerHeight - visibleFrom - bottom) };
}

const groupCardKey = (record: GroupRecord) => `${record.key}#${record.children.length}#${record.expanded ? 1 : 0}`;

/**
 * The library grid in .file-grid: lays the models out for the current view (tested in
 * layout.ts), renders only the rows near the viewport, and keeps them in place while scrolling.
 * The library (library/models.ts) drives it through window.libraryGrid.
 */
export function LibraryGrid() {
  const [container] = useState(() => document.querySelector<HTMLElement>('.file-grid'));
  const [generation, setGeneration] = useState(0);
  const [tick, setTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewHeight, setViewHeight] = useState(() => window.innerHeight);
  const [content, setContent] = useState<HTMLElement | null>(null);
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

  // The grid's width, and the part of it the window shows as the page scrolls (gridView).
  useEffect(() => {
    if (!container) return undefined;
    let frame = 0;
    const place = () => {
      const shown = gridView(container, window.gridHost);
      setScrollTop(shown.top);
      setViewHeight(shown.height);
    };
    const measure = () => {
      setSize({ width: container.clientWidth, height: container.clientHeight });
      place();
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    measure();
    const resize = new ResizeObserver(() => measure());
    resize.observe(container);
    // The header above changes height (banners, filter chips): the grid moves without a scroll.
    const header = container.previousElementSibling;
    if (header) resize.observe(header);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      resize.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [container]);

  const { view, previewSize } = useGridView();
  const width = size.width || container?.clientWidth || 0;
  const metrics: ViewMetrics = useMemo(() => viewMetrics({ view, width, previewSize }), [view, width, previewSize]);

  // Recomputed on every show/refresh: the library edits the model array in place.
  const folders = useFoldersAsModels();
  const { records, layout, indexByKey } = useMemo(() => {
    const models = host?.models() ?? [];
    const built = buildDisplayRecords(models, host?.expanded() ?? { bundles: new Set() }, { folders });
    return {
      records: built,
      indexByKey: new Map(built.map((record, index) => [record.key, index])),
      layout: buildLayoutRows(built, metrics.columns, view, metrics.cellHeight, metrics.groupHeight, metrics.paddingVertical, metrics.verticalGap)
    };
  }, [host, metrics, view, tick, generation, folders]);

  // Grid box: as tall as its rows, scrolled by the page, clear of the phone's tab bar; preview wall styles.
  useLayoutEffect(() => {
    if (!container) return;
    container.style.position = 'relative';
    container.style.overflowY = 'visible';
    container.style.overflowX = 'clip';
    container.style.display = 'block';
    container.style.height = '';
    container.style.maxHeight = '';
    container.style.paddingBottom = `${(host?.bottomChrome() ?? 0) + 16}px`;
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

  // The list view's columns follow their saved layout (also on rows drawn before it loaded).
  useEffect(() => {
    loadColumnLayout();
    return subscribeColumns(() => applyColumns(container));
  }, [container]);

  // After switching between detailed and preview, bring the selection into view.
  useLayoutEffect(() => {
    if (!focusRef.current || !container || !host) return;
    focusRef.current = false;
    const shown = gridView(container, host);
    const target = scrollTopForSelection(layout, shown.height, (path) => host.isSelected(path));
    if (target != null && Math.round(shown.top) !== target) {
      window.scrollBy(0, target - shown.top);
      setScrollTop(target);
    }
  }, [container, host, layout]);

  // When the columns change (the details sidebar opens or closes, the window is resized), the
  // selected card, else the first card in view, stays where it was on screen. The browser's own
  // scroll anchoring is off for the grid (library-frame.css): it held on to whatever element it
  // chose and moved the page.
  const anchorRef = useRef<{ key: string; offset: number; columns: number; view: string } | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!container || !anchor || anchor.view !== view || anchor.columns === metrics.columns) return;
    const row = layout.rows.find((candidate) => candidate.records.some((record) => record.key === anchor.key));
    if (!row) return;
    const shown = gridView(container, host);
    const want = row.top - anchor.offset;
    if (Math.abs(want - shown.top) > 1) {
      window.scrollBy(0, want - shown.top);
      setScrollTop(gridView(container, host).top);
    }
  }, [container, host, layout, metrics.columns, view]);
  useLayoutEffect(() => {
    if (!container || !host) return;
    const top = gridView(container, host).top;
    const inView = layout.rows.filter((row) => row.bottom > top && row.top < top + viewHeight);
    const selected = inView.find((row) => row.records.some((record) => record.type === 'model' && host.isSelected(record.model.filePath)));
    const row = selected || inView[0];
    if (!row) return;
    const record = selected ? row.records.find((r) => r.type === 'model' && host.isSelected(r.model.filePath)) || row.records[0] : row.records[0];
    anchorRef.current = { key: record.key, offset: row.top - top, columns: metrics.columns, view };
  });

  // A rebuilt grid shows the part of it the page is scrolled to.
  useLayoutEffect(() => {
    if (container) setScrollTop(gridView(container, host).top);
  }, [container, host, generation]);

  useLayoutEffect(() => {
    committing = false;
    afterGridPaint();
  });

  if (!container || !host) return null;
  committing = true;

  const viewportHeight = viewHeight;
  const rowHeight = view === 'preview' ? metrics.cellWidth : metrics.cellHeight;
  const buffer = Math.max(rowHeight, metrics.groupHeight) * 2;
  const shown = visibleRows(layout, scrollTop, viewportHeight, buffer);

  const cells = content
    ? shown.flatMap((row) =>
        row.records.map((record, column) => {
          const index = indexByKey.get(record.key) ?? -1;
          const position = cellPosition(row, column, metrics, view);
          const priority = thumbnailPriority(scrollTop, viewportHeight, metrics.headerOffset + row.top, rowHeight, column);
          if (record.type === 'model') {
            return (
              <ModelCard
                key={`${generation}:${view}:${record.key}`}
                host={host}
                model={record.model}
                view={view}
                layoutKey={record.key}
                index={index}
                parentGroupKey={record.parentGroupKey}
                bandClasses={groupBandClasses(records, index)}
                position={position}
                fixedHeight={view === 'preview' || view === 'detailed'}
                priority={priority}
              />
            );
          }
          return (
            <GroupCard
              key={`${generation}:${view}:${groupCardKey(record)}`}
              host={host}
              record={record}
              view={view}
              index={index}
              position={position}
              fixedHeight={view === 'preview' || view === 'detailed'}
            />
          );
        })
      )
    : null;

  return createPortal(
    <>
      {view === 'list' && <ListHeader />}
      <div className="virtual-spacer" style={{ width: '100%', position: 'relative', height: layout.totalHeight }} />
      <div
        ref={setContent}
        className="virtual-content"
        style={{ position: 'absolute', left: 0, width: '100%', height: '100%', top: view === 'list' ? metrics.headerOffset : 0, pointerEvents: 'none' }}
      >
        {cells}
      </div>
    </>,
    container
  );
}
