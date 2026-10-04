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
