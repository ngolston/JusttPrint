import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { columnActions, COLUMNS, getColumnLayout, subscribeColumns } from './columns';
import type { GridView, PreviewTileSize } from './layout';
import { gridViewActions, loadGridView, useGridView } from './view';

const VIEWS: [GridView, string, string][] = [
  ['detailed', 'Detailed', 'Detailed - Large thumbnails with full details'],
  ['preview', 'Preview', 'Preview - Wall of thumbnails'],
  ['list', 'List', 'List - Horizontal list view']
];
const SIZES: [PreviewTileSize, string][] = [['s', 'Small tiles'], ['m', 'Medium tiles'], ['l', 'Large tiles']];

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
  return createPortal(
    <>
      {VIEWS.map(([id, label, title]) => (
        <button key={id} className={`view-button${view === id ? ' active' : ''}`} data-view={id} title={title}
          onClick={() => gridViewActions.setView(id)}>
          <span>{label}</span>
        </button>
      ))}
      <div className="preview-size-switcher" id="preview-size-switcher" hidden={view !== 'preview'} aria-hidden={view !== 'preview'} title="Tile size">
        {SIZES.map(([size, title]) => (
          <button key={size} type="button" data-preview-size={size} className={previewSize === size ? 'active' : undefined} title={title}
            onClick={(e) => { e.preventDefault(); gridViewActions.setPreviewSize(size); }}>{size.toUpperCase()}</button>
        ))}
      </div>
      <button type="button" id="list-view-columns-toolbar-btn" className="list-view-columns-toolbar-btn" ref={columnsButton} hidden={view !== 'list'}
        title="Show or hide columns. Drag column headers to reorder; drag a column edge to resize."
        onClick={(e) => { e.preventDefault(); setColumnsOpen(!columnsOpen); }}>
        Show/Hide columns
      </button>
      {columnsOpen && columnsButton.current && <ColumnsPopover anchor={columnsButton.current} close={() => setColumnsOpen(false)} />}
    </>,
    slot
  );
}
