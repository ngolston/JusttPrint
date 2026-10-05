import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { libraryValues, tags as tagApi } from '../api';
import { askText, exposeGlobal } from '../page';

/** The model the details panel shows (only the fields this section edits are typed). */
export interface DetailsModel {
  filePath: string;
  fileName?: string | null;
  source?: string | null;
  designer?: string | null;
  parentModel?: string | null;
  license?: string | null;
  tags?: unknown[] | null;
}

type PickerField = 'designer' | 'parentModel' | 'license';
type ListField = 'designer' | 'parent' | 'license' | 'tag';

/** What this section asks of renderer.js. */
export interface DetailsHost {
  /** Save one field of the model (autoSaveModel: also updates its grid card). */
  saveField(filePath: string, field: PickerField | 'source' | 'tags', value: string | string[]): Promise<boolean>;
  /** The searchable list dialog; resolves to the picked value, or null. */
  pickFromList(field: ListField): Promise<string | null>;
  /** Open the source URL in a new tab (checks it is http/https). */
  openSource(url: string): void;
  /** A new designer, parent model, license or tag exists: refresh the filters and other pickers. */
  valuesChanged(kind: PickerField | 'tag'): Promise<void>;
}

declare global {
  interface Window {
    detailsHost?: DetailsHost;
    /** The details panel's metadata fields (renderer.js showModelDetails drives it). */
    detailsFields?: {
      show: (model: DetailsModel) => void;
      clear: () => void;
      /** Reload the picker options (a value was added, renamed or removed elsewhere). */
      reloadOptions: () => void;
      /** Add a tag to the shown model and save. */
      addTag: (name: string) => Promise<void>;
      /** Replace the shown tags (they changed elsewhere, e.g. the Tag Manager). */
      setTags: (names: string[]) => void;
    };
  }
}

const tagNames = (list: unknown[] | null | undefined) => (list || [])
  .map((tag) => (typeof tag === 'string' ? tag : String((tag as { name?: string })?.name ?? '')).trim())
  .filter(Boolean)
  .sort((a, b) => a.localeCompare(b));

interface Options {
  designers: string[];
  parents: string[];
  licenses: string[];
  tags: string[];
}

const EMPTY_OPTIONS: Options = { designers: [], parents: [], licenses: [], tags: [] };

async function loadOptions(): Promise<Options> {
  const [designers, parents, licenses, allTags] = await Promise.all([
    libraryValues.designers().catch(() => []),
    libraryValues.parentModels().catch(() => []),
    libraryValues.licenses().catch(() => []),
    tagApi.list().catch(() => [])
  ]);
  const clean = (list: (string | null)[]) => [...new Set(list.filter((value): value is string => !!value))];
  return {
    designers: clean(designers),
    parents: clean(parents),
    licenses: clean(licenses),
    tags: allTags.map((tag) => tag.name).sort((a, b) => a.localeCompare(b))
  };
}

const LABELS: Record<PickerField, { label: string; empty: string; list: ListField; prompt: string }> = {
  designer: { label: 'Designer:', empty: 'Select Designer', list: 'designer', prompt: 'New designer' },
  parentModel: { label: 'Parent Model:', empty: 'None', list: 'parent', prompt: 'New parent model' },
  license: { label: 'License:', empty: 'Select License', list: 'license', prompt: 'New license' }
};
const IDS: Record<PickerField, string> = { designer: 'model-designer', parentModel: 'model-parent', license: 'model-license' };

/**
 * The details panel's name, source, designer, parent model, license and tags. Each change is
 * saved at once. Rendered into two places in #model-details (the path row between them is
 * still static markup). Registers window.detailsFields.
 */
export function DetailsFields() {
  const [nameSlot] = useState(() => document.getElementById('details-name-slot'));
  const [fieldsSlot] = useState(() => document.getElementById('details-fields-slot'));
  const [model, setModel] = useState<DetailsModel | null>(null);
  const [source, setSource] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [options, setOptions] = useState<Options>(EMPTY_OPTIONS);
  const host = window.detailsHost;

  const reloadOptions = () => { loadOptions().then(setOptions).catch(() => {}); };

  // window.detailsFields is read from the latest render, so it always sees the shown model.
  const api = {
    show: (next: DetailsModel) => {
      setModel(next);
      setSource(next.source || '');
      setTags(tagNames(next.tags));
      reloadOptions();
    },
    clear: () => {
      setModel(null);
      setSource('');
      setTags([]);
    },
    reloadOptions,
    addTag: async (name: string) => { await addTag(name); },
    setTags: (names: string[]) => setTags(tagNames(names))
  };
  useEffect(() => exposeGlobal('detailsFields', api));

  async function save(field: PickerField | 'source' | 'tags', value: string | string[]) {
    if (!model || !host) return false;
    const ok = await host.saveField(model.filePath, field, value);
    if (ok && field !== 'tags' && field !== 'source') setModel({ ...model, [field]: value as string });
    return ok;
  }

  async function addTag(name: string) {
    const trimmed = name.trim();
    if (!model || !trimmed || tags.includes(trimmed)) return;
    const next = [...tags, trimmed].sort((a, b) => a.localeCompare(b));
    setTags(next);
    await save('tags', next);
  }

  async function removeTag(name: string) {
    const next = tags.filter((tag) => tag !== name);
    setTags(next);
    await save('tags', next);
  }

  async function pick(field: PickerField) {
    const value = await host?.pickFromList(LABELS[field].list);
    if (value) await save(field, value);
  }

  async function addNew(field: PickerField) {
    const typed = (await askText(LABELS[field].prompt, `Enter a ${LABELS[field].prompt.replace(/^New /, '')} for this model:`))?.trim();
    if (!typed) return;
    if (await save(field, typed)) {
      setOptions((previous) => {
        const key = field === 'designer' ? 'designers' : field === 'parentModel' ? 'parents' : 'licenses';
        return previous[key].includes(typed) ? previous : { ...previous, [key]: [...previous[key], typed].sort((a, b) => a.localeCompare(b)) };
      });
      await host?.valuesChanged(field);
    }
  }

  async function newTag() {
    const typed = (await askText('New tag', 'Enter a tag name:'))?.trim();
    if (!typed) return;
    try {
      const saved = await tagApi.create(typed);
      await addTag(saved?.name || typed);
      reloadOptions();
      await host?.valuesChanged('tag');
    } catch (error) {
      console.error('Error saving new tag:', error);
    }
  }

  function picker(field: PickerField) {
    const value = (model?.[field] || '') as string;
    const list = field === 'designer' ? options.designers : field === 'parentModel' ? options.parents : options.licenses;
    const values = value && !list.includes(value) ? [...list, value] : list;
    return (
      <div className="form-group mobile-detail-extra" key={field}>
        <label htmlFor={IDS[field]}>{LABELS[field].label}</label>
        <div className="designer-input-container">
          <select id={IDS[field]} className={field === 'license' ? 'form-control' : undefined} value={value} disabled={!model}
            onChange={(event) => save(field, event.target.value)}>
            <option value="">{LABELS[field].empty}</option>
            {values.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          <button type="button" className="list-button icon-button" title={`Search existing ${LABELS[field].list === 'parent' ? 'parent models' : `${LABELS[field].list}s`}`}
            disabled={!model} onClick={() => pick(field)}>☰</button>
          <button type="button" className="icon-button" id={`details-add-${LABELS[field].list}`} title={LABELS[field].prompt}
            disabled={!model} onClick={() => addNew(field)}>+</button>
        </div>
      </div>
    );
  }

  const name: ReactNode = (
    <div className="form-group mobile-detail-skip">
      <label htmlFor="model-name">Name:</label>
      <input type="text" id="model-name" readOnly value={model?.fileName || ''} />
    </div>
  );

  const fields: ReactNode = (
    <>
      <div className="form-group mobile-detail-extra">
        <label htmlFor="model-source">Source URL:</label>
        <div className="input-with-icon">
          <input type="text" id="model-source" placeholder="Enter source..." spellCheck={false} value={source} disabled={!model}
            onChange={(event) => setSource(event.target.value)}
            onBlur={() => { if (model && source !== (model.source || '')) { save('source', source); setModel({ ...model, source }); } }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
          <button type="button" id="details-open-source" className="icon-button" title="Open in browser" disabled={!model}
            onClick={() => host?.openSource(source.trim())}>↗</button>
        </div>
      </div>
      {picker('designer')}
      {picker('parentModel')}
      {picker('license')}
      <div className="form-group">
        <label>Tags:</label>
        <div className="tags-container">
          <div className="tags-input-container">
            <select id="tag-select" value="" disabled={!model} onChange={(event) => { if (event.target.value) addTag(event.target.value); }}>
              <option value="">Select a tag...</option>
              {options.tags.filter((tag) => !tags.includes(tag)).map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </select>
            <button type="button" className="list-button icon-button" title="Search existing tags" disabled={!model}
              onClick={async () => { const picked = await host?.pickFromList('tag'); if (picked) await addTag(picked); }}>☰</button>
            <button type="button" id="details-add-tag" className="icon-button" title="New tag" disabled={!model} onClick={newTag}>+</button>
          </div>
          <div id="model-tags" className="tags-list">
            {tags.map((tag) => (
              <div key={tag} className="tag" data-tag-name={tag} title={tag}>
                <span className="tag-text">{tag}</span>
                <span className="tag-remove" role="button" aria-label={`Remove tag ${tag}`} onClick={() => removeTag(tag)}>×</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );

  return (
    <>
      {nameSlot && createPortal(name, nameSlot)}
      {fieldsSlot && createPortal(fields, fieldsSlot)}
    </>
  );
}
