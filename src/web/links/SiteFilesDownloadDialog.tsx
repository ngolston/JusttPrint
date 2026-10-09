import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen } from 'lucide-react';
import { callAction } from '../api';
import { Button } from '../components/Button';
import { pickFolder } from '../components/FolderPicker';
import { Modal } from '../components/Overlay';
import { ProgressBar } from '../components/Panel';
import { getFilterState } from '../filters/store';
import { runSearch } from '../filters/search';
import { SITE_LABELS, type MakerWorldDetails, type ProfileDownload } from '../makerworld/makerworld';
import { exposeGlobal, onServerEvent } from '../page';
import { stlHomeDirectories } from '../scan/stlHome';
import { formatBytes } from '../shell/AppShell';
import { navigate } from '../shell/routes';
import { FileChecklist, type SiteFile } from './FileChecklist';

declare global {
  interface Window {
    /** Download a Printables or Thingiverse model's files into a library folder. */
    openSiteFilesDownload?: (details: MakerWorldDetails, downloads?: ProfileDownload[]) => void;
  }
}

// The same folder memory as Upload Models.
const FOLDER_KEY = 'justtprint.uploadFolder';

function remembered(): string {
  try {
    return localStorage.getItem(FOLDER_KEY) || '';
  } catch {
    return '';
  }
}

async function defaultFolder(): Promise<string> {
  const shown = getFilterState().directory;
  if (shown && !shown.includes('::')) return shown;
  return remembered() || (await stlHomeDirectories().catch(() => [] as string[]))[0] || '';
}

interface Result {
  folder: string;
  saved: string[];
  mainFile: string | null;
  warning?: string | null;
  notScanned?: string[];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Download from Printables or Thingiverse (the details panel's site section): choose a library
 * folder and the files (model files ticked). They go into the model's folder (a new one named
 * after it, or the one from an earlier download) and the online model becomes them.
 */
export function SiteFilesDownloadDialog() {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<MakerWorldDetails | null>(null);
  const [downloaded, setDownloaded] = useState<string[]>([]);
  const [folder, setFolder] = useState('');
  const [folderProblem, setFolderProblem] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ label: string; received: number; total: number | null } | null>(null);
  const [summary, setSummary] = useState('');
  const [done, setDone] = useState(false);
  const alive = useRef(false);

  useEffect(
    () =>
      exposeGlobal('openSiteFilesDownload', (next: MakerWorldDetails, downloads: ProfileDownload[] = []) => {
        const have = downloads.map((d) => d.profileId.replace(/^file:/, ''));
        setDetails(next);
        setDownloaded(have);
        setChosen(next.files.filter((f) => f.model && f.id && !have.includes(f.id)).map((f) => f.id!));
        setSummary('');
        setDone(false);
        setProgress(null);
        setOpen(true);
        void defaultFolder().then((dir) => setFolder((current) => current || dir));
      }),
    []
  );

  useEffect(() => {
    alive.current = open;
    if (!open) return undefined;
    return onServerEvent('makerworld-download-progress', (data: { label: string; received: number; total: number | null }) => {
      if (alive.current) setProgress(data);
    });
  }, [open]);

  useEffect(() => {
    if (!open || !folder) {
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
  }, [open, folder]);

  async function chooseFolder() {
    const picked = await pickFolder({ title: 'Download Into', initial: folder || undefined, confirmLabel: 'Download Here' });
    if (picked) setFolder(picked);
  }

  async function start() {
    if (!details || !folder) return;
    setBusy(true);
    setSummary('');
    try {
      try {
        localStorage.setItem(FOLDER_KEY, folder);
      } catch {
        /* private window */
      }
      const result = await callAction<Result>('site-download-files', { url: details.url, folder, fileIds: chosen });
      const saved = result.saved || [];
      setSummary(
        [
          saved.length
            ? `Downloaded ${saved.length === 1 ? saved[0] : `${saved.length} files`} into ${result.folder}.`
            : `Every chosen file was already in ${result.folder}.`,
          result.warning ? `${result.warning}.` : '',
          result.notScanned?.length ? `Not in the library: ${result.notScanned.join(', ')} (turn its file type on under Settings → Scanning → File Types).` : ''
        ]
          .filter(Boolean)
          .join(' ')
      );
      setDone(true);
      await runSearch({ force: true, preserveScroll: true });
      if (result.mainFile) window.bundleHost?.openModel(result.mainFile);
    } catch (error) {
      setSummary(`Download failed: ${errorText(error)}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const close = () => {
    if (!busy) setOpen(false);
  };
  const files: SiteFile[] = (details?.files || [])
    .filter((f) => f.id)
    .map((f) => ({ id: f.id!, name: f.name, size: f.size, kind: f.type || 'file', model: !!f.model }));
  const todo = chosen.filter((id) => !downloaded.includes(id)).length;
  const label = details ? SITE_LABELS[details.site] : '';

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Download from ${label}`}
      className="jp-upload jp-mw-download jp-site-download"
      footer={
        <>
          {done && (
            <Button
              onClick={() => {
                setOpen(false);
                navigate('library');
              }}
            >
              Show Library
            </Button>
          )}
          <Button onClick={close} disabled={busy}>
            Close
          </Button>
          <Button variant="primary" icon={Download} id="jp-site-download-start" disabled={busy || !folder || !!folderProblem || todo === 0} onClick={start}>
            {busy ? 'Downloading…' : todo > 1 ? `Download ${todo} Files` : 'Download'}
          </Button>
        </>
      }
    >
      <div className="jp-upload__folder">
        <div className="jp-upload__folder-text">
          <span className="jp-label">Library folder</span>
          <span className="jp-upload__path" title={folder}>
            {folder || 'Choose a folder in your library'}
          </span>
        </div>
        <Button icon={FolderOpen} onClick={chooseFolder} disabled={busy}>
          Choose Folder
        </Button>
      </div>
      {folderProblem && (
        <p className="jp-mw-download__problem" role="alert">
          {folderProblem}
        </p>
      )}
      {details && (
        <p className="jp-meta">
          {downloaded.length ? (
            "Saved in the model's folder from before"
          ) : (
            <>
              Saved in a new folder, <strong>{(details.title || '').slice(0, 80)}</strong>
            </>
          )}
          , then added to the library with the designer, license and {label} link. An online model of it becomes the downloaded files.
        </p>
      )}
      {files.length > 0 && (
        <FileChecklist
          files={files}
          chosen={[...new Set([...chosen, ...downloaded])]}
          disabled={busy}
          onChange={(ids) => setChosen(ids.filter((id) => !downloaded.includes(id)))}
        />
      )}
      {downloaded.length > 0 && <p className="jp-meta">{downloaded.length} of the files are downloaded already and are skipped.</p>}
      {progress && (
        <div className="jp-upload__progress">
          <ProgressBar value={progress.total ? progress.received / progress.total : 0} max={1} label={`Downloading ${progress.label}`} />
          <span className="jp-upload__sent">
            {progress.label}: {formatBytes(progress.received)}
            {progress.total ? ` of ${formatBytes(progress.total)}` : ''}
          </span>
        </div>
      )}
      <p className="jp-upload__summary" role="status">
        {summary}
      </p>
    </Modal>
  );
}
