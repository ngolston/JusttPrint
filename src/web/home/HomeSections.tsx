/**
 * Home's sections below the dashboard figures: Continue your kits, Needs attention, Favorites,
 * Collections and Browse by category. Each shows real data only, and a section with nothing to
 * show is left out (Needs attention says so instead, for the people who can act on it).
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Castle,
  CheckCircle2,
  Copy,
  Cpu,
  DatabaseBackup,
  FolderHeart,
  FolderInput,
  GraduationCap,
  Gamepad2,
  House,
  ImageOff,
  Palette,
  Printer as PrinterIcon,
  Scale,
  Search,
  Shapes,
  Shirt,
  Sparkles,
  Swords,
  Tags,
  Wand2,
  Wrench,
  type LucideIcon
} from 'lucide-react';
import {
  callAction,
  categories as categoryApi,
  collections as collectionApi,
  library,
  type CollectionSummary,
  type LibraryAttention,
  type Printer
} from '../api';
import { Button } from '../components/Button';
import { StatusBadge, printStatusInfo } from '../components/Badge';
import { EmptyState, Panel, ProgressBar, Skeleton } from '../components/Panel';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { cardTitle, formatOf } from '../grid/ModelCard';
import type { GridModel } from '../grid/layout';
import { kitsInProgress, progressText, type KitInProgress } from '../kits/kits';
import { showModelDetails } from '../library/details';
import { useFoldersAsModels } from '../library/folderMode';
import { tabInfo, type LibraryTab } from '../library/tabs';
import { onServerEvent } from '../page';
import { showCategory } from '../pages/CategoriesPage';
import { effectiveStatus, type PrintModel } from '../print/printStatus';
import { selection } from '../selection';
import { useCan } from '../session';
import { useLibraryData } from '../shell/libraryData';
import { navigate } from '../shell/routes';
import { generateMissing } from '../thumbnails/jobs';
import { fetchPrimaryThumbnail } from '../thumbnails/cache';
import { attentionItems, type AttentionKey } from './attention';
import { timeAgo } from './format';
import { organizeUploads, showUnorganized, useOrganizeRun } from '../upload/inbox';

/** Show one model in the library with its details. */
export function openModel(filePath: string) {
  navigate('library');
  selection.set([filePath]);
  void showModelDetails(filePath);
}

export function showTab(tab: LibraryTab) {
  const info = tabInfo(tab);
  navigate('library');
  applyFilterChange(() => filterActions.setTab(info.printed, info.favorite));
}

/** The library with only these filters. */
function showLibrary(apply: () => void) {
  navigate('library');
  applyFilterChange(() => {
    filterActions.clearAll();
    apply();
  });
}

const plural = (n: number, one: string) => `${n.toLocaleString()} ${n === 1 ? one : `${one}s`}`;

/** A model's grid picture, the placeholder until it comes. */
export function useThumbnail(filePath: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!filePath) return undefined;
    let live = true;
    fetchPrimaryThumbnail(filePath).then(
      (thumb) => {
        if (live) setSrc(thumb);
      },
      () => {}
    );
    return () => {
      live = false;
    };
  }, [filePath]);
  return src;
}

/** Loads now, then again when one of the server's events comes or the library changes. */
function useReloading<T>(load: () => Promise<T>, events: string[]): T | null {
  const [tick, setTick] = useState(0);
  const key = events.join(' ');
  useEffect(() => {
    const offs = key.split(' ').map((name) => onServerEvent(name, () => setTick((n) => n + 1)));
    return () => offs.forEach((off) => off());
  }, [key]);
  // A new function after each event, so useLibraryData loads again (and keeps the old data until then).
  const reload = useCallback(() => load(), [load, tick]);
  return useLibraryData(reload);
}

// ---- Model cards (Your Library, Favorites) --------------------------------------------------

export function RecentCard({ model }: { model: GridModel }) {
  const src = useThumbnail(model.filePath);
  const designer = typeof model.designer === 'string' ? model.designer : '';
  const format = formatOf(model);
  const status = printStatusInfo(effectiveStatus(model as PrintModel));
  return (
    <li>
      <button type="button" className="jp-recent-card" data-filepath={model.filePath} onClick={() => openModel(model.filePath)}>
        <span className="jp-recent-card__image">
          <img src={src || 'assets/3d.png'} alt="" loading="lazy" />
        </span>
        <span className="jp-recent-card__body">
          <span className="jp-recent-card__title">{cardTitle(model)}</span>
          <span className="jp-recent-card__byline">{designer || ' '}</span>
          <span className="jp-model-card__badges">
            {format && <span className="jp-badge">{format}</span>}
            <StatusBadge tone={status.tone} icon={status.icon}>
              {status.label}
            </StatusBadge>
          </span>
        </span>
      </button>
    </li>
  );
}

/** A section of model or collection cards with a title and a View all button. */
function CardSection({ id, title, meta, viewAll, children }: { id: string; title: string; meta: string; viewAll: () => void; children: ReactNode }) {
  return (
    <section className="jp-home__library" aria-labelledby={id}>
      <header className="jp-home__library-head">
        <div>
          <h2 className="jp-section-title" id={id}>
            {title}
          </h2>
          <p className="jp-meta">{meta}</p>
        </div>
        <Button onClick={viewAll}>View all</Button>
      </header>
      {children}
    </section>
  );
}

// ---- Continue your kits -------------------------------------------------------------------

function KitRow({ kit }: { kit: KitInProgress }) {
  const src = useThumbnail(kit.coverPath);
  const open = () => (kit.kind === 'folder' ? navigate('folder', kit.target) : navigate('model', kit.target));
  return (
    <li>
      <button type="button" className="jp-kit-row" data-kit-target={kit.target} onClick={open} title={`Open ${kit.name}`}>
        <span className="jp-kit-row__image">
          <img src={src || 'assets/3d.png'} alt="" loading="lazy" />
        </span>
        <span className="jp-kit-row__text">
          <span className="jp-activity__title">{kit.name}</span>
          <ProgressBar value={kit.done} max={kit.total} label={`${kit.name}: ${progressText(kit.done, kit.total)}`} />
          <span className="jp-activity__meta">
            {progressText(kit.done, kit.total)} • last part {timeAgo(kit.lastDoneAt)}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Kits with some parts printed and some not, the last ticked first; nothing when there are none. */
export function ContinueKits() {
  const folders = useFoldersAsModels();
  const load = useCallback(() => kitsInProgress(folders, 4).catch(() => [] as KitInProgress[]), [folders]);
  const kits = useReloading(load, ['kit-changed']);
  if (!kits || !kits.length) return null;
  return (
    <Panel title="Continue your kits" labelledBy="jp-kits-title" className="jp-home__panel">
      <ul className="jp-activity-list" id="jp-home-kits">
        {kits.map((kit) => (
          <KitRow key={`${kit.kind}:${kit.target}`} kit={kit} />
        ))}
      </ul>
    </Panel>
  );
}

// ---- Needs attention ------------------------------------------------------------------------

const ATTENTION: Record<AttentionKey, { icon: LucideIcon; run: () => void }> = {
  backup: { icon: DatabaseBackup, run: () => navigate('settings', 'backup') },
  maintenance: { icon: Wrench, run: () => navigate('printers') },
  unorganized: { icon: FolderInput, run: showUnorganized },
  duplicates: { icon: Copy, run: () => navigate('duplicates') },
  uncategorized: { icon: Shapes, run: () => showLibrary(() => filterActions.search('category', 'none')) },
  untagged: { icon: Tags, run: () => showLibrary(() => filterActions.addValue('tags', '__none__')) },
  unlicensed: { icon: Scale, run: () => showLibrary(() => filterActions.setValue('license', '__none__')) },
  thumbnails: { icon: ImageOff, run: () => void generateMissing() }
};

/** For editors and admins, once there are models: the library's loose ends, each a click from where it is fixed. */
export function NeedsAttention({ printers, models }: { printers: Printer[] | null; models: number | undefined }) {
  const canEdit = useCan('editor');
  const found = useLibraryData<LibraryAttention>(library.attention);
  const organizing = useOrganizeRun();
  // Nothing to look after in an empty library (and "All caught up" would say so wrongly).
  if (!canEdit || !models) return null;
  const due = (printers || []).filter((p) => Number(p.due_reminders_count) > 0).length;
  const items = found ? attentionItems(found, due, canEdit) : null;
  return (
    <Panel title="Needs attention" labelledBy="jp-attention-title" className="jp-home__panel">
      {!items ? (
        <div className="jp-home__skeleton">
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : !items.length ? (
        <EmptyState icon={CheckCircle2} title="All caught up">
          Every model has tags, a license, a category and a thumbnail, and there are no duplicates.
        </EmptyState>
      ) : (
        <ul className="jp-activity-list" id="jp-home-attention">
          {items.slice(0, 5).map((item) => {
            const { icon: Icon, run } = ATTENTION[item.key];
            return (
              <li key={item.key} className={item.key === 'unorganized' ? 'jp-attention__with-action' : undefined}>
                <button type="button" className="jp-activity" data-attention={item.key} onClick={run}>
                  <span className={`jp-activity__icon jp-tone--${item.tone}`}>
                    <Icon size={18} aria-hidden="true" />
                  </span>
                  <span className="jp-activity__text">
                    <span className="jp-activity__title">{item.title}</span>
                    <span className="jp-activity__meta">{item.meta}</span>
                  </span>
                </button>
                {item.key === 'unorganized' && (
                  <Button
                    size="sm"
                    variant="primary"
                    icon={Wand2}
                    id="jp-home-organize"
                    disabled={!!organizing?.running}
                    onClick={() => void organizeUploads()}
                  >
                    {organizing?.running ? 'Organizing…' : 'Organize'}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

// ---- Favorites ------------------------------------------------------------------------------

const loadFavorites = () =>
  callAction<GridModel[]>('get-models-filtered', { favorite: 'favorited', sortOption: 'dateadded-desc', limit: 6 }).catch(() => [] as GridModel[]);

export function FavoritesRow() {
  const favorites = useLibraryData<GridModel[]>(loadFavorites);
  if (!favorites || !favorites.length) return null;
  return (
    <CardSection id="jp-home-favorites-title" title="Favorites" meta="Models you marked with a heart" viewAll={() => showTab('favorites')}>
      <ul className="jp-recent-grid" aria-label="Favorite models" id="jp-home-favorites">
        {favorites.map((model) => (
          <RecentCard key={model.filePath} model={model} />
        ))}
      </ul>
    </CardSection>
  );
}

// ---- Collections ----------------------------------------------------------------------------

const loadCollections = () =>
  collectionApi
    .list()
    .then((list) => [...list].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 6))
    .catch(() => [] as CollectionSummary[]);

function CollectionCard({ collection }: { collection: CollectionSummary }) {
  const src = useThumbnail(collection.coverPath);
  return (
    <li>
      <button
        type="button"
        className="jp-recent-card jp-collection-card"
        data-collection-id={collection.id}
        onClick={() => navigate('collections', String(collection.id))}
      >
        <span className="jp-recent-card__image">
          {collection.coverPath ? (
            <img src={src || 'assets/3d.png'} alt="" loading="lazy" />
          ) : (
            <FolderHeart className="jp-home__empty-cover" size={40} aria-hidden="true" />
          )}
        </span>
        <span className="jp-recent-card__body">
          <span className="jp-recent-card__title">{collection.name}</span>
          <span className="jp-recent-card__byline">
            {collection.smart && (
              <span className="jp-badge jp-collection-card__smart" title="A saved search: shows the models it finds now">
                <Search size={12} aria-hidden="true" /> Smart
              </span>
            )}
            {plural(collection.modelCount, 'model')} · changed {timeAgo(collection.updatedAt)}
          </span>
        </span>
      </button>
    </li>
  );
}

export function CollectionsRow() {
  const list = useReloading(loadCollections, ['collections-changed']);
  if (!list || !list.length) return null;
  return (
    <CardSection id="jp-home-collections-title" title="Collections" meta="Changed most recently" viewAll={() => navigate('collections')}>
      <ul className="jp-recent-grid" aria-label="Collections" id="jp-home-collections">
        {list.map((collection) => (
          <CollectionCard key={collection.id} collection={collection} />
        ))}
      </ul>
    </CardSection>
  );
}

// ---- Browse by category ---------------------------------------------------------------------

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  Art: Palette,
  Fashion: Shirt,
  'Hobby & DIY': Cpu,
  Household: House,
  Education: GraduationCap,
  Miniatures: Castle,
  Tools: Wrench,
  'Toys & Games': Gamepad2,
  '3D Printer': PrinterIcon,
  'Props & Cosplays': Swords,
  'Generative 3D Model': Sparkles
};

const loadCategories = () => categoryApi.list().catch(() => ({ categories: [], uncategorized: 0 }));

/** The Categories with models in them, the fullest first. */
export function CategoryTiles() {
  const data = useLibraryData(loadCategories);
  if (!data) return null;
  const main = data.categories.filter((c) => !c.parent_id && c.model_count > 0).sort((a, b) => b.model_count - a.model_count);
  if (!main.length) return null;
  return (
    <CardSection id="jp-home-categories-title" title="Browse by category" meta="The categories your models are in" viewAll={() => navigate('categories')}>
      <ul className="jp-category-tiles" id="jp-home-categories">
        {main.map((category) => {
          const Icon = CATEGORY_ICONS[category.name] || Shapes;
          return (
            <li key={category.id}>
              <button type="button" className="jp-category-tile" data-category-name={category.name} onClick={() => showCategory(category.name)}>
                <span className="jp-category-tile__icon jp-tone--accent">
                  <Icon size={20} aria-hidden="true" />
                </span>
                <span className="jp-category-tile__text">
                  <span className="jp-category-tile__name">{category.name}</span>
                  <span className="jp-category-tile__count">{plural(category.model_count, 'model')}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </CardSection>
  );
}
