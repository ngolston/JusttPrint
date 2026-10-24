/** Checks the upload dialog makes before sending a file (the server checks again: src/server/uploads.js). */
import type { UploadInfo } from '../api';

export type FileCheck = { ok: true; warning?: string } | { ok: false; reason: string };

/** ".stl" for "Benchy.STL"; "" without an extension. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * @param media Whether pictures, videos and documents may go along (into the model's folder):
 *   'yes', 'no' (each file is its own model), or undefined (model files only).
 */
export function checkFile(
  file: Pick<File, 'name' | 'size'>,
  info: Pick<UploadInfo, 'extensions' | 'maxBytes'> & Partial<Pick<UploadInfo, 'scanMaxBytes' | 'mediaExtensions'>>,
  media?: 'yes' | 'no'
): FileCheck {
  if (file.name.startsWith('.')) return { ok: false, reason: 'hidden files are not uploaded' };
  const ext = extensionOf(file.name);
  const isMedia = !!ext && Object.values(info.mediaExtensions || {}).some((list) => list.includes(ext));
  if (isMedia && media) {
    if (media === 'no') return { ok: false, reason: 'pictures, videos and documents need “One model”' };
    return file.size > info.maxBytes ? { ok: false, reason: 'larger than the upload limit' } : { ok: true };
  }
  if (!info.extensions.includes(ext)) {
    return { ok: false, reason: ext ? `${ext} files are not scanned (Settings → File Types)` : 'no file extension' };
  }
  if (file.size > info.maxBytes) return { ok: false, reason: 'larger than the upload limit' };
  // An archive is added as one model whatever its size (it is never opened).
  if (info.scanMaxBytes && file.size > info.scanMaxBytes && !['.zip', '.rar', '.7z'].includes(ext)) {
    const mb = Math.round(info.scanMaxBytes / 1024 / 1024);
    return {
      ok: true,
      warning: `Larger than the scan limit (${mb} MB): it is saved, but added to the library only after an admin raises the limit (Settings → Scanning → File Size) and scans again.`
    };
  }
  return { ok: true };
}
