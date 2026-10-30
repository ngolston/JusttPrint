import { useMemo } from 'react';
import { categories as categoryApi, library, type Category } from '../api';
import { CategoryTabs, type CategoryItem } from '../components/Browse';
import { IsoThumb } from '../components/Filament';
import { categoryOf, type FilterState } from '../filters/query';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { useLibraryData } from '../shell/libraryData';

/*
 * The library's browse layout (docs/design-bento.md, J2 · Library (browse style); docs/merge-10.md,
 * Phase 7): the categories as tabs with their subcategories, and banners for what the spools cover
 * and what is new this week. Both filter the same library grid below.
 */

/** Colors for the categories' block icons, in list order (they are not data, only a way to tell them apart). */
const CATEGORY_COLORS = ['#2f9e44', '#8b8f96', '#e8732c', '#d4a640', '#2f6fdf', '#8b5cf6', '#d23b3b', '#f472b6', '#14b8a6', '#b85a20', '#5a5f68'];

const loadCategories = () => categoryApi.list().catch(() => ({ categories: [] as Category[], uncategorized: 0 }));

/** The Category whose tab is on: the one searched for, or the Category of the Subcategory searched for. */
export function chosenCategory(list: Category[], searched: string): Category | null {
  if (!searched) return null;
  const found = list.find((c) => c.name.toLowerCase() === searched.toLowerCase());
  if (!found) return null;
  return found.parent_id ? list.find((c) => c.id === found.parent_id) || null : found;
}

export function CategoryRow({ state }: { state: FilterState }) {
  const data = useLibraryData(loadCategories);
  const list = useMemo(() => data?.categories || [], [data]);
  const mains = list.filter((c) => !c.parent_id && c.model_count > 0);
  if (!mains.length) return null;
  const searched = categoryOf(state);
  const chosen = chosenCategory(list, searched);
  const items: CategoryItem[] = [
    { id: 'all', name: 'All', color: '#8b8f96' },
    ...mains.map((c, index) => ({ id: String(c.id), name: c.name, color: CATEGORY_COLORS[index % CATEGORY_COLORS.length] }))
  ];
  const subs = chosen ? list.filter((c) => c.parent_id === chosen.id && c.model_count > 0).map((c) => c.name) : [];
  const pick = (id: string) => {
    const category = list.find((c) => String(c.id) === id);
    applyFilterChange(() => filterActions.setCategory(category ? category.name : ''));
  };
  return (
    <div className="jp-library-browse__categories">
      <CategoryTabs
        categories={items}
        value={chosen ? String(chosen.id) : 'all'}
        onChange={pick}
        subcategories={subs}
        subcategoryHeading={chosen ? chosen.name : undefined}
        onSubcategory={(name) => applyFilterChange(() => filterActions.setCategory(name))}
      />
    </div>
  );
}

/** Printable right now (turns on Fits my filament) and New this week (shows them); each only when there are some. */
export function Banners({ state }: { state: FilterState }) {
  const counts = useLibraryData(library.counts);
  const ready = counts?.readyToPrint || 0;
  const added = counts?.addedThisWeek || 0;
  if (!ready && !added) return null;
  const weekAgo = () => new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  return (
    <section className="jp-library-browse__banners" aria-label="Highlights">
      {ready > 0 && (
        <button
          type="button"
          className="jp-banner jp-banner--ink"
          id="jp-banner-ready"
          aria-pressed={state.fitsMyFilament}
          onClick={() => applyFilterChange(() => filterActions.setFitsMyFilament(!state.fitsMyFilament))}
        >
          <span className="jp-banner__text">
            <span className="jp-pill jp-banner__pill">Printable right now</span>
            <span className="jp-banner__title">
              {ready.toLocaleString()} {ready === 1 ? 'model matches' : 'models match'} the spools you have
            </span>
            <span className="jp-banner__meta">{state.fitsMyFilament ? 'Showing them. Click again for every model.' : 'Show only those'}</span>
          </span>
          <span className="jp-banner__art" aria-hidden="true">
            <IsoThumb color="#2f6fdf" second="#e8732c" size={130} ground={false} />
          </span>
        </button>
      )}
      {added > 0 && (
        <button
          type="button"
          className="jp-banner jp-banner--accent"
          id="jp-banner-new"
          onClick={() => applyFilterChange(() => filterActions.showAddedSince(weekAgo()))}
        >
          <span className="jp-pill jp-banner__pill jp-banner__pill--ink">New this week</span>
          <span className="jp-banner__figure">{added.toLocaleString()}</span>
          <span className="jp-banner__meta">{added === 1 ? 'model' : 'models'} added in the last 7 days</span>
        </button>
      )}
    </section>
  );
}
