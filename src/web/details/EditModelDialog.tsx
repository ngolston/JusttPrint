import { useEffect, useRef, useState } from 'react';
import { callAction, categories as categoryApi, libraryValues, models as modelApi } from '../api';
import { ModalDialog } from '../components/ModalDialog';
import { exposeGlobal, showMessage } from '../page';
import { selection } from '../selection';
import { askAboutConflict, bothNotes, type SaveConflict } from '../library/saving';
import { currentModelPath, showModelDetails } from '../library/details';
import { updateModel } from '../library/models';
import { tagNames } from '../library/undo';
import { SITE_LABELS, SITE_DETAILS_CHANGED, getSiteDetails, siteModelUrl, type MakerWorldDetails } from '../makerworld/makerworld';
import { changedFields, listText, nameParts, parseList } from './editModel';
import { formatRoute, navigate } from '../shell/routes';

declare global {
  interface Window {
    /** Open the Edit dialog for a model (the details panel's Edit button). */
    openEditModel?: (filePath: string) => void;
  }
}

type ModelRecord = Record<string, unknown> & { filePath: string; fileName?: string | null; source?: string | null };

interface LibraryForm {
  name: string;
  designer: string;
  source: string;
  parentModel: string;
  license: string;
  tags: string;
  notes: string;
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
    parentModel: text(model.parentModel),
    license: text(model.license),
    tags: listText(tagNames(model.tags)),
    notes: text(model.notes),
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

/**
 * The details panel's Edit dialog: everything the library keeps about a model (its name, which
 * renames its file, designer, source, parent model, license, tags, notes and rating), and for a
 * model from MakerWorld, Printables or Thingiverse what the site says about it. Site edits are kept
 * apart and laid over the site's details, so Refresh does not undo them. Registers window.openEditModel.
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
  const [allCategories, setAllCategories] = useState<string[]>([]);
  const [categoryStart, setCategoryStart] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [options, setOptions] = useState<{ designers: string[]; parents: string[]; licenses: string[] }>({ designers: [], parents: [], licenses: [] });
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
    const inCategories = Array.isArray(loaded.categories) ? (loaded.categories as string[]) : [];
    setCategoryStart(inCategories);
    setChosen(inCategories);
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    categoryApi.list().then(
      (result) => setAllCategories(result.categories.map((category) => category.name)),
      () => {}
    );
    Promise.all([libraryValues.designers(), libraryValues.parentModels(), libraryValues.licenses()]).then(
      ([designers, parents, licenses]) =>
        setOptions({ designers: designers.filter(Boolean), parents: parents.filter(Boolean), licenses: licenses.filter(Boolean) }),
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

  /** Save the library fields; answers false when nothing of this person's was kept. */
  async function saveLibrary(filePath: string, fields: (keyof LibraryForm)[]) {
    if (!form || !start || !fields.length) return true;
    const current = await modelApi.get<ModelRecord>(filePath);
    if (!current) throw new Error('This model is not in the library any more.');
    const payload: ModelRecord = { ...current };
    const base: Record<string, unknown> = {};
    for (const field of fields) {
      if (field === 'tags') {
        payload.tags = parseList(form.tags);
        base.tags = parseList(start.tags);
      } else if (field === 'rating') payload.rating = Number(form.rating) || 0;
      else {
        payload[field] = form[field].trim();
        base[field] = start[field];
      }
    }
    const result = await callAction<{ conflicts?: SaveConflict[] } | null>('save-model', { ...payload, _base: base });
    if (result?.conflicts?.length) {
      // Someone else changed a field meanwhile: whose value stays, field by field.
      const name = text(current.fileName) || filePath;
      for (const conflict of result.conflicts) {
        const choice = await askAboutConflict(conflict, name);
        if (choice === 'theirs') payload[conflict.field] = conflict.theirs;
        else if (choice === 'both') payload[conflict.field] = bothNotes(conflict.theirs, conflict.yours);
      }
      await callAction('save-model', payload);
    }
    return true;
  }

  async function save() {
    if (!model || !form || !start) return;
    const fields = changedFields(start, form);
    const siteFields = site && siteStart ? changedFields(siteStart, site) : [];
    setSaving(true);
    try {
      let filePath = model.filePath;
      if (fields.includes('name')) {
        const renamed = await callAction<{ filePath: string }>('rename-model', filePath, form.name);
        if (renamed.filePath !== filePath && selection.has(filePath)) {
          selection.delete(filePath);
          selection.add(renamed.filePath);
        }
        // The model's page follows its new name.
        if (window.location.hash === formatRoute('model', filePath)) navigate('model', renamed.filePath);
        filePath = renamed.filePath;
      }
      await saveLibrary(
        filePath,
        fields.filter((field) => field !== 'name')
      );
      const categoriesChanged = changedFields({ list: [...categoryStart].sort() }, { list: [...chosen].sort() }).length > 0;
      if (categoriesChanged) await categoryApi.setForModel(filePath, chosen);
      if (details && site && siteFields.length) {
        const changes: Record<string, unknown> = {};
        const profiles: Record<string, string> = {};
        for (const field of siteFields) {
          const key = String(field);
          if (key.startsWith('profile:')) profiles[key.slice('profile:'.length)] = site[field as keyof SiteForm];
          else changes[key] = key === 'categories' || key === 'tags' ? parseList(site[field as keyof SiteForm]) : site[field as keyof SiteForm];
        }
        if (Object.keys(profiles).length) changes.profiles = profiles;
        await callAction('save-site-edits', details.url, changes);
      }
      close();
      for (const kind of ['designer', 'parentModel', 'license'] as const) if (fields.includes(kind)) void window.detailsHost?.valuesChanged(kind);
      if (fields.includes('tags')) void window.detailsHost?.valuesChanged('tag');
      await updateModel(filePath);
      if (currentModelPath() === model.filePath || currentModelPath() === filePath) await showModelDetails(filePath);
      if (siteFields.length) window.dispatchEvent(new Event(SITE_DETAILS_CHANGED));
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
            <label htmlFor="edit-model-parent">Parent model</label>
            <input id="edit-model-parent" type="text" list="edit-model-parents" value={form.parentModel} onChange={set('parentModel')} />
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
            <fieldset className="form-group edit-model-categories" id="edit-model-categories">
              <legend>Categories</legend>
              <div className="edit-model-categories__list">
                {allCategories.map((name) => (
                  <label key={name} className="edit-model-categories__item">
                    <input
                      type="checkbox"
                      checked={chosen.includes(name)}
                      onChange={(event) => setChosen((now) => (event.target.checked ? [...now, name] : now.filter((n) => n !== name)))}
                    />
                    <span>{name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
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
            <label htmlFor="edit-model-notes">Notes</label>
            <textarea id="edit-model-notes" rows={4} value={form.notes} onChange={set('notes')} />
          </div>
          <datalist id="edit-model-designers">
            {options.designers.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
          <datalist id="edit-model-parents">
            {options.parents.map((value) => (
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
