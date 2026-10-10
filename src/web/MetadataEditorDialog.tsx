import { useEffect, useMemo, useRef, useState } from 'react';
import { metadata, type MetadataEntry, type MetadataType } from './api';
import { Pencil, Trash2, Undo2 } from 'lucide-react';
import { Button, IconButton, cx } from './components/Button';
import { ModalDialog } from './components/ModalDialog';
import { lastUndoId, onUndoChange, recordUndo, undoLast, type UndoEntry } from './library/undo';
import { askText, exposeGlobal, showMessage } from './page';

declare global {
  interface Window {
    openMetadataEditor?: () => void;
  }
}

const TABS: { type: MetadataType; tab: string; heading: string; one: string }[] = [
  { type: 'designer', tab: 'Designer', heading: 'Designers', one: 'designer' },
  { type: 'parentModel', tab: 'Parent Model', heading: 'Parent Models', one: 'parent model' },
  { type: 'license', tab: 'License', heading: 'Licenses', one: 'license' }
];

const plural = (count: number) => `${count} model${count !== 1 ? 's' : ''}`;

/** After a change or its undo: the dialog (if open), the grid and the details panel show it. */
async function refreshAll(reload?: () => Promise<void>) {
  await reload?.();
  await window.refreshAfterMetadataChange?.();
}

/** The open dialog's reload, so an undo from the notice or Ctrl/Cmd+Z updates its list. */
let reloadOpenDialog: (() => Promise<void>) | null = null;

/** Make a Metadata Editor change undoable: `name` goes back on the models it changed. */
function recordMetadataUndo(label: string, type: MetadataType, name: string, current: string, modelIds: number[] | undefined) {
  if (!modelIds?.length) return;
  recordUndo(
    label,
    async () => {
      await metadata.restore({ type, name, current, modelIds });
      await refreshAll(reloadOpenDialog ?? undefined);
    },
    'metadata'
  );
}
const capitalize = (text: string) => text.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * One row per name for a type, sorted. Names that differ only in case are one row (the one
 * more models use).
 */
function rowsFor(entries: MetadataEntry[], type: MetadataType, search: string): MetadataEntry[] {
  const byName = new Map<string, MetadataEntry>();
  for (const entry of entries) {
    if (entry.type !== type) continue;
    const key = entry.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing || (entry.model_count || 0) > (existing.model_count || 0)) byName.set(key, entry);
  }
  const needle = search.trim().toLowerCase();
  return [...byName.values()].filter((entry) => !needle || entry.name.toLowerCase().includes(needle)).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Settings → Metadata Manager: rename (or merge) and clear designers, parent models and licenses
 * across the library. Registers window.openMetadataEditor.
 */
export function MetadataEditorDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [entries, setEntries] = useState<MetadataEntry[]>([]);
  const [type, setType] = useState<MetadataType>('designer');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  // The newest change made while the dialog is open, to undo here (the page's notice is behind the dialog).
  const [lastChange, setLastChange] = useState<UndoEntry | null>(null);
  // An undo still refreshing the page: the next one waits for it (undoLast ignores clicks meanwhile).
  const [undoing, setUndoing] = useState(false);
  const openedAt = useRef(0);

  useEffect(
    () =>
      onUndoChange((latest) => {
        setLastChange(latest && latest.kind === 'metadata' && latest.id > openedAt.current ? latest : null);
      }),
    []
  );

  async function reload() {
    try {
      setEntries(await metadata.list());
      setError('');
    } catch (reason) {
      console.error('Error loading metadata:', reason);
      setError('Error loading metadata');
    }
  }

  useEffect(
    () =>
      exposeGlobal('openMetadataEditor', () => {
        setType('designer');
        setSearch('');
        openedAt.current = lastUndoId();
        setLastChange(null);
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
        reload();
      }),
    []
  );

  const tab = TABS.find((candidate) => candidate.type === type) ?? TABS[0];
  const rows = useMemo(() => rowsFor(entries, type, search), [entries, type, search]);

  useEffect(() => {
    reloadOpenDialog = async () => {
      if (dialogRef.current?.open) await reload();
    };
    return () => {
      reloadOpenDialog = null;
    };
  }, []);

  const afterChange = () => refreshAll(reload);

  async function rename(entry: MetadataEntry) {
    const typed = await askText(`Rename ${capitalize(tab.one)}`, `Enter new name for "${entry.name}":`, entry.name);
    const newName = typed?.trim();
    if (!newName || newName === entry.name) return;
    const existing = entries.find((other) => other.type === type && other.name.toLowerCase() === newName.toLowerCase() && other.name !== entry.name);
    if (
      existing &&
      (await showMessage(
        'Merge Metadata',
        `A ${tab.one} named "${newName}" already exists. This will merge "${entry.name}" (${plural(entry.model_count)}) into "${newName}" (${plural(existing.model_count)}).`,
        ['Merge', 'Cancel']
      )) !== 'Merge'
    )
      return;
    try {
      const result = await metadata.rename(type, entry.name, newName);
      recordMetadataUndo(
        result?.merged ? `Merged the ${tab.one} "${entry.name}" into "${newName}"` : `Renamed the ${tab.one} "${entry.name}" to "${newName}"`,
        type,
        entry.name,
        newName,
        result?.modelIds
      );
      await afterChange();
      if (result?.merged) {
        await showMessage('Success', `Successfully merged "${entry.name}" into "${newName}". ${plural(result.updated ?? 0)} updated.`);
      }
    } catch (reason) {
      await showMessage('Error', reason instanceof Error ? reason.message : 'Failed to rename');
    }
  }

  async function remove(entry: MetadataEntry) {
    if ((await showMessage(`Delete ${capitalize(tab.one)}`, `Remove "${entry.name}" from ${plural(entry.model_count)}?`, ['Yes', 'No'])) !== 'Yes') return;
    try {
      const result = await metadata.remove(type, entry.name);
      recordMetadataUndo(`Removed the ${tab.one} "${entry.name}" from ${plural(result?.modelIds?.length ?? 0)}`, type, entry.name, '', result?.modelIds);
      await afterChange();
    } catch (reason) {
      console.error('Error deleting metadata:', reason);
      await showMessage('Error', 'Failed to delete');
    }
  }

  return (
    <ModalDialog
      id="metadata-editor-dialog"
      title="Metadata Editor"
      dialogRef={dialogRef}
      plain
      className="jp-mgr"
      headerClassName="jp-mgr__header"
      headerRowClassName="jp-mgr__header-row"
      footerClassName="jp-mgr__footer dialog-buttons"
      description={
        <>
          <p className="jp-meta">Rename, merge or clear a designer, parent model or license on every model that has it.</p>
          <div className="jp-tabs jp-mgr__tabs" role="tablist" aria-label="Metadata">
            {TABS.map((candidate) => (
              <button
                key={candidate.type}
                type="button"
                role="tab"
                aria-selected={candidate.type === type}
                className={cx('jp-tab metadata-tab', candidate.type === type && 'is-selected active')}
                data-type={candidate.type}
                onClick={() => {
                  setType(candidate.type);
                  setSearch('');
                }}
              >
                <span>{candidate.heading}</span>
              </button>
            ))}
          </div>
        </>
      }
      footer={
        <Button id="metadata-editor-close" onClick={() => dialogRef.current?.close()}>
          Close
        </Button>
      }
    >
      <div className="jp-mgr__body">
        {lastChange && (
          <div className="metadata-editor-undo" role="status">
            <span>{lastChange.label}</span>
            <Button
              size="sm"
              id="metadata-editor-undo"
              icon={Undo2}
              disabled={undoing}
              onClick={async () => {
                setUndoing(true);
                try {
                  await undoLast(lastChange.id);
                } finally {
                  setUndoing(false);
                }
              }}
            >
              Undo
            </Button>
          </div>
        )}
        <section className="jp-mgr__section jp-mgr__section--grow">
          <div className="jp-mgr__toolbar">
            <div className="input-with-icon jp-mgr__search">
              <input
                type="text"
                id="metadata-editor-search"
                className="jp-input"
                placeholder={`Search ${tab.heading.toLowerCase()}`}
                aria-label={`Search ${tab.heading.toLowerCase()}`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button type="button" id="clear-metadata-search" className="icon-button" title="Clear search" onClick={() => setSearch('')}>
                ×
              </button>
            </div>
            <span className="jp-meta" id="metadata-type-label">{`${rows.length} ${rows.length === 1 ? tab.one : tab.heading.toLowerCase()}`}</span>
          </div>
          <div id="metadata-editor-list" className="jp-mgr__list jp-mgr__list--scroll">
            {error ? (
              <div className="jp-mgr__empty error-message">{error}</div>
            ) : rows.length === 0 ? (
              <div className="jp-mgr__empty no-metadata">No {tab.heading.toLowerCase()} found</div>
            ) : (
              rows.map((entry) => (
                <div key={entry.name} className="jp-mgr__row metadata-item">
                  <div className="jp-mgr__row-main">
                    <span className="jp-mgr__name metadata-name">{entry.name}</span>
                    <span className="jp-meta metadata-count">{`${entry.model_count} model${entry.model_count === 1 ? '' : 's'}`}</span>
                  </div>
                  <div className="jp-mgr__row-actions">
                    <Button size="sm" icon={Pencil} className="metadata-rename" aria-label={`Rename ${entry.name}`} onClick={() => rename(entry)}>
                      Rename
                    </Button>
                    <IconButton size="sm" icon={Trash2} className="metadata-delete" label={`Delete ${entry.name}`} onClick={() => remove(entry)} />
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </ModalDialog>
  );
}
