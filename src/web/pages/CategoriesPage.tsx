import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Library, Pencil, Plus, Shapes, Sparkles, Square, Tags, Trash2, WandSparkles, X } from 'lucide-react';
import { categories as categoryApi, type Category, type CategoryScan } from '../api';
import { Button, IconButton, cx } from '../components/Button';
import { EmptyState, Panel, ProgressBar, Skeleton } from '../components/Panel';
import { applyFilterChange } from '../filters/search';
import { filterActions } from '../filters/store';
import { askText, onServerEvent, showMessage } from '../page';
import { useCan } from '../session';
import { navigate } from '../shell/routes';

/** Show a category's models in the library. */
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
  name: 'from their names'
};

const models = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'model' : 'models'}`;

/** What a Categorize Library run did, one line each. */
export function scanSummary(job: CategoryScan): string[] {
  const lines: string[] = [];
  if (!job.total) return ['Every model is already in a category.'];
  const placed = Object.entries(job.placed).filter(([, n]) => n > 0);
  for (const [source, n] of placed) lines.push(`${models(n)} placed ${SOURCE_LABELS[source] || source}.`);
  if (!placed.length && job.phase === 'done') lines.push('Nothing about the models pointed to a category.');
  if (job.useAi && job.aiTotal) {
    lines.push(`The AI looked at ${models(job.aiDone - job.noPicture)}${job.noPicture ? ` (${models(job.noPicture)} without a picture skipped)` : ''}.`);
  } else if (job.left && job.phase === 'done') {
    lines.push(`${models(job.left)} still in no category.`);
  }
  if (job.error) lines.push(`Stopped: ${job.error}`);
  return lines;
}

function CategoryRow({ category, max, canEdit }: { category: Category; max: number; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(category.name);
  const committing = useRef(false);

  async function commit() {
    if (committing.current) return;
    const name = draft.trim();
    if (!name || name === category.name) {
      setDraft(category.name);
      setEditing(false);
      return;
    }
    committing.current = true;
    try {
      await categoryApi.update(category.id, { name });
    } catch (error) {
      setDraft(category.name);
      await showMessage('Could not rename', error instanceof Error ? error.message : String(error));
    }
    committing.current = false;
    setEditing(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      committing.current = true;
      setDraft(category.name);
      setEditing(false);
      queueMicrotask(() => {
        committing.current = false;
      });
    }
  }

  async function editWords() {
    const words = await askText(
      `Words for ${category.name}`,
      'Categorize Library puts a model in this category when one of these words is in its folder names, tags or name. Separate them with commas.',
      category.keywords.join(', ')
    );
    if (words === null) return;
    await categoryApi.update(category.id, { keywords: words }).catch((error) => showMessage('Error', error.message));
  }

  async function remove() {
    const answer = await showMessage(
      'Delete category',
      `Delete ${category.name}?${category.model_count ? ` Its ${models(category.model_count)} stay in the library and in their other categories.` : ''}`,
      ['Delete', 'Cancel']
    );
    if (answer === 'Delete') await categoryApi.remove(category.id).catch((error) => showMessage('Error', error.message));
  }

  const share = max > 0 && category.model_count > 0 ? Math.max(2, Math.round((category.model_count / max) * 100)) : 0;
  return (
    <li className="jp-tag-row jp-category-row" data-category-name={category.name}>
      <div className="jp-tag-row__main">
        {editing ? (
          <input
            className="jp-tag-row__input"
            aria-label={`Rename category ${category.name}`}
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onFocus={(event) => event.target.select()}
            onBlur={() => void commit()}
          />
        ) : (
          <button
            type="button"
            className="jp-tag-row__name jp-category-row__name"
            title={`Show the models in ${category.name}`}
            disabled={!category.model_count}
            onClick={() => showCategory(category.name)}
          >
            <span className="jp-category-row__title">{category.name}</span>
            {category.keywords.length > 0 && <span className="jp-meta jp-category-row__words">{category.keywords.join(', ')}</span>}
          </button>
        )}
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
        {canEdit && (
          <>
            <IconButton
              size="sm"
              icon={Pencil}
              label={`Rename ${category.name}`}
              onClick={() => {
                setDraft(category.name);
                setEditing(true);
              }}
            />
            <IconButton size="sm" icon={Tags} label={`Words for ${category.name}`} onClick={() => void editWords()} />
            <IconButton size="sm" icon={Trash2} label={`Delete ${category.name}`} onClick={() => void remove()} />
          </>
        )}
      </span>
    </li>
  );
}

/** The AI's picks, waiting for a yes: each model with its picked categories, which can be switched off. */
function Review({ job, onDone }: { job: CategoryScan; onDone: () => void }) {
  const [off, setOff] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const key = (filePath: string, name: string) => `${filePath}\n${name}`;
  const toggle = (filePath: string, name: string) =>
    setOff((now) => {
      const next = new Set(now);
      if (next.has(key(filePath, name))) next.delete(key(filePath, name));
      else next.add(key(filePath, name));
      return next;
    });

  async function send(picks: CategoryScan['suggestions']) {
    setSaving(true);
    try {
      await categoryApi.applySuggestions(
        picks.map((s) => ({ filePath: s.filePath, categories: s.categories.filter((name) => !off.has(key(s.filePath, name))) }))
      );
      onDone();
    } catch (error) {
      await showMessage('Error', error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="jp-category-review" id="jp-category-review">
      <h3 className="jp-panel-title">The AI's picks ({job.suggestions.length})</h3>
      <p className="jp-meta">Click a category to leave it out. Nothing is saved until you apply.</p>
      <ul className="jp-category-review__list">
        {job.suggestions.map((s) => (
          <li key={s.filePath} className="jp-category-review__row">
            <span className="jp-category-review__name" title={s.filePath}>
              {s.fileName}
            </span>
            <span className="jp-category-review__chips">
              {s.categories.map((name) => {
                const kept = !off.has(key(s.filePath, name));
                return (
                  <button
                    key={name}
                    type="button"
                    className={cx('jp-chip', kept && 'is-selected')}
                    aria-pressed={kept}
                    onClick={() => toggle(s.filePath, name)}
                  >
                    {name}
                  </button>
                );
              })}
            </span>
            <IconButton size="sm" icon={X} label={`Skip ${s.fileName}`} disabled={saving} onClick={() => void send([{ ...s, categories: [] }])} />
          </li>
        ))}
      </ul>
      <div className="jp-category-scan__buttons">
        <Button variant="primary" id="jp-category-apply" disabled={saving} onClick={() => void send(job.suggestions)}>
          Apply All
        </Button>
      </div>
    </div>
  );
}

/** Categorize Library: start it (with or without the AI), follow it, and review the AI's picks. */
function ScanPanel({ uncategorized }: { uncategorized: number }) {
  const [job, setJob] = useState<CategoryScan | null>(null);
  const [aiReady, setAiReady] = useState(false);
  const [useAi, setUseAi] = useState(true);
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    categoryApi.scan().then(
      (result) => {
        setJob(result.job);
        setAiReady(result.aiReady);
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
      const result = await categoryApi.startScan(useAi && aiReady);
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
        {job.suggestions.length > 0 ? (
          <Review key={job.id} job={job} onDone={load} />
        ) : (
          <div className="jp-category-scan__buttons">
            <Button id="jp-category-scan-close" onClick={() => void close()}>
              Close
            </Button>
          </div>
        )}
      </Panel>
    );
  }

  return (
    <Panel className="jp-category-scan" title="Categorize Library">
      <p className="jp-meta">
        Puts the {models(uncategorized)} in no category into categories. First it uses what the models say about themselves, which is free: the category
        MakerWorld, Printables or Thingiverse gives them, else a category's words in their folder names, tags or name. Those are saved right away.
      </p>
      <label className="jp-category-scan__ai">
        <input type="checkbox" checked={useAi && aiReady} disabled={!aiReady} onChange={(event) => setUseAi(event.target.checked)} />
        <span>
          Then ask the AI service about the models left (it looks at each one's picture; uses the AI Tagging service and its costs). You review its picks before
          they are saved.
          {!aiReady && (
            <>
              {' '}
              <button type="button" className="jp-link-button" onClick={() => window.openAiConfig?.()}>
                Set up the AI service
              </button>{' '}
              first.
            </>
          )}
        </span>
      </label>
      <div className="jp-category-scan__buttons">
        <Button variant="primary" icon={WandSparkles} id="jp-category-scan-start" disabled={starting || !uncategorized} onClick={() => void start()}>
          Categorize Library
        </Button>
      </div>
    </Panel>
  );
}

/**
 * Categories: shelves for the models (MakerWorld's main categories to start), with how many
 * models each holds; a model can be in several. Editors make, rename and delete them, change the
 * words Categorize Library looks for, and run Categorize Library.
 */
export function CategoriesPage() {
  const canEdit = useCan('editor');
  const [data, setData] = useState<{ categories: Category[]; uncategorized: number } | null>(null);
  const [newName, setNewName] = useState('');

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

  async function add() {
    try {
      await categoryApi.create(newName);
      setNewName('');
    } catch (error) {
      await showMessage('Could not create', error instanceof Error ? error.message : String(error));
    }
  }

  const list = data?.categories || null;
  const max = Math.max(0, ...(list || []).map((c) => c.model_count));

  return (
    <div className="jp-page__inner jp-tags jp-categories">
      <header className="jp-page__header jp-queue__header">
        <div>
          <h1 className="jp-page-title">Categories</h1>
          <p className="jp-meta">
            {data
              ? `${data.categories.length} ${data.categories.length === 1 ? 'category' : 'categories'} • ${models(data.uncategorized)} in none`
              : 'Shelves for your models; a model can be on several.'}
          </p>
        </div>
        {canEdit && (
          <Button icon={Sparkles} onClick={() => window.openAiConfig?.()}>
            AI Service
          </Button>
        )}
      </header>

      {canEdit && data && <ScanPanel uncategorized={data.uncategorized} />}

      {canEdit && (
        <div className="jp-tags__toolbar">
          <form
            className="jp-tags__create"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <input
              id="jp-new-category"
              className="jp-input"
              placeholder="New category name"
              aria-label="New category name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <Button type="submit" variant="primary" icon={Plus} disabled={!newName.trim()}>
              Create
            </Button>
          </form>
        </div>
      )}

      {!list ? (
        <div className="jp-home__skeleton">
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : !list.length ? (
        <Panel>
          <EmptyState icon={Shapes} title="No categories">
            Create a category above.
          </EmptyState>
        </Panel>
      ) : (
        <ul className="jp-card jp-tags__list" aria-label="Categories" id="jp-categories-list">
          {list.map((category) => (
            <CategoryRow key={category.id} category={category} max={max} canEdit={canEdit} />
          ))}
        </ul>
      )}
    </div>
  );
}
