/** The preview's Studio settings: model look, backdrop, lights and camera. Saved per browser. */

export type Finish = 'original' | 'matte' | 'gloss' | 'metal' | 'chrome';
export type Backdrop = 'white' | 'gray' | 'blue' | 'pink' | 'mint' | 'sand' | 'charcoal' | 'black' | 'custom';
export type CameraView = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'fit';

export interface StudioSettings {
  color: string;
  finish: Finish;
  finishIntensity: number;
  edges: boolean;
  wireframe: boolean;
  autoRotate: boolean;
  rotateSpeed: number;
  background: 'solid' | 'gradient';
  backdrop: Backdrop;
  customBg: string;
  boxSize: number;
  reflection: number;
  reflectionGap: number;
  shadow: number;
  shadowSmooth: number;
  lightRot: number;
  lightHeight: number;
  light: number;
  even: boolean;
  grid: boolean;
  transparent: boolean;
  fov: number;
  panelOpen: boolean;
}

export const STUDIO_STORAGE_KEY = 'justtprint.previewStudio.v5';

export const STUDIO_DEFAULTS: StudioSettings = {
  color: '#4a9eff',
  finish: 'matte',
  finishIntensity: 100,
  edges: false,
  wireframe: false,
  autoRotate: false,
  rotateSpeed: 100,
  background: 'solid',
  backdrop: 'charcoal',
  customBg: '#ffffff',
  boxSize: 100,
  reflection: 0,
  reflectionGap: 2,
  shadow: 55,
  shadowSmooth: 45,
  lightRot: 45,
  lightHeight: 48,
  light: 100,
  even: false,
  grid: false,
  transparent: false,
  fov: 42,
  panelOpen: false
};

export const BACKDROP_COLORS: Record<Exclude<Backdrop, 'custom'>, string> = {
  white: '#f4f5f7',
  gray: '#c8d0d5',
  blue: '#5aa9e6',
  pink: '#e88aa3',
  mint: '#4fc9a4',
  sand: '#e2c08a',
  charcoal: '#3a3d46',
  black: '#16171c'
};

export const BACKDROP_LABELS: Record<Backdrop, string> = {
  white: 'White',
  gray: 'Cool gray',
  blue: 'Sky blue',
  pink: 'Blush pink',
  mint: 'Mint',
  sand: 'Warm sand',
  charcoal: 'Charcoal',
  black: 'Black',
  custom: 'Custom…'
};

export interface FinishPreset {
  metalness: number;
  roughness: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
}

export const FINISHES: Record<Exclude<Finish, 'original'>, FinishPreset> = {
  matte: { metalness: 0.02, roughness: 0.92 },
  gloss: { metalness: 0.08, roughness: 0.16, clearcoat: 0.9, clearcoatRoughness: 0.12 },
  metal: { metalness: 0.86, roughness: 0.28 },
  chrome: { metalness: 1, roughness: 0.06 }
};

/** Saved settings over the defaults. 'lightbox' was an older name for the solid background. */
export function normalizeStudioSettings(stored: unknown): StudioSettings {
  const merged = { ...STUDIO_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) } as Omit<StudioSettings, 'background'> & { background: string };
  if (merged.background === 'lightbox') merged.background = 'solid';
  return merged as StudioSettings;
}

export function loadStudioSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): StudioSettings {
  try {
    return normalizeStudioSettings(JSON.parse(storage?.getItem(STUDIO_STORAGE_KEY) || '{}'));
  } catch {
    return { ...STUDIO_DEFAULTS };
  }
}

export function saveStudioSettings(settings: StudioSettings, storage: Pick<Storage, 'setItem'> | null = safeStorage()) {
  try {
    storage?.setItem(STUDIO_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage full or blocked */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function backdropHex(settings: Pick<StudioSettings, 'backdrop' | 'customBg'>): string {
  if (settings.backdrop === 'custom') return settings.customBg || '#ffffff';
  return BACKDROP_COLORS[settings.backdrop] || BACKDROP_COLORS.white;
}

/** How much of the scene a settings change touches (the engine redoes only that part). */
export interface ApplyOptions {
  materials?: boolean;
  room?: boolean;
  reflection?: boolean;
  edges?: boolean;
  onlyLights?: boolean;
}

const LIGHT_ONLY: (keyof StudioSettings)[] = ['shadow', 'shadowSmooth', 'lightRot', 'lightHeight', 'light', 'even', 'fov', 'autoRotate', 'rotateSpeed'];
const ROOM: (keyof StudioSettings)[] = ['background', 'backdrop', 'customBg', 'transparent', 'grid'];
const REFLECTION: (keyof StudioSettings)[] = ['reflection', 'reflectionGap'];
const EDGES: (keyof StudioSettings)[] = ['edges', 'wireframe'];

/** Which part of the scene to redo after `key` changed (same grouping as the old studio panel). */
export function applyOptionsFor(key: keyof StudioSettings): ApplyOptions | null {
  if (key === 'panelOpen') return null;
  if (LIGHT_ONLY.includes(key)) return { onlyLights: true };
  if (ROOM.includes(key)) return { materials: false, room: true, reflection: true };
  if (REFLECTION.includes(key)) return { materials: false, room: false, reflection: true };
  if (EDGES.includes(key)) return { materials: false, room: false, reflection: false };
  return {};
}

/** The file's extension, inside a ZIP too. */
export function previewExtension(filePath: string): string {
  const pathForExt = filePath.includes('::') ? filePath.split('::')[1] || '' : filePath;
  return (pathForExt.split('.').pop() || '').toLowerCase();
}

const PREVIEWABLE = new Set(['stl', '3mf', 'obj', 'ply', 'step', 'stp', 'lys', 'igs', 'iges', 'f3d', 'chitubox', 'voxl']);
const IMAGE_ONLY = new Set(['f3d', 'chitubox', 'voxl']);

export const isPreviewableExtension = (ext: string) => PREVIEWABLE.has(ext);
/** Formats that carry only a picture of the model (no mesh). */
export const isImageOnlyExtension = (ext: string) => IMAGE_ONLY.has(ext);
export const isPreviewablePath = (filePath: string) => isPreviewableExtension(previewExtension(filePath));

/** A file name safe to save the preview image under. */
export function exportBasename(title: string): string {
  const raw = (title || 'model-preview').replace(/\.[^.]+$/, '');
  return raw.replace(/[<>:"/\\|?*]+/g, '-').trim() || 'model-preview';
}

/** The message shown when a preview fails (IPC wrapper and Node errors made readable). */
export function friendlyPreviewError(error: unknown): string {
  let message = String((error as Error)?.message || error || 'Unknown error');
  const ipcMatch = message.match(/Error invoking remote method 'parse-3mf-preview':\s*(?:Error:\s*)?([\s\S]+)/);
  if (ipcMatch) message = ipcMatch[1].trim();
  else if (message.startsWith('Error: ')) message = message.slice(7);
  if (message.includes('ERR_WORKER_OUT_OF_MEMORY') || message.includes('heap out of memory')) {
    return 'Preview ran out of memory while processing this model. Try closing other previews first, or restart the app.';
  }
  return message;
}
