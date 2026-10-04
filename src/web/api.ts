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

export async function callAction<T>(name: string, ...args: unknown[]): Promise<T> {
  const response = await fetch(`/api/actions/${encodeURIComponent(name)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
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
