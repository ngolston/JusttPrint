import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Clock, Heart, Printer, Weight } from 'lucide-react';
import { formatDuration, formatGrams } from '../format';
import { cx } from './Button';
import { ColorDot, FitBadge, IsoThumb } from './Filament';
import { nextTabIndex } from './Tabs';

/*
 * Library browse pieces of the Bento look (docs/design-bento.md, J2 · Library (browse style)):
 * the picture-first card, category tabs, sort tabs and the switch.
 */

/** "Zack Freedman" → "ZF", "Hugo" → "H". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return words
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

const AVATAR_TONES = 6;
/** The same designer always gets the same avatar color. */
export function avatarTone(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % AVATAR_TONES;
}

export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <span
      className={cx('jp-avatar', `jp-avatar--${avatarTone(name)}`)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

/** "Printed 3×", or "Not yet". */
export const printedLabel = (times: number) => (times > 0 ? `Printed ${times}×` : 'Not yet');

export interface BrowseCardColor {
  color: string;
  name: string;
  short?: boolean;
}

/**
 * A model in the browse grid: picture (4:3) with source, favorite, the filament check and the
 * plate count; title, designer and colors; times printed, grams and print time. The whole card is
 * one link, so the heart only shows the state (the model page and the menu change it).
 */
export function BrowseCard({
  href,
  title,
  designer,
  source,
  picture,
  colors,
  favorite = false,
  plates,
  printed = 0,
  grams,
  seconds,
  onOpen
}: {
  href: string;
  title: string;
  designer?: string | null;
  /** "MakerWorld", "Printables", "Upload", … */
  source?: string | null;
  /** The model's thumbnail; without one, placeholder art in its first color. */
  picture?: string | null;
  colors: BrowseCardColor[];
  favorite?: boolean;
  /** "2 plates", "11 parts" */
  plates?: string | null;
  printed?: number;
  grams?: number | null;
  seconds?: number | null;
  onOpen?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const missing = colors.filter((c) => c.short).map((c) => c.name);
  const first = colors[0]?.color ?? '#8b8f96';
  return (
    <a className="jp-browse-card" href={href} onClick={onOpen}>
      <span className="jp-browse-card__picture">
        {picture ? <img src={picture} alt="" loading="lazy" decoding="async" /> : <IsoThumb color={first} second={colors[1]?.color} />}
        {source && <span className="jp-pill jp-pill--glass jp-browse-card__source">{source}</span>}
        <span className={cx('jp-browse-card__heart', favorite && 'is-on')} role="img" aria-label={favorite ? 'Favorite' : 'Not a favorite'}>
          <Heart size={16} aria-hidden="true" fill={favorite ? 'currentColor' : 'none'} />
        </span>
        {colors.length > 0 && <FitBadge missing={missing} className="jp-browse-card__fit" />}
        {plates && <span className="jp-pill jp-pill--dark jp-browse-card__plates">{plates}</span>}
      </span>
      <span className="jp-browse-card__body">
        <span className="jp-browse-card__title">{title}</span>
        <span className="jp-browse-card__by">
          {designer && <Avatar name={designer} />}
          <span className="jp-browse-card__designer">{designer || 'Unknown designer'}</span>
          <span className="jp-browse-card__dots">
            {colors.map((c, index) => (
              <ColorDot key={`${c.color}-${index}`} color={c.color} short={c.short} name={c.name} />
            ))}
          </span>
        </span>
        <span className="jp-browse-card__stats">
          <span className="jp-browse-card__stat">
            <Printer size={14} aria-hidden="true" />
            {printedLabel(printed)}
          </span>
          {grams != null && (
            <span className="jp-browse-card__stat">
              <Weight size={14} aria-hidden="true" />
              {formatGrams(grams)}
            </span>
          )}
          {seconds != null && seconds > 0 && (
            <span className="jp-browse-card__stat">
              <Clock size={14} aria-hidden="true" />
              {formatDuration(seconds)}
            </span>
          )}
        </span>
      </span>
    </a>
  );
}

export interface CategoryItem {
  id: string;
  name: string;
  /** The icon's color. */
  color: string;
}

/**
 * The library's categories as a horizontal row of buttons with an icon each, and the chosen
 * category's subcategories as chips under it.
 */
export function CategoryTabs({
  categories,
  value,
  onChange,
  subcategories,
  subcategoryHeading,
  onSubcategory,
  label = 'Categories'
}: {
  categories: CategoryItem[];
  value: string;
  onChange: (id: string) => void;
  subcategories?: string[];
  /** Before the chips: the category's name, or "Popular in your library". */
  subcategoryHeading?: string;
  onSubcategory?: (name: string) => void;
  label?: string;
}) {
  return (
    <div className="jp-categories">
      <nav className="jp-categories__row" aria-label={label}>
        {categories.map((category) => {
          const on = category.id === value;
          return (
            <button key={category.id} type="button" className={cx('jp-category', on && 'is-on')} aria-pressed={on} onClick={() => onChange(category.id)}>
              <span className="jp-category__icon">
                <IsoThumb color={category.color} size={30} ground={false} />
              </span>
              <span className="jp-category__name">{category.name}</span>
            </button>
          );
        })}
      </nav>
      {subcategories && subcategories.length > 0 && (
        <div className="jp-categories__subs">
          {subcategoryHeading && <span className="jp-categories__sub-heading">{subcategoryHeading}</span>}
          {subcategories.map((name) => (
            <button key={name} type="button" className="jp-chip" onClick={() => onSubcategory?.(name)}>
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface SortTabItem<T extends string> {
  id: T;
  label: string;
}

/**
 * Text tabs with a coral underline. As `buttons` (the default) they are a set of pressed buttons
 * (a sort order); as `tabs` they are a tab list for tab panels (the model page), with arrow keys.
 */
export function SortTabs<T extends string>({
  items,
  value,
  onChange,
  label,
  mode = 'buttons',
  end
}: {
  items: SortTabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  mode?: 'buttons' | 'tabs';
  /** Right of the tabs: a switch, a count. */
  end?: ReactNode;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKeyDown(event: KeyboardEvent, index: number) {
    if (mode !== 'tabs') return;
    const next = nextTabIndex(event.key, index, items.length);
    if (next < 0) return;
    event.preventDefault();
    refs.current[next]?.focus();
    onChange(items[next].id);
  }
  return (
    <div className="jp-sort-tabs">
      <div className="jp-sort-tabs__list" role={mode === 'tabs' ? 'tablist' : 'group'} aria-label={label}>
        {items.map((item, index) => {
          const on = item.id === value;
          return (
            <button
              key={item.id}
              type="button"
              ref={(el) => {
                refs.current[index] = el;
              }}
              className={cx('jp-sort-tab', on && 'is-on')}
              role={mode === 'tabs' ? 'tab' : undefined}
              aria-selected={mode === 'tabs' ? on : undefined}
              aria-pressed={mode === 'tabs' ? undefined : on}
              tabIndex={mode === 'tabs' && !on ? -1 : undefined}
              onClick={() => onChange(item.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {end && <div className="jp-sort-tabs__end">{end}</div>}
    </div>
  );
}

/** A switch with its label ("Fits my filament"). */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cx('jp-toggle', checked && 'is-on')}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="jp-toggle__track" aria-hidden="true">
        <span className="jp-toggle__knob" />
      </span>
      <span>{label}</span>
    </button>
  );
}
