import { useEffect, useMemo, useRef, useState } from 'react';
import { metadata, type MetadataEntry, type MetadataType } from './api';
import { ModalDialog } from './components/ModalDialog';
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
  return [...byName.values()]
    .filter((entry) => !needle || entry.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
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

  async function reload() {
    try {
      setEntries(await metadata.list());
      setError('');
    } catch (reason) {
      console.error('Error loading metadata:', reason);
      setError('Error loading metadata');
    }
  }

  useEffect(() => exposeGlobal('openMetadataEditor', () => {
    setType('designer');
    setSearch('');
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    reload();
  }), []);

  const tab = TABS.find((candidate) => candidate.type === type) ?? TABS[0];
  const rows = useMemo(() => rowsFor(entries, type, search), [entries, type, search]);

  async function afterChange() {
    await reload();
    await window.refreshAfterMetadataChange?.();
  }

  async function rename(entry: MetadataEntry) {
    const typed = await askText(`Rename ${capitalize(tab.one)}`, `Enter new name for "${entry.name}":`, entry.name);
    const newName = typed?.trim();
    if (!newName || newName === entry.name) return;
    const existing = entries.find((other) => other.type === type && other.name.toLowerCase() === newName.toLowerCase() && other.name !== entry.name);
    if (existing && await showMessage('Merge Metadata',
      `A ${tab.one} named "${newName}" already exists. This will merge "${entry.name}" (${plural(entry.model_count)}) into "${newName}" (${plural(existing.model_count)}).`,
      ['Merge', 'Cancel']) !== 'Merge') return;
    try {
      const result = await metadata.rename(type, entry.name, newName);
      await afterChange();
      if (result?.merged) {
        await showMessage('Success', `Successfully merged "${entry.name}" into "${newName}". ${plural(result.updated ?? 0)} updated.`);
      }
    } catch (reason) {
      await showMessage('Error', reason instanceof Error ? reason.message : 'Failed to rename');
    }
  }

  async function remove(entry: MetadataEntry) {
    if (await showMessage(`Delete ${capitalize(tab.one)}`,
      `Remove "${entry.name}" from ${plural(entry.model_count)}?`, ['Yes', 'No']) !== 'Yes') return;
    try {
      await metadata.remove(type, entry.name);
      await afterChange();
    } catch (reason) {
      console.error('Error deleting metadata:', reason);
      await showMessage('Error', 'Failed to delete');
    }
  }

  return (
    <ModalDialog id="metadata-editor-dialog" title="Metadata Editor" dialogRef={dialogRef}>
      <div className="metadata-tabs" role="tablist">
        {TABS.map((candidate) => (
          <button key={candidate.type} type="button" role="tab" aria-selected={candidate.type === type}
            className={`metadata-tab${candidate.type === type ? ' active' : ''}`} data-type={candidate.type}
            onClick={() => { setType(candidate.type); setSearch(''); }}>
            {candidate.tab}
          </button>
        ))}
      </div>
      <div className="form-group">
        <label id="metadata-type-label" htmlFor="metadata-editor-search">{tab.heading}</label>
        <div className="input-with-icon">
          <input type="text" id="metadata-editor-search" placeholder="Search..." value={search} onChange={(event) => setSearch(event.target.value)} />
          <button type="button" id="clear-metadata-search" className="icon-button" title="Clear search" onClick={() => setSearch('')}>×</button>
        </div>
        <div id="metadata-editor-list" className="metadata-list">
          {error ? <div className="error-message">{error}</div>
            : rows.length === 0 ? <div className="no-metadata">No items found</div>
              : rows.map((entry) => (
                <div key={entry.name} className="metadata-item">
                  <span className="metadata-name">{entry.name}</span>
                  <span className="metadata-count">{entry.model_count}</span>
                  <button type="button" className="metadata-rename" title="Rename" aria-label={`Rename ${entry.name}`} onClick={() => rename(entry)}>✎</button>
                  <button type="button" className="metadata-delete" title="Delete" aria-label={`Delete ${entry.name}`} onClick={() => remove(entry)}>×</button>
                </div>
              ))}
        </div>
      </div>
    </ModalDialog>
  );
}
