/** A model folder's pictures, videos and documents (src/server/model-folders.js). */
import { callAction, type MediaKind } from '../api';

export interface MediaFile {
  name: string;
  path: string;
  size: number;
  modified: string | null;
}

export interface ModelMedia {
  folder: string | null;
  isModelFolder: boolean;
  /** The picture that is the cover (its name in image/), or null. */
  cover: string | null;
  image: MediaFile[];
  video: MediaFile[];
  document: MediaFile[];
  /** Any other file kept with the model (other/): only downloaded. */
  other: MediaFile[];
  youtube: { id: string; title: string | null }[];
}

export const EMPTY_MEDIA: ModelMedia = { folder: null, isModelFolder: false, cover: null, image: [], video: [], document: [], other: [], youtube: [] };

export const media = {
  get: (folder: string) => callAction<ModelMedia>('get-model-media', folder),
  register: (folder: string) => callAction<ModelMedia>('register-model-folder', folder),
  setCover: (folder: string, name: string | null) => callAction<ModelMedia>('set-model-cover', folder, name),
  remove: (folder: string, kind: MediaKind, name: string) => callAction<ModelMedia>('remove-model-media', folder, kind, name),
  addYoutube: (folder: string, links: string[]) => callAction<ModelMedia>('add-model-youtube', folder, links),
  removeYoutube: (folder: string, id: string) => callAction<ModelMedia>('remove-model-youtube', folder, id)
};

/** A media file's address for viewing (or, with `download`, for saving). */
export const mediaUrl = (filePath: string, download = false) => `/api/media/${encodeURIComponent(filePath)}${download ? '?download=1' : ''}`;

export const extOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
};

/** Pictures browsers do not show by themselves (decoded with UTIF). */
export const isTiff = (name: string) => ['.tif', '.tiff'].includes(extOf(name));

/** Videos browsers play (MPEG-1 and MPEG-2 they do not). */
export const isPlayable = (name: string) => ['.mp4', '.m4v', '.webm'].includes(extOf(name));

/** How a document is shown: the browser's PDF viewer, a sandboxed page, rendered text, Word, or nothing (.doc). */
export type DocumentView = 'pdf' | 'html' | 'markdown' | 'text' | 'docx' | 'none';

export function documentView(name: string): DocumentView {
  switch (extOf(name)) {
    case '.pdf':
      return 'pdf';
    case '.html':
      return 'html';
    case '.md':
      return 'markdown';
    case '.txt':
    case '.text':
      return 'text';
    case '.docx':
      return 'docx';
    default:
      return 'none';
  }
}

/** The YouTube player, without YouTube's cookies until it plays. */
export const youtubeEmbed = (id: string) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`;
export const youtubeThumb = (id: string) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;

/** The folder a model file is in. */
export function folderOf(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return cut > 0 ? filePath.slice(0, cut) : filePath;
}

/** "3 pictures and documents from the model's page" (after a site download). */
export const mediaLine = (count: number) => `${count} ${count === 1 ? 'picture or document' : 'pictures and documents'} from the model's page`;
