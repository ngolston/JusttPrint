import { useEffect, useState } from 'react';
import { Download, Repeat } from 'lucide-react';
import { callAction, downloadUrl, printQueue } from '../api';
import { StatusBadge } from '../components/Badge';
import { EditOnly } from '../components/EditOnly';
import { showMessage } from '../page';
import { formatBytes } from '../shell/Storage';

/** A file a print used (src/server/printed-files.js listPrintedFiles). */
interface PrintedFile {
  id: number;
  name: string;
  size: number | null;
  plate: number | null;
  printerId: number | null;
  printerName: string | null;
  sentAt: string;
  settings: { key: string; label: string; value: string }[];
  outcome: string | null;
}

const OUTCOMES: Record<string, ['success' | 'danger' | 'neutral', string]> = {
  printed: ['success', 'Printed'],
  failed: ['danger', 'Failed'],
  cancelled: ['neutral', 'Cancelled']
};

/**
 * Printed files on a model's page: the exact sliced file each print sent from the queue used,
 * with when, where, how it went and what it was sliced with. Reprint queues the model and sends
 * that same file (queue/SendToPrinter.tsx); Download saves the copy. Nothing when there is none.
 */
export function PrintedFiles({ filePath }: { filePath: string }) {
  const [files, setFiles] = useState<PrintedFile[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    callAction<PrintedFile[]>('get-printed-files', filePath).then(
      (list) => live && setFiles(list),
      () => live && setFiles([])
    );
    return () => {
      live = false;
    };
  }, [filePath]);
  if (!files || !files.length) return null;

  async function reprint(file: PrintedFile) {
    try {
      const id = await printQueue.add(filePath, { plate: file.plate, printerId: file.printerId });
      const item = (await printQueue.list()).find((entry) => entry.id === id);
      if (item) window.openSendToPrinter?.(item, { printedFileId: file.id });
    } catch (error) {
      await showMessage('Reprint', error instanceof Error ? error.message : String(error));
    }
  }

  async function download(file: PrintedFile) {
    try {
      const result = await callAction<{ filePath: string; name: string }>('download-printed-file', file.id);
      const link = document.createElement('a');
      link.href = downloadUrl(result.filePath);
      link.download = result.name;
      link.click();
    } catch (error) {
      await showMessage('Download', error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="jp-card jp-model-page__panel jp-printed-files" aria-labelledby="jp-printed-files-title">
      <h2 className="jp-panel-title" id="jp-printed-files-title">
        Printed files
      </h2>
      <ul className="jp-printed-files__list">
        {files.map((file) => {
          const outcome = file.outcome ? OUTCOMES[file.outcome] : null;
          return (
            <li key={file.id} className="jp-printed-files__item">
              <div className="jp-printed-files__head">
                <span className="jp-printed-files__what">
                  <strong>{new Date(file.sentAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</strong>
                  <span className="jp-meta">
                    {[file.printerName, file.plate ? `Plate ${file.plate}` : null, file.name, file.size ? formatBytes(file.size) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {outcome && <StatusBadge tone={outcome[0]}>{outcome[1]}</StatusBadge>}
                <span className="jp-printed-files__actions">
                  {file.settings.length > 0 && (
                    <button type="button" className="jp-link" aria-expanded={open === file.id} onClick={() => setOpen(open === file.id ? null : file.id)}>
                      Settings
                    </button>
                  )}
                  <EditOnly>
                    <button
                      type="button"
                      className="jp-btn jp-btn--secondary jp-btn--sm"
                      onClick={() => void reprint(file)}
                      title="Queue it and send this same file to a printer"
                    >
                      <Repeat size={14} aria-hidden="true" />
                      <span>Reprint</span>
                    </button>
                  </EditOnly>
                  <button
                    type="button"
                    className="jp-icon-btn jp-icon-btn--sm"
                    onClick={() => void download(file)}
                    aria-label={`Download ${file.name}`}
                    title="Download"
                  >
                    <Download size={14} aria-hidden="true" />
                  </button>
                </span>
              </div>
              {open === file.id && (
                <dl className="jp-printed-files__settings">
                  {file.settings.map((setting) => (
                    <div key={setting.key}>
                      <dt>{setting.label}</dt>
                      <dd>{setting.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
