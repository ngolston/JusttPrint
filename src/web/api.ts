/**
 * Calls to the server's HTTP API: POST /api/actions/<name> with { args } (src/server/api.js).
 * Each action the React screens use gets a typed function below.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The page's WebSocket id goes with each call, so the server can ask this page (in-page
 * dialogs, Puter AI) and send it progress events (src/server/api.js, CLIENT_HEADER).
 */
function clientHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const clientId = window.electron?.getClientId?.();
  if (clientId) headers['X-JusttPrint-Client'] = clientId;
  return headers;
}

export async function callAction<T>(name: string, ...args: unknown[]): Promise<T> {
  const response = await fetch(`/api/actions/${encodeURIComponent(name)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: clientHeaders(),
    body: JSON.stringify({ args })
  });
  if (response.status === 401) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  // Long calls start with keep-alive spaces; JSON.parse skips them.
  const text = await response.text();
  let data: { result?: T; error?: string };
  try {
    data = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`Unexpected response from the JusttPrint backend (HTTP ${response.status})`, response.status);
  }
  if (!response.ok || data.error !== undefined) {
    throw new ApiError(data.error || `HTTP ${response.status}`, response.status);
  }
  if (typeof window !== 'undefined' && changesData(name)) window.dispatchEvent(new Event(LIBRARY_CHANGED));
  return data.result as T;
}

/** Fired on window after an action that may have changed library data (the shell refreshes its counts). */
export const LIBRARY_CHANGED = 'jp:library-changed';

/**
 * True for actions that may change library data: everything except reads and checks, and the
 * frequent ones that only touch previews, thumbnails, menus or progress.
 */
export function changesData(name: string): boolean {
  if (/^(get|read|list|is|has|check|fetch|test|benchmark|open|download|preview|search|find|count|load|export|compute|resolve)[-A-Z]/.test(name)) return false;
  return !/thumbnail|^(parse|cancel|show|calculate|report|extract)-|^delete-temp-file$/.test(name);
}

export interface ServerAccessInfo {
  apiToken: string;
  passwordFromEnv: boolean;
  /** The admin account whose password JUSTTPRINT_PASSWORD sets, if any. */
  envUsername: string | null;
  minPasswordLength: number;
}

export const serverAccess = {
  info: () => callAction<ServerAccessInfo>('get-server-access-info'),
  /** Change the logged-in user's own password (logs them out everywhere). */
  setPassword: (currentPassword: string, newPassword: string) => callAction<unknown>('set-server-password', currentPassword, newPassword),
  regenerateToken: () => callAction<{ apiToken: string }>('regenerate-server-api-token')
};

export type UserRole = 'viewer' | 'editor' | 'admin';

export interface UserAccount {
  id: number;
  username: string;
  role: UserRole;
  createdAt: string | null;
  lastLoginAt: string | null;
  /** The JUSTTPRINT_PASSWORD account: stays an admin, password set by the variable. */
  fromEnv: boolean;
}

/** Settings → Users (admins). */
export const users = {
  list: () => callAction<{ users: UserAccount[]; minPasswordLength: number }>('list-users'),
  create: (details: { username: string; password: string; role: UserRole }) => callAction<UserAccount>('create-user', details),
  update: (id: number, changes: { role?: UserRole; password?: string }) => callAction<UserAccount>('update-user', id, changes),
  remove: (id: number) => callAction<unknown>('delete-user', id)
};

export interface UploadInfo {
  /** Lower-case extensions with the dot (".stl"). */
  extensions: string[];
  maxBytes: number;
  /** Size of the pieces to send (src/server/uploads.js). */
  chunkBytes: number;
  /** Scans skip larger files (Settings → General → Performance): they are uploaded but not added. */
  scanMaxBytes: number;
}

export interface UploadResult {
  fileName: string;
  filePath: string;
  size: number;
}

/** An upload in pieces on the server (src/server/upload-sessions.js). */
interface UploadSession {
  id: string;
  size: number;
  received: number;
  fileName: string;
  folder: string;
}

/** An upload error; `received` is where the server's copy stands, when it said. */
export class UploadError extends ApiError {
  constructor(
    message: string,
    status: number,
    readonly received?: number
  ) {
    super(message, status);
    this.name = 'UploadError';
  }
}

async function uploadRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (response.status === 401) window.location.href = '/login';
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; received?: number };
  if (!response.ok || data.error) throw new UploadError(data.error || `HTTP ${response.status}`, response.status, data.received);
  return data;
}

const sessionUrl = (id: string) => `/api/upload/sessions/${encodeURIComponent(id)}`;

/** Send one piece; progress in bytes of this piece. */
function sendPiece(id: string, offset: number, piece: Blob, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<{ received: number }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', `${sessionUrl(id)}?offset=${offset}`);
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onload = () => {
      let data: { error?: string; received?: number } = {};
      try {
        data = JSON.parse(request.responseText || '{}');
      } catch {
        /* not JSON (a proxy's error page) */
      }
      if (request.status === 401) window.location.href = '/login';
      if (request.status >= 200 && request.status < 300 && !data.error) resolve({ received: Number(data.received) });
      else reject(new UploadError(data.error || `HTTP ${request.status}`, request.status, data.received));
    };
    request.onerror = () => reject(new UploadError('The connection to the JusttPrint backend was lost', 0));
    request.onabort = () => reject(new UploadError('Cancelled', 0));
    const abort = () => request.abort();
    signal?.addEventListener('abort', abort, { once: true });
    request.onloadend = () => signal?.removeEventListener('abort', abort);
    request.send(piece);
  });
}

/** Pauses before each retry of a piece that failed (about 2 minutes in all). */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000];

/** Errors that sending again cannot fix (bad file, no permission, too large, disk full, upload gone). */
const isPermanent = (status: number) => [400, 403, 404, 413, 507].includes(status);

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new UploadError('Cancelled', 0));
      },
      { once: true }
    );
  });

export interface UploadOptions {
  chunkBytes: number;
  signal?: AbortSignal;
  /** The session of an earlier attempt at this file: continue it when the server still has it. */
  resumeId?: string | null;
  /** Called with the session id once the server has one (to resume after a reload). */
  onSession?: (id: string, received: number) => void;
  /** Fraction of the file the server has, as pieces go out. */
  onProgress?: (fraction: number) => void;
  /** A piece failed; retrying after `delayMs`. */
  onRetry?: (attempt: number, delayMs: number) => void;
}

/**
 * Upload a file into a library folder in pieces, retrying a piece that fails and continuing
 * where the server's copy stands. Resolves when the file has its name in the folder.
 */
export async function uploadFile(file: File, folder: string, options: UploadOptions): Promise<UploadResult> {
  const { chunkBytes, signal, resumeId, onSession, onProgress, onRetry } = options;
  let session: UploadSession | null = null;
  if (resumeId) {
    session = await uploadRequest<UploadSession>(sessionUrl(resumeId)).catch(() => null);
    if (session && (session.size !== file.size || session.folder !== folder || session.fileName !== file.name)) session = null;
  }
  if (!session) {
    session = await uploadRequest<UploadSession>('/api/upload/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, name: file.name, size: file.size })
    });
  }
  const { id } = session;
  let received = session.received;
  onSession?.(id, received);
  const piece = Math.max(256, chunkBytes || 16 * 1024 * 1024);
  let attempt = 0;
  while (received < file.size) {
    const end = Math.min(file.size, received + piece);
    const at = received;
    try {
      received = (await sendPiece(id, at, file.slice(at, end), (loaded) => onProgress?.((at + loaded) / Math.max(1, file.size)), signal)).received;
      attempt = 0;
      onProgress?.(received / Math.max(1, file.size));
    } catch (error) {
      if (signal?.aborted) throw error;
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 409 && error instanceof UploadError && error.received !== undefined) {
        received = error.received;
        continue;
      }
      if (isPermanent(status)) throw error;
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw new UploadError(
          `The connection was lost. Upload again to continue from ${Math.round((received / Math.max(1, file.size)) * 100)}%.`,
          status,
          received
        );
      }
      const delay = RETRY_DELAYS_MS[attempt++];
      onRetry?.(attempt, delay);
      await wait(delay, signal);
      // The piece may have arrived even though its answer did not.
      try {
        received = (await uploadRequest<UploadSession>(sessionUrl(id))).received;
      } catch (statusError) {
        if (statusError instanceof ApiError && statusError.status === 404) throw statusError;
      }
    }
  }
  return uploadRequest<UploadResult>(`${sessionUrl(id)}/finish`, { method: 'POST' });
}

/** Give up an upload: the server deletes what it has. */
export function cancelUpload(id: string): Promise<unknown> {
  return uploadRequest(sessionUrl(id), { method: 'DELETE' }).catch(() => null);
}

export const uploads = {
  info: () => callAction<UploadInfo>('get-upload-info'),
  /** Scan the folder after a batch so the new models show up. */
  finish: (folder: string, filePaths: string[]) => callAction<{ newModels: number; inLibrary: number }>('add-uploaded-files', folder, filePaths)
};

export interface PrintStatistics {
  /** 0 for all time. */
  months: number;
  from: string;
  to: string;
  firstPrintMonth: string | null;
  totals: { printed: number; failed: number; cancelled: number; successRate: number | null };
  byMonth: { month: string; printed: number; failed: number; cancelled: number; added: number }[];
  designers: { name: string; printed: number; models: number }[];
  models: { id: number; fileName: string; filePath: string; printed: number }[];
  printers: { id: number | null; name: string; printed: number; failed: number; successRate: number | null }[];
}

export const statistics = {
  get: (months: number) => callAction<PrintStatistics>('get-print-statistics', { months })
};

export interface Tag {
  id: number;
  name: string;
  model_count: number;
}

export const tags = {
  list: () => callAction<Tag[]>('get-all-tags'),
  create: (name: string) => callAction<{ id: number; name: string }>('save-tag', name),
  /** Renaming onto an existing name merges the two tags (`undo` says how to split them again). */
  rename: (id: number, newName: string) =>
    callAction<{ success: boolean; id: number; name: string; merged: boolean; undo?: TagRestore }>('rename-tag', id, newName),
  remove: (id: number) => callAction<{ success: boolean; name: string | null; modelIds: number[] }>('delete-tag', id),
  /** Undo of a delete or merge: the tag comes back on its models. */
  restore: (request: TagRestore) => callAction<{ id: number; name: string; linked: number }>('restore-tag', request)
};

/** What restore-tag puts back: the tag `name` on `modelIds`; after a merge, also splits it from `intoId`. */
export interface TagRestore {
  name: string;
  modelIds: number[];
  intoId?: number;
  intoName?: string;
  addedModelIds?: number[];
}

export interface Part {
  id: number;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  notes: string;
  low_stock: number;
}

export interface PartInput {
  id?: number;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  notes: string;
  lowStock: number;
}

export const parts = {
  list: () => callAction<Part[]>('get-all-parts'),
  /** Creates the part, or updates it when `id` is set. */
  save: (part: PartInput) => callAction<Part>('save-part', part),
  remove: (id: number) => callAction<unknown>('delete-part', id)
};

export const settings = {
  get: <T = string | null>(key: string) => callAction<T>('get-setting', key),
  save: (key: string, value: unknown) => callAction<unknown>('save-setting', key, value)
};

export const folders = {
  /** The scanned folders as a tree (src/core/folder-tree-lib.js buildFolderForest). */
  tree: () => callAction<import('./folders/tree').FolderForest>('get-folder-tree')
};

export interface Printer {
  id: number;
  nickname: string;
  manufacturer: string | null;
  model: string | null;
  printer_type: string | null;
  firmware_type: string | null;
  is_klipper: number;
  web_url: string | null;
  notes: string | null;
  total_prints?: number;
  last_printed_at?: string | null;
  due_reminders_count?: number;
  created_at?: string;
}

export interface PrinterInput {
  id: number | null;
  nickname: string;
  manufacturer: string | null;
  model: string | null;
  printerType: string | null;
  firmwareType: string | null;
  isKlipper: boolean;
  webUrl: string | null;
  notes: string | null;
}

export interface PrinterReminder {
  id: number;
  printer_id: number;
  title: string;
  maintenance_type: string | null;
  due_date: string;
  interval_days: number;
  notes: string | null;
  status: 'pending' | 'completed' | string;
}

export interface MaintenanceLog {
  id: number;
  printer_id: number;
  maintenance_type: string;
  title: string | null;
  description: string | null;
  performed_at: string;
}

export const printers = {
  list: () => callAction<Printer[]>('get-all-printers'),
  save: (printer: PrinterInput) => callAction<Printer>('save-printer', printer),
  remove: (id: number) => callAction<unknown>('delete-printer', id),
  reminders: (printerId: number) => callAction<PrinterReminder[]>('get-printer-reminders', printerId),
  saveReminder: (reminder: { printerId: number; title: string; maintenanceType: string; dueDate: string; intervalDays: number; notes: string | null }) =>
    callAction<PrinterReminder>('save-printer-reminder', reminder),
  completeReminder: (id: number, notes: string) => callAction<unknown>('complete-printer-reminder', { id, notes }),
  removeReminder: (id: number) => callAction<unknown>('delete-printer-reminder', id),
  logs: (printerId: number) => callAction<MaintenanceLog[]>('get-printer-maintenance-logs', printerId),
  saveLog: (entry: { printerId: number; maintenanceType: string; title: string; performedAt: string; description: string | null }) =>
    callAction<MaintenanceLog>('save-printer-maintenance-log', entry),
  removeLog: (id: number) => callAction<unknown>('delete-printer-maintenance-log', id)
};

export interface LibraryStats {
  totalModels: number;
  totalBytes: number;
  fileTypes: { stl: number; threeMf: number; other: number; stlBytes: number; threeMfBytes: number; otherBytes: number };
  archivedModels: number;
  /** Percent of models with each field set, as strings with one decimal ("12.5"), or 0 for an empty library. */
  percentages: { withDesigner: string | number; withParentModel: string | number; withLicense: string | number; withTags: string | number };
  tags: { total: number; mostUsed: { name: string; count: number } | null };
}

/** Sidebar Library Storage (src/core/library-storage.js). `volume` is null without a readable STL Home. */
export interface LibraryStorage {
  libraryBytes: number;
  modelCount: number;
  volume: { path: string; totalBytes: number; usedBytes: number; freeBytes: number } | null;
}

/** Queue badge and dashboard figures (src/core/library-counts.js). */
export interface LibraryCounts {
  models: number;
  printed: number;
  queued: number;
  printing: number;
  printers: number;
}

export const library = {
  stats: () => callAction<LibraryStats>('get-stats'),
  storage: () => callAction<LibraryStorage>('get-library-storage'),
  counts: () => callAction<LibraryCounts>('get-library-counts'),
  activity: (limit?: number) => callAction<ActivityItem[]>('get-recent-activity', ...(limit == null ? [] : [limit])),
  /** Logged prints, newest first; only one outcome when given. */
  recentPrints: (limit: number, outcome?: string | null, printerId?: number) =>
    callAction<PrintActivity[]>('get-recent-prints', limit, ...(printerId != null ? [outcome || '', printerId] : outcome ? [outcome] : []))
};

/** Dashboard Recent Activity (src/core/recent-activity.js), newest first. */
export interface PrintActivity {
  kind: 'print';
  id: number;
  at: string;
  outcome: string;
  quantity: number;
  filePath: string;
  fileName: string | null;
  printer: string | null;
}
export type ActivityItem = PrintActivity | { kind: 'added'; at: string; day: string; count: number };

export interface ServerGpuInfo {
  available: boolean;
  serverMode?: boolean;
  glBackend?: string;
  activeRenderer?: string | null;
  /** The WebGL of the server's thumbnail renderer (headless Chromium); null when it is not running. */
  workerWebgl?: {
    vendor: string | null;
    renderer: string | null;
    version: string | null;
    shadingLanguage: string | null;
    maxTextureSize: number | null;
    webgl2: boolean;
  } | null;
  usingSwiftShader?: boolean;
  nvidia?: {
    available: boolean;
    message?: string;
    gpus?: { index: string; name: string; driverVersion: string; memoryTotalMiB: string; memoryUsedMiB: string; utilizationPercent: string }[];
  } | null;
  nvidiaVisibleDevices?: string | null;
  nvidiaDriverCapabilities?: string | null;
  warnings?: string[];
  error?: string | null;
}

export type FilesystemBenchmark =
  | { success: true; iterations: number; write: { time: number; speedMBps: string }; read: { time: number; speedMBps: string } }
  | { success: false; error: string };

export type DatabaseBenchmark =
  | { success: true; write: { time: number; operations: number; opsPerSec: string }; read: { time: number; operations: number; opsPerSec: string } }
  | { success: false; error: string };

export const systemReport = {
  gpu: () => callAction<ServerGpuInfo>('get-gpu-info'),
  benchmarkFilesystem: () => callAction<FilesystemBenchmark>('benchmark-filesystem'),
  benchmarkDatabase: () => callAction<DatabaseBenchmark>('benchmark-database')
};

export type FileResult = { success: true; filePath: string } | { success: false; message?: string };

export const backup = {
  /** Writes a backup file in the data folder; download it from /api/download/<path>. */
  create: () => callAction<FileResult>('backup-database'),
  /** Replaces the library database with an uploaded backup (.db, base64). */
  restore: (base64: string) => callAction<{ success: boolean; message?: string }>('restore-database', { base64 }),
  exportLibrary: () => callAction<FileResult>('export-library'),
  /** Merges a library export (JSON text) into the library. */
  importLibrary: (json: string) => callAction<{ success: boolean; imported?: number; updated?: number; message?: string }>('import-library', { json })
};

/** Automatic backups (src/server/auto-backup.js), as Settings → Backup shows them. */
export interface AutoBackupStatus {
  enabled: boolean;
  intervalHours: number;
  keep: number;
  /** Where backups go: the chosen folder, or the default on the data volume. */
  directory: string;
  /** The chosen folder; '' means the default. */
  customDirectory: string;
  defaultDirectory: string;
  lastRun: string;
  lastAttempt: string;
  lastError: string;
  /** Settings the container's environment variables set (they win at every start). */
  setByEnvironment: string[];
  running: boolean;
  nextRun: string | null;
  backups: { name: string; path: string; size: number; date: string }[];
  folderProblem: string;
}

export interface AutoBackupSettings {
  enabled?: boolean;
  intervalHours?: number;
  keep?: number;
  directory?: string;
}

/** Backups and exports earlier versions left in the data folder (src/server/download-files.js). */
export interface LeftoverDownloads {
  folder: string;
  files: { name: string; size: number; date: string }[];
  totalBytes: number;
}

export const leftoverDownloads = {
  list: () => callAction<LeftoverDownloads>('get-leftover-downloads'),
  remove: () => callAction<{ count: number; bytes: number }>('delete-leftover-downloads')
};

export const autoBackup = {
  status: () => callAction<AutoBackupStatus>('get-auto-backup'),
  save: (settings: AutoBackupSettings) => callAction<AutoBackupStatus>('save-auto-backup', settings),
  runNow: () => callAction<{ success: boolean; message?: string; status: AutoBackupStatus }>('run-auto-backup'),
  /** Replaces the library database with an automatic backup, by file name. */
  restore: (name: string) => callAction<{ success: boolean; message?: string }>('restore-auto-backup', name)
};

export function downloadUrl(filePath: string): string {
  return `/api/download/${encodeURIComponent(filePath)}`;
}

export interface McpConnectionInfo {
  running: boolean;
  port: number;
  url: string;
  /** Other addresses the endpoint answers on (LAN addresses, 127.0.0.1, a <server-host> placeholder). */
  urls: string[];
  /** { mcpServers: { justtprint: { url, headers: { Authorization } } } } with the server's API token. */
  clientConfig: { mcpServers: Record<string, { url: string; headers?: Record<string, string> }> };
  tools: string[];
}

export const mcp = {
  connectionInfo: () => callAction<McpConnectionInfo>('get-mcp-connection-info')
};

export interface FileTypeEntry {
  id: string;
  label: string;
}

export const fileTypes = {
  /** The optional file types a scan can also pick up (OBJ, STEP, ...). */
  catalog: () => callAction<FileTypeEntry[]>('get-additional-file-types-catalog'),
  countModels: (ids: string[]) => callAction<number>('get-model-count-by-file-type-ids', ids),
  removeModels: (ids: string[]) => callAction<unknown>('remove-models-by-file-type-ids', ids)
};

export type TlsMode = 'off' | 'custom' | 'letsencrypt' | 'selfsigned';

export interface TlsSettings {
  tlsCertPath: string;
  tlsKeyPath: string;
  tlsCaPath: string;
  tlsDomain: string;
  tlsEmail: string;
  tlsAgreeTos: boolean;
  tlsUseStaging: boolean;
  tlsRedirectHttp: boolean;
  serverHttpPort: string;
}

export interface TlsStatus {
  envOverride: boolean;
  portEnvOverride?: boolean;
  tlsMode: TlsMode;
  scheme: 'http' | 'https';
  source: string;
  cert: { expiresAt?: string; daysRemaining?: number } | null;
  missingFiles: boolean;
  lastError: string | null;
  appPort: number;
  settings: TlsSettings;
}

export interface TlsResult {
  success: boolean;
  message?: string;
  status?: TlsStatus;
}

export const tls = {
  status: () => callAction<TlsStatus>('get-tls-status'),
  /** Saves the settings and restarts the listener; with issueNow, also requests a Let's Encrypt certificate. */
  apply: (payload: TlsSettings & { tlsMode: TlsMode; issueNow?: boolean }) => callAction<TlsResult>('apply-tls-settings', payload),
  generateSelfSigned: (payload: { hostname: string; tlsDomain: string; tlsRedirectHttp: boolean; serverHttpPort: string }) =>
    callAction<TlsResult>('generate-self-signed-cert', payload)
};

export const ai = {
  /** Asks the model to tag a test image; Puter.com runs in this page (puter-ai-chat-request). */
  test: (apiKey: string, endpoint: string, model: string, service: string) =>
    callAction<{ success: boolean; tags?: string[]; error?: string }>('test-ai-config', apiKey, endpoint, model, service),
  defaultPrompt: () => callAction<string>('get-default-ai-prompt')
};

export const purge = {
  /** Removes every model from the library database (files on disk are untouched). */
  allModels: () => callAction<boolean>('purge-models', { confirmedInDialog: true })
};

export interface Slicer {
  id?: number;
  name: string;
  path: string;
}

export const slicers = {
  list: () => callAction<Slicer[]>('get-slicers'),
  /** Replaces the whole slicer list. */
  replaceAll: (list: Slicer[]) => callAction<unknown>('clear-and-save-slicers', list)
};

export type MetadataType = 'designer' | 'parentModel' | 'license';

export interface MetadataEntry {
  type: MetadataType;
  name: string;
  model_count: number;
}

/** A notification for the bell (src/server/notifications.js). */
export interface AppNotification {
  id: number;
  createdAt: string;
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string | null;
  /** A page to open, e.g. '#/printers/3'. */
  link: string | null;
  unread: boolean;
}

export const notifications = {
  /** The newest the caller may see, and how many are unread. */
  list: () => callAction<{ items: AppNotification[]; unread: number }>('get-notifications', { limit: 50 }),
  /** Everything up to `id` is read (for this account, in every browser). */
  markRead: (id: number) => callAction<{ success: boolean }>('mark-notifications-read', id)
};

export const metadata = {
  /** Every designer, parent model and license in use, with how many models use it. */
  list: () => callAction<MetadataEntry[]>('get-all-metadata'),
  /** Renaming onto an existing name merges the two. */
  rename: (type: MetadataType, oldName: string, newName: string) =>
    callAction<{ merged?: boolean; updated?: number; modelIds?: number[] }>('rename-metadata', type, oldName, newName),
  /** Clears the value on every model that has it. */
  remove: (type: MetadataType, name: string) => callAction<{ updated?: number; modelIds?: number[] }>('delete-metadata', type, name),
  /** Undo: `name` again on `modelIds`, for those still at `current` (empty after a delete). */
  restore: (request: { type: MetadataType; name: string; current: string; modelIds: number[] }) =>
    callAction<{ restored?: number }>('restore-metadata', request)
};

export interface OrganizeJob {
  sourceDir: string;
  destDir: string;
  includeZips: boolean;
  /** Folder levels under the destination, e.g. ['designer', 'parentModel']. */
  layers: string[];
}

export interface OrganizePreview {
  ok: boolean;
  error?: string;
  spaceError?: string;
  enoughSpace?: boolean;
  destWillBeCreated?: boolean;
  copyCount?: number;
  copyBytes?: number;
  resumeCount?: number;
  zipCount?: number;
  zipEntryCount?: number;
  noParentCount?: number;
  emptyLayers?: { label?: string; folder: string; count: number }[];
  freeBytes?: number | null;
  marginBytes?: number;
  sample?: { from: string; to: string; zipEntryCount?: number }[];
  skippedCount?: number;
  reasonCounts?: Record<string, number>;
}

export interface OrganizeResult {
  ok: boolean;
  error?: string;
  moved?: number;
  skipped?: number;
  failedCount?: number;
  failed?: { from?: string; error: string }[];
  warningCount?: number;
  zipModels?: number;
}

export const organize = {
  /** Scanned folders the organizer may move models out of. */
  sources: () => callAction<{ path: string }[]>('list-organize-sources'),
  preview: (job: OrganizeJob) => callAction<OrganizePreview>('organize-library-preview', job),
  run: (job: OrganizeJob) => callAction<OrganizeResult>('organize-library-run', job)
};

export interface DuplicateFile {
  filePath: string;
  size?: number;
}

export interface DuplicateGroup {
  hash: string;
  files: DuplicateFile[];
}

export interface HashProgress {
  processed: number;
  total: number;
  success?: number;
  failed?: number;
}

export const dedup = {
  /** Groups of identical files (by hash); older servers sent { hash: files }. */
  groups: async (options: { includeZip: boolean; filters?: Record<string, unknown> }): Promise<DuplicateGroup[]> => {
    const raw = await callAction<DuplicateGroup[] | Record<string, DuplicateFile[]>>('get-duplicates', options);
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : Object.entries(raw).map(([hash, files]) => ({ hash, files }));
    return list.filter((group) => group && Array.isArray(group.files) && group.files.length > 1);
  },
  modelsWithoutHash: (filters: Record<string, unknown> | null) => callAction<number>('getModelsWithoutHash', filters),
  isGeneratingHashes: () => callAction<boolean>('is-generating-hashes'),
  /** Starts hash generation in the background; progress comes as hash-generation-progress events. */
  generateHashes: (filters: Record<string, unknown> | null) =>
    callAction<{ started?: boolean; alreadyRunning?: boolean; total?: number; failed?: number }>('generateMissingHashes', filters),
  thumbnail: (filePath: string) => callAction<string | null>('getThumbnail', filePath),
  /** Deletes the file from disk (permanently) and removes it from the library. */
  deleteFile: (filePath: string) => callAction<boolean>('delete-file', filePath),
  /** Same geometry, different files (src/server/geometry-job.js). */
  geometryGroups: (filters: Record<string, unknown> | null, includeZip = false) =>
    callAction<{ groups: DuplicateGroup[]; missing: number; running: boolean; processed: number; total: number }>('get-geometry-duplicates', {
      ...(filters ? { filters } : {}),
      includeZip
    }),
  /** Starts fingerprinting in the background; progress comes as geometry-progress events. */
  startGeometry: (filters: Record<string, unknown> | null) =>
    callAction<{ started?: boolean; alreadyRunning?: boolean; total: number }>('start-geometry-scan', filters ? { filters } : null)
};

/** Values in use across the library, for the details panel's pickers. */
export const libraryValues = {
  designers: () => callAction<string[]>('get-designers'),
  parentModels: () => callAction<string[]>('get-parent-models'),
  licenses: () => callAction<string[]>('get-licenses')
};

export interface PrintEvent {
  id: number;
  model_id: number;
  printed_at: string;
  outcome: string;
  quantity: number;
  notes: string | null;
  printer_nickname?: string | null;
  printer_name?: string | null;
  printer_model?: string | null;
  printer_type?: string | null;
  parts?: { id: number; name?: string | null; quantity: number }[];
}

export interface LogPrintInput {
  printedAt: string;
  outcome: string;
  quantity: number;
  notes: string;
  printerId: number | null;
  parts: { id: number; quantity: number }[];
}

export const prints = {
  events: (modelId: number) => callAction<PrintEvent[]>('get-print-events', modelId),
  log: (filePath: string, input: LogPrintInput) => callAction<unknown>('log-print-event', { ...input, filePath }),
  logMany: (filePaths: string[], input: LogPrintInput) => callAction<unknown>('log-print-events-batch', { ...input, filePaths }),
  removeEvent: (id: number) => callAction<unknown>('delete-print-event', id),
  setStatus: (filePaths: string[], printStatus: string) =>
    filePaths.length === 1
      ? callAction<unknown>('set-print-status', { filePath: filePaths[0], printStatus })
      : callAction<unknown>('set-print-status-batch', { filePaths, printStatus })
};

/** The full model record (fields vary; only the ones the screens read are typed where used). */
export const models = {
  get: <T = Record<string, unknown>>(filePath: string) => callAction<T | null>('get-model', filePath)
};

/** A model's stored images (data URLs); the first is the one the grid shows. */
export const thumbnails = {
  list: (filePath: string) => callAction<string[]>('get-all-thumbnails', filePath),
  setDefault: (filePath: string, index: number) => callAction<unknown>('set-default-thumbnail', filePath, index),
  remove: (filePath: string, index: number) => callAction<unknown>('delete-thumbnail', filePath, index)
};

export interface CollectionSummary {
  id: number;
  name: string;
  description: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  modelCount: number;
  /** The most recently added model, for the cover. */
  coverPath: string | null;
}

export interface CollectionModel {
  id: number;
  filePath: string;
  fileName: string;
  designer: string | null;
  license: string | null;
  print_status: string | null;
  print_count: number | null;
  printed: number | null;
  bundleKey?: string | null;
  bundleLabel?: string | null;
  bundleKind?: string | null;
  added_at: string;
}

export interface CollectionDetail extends CollectionSummary {
  models: CollectionModel[];
}

/** Collections (src/core/collections.js). Everyone reads; editors change. */
export const collections = {
  list: () => callAction<CollectionSummary[]>('get-collections'),
  get: (id: number) => callAction<CollectionDetail>('get-collection', id),
  /** For each collection, how many of these models are already in it. */
  membership: (filePaths: string[]) =>
    callAction<{ models: number; collections: (CollectionSummary & { selectedInIt: number })[] }>('get-collection-membership', filePaths),
  create: (name: string, description = '') => callAction<CollectionSummary>('create-collection', { name, description }),
  update: (id: number, changes: { name?: string; description?: string }) => callAction<CollectionSummary>('update-collection', id, changes),
  remove: (id: number) => callAction<unknown>('delete-collection', id),
  add: (id: number, filePaths: string[]) => callAction<{ added: number; name: string }>('add-to-collection', id, filePaths),
  take: (id: number, filePaths: string[]) => callAction<{ removed: number; name: string }>('remove-from-collection', id, filePaths)
};

export type ShareKind = 'model' | 'collection';

export interface ShareLink {
  token: string;
  kind: ShareKind;
  targetId: number;
  targetName: string | null;
  allowDownload: boolean;
  /** A 3D view on the page: always with downloads, optional on view-only links. */
  allowPreview: boolean;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  expired: boolean;
  views: number;
  lastViewedAt: string | null;
}

export interface ShareTarget {
  kind: ShareKind;
  /** A collection's id (or a model's). */
  targetId?: number;
  /** A model's file path. */
  filePath?: string;
}

/** Read-only share links (src/core/share-links.js); the page is /s/<token>. */
export const shareLinks = {
  create: (target: ShareTarget, options: { allowDownload: boolean; allowPreview?: boolean; expiresInDays: number }) =>
    callAction<ShareLink>('create-share-link', { ...target, ...options }),
  list: (target?: ShareTarget) => callAction<ShareLink[]>('get-share-links', target ?? null),
  revoke: (token: string) => callAction<unknown>('revoke-share-link', token),
  url: (token: string) => `${window.location.origin}/s/${token}`
};
