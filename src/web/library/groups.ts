/**
 * Group cards: a ZIP archive's models (bundle) or models sharing a parent model. Their images
 * (one per model, cached so recycled cards do not flash), their tags, the list view's shared
 * values, and expanding or collapsing them.
 */
import { callAction, settings } from '../api';
import { normalizePath, type GridModel, type GroupRecord } from '../grid/layout';
import { bundleSummary, type PrintModel } from '../print/printStatus';
import { fetchPrimaryThumbnail, saveThumbnailIfReal } from '../thumbnails/cache';
import { isFailurePlaceholder, isMostlyEmpty } from '../thumbnails/formats';
import { makeThumbnail } from '../thumbnails/pipeline';
import { directoryLabel, formatFileSize, parentDirectory } from './paths';
import { refreshGrid } from './models';

/** At most this many images in a group card's carousel. */
const MAX_IMAGES = 12;

type Child = GridModel & {
  thumbnail?: string;
  hasThumbnail?: number | boolean;
  size?: number;
  dateAdded?: string;
  modifiedDate?: string;
  designer?: string | null;
  id?: number | string | null;
};

const cache = new Map<string, string[]>();
let version = 0;
/** The image chosen for a group (groupThumbnailPreferences), shown first. */
let preferred: Record<string, string> | null = null;

/** Goes up when group images change, so group cards load them again. */
export const groupImagesVersion = () => version;

export function invalidateGroupImages(groupKey?: string | null) {
  if (groupKey) cache.delete(groupKey);
  else cache.clear();
  version++;
}

async function preferredImages() {
  if (preferred) return preferred;
  preferred = {};
  try {
    const raw = await settings.get<string | null>('groupThumbnailPreferences');
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') preferred = parsed;
  } catch (error) {
    console.error('Failed to load group thumbnail preferences:', error);
  }
  return preferred!;
}

const primaryOf = (field: string | null | undefined) =>
  String(field || '')
    .split('::')
    .find((t) => t && t !== '3d.png') || null;

async function usable(images: (string | null | undefined)[]): Promise<string[]> {
  const out: string[] = [];
  for (const image of images) {
    if (!image || image === '3d.png' || isFailurePlaceholder(image) || (await isMostlyEmpty(image))) continue;
    if (!out.includes(image)) out.push(image);
  }
  return out;
}

/** The images the children carry inline, the preferred one first. */
function inlineImages(record: GroupRecord, chosen: Record<string, string>): string[] {
  const images: string[] = [];
  for (const child of record.children as Child[]) {
    const primary = primaryOf(child.thumbnail);
    if (primary && !images.includes(primary)) images.push(primary);
    if (images.length >= MAX_IMAGES) break;
  }
  const first = chosen[record.groupKey];
  if (first && first !== '3d.png') {
    const index = images.indexOf(first);
    if (index !== 0) {
      if (index > 0) images.splice(index, 1);
      images.unshift(first);
      images.length = Math.min(images.length, MAX_IMAGES);
    }
  }
  return images;
}

async function childImage(child: Child): Promise<string | null> {
  const [inline] = await usable([primaryOf(child.thumbnail)]);
  if (inline) return inline;
  try {
    const stored = await fetchPrimaryThumbnail(child.filePath);
    if (stored) return stored;
    const full = await callAction<{ thumbnail?: string } | null>('get-model', child.filePath);
    return (await usable([primaryOf(full?.thumbnail)]))[0] || null;
  } catch {
    return null;
  }
}

/**
 * A group card's images, one per child. onImages is called as more arrive (cache, inline,
 * stored images, then a render of the first child). Returns a function that stops it.
 */
export function loadGroupImages(record: GroupRecord, onImages: (images: string[]) => void): () => void {
  let stopped = false;
  const stale = () => stopped;
  const show = async (images: string[]) => {
    const valid = await usable(images);
    if (!valid.length) return;
    cache.set(record.groupKey, valid.slice(0, MAX_IMAGES));
    if (!stale()) onImages(valid);
  };
  (async () => {
    // Paint what is known right away, so recycled cards do not flash the placeholder.
    const cached = cache.get(record.groupKey);
    const chosen = await preferredImages();
    const initial = cached?.length ? cached : inlineImages(record, chosen);
    if (initial.length && !stale()) onImages(initial);

    let images = await usable(initial);
    if (images.length) await show(images);
    if (images.length >= MAX_IMAGES || stale()) return;

    const children = (record.children as Child[]).filter((c) => c.filePath);
    const hasStored = (c: Child) => !!primaryOf(c.thumbnail) || (!!c.hasThumbnail && Number(c.hasThumbnail) !== 0);
    const ordered = [...children.filter(hasStored), ...children.filter((c) => !hasStored(c))];
    // The first few in parallel, then one at a time.
    const first = await Promise.all(ordered.slice(0, 6).map(childImage));
    if (stale()) return;
    images = await usable([...images, ...first]);
    if (images.length) await show(images);
    for (const child of ordered.slice(6)) {
      if (stale() || images.length >= MAX_IMAGES) return;
      const image = await childImage(child);
      if (image && !images.includes(image)) {
        images.push(image);
        await show(images);
      }
    }
    // No stored image anywhere: render the first model.
    if (!images.length && children.length && !stale()) {
      const { image, stored } = await makeThumbnail(children[0].filePath);
      if (stale() || !image) return;
      const [valid] = await usable([image]);
      if (!valid) return;
      await show([valid]);
      if (!stored) await saveThumbnailIfReal(children[0].filePath, valid);
    }
  })().catch(() => {
    /* the placeholder stays */
  });
  return () => {
    stopped = true;
  };
}

const tagNames = (tags: unknown): string[] =>
  [
    ...new Set((Array.isArray(tags) ? tags : []).map((t) => String(typeof t === 'string' ? t : (t as { name?: string })?.name || '').trim()).filter(Boolean))
  ].sort((a, b) => a.localeCompare(b));

/** Every tag any model of the group has. */
export async function groupTagNames(record: GroupRecord): Promise<string[]> {
  const ids = (record.children as Child[]).map((c) => Number(c.id)).filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length) {
    try {
      return tagNames(await callAction<unknown[]>('get-group-tags', ids));
    } catch (error) {
      console.error('Failed loading group tags:', error);
    }
  }
  const models = await Promise.all((record.children as Child[]).map((c) => callAction<{ tags?: unknown } | null>('get-model', c.filePath).catch(() => null)));
  return tagNames(models.flatMap((m) => (Array.isArray(m?.tags) ? (m!.tags as unknown[]) : [])));
}

/** Add or remove tags on every model of a group, and update their cards. */
export async function changeGroupTags(record: GroupRecord, { addTags = [], removeTags = [] }: { addTags?: string[]; removeTags?: string[] }): Promise<boolean> {
  const add = tagNames(addTags);
  const remove = new Set(tagNames(removeTags));
  if (!add.length && !remove.size) return false;
  const models = (
    await Promise.all(
      (record.children as Child[]).map((c) => callAction<(Record<string, unknown> & { filePath: string }) | null>('get-model', c.filePath).catch(() => null))
    )
  ).filter((m): m is Record<string, unknown> & { filePath: string } => !!m);
  if (!models.length) return false;
  for (const model of models) {
    model.tags = tagNames([...tagNames(model.tags), ...add]).filter((t) => !remove.has(t));
  }
  try {
    if (!(await callAction<boolean>('update-models-batch', models))) throw new Error('Bulk update returned false');
  } catch (error) {
    console.error('Error saving group tags, saving one at a time:', error);
    for (const model of models) await callAction('save-model', model).catch((e) => console.error('Error saving tags:', model.filePath, e));
  }
  const shown = document.querySelector<HTMLElement & { currentModels?: GridModel[] }>('.file-grid')?.currentModels;
  if (shown) {
    const byPath = new Map(models.map((m) => [normalizePath(m.filePath), m]));
    shown.forEach((existing, i) => {
      const updated = byPath.get(normalizePath(existing.filePath));
      if (updated) shown[i] = { ...existing, ...updated };
    });
  }
  refreshGrid();
  return true;
}

/** The list view's values for a group row: total size, newest date, and values every model shares. */
export function groupListColumns(record: GroupRecord) {
  const children = record.children as Child[];
  const shared = (get: (c: Child) => unknown) => {
    const values = [...new Set(children.map((c) => String(get(c) ?? '').trim()).filter(Boolean))];
    return values.length === 1 ? values[0] : values.length ? 'Multiple' : '';
  };
  let size = 0;
  let latest: number | null = null;
  for (const child of children) {
    if (Number(child.size) > 0) size += Number(child.size);
    const ms = new Date(child.dateAdded || child.modifiedDate || '').getTime();
    if (Number.isFinite(ms) && (latest == null || ms > latest)) latest = ms;
  }
  const first = children.find((c) => c.filePath)?.filePath || '';
  const archiveOrFile = first.split('::')[0];
  return {
    size: size > 0 ? formatFileSize(size) : '',
    dateAdded: latest != null ? new Date(latest).toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }) : '',
    dateAddedTitle: latest != null ? new Date(latest).toLocaleString() : '',
    directory: archiveOrFile ? directoryLabel(archiveOrFile) : '',
    directoryFull: archiveOrFile ? parentDirectory(archiveOrFile) || directoryLabel(archiveOrFile) : '',
    designer: shared((c) => c.designer),
    parentModel: record.groupKind === 'parentModel' ? record.groupLabel || '' : shared((c) => c.parentModel)
  };
}

/** "3/5 printed" and the like. */
export function groupPrintSummary(children: GridModel[]) {
  const summary = bundleSummary(children as PrintModel[]);
  return { printedCount: summary.printedCount, label: summary.label };
}
