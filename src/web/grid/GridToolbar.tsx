import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Columns3, Grid3x3, LayoutGrid, List, type LucideIcon } from 'lucide-react';
import { cx } from '../components/Button';
import { columnActions, COLUMNS, getColumnLayout, subscribeColumns } from './columns';
import type { GridView, PreviewTileSize } from './layout';
import { gridViewActions, loadGridView, useGridView } from './view';

const SIZES: [PreviewTileSize, string][] = [['s', 'Small tiles'], ['m', 'Medium tiles'], ['l', 'Large tiles']];
/** The JusttPrint 5 header's view buttons (spec §15): grid cards, the preview wall, the list. */
const ICON_VIEWS: [GridView, string, LucideIcon][] = [['detailed', 'Grid', LayoutGrid], ['preview', 'Wall', Grid3x3], ['list', 'List', List]];

/** Show/Hide columns: a checkbox per column, in the current order. */
function ColumnsPopover({ anchor, close }: { anchor: HTMLElement; close: () => void }) {
  const layout = useSyncExternalStore(subscribeColumns, getColumnLayout);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchor.contains(target)) close();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [anchor, close]);
  const rect = anchor.getBoundingClientRect();
  const labels = new Map(COLUMNS.map((c) => [c.id, c.label]));
  return createPortal(
    <div className="list-view-columns-popover" role="menu" ref={ref}
      style={{ position: 'fixed', left: Math.min(rect.left, window.innerWidth - 260), top: rect.bottom + 6, zIndex: 10050 }}>
      <div className="list-view-columns-popover-hint">Drag column headers to reorder. Drag a column edge to resize.</div>
      {layout.order.map((id) => (
        <label key={id} className="list-view-columns-popover-row">
          <input type="checkbox" data-col-id={id} checked={layout.visibility[id] !== false}
            onChange={(e) => columnActions.setVisible(id, e.target.checked)} />
          <span>{labels.get(id)}</span>
        </label>
      ))}
    </div>,
    document.body
  );
}

/** The view buttons above the grid, the preview wall's tile size, and Show/Hide columns for the list. */
export function GridToolbar() {
  const [slot] = useState(() => document.getElementById('grid-toolbar-slot'));
  const { view, previewSize } = useGridView();
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsButton = useRef<HTMLButtonElement>(null);

  useEffect(() => { loadGridView(); }, []);

  useEffect(() => {
    document.querySelector('.grid-view-selector')?.classList.toggle('preview-view-active', view === 'preview');
    if (view !== 'list') setColumnsOpen(false);
  }, [view]);

  if (!slot) return null;
  const columnsPopover = columnsOpen && columnsButton.current && <ColumnsPopover anchor={columnsButton.current} close={() => setColumnsOpen(false)} />;
  return createPortal(
    <>
      <div className="jp-segmented" role="group" aria-label="View">
        {ICON_VIEWS.map(([id, label, Icon]) => (
          <button key={id} type="button" className={cx('view-button jp-segmented__btn', view === id && 'active')} data-view={id}
            aria-label={label} aria-pressed={view === id} title={label} onClick={() => gridViewActions.setView(id)}>
            <Icon size={18} aria-hidden="true" />
          </button>
        ))}
      </div>
      {view === 'preview' && (
        <div className="jp-segmented jp-segmented--text" id="preview-size-switcher" role="group" aria-label="Tile size">
          {SIZES.map(([size, title]) => (
            <button key={size} type="button" data-preview-size={size} className={cx('jp-segmented__btn', previewSize === size && 'active')}
              title={title} aria-label={title} aria-pressed={previewSize === size} onClick={() => gridViewActions.setPreviewSize(size)}>{size.toUpperCase()}</button>
          ))}
        </div>
      )}
      {view === 'list' && (
        <button type="button" id="list-view-columns-toolbar-btn" className="list-view-columns-toolbar-btn jp-btn jp-btn--secondary jp-btn--md" ref={columnsButton}
          aria-expanded={columnsOpen} title="Show or hide columns. Drag column headers to reorder; drag a column edge to resize."
          onClick={() => setColumnsOpen(!columnsOpen)}>
          <Columns3 size={16} aria-hidden="true" />
          <span>Columns</span>
        </button>
      )}
      {columnsPopover}
    </>,
    slot
  );
}
