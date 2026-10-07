import type { ReactNode } from 'react';
import { useCan, type Role } from '../session';

/** Shows its children only to users with at least `role` (default editor): viewers only look. */
export function EditOnly({ children, role = 'editor' }: { children: ReactNode; role?: Role }) {
  return useCan(role) ? <>{children}</> : null;
}
