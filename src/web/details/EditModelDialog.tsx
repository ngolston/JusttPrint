import { useEffect, useRef, useState } from 'react';
import { callAction, categories as categoryApi, libraryValues, models as modelApi } from '../api';
import { ModalDialog } from '../components/ModalDialog';
import { exposeGlobal, showMessage } from '../page';
import { selection } from '../selection';
import { askAboutConflict, bothNotes, type SaveConflict } from '../library/saving';
import { currentModelPath, showModelDetails } from '../library/details';
import { updateModel } from '../library/models';
import { recordUndo, revertTags, tagNames } from '../library/undo';
import { SITE_LABELS, SITE_DETAILS_CHANGED, getSiteDetails, siteModelUrl, type MakerWorldDetails } from '../makerworld/makerworld';
import { changedFields, listText, nameParts, parseList } from './editModel';
import { formatRoute, navigate } from '../shell/routes';

declare global {
  interface Window {
    /** Open the Edit dialog for a model (the details panel's Edit button). */
    openEditModel?: (filePath: string) => void;
  }
}

type ModelRecord = Record<string, unknown> & { filePath: string; fileName?: string | null; source?: string | null; categorySource?: string | null };

interface LibraryForm {
  name: string;
  designer: string;
  source: string;
  title: string;
  license: string;
  tags: string;
  notes: string;
  description: string;
  rating: string;
}

interface SiteForm {
  title: string;
  designer: string;
  license: string;
  categories: string;
  tags: string;
  description: string;
  [profile: `profile:${string}`]: string;
}

const text = (value: unknown) => (value == null ? '' : String(value));

function libraryForm(model: ModelRecord, stem: string): LibraryForm {
  return {
    name: stem,
    designer: text(model.designer),
    source: text(model.source),
    title: text(model.title),
    license: text(model.license),
    tags: listText(tagNames(model.tags)),
    notes: text(model.notes),
    description: text(model.description),
    rating: String(Number(model.rating) || 0)
  };
}

function siteForm(details: MakerWorldDetails): SiteForm {
  const form: SiteForm = {
    title: text(details.title),
    designer: text(details.designer?.name),
    license: text(details.license),
    categories: listText(details.categories),
    tags: listText(details.tags.map((tag) => tag.name)),
    description: text(details.description)
  };
  if (details.site === 'makerworld') for (const profile of details.profiles) form[`profile:${profile.id}`] = text(profile.name);
  return form;
}

/** A library field's value as saved: tags as a list, rating as a number, the rest trimmed. */
function fieldValue(form: LibraryForm, field: keyof LibraryForm): unknown {
  if (field === 'tags') return parseList(form.tags);
  if (field === 'rating') return Number(form.rating) || 0;
  return form[field].trim();
}

/** The site edits for `fields` of a site form, as save-site-edits takes them. */
function siteChanges(form: SiteForm, fields: (keyof SiteForm)[]): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  const profiles: Record<string, string> = {};
  for (const field of fields) {
    const key = String(field);
    if (key.startsWith('profile:')) profiles[key.slice('profile:'.length)] = form[field];
    else changes[key] = key === 'categories' || key === 'tags' ? parseList(form[field]) : form[field];
  }
  if (Object.keys(profiles).length) changes.profiles = profiles;
  return changes;
}

/**
 * Save library fields of a model: `values` to save, `base` what the person saw (or saved, for
 * Undo). When someone else changed a field meanwhile, they choose whose value stays.
 */
async function saveFields(filePath: string, values: Record<string, unknown>, base: Record<string, unknown>) {
  if (!Object.keys(values).length) return;
  const current = await modelApi.get<ModelRecord>(filePath);
  if (!current) throw new Error('This model is not in the library any more.');
  const payload: ModelRecord = { ...current, ...values };
  const result = await callAction<{ conflicts?: SaveConflict[] } | null>('save-model', { ...payload, _base: base });
  if (result?.conflicts?.length) {
    const name = text(current.fileName) || filePath;
    for (const conflict of result.conflicts) {
      const choice = await askAboutConflict(conflict, name);
      if (choice === 'theirs') payload[conflict.field] = conflict.theirs;
      else if (choice === 'both') payload[conflict.field] = bothNotes(conflict.theirs, conflict.yours);
    }
    await callAction('save-model', payload);
  }
}

/** A renamed model's new path: the selection and its page follow it. */
async function renameModel(filePath: string, name: string): Promise<string> {
  const renamed = await callAction<{ filePath: string }>('rename-model', filePath, name);
  if (renamed.filePath !== filePath && selection.has(filePath)) {
    selection.delete(filePath);
    selection.add(renamed.filePath);
  }
  if (window.location.hash === formatRoute('model', filePath)) navigate('model', renamed.filePath);
  return renamed.filePath;
}

/** Show a model's edit everywhere: the lists of values, its card, its details and its site details. */
async function showEdit(filePath: string, oldPath: string, fields: string[], siteChanged: boolean) {
  for (const kind of ['designer', 'title', 'license'] as const) if (fields.includes(kind)) void window.detailsHost?.valuesChanged(kind);
  if (fields.includes('tags')) void window.detailsHost?.valuesChanged('tag');
  await updateModel(filePath);
  if (currentModelPath() === oldPath || currentModelPath() === filePath) await showModelDetails(filePath);
  if (siteChanged) window.dispatchEvent(new Event(SITE_DETAILS_CHANGED));
}

/** What a save of the Edit dialog changed, to put back (Undo). */
interface EditUndo {
  /** The model's path after the save. */
  filePath: string;
  /** The name to rename it back to, when the save renamed it. */
  oldName: string | null;
  /** Library fields: the values before and as saved. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** The place before ('' for none) and who gave it, when the save changed it. */
  category: { name: string; source: string | null } | null;
  /** The site's link and the edits that put back its details, when the save changed them. */
  site: { url: string; changes: Record<string, unknown> } | null;
}

/** Put back what one save of the Edit dialog changed. Tags only take back that save's changes. */
async function undoEdit(edit: EditUndo) {
  let filePath = edit.filePath;
  if (edit.oldName !== null) filePath = await renameModel(filePath, edit.oldName);
  const values: Record<string, unknown> = {};
  const base: Record<string, unknown> = {};
  for (const [field, before] of Object.entries(edit.before)) {
    if (field === 'tags') {
      const current = await modelApi.get<ModelRecord>(filePath);
      values.tags = revertTags(current?.tags, before, edit.after.tags);
    } else {
      values[field] = before;
      if (field !== 'rating') base[field] = edit.after[field];
    }
  }
  await saveFields(filePath, values, base);
  if (edit.category) await categoryApi.setForModel(filePath, edit.category.name ? [edit.category.name] : [], edit.category.source);
  if (edit.site) await callAction('save-site-edits', edit.site.url, edit.site.changes);
  await showEdit(filePath, edit.filePath, Object.keys(edit.before), !!edit.site);
}

/**
 * The details panel's Edit dialog: everything the library keeps about a model (its name, which
 * renames its file, designer, source, title, license, tags, notes and rating), and for a
 * model from MakerWorld, Printables or Thingiverse what the site says about it. Site edits are kept
 * apart and laid over the site's details, so Refresh does not undo them. A save can be undone as one
 * edit (the Undo notice, Ctrl/Cmd+Z). Registers window.openEditModel.
 */
export function EditModelDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [model, setModel] = useState<ModelRecord | null>(null);
  const [start, setStart] = useState<LibraryForm | null>(null);
  const [form, setForm] = useState<LibraryForm | null>(null);
  const [details, setDetails] = useState<MakerWorldDetails | null>(null);
  const [siteStart, setSiteStart] = useState<SiteForm | null>(null);
  const [site, setSite] = useState<SiteForm | null>(null);
  const [siteNote, setSiteNote] = useState('');
  /** The list: each Category with its Subcategories' names. */
  const [allCategories, setAllCategories] = useState<{ name: string; subcategories: string[] }[]>([]);
  /** The model's place: its Subcategory's name (or its Category's when it has only that), '' for none. */
  const [categoryStart, setCategoryStart] = useState('');
  const [chosen, setChosen] = useState('');
  const [options, setOptions] = useState<{ designers: string[]; titles: string[]; licenses: string[] }>({ designers: [], titles: [], licenses: [] });
  const [saving, setSaving] = useState(false);

  useEffect(
    () =>
      exposeGlobal('openEditModel', (filePath: string) => {
        void open(filePath);
      }),
    []
  );

  async function open(filePath: string) {
    const loaded = await modelApi.get<ModelRecord>(filePath).catch(() => null);
    if (!loaded) {
      await showMessage('Error', 'This model is not in the library any more.');
      return;
    }
    const initial = libraryForm(loaded, nameParts(loaded.filePath, loaded.fileName).stem);
    setModel(loaded);
    setStart(initial);
    setForm(initial);
    setDetails(null);
    setSiteStart(null);
    setSite(null);
    const found = siteModelUrl(loaded);
    setSiteNote(found ? `Getting the details from ${SITE_LABELS[found.site]}…` : '');
    // [Category, Subcategory]: the last one is the place.
    const inCategories = Array.isArray(loaded.categories) ? (loaded.categories as string[]) : [];
    const place = inCategories[inCategories.length - 1] || '';
    setCategoryStart(place);
    setChosen(place);
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    categoryApi.list().then(
      (result) =>
        setAllCategories(
          result.categories
            .filter((category) => !category.parent_id)
            .map((main) => ({ name: main.name, subcategories: result.categories.filter((c) => c.parent_id === main.id).map((c) => c.name) }))
        ),
      () => {}
    );
    Promise.all([libraryValues.designers(), libraryValues.titles(), libraryValues.licenses()]).then(
      ([designers, titles, licenses]) =>
        setOptions({ designers: designers.filter(Boolean), titles: titles.filter(Boolean), licenses: licenses.filter(Boolean) }),
      () => {}
    );
    if (found) {
      try {
        const result = await getSiteDetails(found.url);
        if (result?.details) {
          setDetails(result.details);
          setSiteStart(siteForm(result.details));
          setSite(siteForm(result.details));
          setSiteNote('');
        } else setSiteNote(result?.error || '');
      } catch (error) {
        setSiteNote(`Could not get the details: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const close = () => dialogRef.current?.close();

  async function save() {
    if (!model || !form || !start) return;
    const fields = changedFields(start, form);
    const libraryFields = fields.filter((field) => field !== 'name');
    const siteFields = site && siteStart ? changedFields(siteStart, site) : [];
    const before = Object.fromEntries(libraryFields.map((field) => [field, fieldValue(start, field)]));
    const after = Object.fromEntries(libraryFields.map((field) => [field, fieldValue(form, field)]));
    setSaving(true);
    try {
      let filePath = model.filePath;
      if (fields.includes('name')) filePath = await renameModel(filePath, form.name);
      // `base` is what the person saw when the dialog opened, for the conflict check (tags merge).
      const base = Object.fromEntries(
        libraryFields.filter((field) => field !== 'rating').map((field) => [field, field === 'tags' ? parseList(start.tags) : start[field]])
      );
      await saveFields(filePath, after, base);
      const placeChanged = chosen !== categoryStart;
      if (placeChanged) await categoryApi.setForModel(filePath, chosen ? [chosen] : []);
      const siteChanged = !!(details && site && siteStart && siteFields.length);
      if (siteChanged) await callAction('save-site-edits', details!.url, siteChanges(site!, siteFields));
      close();
      await showEdit(filePath, model.filePath, libraryFields, siteChanged);
      if (fields.length || placeChanged || siteChanged) {
        const edit: EditUndo = {
          filePath,
          oldName: fields.includes('name') ? start.name : null,
          before,
          after,
          category: placeChanged ? { name: categoryStart, source: categoryStart ? text(model.categorySource) || null : null } : null,
          site: siteChanged ? { url: details!.url, changes: siteChanges(siteStart!, siteFields) } : null
        };
        recordUndo(`Edited ${text(model.fileName) || filePath.split(/[\\/]/).pop()}`, () => undoEdit(edit));
      }
    } catch (error) {
      await showMessage('Could not save', error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function useSiteDetails() {
    if (!details) return;
    const label = SITE_LABELS[details.site];
    const answer = await showMessage('Use the site’s details', `Forget your changes to the ${label} details of this model and show what ${label} says again?`, [
      'Use ' + label + '’s',
      'Cancel'
    ]);
    if (answer === 'Cancel' || !answer) return;
    try {
      const result = await callAction<{ details: MakerWorldDetails | null } | null>('save-site-edits', details.url, null);
      if (result?.details) {
        setDetails(result.details);
        setSiteStart(siteForm(result.details));
        setSite(siteForm(result.details));
      }
      window.dispatchEvent(new Event(SITE_DETAILS_CHANGED));
    } catch (error) {
      await showMessage('Error', error instanceof Error ? error.message : String(error));
    }
  }

  const name = model ? nameParts(model.filePath, model.fileName) : null;
  const set = (field: keyof LibraryForm) => (event: { target: { value: string } }) => setForm((now) => (now ? { ...now, [field]: event.target.value } : now));
  const setSiteField = (field: keyof SiteForm) => (event: { target: { value: string } }) =>
    setSite((now) => (now ? { ...now, [field]: event.target.value } : now));
  const siteLabel = details ? SITE_LABELS[details.site] : '';

  return (
    <ModalDialog
      id="edit-model-dialog"
      title="Edit Model"
      dialogRef={dialogRef}
      className="edit-model-dialog"
      footer={
        <>
          <button type="button" id="edit-model-save" className="is-primary" disabled={saving || !form} onClick={save}>
            Save
          </button>
          <button type="button" onClick={close}>
            Cancel
          </button>
        </>
      }
    >
      {form && name && (
        <div className="settings-group">
          <h4>In your library</h4>
          <div className="form-group">
            <label htmlFor="edit-model-name">Name</label>
            <div className="edit-model-name">
              <input id="edit-model-name" type="text" value={form.name} disabled={!!name.locked} onChange={set('name')} maxLength={200} />
              {name.extension && <span className="edit-model-extension">{name.extension}</span>}
            </div>
            <p className="setting-description">
              {name.locked || (model?.filePath.startsWith('url::') ? 'The name the library shows.' : 'Renames the file in its folder; it keeps its type.')}
            </p>
          </div>
          <div className="form-group">
            <label htmlFor="edit-model-designer">Designer</label>
            <input id="edit-model-designer" type="text" list="edit-model-designers" value={form.designer} onChange={set('designer')} />
          </div>
          <div className="form-group">
            <label htmlFor="edit-model-source">Source</label>
            <input id="edit-model-source" type="url" value={form.source} onChange={set('source')} placeholder="https://" />
          </div>
          <div className="form-group">
            <label htmlFor="edit-model-title">Title</label>
            <input id="edit-model-title" type="text" list="edit-model-titles" value={form.title} onChange={set('title')} />
          </div>
          <div className="form-group">
            <label htmlFor="edit-model-license">License</label>
            <input id="edit-model-license" type="text" list="edit-model-licenses" value={form.license} onChange={set('license')} />
          </div>
          <div className="form-group">
            <label htmlFor="edit-model-tags">Tags</label>
            <input id="edit-model-tags" type="text" value={form.tags} onChange={set('tags')} />
            <p className="setting-description">Separated by commas.</p>
          </div>
          {allCategories.length > 0 && (
            <div className="form-group" id="edit-model-categories">
              <label htmlFor="edit-model-category">Category › Subcategory</label>
              <select id="edit-model-category" value={chosen} onChange={(event) => setChosen(event.target.value)}>
                <option value="">None yet (Categorize Library or AI Tagging places it)</option>
                {allCategories.map((main) => (
                  <optgroup key={main.name} label={main.name}>
                    {/* A Category alone, as it was (it gets a Subcategory at the next sort). */}
                    {chosen === main.name && <option value={main.name}>{main.name} › (no Subcategory yet)</option>}
                    {main.subcategories.map((sub) => (
                      <option key={sub} value={sub}>
                        {main.name} › {sub}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="setting-description">Chosen here, it stays: Categorize Library and the AI do not change it.</p>
            </div>
          )}
          <div className="form-group">
            <label htmlFor="edit-model-rating">Rating</label>
            <select id="edit-model-rating" value={form.rating} onChange={set('rating')}>
              <option value="0">No rating</option>
              {[1, 2, 3, 4, 5].map((stars) => (
                <option key={stars} value={String(stars)}>
                  {'★'.repeat(stars)}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="edit-model-description">Description</label>
            <textarea id="edit-model-description" rows={6} value={form.description} onChange={set('description')} />
            <p className="setting-description">What the model is: its site's or its 3MF's description. Markdown works.</p>
          </div>
          <div className="form-group">
            <label htmlFor="edit-model-notes">Notes</label>
            <textarea id="edit-model-notes" rows={4} value={form.notes} onChange={set('notes')} />
          </div>
          <datalist id="edit-model-designers">
            {options.designers.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
          <datalist id="edit-model-titles">
            {options.titles.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
          <datalist id="edit-model-licenses">
            {options.licenses.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </div>
      )}
      {siteNote && (
        <div className="settings-group">
          <p className="setting-description">{siteNote}</p>
        </div>
      )}
      {details && site && (
        <div className="settings-group" id="edit-model-site">
          <h4>From {siteLabel}</h4>
          <p className="setting-description">
            Your changes are kept in JusttPrint and shown instead of what {siteLabel} says, also after Refresh. {siteLabel} itself is not changed.
          </p>
          <div className="form-group">
            <label htmlFor="edit-site-title">Title</label>
            <input id="edit-site-title" type="text" value={site.title} onChange={setSiteField('title')} maxLength={300} />
          </div>
          <div className="form-group">
            <label htmlFor="edit-site-designer">Designer</label>
            <input id="edit-site-designer" type="text" value={site.designer} onChange={setSiteField('designer')} maxLength={200} />
          </div>
          <div className="form-group">
            <label htmlFor="edit-site-license">License</label>
            <input id="edit-site-license" type="text" value={site.license} onChange={setSiteField('license')} maxLength={200} />
          </div>
          <div className="form-group">
            <label htmlFor="edit-site-categories">Categories</label>
            <input id="edit-site-categories" type="text" value={site.categories} onChange={setSiteField('categories')} />
            <p className="setting-description">Separated by commas.</p>
          </div>
          <div className="form-group">
            <label htmlFor="edit-site-tags">Tags</label>
            <input id="edit-site-tags" type="text" value={site.tags} onChange={setSiteField('tags')} />
            <p className="setting-description">Separated by commas.</p>
          </div>
          <div className="form-group">
            <label htmlFor="edit-site-description">Description</label>
            <textarea id="edit-site-description" rows={6} value={site.description} onChange={setSiteField('description')} />
          </div>
          {details.site === 'makerworld' &&
            details.profiles.map((profile, index) => (
              <div className="form-group" key={profile.id}>
                <label htmlFor={`edit-site-profile-${profile.id}`}>Print profile {index + 1}</label>
                <input
                  id={`edit-site-profile-${profile.id}`}
                  type="text"
                  value={site[`profile:${profile.id}`]}
                  onChange={setSiteField(`profile:${profile.id}`)}
                  maxLength={300}
                />
              </div>
            ))}
          {!!details.edited?.length && (
            <button type="button" id="edit-site-reset" onClick={useSiteDetails}>
              Use {siteLabel}’s Details
            </button>
          )}
        </div>
      )}
    </ModalDialog>
  );
}
