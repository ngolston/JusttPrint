import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/**
 * The rarely changed part of a settings form, folded away under "Advanced" (with a short line on
 * what is in it). The simple choices stay above it.
 */
export function Advanced({ id, hint, title = 'Advanced', children }: { id: string; hint?: string; title?: string; children: ReactNode }) {
  return (
    <details className="jp-advanced" id={id}>
      <summary className="jp-advanced__summary">
        <ChevronRight size={16} aria-hidden="true" className="jp-advanced__chevron" />
        <span className="jp-advanced__title">{title}</span>
        {hint && <span className="jp-advanced__hint">{hint}</span>}
      </summary>
      <div className="jp-advanced__body">{children}</div>
    </details>
  );
}
