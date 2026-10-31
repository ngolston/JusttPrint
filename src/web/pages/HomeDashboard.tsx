import { filament, home, printQueue, type PrinterLoads, type QueueItem, type Spool } from '../api';
import { BentoGrid, Tile } from '../components/Bento';
import { MonthTile, NeedsYouTile, NewTile, PrintersTile, PrintingTile, RunsOutTile, SpoolsTile, UpNextTile, needsYou } from '../home/HomeBento';
import { useEffect, useState } from 'react';
import {
  Box,
  CheckCircle2,
  CircleSlash,
  Clock,
  Library,
  Loader2,
  PlusCircle,
  Printer as PrinterIcon,
  ScanSearch,
  XCircle,
  type LucideIcon
} from 'lucide-react';
import { callAction, library, printers as printerApi, type ActivityItem, type LibraryCounts, type Printer } from '../api';
import { Button } from '../components/Button';
import { EmptyState, Panel, Skeleton, StatCard } from '../components/Panel';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { cardTitle } from '../grid/ModelCard';
import type { GridModel } from '../grid/layout';
import { greeting, timeAgo } from '../home/format';
import { CategoryTiles, CollectionsRow, ContinueKits, FavoritesRow, NeedsAttention, RecentCard, openModel, showTab } from '../home/HomeSections';
import { useLibraryData } from '../shell/libraryData';
import { NAV } from '../shell/nav';
import { navigate } from '../shell/routes';
import { EditOnly } from '../components/EditOnly';
import { useScanProgress } from '../scan/scan';

const loadActivity = () => library.activity(8);
const loadQueue = () => printQueue.list().catch(() => [] as QueueItem[]);
const loadSpools = () => filament.spools(false).catch(() => [] as Spool[]);
const loadFilamentSummary = () => filament.summary().catch(() => null);
const loadMonth = () => home.month().catch(() => null);
const loadLoads = () => printerApi.loads().catch(() => [] as PrinterLoads[]);
const loadPrinting = () => callAction<GridModel[]>('get-models-filtered', { printed: 'printing', sortOption: 'name-asc', limit: 8 });
const loadNewest = () => callAction<GridModel[]>('get-models-filtered', { sortOption: 'dateadded-desc', limit: 4 });
const loadPrinters = () => printerApi.list();

const scanLibrary = () =>
  NAV.flatMap((section) => section.items)
    .find((item) => item.id === 'scan')
    ?.run?.();

/** Scan Library, showing that it runs: spinning and not clickable until the scan is done. */
function ScanLibraryButton({ primary = false }: { primary?: boolean }) {
  const scanning = !!useScanProgress();
  return (
    <Button
      variant={primary ? 'primary' : 'secondary'}
      icon={scanning ? Loader2 : ScanSearch}
      className={scanning ? 'jp-btn--busy' : undefined}
      disabled={scanning}
      aria-busy={scanning || undefined}
      onClick={scanLibrary}
    >
      {scanning ? 'Scanning…' : 'Scan Library'}
    </Button>
  );
}

// ---- Hero picture -------------------------------------------------------------------------

interface HeroPick {
  model: GridModel;
  /** Why this model: the last one printed, else the newest. */
  reason: 'printed' | 'added';
}

const HERO_CACHE = 'justtprint.heroRender.v1';

function cachedHero(key: string): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(HERO_CACHE) || 'null');
    return saved && saved.key === key && typeof saved.png === 'string' ? saved.png : null;
  } catch {
    return null;
  }
}

function saveHero(key: string, png: string) {
  try {
    localStorage.setItem(HERO_CACHE, JSON.stringify({ key, png }));
  } catch {
    /* storage full or blocked: render again next time */
  }
}

/** The most recently printed model, else the most recently added one. */
async function pickHero(): Promise<HeroPick | null> {
  const printed = await callAction<GridModel[]>('get-models-filtered', { printed: 'ever-printed', sortOption: 'lastprinted-desc', limit: 1 }).catch(() => []);
  if (printed?.[0]) return { model: printed[0], reason: 'printed' };
  const added = await callAction<GridModel[]>('get-models-filtered', { sortOption: 'dateadded-desc', limit: 1 }).catch(() => []);
  return added?.[0] ? { model: added[0], reason: 'added' } : null;
}

/** The hero's model, drawn in cyan with the 3D engine (lazy-loaded) and cached per model version. */
function HeroPicture() {
  const [pick, setPick] = useState<HeroPick | null | undefined>(undefined);
  const [png, setPng] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'done' | 'failed'>('loading');

  useEffect(() => {
    let live = true;
    pickHero().then(
      (found) => {
        if (live) setPick(found);
      },
      () => {
        if (live) setPick(null);
      }
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (pick === undefined) return undefined;
    if (!pick) {
      setState('failed');
      return undefined;
    }
    const key = `${pick.model.filePath}|${String(pick.model.modifiedDate ?? pick.model.size ?? '')}`;
    const cached = cachedHero(key);
    if (cached) {
      setPng(cached);
      setState('done');
      return undefined;
    }
    let live = true;
    setState('loading');
    import('../home/heroRender')
      .then(({ renderHero }) => renderHero(pick.model.filePath))
      .then((result) => {
        if (!live) return;
        if (result) {
          saveHero(key, result);
          setPng(result);
          setState('done');
        } else setState('failed');
      })
      .catch((error) => {
        console.warn('Dashboard picture not drawn:', error);
        if (live) setState('failed');
      });
    return () => {
      live = false;
    };
  }, [pick]);

  if (!pick && pick !== undefined) return null;
  const name = pick ? cardTitle(pick.model) : '';
  return (
    <figure className="jp-hero__figure">
      {state === 'done' && png ? (
        <img className="jp-hero__render" src={png} alt={`3D render of ${name}`} />
      ) : state === 'loading' ? (
        <Skeleton className="jp-hero__render-skeleton" radius="lg" />
      ) : (
        <Box className="jp-hero__fallback" size={96} aria-hidden="true" />
      )}
      {pick && (
        <figcaption>
          <button type="button" className="jp-hero__caption" onClick={() => openModel(pick.model.filePath)} title={`Show ${name}`}>
            {pick.reason === 'printed' ? 'Last printed' : 'Newest model'}: <strong>{name}</strong>
          </button>
        </figcaption>
      )}
    </figure>
  );
}

// ---- Hero card ------------------------------------------------------------------------------

function summary(counts: LibraryCounts | null, activity: ActivityItem[] | null): string {
  if (!counts) return '';
  if (!counts.models) return 'Scan your model folders to start your library.';
  const inQueue = counts.queued + counts.printing;
  if (counts.printing)
    return `${counts.printing} ${counts.printing === 1 ? 'model is' : 'models are'} printing${counts.queued ? `, ${counts.queued} more in the queue` : ''}.`;
  if (inQueue) return `${inQueue} ${inQueue === 1 ? 'model is' : 'models are'} waiting in the queue.`;
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const added = (activity || [])
    .filter((item) => item.kind === 'added' && Date.parse(item.at) >= weekAgo)
    .reduce((sum, item) => sum + (item.kind === 'added' ? item.count : 0), 0);
  if (added) return `${added} new ${added === 1 ? 'model' : 'models'} this week.`;
  return 'Your 3D printing library at a glance.';
}

// ---- Recent Activity (spec §13) -------------------------------------------------------------

const OUTCOME: Record<string, { icon: LucideIcon; tone: string; verb: string }> = {
  printed: { icon: CheckCircle2, tone: 'success', verb: 'printed successfully' },
  failed: { icon: XCircle, tone: 'danger', verb: 'print failed' },
  cancelled: { icon: CircleSlash, tone: 'neutral', verb: 'print cancelled' }
};

function ActivityRow({ item }: { item: ActivityItem }) {
  if (item.kind === 'added') {
    return (
      <li>
        <button
          type="button"
          className="jp-activity"
          onClick={() => {
            navigate('library');
            applyFilterChange(() => filterActions.showAddedSince(`${item.day}T00:00:00.000Z`));
          }}
        >
          <span className="jp-activity__icon jp-tone--accent">
            <PlusCircle size={18} aria-hidden="true" />
          </span>
          <span className="jp-activity__text">
            <span className="jp-activity__title">
              {item.count.toLocaleString()} new {item.count === 1 ? 'model' : 'models'} added
            </span>
            <span className="jp-activity__meta">Added to the library • {timeAgo(item.at)}</span>
          </span>
        </button>
      </li>
    );
  }
  const outcome = OUTCOME[item.outcome] || OUTCOME.printed;
  const Icon = outcome.icon;
  const name = cardTitle({ filePath: item.filePath, fileName: item.fileName });
  const meta = [item.printer, timeAgo(item.at)].filter(Boolean).join(' • ');
  return (
    <li>
      <button type="button" className="jp-activity" onClick={() => openModel(item.filePath)}>
        <span className={`jp-activity__icon jp-tone--${outcome.tone}`}>
          <Icon size={18} aria-hidden="true" />
        </span>
        <span className="jp-activity__text">
          <span className="jp-activity__title">
            {name}
            {item.quantity > 1 ? ` ×${item.quantity}` : ''} {outcome.verb}
          </span>
          <span className="jp-activity__meta">{meta}</span>
        </span>
      </button>
    </li>
  );
}

function RecentActivity({ activity }: { activity: ActivityItem[] | null }) {
  return (
    <Panel title="Recent Activity" labelledBy="jp-activity-title" className="jp-home__panel">
      {!activity ? (
        <div className="jp-home__skeleton">
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : !activity.length ? (
        <EmptyState
          icon={Library}
          title="Nothing yet"
          action={
            <EditOnly>
              <ScanLibraryButton />
            </EditOnly>
          }
        >
          Scanned models and logged prints show up here.
        </EmptyState>
      ) : (
        <ul className="jp-activity-list">
          {activity.slice(0, 4).map((item) => (
            <ActivityRow key={`${item.kind}:${item.kind === 'print' ? item.id : item.day}`} item={item} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * The Home dashboard above "Your Library" (spec §10-§14): greeting, four figures and a cyan
 * render of a library model; Recent Activity; Your Printers; Continue your kits and Needs
 * attention (home/HomeSections.tsx). Real data only (docs/redesign-5.md).
 */
export function HomeDashboard() {
  const counts = useLibraryData<LibraryCounts>(library.counts);
  const activity = useLibraryData<ActivityItem[]>(loadActivity);
  const list = useLibraryData<Printer[]>(loadPrinters);
  const queue = useLibraryData(loadQueue);
  const spools = useLibraryData(loadSpools);
  const filamentSummary = useLibraryData(loadFilamentSummary);
  const month = useLibraryData(loadMonth);
  const loads = useLibraryData(loadLoads);
  const printing = useLibraryData(loadPrinting);
  const newest = useLibraryData(loadNewest);
  const [hour] = useState(() => new Date().getHours());
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const thisWeek = (activity || []).reduce((sum, item) => sum + (item.kind === 'added' && Date.parse(item.at) >= weekAgo ? item.count : 0), 0);
  return (
    <div className="jp-home">
      <header className="jp-home-head">
        <h1 className="jp-display jp-hero__title" id="jp-hero-title">
          {greeting(hour)}
        </h1>
        <p className="jp-home-head__summary">{summary(counts, activity)}</p>
      </header>
      <BentoGrid label="At a glance" className="jp-home-bento">
        <LibraryTile counts={counts} />
        <NeedsYouTile items={needsYou(queue, list, spools)} />
        <SpoolsTile summary={filamentSummary} spools={spools} />
        <RunsOutTile spools={spools} />
        <UpNextTile items={queue} />
        <PrintingTile models={printing} />
        <NewTile models={newest} thisWeek={thisWeek} />
        <MonthTile month={month} />
        <PrintersTile printers={list} loads={loads} />
      </BentoGrid>
      <div className="jp-home__panels jp-home__panels--extra">
        <RecentActivity activity={activity} />
        <ContinueKits />
        <NeedsAttention printers={list} models={counts?.models} />
      </div>
    </div>
  );
}

/** The library's figures and its picture (the most recently printed model), on the ink tile. */
function LibraryTile({ counts }: { counts: LibraryCounts | null }) {
  const figure = (value: number | undefined) => (value == null ? <Skeleton width={44} height={20} /> : value.toLocaleString());
  return (
    <Tile variant="ink" title="Your library" cols={2} rows={2} className="jp-home-library">
      <div className="jp-home-library__body">
        <div className="jp-home-library__stats">
          <StatCard icon={Box} tone="accent" value={figure(counts?.models)} label="Models" onClick={() => showTab('all')} />
          <StatCard icon={CheckCircle2} tone="success" value={figure(counts?.printed)} label="Printed" onClick={() => showTab('printed')} />
          <StatCard
            icon={Clock}
            tone="warning"
            value={figure(counts ? counts.queued + counts.printing : undefined)}
            label="In Queue"
            onClick={() => showTab('queue')}
          />
          <StatCard icon={PrinterIcon} tone="violet" value={figure(counts?.printers)} label="Printers" onClick={() => navigate('printers')} />
        </div>
        <HeroPicture />
      </div>
    </Tile>
  );
}

// ---- Your Library: the latest additions (spec §15, §41 "What did I recently add?") ----------

const loadRecent = () => callAction<GridModel[]>('get-models-filtered', { sortOption: 'dateadded-desc', limit: 8 });

function RecentModels() {
  const recent = useLibraryData<GridModel[]>(loadRecent);
  return (
    <section className="jp-home__library" aria-labelledby="jp-home-library-title">
      <header className="jp-home__library-head">
        <div>
          <h2 className="jp-section-title" id="jp-home-library-title">
            Your Library
          </h2>
          <p className="jp-meta">Recently added</p>
        </div>
        <Button icon={Library} onClick={() => showTab('all')}>
          View all
        </Button>
      </header>
      {!recent ? (
        <div className="jp-home__skeleton">
          <Skeleton height={200} />
        </div>
      ) : !recent.length ? (
        <Panel>
          <EmptyState
            icon={Library}
            title="Your library is empty"
            action={
              <EditOnly>
                <ScanLibraryButton primary />
              </EditOnly>
            }
          >
            Scan your model folders (STL Home) to fill the library.
          </EmptyState>
        </Panel>
      ) : (
        <ul className="jp-recent-grid" aria-label="Recently added models">
          {recent.map((model) => (
            <RecentCard key={model.filePath} model={model} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Home (spec §10-§15): the dashboard, the latest additions to the library, then Favorites,
 * Collections and Browse by category (each left out when empty). Scrolls as one page.
 */
export function HomePage() {
  return (
    <div className="jp-page__inner jp-home-page">
      <HomeDashboard />
      <RecentModels />
      <FavoritesRow />
      <CollectionsRow />
      <CategoryTiles />
    </div>
  );
}
