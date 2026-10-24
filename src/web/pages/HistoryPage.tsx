import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileClock, Folder, Globe, History, RotateCcw, Search, Trash2 } from 'lucide-react';
import { callAction, downloadUrl, LIBRARY_CHANGED } from '../api';
import { Button, IconButton } from '../components/Button';
import { EmptyState, Panel, Skeleton } from '../components/Panel';
import { formatFileSize } from '../library/paths';
import { onServerEvent, showMessage } from '../page';
import { useCan } from '../session';
import { navigate } from '../shell/routes';
import { FIELD_LABELS, shownValue, when } from './ModelHistory';

interface HistoryModel {
  id: number;
  filePath: string;
  fileName: string | null;
}

/** get-all-history (src/server/model-versions.js listAll). */
export type HistoryEntry =
  | { kind: 'change'; id: number; at: string; by: string | null; field: string; oldValue: string | null; newValue: string | null; model: HistoryModel }
  | { kind: 'version'; id: number; at: string; by: string | null; fileName: string; size: number | null; note: string | null; model: HistoryModel }
  | {
      kind: 'detail';
      id: number;
      at: string;
      by: string | null;
      /** A folder's notes, or the site details of a model link (the Edit dialog). */
      scope: 'folder' | 'site';
      target: string;
      label: string | null;
      field: string;
      oldValue: string | null;
      newValue: string | null;
    };

/** What a folder or site change is called (exported for tests). */
export function detailLabel(scope: string, field: string): string {
  if (scope === 'folder') return field === 'notes' ? 'Folder notes' : field;
  if (field.startsWith('profile:')) return 'Print profile name';
  const site: Record<string, string> = {
    title: 'Site title',
    description: 'Site description',
    designer: 'Site designer',
    license: 'Site license',
    categories: 'Site categories',
    tags: 'Site tags'
  };
  return site[field] || field;
}

const PAGE = 100;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const modelName = (model: HistoryModel) => (model.fileName || model.filePath.split(/[\\/]/).pop() || model.filePath).replace(/\.[a-z0-9]{2,6}$/i, '');

/** The day an entry is listed under: "Today", "Yesterday", else the date. */
export function dayOf(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

type Change = Extract<HistoryEntry, { kind: 'change' }>;

/** One line of the list: an entry, or several changes made to one model at once (Edit saves several fields). */
export type HistoryItem = { kind: 'one'; entry: HistoryEntry } | { kind: 'group'; entries: Change[] };

/** Changes to the same model, by the same person, within a minute of each other are one edit (newest first, as listed). */
export function groupEntries(entries: HistoryEntry[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const entry of entries) {
    const last = items[items.length - 1];
    const lastChange = last && (last.kind === 'group' ? last.entries[last.entries.length - 1] : last.entry.kind === 'change' ? last.entry : null);
    if (
      entry.kind === 'change' &&
      lastChange &&
      lastChange.model.filePath === entry.model.filePath &&
      lastChange.by === entry.by &&
      Math.abs(new Date(lastChange.at).getTime() - new Date(entry.at).getTime()) <= 60000
    ) {
      if (last.kind === 'group') last.entries.push(entry);
      else items[items.length - 1] = { kind: 'group', entries: [lastChange, entry] };
      continue;
    }
    items.push({ kind: 'one', entry });
  }
  return items;
}

/**
 * History (sidebar): every model's history in one list, newest first: the changes made to their
 * details (put a value back) and the earlier files kept by Upload New Version (download, put back,
 * delete). Each entry opens its model.
 */
export function HistoryPage() {
  const canEdit = useCan('editor');
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (text: string) => {
    try {
      const found = await callAction<{ entries: HistoryEntry[]; more: boolean }>('get-all-history', { limit: PAGE, search: text.trim() || null });
      setEntries(found.entries);
      setMore(found.more);
    } catch {
      setEntries([]);
      setMore(false);
    }
  }, []);

  useEffect(() => {
    void load(search);
    const again = () => void load(search);
    const off = onServerEvent('model-history-changed', again);
    window.addEventListener(LIBRARY_CHANGED, again);
    return () => {
      off();
      window.removeEventListener(LIBRARY_CHANGED, again);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function loadMore() {
    if (!entries?.length) return;
    setLoadingMore(true);
    try {
      const found = await callAction<{ entries: HistoryEntry[]; more: boolean }>('get-all-history', {
        limit: PAGE,
        search: search.trim() || null,
        before: entries[entries.length - 1].at
      });
      setEntries([...entries, ...found.entries]);
      setMore(found.more);
    } finally {
      setLoadingMore(false);
    }
  }

  async function act(title: string, question: string, button: string, work: () => Promise<unknown>) {
    if ((await showMessage(title, question, [button, 'Cancel'])) !== button) return;
    try {
      await work();
    } catch (error) {
      await showMessage(title, errorText(error));
    }
    void load(search);
  }

  async function download(entry: Extract<HistoryEntry, { kind: 'version' }>) {
    try {
      const { filePath: copy } = await callAction<{ filePath: string }>('download-model-version', entry.id);
      const link = document.createElement('a');
      link.href = downloadUrl(copy);
      link.download = entry.fileName;
      link.click();
    } catch (error) {
      await showMessage('Download', errorText(error));
    }
  }

  let lastDay = '';
  return (
    <div className="jp-page__inner jp-history-page" id="jp-history-page">
      <header className="jp-page__header jp-queue__header">
        <div>
          <h1 className="jp-page-title">History</h1>
          <p className="jp-meta">Every change to your models' details and every earlier file kept, newest first.</p>
        </div>
      </header>

      <div className="jp-history-page__search">
        <Search size={16} aria-hidden="true" />
        <input
          className="jp-input"
          id="jp-history-search"
          type="search"
          placeholder="Search by model, detail or value"
          aria-label="Search the history"
          value={search}
          onChange={(event) => {
            const text = event.target.value;
            setSearch(text);
            if (searchTimer.current) clearTimeout(searchTimer.current);
            searchTimer.current = setTimeout(() => void load(text), 300);
          }}
        />
      </div>

      {!entries ? (
        <div className="jp-home__skeleton">
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : !entries.length ? (
        <Panel>
          <EmptyState icon={History} title={search ? 'Nothing found' : 'No history yet'}>
            {search ? 'No entry matches the search.' : 'Changes to models (Edit, the details panel) and earlier files (New Version on a model page) show here.'}
          </EmptyState>
        </Panel>
      ) : (
        <ul className="jp-card jp-history-page__list" id="jp-history-list">
          {groupEntries(entries).map((item) => {
            if (item.kind === 'group') {
              const first = item.entries[0];
              const day = dayOf(first.at);
              const heading = day !== lastDay;
              lastDay = day;
              return (
                <li key={`group-${first.id}`} className="jp-history-page__entry is-group" data-kind="change">
                  {heading && <h2 className="jp-history-page__day">{day}</h2>}
                  <div className="jp-history-page__row">
                    <span className="jp-history-page__icon" aria-hidden="true">
                      <History size={16} />
                    </span>
                    <span className="jp-history__text">
                      <span>
                        <button type="button" className="jp-link-button" title={first.model.filePath} onClick={() => navigate('model', first.model.filePath)}>
                          {modelName(first.model)}
                        </button>
                        {` · ${item.entries.length} changes`}
                      </span>
                      <span className="jp-meta">
                        {when(first.at)}
                        {first.by ? ` · by ${first.by}` : ''}
                      </span>
                      <ul className="jp-history-page__changes">
                        {item.entries.map((change) => {
                          const label = FIELD_LABELS[change.field] || change.field;
                          return (
                            <li key={change.id}>
                              <span>
                                <strong>{label}</strong>: {shownValue(change.field, change.oldValue)} → {shownValue(change.field, change.newValue)}
                              </span>
                              {canEdit && (
                                <IconButton
                                  size="sm"
                                  icon={History}
                                  label={`Put the ${label.toLowerCase()} back`}
                                  onClick={() =>
                                    void act(
                                      'Put Back',
                                      `Put the ${label.toLowerCase()} back to ${shownValue(change.field, change.oldValue)}?`,
                                      'Put Back',
                                      () => callAction('undo-model-change', change.id)
                                    )
                                  }
                                />
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </span>
                  </div>
                </li>
              );
            }
            const entry = item.entry;
            const day = dayOf(entry.at);
            const heading = day !== lastDay;
            lastDay = day;
            const label =
              entry.kind === 'change' ? FIELD_LABELS[entry.field] || entry.field : entry.kind === 'detail' ? detailLabel(entry.scope, entry.field) : '';
            return (
              <li key={`${entry.kind}-${entry.id}`} className="jp-history-page__entry" data-kind={entry.kind}>
                {heading && <h2 className="jp-history-page__day">{day}</h2>}
                <div className="jp-history-page__row">
                  <span className="jp-history-page__icon" aria-hidden="true">
                    {entry.kind === 'change' ? (
                      <History size={16} />
                    ) : entry.kind === 'detail' ? (
                      entry.scope === 'folder' ? (
                        <Folder size={16} />
                      ) : (
                        <Globe size={16} />
                      )
                    ) : (
                      <FileClock size={16} />
                    )}
                  </span>
                  <span className="jp-history__text">
                    <span>
                      {entry.kind === 'detail' ? (
                        entry.scope === 'folder' ? (
                          <button type="button" className="jp-link-button" title={entry.target} onClick={() => navigate('folder', entry.target)}>
                            {entry.label || entry.target}
                          </button>
                        ) : (
                          <a className="jp-link-button" href={entry.target} target="_blank" rel="noopener noreferrer" title={entry.target}>
                            {entry.label || entry.target}
                          </a>
                        )
                      ) : (
                        <button type="button" className="jp-link-button" title={entry.model.filePath} onClick={() => navigate('model', entry.model.filePath)}>
                          {modelName(entry.model)}
                        </button>
                      )}
                      {entry.kind === 'change' || entry.kind === 'detail' ? (
                        <>
                          {' · '}
                          <strong>{label}</strong>: {shownValue(entry.field, entry.oldValue)} → {shownValue(entry.field, entry.newValue)}
                        </>
                      ) : (
                        <>
                          {' · '}
                          <strong>Earlier file</strong>: {entry.fileName}
                          {entry.size ? ` (${formatFileSize(entry.size)})` : ''}
                        </>
                      )}
                    </span>
                    <span className="jp-meta">
                      {when(entry.at)}
                      {entry.by ? ` · by ${entry.by}` : ''}
                      {entry.kind === 'version' && entry.note ? ` · ${entry.note}` : ''}
                    </span>
                  </span>
                  <span className="jp-history__actions">
                    {entry.kind === 'version' && <IconButton size="sm" icon={Download} label="Download this file" onClick={() => void download(entry)} />}
                    {canEdit && entry.kind === 'version' && (
                      <IconButton
                        size="sm"
                        icon={RotateCcw}
                        label="Put this file back"
                        onClick={() =>
                          void act('Put Back', `Put back the file of ${when(entry.at)}? The current file is kept in the history.`, 'Put Back', () =>
                            callAction('restore-model-version', entry.id)
                          )
                        }
                      />
                    )}
                    {canEdit && entry.kind === 'version' && (
                      <IconButton
                        size="sm"
                        icon={Trash2}
                        label="Delete this file"
                        onClick={() =>
                          void act('Delete', `Delete the file of ${when(entry.at)} for good?`, 'Delete', () => callAction('delete-model-version', entry.id))
                        }
                      />
                    )}
                    {canEdit && entry.kind === 'detail' && (
                      <IconButton
                        size="sm"
                        icon={History}
                        label={`Put the ${label.toLowerCase()} back`}
                        onClick={() =>
                          void act('Put Back', `Put the ${label.toLowerCase()} back to ${shownValue(entry.field, entry.oldValue)}?`, 'Put Back', () =>
                            callAction('undo-detail-change', entry.id)
                          )
                        }
                      />
                    )}
                    {canEdit && entry.kind === 'change' && (
                      <IconButton
                        size="sm"
                        icon={History}
                        label={`Put the ${label.toLowerCase()} back`}
                        onClick={() =>
                          void act('Put Back', `Put the ${label.toLowerCase()} back to ${shownValue(entry.field, entry.oldValue)}?`, 'Put Back', () =>
                            callAction('undo-model-change', entry.id)
                          )
                        }
                      />
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {more && (
        <div className="jp-history-page__more">
          <Button id="jp-history-more" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Show older'}
          </Button>
        </div>
      )}
    </div>
  );
}
