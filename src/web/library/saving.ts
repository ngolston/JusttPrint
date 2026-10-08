/**
 * Saving model fields: one model (the details panel, a card's stars and heart), every selected
 * model (multi-edit), or a group's models (a group card's stars and heart).
 */
import { callAction, models as modelApi } from '../api';
import { showMessage } from '../page';
import { selection } from '../selection';
import type { GridModel } from '../grid/layout';
import { mergeModel, refreshGrid, updateModel } from './models';
import { currentModelPath } from './details';
import { recordUndo, revertTags, sameValue, tagNames } from './undo';

type ModelRecord = GridModel & Record<string, unknown>;

/** A field someone else changed while this browser was editing it (src/core/edit-merge.js). */
export interface SaveConflict {
  field: string;
  theirs: string | null;
  yours: string | null;
}

const FIELD_NAMES: Record<string, string> = { designer: 'designer', parentModel: 'parent model', license: 'license', source: 'source', notes: 'notes', tags: 'tags' };

/** Fields whose edits can be undone (rating, favorite and print status are one click to change back). */
const UNDOABLE = new Set(Object.keys(FIELD_NAMES));

const nameOf = (model: ModelRecord, filePath: string) => String(model.fileName || filePath.split(/[\\/]/).pop() || 'this model');

const shown = (value: string | null) => {
  const text = String(value ?? '').trim();
  if (!text) return '(empty)';
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
};

/** "Keep Mine", "Keep Theirs" or (notes) "Keep Both": what to do about a conflict. */
export async function askAboutConflict(conflict: SaveConflict, modelName: string): Promise<'mine' | 'theirs' | 'both'> {
  const what = FIELD_NAMES[conflict.field] || conflict.field;
  const buttons = conflict.field === 'notes' ? ['Keep Mine', 'Keep Theirs', 'Keep Both'] : ['Keep Mine', 'Keep Theirs'];
  const answer = await showMessage('Changed by someone else',
    `While you were editing, someone else changed the ${what} of ${modelName}.\n\nTheirs:\n${shown(conflict.theirs)}\n\nYours:\n${shown(conflict.yours)}`,
    buttons);
  return answer === 'Keep Mine' ? 'mine' : answer === 'Keep Both' ? 'both' : 'theirs';
}

/** Notes kept from both: theirs, then yours. */
export const bothNotes = (theirs: string | null, yours: string | null) =>
  [String(theirs ?? '').trim(), String(yours ?? '').trim()].filter(Boolean).join('\n\n');

/**
 * Save one field of one model, then update its card (and the details panel's print status).
 * `base` is the value the person saw when they started editing: when someone else changed the
 * field meanwhile, they choose whose value stays. Resolves false when nothing of theirs was saved.
 */
export async function saveModelField(field: string, value: unknown, filePath: string, base?: unknown, options: { undoable?: boolean } = {}): Promise<boolean> {
  try {
    const model = await modelApi.get<ModelRecord>(filePath);
    if (!model) return false;
    let saved = value;
    const payload: ModelRecord = { ...model, [field]: value };
    if (base !== undefined) payload._base = { [field]: base };
    const result = await callAction<{ success?: boolean; conflicts?: SaveConflict[] } | null>('save-model', payload);
    if (result && Array.isArray(result.conflicts) && result.conflicts.length) {
      const conflict = result.conflicts[0];
      const choice = await askAboutConflict(conflict, nameOf(model, filePath));
      if (choice === 'theirs') {
        await updateModel(filePath);
        if (currentModelPath() === filePath) await window.reloadShownModelDetails?.();
        return false;
      }
      const kept = choice === 'both' ? bothNotes(conflict.theirs, conflict.yours) : value;
      await callAction('save-model', { ...model, [field]: kept });
      saved = kept;
      if (choice === 'both' && currentModelPath() === filePath) await window.reloadShownModelDetails?.();
    }
    await updateModel(filePath);
    const before = field === 'tags' ? tagNames(model.tags) : model[field];
    if (options.undoable !== false && UNDOABLE.has(field) && !sameValue(field, before, saved)) {
      recordUndo(`Changed the ${FIELD_NAMES[field]} of ${nameOf(model, filePath)}`, () => undoModelField(field, filePath, before, saved));
    }
    if ((field === 'printed' || field === 'printStatus') && currentModelPath() === filePath) {
      const updated = await modelApi.get<ModelRecord>(filePath);
      if (updated) window.detailsPrint?.show(updated as never);
    }
    return true;
  } catch (error) {
    console.error(`Error saving ${field}:`, error);
    return false;
  }
}

/**
 * Put a field back. It goes through the same check as any edit: if someone else changed the
 * field since, they are asked whose value stays. Tags only take back this edit's changes.
 */
async function undoModelField(field: string, filePath: string, before: unknown, after: unknown) {
  if (field === 'tags') {
    const current = await modelApi.get<ModelRecord>(filePath);
    if (!current) return;
    await saveModelField('tags', revertTags(current.tags, before, after), filePath, undefined, { undoable: false });
  } else {
    await saveModelField(field, before, filePath, after, { undoable: false });
  }
  if (currentModelPath() === filePath) await window.reloadShownModelDetails?.();
}

declare global {
  interface Window {
    /** library/actions.ts: show the details panel's model again from the JusttPrint backend. */
    reloadShownModelDetails?: () => Promise<void>;
  }
}

const tagList = tagNames;

/** Save many models at once (one transaction), one by one if that fails; then redraw their cards. */
async function saveBatch(batch: ModelRecord[]) {
  try {
    if (!await callAction<boolean>('update-models-batch', batch)) throw new Error('Bulk update returned false');
  } catch (error) {
    console.error(`Bulk update of ${batch.length} models failed, saving one at a time:`, error);
    await Promise.all(batch.map((model) => callAction('save-model', model).catch((e) => console.error('Error saving', model.filePath, e))));
  }
  batch.forEach((model) => mergeModel({ ...model }));
  refreshGrid();
}

/**
 * Set a field on every selected model. Tags are added to what each model has
 * (replaced with `replace`); an empty designer becomes "Unknown".
 */
export async function saveSelectedField(field: string, value: unknown, options: { replace?: boolean } = {}): Promise<boolean> {
  const paths = selection.values();
  if (!paths.length) return false;
  try {
    const loaded = (await Promise.all(paths.map((p) => modelApi.get<ModelRecord>(p).catch(() => null)))).filter((m): m is ModelRecord => !!m);
    const before = loaded.map((model) => (field === 'tags' ? tagList(model.tags) : model[field]));
    for (const model of loaded) {
      if (field === 'tags') {
        const next = tagList(value);
        model.tags = (options.replace ? next : [...new Set([...tagList(model.tags), ...next])]).sort();
      } else {
        model[field] = field === 'designer' && !value ? 'Unknown' : value;
      }
    }
    if (loaded.length) await saveBatch(loaded);
    if (UNDOABLE.has(field)) {
      const changes = loaded.map((model, i) => ({ filePath: model.filePath, before: before[i], after: model[field] }))
        .filter((c) => !sameValue(field, c.before, c.after));
      const what = field === 'tags' ? (options.replace ? 'Replaced the tags of' : 'Added tags to') : `Changed the ${FIELD_NAMES[field]} of`;
      if (changes.length) recordUndo(`${what} ${modelCount(changes.length)}`, () => undoBatch(field, changes));
    }
    return true;
  } catch (error) {
    console.error(`Error saving ${field} on the selected models:`, error);
    return false;
  }
}

/** Remove one tag from every selected model, keeping their others. */
export async function removeFromSelected(field: 'tags', value: string) {
  const batch: ModelRecord[] = [];
  const changes: FieldChange[] = [];
  for (const filePath of selection.values()) {
    const model = await modelApi.get<ModelRecord>(filePath).catch(() => null);
    if (!model) continue;
    const tags = tagList(model.tags);
    if (!tags.includes(String(value))) continue;
    model.tags = tags.filter((t) => t !== value);
    batch.push(model);
    changes.push({ filePath, before: tags, after: model.tags });
  }
  if (batch.length) await saveBatch(batch);
  if (changes.length) recordUndo(`Removed the tag "${value}" from ${modelCount(changes.length)}`, () => undoBatch('tags', changes));
}

const modelCount = (n: number) => (n === 1 ? '1 model' : `${n} models`);

interface FieldChange { filePath: string; before: unknown; after: unknown }

/**
 * Undo a multi-edit. Tags take back only what the edit added or removed. Other fields go back
 * only on models nobody changed since; the person is told about the rest.
 */
async function undoBatch(field: string, changes: FieldChange[]) {
  const current = await Promise.all(changes.map((c) => modelApi.get<ModelRecord>(c.filePath).catch(() => null)));
  const batch: ModelRecord[] = [];
  let changedSince = 0;
  changes.forEach((change, i) => {
    const model = current[i];
    if (!model) return;
    if (field === 'tags') {
      model.tags = revertTags(model.tags, change.before, change.after);
    } else if (sameValue(field, model[field], change.after)) {
      model[field] = change.before;
    } else {
      changedSince++;
      return;
    }
    batch.push(model);
  });
  if (batch.length) await saveBatch(batch);
  const shownPath = currentModelPath();
  if (shownPath && batch.some((m) => m.filePath === shownPath)) await window.reloadShownModelDetails?.();
  if (changedSince) {
    await showMessage('Not all undone', `${modelCount(changedSince)} kept the ${FIELD_NAMES[field]} someone else gave them after your edit.`);
  }
}

/** Rate or favorite several models (a group card). */
export async function saveEngagement(filePaths: string[], field: 'rating' | 'favorite', value: number | boolean): Promise<boolean> {
  const batch = (await Promise.all(filePaths.map((p) => modelApi.get<ModelRecord>(p).catch(() => null)))).filter((m): m is ModelRecord => !!m);
  if (!batch.length) return false;
  batch.forEach((model) => { model[field] = value; });
  try {
    const ok = await callAction<boolean>('update-models-batch', batch);
    if (ok) for (const model of batch) await updateModel(model.filePath);
    return !!ok;
  } catch (error) {
    console.error('Error saving rating or favorite:', error);
    return false;
  }
}

/** Open a model's source URL in a new tab (http and https only). */
export async function openSourceUrl(url: string) {
  if (!url) return void showMessage('Error', 'Please enter a source URL');
  if (!/^https?:\/\//.test(url)) return void showMessage('Error', 'Please enter a valid URL starting with http:// or https://');
  try {
    await window.electron?.openExternal?.(url);
  } catch (error) {
    await showMessage('Error', `Failed to open URL: ${error instanceof Error ? error.message : String(error)}`);
  }
}
