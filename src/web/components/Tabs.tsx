import { useRef, type KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './Button';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
}

/** Index of the tab to focus after a key press (arrows wrap, Home/End jump), or -1. */
export function nextTabIndex(key: string, index: number, count: number): number {
  if (count <= 0) return -1;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}

/** The library's state tabs (All Models, Printed, ...; spec §15). Arrow keys move between tabs. */
export function Tabs<T extends string>({ items, value, onChange, label }: { items: TabItem<T>[]; value: T; onChange: (id: T) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKeyDown(event: KeyboardEvent, index: number) {
    const next = nextTabIndex(event.key, index, items.length);
    if (next < 0) return;
    event.preventDefault();
    refs.current[next]?.focus();
    onChange(items[next].id);
  }
  return (
    <div className="jp-tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => {
        const selected = item.id === value;
        const Icon = item.icon;
        return (
          <button key={item.id} type="button" role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1}
            ref={(el) => { refs.current[index] = el; }}
            className={cx('jp-tab', selected && 'is-selected')} onClick={() => onChange(item.id)} onKeyDown={(event) => onKeyDown(event, index)}>
            {Icon && <Icon size={16} aria-hidden="true" />}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
