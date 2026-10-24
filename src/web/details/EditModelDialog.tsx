import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ExternalLink, Star, X } from 'lucide-react';
import { callAction, categories as categoryApi, libraryValues, models as modelApi, tags as tagApi } from '../api';
import { Button, cx } from '../components/Button';
import { Modal } from '../components/Overlay';
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

/** A field: its label (marked when changed), the control, and a hint under it. */
function Field({
  label,
  htmlFor,
  changed,
  hint,
  wide,
  children
}: {
  label: string;
  htmlFor?: string;
  changed?: boolean;
  hint?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cx('jp-edit__field', wide && 'jp-edit__field--wide')}>
      <label className="jp-edit__label" htmlFor={htmlFor}>
        {label}
        {changed && (
          <span className="jp-edit__changed" title="Changed">
            <span className="jp-sr-only">(changed)</span>
          </span>
        )}
      </label>
      {children}
      {hint && <p className="jp-edit__hint">{hint}</p>}
    </div>
  );
}

/**
 * Tags as chips: type and press Enter or a comma to add one, × or Backspace (in an empty field) to
 * take one off. `draft` is what is typed and not added yet (Save adds it too).
 */
function TagChips({
  id,
  value,
  onChange,
  draft,
  onDraft,
  suggestions
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  draft: string;
  onDraft: (next: string) => void;
  suggestions: string[];
}) {
  const chips = parseList(value);
  const add = (text: string) => {
    const added = parseList(text);
    if (added.length) onChange(listText(parseList([...chips, ...added].join(','))));
    onDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if ((event.key === 'Enter' || event.key === ',') && draft.trim()) {
      event.preventDefault();
      add(draft);
    } else if (event.key === 'Backspace' && !draft && chips.length) {
      onChange(listText(chips.slice(0, -1)));
    }
  };
  return (
    <div className="jp-input jp-edit__chips">
      {chips.map((tag) => (
        <span key={tag} className="jp-edit__chip">
          {tag}
          <button type="button" aria-label={`Remove the tag ${tag}`} onClick={() => onChange(listText(chips.filter((t) => t !== tag)))}>
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        list={`${id}-list`}
        value={draft}
        placeholder={chips.length ? 'Add a tag…' : 'Add tags: type and press Enter'}
        onChange={(event) => {
          const text = event.target.value;
          if (text.includes(',')) add(text);
          else onDraft(text);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && add(draft)}
      />
      <datalist id={`${id}-list`}>
        {suggestions
          .filter((tag) => !chips.includes(tag))
          .slice(0, 200)
          .map((tag) => (
            <option key={tag} value={tag} />
          ))}
      </datalist>
    </div>
  );
}

/** Rating as five stars; the × clears it. */
function StarPicker({ value, onChange }: { value: number; onChange: (stars: number) => void }) {
  return (
    <div className="jp-edit__stars" role="group" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((stars) => (
        <button
          key={stars}
          type="button"
          id={`edit-model-rating-${stars}`}
          className={cx('jp-edit__star', stars <= value && 'is-on')}
          aria-label={`${stars} ${stars === 1 ? 'star' : 'stars'}`}
          aria-pressed={stars === value}
          onClick={() => onChange(stars)}
        >
          <Star size={20} aria-hidden="true" />
        </button>
      ))}
      <button
        type="button"
        id="edit-model-rating-0"
        className="jp-edit__star-clear"
        aria-label="No rating"
        title="No rating"
        disabled={!value}
        onClick={() => onChange(0)}
      >
        <X size={14} aria-hidden="true" />
      </button>
      <span className="jp-meta">{value ? `${value} of 5` : 'No rating'}</span>
    </div>
  );
}

/**
 * The details panel's Edit dialog: everything the library keeps about a model (its name, which
 * renames its file, title, designer, source, license, rating, place, tags, description and notes),
 * and for a model from MakerWorld, Printables or Thingiverse what the site says about it (its own
 * tab). Site edits are kept apart and laid over the site's details, so Refresh does not undo them.
 * Changed fields are marked and counted; Save (or Ctrl/Cmd+Enter) saves them all as one edit that
 * Undo takes back. Closing with changes asks first. Registers window.openEditModel.
 */
export function EditModelDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<'library' | 'site'>('library');
  const [model, setModel] = useState<ModelRecord | null>(null);
  const [start, setStart] = useState<LibraryForm | null>(null);
  const [form, setForm] = useState<LibraryForm | null>(null);
  /** A tag typed and not added as a chip yet. */
  const [tagDraft, setTagDraft] = useState('');
  const [details, setDetails] = useState<MakerWorldDetails | null>(null);
  const [siteStart, setSiteStart] = useState<SiteForm | null>(null);
  const [site, setSite] = useState<SiteForm | null>(null);
  const [siteNote, setSiteNote] = useState('');
  /** The list: each Category with its Subcategories' names. */
  const [allCategories, setAllCategories] = useState<{ name: string; subcategories: string[] }[]>([]);
  /** The model's place: its Subcategory's name (or its Category's when it has only that), '' for none. */
  const [categoryStart, setCategoryStart] = useState('');
  const [chosen, setChosen] = useState('');
  const [options, setOptions] = useState<{ designers: string[]; titles: string[]; licenses: string[]; tags: string[] }>({
    designers: [],
    titles: [],
    licenses: [],
    tags: []
  });
  const [saving, setSaving] = useState(false);

  useEffect(
    () =>
      exposeGlobal('openEditModel', (filePath: string) => {
        void open(filePath);
      }),
    []
  );

  async function open(filePath: string) {
    // Nothing of the model edited last shows while this one loads.
    setForm(null);
    setStart(null);
    setModel(null);
    const loaded = await modelApi.get<ModelRecord>(filePath).catch(() => null);
    if (!loaded) {
      await showMessage('Error', 'This model is not in the library any more.');
      return;
    }
    const initial = libraryForm(loaded, nameParts(loaded.filePath, loaded.fileName).stem);
    setModel(loaded);
    setStart(initial);
    setForm(initial);
    setTagDraft('');
    setTab('library');
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
    setIsOpen(true);
    categoryApi.list().then(
      (result) =>
        setAllCategories(
          result.categories
            .filter((category) => !category.parent_id)
            .map((main) => ({ name: main.name, subcategories: result.categories.filter((c) => c.parent_id === main.id).map((c) => c.name) }))
        ),
      () => {}
    );
    Promise.all([libraryValues.designers(), libraryValues.titles(), libraryValues.licenses(), tagApi.list().catch(() => [])]).then(
      ([designers, titles, licenses, allTags]) =>
        setOptions({
          designers: designers.filter(Boolean),
          titles: titles.filter(Boolean),
          licenses: licenses.filter(Boolean),
          tags: allTags.map((tag) => tag.name).filter(Boolean)
        }),
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

  const close = () => setIsOpen(false);

  /** The form with a typed tag that is not a chip yet added (what Save saves). */
  const withDraft = (now: LibraryForm): LibraryForm => (tagDraft.trim() ? { ...now, tags: listText(parseList([now.tags, tagDraft].join(','))) } : now);

  const libraryChanges = form && start ? changedFields(start, withDraft(form)) : [];
  const siteChangeList = site && siteStart ? changedFields(siteStart, site) : [];
  const placeChange = chosen !== categoryStart;
  const changeCount = libraryChanges.length + siteChangeList.length + (placeChange ? 1 : 0);

  /** Close, asking first when there are changes. */
  async function requestClose() {
    if (saving) return;
    if (changeCount) {
      const answer = await showMessage('Discard your changes?', `${changeCount} ${changeCount === 1 ? 'change is' : 'changes are'} not saved.`, [
        'Discard',
        'Keep Editing'
      ]);
      if (answer !== 'Discard') return;
    }
    close();
  }

  async function save() {
    if (!model || !form || !start) return;
    const current = withDraft(form);
    const fields = changedFields(start, current);
    const libraryFields = fields.filter((field) => field !== 'name');
    const siteFields = site && siteStart ? changedFields(siteStart, site) : [];
    const before = Object.fromEntries(libraryFields.map((field) => [field, fieldValue(start, field)]));
    const after = Object.fromEntries(libraryFields.map((field) => [field, fieldValue(current, field)]));
    setSaving(true);
    try {
      let filePath = model.filePath;
      if (fields.includes('name')) filePath = await renameModel(filePath, current.name);
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
  const siteLabel = details ? SITE_LABELS[details.site] : model ? SITE_LABELS[siteModelUrl(model)?.site as keyof typeof SITE_LABELS] || '' : '';
  const hasSite = !!(details || siteNote);
  const changed = (field: keyof LibraryForm) => libraryChanges.includes(field);
  const siteChanged = (field: keyof SiteForm) => siteChangeList.includes(field);
  const sourceIsLink = !!form && /^https?:\/\//i.test(form.source.trim());
  const fileName = model ? text(model.fileName) || model.filePath.split(/[\\/]/).pop() : '';

  return (
    <Modal
      id="edit-model-dialog"
      open={isOpen}
      onClose={() => void requestClose()}
      className="jp-edit"
      title={
        <span className="jp-edit__title">
          Edit Model
          {fileName && (
            <span className="jp-meta" title={model?.filePath}>
              {fileName}
            </span>
          )}
        </span>
      }
      footer={
        <>
          <span className="jp-edit__status" role="status">
            {changeCount ? `${changeCount} ${changeCount === 1 ? 'change' : 'changes'}` : 'No changes yet'}
          </span>
          <span className="jp-meta jp-edit__shortcut">Ctrl/⌘ + Enter saves</span>
          <Button onClick={() => void requestClose()} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" id="edit-model-save" disabled={saving || !form || !changeCount} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div
        className="jp-edit__body"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && changeCount && !saving) {
            event.preventDefault();
            void save();
          }
        }}
      >
        {hasSite && (
          <div className="jp-edit__tabs" role="tablist" aria-label="What to edit">
            <button
              type="button"
              role="tab"
              id="edit-model-tab-library"
              aria-selected={tab === 'library'}
              className={cx(tab === 'library' && 'is-active')}
              onClick={() => setTab('library')}
            >
              In your library
              {libraryChanges.length + (placeChange ? 1 : 0) > 0 && <span className="jp-edit__changed" aria-hidden="true" />}
            </button>
            <button
              type="button"
              role="tab"
              id="edit-model-tab-site"
              aria-selected={tab === 'site'}
              className={cx(tab === 'site' && 'is-active')}
              onClick={() => setTab('site')}
            >
              From {siteLabel || 'the site'}
              {siteChangeList.length > 0 && <span className="jp-edit__changed" aria-hidden="true" />}
            </button>
          </div>
        )}

        {form && name && (
          <div className="jp-edit__panel" hidden={tab !== 'library'} role={hasSite ? 'tabpanel' : undefined}>
            <section className="jp-edit__section" aria-labelledby="edit-model-basics">
              <h3 className="jp-edit__heading" id="edit-model-basics">
                Basics
              </h3>
              <div className="jp-edit__grid">
                <Field
                  label="Name"
                  htmlFor="edit-model-name"
                  changed={changed('name')}
                  wide
                  hint={
                    name.locked || (model?.filePath.startsWith('url::') ? 'The name the library shows.' : 'Renames the file in its folder; it keeps its type.')
                  }
                >
                  <div className="jp-edit__name">
                    <input
                      className="jp-input"
                      id="edit-model-name"
                      type="text"
                      value={form.name}
                      disabled={!!name.locked}
                      onChange={set('name')}
                      maxLength={200}
                    />
                    {name.extension && <span className="jp-edit__extension">{name.extension}</span>}
                  </div>
                </Field>
                <Field label="Title" htmlFor="edit-model-title" changed={changed('title')} hint="Shown instead of the file name.">
                  <input className="jp-input" id="edit-model-title" type="text" list="edit-model-titles" value={form.title} onChange={set('title')} />
                </Field>
                <Field label="Designer" htmlFor="edit-model-designer" changed={changed('designer')}>
                  <input
                    className="jp-input"
                    id="edit-model-designer"
                    type="text"
                    list="edit-model-designers"
                    value={form.designer}
                    onChange={set('designer')}
                  />
                </Field>
                <Field label="Source" htmlFor="edit-model-source" changed={changed('source')} wide>
                  <div className="jp-edit__with-button">
                    <input className="jp-input" id="edit-model-source" type="url" value={form.source} onChange={set('source')} placeholder="https://" />
                    {sourceIsLink && (
                      <a
                        className="jp-btn jp-btn--secondary jp-btn--md"
                        href={form.source.trim()}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Open the source in a new tab"
                      >
                        <ExternalLink size={16} aria-hidden="true" />
                      </a>
                    )}
                  </div>
                </Field>
                <Field label="License" htmlFor="edit-model-license" changed={changed('license')}>
                  <input className="jp-input" id="edit-model-license" type="text" list="edit-model-licenses" value={form.license} onChange={set('license')} />
                </Field>
                <Field label="Rating" changed={changed('rating')}>
                  <StarPicker value={Number(form.rating) || 0} onChange={(stars) => setForm((now) => (now ? { ...now, rating: String(stars) } : now))} />
                </Field>
              </div>
            </section>

            <section className="jp-edit__section" aria-labelledby="edit-model-organize">
              <h3 className="jp-edit__heading" id="edit-model-organize">
                Organize
              </h3>
              <div className="jp-edit__grid">
                {allCategories.length > 0 && (
                  <Field
                    label="Category › Subcategory"
                    htmlFor="edit-model-category"
                    changed={placeChange}
                    wide
                    hint="Chosen here, it stays: Categorize Library and the AI do not change it."
                  >
                    <select className="jp-input" id="edit-model-category" value={chosen} onChange={(event) => setChosen(event.target.value)}>
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
                  </Field>
                )}
                <Field label="Tags" htmlFor="edit-model-tags" changed={changed('tags')} wide hint="Press Enter or type a comma to add a tag.">
                  <TagChips
                    id="edit-model-tags"
                    value={form.tags}
                    onChange={(next) => setForm((now) => (now ? { ...now, tags: next } : now))}
                    draft={tagDraft}
                    onDraft={setTagDraft}
                    suggestions={options.tags}
                  />
                </Field>
              </div>
            </section>

            <section className="jp-edit__section" aria-labelledby="edit-model-about">
              <h3 className="jp-edit__heading" id="edit-model-about">
                About
              </h3>
              <div className="jp-edit__grid">
                <Field
                  label="Description"
                  htmlFor="edit-model-description"
                  changed={changed('description')}
                  wide
                  hint="What the model is: its site's or its 3MF's description. Markdown works."
                >
                  <textarea className="jp-input" id="edit-model-description" rows={6} value={form.description} onChange={set('description')} />
                </Field>
                <Field
                  label="Notes"
                  htmlFor="edit-model-notes"
                  changed={changed('notes')}
                  wide
                  hint="Your own notes: settings that worked, what to fix next time."
                >
                  <textarea className="jp-input" id="edit-model-notes" rows={4} value={form.notes} onChange={set('notes')} />
                </Field>
              </div>
            </section>

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

        {hasSite && (
          <div className="jp-edit__panel" hidden={tab !== 'site'} role="tabpanel" id="edit-model-site">
            {siteNote && <p className="jp-meta">{siteNote}</p>}
            {details && site && (
              <>
                <p className="jp-meta jp-edit__intro">
                  Your changes are kept in JusttPrint and shown instead of what {siteLabel} says, also after Refresh. {siteLabel} itself is not changed.
                </p>
                <div className="jp-edit__grid">
                  <Field label="Title" htmlFor="edit-site-title" changed={siteChanged('title')} wide>
                    <input className="jp-input" id="edit-site-title" type="text" value={site.title} onChange={setSiteField('title')} maxLength={300} />
                  </Field>
                  <Field label="Designer" htmlFor="edit-site-designer" changed={siteChanged('designer')}>
                    <input className="jp-input" id="edit-site-designer" type="text" value={site.designer} onChange={setSiteField('designer')} maxLength={200} />
                  </Field>
                  <Field label="License" htmlFor="edit-site-license" changed={siteChanged('license')}>
                    <input className="jp-input" id="edit-site-license" type="text" value={site.license} onChange={setSiteField('license')} maxLength={200} />
                  </Field>
                  <Field label="Categories" htmlFor="edit-site-categories" changed={siteChanged('categories')} hint="Separated by commas.">
                    <input className="jp-input" id="edit-site-categories" type="text" value={site.categories} onChange={setSiteField('categories')} />
                  </Field>
                  <Field label="Tags" htmlFor="edit-site-tags" changed={siteChanged('tags')} hint="Separated by commas.">
                    <input className="jp-input" id="edit-site-tags" type="text" value={site.tags} onChange={setSiteField('tags')} />
                  </Field>
                  <Field label="Description" htmlFor="edit-site-description" changed={siteChanged('description')} wide>
                    <textarea className="jp-input" id="edit-site-description" rows={6} value={site.description} onChange={setSiteField('description')} />
                  </Field>
                  {details.site === 'makerworld' &&
                    details.profiles.map((profile, index) => (
                      <Field
                        key={profile.id}
                        label={`Print profile ${index + 1}`}
                        htmlFor={`edit-site-profile-${profile.id}`}
                        changed={siteChanged(`profile:${profile.id}`)}
                        wide
                      >
                        <input
                          className="jp-input"
                          id={`edit-site-profile-${profile.id}`}
                          type="text"
                          value={site[`profile:${profile.id}`]}
                          onChange={setSiteField(`profile:${profile.id}`)}
                          maxLength={300}
                        />
                      </Field>
                    ))}
                </div>
                {!!details.edited?.length && (
                  <Button id="edit-site-reset" onClick={() => void useSiteDetails()}>
                    Use {siteLabel}’s Details
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
