import { useEffect, useRef, useState, type ReactNode } from 'react';
import { organize, settings, type OrganizeJob, type OrganizePreview, type OrganizeResult } from '../api';
import { pickFolder } from '../components/FolderPicker';
import { exposeGlobal, showMessage } from '../page';
import { navigate } from '../shell/routes';

declare global {
  interface Window {
    openOrganizeLibrary?: () => void;
  }
}

const FIELDS = [
  { id: 'designer', label: 'Designer' },
  { id: 'parentModel', label: 'Parent Model' },
  { id: 'license', label: 'License' },
  { id: 'source', label: 'Source' },
  { id: 'printStatus', label: 'Print Status' }
];
const MAX_LAYERS = 4;
const LAYERS_SETTING = 'organizeLibraryLayers';

const fieldLabel = (id: string) => FIELDS.find((field) => field.id === id)?.label ?? id;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function formatBytes(value: unknown): string {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = size;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const folderKey = (value: string) => value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const isAbsolute = (value: string) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');

export function folderIsInside(child: string, parent: string): boolean {
  const left = folderKey(child);
  const right = folderKey(parent);
  return !!left && !!right && (left === right || left.startsWith(`${right}/`));
}

/** The scanned root plus a folder inside it (relative, or an absolute path). */
export function resolveSource(root: string, sub: string): string {
  const base = root.trim();
  const extra = sub.trim();
  if (!base) return '';
  if (!extra) return base;
  if (isAbsolute(extra)) return extra;
  const sep = base.includes('\\') ? '\\' : '/';
  const parts = base.split(/[\\/]+/).filter(Boolean);
  for (const part of extra.split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  if (/^[A-Za-z]:/.test(base)) return parts.join(sep);
  if (base.startsWith('\\\\')) return `\\\\${parts.join(sep)}`;
  if (base.startsWith('/')) return `/${parts.join(sep)}`;
  return parts.join(sep);
}

function parseLayers(raw: string | null): string[] | null {
  if (raw == null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return [...new Set(parsed.filter((id) => FIELDS.some((field) => field.id === id)))].slice(0, MAX_LAYERS);
  } catch {
    return null;
  }
}

function summaryLines(preview: OrganizePreview): string[] {
  const copy = Number(preview.copyCount) || 0;
  const resume = Number(preview.resumeCount) || 0;
  const lines: string[] = [];
  if (preview.destWillBeCreated) lines.push('The destination folder will be created.');
  if (copy + resume) {
    lines.push(`${plural(copy, 'file')} will be copied (${formatBytes(preview.copyBytes)}).`);
    if (resume) lines.push(`${plural(resume, 'matching file')} already at the destination will be finished and the original removed.`);
    if (preview.zipCount) {
      lines.push(`${preview.zipCount} of those ${preview.zipCount === 1 ? 'is a zip file' : 'are zip files'} (${preview.zipEntryCount} models inside, not extracted).`);
    }
  } else if (preview.ok) {
    lines.push('Nothing in that folder needs to be moved.');
  }
  if (preview.emptyLayers?.length) {
    for (const layer of preview.emptyLayers) {
      lines.push(`${plural(layer.count, 'file')} have no ${String(layer.label || 'value').toLowerCase()} and will go in "${layer.folder}".`);
    }
  } else if (preview.noParentCount) {
    lines.push(`${plural(preview.noParentCount, 'file')} have no parent model and will go in "No Parent Model".`);
  }
  return lines;
}

function resultMessage(result: OrganizeResult | null): string {
  if (!result) return 'Organize failed.';
  if (result.error && !result.moved) return result.error;
  const lines = [`Moved ${plural(result.moved || 0, 'file')}.`, `Skipped ${result.skipped || 0}.`];
  if (result.failedCount) {
    lines.push(`${result.failedCount} failed. Those originals were left in place.`);
    for (const item of (result.failed || []).slice(0, 5)) lines.push(`${item.from || 'File'}: ${item.error}`);
  }
  if (result.warningCount) lines.push(`${result.warningCount} copied, but the original could not be removed.`);
  if (result.zipModels) lines.push(`${result.zipModels} models stay inside the moved zip files.`);
  return lines.join('\n');
}

/** A button that opens a searchable list of the scanned folders. */
function SourcePicker({ sources, value, onChange }: { sources: string[]; value: string; onChange: (dir: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const matches = sources.filter((dir) => !query || folderKey(dir).includes(folderKey(query)));

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('click', closeOutside);
    return () => document.removeEventListener('click', closeOutside);
  }, [open]);

  function choose(dir: string) {
    onChange(dir);
    setOpen(false);
  }

  return (
    <div className="organize-source-picker" ref={pickerRef}>
      <button type="button" id="organize-source-button" ref={buttonRef} className="organize-source-button" aria-haspopup="listbox"
        aria-expanded={open} aria-controls="organize-source-menu" disabled={!sources.length}
        onClick={() => { setQuery(''); setOpen(!open); }}>
        <span id="organize-source-label">{value || 'No scanned directories yet'}</span>
      </button>
      {open && (
        <div id="organize-source-menu" className="organize-source-menu">
          <input type="text" id="organize-source-search" className="organize-source-search" placeholder="Search folders" autoComplete="off"
            spellCheck={false} aria-label="Search scanned directories" autoFocus value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                buttonRef.current?.focus();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (matches[0]) choose(matches[0]);
              }
            }} />
          <div id="organize-source-options" className="organize-source-options" role="listbox">
            {matches.map((dir) => (
              <button key={dir} type="button" role="option" title={dir} data-path={dir} aria-selected={dir === value} onClick={() => choose(dir)}>{dir}</button>
            ))}
          </div>
          {matches.length === 0 && <p id="organize-source-empty" className="organize-source-empty">No matching folders</p>}
        </div>
      )}
    </div>
  );
}

type PreviewState =
  | { kind: 'none' }
  | { kind: 'stale' }
  | { kind: 'preview'; preview: OrganizePreview }
  | { kind: 'done'; ok: boolean; message: string };

/**
 * Settings → Organize Library: copy the models in a scanned folder into a new folder structure
 * (Designer / Parent Model / ...), removing each original once its copy is checked. Preview
 * first; any change asks for a new preview. Registers window.openOrganizeLibrary.
 */
/**
 * Organize Library: copy models from a scanned folder into a folder structure, removing each
 * original after its copy is checked. Mounted while the #/organize page is shown. `actions`
 * places the Preview and Copy buttons.
 */
function OrganizeLibrary({ actions }: { actions: (buttons: ReactNode) => ReactNode }) {
  const [sources, setSources] = useState<string[]>([]);
  const [root, setRoot] = useState('');
  const [sub, setSub] = useState('');
  const [dest, setDest] = useState('');
  const [layers, setLayers] = useState<string[]>(['parentModel']);
  const [zipEnabled, setZipEnabled] = useState(false);
  const [includeZips, setIncludeZips] = useState(false);
  const [state, setState] = useState<PreviewState>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const runToken = useRef(0);

  // Shown: read the saved layers and the scanned folders.
  useEffect(() => {
    let live = true;
    (async () => {
      const [stored, zip, list] = await Promise.all([
        settings.get<string | null>(LAYERS_SETTING).catch(() => null),
        settings.get<string | null>('enableZipArchives').catch(() => null),
        organize.sources().catch(() => [])
      ]);
      if (!live) return;
      const saved = parseLayers(stored);
      if (saved) setLayers(saved);
      setZipEnabled(zip === '1');
      if (zip !== '1') setIncludeZips(false);
      const dirs = (Array.isArray(list) ? list : []).map((item) => String(item?.path || '')).filter(Boolean);
      setSources(dirs);
      setRoot((previous) => dirs.find((dir) => folderKey(dir) === folderKey(previous)) ?? dirs[0] ?? '');
      setState((previous) => (previous.kind === 'none' ? previous : { kind: 'stale' }));
    })();
    return () => { live = false; };
  }, []);

  /** Any change to the job: the shown preview no longer applies. */
  function changed() {
    runToken.current += 1;
    setState((previous) => (previous.kind === 'none' ? previous : { kind: 'stale' }));
  }

  function updateLayers(next: string[]) {
    setLayers(next);
    settings.save(LAYERS_SETTING, JSON.stringify(next)).catch(() => {});
    changed();
  }

  function moveLayer(index: number, by: number) {
    const next = layers.slice();
    [next[index], next[index + by]] = [next[index + by], next[index]];
    updateLayers(next);
  }

  function chooseRoot(dir: string) {
    setRoot(dir);
    if (sub.trim() && !folderIsInside(resolveSource(dir, sub), dir)) setSub('');
    changed();
  }

  const job = (): OrganizeJob => ({ sourceDir: resolveSource(root, sub), destDir: dest.trim(), includeZips: zipEnabled && includeZips, layers: layers.slice() });

  async function runPreview() {
    const token = ++runToken.current;
    setBusy(true);
    try {
      const preview = await organize.preview(job());
      if (token === runToken.current) setState({ kind: 'preview', preview: preview || { ok: false, error: 'Could not preview the organize job.' } });
    } catch (error) {
      if (token === runToken.current) {
        setState({ kind: 'preview', preview: { ok: false, error: error instanceof Error ? error.message : 'Could not preview the organize job.' } });
      }
    } finally {
      setBusy(false);
    }
  }

  async function runOrganize() {
    setBusy(true);
    let message: string;
    let ok = false;
    try {
      const result = await organize.run(job());
      ok = !!result?.ok;
      message = resultMessage(result);
    } catch (error) {
      message = error instanceof Error ? error.message : 'Organize failed.';
    }
    runToken.current += 1;
    setState({ kind: 'done', ok, message });
    setBusy(false);
    if (ok) await window.performCombinedSearch?.();
    await showMessage('Organize Library', message);
  }

  const preview = state.kind === 'preview' ? state.preview : null;
  const moveCount = preview ? (Number(preview.copyCount) || 0) + (Number(preview.resumeCount) || 0) : 0;
  const canConfirm = !!preview?.ok && !!preview.enoughSpace && moveCount > 0 && !busy;
  const problems = preview ? [preview.error, preview.spaceError].filter(Boolean).join(' ') : '';
  const skipped = preview ? (() => {
    const counts = preview.reasonCounts || {};
    const parts = Object.keys(counts).map((reason) => `${counts[reason]} ${reason}`);
    if (!parts.length && preview.skippedCount) parts.push(`${preview.skippedCount} skipped`);
    return parts.join('. ');
  })() : '';

  return (
    <>
      <div className="form-group">
        <label htmlFor="organize-source-button">Scanned directory</label>
        <SourcePicker sources={sources} value={root} onChange={chooseRoot} />
      </div>
      <div className="form-group">
        <label htmlFor="organize-source-subfolder">Folder inside it</label>
        <div className="organize-path-row">
          <input type="text" id="organize-source-subfolder" placeholder="Entire scanned folder" autoComplete="off" spellCheck={false}
            value={sub} onChange={(event) => { setSub(event.target.value); changed(); }} />
          <button type="button" id="organize-source-subfolder-browse" disabled={!root} onClick={async () => {
            const typed = sub.trim();
            const start = !typed ? root : typed.startsWith('/') ? typed : `${root.replace(/\/+$/, '')}/${typed}`;
            const dir = await pickFolder({ title: 'Folder to Organize', initial: start });
            if (dir) { setSub(dir); changed(); }
          }}>Browse…</button>
        </div>
        <p className="setting-description">Leave this blank to use the whole scanned folder, or type a folder inside it (relative to it, or a full path).</p>
      </div>
      <div className="form-group">
        <label htmlFor="organize-dest-input">Destination directory</label>
        <div className="organize-path-row">
          <input type="text" id="organize-dest-input" placeholder="New library root, a path in the JusttPrint backend's container" autoComplete="off" spellCheck={false}
            value={dest} onChange={(event) => { setDest(event.target.value); changed(); }} />
          <button type="button" id="organize-dest-browse" onClick={async () => {
            const dir = await pickFolder({ title: 'Destination Directory', initial: dest.trim() || root || undefined });
            if (dir) { setDest(dir); changed(); }
          }}>Browse…</button>
        </div>
      </div>
      <div className="organize-structure">
        <span className="organize-structure-label">Folder structure</span>
        <div id="organize-structure-rows">
          {layers.map((current, index) => (
            <div key={current} className="organize-structure-row">
              <select aria-label={`Folder ${index + 1}`} value={current}
                onChange={(event) => updateLayers(layers.map((id, other) => (other === index ? event.target.value : id)))}>
                {FIELDS.filter((field) => field.id === current || !layers.includes(field.id)).map((field) => (
                  <option key={field.id} value={field.id}>{field.label}</option>
                ))}
              </select>
              <button type="button" disabled={index === 0} onClick={() => moveLayer(index, -1)}>Up</button>
              <button type="button" disabled={index === layers.length - 1} onClick={() => moveLayer(index, 1)}>Down</button>
              <button type="button" onClick={() => updateLayers(layers.filter((_, other) => other !== index))}>Remove</button>
            </div>
          ))}
        </div>
        <p id="organize-structure-preview" className="setting-description">
          Root / {layers.length ? `${layers.map(fieldLabel).join(' / ')} / ` : ''}file
        </p>
        <button type="button" id="organize-structure-add" disabled={layers.length >= MAX_LAYERS || FIELDS.every((field) => layers.includes(field.id))}
          onClick={() => {
            const next = FIELDS.find((field) => !layers.includes(field.id));
            if (next) updateLayers([...layers, next.id]);
          }}>Add folder</button>
      </div>
      {zipEnabled && (
        <div id="organize-include-zip" className="organize-include-zip">
          <label htmlFor="organize-include-zip-input">
            <input type="checkbox" id="organize-include-zip-input" checked={includeZips} onChange={(event) => { setIncludeZips(event.target.checked); changed(); }} />
            Include zip files
          </label>
          <p className="setting-description">Moves each zip archive into the library. Files inside the zip stay packed.</p>
        </div>
      )}
      {state.kind !== 'none' && (
        <div id="organize-preview" className="organize-preview">
          {state.kind === 'stale' && <p id="organize-preview-summary">Choices changed. Preview again before copying.</p>}
          {state.kind === 'done' && (state.ok
            ? <p id="organize-preview-summary" className="organize-result">{state.message}</p>
            : <p id="organize-preview-error" className="organize-preview-error organize-result">{state.message}</p>)}
          {preview && (
            <>
              <p id="organize-preview-summary">{summaryLines(preview).join(' ')}</p>
              <p id="organize-preview-space">
                {[preview.freeBytes != null ? `Free space: ${formatBytes(preview.freeBytes)}.` : '',
                  (Number(preview.copyBytes) || 0) > 0 ? `Required: ${formatBytes(preview.copyBytes)} plus ${formatBytes(preview.marginBytes)}.` : '']
                  .filter(Boolean).join(' ')}
              </p>
              <ul id="organize-preview-list">
                {(preview.sample || []).map((move) => (
                  <li key={`${move.from}→${move.to}`}>{move.from} → {move.to}{move.zipEntryCount ? ` (${move.zipEntryCount} models inside)` : ''}</li>
                ))}
                {moveCount > (preview.sample || []).length && <li>…</li>}
              </ul>
              {skipped && <p id="organize-preview-skipped">Skipped: {skipped}.</p>}
              {problems && <p id="organize-preview-error" className="organize-preview-error">{problems}</p>}
            </>
          )}
        </div>
      )}
      {actions(
        <>
          <button type="button" id="organize-preview-button" className="jp-btn jp-btn--secondary jp-btn--md" disabled={busy} onClick={runPreview}>Preview</button>
          <button type="button" id="organize-confirm-button" className="jp-btn jp-btn--primary jp-btn--md" disabled={!canConfirm} onClick={runOrganize}>Copy and remove originals</button>
        </>
      )}
    </>
  );
}

const INTRO = 'Copy models from a scanned folder into the folders you choose. Each original is removed only after its copy is checked. Files that are not in the library stay where they are.';

/** Organize Library as a page of the JusttPrint 5 shell (#/organize). */
export function OrganizePage() {
  return (
    <div className="jp-page__inner jp-organize" id="organize-library-page">
      <header className="jp-page__header">
        <h1 className="jp-page-title">Organize Library</h1>
        <p className="jp-meta">{INTRO}</p>
      </header>
      <div className="jp-card jp-organize__card">
        <OrganizeLibrary actions={(buttons) => <div className="jp-organize__actions">{buttons}</div>} />
      </div>
    </div>
  );
}

/** window.openOrganizeLibrary (Settings, the old menu actions): the Organize Library page. */
export function OrganizeLibraryOpener() {
  useEffect(() => exposeGlobal('openOrganizeLibrary', () => navigate('organize')), []);
  return null;
}
