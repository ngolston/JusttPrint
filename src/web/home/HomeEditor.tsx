import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, GripVertical, Plus, X } from 'lucide-react';
import { Button, cx } from '../components/Button';
import { Modal } from '../components/Overlay';
import { dropOn, hiddenWidgets, moveItem, SIZE_LABELS, spanOf, widgetInfo, type HomeLayout, type LayoutItem, type WidgetSize } from './homeLayout';

/*
 * Edit Home (pages/HomeDashboard.tsx): each widget in a frame with a handle to drag it, its size,
 * Move earlier and later (also the arrow keys on the frame), and Remove; Add Widget lists the rest.
 */

/** One widget on Home's grid, at its size; while editing, with its frame. */
export function WidgetFrame({
  item,
  index,
  count,
  editing,
  layout,
  onChange,
  dragging,
  setDragging,
  children
}: {
  item: LayoutItem;
  index: number;
  count: number;
  editing: boolean;
  layout: HomeLayout;
  onChange: (next: HomeLayout, focus?: string) => void;
  dragging: string | null;
  setDragging: (id: string | null) => void;
  children: ReactNode;
}) {
  const info = widgetInfo(item.id)!;
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [cols, rows] = spanOf(item.size);
  const style = { gridColumn: `span ${cols}`, gridRow: rows > 1 ? `span ${rows}` : undefined };
  const move = (by: number) => onChange(moveItem(layout, index, index + by), item.id);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowUp') && index > 0) {
      event.preventDefault();
      move(-1);
    } else if ((event.key === 'ArrowRight' || event.key === 'ArrowDown') && index < count - 1) {
      event.preventDefault();
      move(1);
    }
  };
  const onDragStart = (event: DragEvent<HTMLSpanElement>) => {
    event.dataTransfer.effectAllowed = 'move';
    // Firefox drags nothing without data.
    event.dataTransfer.setData('text/plain', item.id);
    if (ref.current) event.dataTransfer.setDragImage(ref.current, 24, 24);
    setDragging(item.id);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!dragging || dragging === item.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setOver(true);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    const id = dragging || event.dataTransfer.getData('text/plain');
    setDragging(null);
    if (id && id !== item.id) onChange(dropOn(layout, id, item.id), id);
  };

  return (
    <div
      ref={ref}
      className={cx('jp-widget', editing && 'is-editing', over && 'is-drop-target', dragging === item.id && 'is-dragging')}
      style={style}
      data-widget={item.id}
      data-size={item.size}
      tabIndex={editing ? 0 : undefined}
      aria-label={editing ? `${info.name}, ${SIZE_LABELS[item.size]}, ${index + 1} of ${count}. Arrow keys move it.` : undefined}
      onKeyDown={editing ? onKeyDown : undefined}
      onDragOver={editing ? onDragOver : undefined}
      onDragLeave={editing ? () => setOver(false) : undefined}
      onDrop={editing ? onDrop : undefined}
    >
      {editing && (
        <div className="jp-widget__bar">
          <span
            className="jp-widget__grip"
            draggable
            onDragStart={onDragStart}
            onDragEnd={() => {
              setDragging(null);
              setOver(false);
            }}
            title="Drag to move"
            aria-hidden="true"
          >
            <GripVertical size={16} />
          </span>
          <span className="jp-widget__name">{info.name}</span>
          {info.sizes.length > 1 && (
            <select
              className="jp-input jp-widget__size"
              aria-label={`Size of ${info.name}`}
              value={item.size}
              onChange={(event) =>
                onChange({
                  ...layout,
                  items: layout.items.map((other) => (other.id === item.id ? { ...other, size: event.target.value as WidgetSize } : other))
                })
              }
            >
              {info.sizes.map((size) => (
                <option key={size} value={size}>
                  {SIZE_LABELS[size]}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="jp-icon-btn" aria-label={`Move ${info.name} earlier`} disabled={index === 0} onClick={() => move(-1)}>
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <button type="button" className="jp-icon-btn" aria-label={`Move ${info.name} later`} disabled={index === count - 1} onClick={() => move(1)}>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="jp-icon-btn"
            aria-label={`Remove ${info.name}`}
            title="Remove from Home"
            onClick={() => onChange({ ...layout, items: layout.items.filter((other) => other.id !== item.id) })}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="jp-widget__body" inert={editing || undefined}>
        {children}
      </div>
    </div>
  );
}

/** The widgets not on Home, each with Add. */
export function AddWidgetDialog({ layout, onAdd, onClose }: { layout: HomeLayout; onAdd: (id: string) => void; onClose: () => void }) {
  const hidden = hiddenWidgets(layout);
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a Widget"
      id="jp-home-add-widget"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {hidden.length ? (
        <ul className="jp-widgets__list">
          {hidden.map((widget) => (
            <li key={widget.id} className="jp-widgets__item">
              <span>
                <span className="jp-widgets__name">{widget.name}</span>
                <span className="jp-meta">{widget.description}</span>
              </span>
              <Button size="sm" icon={Plus} onClick={() => onAdd(widget.id)} data-add-widget={widget.id}>
                Add
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="jp-meta">Every widget is on Home already.</p>
      )}
    </Modal>
  );
}
