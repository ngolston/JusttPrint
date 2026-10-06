import { useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react';
import { runSearch } from '../filters/search';
import { filterActions, getFilterState, subscribeFilters } from '../filters/store';
import { COLUMNS, applyColumns, columnActions, getColumnLayout, subscribeColumns, type ColumnDef, type ColumnId } from './columns';

const ICONS: Partial<Record<ColumnId, { d: string; fill: string }>> = {
  directory: { fill: '#aaa', d: 'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z' },
  designer: { fill: '#a855f7', d: 'm352-522 86-87-56-57-44 44-56-56 43-44-45-45-87 87 159 158Zm328 329 87-87-45-45-44 43-56-56 43-44-57-56-86 86 158 159Zm24-567 57 57-57-57ZM290-120H120v-170l175-175L80-680l200-200 216 216 151-152q12-12 27-18t31-6q16 0 31 6t27 18l53 54q12 12 18 27t6 31q0 16-6 30.5T816-647L665-495l215 215L680-80 465-295 290-120Zm-90-80h56l392-391-57-57-391 392v56Zm420-419-29-29 57 57-28-28Z' },
  tags: { fill: '#aaa', d: 'M240-120q-33 0-56.5-23.5T160-200v-480q0-33 23.5-56.5T240-760h120l80 80h320q33 0 56.5 23.5T820-600v400q0 33-23.5 56.5T740-120H240Zm0-80h500v-400H447l-80-80H240v480Zm0 0v-480 480Zm280-240q17 0 28.5-11.5T560-480q0-17-11.5-28.5T520-520q-17 0-28.5 11.5T480-480q0 17 11.5 28.5T520-440Zm-160 0q17 0 28.5-11.5T400-480q0-17-11.5-28.5T360-520q-17 0-28.5 11.5T320-480q0 17 11.5 28.5T360-440Zm320 0q17 0 28.5-11.5T720-480q0-17-11.5-28.5T680-520q-17 0-28.5 11.5T640-480q0 17 11.5 28.5T680-440ZM520-280q17 0 28.5-11.5T560-320q0-17-11.5-28.5T520-360q-17 0-28.5 11.5T480-320q0 17 11.5 28.5T520-280Zm-160 0q17 0 28.5-11.5T400-320q0-17-11.5-28.5T360-360q-17 0-28.5 11.5T320-320q0 17 11.5 28.5T360-280Zm320 0q17 0 28.5-11.5T720-320q0-17-11.5-28.5T680-360q-17 0-28.5 11.5T640-320q0 17 11.5 28.5T680-280Z' },
  archive: { fill: '#aaa', d: 'M640-480v-80h80v80h-80Zm0 80h-80v-80h80v80Zm0 80v-80h80v80h-80ZM447-640l-80-80H160v480h400v-80h80v80h160v-400H640v80h-80v-80H447ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80v-480 480Z' }
};

function Icon({ id }: { id: ColumnId }) {
  const icon = ICONS[id];
  if (!icon) return null;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" height="16px" width="16px" viewBox="0 -960 960 960" fill={icon.fill} style={{ flexShrink: 0 }} aria-hidden="true">
      <path d={icon.d} />
    </svg>
  );
}

/** Drag a column edge to resize; saved on release. */
function startResize(event: ReactMouseEvent, col: ColumnDef) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const startWidth = getColumnLayout().widths[col.id];
  const onMove = (move: MouseEvent) => columnActions.setWidth(col.id, startWidth + move.clientX - startX, false);
  const onUp = (up: MouseEvent) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    columnActions.setWidth(col.id, startWidth + up.clientX - startX, true);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function sortNext(current: string, key: string) {
  return current === `${key}-asc` ? `${key}-desc` : `${key}-asc`;
}

/** The list view's header: column titles (click to sort), drag edges to resize, drag titles to reorder. */
export function ListHeader() {
  const sort = useSyncExternalStore(subscribeFilters, () => getFilterState().sort);
  const columns = useSyncExternalStore(subscribeColumns, getColumnLayout);
  const infoRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: ColumnId; target: ColumnId | null; place: 'before' | 'after' } | null>(null);
  /** A finished drag must not also sort. */
  const dragged = useRef(false);

  useLayoutEffect(() => applyColumns(infoRef.current), [columns]);

  // Drag a column title (8 px or more) to move the column.
  const startDrag = (event: ReactMouseEvent, from: ColumnId) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    let moving = false;
    let target: { target: ColumnId; place: 'before' | 'after' } | null = null;
    const targetAt = (x: number) => {
      const cells = [...(infoRef.current?.querySelectorAll<HTMLElement>('[data-list-col]') || [])]
        .filter((el) => el.style.display !== 'none' && el.dataset.listCol !== from)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      if (!cells.length) return null;
      const before = cells.find((el) => { const r = el.getBoundingClientRect(); return x < r.left + r.width / 2; });
      const el = before || cells[cells.length - 1];
      return { target: el.dataset.listCol as ColumnId, place: before ? 'before' as const : 'after' as const };
    };
    const onMove = (move: MouseEvent) => {
      if (!moving && Math.abs(move.clientX - startX) < 8) return;
      moving = true;
      move.preventDefault();
      target = targetAt(move.clientX);
      setDrag({ from, target: target?.target ?? null, place: target?.place ?? 'before' });
      document.body.classList.add('list-view-col-reorder-active');
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('list-view-col-reorder-active');
      setDrag(null);
      if (!moving) return;
      dragged.current = true;
      setTimeout(() => { dragged.current = false; }, 0);
      if (target) columnActions.move(from, target.target, target.place);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const sortBy = (key: string) => {
    if (dragged.current) return;
    filterActions.setSort(sortNext(sort, key));
    runSearch({ force: true });
  };

  return (
    <div className="list-view-header">
      <div className="list-view-thumb-spacer" style={{ flexShrink: 0, width: 60, height: 20 }} />
      <div className="list-view-header-info" ref={infoRef}>
        {COLUMNS.map((col) => {
          const active = !!col.sortKey && (sort === `${col.sortKey}-asc` || sort === `${col.sortKey}-desc`);
          const classes = ['list-view-col',
            drag?.from === col.id && 'is-dragging',
            drag?.target === col.id && (drag.place === 'before' ? 'list-view-col-drop-before' : 'list-view-col-drop-after')];
          return (
            <div key={col.id} className={classes.filter(Boolean).join(' ')} data-list-col={col.id} style={{ position: 'relative' }}
              onMouseDown={(e) => startDrag(e, col.id)}>
              <Icon id={col.id} />
              {col.sortKey ? (
                <div className={`sortable-header${active ? ' sort-active' : ''}`} data-sort-key={col.sortKey}
                  style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, userSelect: 'none', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', color: active ? '#fff' : '#aaa' }}
                  onClick={() => sortBy(col.sortKey!)}>
                  <span>{col.label}</span>
                  <span className="sort-indicator" title={active ? (sort.endsWith('-asc') ? 'Sorted ascending' : 'Sorted descending') : ''}
                    style={{ opacity: active ? 1 : 0 }}>{active ? (sort.endsWith('-asc') ? '↑' : '↓') : ''}</span>
                </div>
              ) : (
                <span style={{ fontSize: 12, fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.5px', marginLeft: 6 }}>{col.label}</span>
              )}
              <div className="list-view-col-resize-handle" title="Drag to resize" onMouseDown={(e) => startResize(e, col)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
