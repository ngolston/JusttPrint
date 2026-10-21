/** Where the files of an upload go: model folders (src/server/model-folders.js). */
import type { MediaKind, UploadInfo } from '../api';
import { extensionOf } from './check';

/**
 * - one: every file in one new model folder (named in the dialog)
 * - each: each model file in a new folder of its own (pictures, videos and documents need `one`)
 * - add: into the chosen folder, which is a model folder already
 */
export type UploadMode = 'one' | 'each' | 'add';

export const MEDIA_LABELS: Record<MediaKind, string> = { image: 'picture', video: 'video', document: 'document', other: 'other file' };

/** The kind of media a file is, or null for a model file (or anything else). */
export function mediaKindOf(name: string, info: Pick<UploadInfo, 'mediaExtensions'> | null): MediaKind | null {
  const ext = extensionOf(name);
  const media = info?.mediaExtensions;
  if (!media || !ext) return null;
  return (Object.keys(media) as MediaKind[]).find((kind) => (media[kind] || []).includes(ext)) || null;
}

/** "Benchy" for "Benchy.stl". */
export function stem(name: string): string {
  const ext = extensionOf(name);
  return ext ? name.slice(0, name.length - ext.length) : name;
}

/** The name a new model folder gets first: the first model file's name, else the first file's. */
export function defaultModelName(names: string[], info: Pick<UploadInfo, 'mediaExtensions'> | null): string {
  const model = names.find((name) => !mediaKindOf(name, info));
  return stem(model || names[0] || '').trim();
}

/** A subfolder of a server folder, with the folder's own separator. */
export function joinFolder(folder: string, name: string): string {
  const sep = folder.includes('\\') && !folder.includes('/') ? '\\' : '/';
  return `${folder.replace(/[\\/]+$/, '')}${sep}${name}`;
}

/** The folder a file goes into inside its model folder: a picture into image/, and so on. */
export function targetFolder(modelFolder: string, name: string, info: Pick<UploadInfo, 'mediaExtensions'> | null): string {
  const kind = mediaKindOf(name, info);
  return kind ? joinFolder(modelFolder, kind) : modelFolder;
}

/**
 * A model page's Upload: where a file goes in the model's folder. A picture, video or document into
 * its subfolder, a model file (a type the library scans) beside the model's files, anything else
 * into other/.
 */
export function modelUploadTarget(
  modelFolder: string,
  name: string,
  info: Pick<UploadInfo, 'extensions' | 'mediaExtensions'> | null
): { folder: string; kind: MediaKind | 'model' } {
  const media = mediaKindOf(name, info);
  if (media) return { folder: joinFolder(modelFolder, media), kind: media };
  const ext = extensionOf(name);
  if (ext && (info?.extensions || []).includes(ext)) return { folder: modelFolder, kind: 'model' };
  return { folder: joinFolder(modelFolder, 'other'), kind: 'other' };
}

/** "Robot" for "/lib/Robot". */
export const lastSegment = (folder: string) =>
  folder
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || folder;
