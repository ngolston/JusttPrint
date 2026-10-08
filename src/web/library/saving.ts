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

type ModelRecord = GridModel & Record<string, unknown>;

/** Save one field of one model, then update its card (and the details panel's print status). */
export async function saveModelField(field: string, value: unknown, filePath: string): Promise<boolean> {
  try {
    const model = await modelApi.get<ModelRecord>(filePath);
    if (!model) return false;
    model[field] = value;
    await callAction('save-model', model);
    await updateModel(filePath);
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

const tagList = (list: unknown): string[] => (Array.isArray(list) ? list : [])
  .map((t) => String(typeof t === 'string' ? t : (t as { name?: string })?.name || '')).filter(Boolean);

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
    for (const model of loaded) {
      if (field === 'tags') {
        const next = tagList(value);
        model.tags = (options.replace ? next : [...new Set([...tagList(model.tags), ...next])]).sort();
      } else {
        model[field] = field === 'designer' && !value ? 'Unknown' : value;
      }
    }
    if (loaded.length) await saveBatch(loaded);
    return true;
  } catch (error) {
    console.error(`Error saving ${field} on the selected models:`, error);
    return false;
  }
}

/** Remove one tag from every selected model, keeping their others. */
export async function removeFromSelected(field: 'tags', value: string) {
  const batch: ModelRecord[] = [];
  for (const filePath of selection.values()) {
    const model = await modelApi.get<ModelRecord>(filePath).catch(() => null);
    if (!model) continue;
    const tags = tagList(model.tags);
    if (!tags.includes(String(value))) continue;
    model.tags = tags.filter((t) => t !== value);
    batch.push(model);
  }
  if (batch.length) await saveBatch(batch);
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
