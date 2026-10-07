/**
 * Who is logged in, from GET /api/auth/status (src/server/server-auth.js), read once per page.
 * Roles (src/server/users.js): viewer < editor < admin. The server checks every action; the page
 * only hides what the role cannot use.
 */
import { useSyncExternalStore } from 'react';

export type Role = 'viewer' | 'editor' | 'admin';

export interface CurrentUser {
  id: number;
  username: string;
  role: Role;
  roleLabel: string;
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
export const ROLE_LABELS: Record<Role, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' };
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Browse, preview and download.',
  editor: 'Also edit models, tags and the print log, upload, move and delete files.',
  admin: 'Also settings, backups, server access and user accounts.'
};

/** True when `role` is at least `required`. An unknown role allows nothing. */
export function roleAllows(role: string | null | undefined, required: Role): boolean {
  return !!role && role in RANK && RANK[role as Role] >= RANK[required];
}

let current: CurrentUser | null = null;
const listeners = new Set<() => void>();

function set(user: CurrentUser | null) {
  current = user;
  // For CSS: controls that only edit are hidden or inert for viewers (styles/stats.css).
  if (typeof document !== 'undefined') {
    if (user) document.documentElement.dataset.role = user.role;
    else delete document.documentElement.dataset.role;
  }
  listeners.forEach((listener) => listener());
}

/** Read the logged-in user again (after logging in elsewhere, or a role change). */
export async function loadCurrentUser(): Promise<CurrentUser | null> {
  try {
    const response = await fetch('/api/auth/status', { credentials: 'same-origin' });
    const data = await response.json() as { authenticated?: boolean; user?: CurrentUser };
    set(data.authenticated && data.user ? data.user : null);
  } catch {
    /* offline: keep what we had */
  }
  return current;
}

export function getCurrentUser(): CurrentUser | null {
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The logged-in user; null until the status has loaded. */
export function useCurrentUser(): CurrentUser | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** True when the logged-in user has at least this role (false while it is still loading). */
export function useCan(required: Role): boolean {
  return roleAllows(useCurrentUser()?.role, required);
}

if (typeof window !== 'undefined' && typeof fetch === 'function') void loadCurrentUser();
