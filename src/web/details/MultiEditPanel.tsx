import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { filaments as filamentApi, libraryValues, models, tags as tagApi, type Filament } from '../api';
import { askText, exposeGlobal, showMessage } from '../page';
import { selection } from '../selection';
import { STATUSES, STATUS_LABELS, colorCss, filamentLabel, type FilamentLike } from '../print/printStatus';

type Field = 'designer' | 'parentModel' | 'license' | 'source' | 'tags' | 'filaments';
type ListField = 'designer' | 'parent' | 'license' | 'tag' | 'filament';

/** What the multi-edit panel asks of renderer.js, which owns the selection and the panel's visibility. */
export interface MultiEditHost {
  /** The selected models' paths. */
  selectedPaths(): string[];
  /** Leave multi-edit mode (clears the selection and shows the details panel). */
  exit(): void;
  selectAllVisible(): Promise<void>;
  clearSelection(): void;
  /** Set a field on every selected model. Tags and filaments in `value` are added to what each model has. */
  saveField(field: Field, value: string | string[] | number[]): Promise<boolean>;
  /** Remove one tag or filament from every selected model, keeping their others. */
  removeFromSelected(field: 'tags' | 'filaments', value: string | number): Promise<void>;
  /** The searchable list dialog; `remove` lists only values on the selected models. Resolves to the pick, or null. */
  pickFromList(field: ListField, remove?: boolean): Promise<string | null>;
  openSource(url: string): void;
}

declare global {
  interface Window {
    multiEditHost?: MultiEditHost;
    /** The multi-edit panel's body (renderer.js drives it). */
    multiEdit?: {
      /** The panel was shown: clear the form and load the pickers. */
      open: () => void;
      /** The selection changed. */
      selectionChanged: () => void;
      /** Reload the pickers (a value was added or renamed elsewhere). */
      reloadOptions: () => void;
    };
  }
}

const label = (filament: FilamentLike) => filamentLabel(filament, undefined, 'Unnamed filament');
const sortNames = (names: (string | null | undefined)[]) =>
  [...new Set(names.map((n) => String(n || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

interface Options {
  designers: string[];
  parents: string[];
  licenses: string[];
  tags: string[];
  filaments: Filament[];
}

interface OnSelected {
  tags: string[];
  filaments: FilamentLike[];
}

async function loadOptions(): Promise<Options> {
  const [designers, parents, licenses, allTags, allFilaments] = await Promise.all([
    libraryValues.designers().catch(() => []),
    libraryValues.parentModels().catch(() => []),
    libraryValues.licenses().catch(() => []),
    tagApi.list().catch(() => []),
    filamentApi.list().catch(() => [] as Filament[])
  ]);
  return {
    designers: sortNames(designers),
    parents: sortNames(parents),
    licenses: sortNames(licenses),
    tags: sortNames(allTags.map((t) => t.name)),
    filaments: allFilaments.slice().sort((a, b) => label(a).localeCompare(label(b)))
  };
}

/** Tags and filaments that at least one selected model has (for the Remove pickers). */
async function loadOnSelected(paths: string[]): Promise<OnSelected> {
  const loaded = await Promise.all(paths.map((p) => models.get<{ tags?: unknown[]; filaments?: FilamentLike[] }>(p).catch(() => null)));
  const tagNames: string[] = [];
  const byId = new Map<string, FilamentLike>();
  for (const model of loaded) {
    for (const tag of model?.tags || []) tagNames.push(typeof tag === 'string' ? tag : String((tag as { name?: string })?.name ?? ''));
    for (const f of model?.filaments || []) if (f?.id != null && !byId.has(String(f.id))) byId.set(String(f.id), f);
  }
  return { tags: sortNames(tagNames), filaments: [...byId.values()].sort((a, b) => label(a).localeCompare(label(b))) };
}

const PROMPTS: Record<'designer' | 'parentModel' | 'license', string> = {
  designer: 'designer',
  parentModel: 'parent model',
  license: 'license'
};

/**
 * Everything under the multi-edit panel's header (#multi-edit-slot): selection buttons and count,
 * and fields that apply to every selected model as soon as they change. Registers window.multiEdit.
 */
export function MultiEditPanel() {
  const [slot] = useState(() => document.getElementById('multi-edit-slot'));
  const [count, setCount] = useState(0);
  const [options, setOptions] = useState<Options>({ designers: [], parents: [], licenses: [], tags: [], filaments: [] });
  const [onSelected, setOnSelected] = useState<OnSelected>({ tags: [], filaments: [] });
  const [source, setSource] = useState('');
  const [picked, setPicked] = useState({ designer: '', parentModel: '', license: '' });
  const [addedFilaments, setAddedFilaments] = useState<FilamentLike[]>([]);
  const sourceTimer = useRef<number | undefined>(undefined);
  const selectionLoad = useRef(0);
  const host = window.multiEditHost;

  const reloadOptions = () => { loadOptions().then(setOptions).catch(() => {}); };

  const selectionChanged = () => {
    const paths = window.multiEditHost?.selectedPaths() || [];
    setCount(paths.length);
    const load = ++selectionLoad.current;
    if (!paths.length || document.getElementById('multi-edit-panel')?.classList.contains('hidden')) {
      setOnSelected({ tags: [], filaments: [] });
      return;
    }
    loadOnSelected(paths).then((next) => { if (load === selectionLoad.current) setOnSelected(next); }).catch(() => {});
  };

  useEffect(() => selection.subscribe(() => selectionChanged()), []);
  useEffect(() => exposeGlobal('multiEdit', {
    open: () => {
      window.clearTimeout(sourceTimer.current);
      setSource('');
      setPicked({ designer: '', parentModel: '', license: '' });
      setAddedFilaments([]);
      reloadOptions();
      selectionChanged();
    },
    selectionChanged,
    reloadOptions
  }), []);

  async function save(field: Field, value: string | string[] | number[]) {
    if (!host || !host.selectedPaths().length) return false;
    const ok = await host.saveField(field, value);
    if (field === 'tags' || field === 'filaments') selectionChanged();
    return ok;
  }

  async function pickValue(field: 'designer' | 'parentModel' | 'license', value: string) {
    setPicked((current) => ({ ...current, [field]: value }));
    if (!value) return;
    await save(field, value);
  }

  async function addNewValue(field: 'designer' | 'parentModel' | 'license') {
    const typed = (await askText(`New ${PROMPTS[field]}`, `Enter a ${PROMPTS[field]} for the selected models:`))?.trim();
    if (!typed) return;
    setPicked((current) => ({ ...current, [field]: typed }));
    if (await save(field, typed)) {
      reloadOptions();
      window.detailsFields?.reloadOptions();
      await window.detailsHost?.valuesChanged(field);
    }
  }

  async function addTag(name: string | null | undefined) {
    const tag = String(name || '').trim();
    if (tag) await save('tags', [tag]);
  }

  async function addNewTag() {
    const typed = (await askText('New tag', 'Enter a tag to add to the selected models:'))?.trim();
    if (!typed) return;
    try {
      const saved = await tagApi.create(typed);
      await addTag(saved?.name || typed);
      reloadOptions();
      window.detailsFields?.reloadOptions();
      await window.detailsHost?.valuesChanged('tag');
    } catch (error) {
      console.error('Error creating tag:', error);
    }
  }

  async function removeTag(name: string | null | undefined) {
    const tag = String(name || '').trim();
    if (!tag || !host) return;
    const n = host.selectedPaths().length;
    const answer = await showMessage('Remove Tag', `Are you sure you want to remove the tag "${tag}" from ${n} selected file${n === 1 ? '' : 's'}?`, ['Yes', 'No']);
    if (answer !== 'Yes') return;
    await host.removeFromSelected('tags', tag);
    selectionChanged();
  }

  async function addFilament(id: number) {
    const filament = options.filaments.find((f) => f.id === id);
    if (!id || !filament) return;
    if (await save('filaments', [id])) {
      setAddedFilaments((current) => (current.some((f) => Number(f.id) === id) ? current : [...current, filament]));
    }
  }

  async function removeFilament(id: number) {
    if (!id || !host) return;
    await host.removeFromSelected('filaments', id);
    setAddedFilaments((current) => current.filter((f) => Number(f.id) !== id));
    selectionChanged();
  }

  if (!slot) return null;

  const valueSelect = (field: 'designer' | 'parentModel' | 'license', id: string, title: string, empty: string, values: string[], list: ListField) => (
    <div className="form-group">
      <label htmlFor={id}>{title}</label>
      <div className="designer-input-container">
        <select id={id} value={picked[field]} onChange={(e) => pickValue(field, e.target.value)}>
          <option value="">{empty}</option>
          {values.map((v) => <option key={v} value={v}>{v}</option>)}
          {picked[field] && !values.includes(picked[field]) && <option value={picked[field]}>{picked[field]}</option>}
        </select>
        <button type="button" className="list-button icon-button" title={`Search existing ${PROMPTS[field]}s`}
          onClick={async () => { const v = await host?.pickFromList(list); if (v) await pickValue(field, v); }}>☰</button>
        <button type="button" id={`${id}-add`} className="icon-button" title={`New ${PROMPTS[field]}`} onClick={() => addNewValue(field)}>+</button>
      </div>
    </div>
  );

  const addableFilaments = options.filaments.filter((f) => !addedFilaments.some((a) => Number(a.id) === f.id));

  return createPortal(
    <>
      <button type="button" id="exit-multi-edit-button" className="full-width-button" onClick={() => host?.exit()}>Exit Multi-Edit Mode</button>
      <button type="button" id="select-all-button" className="full-width-button" onClick={() => host?.selectAllVisible()}>Select All Visible</button>
      <button type="button" id="clear-selection-button" className="full-width-button" onClick={() => host?.clearSelection()}>Clear Selection</button>
      <p className="selected-count">{`${count} model${count !== 1 ? 's' : ''} selected`}</p>
      <div className="form-group">
        <label htmlFor="multi-print-status">Print status</label>
        <select id="multi-print-status" value="" onChange={async (e) => {
          const paths = host?.selectedPaths() || [];
          const status = e.target.value;
          if (!paths.length || !status) return;
          await window.PrintHistory?.setStatus(paths, status);
        }}>
          <option value="">No change</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
      </div>
      <div className="form-group">
        <button type="button" id="multi-log-print-button" className="full-width-button" onClick={() => {
          const paths = host?.selectedPaths() || [];
          if (paths.length) window.PrintHistory?.openLogDialog({ filePaths: paths });
        }}>Log a print on selected</button>
      </div>
      <div className="form-group">
        <label htmlFor="multi-source">Source:</label>
        <div className="input-with-icon">
          <input type="text" id="multi-source" placeholder="Enter source..." spellCheck={false} value={source}
            onChange={(e) => {
              const value = e.target.value;
              setSource(value);
              window.clearTimeout(sourceTimer.current);
              sourceTimer.current = window.setTimeout(() => { save('source', value.trim()); }, 500);
            }} />
          <button type="button" id="multi-open-source-button" className="icon-button" title="Open in browser"
            onClick={() => host?.openSource(source.trim())}>↗</button>
        </div>
      </div>
      {valueSelect('designer', 'multi-designer', 'Designer:', 'Select Designer', options.designers, 'designer')}
      {valueSelect('parentModel', 'multi-parent', 'Parent Model:', 'None', options.parents, 'parent')}
      {valueSelect('license', 'multi-license', 'License:', 'Select License', options.licenses, 'license')}
      <div className="form-group">
        <label>Tags:</label>
        <div className="tags-container">
          <div className="tags-input-container">
            <select id="multi-tag-select" value="" onChange={(e) => addTag(e.target.value)}>
              <option value="">Select a tag...</option>
              {options.tags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <button type="button" className="list-button icon-button" title="Search existing tags"
              onClick={async () => addTag(await host?.pickFromList('tag'))}>☰</button>
            <button type="button" id="multi-add-tag" className="icon-button" title="New tag" onClick={addNewTag}>+</button>
          </div>
          <div style={{ marginTop: 8 }}>
            <label htmlFor="multi-tag-remove-select" style={{ display: 'block', marginBottom: 4 }}>Remove from selected:</label>
            <div className="tags-input-container">
              <select id="multi-tag-remove-select" value="" onChange={(e) => removeTag(e.target.value)}>
                <option value="">Select a tag to remove...</option>
                {count === 0 && <option value="" disabled>No files selected</option>}
                {onSelected.tags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <button type="button" className="list-button icon-button" title="Search tags to remove from selected files"
                onClick={async () => removeTag(await host?.pickFromList('tag', true))}>☰</button>
            </div>
          </div>
          <button type="button" id="multi-edit-tags-button" className="full-width-button" onClick={() => window.openTagManager?.()}>Edit Tags</button>
        </div>
      </div>
      <div className="form-group">
        <label>Filament:</label>
        <div className="tags-container">
          <div className="tags-input-container">
            <select id="multi-filament-select" value="" onChange={(e) => addFilament(Number(e.target.value))}>
              <option value="">Select a filament...</option>
              {addableFilaments.map((f) => <option key={f.id} value={String(f.id)}>{label(f)}</option>)}
            </select>
            <button type="button" className="list-button icon-button" title="Search existing filaments"
              onClick={async () => addFilament(Number(await host?.pickFromList('filament')))}>☰</button>
            <button type="button" className="icon-button" title="Filament Manager" onClick={() => window.openFilamentManager?.()}>+</button>
          </div>
          <div id="multi-filaments" className="tags-list">
            {addedFilaments.map((f) => (
              <div key={String(f.id)} className="filament-chip" data-filament-id={String(f.id)} title={label(f)}>
                <span className="filament-swatch" style={{ background: colorCss(f.color_hex) }} />
                <span className="filament-chip-text">{label(f)}</span>
                <span className="filament-chip-remove" onClick={() => removeFilament(Number(f.id))}>×</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8 }}>
            <label htmlFor="multi-filament-remove-select" style={{ display: 'block', marginBottom: 4 }}>Remove Filament:</label>
            <div className="tags-input-container">
              <select id="multi-filament-remove-select" value="" onChange={(e) => removeFilament(Number(e.target.value))}>
                <option value="">Select a filament to remove...</option>
                {onSelected.filaments.map((f) => <option key={String(f.id)} value={String(f.id)}>{label(f)}</option>)}
              </select>
              <button type="button" className="list-button icon-button" title="Search filaments to remove from selected files"
                onClick={async () => removeFilament(Number(await host?.pickFromList('filament', true)))}>☰</button>
            </div>
          </div>
        </div>
      </div>
    </>,
    slot
  );
}
