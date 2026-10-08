import { useEffect, useState } from 'react';
import { onUndoChange, undoLast, type UndoEntry } from './undo';

/** How long the notice stays (Ctrl/Cmd+Z keeps working after it goes). */
const SHOW_MS = 10_000;

/** The "Changed … · Undo" notice after a metadata or tag edit (library/undo.ts). */
export function UndoToast() {
  const [entry, setEntry] = useState<UndoEntry | null>(null);
  const [undone, setUndone] = useState<string | null>(null);

  useEffect(() => onUndoChange((latest) => { setEntry(latest); if (latest) setUndone(null); }), []);

  useEffect(() => {
    if (!entry && !undone) return undefined;
    const timer = window.setTimeout(() => { setEntry(null); setUndone(null); }, undone ? 4000 : SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [entry, undone]);

  // Ctrl/Cmd+Z (KeyboardShortcutsDialog.tsx) reports what it undid here too.
  useEffect(() => {
    const onUndone = (event: Event) => { setEntry(null); setUndone((event as CustomEvent<string>).detail); };
    window.addEventListener('jp-undone', onUndone);
    return () => window.removeEventListener('jp-undone', onUndone);
  }, []);

  const undo = async () => {
    if (!entry) return;
    const label = await undoLast(entry.id);
    if (label) window.dispatchEvent(new CustomEvent('jp-undone', { detail: label }));
  };

  if (!entry && !undone) return <div className="jp-undo-toast-region" role="status" aria-live="polite" />;
  return (
    <div className="jp-undo-toast-region" role="status" aria-live="polite">
      <div className="jp-undo-toast" data-testid="undo-toast">
        {entry ? (
          <>
            <span className="jp-undo-toast__text">{entry.label}</span>
            <button type="button" className="jp-undo-toast__button" onClick={undo}>Undo</button>
          </>
        ) : (
          <span className="jp-undo-toast__text">Undone: {undone}</span>
        )}
        <button type="button" className="jp-undo-toast__close" aria-label="Dismiss" onClick={() => { setEntry(null); setUndone(null); }}>×</button>
      </div>
    </div>
  );
}
