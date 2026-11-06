import { useState } from 'react';
import { ArrowUp, FileBox, Folder, Play, RefreshCw, Trash2 } from 'lucide-react';
import { callAction, type Printer, type PrinterLive } from '../api';
import { EditOnly } from '../components/EditOnly';
import { showMessage } from '../page';
import { formatBytes } from '../shell/Storage';
import { formatDuration } from '../format';

/** One entry of a folder on the printer (src/server/printer-files.js listPrinterFiles). */
interface PrinterFile {
  name: string;
  path: string;
  folder: boolean;
  size: number;
  modified: string | null;
  printable: boolean;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The printer page's Files section (Bambu Lab): what is on the printer's storage (its microSD
 * card on a P1 or A1), loaded when asked. A sliced project or G-code there prints again without
 * an upload; old files can be deleted.
 */
export function PrinterFilesSection({ printer, live }: { printer: Printer; live: PrinterLive | null | undefined }) {
  const [dir, setDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<PrinterFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (printer.connection_type !== 'bambu' || !live?.connected) return null;

  async function open(folder: string) {
    setBusy('list');
    setError(null);
    try {
      const answer = await callAction<{ dir: string; entries: PrinterFile[] }>('get-printer-files', printer.id, folder);
      setDir(answer.dir);
      setEntries(answer.entries);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  }

  async function print(file: PrinterFile) {
    setBusy(file.path);
    try {
      let plate: number | undefined;
      if (/\.gcode\.3mf$/i.test(file.name)) {
        const plates = await callAction<{ index: number; seconds: number | null }[]>('get-printer-file-plates', printer.id, file.path);
        if (!plates.length) throw new Error('This file holds no sliced plate');
        const labels = plates.map((p) => `Plate ${p.index}${p.seconds ? ` (${formatDuration(p.seconds)})` : ''}`);
        const answer = await showMessage('Print from the printer', `Print ${file.name} on ${printer.nickname}? Choose the plate.`, [...labels, 'Cancel']);
        const chosen = labels.indexOf(answer);
        if (chosen < 0) return;
        plate = plates[chosen].index;
      } else if ((await showMessage('Print from the printer', `Print ${file.name} on ${printer.nickname}?`, ['Print', 'Cancel'])) !== 'Print') return;
      await callAction('print-printer-file', printer.id, file.path, plate === undefined ? {} : { plate });
      await showMessage('Printing', `${printer.nickname} starts ${file.name} in a moment.`);
    } catch (failure) {
      await showMessage(printer.nickname, errorText(failure));
    } finally {
      setBusy(null);
    }
  }

  async function remove(file: PrinterFile) {
    if (
      (await showMessage('Delete from the printer', `Delete ${file.name} from ${printer.nickname}? It cannot be brought back.`, ['Delete', 'Cancel'])) !==
      'Delete'
    )
      return;
    setBusy(file.path);
    try {
      await callAction('delete-printer-file', printer.id, file.path);
      setEntries((list) => (list ? list.filter((entry) => entry.path !== file.path) : list));
    } catch (failure) {
      await showMessage(printer.nickname, errorText(failure));
    } finally {
      setBusy(null);
    }
  }

  const parent = dir && dir !== '/' ? dir.replace(/\/[^/]+$/, '') || '/' : null;
  return (
    <EditOnly>
      <section className="jp-printer-detail__section jp-printer-files" aria-labelledby="jp-printer-files" id="jp-printer-files-section">
        <div className="jp-printer-detail__section-head">
          <h3 className="jp-details__heading" id="jp-printer-files">
            Files on the printer
          </h3>
          {entries && (
            <button type="button" className="jp-link" disabled={busy === 'list'} onClick={() => void open(dir || '/')} title="Read the files again">
              <RefreshCw size={14} aria-hidden="true" /> Refresh
            </button>
          )}
        </div>
        {!entries ? (
          <div className="jp-printer-files__start">
            <p className="jp-meta">The prints saved on the printer (its microSD card on a P1 or A1): print one again without sending it, or delete old ones.</p>
            <button
              type="button"
              id="jp-printer-files-show"
              className="jp-btn jp-btn--secondary jp-btn--sm"
              disabled={busy === 'list'}
              onClick={() => void open('/')}
            >
              {busy === 'list' ? 'Reading…' : 'Show Files'}
            </button>
          </div>
        ) : (
          <>
            <div className="jp-printer-files__path">
              {parent !== null && (
                <button type="button" className="jp-btn jp-btn--secondary jp-btn--sm" onClick={() => void open(parent)} title="Up a folder">
                  <ArrowUp size={14} aria-hidden="true" />
                  <span>Up</span>
                </button>
              )}
              <code>{dir}</code>
            </div>
            {!entries.length ? (
              <p className="jp-meta">Nothing here.</p>
            ) : (
              <ul className="jp-printer-files__list" aria-label="Files on the printer">
                {entries.map((entry) => (
                  <li key={entry.path} className="jp-printer-files__row">
                    {entry.folder ? (
                      <button type="button" className="jp-link jp-printer-files__name" onClick={() => void open(entry.path)}>
                        <Folder size={16} aria-hidden="true" /> {entry.name}
                      </button>
                    ) : (
                      <span className="jp-printer-files__name">
                        <FileBox size={16} aria-hidden="true" /> {entry.name}
                      </span>
                    )}
                    <span className="jp-meta">
                      {[!entry.folder ? formatBytes(entry.size) : null, entry.modified ? new Date(entry.modified).toLocaleDateString() : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    {!entry.folder && (
                      <span className="jp-printer-files__actions">
                        {entry.printable && (
                          <button
                            type="button"
                            className="jp-btn jp-btn--secondary jp-btn--sm"
                            disabled={!!busy}
                            onClick={() => void print(entry)}
                            title={`Print ${entry.name} on ${printer.nickname}`}
                          >
                            <Play size={14} aria-hidden="true" />
                            <span>Print</span>
                          </button>
                        )}
                        <button
                          type="button"
                          className="jp-icon-btn jp-icon-btn--sm"
                          disabled={!!busy}
                          onClick={() => void remove(entry)}
                          aria-label={`Delete ${entry.name} from the printer`}
                          title={`Delete ${entry.name} from the printer`}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {error && (
          <p className="jp-send__error" role="alert">
            {error}
          </p>
        )}
      </section>
    </EditOnly>
  );
}
