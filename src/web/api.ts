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
  return data.result as T;
}

export interface ServerAccessInfo {
  apiToken: string;
  passwordFromEnv: boolean;
  minPasswordLength: number;
}

export const serverAccess = {
  info: () => callAction<ServerAccessInfo>('get-server-access-info'),
  setPassword: (currentPassword: string, newPassword: string) =>
    callAction<unknown>('set-server-password', currentPassword, newPassword),
  regenerateToken: () => callAction<{ apiToken: string }>('regenerate-server-api-token')
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

export interface Filament {
  id: number;
  name: string;
  vendor: string | null;
  material: string | null;
  color_hex: string | null;
  diameter: number | null;
  spoolman_id: number | null;
  source: 'manual' | 'spoolman' | string;
  model_count: number;
}

export interface FilamentInput {
  name: string;
  vendor: string;
  material: string;
  color_hex: string;
  diameter: number;
  source: 'manual';
}

export const filaments = {
  list: () => callAction<Filament[]>('get-all-filaments'),
  save: (filament: FilamentInput) => callAction<Filament>('save-filament', filament),
  remove: (id: number) => callAction<unknown>('delete-filament', id),
  testSpoolman: (url: string, token: string) => callAction<{ version?: string }>('test-spoolman-connection', url, token),
  syncSpoolman: (url: string, token: string) =>
    callAction<{ total: number; created: number; updated: number }>('sync-spoolman-filaments', url, token)
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
  due_reminders_count?: number;
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

export const library = {
  stats: () => callAction<LibraryStats>('get-stats')
};

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

export interface InboxImportResult {
  imported: number;
  failed: number;
  skipped: number;
  errors: string[];
  busy?: boolean;
}

export const extensionInbox = {
  defaultDirectory: () => callAction<string>('get-default-extension-inbox-directory'),
  importNow: () => callAction<InboxImportResult>('import-extension-inbox')
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
