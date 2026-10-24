/**
 * The Library's filter bar: Sort, Designer, Category, Tags, Rating and File type as buttons, each
 * opening a short list (with a search box when it is long, and how many models each choice has).
 * A set filter shows its value on its button, with × to take it off. Everything else (search
 * logic, license, title, invert) stays in the All filters popover.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownUp, Check, ChevronDown, X } from 'lucide-react';
import { categories as categoryApi, libraryValues, tags as tagApi } from '../api';
import { SORT_OPTIONS, categoryOf } from './query';
import { applyFilterChange, onReloadOptions, runSearch } from './search';
import { filterActions, getFilterState, subscribeFilters } from './store';
import { loadFileTypes } from './Sidebar';

interface Choice {
  value: string;
  label: string;
  count?: number;
  /** A Subcategory under its Category. */
  indent?: boolean;
}

interface FacetData {
  designers: Choice[];
  categories: Choice[];
  tags: Choice[];
  fileTypes: Choice[];
}

const EMPTY: FacetData = { designers: [], categories: [], tags: [], fileTypes: [] };

const RATINGS: Choice[] = [
  { value: 'all', label: 'Any rating' },
  { value: '5', label: '★★★★★' },
  { value: '4', label: '★★★★ and up' },
  { value: '3', label: '★★★ and up' },
  { value: '2', label: '★★ and up' },
  { value: '1', label: '★ and up' }
];

/** A shorter sort name for the button ("Date Added (Newest First)" → "Date Added ↓"). */
export function shortSort(label: string): string {
  return label.replace(/\s*\((.*)\)$/, (_, how: string) => (/(Oldest|Smallest|Least|Lowest|A-Z|Not Printed|Printing) First|A-Z/.test(how) ? ' ↑' : ' ↓'));
}

async function loadFacets(): Promise<FacetData> {
  const [facets, tagList, categoryList, fileTypes] = await Promise.all([
    libraryValues.facets().catch(() => ({ designers: [], licenses: [] })),
    tagApi.list().catch(() => []),
    categoryApi.list().catch(() => ({ categories: [], uncategorized: 0 })),
    loadFileTypes()
  ]);
  const mains = categoryList.categories.filter((c) => !c.parent_id);
  const categories: Choice[] = [];
  for (const main of mains) {
    const subs = categoryList.categories.filter((c) => c.parent_id === main.id && c.model_count > 0);
    // A model counts in its Category too (core/categories.js), so the Category's count is its total.
    if (!main.model_count) continue;
    categories.push({ value: main.name, label: main.name, count: main.model_count });
    for (const sub of subs) categories.push({ value: sub.name, label: sub.name, count: sub.model_count, indent: true });
  }
  return {
    designers: facets.designers.map((d) => ({ value: d.name, label: d.name, count: d.count })),
    categories,
    tags: tagList
      .filter((t) => t.model_count > 0)
      .map((t) => ({ value: t.name, label: t.name, count: t.model_count }))
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.label.localeCompare(b.label)),
    fileTypes: fileTypes.filter((t) => t.value).map((t) => ({ value: t.value, label: t.label }))
  };
}

/** The list a facet button opens, under the button (fixed, so a scrolling bar does not clip it). */
function FacetMenu({
  anchor,
  label,
  choices,
  isChecked,
  onPick,
  onClose,
  footer
}: {
  anchor: HTMLElement;
  label: string;
  choices: Choice[];
  isChecked: (value: string) => boolean;
  onPick: (value: string) => void;
  onClose: () => void;
  footer?: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [place, setPlace] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const searchable = choices.length > 8;

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const width = 280;
    setPlace({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
  }, [anchor]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (menu.current?.contains(target) || anchor.contains(target))) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
      anchor.focus();
    };
    const onScroll = (event: Event) => {
      if (menu.current && event.target instanceof Node && menu.current.contains(event.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onClose);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onClose);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, onClose]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return words ? choices.filter((choice) => choice.label.toLowerCase().includes(words)) : choices;
  }, [choices, query]);

  return createPortal(
    <div ref={menu} className="jp jp-facet-menu" role="dialog" aria-label={label} style={{ top: place.top, left: place.left }}>
      {searchable && (
        <input
          type="search"
          className="jp-facet-menu__search"
          placeholder={`Find ${label.toLowerCase()}`}
          aria-label={`Find ${label.toLowerCase()}`}
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && shown.length === 1) onPick(shown[0].value);
          }}
        />
      )}
      <ul className="jp-facet-menu__list" role="listbox" aria-label={label}>
        {shown.map((choice) => {
          const checked = isChecked(choice.value);
          return (
            <li key={`${choice.indent ? 'sub' : 'main'}:${choice.value}`}>
              <button
                type="button"
                role="option"
                aria-selected={checked}
                className={`jp-facet-menu__item${choice.indent ? ' is-sub' : ''}${checked ? ' is-checked' : ''}`}
                onClick={() => onPick(choice.value)}
              >
                <span className="jp-facet-menu__check" aria-hidden="true">
                  {checked && <Check size={14} />}
                </span>
                <span className="jp-facet-menu__label">{choice.label}</span>
                {choice.count !== undefined && <span className="jp-facet-menu__count">{choice.count.toLocaleString()}</span>}
              </button>
            </li>
          );
        })}
        {!shown.length && <li className="jp-facet-menu__none">Nothing matches</li>}
      </ul>
      {footer}
    </div>,
    document.body
  );
}

/** Load the lists again (FacetBar sets it): every time a list opens, so counts follow scans and edits. */
let reloadFacets: () => void = () => {};

/** One button of the bar, and its list while open. */
function Facet({
  id,
  label,
  value,
  icon,
  onClear,
  menu
}: {
  id: string;
  label: string;
  /** The value set (shown on the button), or '' for none. */
  value: string;
  icon?: ReactNode;
  onClear?: () => void;
  menu: (close: () => void, anchor: HTMLElement) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useMemo(() => () => setOpen(false), []);
  return (
    <div className={`jp-facet${value ? ' is-set' : ''}`}>
      <button
        ref={button}
        type="button"
        id={id}
        className="jp-facet__button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={value ? `${label}: ${value}` : label}
        onClick={() => {
          if (!open) reloadFacets();
          setOpen(!open);
        }}
      >
        {icon}
        <span className="jp-facet__label">{label}</span>
        {value && <span className="jp-facet__value">{value}</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {value && onClear && (
        <button type="button" className="jp-facet__clear" aria-label={`Clear ${label}`} title={`Clear ${label}`} onClick={onClear}>
          <X size={13} aria-hidden="true" />
        </button>
      )}
      {open && button.current && menu(close, button.current)}
    </div>
  );
}

export function FacetBar({ children }: { children?: ReactNode }) {
  const state = useSyncExternalStore(subscribeFilters, getFilterState);
  const [data, setData] = useState<FacetData>(EMPTY);

  useEffect(() => {
    const reload = () => {
      loadFacets()
        .then(setData)
        .catch((error) => console.error('Error loading the filter bar:', error));
    };
    reload();
    reloadFacets = reload;
    const stop = onReloadOptions(reload);
    return () => {
      stop();
      reloadFacets = () => {};
    };
  }, []);

  const sortLabel = SORT_OPTIONS.find(([value]) => value === state.sort)?.[1] || '';
  const designer = state.designer.length === 1 ? state.designer[0] : '';
  const category = categoryOf(state);
  const rating = state.ratingMin && state.ratingMin !== 'all' ? state.ratingMin : '';
  const fileType = state.fileType || '';
  const fileTypeLabel = data.fileTypes.find((t) => t.value === fileType)?.label || fileType.toUpperCase();
  const tagValue = state.tags.length === 1 ? state.tags[0] : state.tags.length ? `${state.tags.length}` : '';
  const change = (run: () => void) => applyFilterChange(run);

  return (
    <div className="jp-facet-bar" role="toolbar" aria-label="Filter the library">
      <Facet
        id="jp-facet-sort"
        label="Sort"
        value={shortSort(sortLabel)}
        icon={<ArrowDownUp size={14} aria-hidden="true" />}
        menu={(close, anchor) => (
          <FacetMenu
            anchor={anchor}
            label="Sort"
            choices={SORT_OPTIONS.map(([value, text]) => ({ value, label: text }))}
            isChecked={(value) => value === state.sort}
            onClose={close}
            onPick={(value) => {
              close();
              filterActions.setSort(value);
              void runSearch({ force: true });
            }}
          />
        )}
      />
      <span className="jp-facet-bar__divider" aria-hidden="true" />
      <Facet
        id="jp-facet-designer"
        label="Designer"
        value={designer === '__none__' ? 'None' : designer}
        onClear={() => change(() => filterActions.setValue('designer', ''))}
        menu={(close, anchor) => (
          <FacetMenu
            anchor={anchor}
            label="Designers"
            choices={[{ value: '', label: 'Any designer' }, ...data.designers, { value: '__none__', label: 'No designer' }]}
            isChecked={(value) => value === designer}
            onClose={close}
            onPick={(value) => {
              close();
              change(() => filterActions.setValue('designer', value));
            }}
          />
        )}
      />
      <Facet
        id="jp-facet-category"
        label="Category"
        value={category === 'none' ? 'None yet' : category}
        onClear={() => change(() => filterActions.setCategory(''))}
        menu={(close, anchor) => (
          <FacetMenu
            anchor={anchor}
            label="Categories"
            choices={[{ value: '', label: 'Any category' }, ...data.categories, { value: 'none', label: 'No category yet' }]}
            isChecked={(value) => value === category}
            onClose={close}
            onPick={(value) => {
              close();
              change(() => filterActions.setCategory(value));
            }}
          />
        )}
      />
      <Facet
        id="jp-facet-tags"
        label="Tags"
        value={tagValue === '__none__' ? 'None' : tagValue}
        onClear={() => change(() => filterActions.setTags([]))}
        menu={(close, anchor) => (
          <FacetMenu
            anchor={anchor}
            label="Tags"
            choices={data.tags}
            isChecked={(value) => state.tags.includes(value)}
            onClose={close}
            onPick={(value) => change(() => (state.tags.includes(value) ? filterActions.removeValue('tags', value) : filterActions.addValue('tags', value)))}
            footer={
              state.tags.length > 1 ? (
                <div className="jp-facet-menu__footer" role="radiogroup" aria-label="Match">
                  {(['OR', 'AND'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={state.combine.tags === mode}
                      className={`jp-facet-menu__mode${state.combine.tags === mode ? ' is-checked' : ''}`}
                      onClick={() => {
                        filterActions.setCombine('tags', mode);
                        void runSearch({ force: true });
                      }}
                    >
                      {mode === 'OR' ? 'Any of them' : 'All of them'}
                    </button>
                  ))}
                </div>
              ) : null
            }
          />
        )}
      />
      <Facet
        id="jp-facet-rating"
        label="Rating"
        value={rating ? `${rating}★${rating === '5' ? '' : '+'}` : ''}
        onClear={() => change(() => filterActions.setSingle('ratingMin', 'all'))}
        menu={(close, anchor) => (
          <FacetMenu
            anchor={anchor}
            label="Rating"
            choices={RATINGS}
            isChecked={(value) => (value === 'all' ? !rating : value === rating)}
            onClose={close}
            onPick={(value) => {
              close();
              change(() => filterActions.setSingle('ratingMin', value));
            }}
          />
        )}
      />
      <Facet
        id="jp-facet-filetype"
        label="File type"
        value={fileType ? fileTypeLabel.replace(/\s*\(.*\)$/, '') : ''}
        onClear={() => change(() => filterActions.setSingle('fileType', ''))}
        menu={(close, anchor) => (
          <FacetMenu
            anchor={anchor}
            label="File types"
            choices={[{ value: '', label: 'Any file type' }, ...data.fileTypes]}
            isChecked={(value) => value === fileType}
            onClose={close}
            onPick={(value) => {
              close();
              change(() => filterActions.setSingle('fileType', value));
            }}
          />
        )}
      />
      {children}
    </div>
  );
}
