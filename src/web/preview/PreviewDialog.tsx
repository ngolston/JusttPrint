import { useEffect, useRef, useState, type ReactNode } from 'react';
import { exposeGlobal, onServerEvent, showMessage } from '../page';
import { loadSlicers, offerSlicerSettings, sendToSlicer, type Slicer } from '../slicer';
import type { ImageOnlyPreview, PreviewEngine, PreviewPart } from './engine';
import {
  BACKDROP_LABELS,
  applyOptionsFor,
  exportBasename,
  friendlyPreviewError,
  isPreviewableExtension,
  isPreviewablePath,
  loadStudioSettings,
  previewExtension,
  saveStudioSettings,
  type Backdrop,
  type CameraView,
  type Finish,
  type StudioSettings
} from './studio';

/** A bundle as the grid groups it (ZIP or folder). */
interface BundleRecord {
  groupLabel?: string | null;
  children?: { filePath?: string; fileName?: string | null; bundleKind?: string | null }[];
}

interface PreviewBridge {
  cancel3MFPreview?: (requestId: string) => void;
}

declare global {
  interface Window {
    openPreview?: (filePath: string) => Promise<void>;
    openBundlePreview?: (record: BundleRecord) => Promise<void>;
  }
}

const bridge = () => window.electron as (PreviewBridge & typeof window.electron) | undefined;
const MAX_BUNDLE_PARTS = 32;

type Loading = { text: string } | { error: string; title: string } | null;

const FINISH_CHIPS: [Finish, string][] = [
  ['original', 'Original'],
  ['matte', 'Matte'],
  ['gloss', 'Gloss'],
  ['metal', 'Metal'],
  ['chrome', 'Chrome']
];
const VIEW_CHIPS: [CameraView, string][] = [
  ['iso', 'ISO'],
  ['front', 'Front'],
  ['back', 'Back'],
  ['left', 'Left'],
  ['right', 'Right'],
  ['top', 'Top'],
  ['fit', 'Fit']
];
const BACKDROPS = Object.keys(BACKDROP_LABELS) as Backdrop[];

function Chips<T extends string>({
  id,
  label,
  value,
  items,
  attr,
  onPick
}: {
  id: string;
  label: string;
  value: T;
  items: [T, string][];
  attr: string;
  onPick: (value: T) => void;
}) {
  return (
    <div id={id} className="preview-view-chips" role="radiogroup" aria-label={label}>
      {items.map(([key, text]) => (
        <button
          key={key}
          type="button"
          role="radio"
          {...{ [`data-${attr}`]: key }}
          className={key === value ? 'active' : undefined}
          aria-checked={key === value}
          onClick={() => onPick(key)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
  wrapId,
  hidden
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  wrapId?: string;
  hidden?: boolean;
}) {
  return (
    <label className="preview-studio-slider" id={wrapId} hidden={hidden}>
      <span>{label}</span>
      <input type="range" id={id} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Check({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="preview-studio-check">
      <input type="checkbox" id={id} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

const ICON_PROPS = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
};

/**
 * The 3D preview (#preview-dialog): one model or a ZIP/folder bundle, with the Studio panel,
 * part focus, Send to Slicer and Save Image. The scene itself is PreviewEngine (engine.ts),
 * loaded when a preview first opens. Registers window.openPreview and window.openBundlePreview
 * and answers the server's 'preview-model' and 'preview-bundle-models' events.
 */
export function PreviewDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const tokenRef = useRef(0);
  const request3mf = useRef<string | null>(null);
  const [title, setTitle] = useState('Model Preview');
  const [loading, setLoading] = useState<Loading>({ text: 'Loading model...' });
  const [fileType, setFileType] = useState('');
  const [dimensions, setDimensions] = useState('');
  const [note, setNote] = useState('');
  const [imageOnly, setImageOnly] = useState<ImageOnlyPreview | null>(null);
  const [settings, setSettings] = useState<StudioSettings>(() => loadStudioSettings());
  const [view, setView] = useState<CameraView>('iso');
  const [parts, setParts] = useState<PreviewPart[]>([]);
  const [focus, setFocus] = useState('all');
  const [sitOnFace, setSitOnFace] = useState(false);
  const [slicerPaths, setSlicerPaths] = useState<string[]>([]);
  const [slicerMenu, setSlicerMenu] = useState<Slicer[] | null>(null);
  const [saveMenu, setSaveMenu] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const studioAvailable = !imageOnly;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  function updateSetting<K extends keyof StudioSettings>(key: K, value: StudioSettings[K]) {
    const next = { ...settingsRef.current, [key]: value };
    setSettings(next);
    saveStudioSettings(next);
    const options = applyOptionsFor(key);
    if (options) engineRef.current?.setSettings(next, options);
  }

  /** Close the old scene, open the dialog and make a new scene. Returns this preview's token. */
  async function begin(name: string, paths: string[]): Promise<number> {
    const token = ++tokenRef.current;
    if (request3mf.current) bridge()?.cancel3MFPreview?.(request3mf.current);
    request3mf.current = null;
    engineRef.current?.dispose();
    engineRef.current = null;
    setTitle(name);
    setLoading({ text: 'Loading model...' });
    setFileType('');
    setDimensions('');
    setNote('');
    setImageOnly(null);
    setParts([]);
    setFocus('all');
    setSitOnFace(false);
    setView('iso');
    setSlicerMenu(null);
    setSaveMenu(false);
    setSlicerPaths(paths);
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    // Let the dialog lay out before sizing the canvas.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { PreviewEngine } = await import('./engine');
    if (token !== tokenRef.current || !canvasRef.current || !containerRef.current) return token;
    engineRef.current = new PreviewEngine(canvasRef.current, containerRef.current, settingsRef.current, {
      dimensions: setDimensions,
      parts: (list, current) => {
        setParts(list);
        setFocus(current);
      },
      sitOnFace: setSitOnFace
    });
    return token;
  }

  const context = (token: number) => ({
    isCurrent: () => token === tokenRef.current,
    status: (text: string) => {
      if (token === tokenRef.current) setLoading({ text });
    },
    set3mfRequest: (id: string | null) => {
      request3mf.current = id;
    }
  });

  function showError(token: number, error: unknown, heading = 'Error loading model') {
    if (token !== tokenRef.current) return;
    const message = (error as Error)?.message || '';
    if (message.includes('Preview cancelled')) return;
    console.error('Error loading preview model:', error);
    setLoading({ title: heading, error: friendlyPreviewError(error) });
  }

  async function openPreview(filePath: string) {
    // An online model (added from a link) has no file to draw.
    if (filePath.startsWith('url::')) {
      await showMessage(
        'No 3D Preview',
        'This is an online model: JusttPrint has a link to it, not its files. Download the files to see it in 3D (for MakerWorld models: Download to Library… in the MakerWorld section of its details).'
      );
      return;
    }
    const token = await begin(filePath.split(/[/\\]/).pop() || filePath, [filePath]);
    if (token !== tokenRef.current) return;
    const ext = previewExtension(filePath);
    setFileType(`Type: ${ext.toUpperCase()}`);
    try {
      if (!isPreviewableExtension(ext)) {
        throw new Error('Preview not available for this file type. Only STL, 3MF, OBJ, PLY, STEP, IGES, and LYS models can be previewed in 3D.');
      }
      const { loadPreviewObject } = await import('./engine');
      const loaded = await loadPreviewObject(filePath, context(token));
      if (token !== tokenRef.current) return;
      if ('imageOnly' in loaded) {
        setImageOnly(loaded);
        setSitOnFace(false);
        setDimensions(`${loaded.label} embedded preview`);
      } else {
        engineRef.current?.showModel(loaded.object);
        setNote(loaded.note || '');
      }
      setLoading(null);
    } catch (error) {
      showError(token, error);
    }
  }

  async function openBundlePreview(record: BundleRecord) {
    const previewable = (record?.children || []).filter((child) => child?.filePath && isPreviewablePath(child.filePath));
    if (!previewable.length) {
      await showMessage('Preview', 'No STL or 3MF models in this bundle to preview.');
      return;
    }
    const sorted = [...previewable].sort((a, b) => String(a.fileName || '').localeCompare(String(b.fileName || ''), undefined, { sensitivity: 'base' }));
    const toLoad = sorted.slice(0, MAX_BUNDLE_PARTS);
    const paths = previewable.map((child) => child.filePath!).filter((p) => !p.startsWith('url::'));
    const token = await begin(record.groupLabel || 'Bundle', paths);
    if (token !== tokenRef.current) return;
    const { loadPreviewObject, arrangeBundle } = await import('./engine');
    const objects: { object: import('three').Object3D; name: string }[] = [];
    let failures = 0;
    for (let i = 0; i < toLoad.length; i++) {
      const child = toLoad[i];
      if (token !== tokenRef.current) return;
      setLoading({ text: `Loading bundle preview (${i + 1}/${toLoad.length})...\n${child.fileName || ''}` });
      try {
        const loaded = await loadPreviewObject(child.filePath!, context(token));
        if ('imageOnly' in loaded) failures++;
        else objects.push({ object: loaded.object, name: child.fileName || '' });
      } catch (error) {
        if ((error as Error)?.message?.includes('Preview cancelled')) return;
        console.warn('Bundle preview skipped:', child.filePath, error);
        failures++;
      }
    }
    if (token !== tokenRef.current) return;
    if (!objects.length) {
      setLoading({ title: 'Could not load bundle preview', error: 'No models in this bundle could be loaded for 3D preview.' });
      return;
    }
    engineRef.current?.showModel(arrangeBundle(objects));
    const kind = record.children?.[0]?.bundleKind === 'zip' ? 'ZIP' : 'Folder';
    setFileType(`${kind} bundle • ${objects.length} model${objects.length === 1 ? '' : 's'}`);
    const info: string[] = [];
    if (previewable.length > MAX_BUNDLE_PARTS) info.push(`Showing first ${MAX_BUNDLE_PARTS} of ${previewable.length} previewable models`);
    if (failures) info.push(`${failures} model${failures === 1 ? '' : 's'} failed to load`);
    setDimensions(info.join(' • '));
    setLoading(null);
  }

  function cleanup() {
    tokenRef.current++;
    if (request3mf.current) bridge()?.cancel3MFPreview?.(request3mf.current);
    request3mf.current = null;
    engineRef.current?.dispose();
    engineRef.current = null;
    setImageOnly(null);
    setParts([]);
    setSitOnFace(false);
    setSlicerMenu(null);
    setSaveMenu(false);
    setSlicerPaths([]);
  }

  const close = () => dialogRef.current?.close();

  useEffect(() => exposeGlobal('openPreview', openPreview));
  useEffect(() => exposeGlobal('openBundlePreview', openBundlePreview));
  useEffect(() => {
    const offs = [
      onServerEvent('preview-model', (filePath: string) => {
        if (filePath) window.openPreview?.(filePath);
      }),
      onServerEvent('preview-bundle-models', (payload: BundleRecord) => {
        window.openBundlePreview?.(payload || {});
      }),
      onServerEvent('3mf-preview-status', (requestId: string, message: string) => {
        if (requestId && requestId === request3mf.current && message) setLoading({ text: message });
      })
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // Clicks outside the slicer and save menus close them.
  useEffect(() => {
    if (!slicerMenu && !saveMenu) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element;
      if (!target.closest('#preview-slicer-menu, #preview-send-to-slicer')) setSlicerMenu(null);
      if (!target.closest('#preview-save-menu, #preview-save-image')) setSaveMenu(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [slicerMenu, saveMenu]);

  async function onSendToSlicer() {
    setSaveMenu(false);
    if (!slicerPaths.length) return;
    setSlicerMenu(null);
    const slicers = await loadSlicers();
    if (!slicers.length) {
      await offerSlicerSettings();
      return;
    }
    if (slicers.length === 1) await sendToSlicer(slicerPaths, slicers[0]);
    else setSlicerMenu(slicers);
  }

  async function saveImage(transparent: boolean) {
    setSaveMenu(false);
    const engine = engineRef.current;
    if (!engine || loading) {
      await showMessage('Save Image', 'Nothing to save yet. Wait for the model to finish loading.');
      return;
    }
    let dataUrl = '';
    try {
      dataUrl = engine.snapshot(transparent);
    } catch (error) {
      console.error('[Preview] Failed to export image:', error);
    }
    if (!dataUrl) {
      await showMessage('Save Image', 'Could not save the preview image.');
      return;
    }
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `${exportBasename(title)}${transparent ? '-preview-transparent.png' : '-preview.png'}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  const panelOpen = settings.panelOpen && studioAvailable;
  const slicerTitle = !slicerPaths.length
    ? 'No local model to send to slicer'
    : slicerPaths.length === 1
      ? 'Open this model in your slicer'
      : `Open ${slicerPaths.length} models in your slicer`;
  let hint: ReactNode = (
    <>
      <strong>Controls:</strong> Left click + drag to orbit • Right click + drag to pan • Scroll to zoom • Click a part to focus
    </>
  );
  if (imageOnly)
    hint = (
      <>
        <strong>Embedded preview:</strong> This file type includes a still image only — orbit, pan, and Studio are not available
      </>
    );
  else if (sitOnFace)
    hint = (
      <>
        <strong>Sit on face:</strong> Click a surface to set it flat on the floor • Esc or the button again to cancel
      </>
    );
  const fullLabel = fullscreen ? 'Exit Full Screen' : 'Full Screen';

  return (
    <dialog
      id="preview-dialog"
      className={`modal preview-modal${fullscreen ? ' modal-fullscreen' : ''}`}
      ref={dialogRef}
      onClose={cleanup}
      onCancel={(event) => {
        // Esc first leaves sit-on-face mode; the next Esc closes the preview.
        if (sitOnFace) {
          event.preventDefault();
          engineRef.current?.setSitOnFace(false);
        }
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) close();
      }}
    >
      <div className="preview-container">
        <div className="preview-header">
          <h3 id="preview-model-name">{title}</h3>
          <div className="preview-header-actions">
            <button
              type="button"
              id="preview-fullscreen-toggle"
              className="icon-button modal-fullscreen-icon-btn"
              title={fullLabel}
              aria-label={fullLabel}
              aria-pressed={fullscreen}
              onClick={() => setFullscreen(!fullscreen)}
            >
              <svg className="fullscreen-icon-expand" {...ICON_PROPS}>
                <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
              <svg className="fullscreen-icon-shrink" {...ICON_PROPS}>
                <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
              </svg>
            </button>
            <button type="button" id="close-preview" className="icon-button modal-fullscreen-icon-btn" title="Close" aria-label="Close" onClick={close}>
              <svg {...ICON_PROPS}>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div className="preview-content">
          <div className="preview-stage">
            <aside
              id="preview-studio-panel"
              className={`preview-studio-panel${panelOpen ? '' : ' hidden'}${settings.transparent ? ' is-transparent' : ''}`}
              aria-label="Preview studio"
            >
              <div className="preview-studio-header">
                <h4>Studio</h4>
                <button
                  type="button"
                  id="preview-studio-close"
                  className="preview-studio-close"
                  title="Hide studio"
                  onClick={() => updateSetting('panelOpen', false)}
                >
                  ×
                </button>
              </div>
              <section className="preview-studio-section">
                <h5>Appearance</h5>
                <label className="preview-studio-color">
                  <span>Model color</span>
                  <input
                    type="color"
                    id="preview-studio-color"
                    value={settings.color}
                    title="Model color"
                    onChange={(e) => updateSetting('color', e.target.value)}
                  />
                </label>
                <div className="preview-studio-select">
                  <span>Finish</span>
                  <Chips
                    id="preview-studio-finish"
                    label="Finish"
                    attr="finish"
                    value={settings.finish}
                    items={FINISH_CHIPS}
                    onPick={(v) => updateSetting('finish', v)}
                  />
                </div>
                <Slider
                  id="preview-studio-finish-intensity"
                  label="Finish intensity"
                  min={0}
                  max={100}
                  value={settings.finishIntensity}
                  onChange={(v) => updateSetting('finishIntensity', v)}
                />
                <Check id="preview-studio-wireframe" label="Wireframe" checked={settings.wireframe} onChange={(v) => updateSetting('wireframe', v)} />
                <Check id="preview-studio-edges" label="Edges" checked={settings.edges} onChange={(v) => updateSetting('edges', v)} />
                <Check id="preview-studio-autorotate" label="Auto rotate" checked={settings.autoRotate} onChange={(v) => updateSetting('autoRotate', v)} />
                <Slider
                  id="preview-studio-rotate-speed"
                  wrapId="preview-studio-rotate-speed-wrap"
                  hidden={!settings.autoRotate}
                  label="Rotate speed"
                  min={10}
                  max={250}
                  value={settings.rotateSpeed}
                  onChange={(v) => updateSetting('rotateSpeed', v)}
                />
              </section>
              <section className="preview-studio-section">
                <h5>Studio</h5>
                <div className="preview-studio-select">
                  <span>Background</span>
                  <Chips
                    id="preview-studio-bg"
                    label="Background"
                    attr="bg"
                    value={settings.background}
                    items={[
                      ['solid', 'Solid'],
                      ['gradient', 'Gradient']
                    ]}
                    onPick={(v) => updateSetting('background', v)}
                  />
                </div>
                <div className="preview-studio-select">
                  <span>Backdrop</span>
                  <Chips
                    id="preview-studio-backdrop"
                    label="Backdrop"
                    attr="backdrop"
                    value={settings.backdrop}
                    items={BACKDROPS.map((b) => [b, BACKDROP_LABELS[b]] as [Backdrop, string])}
                    onPick={(v) => updateSetting('backdrop', v)}
                  />
                </div>
                <label className="preview-studio-color">
                  <span>Custom backdrop</span>
                  <input type="color" id="preview-studio-custom-bg" value={settings.customBg} onChange={(e) => updateSetting('customBg', e.target.value)} />
                </label>
                <Slider
                  id="preview-studio-reflection"
                  label="Reflection"
                  min={0}
                  max={100}
                  value={settings.reflection}
                  onChange={(v) => updateSetting('reflection', v)}
                />
                <Slider
                  id="preview-studio-reflection-gap"
                  label="Reflection gap"
                  min={0}
                  max={20}
                  step={0.5}
                  value={settings.reflectionGap}
                  onChange={(v) => updateSetting('reflectionGap', v)}
                />
                <Slider
                  id="preview-studio-shadow"
                  label="Shadow strength"
                  min={0}
                  max={100}
                  value={settings.shadow}
                  onChange={(v) => updateSetting('shadow', v)}
                />
                <Slider
                  id="preview-studio-shadow-smooth"
                  label="Shadow smoothness"
                  min={0}
                  max={100}
                  value={settings.shadowSmooth}
                  onChange={(v) => updateSetting('shadowSmooth', v)}
                />
                <Slider
                  id="preview-studio-light-rot"
                  label="Light rotation"
                  min={0}
                  max={360}
                  value={settings.lightRot}
                  onChange={(v) => updateSetting('lightRot', v)}
                />
                <Slider
                  id="preview-studio-light-height"
                  label="Light height"
                  min={10}
                  max={85}
                  value={settings.lightHeight}
                  onChange={(v) => updateSetting('lightHeight', v)}
                />
                <Slider
                  id="preview-studio-light"
                  label="Light intensity"
                  min={0}
                  max={200}
                  value={settings.light}
                  onChange={(v) => updateSetting('light', v)}
                />
                <Check id="preview-studio-even" label="Even lighting" checked={settings.even} onChange={(v) => updateSetting('even', v)} />
                <Check id="preview-studio-grid" label="Grid" checked={settings.grid} onChange={(v) => updateSetting('grid', v)} />
                <Check
                  id="preview-studio-transparent"
                  label="Transparent PNG"
                  checked={settings.transparent}
                  onChange={(v) => updateSetting('transparent', v)}
                />
              </section>
              <section className="preview-studio-section">
                <h5>Placement</h5>
                <p className="preview-studio-hint">Click a surface on the model to sit that plane flat on the floor.</p>
                <div className="preview-studio-actions">
                  <button
                    type="button"
                    id="preview-studio-sit-face"
                    className={sitOnFace ? 'active' : undefined}
                    onClick={() => engineRef.current?.setSitOnFace(!sitOnFace)}
                  >
                    Sit on face
                  </button>
                  <button type="button" id="preview-studio-reset-pose" onClick={() => engineRef.current?.resetPose()}>
                    Reset pose
                  </button>
                </div>
              </section>
              <section className="preview-studio-section">
                <h5>Camera</h5>
                <div className="preview-studio-select">
                  <span>View</span>
                  <Chips
                    id="preview-camera-view"
                    label="Camera view"
                    attr="view"
                    value={view}
                    items={VIEW_CHIPS}
                    onPick={(v) => {
                      setView(v);
                      engineRef.current?.setCameraView(v);
                    }}
                  />
                </div>
                <Slider id="preview-studio-fov" label="Field of view" min={20} max={75} value={settings.fov} onChange={(v) => updateSetting('fov', v)} />
              </section>
            </aside>
            <div
              id="preview-canvas-container"
              ref={containerRef}
              className={[
                'preview-canvas-container',
                imageOnly && 'image-only-preview',
                sitOnFace && 'is-picking-face',
                settings.transparent && 'transparent-stage'
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div id="preview-loading" className="preview-loading" style={{ display: loading ? 'flex' : 'none' }}>
                {loading && 'error' in loading ? (
                  <div style={{ color: '#ff6b6b', textAlign: 'center', padding: 20, maxWidth: 500 }}>
                    <p style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>{loading.title}</p>
                    <p style={{ fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-line' }}>{loading.error}</p>
                    <button
                      type="button"
                      onClick={close}
                      style={{
                        marginTop: 20,
                        padding: '10px 20px',
                        background: 'rgba(255,255,255,0.1)',
                        border: '1px solid rgba(255,255,255,0.2)',
                        borderRadius: 8,
                        color: 'white',
                        cursor: 'pointer',
                        fontSize: 14
                      }}
                    >
                      Close
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="loader" />
                    <p>{loading?.text}</p>
                  </>
                )}
              </div>
              <canvas id="preview-canvas" ref={canvasRef} style={imageOnly ? { visibility: 'hidden' } : undefined} />
              {imageOnly && (
                <div id="preview-image-only" className="preview-image-only" role="img" aria-label={`${imageOnly.label || 'Embedded'} preview image`}>
                  <img src={imageOnly.dataUrl} alt={`${imageOnly.label || 'Embedded'} preview`} />
                </div>
              )}
            </div>
          </div>
          <div className="preview-controls">
            <div className="preview-control-group">
              <button
                type="button"
                id="preview-send-to-slicer"
                className="preview-control-button preview-slicer-button"
                title={slicerTitle}
                disabled={!slicerPaths.length}
                onClick={onSendToSlicer}
              >
                <span>🖨️</span> Send to Slicer
              </button>
              <button
                type="button"
                id="preview-reset-view"
                className="preview-control-button"
                title="Reset View"
                onClick={() => {
                  setView('iso');
                  engineRef.current?.resetView();
                }}
              >
                <span>🔄</span> Reset View
              </button>
              <button
                type="button"
                id="preview-toggle-studio"
                className={`preview-control-button${studioAvailable ? '' : ' hidden'}${panelOpen ? ' active' : ''}`}
                title={studioAvailable ? 'Studio lighting and materials' : 'Studio is not available for this file type'}
                disabled={!studioAvailable}
                aria-hidden={!studioAvailable}
                onClick={() => updateSetting('panelOpen', !settings.panelOpen)}
              >
                <span>🎛️</span> Studio
              </button>
              <button
                type="button"
                id="preview-save-image"
                className="preview-control-button"
                title="Save a picture of this preview"
                onClick={(event) => {
                  event.stopPropagation();
                  setSlicerMenu(null);
                  setSaveMenu(!saveMenu);
                }}
              >
                <span>💾</span> Save Image
              </button>
            </div>
            <div id="preview-slicer-menu" className={`preview-slicer-menu${slicerMenu ? '' : ' hidden'}`} role="menu" aria-label="Choose slicer">
              {slicerMenu?.map((slicer) => (
                <button
                  key={`${slicer.id}:${slicer.name}`}
                  type="button"
                  className="preview-slicer-menu-item"
                  title={slicer.path || slicer.name}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSlicerMenu(null);
                    sendToSlicer(slicerPaths, slicer);
                  }}
                >
                  {slicer.name}
                </button>
              ))}
            </div>
            <div id="preview-save-menu" className={`preview-slicer-menu${saveMenu ? '' : ' hidden'}`} role="menu" aria-label="Save preview image">
              <button type="button" className="preview-slicer-menu-item" id="preview-save-with-backdrop" onClick={() => saveImage(false)}>
                Save with backdrop
              </button>
              <button type="button" className="preview-slicer-menu-item" id="preview-save-transparent" onClick={() => saveImage(true)}>
                Save transparent PNG
              </button>
            </div>
            <div className="preview-info">
              <label id="preview-part-picker" className={`preview-part-picker${parts.length > 1 ? '' : ' hidden'}`}>
                <span>Part</span>
                <select
                  id="preview-part-select"
                  aria-label="Focus preview part"
                  value={focus}
                  onChange={(e) => {
                    setFocus(e.target.value);
                    engineRef.current?.focusPart(e.target.value || 'all');
                  }}
                >
                  <option value="all">All parts</option>
                  {parts.map((part) => (
                    <option key={part.id} value={part.id}>
                      {part.name}
                    </option>
                  ))}
                </select>
              </label>
              <span id="preview-file-type">{fileType}</span>
              <span id="preview-dimensions">{dimensions}</span>
              <span id="preview-simplified-note" className="preview-simplified-note" style={{ display: note ? 'inline' : 'none' }}>
                {note}
              </span>
            </div>
          </div>
        </div>
        <div className="preview-instructions">
          <p>{hint}</p>
        </div>
      </div>
    </dialog>
  );
}
