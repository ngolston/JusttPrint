import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './Button';

export interface MenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** The side to align to so a menu `width` wide fits between 8px margins, keeping `preferred` when it fits. */
export function menuSide(preferred: 'start' | 'end', anchor: { left: number; right: number }, width: number, viewport: number): 'start' | 'end' {
  const fitsEnd = anchor.right - width >= 8;
  const fitsStart = anchor.left + width <= viewport - 8;
  if (preferred === 'end') return fitsEnd || !fitsStart ? 'end' : 'start';
  return fitsStart || !fitsEnd ? 'start' : 'end';
}

/** Index of the next enabled item for a key press, or -1 (arrows wrap, Home/End jump). */
export function nextMenuIndex(key: string, index: number, items: Pick<MenuItem, 'disabled'>[]): number {
  const enabled = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);
  if (!enabled.length) return -1;
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled[enabled.length - 1];
  const at = enabled.indexOf(index);
  if (key === 'ArrowDown') return enabled[(at + 1) % enabled.length];
  if (key === 'ArrowUp') return enabled[at <= 0 ? enabled.length - 1 : at - 1];
  return -1;
}

interface MenuProps {
  items: MenuItem[];
  /** Renders the button that opens the menu; spread the props onto it. */
  trigger: (props: { 'aria-haspopup': 'menu'; 'aria-expanded': boolean; 'aria-controls': string; onClick: () => void; ref: (el: HTMLButtonElement | null) => void }) => ReactNode;
  align?: 'start' | 'end';
  label: string;
}

/**
 * A dropdown menu (the More button, Open in Slicer's dropdown, the account menu). Keyboard:
 * arrows, Home/End, Enter, Escape returns focus to the button. Clicking outside closes it.
 */
export function Menu({ items, trigger, align = 'end', label }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [side, setSide] = useState(align);
  const id = useId();
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Flip to the side with room before the menu is painted.
  useLayoutEffect(() => {
    if (!open || !button.current || !list.current) return;
    setSide(menuSide(align, button.current.getBoundingClientRect(), list.current.offsetWidth, window.innerWidth));
  }, [open, align]);

  useEffect(() => {
    if (!open) return undefined;
    const first = nextMenuIndex('Home', -1, items);
    setActive(first);
    itemRefs.current[first]?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open, items]);

  function close(focusButton = true) {
    setOpen(false);
    if (focusButton) button.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      close(event.key === 'Escape');
      return;
    }
    const next = nextMenuIndex(event.key, active, items);
    if (next < 0) return;
    event.preventDefault();
    setActive(next);
    itemRefs.current[next]?.focus();
  }

  return (
    <div className="jp-menu-anchor">
      {trigger({ 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': id, onClick: () => setOpen((v) => !v), ref: (el) => { button.current = el; } })}
      {open && (
        <div id={id} ref={list} role="menu" aria-label={label} className={cx('jp-menu', `jp-menu--${side}`)} onKeyDown={onKeyDown}>
          {items.map((item, index) => {
            const Icon = item.icon;
            return (
              <button key={item.id} type="button" role="menuitem" disabled={item.disabled} tabIndex={index === active ? 0 : -1}
                ref={(el) => { itemRefs.current[index] = el; }}
                className={cx('jp-menu__item', item.danger && 'is-danger')}
                onClick={() => { close(); item.onSelect(); }}>
                {Icon && <Icon size={16} aria-hidden="true" />}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
