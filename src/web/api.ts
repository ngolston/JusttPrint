/**
 * Calls to the server's HTTP API: POST /api/actions/<name> with { args } (src/server/api.js).
 * Each action the React screens use gets a typed function below.
 */

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
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
    throw new ApiError(`Unexpected response from the server (HTTP ${response.status})`, response.status);
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
  setPassword: (currentPassword: string, newPassword: string) =>
    callAction<unknown>('set-server-password', currentPassword, newPassword),
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
}

export interface UploadResult {
  fileName: string;
  filePath: string;
  size: number;
}

/**
 * Upload one file into a library folder (POST /api/upload, src/server/uploads.js), reporting
 * progress as a fraction. XMLHttpRequest, because fetch cannot report upload progress.
 */
export function uploadFile(file: File, folder: string, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api/upload?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`);
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    request.onload = () => {
      let data: { error?: string } & Partial<UploadResult> = {};
      try { data = JSON.parse(request.responseText || '{}'); } catch { /* not JSON */ }
      if (request.status === 401) window.location.href = '/login';
      if (request.status >= 200 && request.status < 300 && !data.error) resolve(data as UploadResult);
      else reject(new ApiError(data.error || `HTTP ${request.status}`, request.status));
    };
    request.onerror = () => reject(new ApiError('The connection to the server was lost', 0));
    request.onabort = () => reject(new ApiError('Cancelled', 0));
    signal?.addEventListener('abort', () => request.abort(), { once: true });
    request.send(file);
  });
}

export const uploads = {
  info: () => callAction<UploadInfo>('get-upload-info'),
  /** Scan the folder after a batch so the new models show up. */
  finish: (folder: string) => callAction<{ newModels: number }>('add-uploaded-files', folder)
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
  filaments: { id: number; name: string; vendor: string; material: string; colorHex: string; prints: number }[];
  materials: { material: string; prints: number }[];
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
  /** Renaming onto an existing name merges the two tags. */
  rename: (id: number, newName: string) =>
    callAction<{ success: boolean; id: number; name: string; merged: boolean }>('rename-tag', id, newName),
  remove: (id: number) => callAction<boolean>('delete-tag', id)
};

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

export interface Filament {
  id: number;
  name: string;
  vendor: string | null;
  material: string | null;
  color_hex: string | null;
  diameter: number | null;
  model_count: number;
  /** Logged prints with this filament, and when the last one was (null when never). */
  print_count?: number;
  last_used_at?: string | null;
}

export interface FilamentInput {
  name: string;
  vendor: string;
  material: string;
  color_hex: string;
  diameter: number;
}

export const filaments = {
  list: () => callAction<Filament[]>('get-all-filaments'),
  save: (filament: FilamentInput) => callAction<Filament>('save-filament', filament),
  remove: (id: number) => callAction<unknown>('delete-filament', id)
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
export interface PrintActivity { kind: 'print'; id: number; at: string; outcome: string; quantity: number; filePath: string; fileName: string | null; printer: string | null; filaments: string[] }
export type ActivityItem = PrintActivity | { kind: 'added'; at: string; day: string; count: number };

export interface ServerGpuInfo {
  available: boolean;
  serverMode?: boolean;
  glBackend?: string;
  activeRenderer?: string | null;
  usingSwiftShader?: boolean;
  nvidia?: { available: boolean; message?: string; gpus?: { index: string; name: string; driverVersion: string; memoryTotalMiB: string; memoryUsedMiB: string; utilizationPercent: string }[] } | null;
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
  importLibrary: (json: string) =>
    callAction<{ success: boolean; imported?: number; updated?: number; message?: string }>('import-library', { json })
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

export const metadata = {
  /** Every designer, parent model and license in use, with how many models use it. */
  list: () => callAction<MetadataEntry[]>('get-all-metadata'),
  /** Renaming onto an existing name merges the two. */
  rename: (type: MetadataType, oldName: string, newName: string) =>
    callAction<{ merged?: boolean; updated?: number }>('rename-metadata', type, oldName, newName),
  /** Clears the value on every model that has it. */
  remove: (type: MetadataType, name: string) => callAction<unknown>('delete-metadata', type, name)
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
  deleteFile: (filePath: string) => callAction<boolean>('delete-file', filePath)
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
  filaments?: { id: number; vendor?: string | null; name?: string | null; material?: string | null; color_hex?: string | null }[];
  parts?: { id: number; name?: string | null; quantity: number }[];
}

export interface LogPrintInput {
  printedAt: string;
  outcome: string;
  quantity: number;
  notes: string;
  printerId: number | null;
  filamentIds: number[];
  parts: { id: number; quantity: number }[];
}

export const prints = {
  events: (modelId: number) => callAction<PrintEvent[]>('get-print-events', modelId),
  log: (filePath: string, input: LogPrintInput) => callAction<unknown>('log-print-event', { ...input, filePath }),
  logMany: (filePaths: string[], input: LogPrintInput) => callAction<unknown>('log-print-events-batch', { ...input, filePaths }),
  removeEvent: (id: number) => callAction<unknown>('delete-print-event', id),
  setStatus: (filePaths: string[], printStatus: string) => (filePaths.length === 1
    ? callAction<unknown>('set-print-status', { filePath: filePaths[0], printStatus })
    : callAction<unknown>('set-print-status-batch', { filePaths, printStatus }))
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
