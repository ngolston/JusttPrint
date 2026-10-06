import { useEffect, useState } from 'react';
import {
  Box, CheckCircle2, CircleSlash, Clock, ExternalLink, Library, PlusCircle, Printer as PrinterIcon, ScanSearch, Wrench, XCircle,
  type LucideIcon
} from 'lucide-react';
import { callAction, library, printers as printerApi, type ActivityItem, type LibraryCounts, type Printer } from '../api';
import { Button } from '../components/Button';
import { StatusBadge } from '../components/Badge';
import { EmptyState, Panel, Skeleton, StatCard } from '../components/Panel';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { cardTitle } from '../grid/ModelCard';
import type { GridModel } from '../grid/layout';
import { greeting, timeAgo } from '../home/format';
import { showModelDetails } from '../library/details';
import { tabInfo, type LibraryTab } from '../library/tabs';
import { selection } from '../selection';
import { useLibraryData } from '../shell/libraryData';
import { NAV } from '../shell/nav';
import { navigate } from '../shell/routes';

const loadActivity = () => library.activity(8);
const loadPrinters = () => printerApi.list();

/** Show one model: select it and open its details (the grid stays as it is). */
function openModel(filePath: string) {
  selection.set([filePath]);
  void showModelDetails(filePath);
}

function showTab(tab: LibraryTab) {
  const info = tabInfo(tab);
  navigate('library');
  applyFilterChange(() => filterActions.setTab(info.printed, info.favorite));
}

const scanLibrary = () => NAV.flatMap((section) => section.items).find((item) => item.id === 'scan')?.run?.();

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
  } catch { /* storage full or blocked: render again next time */ }
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
    pickHero().then((found) => { if (live) setPick(found); }, () => { if (live) setPick(null); });
    return () => { live = false; };
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
    return () => { live = false; };
  }, [pick]);

  if (!pick && pick !== undefined) return null;
  const name = pick ? cardTitle(pick.model) : '';
  return (
    <figure className="jp-hero__figure">
      {state === 'done' && png
        ? <img className="jp-hero__render" src={png} alt={`3D render of ${name}`} />
        : state === 'loading' ? <Skeleton className="jp-hero__render-skeleton" radius="lg" /> : <Box className="jp-hero__fallback" size={96} aria-hidden="true" />}
      {pick && (
        <figcaption>
          <button type="button" className="jp-hero__caption" onClick={() => openModel(pick.model.filePath)}
            title={`Show ${name}`}>
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
  if (counts.printing) return `${counts.printing} ${counts.printing === 1 ? 'model is' : 'models are'} printing${counts.queued ? `, ${counts.queued} more in the queue` : ''}.`;
  if (inQueue) return `${inQueue} ${inQueue === 1 ? 'model is' : 'models are'} waiting in the queue.`;
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const added = (activity || []).filter((item) => item.kind === 'added' && Date.parse(item.at) >= weekAgo)
    .reduce((sum, item) => sum + (item.kind === 'added' ? item.count : 0), 0);
  if (added) return `${added} new ${added === 1 ? 'model' : 'models'} this week.`;
  return 'Your 3D printing library at a glance.';
}

function Hero({ counts, activity }: { counts: LibraryCounts | null; activity: ActivityItem[] | null }) {
  const [hour] = useState(() => new Date().getHours());
  const figure = (value: number | undefined) => (value == null ? <Skeleton width={44} height={20} /> : value.toLocaleString());
  return (
    <section className="jp-hero" aria-labelledby="jp-hero-title">
      <div className="jp-hero__text">
        <h1 className="jp-hero__title" id="jp-hero-title">{greeting(hour)}</h1>
        <p className="jp-hero__subtitle">{summary(counts, activity)}</p>
        <div className="jp-hero__stats">
          <StatCard icon={Box} tone="accent" value={figure(counts?.models)} label="Models" onClick={() => showTab('all')} />
          <StatCard icon={CheckCircle2} tone="success" value={figure(counts?.printed)} label="Printed" onClick={() => showTab('printed')} />
          <StatCard icon={Clock} tone="warning" value={figure(counts ? counts.queued + counts.printing : undefined)} label="In Queue" onClick={() => showTab('queue')} />
          <StatCard icon={PrinterIcon} tone="violet" value={figure(counts?.printers)} label="Printers" onClick={() => navigate('printers')} />
        </div>
      </div>
      <HeroPicture />
    </section>
  );
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
        <button type="button" className="jp-activity" onClick={() => {
          navigate('library');
          applyFilterChange(() => filterActions.showAddedSince(`${item.day}T00:00:00.000Z`));
        }}>
          <span className="jp-activity__icon jp-tone--accent"><PlusCircle size={18} aria-hidden="true" /></span>
          <span className="jp-activity__text">
            <span className="jp-activity__title">{item.count.toLocaleString()} new {item.count === 1 ? 'model' : 'models'} added</span>
            <span className="jp-activity__meta">Added to the library • {timeAgo(item.at)}</span>
          </span>
        </button>
      </li>
    );
  }
  const outcome = OUTCOME[item.outcome] || OUTCOME.printed;
  const Icon = outcome.icon;
  const name = cardTitle({ filePath: item.filePath, fileName: item.fileName });
  const meta = [item.printer, item.filaments[0], timeAgo(item.at)].filter(Boolean).join(' • ');
  return (
    <li>
      <button type="button" className="jp-activity" onClick={() => openModel(item.filePath)}>
        <span className={`jp-activity__icon jp-tone--${outcome.tone}`}><Icon size={18} aria-hidden="true" /></span>
        <span className="jp-activity__text">
          <span className="jp-activity__title">{name}{item.quantity > 1 ? ` ×${item.quantity}` : ''} {outcome.verb}</span>
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
        <div className="jp-home__skeleton"><Skeleton height={36} /><Skeleton height={36} /><Skeleton height={36} /></div>
      ) : !activity.length ? (
        <EmptyState icon={Library} title="Nothing yet" action={<Button icon={ScanSearch} onClick={scanLibrary}>Scan Library</Button>}>
          Scanned models and logged prints show up here.
        </EmptyState>
      ) : (
        <ul className="jp-activity-list">{activity.slice(0, 4).map((item) => <ActivityRow key={`${item.kind}:${item.kind === 'print' ? item.id : item.day}`} item={item} />)}</ul>
      )}
    </Panel>
  );
}

// ---- Your Printers (spec §14, without live state) ------------------------------------------

function PrinterRow({ printer }: { printer: Printer }) {
  const due = Number(printer.due_reminders_count) || 0;
  const prints = Number(printer.total_prints) || 0;
  const kind = [printer.manufacturer, printer.model].filter(Boolean).join(' ') || printer.printer_type || '';
  return (
    <li className="jp-printer">
      <span className="jp-printer__icon"><PrinterIcon size={20} aria-hidden="true" /></span>
      <button type="button" className="jp-printer__text" onClick={() => navigate('printers', String(printer.id))} title={`Show ${printer.nickname}`}>
        <span className="jp-printer__name">{printer.nickname}</span>
        {kind && <span className="jp-printer__meta">{kind}</span>}
      </button>
      {due > 0
        ? <StatusBadge tone="warning" icon={Wrench}>Maintenance due</StatusBadge>
        : <span className="jp-printer__prints">{prints.toLocaleString()} {prints === 1 ? 'print' : 'prints'}</span>}
      {printer.web_url && /^https?:\/\//i.test(printer.web_url) && (
        <a className="jp-printer__link" href={printer.web_url} target="_blank" rel="noopener noreferrer"
          aria-label={`Open ${printer.nickname}'s web page`} title={`Open ${printer.web_url}`}>
          <ExternalLink size={16} aria-hidden="true" />
        </a>
      )}
    </li>
  );
}

function YourPrinters({ list }: { list: Printer[] | null }) {
  const manage = () => navigate('printers');
  return (
    <Panel title="Your Printers" labelledBy="jp-printers-title" className="jp-home__panel" action={{ label: 'Manage', onClick: manage }}>
      {!list ? (
        <div className="jp-home__skeleton"><Skeleton height={36} /><Skeleton height={36} /><Skeleton height={36} /></div>
      ) : !list.length ? (
        <EmptyState icon={PrinterIcon} title="No printers yet" action={<Button icon={PrinterIcon} onClick={() => window.openPrinterManagement?.({ action: 'add' })}>Add a Printer</Button>}>
          Add your printers to keep their web pages and maintenance in one place.
        </EmptyState>
      ) : (
        <ul className="jp-printer-list">{list.slice(0, 4).map((printer) => <PrinterRow key={printer.id} printer={printer} />)}</ul>
      )}
    </Panel>
  );
}

/**
 * The Home dashboard above "Your Library" (spec §10-§14): greeting, four figures and a cyan
 * render of a library model; Recent Activity; Your Printers. Real data only (docs/redesign-5.md).
 */
export function HomeDashboard() {
  const counts = useLibraryData<LibraryCounts>(library.counts);
  const activity = useLibraryData<ActivityItem[]>(loadActivity);
  const list = useLibraryData<Printer[]>(loadPrinters);
  return (
    <div className="jp-home">
      <Hero counts={counts} activity={activity} />
      <div className="jp-home__panels">
        <RecentActivity activity={activity} />
        <YourPrinters list={list} />
      </div>
    </div>
  );
}
