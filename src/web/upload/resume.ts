/**
 * Unfinished uploads this browser can continue: the server's session id for each file (by folder,
 * name, size and date), kept in localStorage so an upload resumes after a reload or a lost
 * connection. The server deletes sessions left for a day, so old entries are dropped too.
 */
const KEY = 'justtprint.uploadSessions';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface Saved { id: string; at: number }

type FileLike = Pick<File, 'name' | 'size' | 'lastModified'>;

export const resumeKey = (folder: string, file: FileLike) => `${folder}\n${file.name}\n${file.size}\n${file.lastModified}`;

function read(now: number): Record<string, Saved> {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Saved>;
    return Object.fromEntries(Object.entries(all).filter(([, saved]) => saved && typeof saved.id === 'string' && now - saved.at < MAX_AGE_MS));
  } catch {
    return {};
  }
}

function write(all: Record<string, Saved>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* private window: no resuming after a reload */ }
}

export function savedSession(folder: string, file: FileLike, now = Date.now()): string | null {
  return read(now)[resumeKey(folder, file)]?.id ?? null;
}

export function saveSession(folder: string, file: FileLike, id: string, now = Date.now()) {
  write({ ...read(now), [resumeKey(folder, file)]: { id, at: now } });
}

export function forgetSession(folder: string, file: FileLike, now = Date.now()) {
  const all = read(now);
  delete all[resumeKey(folder, file)];
  write(all);
}
