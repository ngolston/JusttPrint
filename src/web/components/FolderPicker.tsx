import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Folder, HardDrive } from 'lucide-react';
import { callAction } from '../api';
import { Button, cx } from './Button';
import { Modal } from './Overlay';

interface Entry { name: string; path: string }

/** What browse-folders returns (src/server/folder-browse.js). */
interface Listing {
  places: Entry[];
  path: string | null;
  parent: string | null;
  folders: Entry[];
  truncated: boolean;
  /** Why `dir` could not be listed (then `path` is null). */
  error?: string;
}

interface Request {
  title: string;
  /** Where to start; the first place when it is missing or not allowed. */
  initial?: string;
  confirmLabel: string;
  resolve: (folder: string | null) => void;
}

let open: ((request: Request) => void) | null = null;

/**
 * Choose a folder on the server: the container's mounted volumes and library folders, and their
 * subfolders. Resolves to the folder's path, or null when cancelled.
 */
export function pickFolder(options: { title?: string; initial?: string; confirmLabel?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const request = { title: options.title || 'Choose Folder', initial: options.initial, confirmLabel: options.confirmLabel || 'Choose This Folder', resolve };
    if (open) open(request);
    else resolve(null);
  });
}

const browse = (dir?: string | null) => callAction<Listing>('browse-folders', dir || null);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** The Choose Folder dialog (#folder-picker-dialog). Mounted once in main.tsx. */
export function FolderPicker() {
  const [request, setRequest] = useState<Request | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const pending = useRef<Request | null>(null);
  const load = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  async function go(dir: string | null | undefined, fallBack = false) {
    const ticket = ++load.current;
    setLoading(true);
    setError('');
    try {
      let next = await browse(dir);
      if (next.error && !fallBack) {
        // Keep the folder shown; say why the typed one cannot be opened.
        if (ticket === load.current) setError(next.error);
        return;
      }
      if (!next.path && next.places.length) next = await browse(next.places[0].path);
      if (ticket !== load.current) return;
      setListing(next);
      setTyped(next.path || '');
      listRef.current?.scrollTo(0, 0);
    } catch (err) {
      if (ticket === load.current) setError(errorText(err));
    } finally {
      if (ticket === load.current) setLoading(false);
    }
  }

  useEffect(() => {
    open = (next) => {
      pending.current?.resolve(null);
      pending.current = next;
      setRequest(next);
      setListing(null);
      setTyped(next.initial || '');
      void go(next.initial || null, true);
    };
    return () => { open = null; };
  }, []);

  const finish = (folder: string | null) => {
    const current = pending.current;
    pending.current = null;
    load.current++;
    setRequest(null);
    current?.resolve(folder);
  };

  const current = listing?.path || null;
  const places = listing?.places || [];
  const inPlace = (place: Entry) => !!current && (current === place.path || current.startsWith(place.path === '/' ? '/' : `${place.path}/`));
  const activePlace = places.filter(inPlace).sort((a, b) => b.path.length - a.path.length)[0];

  return (
    <Modal open={!!request} onClose={() => finish(null)} title={request?.title || 'Choose Folder'} className="jp-folder-picker"
      footer={(
        <>
          <Button variant="secondary" onClick={() => finish(null)}>Cancel</Button>
          <Button id="folder-picker-choose" variant="primary" disabled={!current || loading} onClick={() => finish(current)}>
            {request?.confirmLabel || 'Choose This Folder'}
          </Button>
        </>
      )}>
      <div id="folder-picker-dialog">
        {places.length > 0 && (
          <div className="jp-folder-picker__places" role="group" aria-label="Places">
            {places.map((place) => (
              <button key={place.path} type="button" className={cx('jp-folder-picker__place', place === activePlace && 'is-active')}
                title={place.path} onClick={() => go(place.path)}>
                <HardDrive size={14} aria-hidden="true" />
                <span>{place.path}</span>
              </button>
            ))}
          </div>
        )}

        <form className="jp-folder-picker__bar" onSubmit={(event) => { event.preventDefault(); void go(typed.trim()); }}>
          <button type="button" className="jp-icon-btn jp-icon-btn--sm" aria-label="Up one folder" title="Up one folder"
            disabled={!listing?.parent || loading} onClick={() => go(listing?.parent)}>
            <ArrowUp size={16} aria-hidden="true" />
          </button>
          <input type="text" id="folder-picker-path" className="jp-input" aria-label="Folder path" spellCheck={false} autoComplete="off"
            value={typed} placeholder="/models" onChange={(event) => setTyped(event.target.value)} />
          <Button type="submit" size="sm" disabled={!typed.trim() || loading}>Go</Button>
        </form>

        {error && <p className="jp-folder-picker__error" role="alert">{error}</p>}

        <ul ref={listRef} id="folder-picker-list" className="jp-folder-picker__list" aria-busy={loading}>
          {!loading && listing && !places.length && (
            <li className="jp-folder-picker__empty">No folders are mounted into the container. Add a volume in your Docker setup.</li>
          )}
          {!loading && current && !listing?.folders.length && <li className="jp-folder-picker__empty">No subfolders here.</li>}
          {listing?.folders.map((folder) => (
            <li key={folder.path}>
              <button type="button" className="jp-folder-picker__folder" onClick={() => go(folder.path)} title={folder.path}>
                <Folder size={16} aria-hidden="true" />
                <span>{folder.name}</span>
              </button>
            </li>
          ))}
          {listing?.truncated && <li className="jp-folder-picker__empty">Only the first 1,000 folders are shown. Type a path above to go further.</li>}
        </ul>
      </div>
    </Modal>
  );
}
