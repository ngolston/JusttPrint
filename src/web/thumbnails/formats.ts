/**
 * What kind of thumbnail a model file can have: a 3D render, images stored inside the file,
 * or a placeholder naming its format. Also the failure art that is shown but never saved.
 */

/** The extension of a model path, also for a ZIP entry (`archive.zip::dir/part.stl`). */
export function extensionOf(filePath: string | null | undefined): string {
  if (!filePath) return '';
  const pathPart = filePath.includes('::') ? filePath.split('::')[1] || '' : filePath;
  const base = pathPart.split(/[/\\]/).pop() || pathPart;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

const bare = (ext: string) => (ext || '').toLowerCase().replace(/^\./, '');

/** Formats the parse worker can load and three.js can draw. */
export function isRenderable3d(ext: string): boolean {
  return ['stl', '3mf', 'obj', 'ply', 'step', 'stp', 'lys', 'igs', 'iges'].includes(bare(ext));
}

/** Formats that may carry preview images (tried before a 3D render). */
export function hasEmbeddedPreviews(ext: string): boolean {
  return ['3mf', 'lys', 'f3d', 'chitubox', 'voxl'].includes(bare(ext));
}

/** Formats whose only possible thumbnail is an embedded image (no mesh to render). */
export function isImageOnly(ext: string): boolean {
  return ['f3d', 'chitubox', 'voxl'].includes(bare(ext));
}

const LABELS: Record<string, string> = {
  '3ds': '3DS', amf: 'AMF', blender: 'Blender', dae: 'DAE', dxf: 'DXF', dwg: 'DWG', fbx: 'FBX', f3d: 'F3D', f3z: 'F3Z',
  chitubox: 'ChiTuBox', gcode: 'G-code', igs: 'IGES', iges: 'IGES', lys: 'LYS', lyt: 'LYT', obj: 'OBJ', ply: 'PLY',
  step: 'STEP', stp: 'STEP', svg: 'SVG', voxl: 'VOXL', x3d: 'X3D'
};

/** The text a placeholder shows for a format. */
export function formatLabel(ext: string): string {
  const e = bare(ext);
  return LABELS[e] || (e ? e.toUpperCase() : '?');
}

const SIZE = 250;
const drawn = new Map<string, string>();

function draw(key: string, paint: (ctx: CanvasRenderingContext2D) => void): string {
  const cached = drawn.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '3d.png';
  paint(ctx);
  let url = '3d.png';
  try {
    url = canvas.toDataURL('image/png');
  } catch { /* keep 3d.png */ }
  drawn.set(key, url);
  return url;
}

/** A dark tile with the format's name (models without a render). */
export function typedPlaceholder(ext: string): string {
  const label = formatLabel(ext);
  return draw(`typed:${label}`, (ctx) => {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, SIZE / 2, SIZE / 2);
  });
}

/** "Model may be corrupted" (the file could not be loaded or drawn). */
export function corruptedPlaceholder(): string {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--model-background-color').trim() || '#070147';
  return draw(`corrupted:${bg}`, (ctx) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = 'rgba(255, 120, 100, 0.95)';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Model may be', SIZE / 2, SIZE / 2 - 14);
    ctx.fillText('corrupted', SIZE / 2, SIZE / 2 + 10);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '12px sans-serif';
    ctx.fillText('(could not load)', SIZE / 2, SIZE / 2 + 32);
  });
}

const FAILURE_FORMATS = ['stl', '3mf', 'obj', 'ply', 'step', 'stp', 'lys', 'lyt', 'igs', 'iges', 'f3d', 'chitubox', 'voxl', 'svg', 'f3z'];

/**
 * Failure art and placeholders: shown, never saved (so the model keeps hasThumbnail = 0 and is
 * retried). Older versions saved typed placeholders; those count as failures too.
 */
export function isFailurePlaceholder(thumb: string | null | undefined): boolean {
  if (!thumb || thumb === '3d.png') return true;
  if (!thumb.startsWith('data:image')) return false;
  if (thumb === corruptedPlaceholder()) return true;
  return FAILURE_FORMATS.some((ext) => thumb === typedPlaceholder(ext));
}

/** A real stored image: a data URL that is not the default 3d.png or failure art. */
export function isRealImage(thumb: unknown): thumb is string {
  return typeof thumb === 'string' && thumb.startsWith('data:image') && !isFailurePlaceholder(thumb);
}

/** The real images in a model's thumbnail field (images joined by `::`). */
export function imagesIn(thumbnailField: string | null | undefined): string[] {
  return String(thumbnailField || '').split('::').filter(isRealImage);
}

/** True when an image is (nearly) empty: under 0.5% opaque pixels, e.g. a model drawn off camera. */
export function isMostlyEmpty(dataUrl: string | null | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (!dataUrl || !dataUrl.startsWith('data:image')) return resolve(true);
    const img = new Image();
    img.onload = () => {
      try {
        const w = Math.min(64, img.width || 64);
        const h = Math.min(64, img.height || 64);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(false);
        ctx.drawImage(img, 0, 0, w, h);
        const pixels = ctx.getImageData(0, 0, w, h).data;
        let opaque = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 12) opaque++;
        resolve(opaque < w * h * 0.005);
      } catch {
        resolve(false);
      }
    };
    img.onerror = () => resolve(true);
    img.src = dataUrl;
  });
}
