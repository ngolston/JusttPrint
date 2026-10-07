/** Checks the upload dialog makes before sending a file (the server checks again: src/server/uploads.js). */
import type { UploadInfo } from '../api';

export type FileCheck = { ok: true; warning?: string } | { ok: false; reason: string };

/** ".stl" for "Benchy.STL"; "" without an extension. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

export function checkFile(file: Pick<File, 'name' | 'size'>, info: Pick<UploadInfo, 'extensions' | 'maxBytes'> & Partial<Pick<UploadInfo, 'scanMaxBytes'>>): FileCheck {
  if (file.name.startsWith('.')) return { ok: false, reason: 'hidden files are not uploaded' };
  const ext = extensionOf(file.name);
  if (!info.extensions.includes(ext)) {
    return { ok: false, reason: ext ? `${ext} files are not scanned (Settings → File Types)` : 'no file extension' };
  }
  if (file.size > info.maxBytes) return { ok: false, reason: 'larger than the upload limit' };
  if (info.scanMaxBytes && file.size > info.scanMaxBytes) {
    const mb = Math.round(info.scanMaxBytes / 1024 / 1024);
    return { ok: true, warning: `Larger than the scan limit (${mb} MB): it is saved, but added to the library only after an admin raises the limit (Settings → General → Performance) and scans again.` };
  }
  return { ok: true };
}
