import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, FolderOpen, Link2, LoaderCircle } from 'lucide-react';
import { callAction } from '../api';
import { Button } from '../components/Button';
import { pickFolder } from '../components/FolderPicker';
import { Modal } from '../components/Overlay';
import { getFilterState } from '../filters/store';
import { runSearch } from '../filters/search';
import { accountStatus, getSiteDetails, type MakerWorldProfile } from '../makerworld/makerworld';
import { ProfileChecklist } from '../makerworld/ProfileChecklist';
import { FileChecklist, type SiteFile } from './FileChecklist';
import { SiteSetupNotice } from './SiteSetup';
import { exposeGlobal, onServerEvent } from '../page';
import { stlHomeDirectories } from '../scan/stlHome';
import { formatBytes } from '../shell/AppShell';
import { navigate } from '../shell/routes';
import { useCan } from '../session';

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
  profileId: string | null;
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
  status: 'added' | 'downloaded' | 'exists' | 'missing';
  name: string | null;
  designer: string | null;
  picture: boolean;
  warning: string | null;
  folder?: string;
  saved?: string[];
  /** Saved, but of a type the library does not scan. */
  notScanned?: string[];
}

// Same folder memory as Upload Models; whether MakerWorld files are downloaded too.
const FOLDER_KEY = 'justtprint.uploadFolder';
const DOWNLOAD_KEY = 'justtprint.linkDownload';

function stored(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window */
  }
}

async function defaultFolder(): Promise<string> {
  const shown = getFilterState().directory;
  if (shown && !shown.includes('::')) return shown;
  return stored(FOLDER_KEY) || (await stlHomeDirectories().catch(() => [] as string[]))[0] || '';
}

type Status = 'new' | 'exists' | 'adding' | 'added' | 'missing' | 'error';

interface Row {
  url: string;
  /** The link to import: with the MakerWorld print profile it named (#profileId-…). */
  importUrl: string;
  site: string;
  siteLabel: string;
  name: string;
  status: Status;
  message: string;
  /** Added, but the site's details or picture could not be read. */
  partial?: boolean;
  /** MakerWorld: the model's print profiles (looked up after pasting) and the ones ticked. */
  profiles?: MakerWorldProfile[];
  chosen?: string[];
  /** The profile the link named (#profileId-…). */
  linkProfile?: string | null;
  /** In the library as an online model: Add can still download its files. */
  online?: boolean;
  /** Printables and Thingiverse: the model's files (looked up after pasting) and the ones ticked. */
  files?: SiteFile[];
  chosenFiles?: string[];
  /** Why the files are not listed (Thingiverse without an API token). */
  filesNote?: string;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const models = (count: number) => `${count} ${count === 1 ? 'model' : 'models'}`;

function rowFor(link: CheckedLink): Row {
  const base = {
    url: link.url,
    importUrl: link.profileId ? `${link.url}#profileId-${link.profileId}` : link.url,
    site: link.site,
    siteLabel: link.siteLabel,
    linkProfile: link.profileId
  };
  return link.existing
    ? {
        ...base,
        name: link.existing.fileName || link.name || link.url,
        status: 'exists',
        message: 'Already in your library',
        online: link.existing.filePath.startsWith('url::')
      }
    : { ...base, name: link.name || link.url, status: 'new', message: '' };
}

/** Rows Add works on: new ones, failed ones, and online models whose files can be downloaded. */
const isPending = (row: Row, download: boolean) => row.status === 'new' || row.status === 'error' || (download && !!row.online && row.status === 'exists');

function summaryOf(rows: Row[]): string {
  const count = (status: Status) => rows.filter((row) => row.status === status).length;
  const added = count('added');
  const partial = rows.filter((row) => row.status === 'added' && row.partial).length;
  return [
    added ? `Added ${models(added)}${partial ? ` (${partial} without all details)` : ''}.` : 'Nothing was added.',
    count('exists') ? `${models(count('exists'))} already in your library.` : '',
    count('missing') ? `${count('missing')} not found on the site.` : '',
    count('error') ? `${count('error')} failed.` : ''
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Add Links (Library → Add Links): paste Printables, Thingiverse or MakerWorld links and each
 * model is added to the library as an online model, with its name, designer, license, picture
 * and source link from the site. With "Download the files" on, the models are downloaded into a
 * library folder instead: the ticked MakerWorld print profiles (after the MakerWorld sign-in) and
 * the ticked Printables and Thingiverse files (Thingiverse with an API token). Links already in
 * the library are skipped, except online models, which can still get their files. Editors and admins.
 */
export function LinkImportDialog() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [unsupported, setUnsupported] = useState<string[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState('');
  const [download, setDownload] = useState(() => stored(DOWNLOAD_KEY) !== '0');
  const [folder, setFolder] = useState('');
  const [folderProblem, setFolderProblem] = useState('');
  const stop = useRef(false);
  const checkId = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const current = useRef<string | null>(null);
  const canEdit = useCan('editor');

  useEffect(
    () =>
      exposeGlobal('openLinkImport', (initial?: string) => {
        setOpen(true);
        setSummary('');
        if (initial) setText(initial);
        setTimeout(() => input.current?.focus(), 0);
        void defaultFolder().then((dir) => setFolder((value) => value || dir));
      }),
    []
  );

  // Say right away when downloads cannot be saved in the folder (mounted read-only, for one).
  useEffect(() => {
    if (!open || !folder || !download) {
      setFolderProblem('');
      return undefined;
    }
    let live = true;
    callAction<{ ok: boolean; error: string | null }>('makerworld-check-folder', folder)
      .then((result) => {
        if (live) setFolderProblem(result.ok ? '' : result.error || 'Files cannot be saved in this folder.');
      })
      .catch(() => {
        if (live) setFolderProblem('');
      });
    return () => {
      live = false;
    };
  }, [open, folder, download]);

  // Download progress of the link being added.
  useEffect(() => {
    if (!open) return undefined;
    return onServerEvent('makerworld-download-progress', (data: { label: string; received: number; total: number | null }) => {
      const url = current.current;
      if (url)
        patch(url, { message: `Downloading ${data.label.toLowerCase()}: ${formatBytes(data.received)}${data.total ? ` of ${formatBytes(data.total)}` : ''}` });
    });
  }, [open]);

  async function chooseFolder() {
    const picked = await pickFolder({ title: 'Download Into', initial: folder || undefined, confirmLabel: 'Download Here' });
    if (picked) setFolder(picked);
  }

  // Check the links shortly after typing or pasting stops. Only a change to the text checks them
  // again: finishing Add must not, or the results of each link would be replaced at once.
  useEffect(() => {
    if (!open) return undefined;
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
        const next = result.links.map(rowFor);
        setRows(next);
        void lookUpFiles(next, id);
        setUnsupported(result.unsupported);
        setSkipped(result.skipped);
      } catch (error) {
        if (id === checkId.current) setSummary(`The links could not be checked: ${errorText(error)}`);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [text, open]);

  /**
   * What each new link (or online model) can download, so it can be ticked before Add: a
   * MakerWorld model's print profiles (all ticked), a Printables or Thingiverse model's files
   * (model files ticked). No sign-in is needed to look.
   */
  async function lookUpFiles(list: Row[], id: number) {
    for (const row of list.filter((r) => r.status === 'new' || r.online)) {
      if (id !== checkId.current) return;
      try {
        if (row.site === 'makerworld') {
          const found = await getSiteDetails(row.importUrl);
          const profiles = found?.details?.profiles || [];
          if (id === checkId.current) patch(row.url, { profiles, chosen: profiles.map((p) => p.id) });
        } else {
          const found = await callAction<{ files: SiteFile[]; needsToken?: boolean; error?: string }>('list-site-files', row.url);
          if (id === checkId.current)
            patch(row.url, { files: found.files, chosenFiles: found.files.filter((f) => f.model).map((f) => f.id), filesNote: found.error || '' });
        }
      } catch {
        /* the download picks the files itself then */
      }
    }
  }

  function patch(url: string, changes: Partial<Row>) {
    setRows((list) => list.map((row) => (row.url === url ? { ...row, ...changes } : row)));
  }

  async function start() {
    const queue = rows.filter((row) => isPending(row, download));
    if (!queue.length) return;
    // Files are downloaded into the library folder; MakerWorld needs its sign-in first.
    const downloading = download;
    let makerWorldDownloads = downloading && queue.some((row) => row.site === 'makerworld');
    let note = '';
    if (downloading) {
      if (!folder || folderProblem) {
        setSummary(folderProblem || 'Choose the library folder the files are downloaded into.');
        return;
      }
      store(FOLDER_KEY, folder);
      if (
        makerWorldDownloads &&
        !(await accountStatus().catch(() => ({ signedIn: false }))).signedIn &&
        !(await window.signInMakerWorld?.('To download the MakerWorld models you are adding,'))
      ) {
        makerWorldDownloads = false;
        note = ' MakerWorld models were not downloaded: no MakerWorld sign-in.';
      }
    }
    stop.current = false;
    setBusy(true);
    setSummary('');
    const done = new Map<string, Partial<Row>>();
    for (const row of queue) {
      if (stop.current) break;
      current.current = row.url;
      const downloadThis = downloading && (row.site !== 'makerworld' || makerWorldDownloads);
      patch(row.url, { status: 'adding', message: downloadThis ? 'Downloading…' : '' });
      let changes: Partial<Row>;
      try {
        // What was ticked: none ticked adds the online model only.
        const options = !downloadThis
          ? null
          : row.site === 'makerworld'
            ? { downloadFolder: folder, profileIds: row.profiles && row.profiles.length > 1 ? row.chosen || [] : undefined }
            : { downloadFolder: folder, fileIds: row.files && row.files.length ? row.chosenFiles || [] : undefined };
        const result = await callAction<ImportResult>('import-model-link', row.importUrl, options);
        if (result.status === 'downloaded') {
          const saved = result.saved || [];
          const what = row.site === 'makerworld' ? 'print profiles' : 'files';
          changes = {
            status: 'added',
            online: false,
            name: result.name || row.name,
            partial: !!result.warning,
            message:
              `Downloaded ${saved.length === 1 ? saved[0] : `${saved.length} ${what}`} into ${result.folder}${result.warning ? `. ${result.warning}` : ''}` +
              (result.notScanned?.length
                ? `. Not in the library: ${result.notScanned.join(', ')} (turn its file type on under Settings → Scanning → File Types)`
                : '')
          };
        } else if (result.status === 'added') {
          changes = {
            status: 'added',
            name: result.name || row.name,
            partial: !!result.warning,
            message: result.warning || [result.designer ? `by ${result.designer}` : '', result.picture ? '' : 'no picture'].filter(Boolean).join(' · ')
          };
        } else if (result.status === 'exists') {
          changes = {
            status: 'exists',
            online: false,
            name: result.name || row.name,
            partial: !!result.warning,
            message: result.warning || 'Already in your library'
          };
        } else {
          changes = { status: 'missing', message: result.warning || 'Not found on the site' };
        }
      } catch (error) {
        changes = { status: 'error', message: errorText(error) };
      }
      done.set(row.url, changes);
      patch(row.url, changes);
    }
    current.current = null;
    setRows((list) => {
      const finished = list.map((row) => ({
        ...row,
        ...(done.get(row.url) || {}),
        ...(row.status === 'adding' && !done.has(row.url) ? { status: 'new' as Status } : {})
      }));
      setSummary(`${summaryOf(finished)}${stop.current ? ' Stopped.' : ''}${note}`);
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

  const waiting = rows.filter((row) => isPending(row, download)).length;
  const anyAdded = rows.some((row) => row.status === 'added');
  const downloadable = rows.some((row) => row.status === 'new' || row.status === 'error' || row.online);

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add Links"
      className="jp-upload jp-links"
      footer={
        <>
          {anyAdded && !busy && (
            <Button
              onClick={() => {
                close();
                navigate('library');
              }}
            >
              Show Library
            </Button>
          )}
          <Button onClick={close}>{busy ? 'Stop' : 'Close'}</Button>
          <Button variant="primary" icon={Link2} id="jp-links-start" disabled={busy || waiting === 0} onClick={start}>
            {busy ? 'Adding…' : waiting ? `Add ${models(waiting)}` : 'Add'}
          </Button>
        </>
      }
    >
      <label className="jp-label" htmlFor="jp-links-text">
        Model links from Printables, Thingiverse or MakerWorld, one per line
      </label>
      <textarea
        id="jp-links-text"
        ref={input}
        className="jp-input jp-links__text"
        rows={6}
        value={text}
        disabled={busy}
        spellCheck={false}
        placeholder={'https://www.printables.com/model/3161-3d-benchy\nhttps://www.thingiverse.com/thing:763622\nhttps://makerworld.com/en/models/1000000'}
        onChange={(event) => {
          setText(event.target.value);
          setSummary('');
        }}
      />
      <p className="jp-meta jp-links__hint">
        Each model is added with its name, designer, license and picture from the site, and the link as its source: as its files when they are downloaded, else
        as an online model. Links already in your library are skipped.
      </p>

      {downloadable && canEdit && (
        <div className="jp-links__download" id="jp-links-download">
          <label className="jp-mw-download__row">
            <input
              type="checkbox"
              id="jp-links-download-toggle"
              checked={download}
              disabled={busy}
              onChange={(event) => {
                setDownload(event.target.checked);
                store(DOWNLOAD_KEY, event.target.checked ? '1' : '0');
              }}
            />
            <span>Download the files into a new folder per model: MakerWorld print profiles (3MF), Printables and Thingiverse files</span>
          </label>
          {download && (
            <div className="jp-upload__folder">
              <div className="jp-upload__folder-text">
                <span className="jp-label">Library folder</span>
                <span className="jp-upload__path" id="jp-links-folder" title={folder}>
                  {folder || 'Choose a folder in your library'}
                </span>
              </div>
              <Button icon={FolderOpen} onClick={chooseFolder} disabled={busy}>
                Choose Folder
              </Button>
            </div>
          )}
          {download && folderProblem && (
            <p className="jp-mw-download__problem" role="alert">
              {folderProblem}
            </p>
          )}
        </div>
      )}
      {download && canEdit && !busy && (
        <SiteSetupNotice sites={[...new Set(rows.filter((row) => isPending(row, download)).map((row) => row.site))]} onLeave={close} />
      )}

      {rows.length > 0 && (
        <ul className="jp-upload__list" aria-label="Links to add" id="jp-links-list">
          {rows.map((row) => (
            <li key={row.url} className={`jp-upload__item jp-links__item is-${row.status === 'added' && row.partial ? 'skipped' : row.status}`}>
              <span className="jp-upload__icon" aria-hidden="true">
                {row.status === 'added' || row.status === 'exists' ? (
                  <CheckCircle2 size={16} />
                ) : row.status === 'adding' ? (
                  <LoaderCircle size={16} className="jp-spin" />
                ) : row.status === 'missing' || row.status === 'error' ? (
                  <CircleAlert size={16} />
                ) : (
                  <Link2 size={16} />
                )}
              </span>
              <span className="jp-upload__name" title={row.url}>
                {row.name}
              </span>
              <span className="jp-upload__size">{row.siteLabel}</span>
              {row.message && !(download && row.online && row.status === 'exists') && (
                <span className="jp-upload__message">
                  {row.status === 'error' ? 'Failed: ' : row.status === 'missing' ? 'Skipped: ' : ''}
                  {row.message}
                </span>
              )}
              {download && row.online && row.status === 'exists' && (
                <span className="jp-upload__message">In your library as an online model: Add downloads its files.</span>
              )}
              {download && row.site !== 'makerworld' && isPending(row, download) && row.files && row.files.length > 0 && (
                <div className="jp-links__profiles">
                  <FileChecklist files={row.files} chosen={row.chosenFiles || []} disabled={busy} onChange={(ids) => patch(row.url, { chosenFiles: ids })} />
                  {!(row.chosenFiles || []).length && <span className="jp-meta">None ticked: added as an online model, nothing downloaded.</span>}
                </div>
              )}
              {download && row.site !== 'makerworld' && isPending(row, download) && row.filesNote && (
                <span className="jp-upload__message">{row.filesNote}. Added as an online model until then.</span>
              )}
              {download && row.site === 'makerworld' && isPending(row, download) && row.profiles && row.profiles.length > 1 && (
                <div className="jp-links__profiles">
                  <ProfileChecklist
                    profiles={row.profiles}
                    chosen={row.chosen || []}
                    disabled={busy}
                    mainId={row.linkProfile || null}
                    onChange={(ids) => patch(row.url, { chosen: ids })}
                  />
                  {!(row.chosen || []).length && <span className="jp-meta">None ticked: added as an online model, nothing downloaded.</span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {(unsupported.length > 0 || skipped > 0) && (
        <p className="jp-meta jp-links__unsupported" id="jp-links-unsupported">
          {unsupported.length > 0 &&
            `Not a model link, left out: ${unsupported.slice(0, 3).join(', ')}${unsupported.length > 3 ? ` and ${unsupported.length - 3} more` : ''}.`}
          {skipped > 0 && ` Up to 200 links at a time: ${skipped} left out.`}
        </p>
      )}
      <p className="jp-upload__summary" role="status" id="jp-links-summary">
        {summary}
      </p>
    </Modal>
  );
}
