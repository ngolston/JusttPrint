import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArchiveX, ClipboardPen, ExternalLink, FolderPlus, List, ListChecks, Merge, Plus, Tags, Trash2, X } from 'lucide-react';
import { callAction, categories as categoryApi, collections as collectionApi, libraryValues, models, tags as tagApi } from '../api';
import { askText, exposeGlobal, onServerEvent, showMessage } from '../page';
import { selection } from '../selection';
import { useCanDeleteFiles } from '../session';
import { STATUSES, STATUS_LABELS } from '../print/printStatus';
import { Button } from '../components/Button';
import { pickFromList, type ListField } from '../components/ListPicker';
import { MergeDialog } from './MergeDialog';

type Field = 'designer' | 'title' | 'license' | 'source' | 'tags';

/** What the multi-edit panel asks of the library (library/hosts.ts), which owns the selection and the panel's visibility. */
export interface MultiEditHost {
  /** The selected models' paths. */
  selectedPaths(): string[];
  /** Leave multi-edit mode (clears the selection and shows the details panel). */
  exit(): void;
  selectAllVisible(): Promise<void>;
  clearSelection(): void;
  /** Set a field on every selected model. Tags in `value` are added to what each model has. */
  saveField(field: Field, value: string | string[]): Promise<boolean>;
  /** Remove one tag from every selected model, keeping their others. */
  removeFromSelected(field: 'tags', value: string): Promise<void>;
  openSource(url: string): void;
}

declare global {
  interface Window {
    multiEditHost?: MultiEditHost;
    /** The multi-edit panel's body (library/details.ts drives it). */
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

const sortNames = (names: (string | null | undefined)[]) =>
  [...new Set(names.map((n) => String(n || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

interface Options {
  designers: string[];
  titles: string[];
  licenses: string[];
  tags: string[];
  /** Each Category with its Subcategories' names. */
  categories: { name: string; subcategories: string[] }[];
}

interface OnSelected {
  tags: string[];
}

async function loadOptions(): Promise<Options> {
  const [designers, titles, licenses, allTags, list] = await Promise.all([
    libraryValues.designers().catch(() => []),
    libraryValues.titles().catch(() => []),
    libraryValues.licenses().catch(() => []),
    tagApi.list().catch(() => []),
    categoryApi.list().catch(() => ({ categories: [], uncategorized: 0 }))
  ]);
  return {
    designers: sortNames(designers),
    titles: sortNames(titles),
    licenses: sortNames(licenses),
    tags: sortNames(allTags.map((t) => t.name)),
    categories: list.categories
      .filter((c) => !c.parent_id)
      .map((main) => ({ name: main.name, subcategories: list.categories.filter((c) => c.parent_id === main.id).map((c) => c.name) }))
  };
}

/** Tags that at least one selected model has (for the Remove picker). */
async function loadOnSelected(paths: string[]): Promise<OnSelected> {
  const loaded = await Promise.all(paths.map((p) => models.get<{ tags?: unknown[] }>(p).catch(() => null)));
  const tagNames: string[] = [];
  for (const model of loaded) {
    for (const tag of model?.tags || []) tagNames.push(typeof tag === 'string' ? tag : String((tag as { name?: string })?.name ?? ''));
  }
  return { tags: sortNames(tagNames) };
}

const PROMPTS: Record<'designer' | 'title' | 'license', string> = {
  designer: 'designer',
  title: 'title',
  license: 'license'
};

/**
 * The multi-edit panel's body (#multi-edit-slot), laid out like the JusttPrint 5 details panel: the
 * count and selection buttons, Merge, then Printing, Details, Tags, Collections and Delete; the
 * fields apply to every selected model as soon as they change. Registers window.multiEdit.
 */
export function MultiEditPanel() {
  const [slot] = useState(() => document.getElementById('multi-edit-slot'));
  const [count, setCount] = useState(0);
  const [options, setOptions] = useState<Options>({ designers: [], titles: [], licenses: [], tags: [], categories: [] });
  const [onSelected, setOnSelected] = useState<OnSelected>({ tags: [] });
  const [source, setSource] = useState('');
  const [picked, setPicked] = useState({ designer: '', title: '', license: '' });
  const sourceTimer = useRef<number | undefined>(undefined);
  const selectionLoad = useRef(0);
  const host = window.multiEditHost;
  const canDeleteFiles = useCanDeleteFiles();
  const [deleting, setDeleting] = useState(false);
  /** The collections models can be added to (not smart ones: a search fills those), and what the last add did. */
  const [collectionList, setCollectionList] = useState<{ id: number; name: string }[]>([]);
  const [collectionNote, setCollectionNote] = useState('');
  /** Merge: the chosen models' paths while its dialog is open. */
  const [merging, setMerging] = useState<string[] | null>(null);

  const reloadOptions = () => {
    loadOptions()
      .then(setOptions)
      .catch(() => {});
  };

  const selectionChanged = () => {
    const paths = window.multiEditHost?.selectedPaths() || [];
    setCount(paths.length);
    setCollectionNote('');
    const load = ++selectionLoad.current;
    if (!paths.length || document.getElementById('multi-edit-panel')?.classList.contains('hidden')) {
      setOnSelected({ tags: [] });
      return;
    }
    loadOnSelected(paths)
      .then((next) => {
        if (load === selectionLoad.current) setOnSelected(next);
      })
      .catch(() => {});
  };

  useEffect(() => selection.subscribe(() => selectionChanged()), []);
  useEffect(() => {
    const load = () =>
      collectionApi.list().then(
        (list) =>
          setCollectionList(
            list
              .filter((c) => !c.smart)
              .map((c) => ({ id: c.id, name: c.name }))
              .sort((a, b) => a.name.localeCompare(b.name))
          ),
        () => {}
      );
    void load();
    return onServerEvent('collections-changed', load);
  }, []);
  useEffect(
    () =>
      exposeGlobal('multiEdit', {
        open: () => {
          window.clearTimeout(sourceTimer.current);
          setSource('');
          setPicked({ designer: '', title: '', license: '' });
          reloadOptions();
          selectionChanged();
        },
        selectionChanged,
        reloadOptions
      }),
    []
  );

  async function save(field: Field, value: string | string[]) {
    if (!host || !host.selectedPaths().length) return false;
    const ok = await host.saveField(field, value);
    if (field === 'tags') selectionChanged();
    return ok;
  }

  async function pickValue(field: 'designer' | 'title' | 'license', value: string) {
    setPicked((current) => ({ ...current, [field]: value }));
    if (!value) return;
    await save(field, value);
  }

  async function addNewValue(field: 'designer' | 'title' | 'license') {
    const typed = (await askText(`New ${PROMPTS[field]}`, `Enter a ${PROMPTS[field]} for the selected models:`))?.trim();
    if (!typed) return;
    setPicked((current) => ({ ...current, [field]: typed }));
    if (await save(field, typed)) {
      reloadOptions();
      window.detailsFields?.reloadOptions();
      await window.detailsHost?.valuesChanged(field);
    }
  }

  /** One Category › Subcategory for every selected model (it stays: Categorize Library and the AI leave it). */
  async function setCategory(name: string) {
    const paths = host?.selectedPaths() || [];
    if (!name || !paths.length) return;
    const answer = await showMessage(
      'Category',
      `Put ${paths.length} selected model${paths.length === 1 ? '' : 's'} in ${options.categories.find((c) => c.subcategories.includes(name))?.name ?? ''} › ${name}?`,
      ['Yes', 'No']
    );
    if (answer !== 'Yes') return;
    try {
      await callAction('set-models-category', paths, name);
    } catch (error) {
      await showMessage('Category', error instanceof Error ? error.message : String(error));
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
    const answer = await showMessage('Remove Tag', `Are you sure you want to remove the tag "${tag}" from ${n} selected file${n === 1 ? '' : 's'}?`, [
      'Yes',
      'No'
    ]);
    if (answer !== 'Yes') return;
    await host.removeFromSelected('tags', tag);
    selectionChanged();
  }

  /**
   * Delete the chosen models (src/server/delete-models.js): out of the library, their files moved to
   * the ".JusttPrint Trash" folder no scan looks in ('library'), or deleted for good ('disk').
   */
  async function deleteSelected(mode: 'library' | 'disk') {
    const paths = host?.selectedPaths() || [];
    if (!paths.length || deleting) return;
    const name = (p: string) => p.split('::').pop()?.split(/[/\\]/).pop() || p;
    const list = paths.slice(0, 15).map(name).join('\n') + (paths.length > 15 ? `\n… and ${paths.length - 15} more` : '');
    const models = `${paths.length} ${paths.length === 1 ? 'model' : 'models'}`;
    const message =
      mode === 'disk'
        ? `Delete ${models} from disk? Their files are deleted for good (a model folder whose models are all chosen goes as a whole, with its pictures and documents; a model inside a ZIP deletes the whole ZIP). This cannot be undone.\n\n${list}`
        : `Delete ${models} from the library? Their files are kept, moved to the ".JusttPrint Trash" folder of their library folder, which no scan looks in (a model folder whose models are all chosen moves as a whole; a model inside a ZIP moves the whole ZIP). Their tags, notes and history are removed.\n\n${list}`;
    const yes = mode === 'disk' ? 'Delete from Disk' : 'Delete from Library';
    if ((await showMessage(mode === 'disk' ? 'Delete from Disk' : 'Delete from Library', message, [yes, 'Cancel'])) !== yes) return;
    setDeleting(true);
    try {
      const result = await callAction<{ removed: number; items: { target: string; to?: string }[]; failed: { name: string; error: string }[] }>(
        'delete-models',
        paths,
        mode
      );
      selection.clear();
      const failed = result.failed.length ? `\n\nNot deleted: ${result.failed.map((f) => `${f.name} (${f.error})`).join('; ')}` : '';
      const where =
        mode === 'library' && result.items[0]?.to ? `\n\nThe files are in ${result.items[0].to.replace(/([/\\]\.JusttPrint Trash)[/\\].*$/, '$1')}.` : '';
      await showMessage(
        mode === 'disk' ? 'Deleted from Disk' : 'Deleted from Library',
        `${result.removed} ${result.removed === 1 ? 'model' : 'models'} deleted ${mode === 'disk' ? 'from disk' : 'from the library'}.${where}${failed}`
      );
    } catch (error) {
      await showMessage('Delete', error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }

  /** Add every chosen model to a collection; `id` null makes a new one first. */
  async function addToCollection(id: number | null) {
    const paths = host?.selectedPaths() || [];
    if (!paths.length) return;
    try {
      let target = collectionList.find((c) => c.id === id) || null;
      if (id === null) {
        const name = (await askText('New Collection', `Name the collection for the ${paths.length} selected model${paths.length === 1 ? '' : 's'}:`))?.trim();
        if (!name) return;
        const made = await collectionApi.create(name);
        target = { id: made.id, name: made.name };
      }
      if (!target) return;
      const result = await collectionApi.add(target.id, paths);
      setCollectionNote(
        result.added ? `Added ${result.added} model${result.added === 1 ? '' : 's'} to ${target.name}.` : `The selected models are in ${target.name} already.`
      );
    } catch (error) {
      await showMessage('Collections', error instanceof Error ? error.message : String(error));
    }
  }

  /** Merge: the other chosen models are merged into `mainPath` (one card; its page lists them). */
  async function merge(mainPath: string) {
    const paths = merging || [];
    await callAction(
      'set-model-parts',
      mainPath,
      paths.filter((p) => p !== mainPath)
    );
    setMerging(null);
    selection.clear();
    host?.exit();
  }

  if (!slot) return null;
  const chosenText = count ? `${count} model${count === 1 ? '' : 's'}` : '';

  const listButton = (title: string, onClick: () => void) => (
    <button type="button" className="jp-icon-btn jp-icon-btn--sm jp-multi__tool" title={title} aria-label={title} onClick={onClick}>
      <List size={16} aria-hidden="true" />
    </button>
  );
  const addButton = (title: string, onClick: () => void, id?: string) => (
    <button type="button" id={id} className="jp-icon-btn jp-icon-btn--sm jp-multi__tool" title={title} aria-label={title} onClick={onClick}>
      <Plus size={16} aria-hidden="true" />
    </button>
  );

  const valueRow = (field: 'designer' | 'title' | 'license', id: string, title: string, empty: string, values: string[], list: ListField) => (
    <div className="jp-multi__row">
      <label htmlFor={id}>{title}</label>
      <div className="jp-multi__control">
        <select id={id} value={picked[field]} onChange={(e) => pickValue(field, e.target.value)}>
          <option value="">{empty}</option>
          {values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
          {picked[field] && !values.includes(picked[field]) && <option value={picked[field]}>{picked[field]}</option>}
        </select>
        {listButton(`Search existing ${PROMPTS[field]}s`, async () => {
          const v = await pickFromList(list);
          if (v) await pickValue(field, v);
        })}
        {addButton(`New ${PROMPTS[field]}`, () => addNewValue(field), `${id}-add`)}
      </div>
    </div>
  );

  return createPortal(
    <div className="jp jp-details jp-multi">
      <div className="jp-details__identity">
        <h2 className="jp-details__title selected-count">{chosenText ? `${chosenText} selected` : 'Nothing selected'}</h2>
        <p className="jp-details__byline">{count ? 'Changes apply to every selected model right away.' : 'Click models in the library to choose them.'}</p>
      </div>

      <div className="jp-details__actions">
        <Button id="select-all-button" icon={ListChecks} title="Select every model shown in the library" onClick={() => host?.selectAllVisible()}>
          Select All
        </Button>
        <Button id="clear-selection-button" icon={X} onClick={() => host?.clearSelection()}>
          Clear Selection
        </Button>
      </div>

      <section className="jp-details__section" id="multi-merge-section">
        <h3 className="jp-details__heading">Merge</h3>
        <Button
          id="multi-merge"
          icon={Merge}
          disabled={count < 2}
          title="One model for the chosen models: pick the main one, the others are merged into it"
          onClick={() => setMerging(host?.selectedPaths() || [])}
        >
          Merge…
        </Button>
        <p className="jp-meta">One card in the library for the chosen models; the main model's page lists the others. Un-merge on a merged model's page.</p>
      </section>

      <section className="jp-details__section">
        <h3 className="jp-details__heading">Printing</h3>
        <div className="jp-multi__rows">
          <div className="jp-multi__row">
            <label htmlFor="multi-print-status">Status</label>
            <div className="jp-multi__control">
              <select
                id="multi-print-status"
                value=""
                onChange={async (e) => {
                  const paths = host?.selectedPaths() || [];
                  const status = e.target.value;
                  if (!paths.length || !status) return;
                  await window.PrintHistory?.setStatus(paths, status);
                }}
              >
                <option value="">No change</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <Button
          id="multi-log-print-button"
          className="jp-multi__wide"
          icon={ClipboardPen}
          onClick={() => {
            const paths = host?.selectedPaths() || [];
            if (paths.length) window.PrintHistory?.openLogDialog({ filePaths: paths });
          }}
        >
          Log a Print on Selected
        </Button>
      </section>

      <section className="jp-details__section">
        <h3 className="jp-details__heading">Details</h3>
        <div className="jp-multi__rows">
          <div className="jp-multi__row">
            <label htmlFor="multi-source">Source</label>
            <div className="jp-multi__control">
              <input
                type="text"
                id="multi-source"
                placeholder="Enter a link or name…"
                spellCheck={false}
                value={source}
                onChange={(e) => {
                  const value = e.target.value;
                  setSource(value);
                  window.clearTimeout(sourceTimer.current);
                  sourceTimer.current = window.setTimeout(() => {
                    save('source', value.trim());
                  }, 500);
                }}
              />
              <button
                type="button"
                id="multi-open-source-button"
                className="jp-icon-btn jp-icon-btn--sm jp-multi__tool"
                title="Open in browser"
                aria-label="Open in browser"
                disabled={!source.trim()}
                onClick={() => host?.openSource(source.trim())}
              >
                <ExternalLink size={16} aria-hidden="true" />
              </button>
            </div>
          </div>
          {valueRow('designer', 'multi-designer', 'Designer', 'No change', options.designers, 'designer')}
          {valueRow('title', 'multi-title', 'Title', 'No change', options.titles, 'title')}
          {valueRow('license', 'multi-license', 'License', 'No change', options.licenses, 'license')}
          <div className="jp-multi__row">
            <label htmlFor="multi-category">Category</label>
            <div className="jp-multi__control">
              <select id="multi-category" value="" onChange={(e) => void setCategory(e.target.value)}>
                <option value="">No change</option>
                {options.categories.map((main) => (
                  <optgroup key={main.name} label={main.name}>
                    {main.subcategories.map((sub) => (
                      <option key={sub} value={sub}>
                        {main.name} › {sub}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
        </div>
      </section>

      <section className="jp-details__section">
        <h3 className="jp-details__heading">Tags</h3>
        <div className="jp-multi__rows">
          <div className="jp-multi__row">
            <label htmlFor="multi-tag-select">Add</label>
            <div className="jp-multi__control">
              <select id="multi-tag-select" className="jp-multi__picker" value="" onChange={(e) => addTag(e.target.value)}>
                <option value="">Add a tag…</option>
                {options.tags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {listButton('Search existing tags', async () => addTag(await pickFromList('tag')))}
              {addButton('New tag', addNewTag, 'multi-add-tag')}
            </div>
          </div>
          <div className="jp-multi__row">
            <label htmlFor="multi-tag-remove-select">Remove</label>
            <div className="jp-multi__control">
              <select
                id="multi-tag-remove-select"
                className="jp-multi__picker"
                value=""
                disabled={!onSelected.tags.length}
                onChange={(e) => removeTag(e.target.value)}
              >
                <option value="">{onSelected.tags.length ? 'Remove a tag…' : 'None to remove'}</option>
                {onSelected.tags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {listButton('Search tags to remove from the selection', async () => removeTag(await pickFromList('tag', true)))}
            </div>
          </div>
        </div>
        <Button id="multi-edit-tags-button" variant="ghost" size="sm" icon={Tags} className="jp-multi__manage" onClick={() => window.openTagManager?.()}>
          Manage Tags
        </Button>
      </section>

      <section className="jp-details__section" id="multi-collections">
        <h3 className="jp-details__heading">Collections</h3>
        <div className="jp-multi__rows">
          <div className="jp-multi__row">
            <label htmlFor="multi-collection-select">Add to</label>
            <div className="jp-multi__control">
              <select
                id="multi-collection-select"
                className="jp-multi__picker"
                value=""
                disabled={!count}
                onChange={(e) => e.target.value && void addToCollection(Number(e.target.value))}
              >
                <option value="">{collectionList.length ? 'Add to a collection…' : 'No collections yet'}</option>
                {collectionList.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.name}
                  </option>
                ))}
              </select>
              {addButton('New collection with the selected models', () => void addToCollection(null), 'multi-collection-add')}
            </div>
          </div>
        </div>
        {collectionNote && (
          <p className="jp-meta jp-multi__note" role="status" id="multi-collection-note">
            {collectionNote}
          </p>
        )}
        <Button
          id="multi-collections-manage"
          variant="ghost"
          size="sm"
          icon={FolderPlus}
          className="jp-multi__manage"
          disabled={!count}
          onClick={() => window.openAddToCollection?.(host?.selectedPaths() || [])}
        >
          Manage Collections…
        </Button>
      </section>

      <section className="jp-details__section" id="multi-delete">
        <h3 className="jp-details__heading">Delete</h3>
        <div className="jp-multi__delete">
          <Button id="multi-delete-library" icon={ArchiveX} disabled={!count || deleting} onClick={() => void deleteSelected('library')}>
            Delete from Library
          </Button>
          {canDeleteFiles && (
            <Button id="multi-delete-disk" variant="danger" icon={Trash2} disabled={!count || deleting} onClick={() => void deleteSelected('disk')}>
              Delete from Disk
            </Button>
          )}
        </div>
        <p className="jp-meta jp-multi__note">
          From the library: the files are kept, moved to a .JusttPrint Trash folder that is not scanned.
          {canDeleteFiles ? ' From disk: deleted for good.' : ''}
        </p>
      </section>

      <div className="jp-details__footer">
        <Button id="exit-multi-edit-button" className="jp-multi__wide" onClick={() => host?.exit()}>
          Done Editing
        </Button>
      </div>
      <MergeDialog open={!!merging} filePaths={merging || []} onCancel={() => setMerging(null)} onSubmit={merge} />
    </div>,
    slot
  );
}
