import { useEffect, useRef, useState } from 'react';
import { Download, FilePlus2, FolderOpen } from 'lucide-react';
import { callAction, uploadFile, uploads } from '../api';
import { Button } from '../components/Button';
import { pickFolder } from '../components/FolderPicker';
import { Modal } from '../components/Overlay';
import { ProgressBar } from '../components/Panel';
import { getFilterState } from '../filters/store';
import { runSearch } from '../filters/search';
import { exposeGlobal, onServerEvent } from '../page';
import { stlHomeDirectories } from '../scan/stlHome';
import { formatBytes } from '../shell/AppShell';
import { navigate } from '../shell/routes';
import { accountStatus, type MakerWorldDetails, type ProfileDownload } from './makerworld';
import { ProfileChecklist } from './ProfileChecklist';

declare global {
  interface Window {
    /** Download a MakerWorld model's files into a library folder. */
    openMakerWorldDownload?: (details: MakerWorldDetails, options?: { profileId?: string; downloads?: ProfileDownload[] }) => void;
  }
}

// The same folder memory as Upload Models.
const FOLDER_KEY = 'justtprint.uploadFolder';

interface DownloadResult {
  folder?: string;
  saved?: string[];
  inLibrary?: number;
  mainFile?: string | null;
  missing?: string[];
  warning?: string | null;
  signIn?: boolean;
  error?: string;
}

function rememberedFolder(): string {
  try {
    return localStorage.getItem(FOLDER_KEY) || '';
  } catch {
    return '';
  }
}

function rememberFolder(folder: string) {
  try {
    localStorage.setItem(FOLDER_KEY, folder);
  } catch {
    /* private window */
  }
}

async function defaultFolder(): Promise<string> {
  const shown = getFilterState().directory;
  if (shown && !shown.includes('::')) return shown;
  return rememberedFolder() || (await stlHomeDirectories().catch(() => [] as string[]))[0] || '';
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Download from MakerWorld (the details panel's MakerWorld section): choose a library folder and
 * a print profile; its 3MF goes into a new folder named after the model and is scanned. Asks for
 * the MakerWorld sign-in first when there is none. The separate model files are behind a CAPTCHA
 * on MakerWorld, so the dialog links to the model page for them.
 */
export function MakerWorldDownloadDialog() {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<MakerWorldDetails | null>(null);
  const [folder, setFolder] = useState('');
  const [profileId, setProfileId] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [downloads, setDownloads] = useState<ProfileDownload[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ label: string; received: number; total: number | null } | null>(null);
  const [summary, setSummary] = useState('');
  const [done, setDone] = useState(false);
  const [folderProblem, setFolderProblem] = useState('');
  const [blocked, setBlocked] = useState(false);
  const alive = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      exposeGlobal('openMakerWorldDownload', (next: MakerWorldDetails, options?: { profileId?: string; downloads?: ProfileDownload[] }) => {
        setDetails(next);
        setDownloads(options?.downloads || []);
        // Every profile not downloaded yet is ticked to start.
        setChosen(next.profiles.filter((p) => !(options?.downloads || []).some((d) => d.profileId === p.id)).map((p) => p.id));
        setProfileId(options?.profileId || next.profiles[0]?.id || '');
        setSummary('');
        setDone(false);
        setProgress(null);
        setBlocked(false);
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

  // Say right away when files cannot be saved there (a folder mounted read-only, for one).
  useEffect(() => {
    if (!open || !folder) {
      setFolderProblem('');
      return undefined;
    }
    let current = true;
    callAction<{ ok: boolean; error: string | null }>('makerworld-check-folder', folder)
      .then((result) => {
        if (current) setFolderProblem(result.ok ? '' : result.error || 'Files cannot be saved in this folder.');
      })
      .catch(() => {
        if (current) setFolderProblem('');
      });
    return () => {
      current = false;
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
      // The first download asks for the MakerWorld sign-in before anything else.
      if (!(await accountStatus()).signedIn && !(await window.signInMakerWorld?.())) {
        setSummary('Not downloaded: MakerWorld needs a sign-in.');
        return;
      }
      rememberFolder(folder);
      const request = {
        url: details.url,
        folder,
        profileIds: details.profiles.length > 1 ? chosen : details.profiles.map((p) => p.id),
        mainProfileId: profileId
      };
      let result = await callAction<DownloadResult>('makerworld-download', request);
      if (result.signIn) {
        if (!(await window.signInMakerWorld?.(result.error))) {
          setSummary('Not downloaded: MakerWorld needs a sign-in.');
          return;
        }
        result = await callAction<DownloadResult>('makerworld-download', request);
      }
      if (result.signIn) throw new Error(result.error || 'MakerWorld needs a sign-in');
      const saved = result.saved || [];
      const what = saved.length
        ? `Downloaded ${saved.length === 1 ? saved[0] : `${saved.length} print profiles`} into ${result.folder}.`
        : `Every chosen profile was already in ${result.folder}.`;
      setSummary(`${what}${result.warning ? ` ${result.warning}.` : ''}`);
      if (result.missing?.length && /not a robot/i.test(result.warning || '')) setBlocked(true);
      setDone(true);
      // The online model became these files: show the main one (the 3MF when there is one).
      await runSearch({ force: true, preserveScroll: true });
      if (result.mainFile) window.bundleHost?.openModel(result.mainFile);
    } catch (error) {
      // MakerWorld's robot check: point at downloading in the browser and adding the files here.
      if (/not a robot/i.test(errorText(error))) setBlocked(true);
      setSummary(`Download failed: ${errorText(error)}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  /** Files downloaded on MakerWorld in the browser: into the model's folder, then one model with the online one. */
  async function addFiles(chosen: File[]) {
    if (!details || !folder || !chosen.length) return;
    setBusy(true);
    setSummary('');
    try {
      rememberFolder(folder);
      const info = await uploads.info();
      const { folder: target } = await callAction<{ folder: string }>('makerworld-prepare-folder', { url: details.url, folder });
      const added: string[] = [];
      for (const file of chosen) {
        const uploaded = await uploadFile(file, target, {
          chunkBytes: info.chunkBytes,
          onProgress: (fraction) => setProgress({ label: file.name, received: fraction * file.size, total: file.size })
        });
        added.push(uploaded.fileName);
      }
      const result = await callAction<{ folder: string; inLibrary: number; mainFile: string | null }>('makerworld-add-files', {
        url: details.url,
        folder: target,
        files: added
      });
      setSummary(`Added ${chosen.length === 1 ? chosen[0].name : `${chosen.length} files`} into ${result.folder}.`);
      setDone(true);
      setBlocked(false);
      await runSearch({ force: true, preserveScroll: true });
      if (result.mainFile) window.bundleHost?.openModel(result.mainFile);
    } catch (error) {
      setSummary(`Adding the files failed: ${errorText(error)}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const close = () => {
    if (!busy) setOpen(false);
  };
  const profile = details?.profiles.find((p) => p.id === profileId);
  const toDownload = !details ? 0 : details.profiles.length > 1 ? chosen.filter((id) => !downloads.some((d) => d.profileId === id)).length : 1;
  const nothing = !details?.profiles.length || toDownload === 0;

  return (
    <Modal
      open={open}
      onClose={close}
      title="Download from MakerWorld"
      className="jp-upload jp-mw-download"
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
          <Button variant="primary" icon={Download} id="jp-mw-download-start" disabled={busy || !folder || !!folderProblem || nothing} onClick={start}>
            {busy ? 'Downloading…' : toDownload > 1 ? `Download ${toDownload} Profiles` : 'Download 3MF'}
          </Button>
        </>
      }
    >
      <div className="jp-upload__folder">
        <div className="jp-upload__folder-text">
          <span className="jp-label">Library folder</span>
          <span className="jp-upload__path" id="jp-mw-download-folder" title={folder}>
            {folder || 'Choose a folder in your library'}
          </span>
        </div>
        <Button icon={FolderOpen} onClick={chooseFolder} disabled={busy}>
          Choose Folder
        </Button>
      </div>
      {folderProblem && (
        <p className="jp-mw-download__problem" role="alert" id="jp-mw-download-folder-problem">
          {folderProblem}
        </p>
      )}
      {details && (
        <p className="jp-meta">
          {downloads.length ? (
            "Saved in the model's folder from before"
          ) : (
            <>
              Saved in a new folder, <strong>{(details.titleEnglish || details.title || '').slice(0, 80)}</strong>
            </>
          )}
          , then added to the library with the designer, license and MakerWorld link. An online model of it becomes the downloaded files, with its tags, notes
          and print history.
        </p>
      )}

      {details && details.profiles.length > 0 && (
        <fieldset className="jp-mw-download__group">
          {details.profiles.length > 1 ? (
            <ProfileChecklist
              id="jp-mw-download-profiles"
              profiles={details.profiles}
              chosen={chosen}
              onChange={setChosen}
              disabled={busy}
              downloaded={downloads.map((d) => d.profileId)}
            />
          ) : (
            profile && (
              <>
                <legend className="jp-label">Print profile</legend>
                <p className="jp-mw-download__name-line">{profile.nameEnglish || profile.name}</p>
              </>
            )
          )}
          <p className="jp-meta">
            Each profile is a 3MF project: its parts on their plates, with the colors and settings, ready for the slicer.
            {downloads.length > 0 && " Profiles already downloaded are skipped, and new ones go into the model's folder."}
          </p>
        </fieldset>
      )}
      {details && details.profiles.length === 0 && (
        <p className="jp-mw-download__problem">
          This model has no print profile to download.{' '}
          <a href={details.url} target="_blank" rel="noopener noreferrer">
            Open it on MakerWorld
          </a>{' '}
          to download its files.
        </p>
      )}

      {details && (
        <div className={`jp-mw-download__manual${blocked ? ' is-highlighted' : ''}`} id="jp-mw-download-manual">
          <p className="jp-meta">
            {blocked
              ? 'MakerWorld wants a browser for this one. '
              : details.files.length
                ? `MakerWorld only lets a browser download the ${details.files.length} separate ${details.files.length === 1 ? 'file' : 'files'}. `
                : 'Downloaded it yourself? '}
            <a href={details.url} target="_blank" rel="noopener noreferrer">
              Download on MakerWorld
            </a>
            , then add the files here: they go into the model's folder and become this model.
          </p>
          <Button icon={FilePlus2} id="jp-mw-add-files" disabled={busy || !folder || !!folderProblem} onClick={() => fileInput.current?.click()}>
            Add Downloaded Files…
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            id="jp-mw-add-files-input"
            onChange={(event) => {
              const chosen = Array.from(event.target.files || []);
              event.target.value = '';
              void addFiles(chosen);
            }}
          />
        </div>
      )}

      {progress && (
        <div className="jp-upload__progress">
          <ProgressBar value={progress.total ? progress.received / progress.total : 0} max={1} label={`Downloading ${progress.label}`} />
          <span className="jp-upload__sent">
            {progress.label}: {formatBytes(progress.received)}
            {progress.total ? ` of ${formatBytes(progress.total)}` : ''}
          </span>
        </div>
      )}
      <p className="jp-upload__summary" role="status" id="jp-mw-download-summary">
        {summary}
      </p>
    </Modal>
  );
}
