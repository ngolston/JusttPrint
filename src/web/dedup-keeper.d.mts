export interface DedupFile {
  filePath: string;
}

/** Path of the file on disk, normalized for comparing. ZIP entries use archivePath::innerPath. */
export function normalizeDedupPath(filePath: string): string;

/** True when filePath is the directory or any nested file under it. */
export function fileIsUnderPreferredDirectory(filePath: string, preferredDir: string): boolean;

/** The copy to keep: one under preferredDir (shortest path), else a ZIP entry, else the first. */
export function pickDedupKeeperPath(files: DedupFile[], preferredDir: string): string;
