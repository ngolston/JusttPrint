import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, FolderInput, Loader2, Wand2 } from 'lucide-react';
import { callAction } from '../api';
import { Button } from '../components/Button';
import { pickFolder } from '../components/FolderPicker';
import { ModalDialog } from '../components/ModalDialog';
import { useCan } from '../session';
import { exposeGlobal, showMessage } from '../page';
import {
  dismissOrganizeRun,
  organizeStructure,
  runOrganize,
  hideUnorganized,
  organizeText,
  organizeUploads,
  reloadUploadFolder,
  showUnorganized,
  showsUnorganized,
  stopOrganizing,
  useOrganizeRun,
  useUploadFolder,
  type OrganizeOptions,
  type UploadFolderInfo
} from './inbox';

declare global {
  interface Window {
    /** Settings → Scanning → Organize. */
    openOrganizeSettings?: () => void;
    /** Organize (the old menu's Organize Library). */
    openOrganizeLibrary?: () => void;
  }
}

/** How long "Organize Uploads finished" stays. */
const SHOW_MS = 20_000;

/** The notice for Organize Uploads, on every page: how far it is, then how it ended. */
export function OrganizeToast() {
  const run = useOrganizeRun();
  // The old menu's Organize Library runs Organize.
  useEffect(() => exposeGlobal('openOrganizeLibrary', () => void runOrganize()), []);
  const canEdit = useCan('editor');
  const finished = !!run && !run.running;

  useEffect(() => {
    if (!finished) return undefined;
    const timer = window.setTimeout(dismissOrganizeRun, SHOW_MS);
    return () => window.clearTimeout(timer);
  }, [finished, run?.id]);

  if (!run || !canEdit) return null;
  return (
    <div className="jp-undo-toast-region jp-organize-toast-region" role="status" aria-live="polite">
      <div className="jp-undo-toast jp-scan-toast" id="jp-organize-toast" data-state={run.running ? 'running' : 'done'}>
        {run.running ? (
          <Loader2 className="jp-spin" size={16} aria-hidden="true" />
        ) : (
          <CheckCircle2 className="jp-scan-toast__done" size={16} aria-hidden="true" />
        )}
        <span className="jp-undo-toast__text">{organizeText(run)}</span>
        {run.running ? (
          !run.stopping && (
            <button type="button" className="jp-undo-toast__button" onClick={() => void stopOrganizing()}>
              Stop
            </button>
          )
        ) : (
          <button type="button" className="jp-undo-toast__close" aria-label="Dismiss" onClick={dismissOrganizeRun}>
            ×
          </button>
        )}
      </div>
    </div>
  );
}

/** The library's Not organized filter: the models waiting in the Upload folder. */
export function UnorganizedButton({ directory }: { directory: string }) {
  const info = useUploadFolder();
  const canEdit = useCan('editor');
  const showing = showsUnorganized(directory, info);
  if (!canEdit || !info?.uploadFolder || (!info.waiting && !showing)) return null;
  return (
    <button
      type="button"
      id="jp-unorganized-button"
      className={`jp-btn jp-btn--${showing ? 'primary' : 'secondary'} jp-btn--md`}
      aria-pressed={showing}
      title={showing ? 'Show the whole library' : 'Show the models waiting in the Upload folder'}
      onClick={() => (showing ? hideUnorganized() : showUnorganized())}
    >
      <FolderInput size={16} aria-hidden="true" />
      <span>Not organized</span>
      {info.waiting > 0 && (
        <span className="jp-library-header__filter-count" aria-label={`${info.waiting} models`}>
          {info.waiting.toLocaleString()}
        </span>
      )}
    </button>
  );
}

/** Under the library's header while it shows the Upload folder: what Organize does, and the button. */
export function OrganizeNotice({ directory }: { directory: string }) {
  const info = useUploadFolder();
  const run = useOrganizeRun();
  const canEdit = useCan('editor');
  if (!canEdit || !info || !showsUnorganized(directory, info)) return null;
  const busy = !!run?.running;
  return (
    <div className="jp-upload-organize" id="jp-organize-uploads" role="region" aria-label="Organize">
      <p className="jp-upload-organize__text">
        {info.waiting
          ? `${info.waiting.toLocaleString()} ${info.waiting === 1 ? 'model is' : 'models are'} waiting in the Upload folder. `
          : 'Nothing is waiting in the Upload folder. '}
        Organize gives each folder (or model file) its category and moves it to <code>{organizeStructure(info)}</code>, its files named after its Title
        (Settings → Scanning → Organize).
      </p>
      <Button
        variant="primary"
        icon={busy ? Loader2 : Wand2}
        id="jp-organize-button"
        disabled={busy || !info.waiting || !info.destination}
        title={info.destination ? undefined : 'Choose a destination in Settings → Scanning → Organize'}
        onClick={() => void organizeUploads()}
      >
        {busy ? 'Organizing…' : 'Organize'}
      </Button>
    </div>
  );
}

/**
 * Settings → Scanning → Organize: the scanned directory (the Upload folder, where uploads wait as
 * "Not organized"), the destination (empty: the first STL Home folder), the folder levels above
 * each model's own folder (named after its Title), and Organize's steps. Organize in the sidebar
 * runs with them. Registers window.openOrganizeSettings.
 */
export function OrganizeSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [upload, setUpload] = useState('');
  const [destination, setDestination] = useState('');
  const [fallback, setFallback] = useState('');
  const [uploadFallback, setUploadFallback] = useState('');
  /** Folders set by Docker (JUSTTPRINT_UPLOAD_FOLDER / JUSTTPRINT_ORGANIZE_DESTINATION): applied on every start, so not changed here. */
  const [fromEnv, setFromEnv] = useState({ uploadFolder: false, destination: false });
  const [options, setOptions] = useState<OrganizeOptions>({ layers: ['category', 'subcategory'], tidy: true, tags: true, autoApply: true });
  const [choices, setChoices] = useState<{ id: string; label: string }[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(
    () =>
      exposeGlobal('openOrganizeSettings', () => {
        void callAction<UploadFolderInfo>('get-upload-folder')
          .then((info) => {
            const chosenUpload = info.chosenUploadFolder ?? info.uploadFolder;
            setUpload(chosenUpload);
            setUploadFallback(chosenUpload ? '' : info.uploadFolder);
            setDestination(info.chosenDestination);
            setFallback(info.chosenDestination ? '' : info.destination);
            setFromEnv(info.fromEnv || { uploadFolder: false, destination: false });
            setOptions(info.options);
            setChoices(info.layerChoices);
          })
          .catch(() => {})
          .finally(() => {
            if (!dialogRef.current?.open) dialogRef.current?.showModal();
          });
      }),
    []
  );

  async function choose(current: string, title: string, apply: (dir: string) => void) {
    const picked = await pickFolder({ title, initial: current || undefined, confirmLabel: 'Choose' });
    if (picked) apply(picked);
  }

  const update = (change: Partial<OrganizeOptions>) => setOptions((previous) => ({ ...previous, ...change }));
  const setLayer = (index: number, id: string) => update({ layers: options.layers.map((layer, i) => (i === index ? id : layer)) });
  const moveLayer = (index: number, by: number) => {
    const next = [...options.layers];
    const [layer] = next.splice(index, 1);
    next.splice(index + by, 0, layer);
    update({ layers: next });
  };
  const unused = choices.filter((choice) => !options.layers.includes(choice.id));
  const label = (id: string) => choices.find((choice) => choice.id === id)?.label || id;

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await callAction('save-upload-folder', upload.trim(), destination.trim(), options);
      await reloadUploadFolder();
      dialogRef.current?.close();
    } catch (error) {
      await showMessage('Organize', error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  const step = (key: 'tidy' | 'tags' | 'autoApply', id: string, title: string, description: string, disabled = false) => (
    <>
      <div className="form-group checkbox-container">
        <input type="checkbox" id={id} checked={options[key]} disabled={disabled} onChange={(event) => update({ [key]: event.target.checked })} />
        <label htmlFor={id}>{title}</label>
      </div>
      <p className="setting-description">{description}</p>
    </>
  );

  return (
    <ModalDialog
      id="organize-settings-dialog"
      title="Organize"
      dialogRef={dialogRef}
      description={
        <p className="setting-description">
          <strong>Organize</strong> in the sidebar (and in the library&apos;s <strong>Not organized</strong> view and on Home) puts every folder or model file
          in the scanned directory where it belongs:{' '}
          <code>{[destination || fallback || 'Destination', ...options.layers.map(label), 'Title', 'file'].join('/')}</code>.
        </p>
      }
      footer={
        <>
          <button type="button" id="save-organize-settings" className="is-primary" disabled={saving} onClick={() => void save()}>
            Save
          </button>
          <button type="button" id="cancel-organize-settings" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
        </>
      }
    >
      <div className="settings-group">
        <div className="form-group">
          <label htmlFor="upload-folder-path">Scanned directory (the Upload folder)</label>
          <div className="jp-folder-field">
            <input
              type="text"
              id="upload-folder-path"
              value={upload}
              placeholder={uploadFallback ? `Default: ${uploadFallback}` : '/upload'}
              readOnly={fromEnv.uploadFolder}
              onChange={(event) => setUpload(event.target.value)}
            />
            {!fromEnv.uploadFolder && (
              <button type="button" id="choose-upload-folder" onClick={() => void choose(upload, 'Scanned Directory', setUpload)}>
                Choose…
              </button>
            )}
          </div>
        </div>
        <p className="setting-description">
          {fromEnv.uploadFolder ? 'Set by Docker (JUSTTPRINT_UPLOAD_FOLDER). ' : ''}Every upload and every download from a model link goes here, and shows in
          the library as Not organized. Made when it does not exist yet. Empty: an Uploads folder inside the first STL Home folder.
        </p>
        <div className="form-group">
          <label htmlFor="organize-destination-path">Destination directory</label>
          <div className="jp-folder-field">
            <input
              type="text"
              id="organize-destination-path"
              value={destination}
              placeholder={fallback ? `${fallback} (the first STL Home folder)` : 'The first STL Home folder'}
              readOnly={fromEnv.destination}
              onChange={(event) => setDestination(event.target.value)}
            />
            {!fromEnv.destination && (
              <button type="button" id="choose-organize-destination" onClick={() => void choose(destination || fallback, 'Destination', setDestination)}>
                Choose…
              </button>
            )}
          </div>
        </div>
        {fromEnv.destination && <p className="setting-description">Set by Docker (JUSTTPRINT_ORGANIZE_DESTINATION).</p>}
      </div>
      <div className="settings-group">
        <h4>Folder structure</h4>
        <ol className="jp-organize-layers" id="organize-layers">
          {options.layers.map((layer, index) => (
            <li key={layer} className="jp-organize-layers__row">
              <select aria-label={`Folder level ${index + 1}`} value={layer} onChange={(event) => setLayer(index, event.target.value)}>
                {[layer, ...unused.map((choice) => choice.id)].map((id) => (
                  <option key={id} value={id}>
                    {label(id)}
                  </option>
                ))}
              </select>
              <button type="button" disabled={index === 0} onClick={() => moveLayer(index, -1)}>
                Up
              </button>
              <button type="button" disabled={index === options.layers.length - 1} onClick={() => moveLayer(index, 1)}>
                Down
              </button>
              <button type="button" onClick={() => update({ layers: options.layers.filter((_, i) => i !== index) })}>
                Remove
              </button>
            </li>
          ))}
          <li className="jp-organize-layers__row jp-organize-layers__fixed">Title / file</li>
        </ol>
        {unused.length > 0 && options.layers.length < 4 && (
          <button type="button" id="organize-add-layer" onClick={() => update({ layers: [...options.layers, unused[0].id] })}>
            Add folder level
          </button>
        )}
        <p className="setting-description">
          Each model gets a folder named after its Title (else its file&apos;s name), and its files are named after the Title too (
          <code>Articulated Dragon.3mf</code>; <code>(2)</code> when two share it). Without a Category: Uncategorized/Other, after trying its site, the AI and
          the words in its names.
        </p>
      </div>
      <div className="settings-group">
        <h4>Steps</h4>
        {step(
          'tidy',
          'organize-tidy',
          'Tidy into model folders',
          "Each model's loose pictures, videos and documents go into its image, video and document folders."
        )}
        {step('tags', 'organize-tags', 'Generate tags', 'The AI service (Settings → AI) suggests tags for every model it moved.')}
        {step(
          'autoApply',
          'organize-auto-apply',
          'Apply the suggested tags',
          'On: added at once (with AI Tagged). Off: they open for your review, as Generate Tags does.',
          !options.tags
        )}
      </div>
    </ModalDialog>
  );
}
