/**
 * Grid thumbnails drawn in this browser: one model at 250×250 on a transparent background,
 * through a shared WebGL renderer that is recycled every `contextReuse` renders.
 * three.js 0.181 set up like the old r128 renderer (../three/setup.ts); like before, the
 * output is not sRGB-encoded and not tone-mapped.
 */
import { LIGHT, THREE } from '../three/setup';
import { disposeObject3D, groupFromGeometryData } from '../three/models';
import { loadModelData, type ModelData } from './loader';

const SIZE = 250;

export class WebGLUnavailableError extends Error {}

let renderer: THREE.WebGLRenderer | null = null;
let canvas: HTMLCanvasElement | null = null;
let uses = 0;
let unavailable = false;

function createRenderer(target: HTMLCanvasElement): THREE.WebGLRenderer {
  // Prefer options that work on most GPUs; fall back if a preference is rejected.
  const attempts: THREE.WebGLRendererParameters[] = [
    { powerPreference: 'default', failIfMajorPerformanceCaveat: false },
    { powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false },
    { failIfMajorPerformanceCaveat: false },
    {}
  ];
  let lastError: unknown = null;
  for (const extra of attempts) {
    try {
      const created = new THREE.WebGLRenderer({ canvas: target, antialias: false, alpha: true, preserveDrawingBuffer: true, ...extra });
      // Some WebGL stacks return null shader logs, which three.js would fail on.
      created.debug.checkShaderErrors = false;
      created.outputColorSpace = THREE.LinearSRGBColorSpace;
      return created;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Error creating WebGL context.');
}

/** Drop the shared renderer (the next render makes a new one). Never forces a context loss. */
export function resetThumbnailRenderer() {
  try {
    renderer?.dispose();
  } catch {
    /* ignore */
  }
  renderer = null;
  canvas?.remove();
  canvas = null;
  uses = 0;
}

function sharedRenderer(contextReuse: number): THREE.WebGLRenderer {
  if (unavailable) throw new WebGLUnavailableError('Error creating WebGL context.');
  if (!renderer || uses >= contextReuse) {
    resetThumbnailRenderer();
    // On the page (detached canvases can fail getContext on some systems), out of sight.
    canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, { position: 'fixed', left: '-9999px', top: '0', width: `${SIZE}px`, height: `${SIZE}px`, opacity: '0', pointerEvents: 'none' });
    document.body.appendChild(canvas);
    try {
      renderer = createRenderer(canvas);
    } catch (error) {
      unavailable = true;
      resetThumbnailRenderer();
      throw new WebGLUnavailableError(String((error as Error)?.message || error));
    }
    canvas.addEventListener(
      'webglcontextlost',
      (event) => {
        event.preventDefault();
        resetThumbnailRenderer();
      },
      false
    );
  }
  uses++;
  return renderer!;
}

/** Turn the model Y-up, center it and put the camera on the (1,1,1) diagonal to fit it. */
function fitCamera(camera: THREE.PerspectiveCamera, object: THREE.Object3D) {
  object.rotation.x = -Math.PI / 2;
  object.updateMatrixWorld(true);
  const center = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
  if (Number.isFinite(center.x) && Number.isFinite(center.y) && Number.isFinite(center.z)) {
    object.position.sub(center);
    object.updateMatrixWorld(true);
  }
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
  const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
  let cameraZ = maxDim > 0 && tanHalfFov > 0 ? Math.abs(maxDim / 2 / tanHalfFov) * 1.5 : 5;
  if (!Number.isFinite(cameraZ) || cameraZ <= 0) cameraZ = 5;
  const distance = cameraZ * Math.sqrt(3);
  camera.near = Math.max(0.01, distance / 1000);
  camera.far = Math.max(10000, distance * 20);
  camera.updateProjectionMatrix();
  camera.position.set(cameraZ, cameraZ, cameraZ);
  camera.lookAt(0, 0, 0);
}

/** Fewer than 0.5% opaque pixels: the model was clipped or did not draw. */
function mostlyEmpty(gl: THREE.WebGLRenderer): boolean {
  const small = document.createElement('canvas');
  small.width = 64;
  small.height = 64;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(gl.domElement, 0, 0, 64, 64);
  const pixels = ctx.getImageData(0, 0, 64, 64).data;
  let opaque = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 12) opaque++;
  return opaque < 64 * 64 * 0.005;
}

export interface ThumbnailOptions {
  /** Give up on loading after this long. */
  timeoutMs: number;
  /** Renders before the shared WebGL context is replaced. */
  contextReuse: number;
  /** Key and fill lights (the "advanced lighting" setting); otherwise one light. */
  lighting: boolean;
  /** False when the caller no longer needs the image (stop before rendering). */
  stillWanted?: () => boolean;
}

/**
 * A PNG data URL of the model, or null when the file has nothing to draw (or is no longer
 * wanted). Throws WebGLUnavailableError without WebGL, other errors for broken files.
 */
export async function renderThumbnail(filePath: string, options: ThumbnailOptions): Promise<string | null> {
  const gl = sharedRenderer(options.contextReuse);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  let model: THREE.Object3D | null = null;
  try {
    gl.setSize(SIZE, SIZE);
    gl.setClearColor(0x000000, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 0.4 * LIGHT));
    if (options.lighting) {
      const key = new THREE.DirectionalLight(0xffffff, 1.0 * LIGHT);
      key.position.set(5, 10, 7.5);
      const fill = new THREE.DirectionalLight(0xffffff, 0.5 * LIGHT);
      fill.position.set(-5, 5, -7.5);
      scene.add(key, fill);
    } else {
      const simple = new THREE.DirectionalLight(0xffffff, 1.0 * LIGHT);
      simple.position.set(1, 1, 1).normalize();
      scene.add(simple);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Loading model timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
    });
    let data: ModelData | null;
    try {
      data = await Promise.race([loadModelData(filePath), timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (!data || options.stillWanted?.() === false) return null;

    model = groupFromGeometryData(data.geometries);
    scene.add(model);
    fitCamera(camera, model);
    gl.render(scene, camera);
    if (mostlyEmpty(gl)) {
      // One retry with wider framing (large flat models get clipped).
      const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
      const cameraZ = Math.max(size.x, size.y, size.z, 1e-3) * 2.5;
      const distance = cameraZ * Math.sqrt(3);
      camera.near = Math.max(0.01, distance / 1000);
      camera.far = Math.max(20000, distance * 20);
      camera.updateProjectionMatrix();
      camera.position.set(cameraZ, cameraZ * 0.7, cameraZ);
      camera.lookAt(0, 0, 0);
      gl.render(scene, camera);
    }
    return gl.domElement.toDataURL('image/png');
  } finally {
    disposeObject3D(model);
    scene.clear();
    renderer?.clear();
  }
}
