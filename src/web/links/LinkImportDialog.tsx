import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Link2, LoaderCircle } from 'lucide-react';
import { callAction } from '../api';
import { Button } from '../components/Button';
import { Modal } from '../components/Overlay';
import { runSearch } from '../filters/search';
import { exposeGlobal } from '../page';
import { navigate } from '../shell/routes';

declare global {
  interface Window {
    /** Open Add Links (bulk import from Printables, Thingiverse and MakerWorld links). */
    openLinkImport?: (text?: string) => void;
  }
}

/** check-model-links (src/server/link-import.js). */
interface CheckedLink {
  site: string;
  siteLabel: string;
  id: string;
  url: string;
  name: string | null;
  existing: { filePath: string; fileName: string } | null;
}

interface CheckResult {
  links: CheckedLink[];
  unsupported: string[];
  skipped: number;
}

/** import-model-link. */
interface ImportResult {
  status: 'added' | 'exists' | 'missing';
  name: string | null;
  designer: string | null;
  picture: boolean;
  warning: string | null;
}

type Status = 'new' | 'exists' | 'adding' | 'added' | 'missing' | 'error';

interface Row {
  url: string;
  siteLabel: string;
  name: string;
  status: Status;
  message: string;
  /** Added, but the site's details or picture could not be read. */
  partial?: boolean;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const models = (count: number) => `${count} ${count === 1 ? 'model' : 'models'}`;

function rowFor(link: CheckedLink): Row {
  return link.existing
    ? { url: link.url, siteLabel: link.siteLabel, name: link.existing.fileName || link.name || link.url, status: 'exists', message: 'Already in your library' }
    : { url: link.url, siteLabel: link.siteLabel, name: link.name || link.url, status: 'new', message: '' };
}

function summaryOf(rows: Row[]): string {
  const count = (status: Status) => rows.filter((row) => row.status === status).length;
  const added = count('added');
  const partial = rows.filter((row) => row.status === 'added' && row.partial).length;
  return [
    added ? `Added ${models(added)}${partial ? ` (${partial} without all details)` : ''}.` : 'Nothing was added.',
    count('exists') ? `${models(count('exists'))} already in your library.` : '',
    count('missing') ? `${count('missing')} not found on the site.` : '',
    count('error') ? `${count('error')} failed.` : ''
  ].filter(Boolean).join(' ');
}

/**
 * Add Links (Library → Add Links): paste Printables, Thingiverse or MakerWorld links and each
 * model is added to the library as an online model, with its name, designer, license, picture
 * and source link from the site. Links already in the library are skipped. Editors and admins.
 */
export function LinkImportDialog() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [unsupported, setUnsupported] = useState<string[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState('');
  const stop = useRef(false);
  const checkId = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => exposeGlobal('openLinkImport', (initial?: string) => {
    setOpen(true);
    setSummary('');
    if (initial) setText(initial);
    setTimeout(() => input.current?.focus(), 0);
  }), []);

  // Check the links shortly after typing or pasting stops.
  useEffect(() => {
    if (!open || busy) return undefined;
    const id = ++checkId.current;
    const timer = setTimeout(async () => {
      if (!text.trim()) {
        setRows([]);
        setUnsupported([]);
        setSkipped(0);
        return;
      }
      try {
        const result = await callAction<CheckResult>('check-model-links', text);
        if (id !== checkId.current) return;
        setRows(result.links.map(rowFor));
        setUnsupported(result.unsupported);
        setSkipped(result.skipped);
      } catch (error) {
        if (id === checkId.current) setSummary(`The links could not be checked: ${errorText(error)}`);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [text, open, busy]);

  function patch(url: string, changes: Partial<Row>) {
    setRows((list) => list.map((row) => (row.url === url ? { ...row, ...changes } : row)));
  }

  async function start() {
    const queue = rows.filter((row) => row.status === 'new' || row.status === 'error');
    if (!queue.length) return;
    stop.current = false;
    setBusy(true);
    setSummary('');
    const done = new Map<string, Partial<Row>>();
    for (const row of queue) {
      if (stop.current) break;
      patch(row.url, { status: 'adding', message: '' });
      let changes: Partial<Row>;
      try {
        const result = await callAction<ImportResult>('import-model-link', row.url);
        if (result.status === 'added') {
          changes = { status: 'added', name: result.name || row.name, partial: !!result.warning,
            message: result.warning || [result.designer ? `by ${result.designer}` : '', result.picture ? '' : 'no picture'].filter(Boolean).join(' · ') };
        } else if (result.status === 'exists') {
          changes = { status: 'exists', name: result.name || row.name, message: 'Already in your library' };
        } else {
          changes = { status: 'missing', message: result.warning || 'Not found on the site' };
        }
      } catch (error) {
        changes = { status: 'error', message: errorText(error) };
      }
      done.set(row.url, changes);
      patch(row.url, changes);
    }
    setRows((list) => {
      const finished = list.map((row) => ({ ...row, ...(done.get(row.url) || {}), ...(row.status === 'adding' && !done.has(row.url) ? { status: 'new' as Status } : {}) }));
      setSummary(`${summaryOf(finished)}${stop.current ? ' Stopped.' : ''}`);
      return finished;
    });
    setBusy(false);
    if ([...done.values()].some((changes) => changes.status === 'added')) await runSearch({ force: true, preserveScroll: true });
  }

  function close() {
    if (busy) {
      stop.current = true;
      return;
    }
    setOpen(false);
    setText('');
    setRows([]);
    setUnsupported([]);
    setSummary('');
  }

  const waiting = rows.filter((row) => row.status === 'new' || row.status === 'error').length;
  const anyAdded = rows.some((row) => row.status === 'added');

  return (
    <Modal open={open} onClose={close} title="Add Links" className="jp-upload jp-links"
      footer={(
        <>
          {anyAdded && !busy && <Button onClick={() => { close(); navigate('library'); }}>Show Library</Button>}
          <Button onClick={close}>{busy ? 'Stop' : 'Close'}</Button>
          <Button variant="primary" icon={Link2} id="jp-links-start" disabled={busy || waiting === 0} onClick={start}>
            {busy ? 'Adding…' : waiting ? `Add ${models(waiting)}` : 'Add'}
          </Button>
        </>
      )}>
      <label className="jp-label" htmlFor="jp-links-text">Model links from Printables, Thingiverse or MakerWorld, one per line</label>
      <textarea id="jp-links-text" ref={input} className="jp-input jp-links__text" rows={6} value={text} disabled={busy} spellCheck={false}
        placeholder={'https://www.printables.com/model/3161-3d-benchy\nhttps://www.thingiverse.com/thing:763622\nhttps://makerworld.com/en/models/1000000'}
        onChange={(event) => { setText(event.target.value); setSummary(''); }} />
      <p className="jp-meta jp-links__hint">
        Each model is added as an online model with its name, designer, license and picture from the site, and the link as its source.
        Links already in your library are skipped.
      </p>

      {rows.length > 0 && (
        <ul className="jp-upload__list" aria-label="Links to add" id="jp-links-list">
          {rows.map((row) => (
            <li key={row.url} className={`jp-upload__item jp-links__item is-${row.status === 'added' && row.partial ? 'skipped' : row.status}`}>
              <span className="jp-upload__icon" aria-hidden="true">
                {row.status === 'added' || row.status === 'exists' ? <CheckCircle2 size={16} />
                  : row.status === 'adding' ? <LoaderCircle size={16} className="jp-spin" />
                    : row.status === 'missing' || row.status === 'error' ? <CircleAlert size={16} /> : <Link2 size={16} />}
              </span>
              <span className="jp-upload__name" title={row.url}>{row.name}</span>
              <span className="jp-upload__size">{row.siteLabel}</span>
              {row.message && (
                <span className="jp-upload__message">
                  {row.status === 'error' ? 'Failed: ' : row.status === 'missing' ? 'Skipped: ' : ''}{row.message}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {(unsupported.length > 0 || skipped > 0) && (
        <p className="jp-meta jp-links__unsupported" id="jp-links-unsupported">
          {unsupported.length > 0 && `Not a model link, left out: ${unsupported.slice(0, 3).join(', ')}${unsupported.length > 3 ? ` and ${unsupported.length - 3} more` : ''}.`}
          {skipped > 0 && ` Up to 200 links at a time: ${skipped} left out.`}
        </p>
      )}
      <p className="jp-upload__summary" role="status" id="jp-links-summary">{summary}</p>
    </Modal>
  );
}
