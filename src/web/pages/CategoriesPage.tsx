import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ChevronRight, Library, Shapes, Sparkles, Square, Tags, WandSparkles } from 'lucide-react';
import { categories as categoryApi, type Category, type CategoryScan } from '../api';
import { Button, IconButton } from '../components/Button';
import { EmptyState, Panel, ProgressBar, Skeleton } from '../components/Panel';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { askText, onServerEvent, showMessage } from '../page';
import { useCan } from '../session';
import { currentToken, subscribe as subscribePuter } from '../ai/puterAuth';
import { navigate } from '../shell/routes';

/** Show a Category's or Subcategory's models in the library. */
export function showCategory(name: string) {
  navigate('library');
  applyFilterChange(() => {
    filterActions.clearAll();
    filterActions.search('category', name);
  });
}

const SOURCE_LABELS: Record<string, string> = {
  site: 'from the site they came from',
  folder: 'from their folder names',
  tag: 'from their tags',
  name: 'from their names',
  ai: 'by the AI'
};

const models = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'model' : 'models'}`;

/** What a Categorize Library run did, one line each. */
export function scanSummary(job: CategoryScan): string[] {
  const lines: string[] = [];
  if (!job.total) return ['Every model already has a Category and a Subcategory.'];
  const placed = Object.entries(job.placed).filter(([, n]) => n > 0);
  for (const [source, n] of placed) lines.push(`${models(n)} placed ${SOURCE_LABELS[source] || source}.`);
  if (!placed.length && job.phase === 'done') lines.push('Nothing about the models pointed to a category.');
  if (job.useAi && job.aiTotal) {
    lines.push(`The AI looked at ${models(job.aiDone - job.noPicture)}${job.noPicture ? ` (${models(job.noPicture)} without a picture skipped)` : ''}.`);
  }
  if (job.left && job.phase === 'done') lines.push(`${models(job.left)} still without a Subcategory.`);
  if (job.error) lines.push(`Stopped: ${job.error}`);
  return lines;
}

/** A Category with its Subcategories (list order). */
export interface CategoryGroup {
  category: Category;
  subcategories: Category[];
}

export function groupCategories(list: Category[]): CategoryGroup[] {
  return list.filter((c) => !c.parent_id).map((category) => ({ category, subcategories: list.filter((c) => c.parent_id === category.id) }));
}

function Row({ category, max, canEdit, sub }: { category: Category; max: number; canEdit: boolean; sub?: boolean }) {
  async function editWords() {
    const words = await askText(
      `Words for ${category.name}`,
      'Without the AI, Categorize Library puts a model here when one of these words is in its folder names, tags or name. Separate them with commas.',
      category.keywords.join(', ')
    );
    if (words === null) return;
    await categoryApi.update(category.id, { keywords: words }).catch((error) => showMessage('Error', error.message));
  }

  const share = max > 0 && category.model_count > 0 ? Math.max(2, Math.round((category.model_count / max) * 100)) : 0;
  return (
    <div className={`jp-tag-row jp-category-row${sub ? ' is-sub' : ''}`} data-category-name={category.name}>
      <div className="jp-tag-row__main">
        <button
          type="button"
          className="jp-tag-row__name jp-category-row__name"
          title={`Show the models in ${category.name}`}
          disabled={!category.model_count}
          onClick={() => showCategory(category.name)}
        >
          <span className="jp-category-row__title">{category.name}</span>
          {sub && category.keywords.length > 0 && <span className="jp-meta jp-category-row__words">{category.keywords.join(', ')}</span>}
        </button>
        <span className="jp-tag-row__count">{category.model_count ? models(category.model_count) : 'Empty'}</span>
      </div>
      <span className="jp-tag-row__bar" aria-hidden="true">
        <span style={{ width: `${share}%` }} />
      </span>
      <span className="jp-tag-row__actions">
        <IconButton
          size="sm"
          icon={Library}
          label={`Show the models in ${category.name}`}
          disabled={!category.model_count}
          onClick={() => showCategory(category.name)}
        />
        {canEdit && <IconButton size="sm" icon={Tags} label={`Words for ${category.name}`} onClick={() => void editWords()} />}
      </span>
    </div>
  );
}

/** Categorize Library: start it (with or without the AI, or for every model again), follow it, and see what the AI placed. */
function ScanPanel({ uncategorized }: { uncategorized: number }) {
  const [job, setJob] = useState<CategoryScan | null>(null);
  const [serviceReady, setServiceReady] = useState(false);
  const [aiService, setAiService] = useState('');
  // Puter runs in this browser: without its sign-in here, the AI step would wait for one.
  const puterSignedIn = useSyncExternalStore(subscribePuter, () => !!currentToken());
  const puterMissing = aiService === 'puter' && !puterSignedIn;
  const aiReady = serviceReady && !puterMissing;
  const [useAi, setUseAi] = useState(true);
  const [again, setAgain] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    categoryApi.scan().then(
      (result) => {
        setJob(result.job);
        setServiceReady(result.aiReady);
        setAiService(result.aiService || '');
      },
      () => {}
    );
  }, []);

  useEffect(() => {
    load();
    return onServerEvent('category-scan', load);
  }, [load]);

  async function start() {
    setStarting(true);
    try {
      const result = await categoryApi.startScan(useAi && aiReady, again);
      if ('busy' in result) await showMessage('Categorize Library', 'Categorize Library is already running.');
      load();
    } catch (error) {
      await showMessage('Could not start', error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }

  async function close() {
    await categoryApi.dismissScan().catch(() => {});
    load();
  }

  if (job?.running) {
    const ai = job.phase === 'ai';
    return (
      <Panel className="jp-category-scan" title="Categorize Library">
        <p className="jp-meta" id="jp-category-scan-progress">
          {job.stopping
            ? 'Stopping…'
            : ai
              ? `Asking the AI about ${models(job.aiTotal)}… ${job.aiDone} of ${job.aiTotal}`
              : `Looking at ${models(job.total)}… ${job.processed} of ${job.total}`}
        </p>
        <ProgressBar value={ai ? job.aiDone : job.processed} max={(ai ? job.aiTotal : job.total) || 1} label="Categorize Library progress" />
        <div className="jp-category-scan__buttons">
          <Button icon={Square} disabled={job.stopping} onClick={() => void categoryApi.stopScan()}>
            Stop
          </Button>
        </div>
      </Panel>
    );
  }

  if (job) {
    return (
      <Panel className="jp-category-scan" title="Categorize Library">
        <ul className="jp-category-scan__summary" id="jp-category-scan-summary">
          {scanSummary(job).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {job.aiPlaced.length > 0 && (
          <details className="jp-category-placed" id="jp-category-ai-placed">
            <summary>What the AI placed ({job.aiPlaced.length})</summary>
            <p className="jp-meta">Saved already. Open a model to change its place with Edit.</p>
            <ul className="jp-category-placed__list">
              {job.aiPlaced.map((placed) => (
                <li key={placed.filePath}>
                  <button type="button" className="jp-link-button" title={placed.filePath} onClick={() => navigate('model', placed.filePath)}>
                    {placed.fileName}
                  </button>
                  <span className="jp-meta">
                    {placed.category} › {placed.subcategory}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <div className="jp-category-scan__buttons">
          <Button id="jp-category-scan-close" onClick={() => void close()}>
            Close
          </Button>
        </div>
      </Panel>
    );
  }

  const aiNote =
    puterMissing && serviceReady ? (
      <>
        {' '}
        <button type="button" className="jp-link-button" onClick={() => window.openAiConfig?.()}>
          Sign in to Puter
        </button>{' '}
        first: the AI step runs through your Puter account in this browser.
      </>
    ) : !serviceReady ? (
      <>
        {' '}
        <button type="button" className="jp-link-button" onClick={() => window.openAiConfig?.()}>
          Set up the AI service
        </button>{' '}
        first.
      </>
    ) : null;
  return (
    <section className="jp-card jp-category-scan jp-category-scan--idle" aria-label="Categorize Library">
      <div className="jp-category-scan__row">
        <div className="jp-category-scan__text">
          <strong>{uncategorized ? `${models(uncategorized)} without a Subcategory yet` : 'Every model has its place'}</strong>
          <span className="jp-meta">
            {uncategorized
              ? 'Categorize Library places them: the category MakerWorld, Printables or Thingiverse gives (free), then the AI, then words in their names.'
              : 'Categorize Library can sort every model again.'}
          </span>
        </div>
        <Button
          variant={uncategorized ? 'primary' : 'secondary'}
          icon={WandSparkles}
          id="jp-category-scan-start"
          disabled={starting || (!uncategorized && !again && !(useAi && aiReady))}
          onClick={() => void start()}
        >
          Categorize Library
        </Button>
      </div>
      <details className="jp-category-scan__options" id="jp-category-scan-options">
        <summary>Options</summary>
        <label className="jp-category-scan__ai">
          <input type="checkbox" checked={useAi && aiReady} disabled={!aiReady} onChange={(event) => setUseAi(event.target.checked)} />
          <span>
            Use the AI for the rest: it looks at each model's picture (uses your AI service and its costs). Without it, words in folder names, tags and names
            place what they can.
            {aiNote}
          </span>
        </label>
        <label className="jp-category-scan__ai">
          <input type="checkbox" id="jp-category-scan-again" checked={again} onChange={(event) => setAgain(event.target.checked)} />
          <span>Sort every model again (not the ones you placed yourself in Edit).</span>
        </label>
      </details>
    </section>
  );
}

/**
 * Categories: every model has one place, a Category and one of its Subcategories, from a fixed
 * list (MakerWorld's). Each shows how many models it holds; editors change the words Categorize
 * Library looks for and run Categorize Library. AI Tagging also places the models it tags.
 */
export function CategoriesPage() {
  const canEdit = useCan('editor');
  const [data, setData] = useState<{ categories: Category[]; uncategorized: number } | null>(null);
  /** Categories and Subcategories without models are hidden unless asked for. */
  const [showEmpty, setShowEmpty] = useState(false);

  const load = useCallback(() => {
    categoryApi.list().then(setData, () => {});
  }, []);

  useEffect(() => {
    load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, 500);
    };
    const offs = [onServerEvent('categories-changed', soon), onServerEvent('refresh-grid', soon), onServerEvent('category-scan', soon)];
    return () => {
      if (timer) clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, [load]);

  const allGroups = data ? groupCategories(data.categories) : null;
  const groups = allGroups
    ? showEmpty
      ? allGroups
      : allGroups
          .filter((group) => group.category.model_count > 0)
          .map((group) => ({ ...group, subcategories: group.subcategories.filter((sub) => sub.model_count > 0) }))
    : null;
  const hiddenCount = allGroups && groups ? allGroups.length - groups.length : 0;
  const max = Math.max(0, ...(data?.categories || []).filter((c) => c.parent_id).map((c) => c.model_count));

  return (
    <div className="jp-page__inner jp-tags jp-categories">
      <header className="jp-page__header jp-queue__header">
        <div>
          <h1 className="jp-page-title">Categories</h1>
          <p className="jp-meta">
            {data && allGroups
              ? `${allGroups.length} categories, ${data.categories.length - allGroups.length} subcategories • ${models(data.uncategorized)} without a Subcategory`
              : 'Every model has a Category and a Subcategory.'}
          </p>
        </div>
        {canEdit && (
          <Button icon={Sparkles} onClick={() => window.openAiConfig?.()}>
            AI Service
          </Button>
        )}
      </header>

      {canEdit && data && <ScanPanel uncategorized={data.uncategorized} />}

      {!groups ? (
        <div className="jp-home__skeleton">
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : !allGroups?.length ? (
        <Panel>
          <EmptyState icon={Shapes} title="No categories" />
        </Panel>
      ) : (
        <>
          <div className="jp-categories__bar">
            <span className="jp-meta">{showEmpty ? 'Every Category and Subcategory' : 'Categories with models'}</span>
            <label className="jp-categories__empty-toggle">
              <input type="checkbox" id="jp-categories-show-empty" checked={showEmpty} onChange={(event) => setShowEmpty(event.target.checked)} />
              <span>Show empty ones{!showEmpty && hiddenCount ? ` (${hiddenCount} more)` : ''}</span>
            </label>
          </div>
          {!groups.length && (
            <Panel>
              <EmptyState icon={Shapes} title="No models have a place yet">
                Categorize Library above gives each model its Category and Subcategory.
              </EmptyState>
            </Panel>
          )}
          <ul className="jp-card jp-tags__list" aria-label="Categories" id="jp-categories-list">
            {groups.map(({ category, subcategories }) => (
              <li key={category.id} className="jp-category-group">
                <details>
                  <summary aria-label={`${category.name}: its subcategories`}>
                    <ChevronRight size={16} aria-hidden="true" className="jp-category-group__chevron" />
                    <Row category={category} max={0} canEdit={canEdit} />
                  </summary>
                  <div className="jp-category-group__subs">
                    {subcategories.map((sub) => (
                      <Row key={sub.id} category={sub} max={max} canEdit={canEdit} sub />
                    ))}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** A model's place, "Toys & Games › Puzzles", each part showing its models. */
export function CategoryPlace({ names, id }: { names: string[]; id?: string }) {
  return (
    <span className="jp-details__categories jp-category-place" id={id}>
      {names.map((name, index) => (
        <span key={name} className="jp-category-place__part">
          {index > 0 && (
            <span className="jp-meta" aria-hidden="true">
              ›
            </span>
          )}
          <button type="button" className="jp-chip" title={`Show the models in ${name}`} onClick={() => showCategory(name)}>
            {name}
          </button>
        </span>
      ))}
    </span>
  );
}
