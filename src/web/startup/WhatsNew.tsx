import { useEffect, useRef, useState } from 'react';
import { callAction, settings } from '../api';
import { ModalDialog } from '../components/ModalDialog';
import { render } from '../notes/markdown';
import { exposeGlobal } from '../page';
import { compareVersions } from './updates';

declare global {
  interface Window {
    openWhatsNew?: () => void;
  }
}

export interface WhatsNewEntry {
  version: string;
  /** YYYY-MM-DD, from the changelog heading. */
  date: string;
  /** The changelog entry, in Markdown. */
  body: string;
}
interface WhatsNewAnswer {
  version: string;
  entries: WhatsNewEntry[];
}

/** Opens the dialog and settles when it closes (set while it is mounted). */
let present: ((answer: WhatsNewAnswer) => Promise<void>) | null = null;

/**
 * Once per person after an update: what changed since the version they saw last (the
 * changelog, src/server/whats-new.js). A new account gets the welcome instead, and a person
 * who never saw one gets this version's. Settles when the dialog is closed.
 */
export async function showWhatsNewAfterUpdate(firstRun: boolean): Promise<void> {
  const [current, seen] = await Promise.all([settings.get<string | null>('currentVersion'), settings.get<string | null>('whatsNewSeen')]).catch(() => [
    null,
    null
  ]);
  if (!current || seen === current) return;
  await settings.save('whatsNewSeen', current).catch(() => {});
  // A downgrade only remembers the version.
  if (firstRun || (seen && compareVersions(seen, current) > 0)) return;
  const answer = await callAction<WhatsNewAnswer>('get-whats-new', seen || null).catch(() => null);
  if (answer?.entries.length && present) await present(answer);
}

/** "Nov 5, 2026" for 2026-11-05. */
function formatDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** What's New: after an update, and from Settings → Help → What's New. Registers window.openWhatsNew. */
export function WhatsNew() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [answer, setAnswer] = useState<WhatsNewAnswer | null>(null);
  const closed = useRef<(() => void) | null>(null);

  useEffect(() => {
    const show = (next: WhatsNewAnswer) => {
      setAnswer(next);
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
    };
    present = (next) =>
      new Promise((resolve) => {
        closed.current = resolve;
        show(next);
      });
    const unexpose = exposeGlobal('openWhatsNew', () => {
      void callAction<WhatsNewAnswer>('get-whats-new', null).then(show, () => {});
    });
    return () => {
      present = null;
      unexpose();
    };
  }, []);

  const entries = answer?.entries ?? [];
  return (
    <ModalDialog
      id="whats-new-dialog"
      className="jp-whats-new"
      title={answer ? `What's new in JusttPrint ${answer.version}` : "What's New"}
      dialogRef={dialogRef}
      onClose={() => {
        closed.current?.();
        closed.current = null;
      }}
      footer={
        <button type="button" className="jp-btn jp-btn--primary jp-btn--md" onClick={() => dialogRef.current?.close()}>
          Got it
        </button>
      }
    >
      <div className="jp-whats-new__entries">
        {entries.length === 0 && <p className="jp-meta">No notes for this version.</p>}
        {entries.map((entry) => (
          <section key={entry.version} className="jp-whats-new__entry" aria-label={`Version ${entry.version}`}>
            {(entries.length > 1 || entry.date) && (
              <h4 className="jp-whats-new__version">
                {entries.length > 1 ? `Version ${entry.version}` : ''}
                {entries.length > 1 && entry.date ? ' · ' : ''}
                {entry.date ? formatDate(entry.date) : ''}
              </h4>
            )}
            <div className="jp-whats-new__body" dangerouslySetInnerHTML={{ __html: render(entry.body) }} />
          </section>
        ))}
      </div>
    </ModalDialog>
  );
}
