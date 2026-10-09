/**
 * The 3D preview's scene: renderer, camera and orbit controls, the studio room, lights,
 * materials, reflection and edges, part focus and "sit on face" picking, and image export.
 * Loaded on demand (import('./engine')) so three.js is only fetched when a preview opens.
 *
 * three.js 0.181, set up to look like the old r128 preview (../three/setup.ts).
 */
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
  FINISHES,
  STUDIO_DEFAULTS,
  backdropHex,
  isImageOnlyExtension,
  isPreviewableExtension,
  previewExtension,
  type ApplyOptions,
  type CameraView,
  type StudioSettings
} from './studio';
import { loadLibraryFileBuffer } from './files';
import { loadModelData } from '../thumbnails/loader';
import { LIGHT, THREE } from '../three/setup';
import { disposeObject3D, groupFromGeometryData } from '../three/models';

export interface PreviewPart {
  id: string;
  name: string;
}

export interface EngineEvents {
  /** "Dimensions: …" text, or another line for the info bar. */
  dimensions(text: string): void;
  /** The parts the model can focus on (empty: no picker), and the focused one. */
  parts(parts: PreviewPart[], focus: string): void;
  /** Sit-on-face mode turned on or off (a pick ends it). */
  sitOnFace(enabled: boolean): void;
}

/** A file that only carries a picture of the model. */
export interface ImageOnlyPreview {
  imageOnly: true;
  dataUrl: string;
  label: string;
}

export interface LoadedObject {
  object: THREE.Object3D;
  /** "Simplified preview (n of m triangles)" for big 3MF files. */
  note?: string;
}

interface Bridge {
  parse3MFPreview?: (filePath: string, requestId: string) => Promise<any>;
  cancel3MFPreview?: (requestId: string) => void;
  getF3DImages?: (filePath: string) => Promise<string[]>;
  getChituboxImages?: (filePath: string) => Promise<string[]>;
  getVoxlImages?: (filePath: string) => Promise<string[]>;
}

const bridge = () => window.electron as (Bridge & typeof window.electron) | undefined;

export class PreviewCancelled extends Error {
  constructor() {
    super('Preview cancelled');
  }
}

// ---------------------------------------------------------------- loading

const MAX_STL_TRIANGLES = 10000000;

function validateSTLBuffer(buffer: ArrayBuffer) {
  if (buffer.byteLength < 84) throw new Error('STL file too small to be valid');
  const triangleCount = new DataView(buffer).getUint32(80, true);
  if (84 + triangleCount * 50 === buffer.byteLength && triangleCount > MAX_STL_TRIANGLES) {
    throw new Error(`STL has too many triangles (${triangleCount.toLocaleString()}). Max ${MAX_STL_TRIANGLES.toLocaleString()}. File may be corrupted.`);
  }
}

const materialsOf = (mesh: THREE.Mesh): THREE.Material[] => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
const asMesh = (object: THREE.Object3D) => ((object as THREE.Mesh).isMesh ? (object as THREE.Mesh) : null);

function hasColorData(object: THREE.Object3D): boolean {
  let found = false;
  object.traverse((child) => {
    const mesh = asMesh(child);
    if (!mesh) return;
    if (mesh.geometry?.attributes?.color) found = true;
    for (const mat of materialsOf(mesh) as (THREE.Material & { map?: unknown; color?: THREE.Color })[]) {
      if (!mat) continue;
      if (mat.map || mat.vertexColors) found = true;
      if (mat.color && (mat.color.r > 0.05 || mat.color.g > 0.05 || mat.color.b > 0.05)) found = true;
    }
  });
  return found;
}

function applyDefaultMetalMaterial(object: THREE.Object3D) {
  const material = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, metalness: 0.85, roughness: 0.35, flatShading: false });
  object.traverse((child) => {
    const mesh = asMesh(child);
    if (!mesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(() => material.clone()) : material.clone();
  });
}

/** Basic and Phong materials (from OBJ/3MF loaders) become lit standard materials. */
function ensureLitMaterials(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = asMesh(child);
    if (!mesh) return;
    const list = materialsOf(mesh);
    list.forEach((mat, index) => {
      const m = mat as THREE.MeshBasicMaterial & THREE.MeshPhongMaterial;
      if (!m || !(m.isMeshBasicMaterial || m.isMeshPhongMaterial)) return;
      const color = m.color ? m.color.clone() : new THREE.Color(0xffffff);
      if (m.map || m.vertexColors) color.set(0xffffff);
      const converted = new THREE.MeshStandardMaterial({
        color,
        map: m.map || null,
        metalness: m.isMeshBasicMaterial ? 0.15 : 0.2,
        roughness: m.isMeshBasicMaterial ? 0.65 : 0.55,
        flatShading: m.flatShading || false,
        vertexColors: m.vertexColors || false,
        transparent: m.transparent || false,
        opacity: typeof m.opacity === 'number' ? m.opacity : 1
      });
      if (Array.isArray(mesh.material)) mesh.material[index] = converted;
      else mesh.material = converted;
    });
  });
}

/** Server-mode JSON turns typed arrays into objects with numeric keys; ObjectLoader needs arrays. */
function normalize3mfJson(json: any) {
  for (const geometry of json?.geometries || []) {
    const data = geometry?.data;
    if (!data) continue;
    for (const key of Object.keys(data.attributes || {})) {
      const attr = data.attributes[key];
      if (attr && attr.array != null && !Array.isArray(attr.array)) attr.array = Object.values(attr.array);
    }
    if (data.index && data.index.array != null && !Array.isArray(data.index.array)) data.index.array = Object.values(data.index.array);
  }
  return json;
}

async function embeddedImage(filePath: string, ext: string): Promise<string | null> {
  const b = bridge();
  const getter = ext === 'f3d' ? b?.getF3DImages : ext === 'chitubox' ? b?.getChituboxImages : ext === 'voxl' ? b?.getVoxlImages : undefined;
  if (typeof getter !== 'function') throw new Error(`${ext.toUpperCase()} preview is not available`);
  const images = await getter(filePath);
  return Array.isArray(images) ? images.find((im) => typeof im === 'string' && im.startsWith('data:image')) || null : null;
}

export interface LoadContext {
  /** False once a newer preview started or the dialog closed. */
  isCurrent(): boolean;
  /** Loading message. */
  status(text: string): void;
  /** The 3MF parse request id, so the dialog can match status events and cancel it. */
  set3mfRequest(id: string | null): void;
}

/** Load one library file for the preview: a three.js object, or the embedded picture of image-only formats. */
export async function loadPreviewObject(filePath: string, ctx: LoadContext): Promise<LoadedObject | ImageOnlyPreview> {
  const check = () => {
    if (!ctx.isCurrent()) throw new PreviewCancelled();
  };
  check();
  const ext = previewExtension(filePath);
  if (!isPreviewableExtension(ext)) throw new Error(`Unsupported file type: ${ext}`);

  if (isImageOnlyExtension(ext)) {
    const label = ext === 'f3d' ? 'Fusion' : ext === 'chitubox' ? 'ChiTuBox' : 'VOXL';
    ctx.status(`Extracting ${label} preview...`);
    const dataUrl = await embeddedImage(filePath, ext);
    check();
    if (!dataUrl) throw new Error(`This ${ext.toUpperCase()} file has no embedded preview image`);
    return { imageOnly: true, dataUrl, label };
  }

  if (['step', 'stp', 'lys', 'obj', 'ply', 'igs', 'iges'].includes(ext)) {
    ctx.status(
      ext === 'lys'
        ? 'Parsing LYS mesh...\nLarge supported scenes can take a moment.'
        : ext === 'igs' || ext === 'iges'
          ? 'Tessellating IGES file...\nThis can take time for large CAD models.'
          : ext === 'step' || ext === 'stp'
            ? 'Tessellating STEP file...\nThis can take time for large CAD models.'
            : `Loading ${ext.toUpperCase()} mesh...`
    );
    const data = await loadModelData(filePath);
    check();
    if (!data) throw new Error(`Failed to parse ${ext.toUpperCase()} geometry`);
    const object = groupFromGeometryData(data.geometries);
    if (!hasColorData(object)) applyDefaultMetalMaterial(object);
    else ensureLitMaterials(object);
    return { object };
  }

  if (ext === 'stl') {
    const buffer = await loadLibraryFileBuffer(filePath);
    check();
    validateSTLBuffer(buffer);
    const geometry = new STLLoader().parse(buffer);
    if (!geometry) throw new Error('Failed to parse STL geometry');
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({
      color: 0x4a9eff,
      metalness: 0.3,
      roughness: 0.6,
      flatShading: false,
      emissive: 0x002244,
      emissiveIntensity: 0.2
    });
    return { object: new THREE.Mesh(geometry, material) };
  }

  // 3MF: the server parses it (simplifying very large meshes) and sends ObjectLoader JSON.
  ctx.status('Loading 3MF file...\nThis could take time for larger files.');
  const requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  ctx.set3mfRequest(requestId);
  let json: any;
  try {
    json = await bridge()?.parse3MFPreview?.(filePath, requestId);
  } finally {
    ctx.set3mfRequest(null);
  }
  check();
  if (!json) throw new Error('Failed to load 3MF file');
  const object = new THREE.ObjectLoader().parse(normalize3mfJson(json));
  if (!object) throw new Error('Failed to parse 3MF preview');
  // 3MF is Z-up; the studio camera and floor are Y-up.
  object.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  object.updateMatrixWorld(true);
  object.traverse((child) => {
    const mesh = asMesh(child);
    if (mesh?.geometry && (!mesh.geometry.attributes.normal || mesh.geometry.attributes.normal.count === 0)) mesh.geometry.computeVertexNormals();
  });
  if (!hasColorData(object)) applyDefaultMetalMaterial(object);
  else ensureLitMaterials(object);
  const meta = json.metadata || {};
  const note =
    meta.previewSimplified && meta.sourceTriangles && meta.keptTriangles
      ? `Simplified preview (${meta.keptTriangles.toLocaleString('en-US')} of ${meta.sourceTriangles.toLocaleString('en-US')} triangles)`
      : undefined;
  return { object, note };
}

/** Give each part of a bundle its own color (parts without a texture or vertex colors). */
function applyPartTint(object: THREE.Object3D, index: number, total: number) {
  if (total <= 1) return;
  const tint = new THREE.Color().setHSL((index / total) * 0.75 + 0.05, 0.55, 0.52);
  object.traverse((child) => {
    const mesh = asMesh(child);
    if (!mesh) return;
    materialsOf(mesh).forEach((mat, i) => {
      const m = mat as THREE.MeshStandardMaterial;
      if (!m || m.map || m.vertexColors) return;
      const tinted = m.clone();
      tinted.color = tint.clone();
      if (Array.isArray(mesh.material)) mesh.material[i] = tinted;
      else mesh.material = tinted;
    });
  });
}

/** Lay bundle parts out on a grid, one cell per part, tinted apart. */
export function arrangeBundle(objects: { object: THREE.Object3D; name: string }[]): THREE.Group {
  const root = new THREE.Group();
  const placed = objects.map(({ object, name }, index) => {
    applyPartTint(object, index, objects.length);
    const box = new THREE.Box3().setFromObject(object);
    object.position.sub(box.getCenter(new THREE.Vector3()));
    object.name = name || object.name || `Part ${index + 1}`;
    return { object, size: box.getSize(new THREE.Vector3()) };
  });
  const maxPartDim = Math.max(...placed.map((p) => Math.max(p.size.x, p.size.y, p.size.z)), 1);
  const spacing = maxPartDim * 1.4;
  const cols = Math.ceil(Math.sqrt(placed.length));
  placed.forEach((entry, index) => {
    entry.object.position.x = (index % cols) * spacing;
    entry.object.position.z = -Math.floor(index / cols) * spacing;
    entry.object.userData.previewPart = true;
    entry.object.userData.previewPartId = String(index);
    root.add(entry.object);
  });
  return root;
}

// ---------------------------------------------------------------- scene

const isPlateLike = (size: THREE.Vector3) => size.y > 0 && size.y < Math.max(size.x, size.z, 1) * 0.35;

export class PreviewEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private ambient: THREE.AmbientLight;
  private hemi: THREE.HemisphereLight;
  private key: THREE.DirectionalLight;
  private fill: THREE.DirectionalLight;
  private back: THREE.DirectionalLight;
  private turntable = new THREE.Group();
  private room = new THREE.Group();
  private ground: THREE.Mesh<THREE.BoxGeometry, THREE.MeshLambertMaterial>;
  private floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
  private grid: THREE.GridHelper;
  private axes: THREE.AxesHelper;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private gradient: THREE.CanvasTexture | null = null;
  private model: THREE.Object3D | null = null;
  private reflection: THREE.Group | null = null;
  private edges: THREE.Group | null = null;
  private faceHighlight: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | null = null;
  private modelSize = new THREE.Vector3(100, 100, 100);
  private floorY = 0;
  private wireframe = false;
  private parts: (PreviewPart & { object: THREE.Object3D })[] = [];
  private focusPartId = 'all';
  private sitOnFace = false;
  private restPose: { quaternion: THREE.Quaternion; position: THREE.Vector3 } | null = null;
  private pickStart: { x: number; y: number } | null = null;
  private frame = 0;
  private settings: StudioSettings;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private container: HTMLElement,
    settings: StudioSettings,
    private events: EngineEvents
  ) {
    this.settings = { ...settings };
    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    this.scene.background = new THREE.Color(0x2a2a3e);
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);
    this.camera.position.set(100, 100, 100);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: false
    });
    this.renderer.debug.checkShaderErrors = false;
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.ambient = new THREE.AmbientLight(0xffffff, 0.55 * LIGHT);
    this.hemi = new THREE.HemisphereLight(0xf0f4ff, 0x2a2430, 0.35 * LIGHT);
    this.key = new THREE.DirectionalLight(0xfff6ea, 1.0 * LIGHT);
    this.key.position.set(200, 240, 160);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0002;
    this.key.shadow.normalBias = 0.02;
    this.fill = new THREE.DirectionalLight(0xc8d8ff, 0.45 * LIGHT);
    this.fill.position.set(-220, 120, -160);
    this.back = new THREE.DirectionalLight(0xffffff, 0.35 * LIGHT);
    this.back.position.set(40, 80, -260);
    this.scene.add(this.ambient, this.hemi, this.key, this.key.target, this.fill, this.back);

    this.turntable.name = 'preview-turntable';
    this.scene.add(this.turntable);
    this.createEnvironment();

    // The studio room: a box around the model (seen from inside), a reflective floor plate, a grid.
    this.room.name = 'preview-room';
    this.scene.add(this.room);
    this.ground = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x3a3d46, side: THREE.BackSide }));
    this.ground.receiveShadow = true;
    this.ground.renderOrder = -1;
    this.room.add(this.ground);
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshPhysicalMaterial({
        color: 0x16171c,
        metalness: 0.08,
        roughness: 0.42,
        transparent: true,
        opacity: 0.22,
        envMapIntensity: 0.2,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
      })
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.floor.renderOrder = 1;
    this.floor.visible = false;
    this.room.add(this.floor);
    this.grid = new THREE.GridHelper(1, 20, 0x8aa0b8, 0xc5d0dc);
    this.grid.visible = false;
    this.grid.position.y = 0.02;
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(100);
    this.axes.visible = false;
    this.scene.add(this.axes);

    this.applySettings(this.settings);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 5000;
    this.controls.enableRotate = true;
    this.controls.autoRotate = this.settings.autoRotate;
    this.controls.autoRotateSpeed = 2 * Math.max(0.1, (this.settings.rotateSpeed || 100) / 100);
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('pointerup', this.onPointerUp);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.animate();
  }

  // ------------------------------------------------------------ public

  /** Show a loaded object (or a bundle group) as the model. */
  showModel(object: THREE.Object3D) {
    this.removeModel();
    this.restPose = null;
    this.setSitOnFace(false);
    this.model = object;
    this.captureOriginalMaterials(object);
    object.traverse((child) => {
      const mesh = asMesh(child);
      if (mesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    this.turntable.add(object);
    this.centerModel(object);
    this.restPose = { quaternion: object.quaternion.clone(), position: object.position.clone() };
    this.updateDimensions(object);
    this.applySettings(this.settings);
    this.discoverParts(object);
  }

  /** New studio settings; `options` says which part of the scene to redo. */
  setSettings(settings: StudioSettings, options: ApplyOptions = {}) {
    this.settings = { ...settings };
    this.applySettings(this.settings, options);
  }

  setCameraView(name: CameraView) {
    this.frameCamera(this.modelSize, name);
    this.turntable.rotation.set(0, 0, 0);
  }

  /** Reset View: back to ISO on the focused part, or the whole model. */
  resetView() {
    if (!this.model) return;
    if (this.parts.length > 1 && this.focusPartId !== 'all') this.focusPart(this.focusPartId, 'iso');
    else this.setCameraView('iso');
  }

  focusPart(partId: string, view: CameraView = 'iso') {
    this.focusPartId = partId || 'all';
    const all = this.focusPartId === 'all';
    this.parts.forEach((part) => {
      part.object.visible = all || part.id === this.focusPartId;
    });
    const target = this.focusObject();
    if (target) {
      const box = new THREE.Box3().setFromObject(target);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      this.modelSize.copy(size);
      this.floorY = box.min.y;
      this.updateGround(target);
      this.updateDimensions(target);
      this.frameCamera(size, view, new THREE.Vector3(center.x, box.min.y, center.z));
    }
    this.applySettings(this.settings, { materials: false, room: true, reflection: true });
    this.events.parts(
      this.parts.map(({ id, name }) => ({ id, name })),
      this.focusPartId
    );
  }

  setSitOnFace(enabled: boolean) {
    const next = !!enabled && !!this.model;
    if (next === this.sitOnFace) return;
    this.sitOnFace = next;
    if (!next && this.faceHighlight) this.faceHighlight.visible = false;
    this.events.sitOnFace(next);
  }

  resetPose() {
    if (!this.model || !this.restPose) return;
    this.model.quaternion.copy(this.restPose.quaternion);
    this.model.position.copy(this.restPose.position);
    this.model.updateMatrixWorld(true);
    this.afterPoseChange();
  }

  /** The current view as a PNG data URL (with or without the studio backdrop). */
  snapshot(transparent: boolean): string {
    const hidden: [THREE.Object3D, boolean][] = [];
    const hide = (obj: THREE.Object3D | null) => {
      if (!obj) return;
      hidden.push([obj, obj.visible]);
      obj.visible = false;
    };
    hide(this.axes);
    hide(this.grid);
    hide(this.edges);
    const previousBackground = this.scene.background;
    if (transparent) {
      this.scene.background = null;
      hide(this.room);
      hide(this.ground);
      hide(this.floor);
      hide(this.reflection);
      this.renderer.setClearColor(0x000000, 0);
    }
    this.renderer.render(this.scene, this.camera);
    let dataUrl = '';
    try {
      dataUrl = this.renderer.domElement.toDataURL('image/png');
    } finally {
      hidden.forEach(([obj, visible]) => {
        obj.visible = visible;
      });
      this.scene.background = previousBackground;
      this.applySettings(this.settings, { materials: false, room: true, reflection: true });
    }
    return dataUrl;
  }

  resize() {
    if (this.disposed) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.envTarget?.dispose();
    this.gradient?.dispose();
    this.removeModel();
    this.scene.traverse((child) => {
      const mesh = asMesh(child);
      if (!mesh) return;
      mesh.geometry?.dispose();
      materialsOf(mesh).forEach((mat) => mat?.dispose());
    });
    this.scene.clear();
    this.controls.dispose();
    this.renderer.dispose();
  }

  // ------------------------------------------------------------ model

  private removeModel() {
    if (this.reflection) {
      this.reflection.removeFromParent();
      this.disposeReflection(this.reflection);
      this.reflection = null;
    }
    if (this.edges) {
      this.edges.removeFromParent();
      disposeObject3D(this.edges);
      this.edges = null;
    }
    if (this.model) {
      this.model.removeFromParent();
      disposeObject3D(this.model);
      this.model = null;
    }
    this.parts = [];
    this.focusPartId = 'all';
  }

  private centerModel(model: THREE.Object3D) {
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    this.turntable.rotation.set(0, 0, 0);
    model.position.set(0, 0, 0);
    model.updateMatrixWorld(true);
    const seated = new THREE.Box3().setFromObject(model);
    const center = seated.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    this.seatOnFloor(model, 0);
    this.modelSize.copy(seated.getSize(new THREE.Vector3()));
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim === 0) return;
    this.frameCamera(size, 'iso');
    this.axes.scale.setScalar((maxDim * 0.6) / 100);
    this.updateGround(model);
  }

  private updateDimensions(object: THREE.Object3D) {
    const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
    this.events.dimensions(`Dimensions: ${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`);
  }

  private frameCamera(size: THREE.Vector3, name: CameraView, origin?: THREE.Vector3) {
    const ox = origin?.x || 0;
    const oy = origin?.y || 0;
    const oz = origin?.z || 0;
    const plate = isPlateLike(size);
    const span = Math.max(size.x, size.z, 1);
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const lookY = oy + (plate ? size.y * 0.7 : size.y * 0.4);
    const dist = plate ? span * (name === 'fit' ? 0.85 : 0.98) : maxDim * (name === 'fit' ? 1.45 : 1.7);
    const elev = plate ? Math.max(size.y * 2.8, span * 0.26) : lookY - oy + dist * 0.42;
    const side = plate ? 1.05 : 1.15;
    const lift = plate ? size.y : 0;
    const views: Record<CameraView, [number, number, number]> = {
      iso: [ox + dist, oy + elev, oz + dist],
      front: [ox, lookY + lift, oz + dist * side],
      back: [ox, lookY + lift, oz - dist * side],
      left: [ox - dist * side, lookY + lift, oz],
      right: [ox + dist * side, lookY + lift, oz],
      top: [ox + 0.01, oy + Math.max(dist * 1.05, span * 1.1), oz + 0.01],
      fit: [ox + dist, oy + (plate ? elev : lookY - oy + dist * 0.38), oz + dist]
    };
    const pos = views[name] || views.iso;
    this.camera.position.set(pos[0], pos[1], pos[2]);
    this.camera.lookAt(ox, lookY, oz);
    if (this.controls) {
      this.controls.target.set(ox, lookY, oz);
      this.controls.update();
    }
  }

  private discoverParts(root: THREE.Object3D) {
    this.parts = [];
    this.focusPartId = 'all';
    const marked: THREE.Object3D[] = [];
    root.traverse((child) => {
      if (child !== root && child.userData?.previewPart) marked.push(child);
    });
    let candidates = marked;
    if (candidates.length < 2 && (root as THREE.Group).isGroup) {
      const kids = root.children.filter((child) => (child as THREE.Mesh).isMesh || (child as THREE.Group).isGroup);
      if (kids.length > 1) candidates = kids;
    }
    if (candidates.length >= 2) {
      const set = new Set(candidates);
      candidates = candidates.filter((child) => {
        for (let parent = child.parent; parent && parent !== root; parent = parent.parent) if (set.has(parent)) return false;
        return true;
      });
    }
    if (candidates.length >= 2) {
      this.parts = candidates.map((object, index) => ({
        id: String(object.userData?.previewPartId ?? index),
        name: object.name || `Part ${index + 1}`,
        object
      }));
    }
    this.events.parts(
      this.parts.map(({ id, name }) => ({ id, name })),
      this.focusPartId
    );
  }

  private focusObject(): THREE.Object3D | null {
    if (this.focusPartId === 'all' || !this.parts.length) return this.model;
    return this.parts.find((part) => part.id === this.focusPartId)?.object || this.model;
  }

  // ------------------------------------------------------------ picking

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (!this.sitOnFace && this.parts.length < 2) return;
    this.pickStart = { x: event.clientX, y: event.clientY };
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.sitOnFace) return;
    const hit = this.raycast(event);
    if (hit) this.showFaceHighlight(hit);
    else if (this.faceHighlight) this.faceHighlight.visible = false;
  };

  private onPointerLeave = () => {
    if (this.sitOnFace && this.faceHighlight) this.faceHighlight.visible = false;
  };

  private onPointerUp = (event: PointerEvent) => {
    const start = this.pickStart;
    this.pickStart = null;
    if (!start || event.button !== 0) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (dx * dx + dy * dy > 16) return; // a drag, not a click
    const hit = this.raycast(event);
    if (this.sitOnFace) {
      if (hit) this.sitOnPickedFace(hit);
      return;
    }
    if (this.parts.length < 2 || !hit) return;
    for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) {
      const part = this.parts.find((entry) => entry.object === node);
      if (part) {
        this.focusPart(part.id);
        return;
      }
    }
  };

  private raycast(event: PointerEvent): THREE.Intersection | null {
    const rect = this.canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, this.camera);
    const meshes: THREE.Object3D[] = [];
    this.focusObject()?.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && child.visible && child !== this.faceHighlight) meshes.push(child);
    });
    return raycaster.intersectObjects(meshes, false).find((hit) => hit.face) || null;
  }

  private worldFaceNormal(hit: THREE.Intersection): THREE.Vector3 | null {
    if (!hit.face) return null;
    const normal = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
    return normal.lengthSq() > 1e-10 ? normal : null;
  }

  private showFaceHighlight(hit: THREE.Intersection) {
    const normal = this.worldFaceNormal(hit);
    if (!normal) return;
    if (!this.faceHighlight) {
      this.faceHighlight = new THREE.Mesh(
        new THREE.CircleGeometry(1, 40),
        new THREE.MeshBasicMaterial({
          color: 0x4a9eff,
          transparent: true,
          opacity: 0.42,
          side: THREE.DoubleSide,
          depthTest: false
        })
      );
      this.faceHighlight.renderOrder = 20;
      this.scene.add(this.faceHighlight);
    }
    const span = Math.max(this.modelSize.x, this.modelSize.y, this.modelSize.z, 8);
    this.faceHighlight.scale.setScalar(Math.max(span * 0.1, 2));
    this.faceHighlight.position.copy(hit.point).addScaledVector(normal, Math.max(span * 0.002, 0.08));
    this.faceHighlight.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    this.faceHighlight.visible = true;
  }

  /** Turn the model so the picked face lies flat on the floor. */
  private sitOnPickedFace(hit: THREE.Intersection) {
    const normal = this.worldFaceNormal(hit);
    const model = this.model;
    if (!normal || !model) return;
    const align = new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, -1, 0));
    const parentQ = new THREE.Quaternion();
    model.parent?.getWorldQuaternion(parentQ);
    const currentQ = model.getWorldQuaternion(new THREE.Quaternion());
    model.quaternion.copy(parentQ.invert().multiply(align.multiply(currentQ)));
    model.updateMatrixWorld(true);
    this.afterPoseChange();
  }

  private afterPoseChange() {
    const model = this.model;
    if (!model) return;
    model.updateMatrixWorld(true);
    const box = this.visibleWorldBox(model);
    if (Number.isFinite(box.min.y)) {
      const center = box.getCenter(new THREE.Vector3());
      model.position.x -= center.x;
      model.position.z -= center.z;
      this.seatOnFloor(model, 0);
      this.modelSize.copy(this.visibleWorldBox(model).getSize(new THREE.Vector3()));
    }
    this.setSitOnFace(false);
    this.updateGround(model);
    this.updateDimensions(model);
    this.applySettings(this.settings, { materials: false, room: true, reflection: true });
    this.frameCamera(this.modelSize, 'iso');
  }

  /** Bounds of the visible meshes only (hidden parts and the face marker do not count). */
  private visibleWorldBox(root: THREE.Object3D): THREE.Box3 {
    const box = new THREE.Box3();
    let found = false;
    root.updateMatrixWorld(true);
    root.traverse((child) => {
      const mesh = asMesh(child);
      if (!mesh?.geometry || mesh === this.faceHighlight) return;
      for (let node: THREE.Object3D | null = mesh; node && node !== root.parent; node = node.parent) {
        if (!node.visible) return;
        if (node === root) break;
      }
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const childBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
      if (found) box.union(childBox);
      else {
        box.copy(childBox);
        found = true;
      }
    });
    return found ? box : new THREE.Box3().setFromObject(root);
  }

  private seatOnFloor(model: THREE.Object3D, floorY = 0) {
    model.updateMatrixWorld(true);
    const box = this.visibleWorldBox(model);
    if (!Number.isFinite(box.min.y)) return;
    const lift = floorY - box.min.y;
    if (Math.abs(lift) > 1e-8) {
      model.position.y += lift;
      model.updateMatrixWorld(true);
    }
    this.floorY = floorY;
  }

  // ------------------------------------------------------------ studio

  private createEnvironment() {
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envScene = new THREE.Scene();
      envScene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.15 * LIGHT));
      const key = new THREE.DirectionalLight(0xfff4e5, 2.2 * LIGHT);
      key.position.set(6, 10, 4);
      const fill = new THREE.DirectionalLight(0xa8c4ff, 0.9 * LIGHT);
      fill.position.set(-8, 3, -5);
      const rim = new THREE.DirectionalLight(0xffffff, 0.6 * LIGHT);
      rim.position.set(0, 4, -8);
      envScene.add(key, fill, rim);
      this.envTarget = pmrem.fromScene(envScene, 0.04);
      pmrem.dispose();
      this.scene.environment = this.envTarget.texture;
    } catch (error) {
      console.warn('[Preview] Could not create studio environment:', error);
    }
  }

  private backdropColor(): THREE.Color {
    return new THREE.Color(backdropHex(this.settings)).convertSRGBToLinear();
  }

  private reflectionWell() {
    return Math.max(this.modelSize.y * 2.6, 8);
  }

  private placeBox() {
    const size = this.ground.scale.x || 1;
    const well = this.floor.visible ? this.reflectionWell() : 0;
    this.ground.position.set(0, this.floorY + size / 2 - well, 0);
  }

  private updateGround(model: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(model);
    this.floorY = box.min.y;
    this.modelSize.copy(box.getSize(new THREE.Vector3()));
    this.placeBox();
    this.floor.position.y = this.floorY + 0.02;
    this.grid.position.y = this.floorY + 0.03;
  }

  private rebuildRoom() {
    const s = this.settings;
    const maxDim = Math.max(this.modelSize.x, this.modelSize.y, this.modelSize.z, 20);
    const size = maxDim * 7;
    const color = this.backdropColor();
    const showBox = !s.transparent && s.background !== 'gradient';
    this.ground.scale.set(size, size, size);
    this.placeBox();
    this.ground.visible = showBox;
    this.ground.material.color.copy(color);
    this.ground.receiveShadow = s.shadow > 0 && !s.even;
    this.floor.scale.set(size, size, 1);
    this.floor.position.set(0, this.floorY + 0.02, 0);
    this.floor.material.color.copy(color);
    this.floor.visible = showBox && s.reflection > 0;
    this.grid.scale.set(size, 1, size);
    this.grid.position.set(0, this.floorY + 0.05, 0);
  }

  private gradientTexture(top: string, bottom: string): THREE.CanvasTexture {
    this.gradient?.dispose();
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, top);
    gradient.addColorStop(1, bottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 4, 256);
    this.gradient = new THREE.CanvasTexture(canvas);
    this.gradient.needsUpdate = true;
    return this.gradient;
  }

  private captureOriginalMaterials(object: THREE.Object3D) {
    object.traverse((child) => {
      const mesh = asMesh(child);
      if (!mesh || mesh.userData.originalMaterial) return;
      mesh.userData.originalMaterial = materialsOf(mesh).map((mat) => (mat ? mat.clone() : mat));
      mesh.userData.originalWasArray = Array.isArray(mesh.material);
    });
  }

  private restoreOriginalMaterials() {
    this.model?.traverse((child) => {
      const mesh = asMesh(child);
      const originals: THREE.Material[] | undefined = mesh?.userData.originalMaterial;
      if (!mesh || !originals) return;
      materialsOf(mesh).forEach((mat) => {
        if (mat && !originals.includes(mat)) mat.dispose();
      });
      mesh.material = mesh.userData.originalWasArray ? originals.map((mat) => mat?.clone()) : originals[0]?.clone();
    });
  }

  private applyWireframe() {
    this.model?.traverse((child) => {
      const mesh = asMesh(child);
      if (!mesh) return;
      materialsOf(mesh).forEach((mat) => {
        if (!mat) return;
        (mat as THREE.MeshStandardMaterial).wireframe = this.wireframe;
        mat.needsUpdate = true;
      });
    });
  }

  private applySurface() {
    const s = this.settings;
    if (!this.model) return;
    if (s.finish === 'original') {
      this.restoreOriginalMaterials();
      this.applyWireframe();
      this.updateEdges();
      return;
    }
    const preset = FINISHES[s.finish] || FINISHES.matte;
    const mix = Math.max(0, Math.min(1, (s.finishIntensity ?? 100) / 100));
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const color = new THREE.Color(s.color || STUDIO_DEFAULTS.color);
    const metalness = lerp(0.04, preset.metalness, mix);
    const roughness = lerp(0.55, preset.roughness, mix);
    const envMapIntensity = s.finish === 'chrome' ? 1.6 : s.finish === 'metal' ? 1.1 : 0.55;
    this.model.traverse((child) => {
      const mesh = asMesh(child);
      if (!mesh) return;
      const sources: THREE.Material[] = mesh.userData.originalMaterial || materialsOf(mesh);
      const next = sources.map((source) => {
        const src = source as THREE.MeshStandardMaterial | undefined;
        const params: THREE.MeshStandardMaterialParameters = {
          color: src?.map ? 0xffffff : color,
          map: src?.map || null,
          metalness,
          roughness,
          flatShading: false,
          vertexColors: false,
          transparent: !!src?.transparent,
          opacity: typeof src?.opacity === 'number' ? src.opacity : 1,
          envMapIntensity,
          side: src?.side ?? THREE.FrontSide
        };
        const material = preset.clearcoat
          ? new THREE.MeshPhysicalMaterial({ ...params, clearcoat: preset.clearcoat * mix, clearcoatRoughness: preset.clearcoatRoughness })
          : new THREE.MeshStandardMaterial(params);
        material.wireframe = this.wireframe;
        return material;
      });
      const originals: THREE.Material[] = mesh.userData.originalMaterial || [];
      materialsOf(mesh).forEach((mat) => {
        if (mat && !originals.includes(mat)) mat.dispose();
      });
      mesh.material = mesh.userData.originalWasArray ? next : next[0];
    });
    this.updateEdges();
  }

  private updateEdges() {
    if (this.edges) {
      this.edges.removeFromParent();
      disposeObject3D(this.edges);
      this.edges = null;
    }
    if (!this.model || !this.settings.edges) return;
    const group = new THREE.Group();
    let meshCount = 0;
    this.model.traverse((child) => {
      const mesh = asMesh(child);
      if (!mesh?.geometry || meshCount > 12) return;
      if ((mesh.geometry.attributes.position?.count || 0) > 80000) return;
      meshCount += 1;
      try {
        const lines = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry, 25),
          new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.35 })
        );
        lines.position.copy(mesh.getWorldPosition(new THREE.Vector3()));
        lines.quaternion.copy(mesh.getWorldQuaternion(new THREE.Quaternion()));
        lines.scale.copy(mesh.getWorldScale(new THREE.Vector3()));
        group.add(lines);
      } catch {
        /* skip dense meshes */
      }
    });
    this.edges = group;
    this.turntable.add(group);
  }

  private disposeReflection(object: THREE.Object3D) {
    object.traverse((child) => {
      const mesh = asMesh(child);
      if (mesh)
        materialsOf(mesh).forEach((mat) => {
          if (mat?.userData?.previewReflection) mat.dispose();
        });
    });
  }

  /** A mirrored, faded copy of the model under the floor. */
  private updateReflection() {
    const s = this.settings;
    if (this.reflection) {
      this.reflection.removeFromParent();
      this.disposeReflection(this.reflection);
      this.reflection = null;
    }
    this.floor.visible = !s.transparent && s.reflection > 0;
    if (!this.model || s.transparent || s.reflection <= 0) return;
    const sourceBox = new THREE.Box3().setFromObject(this.model);
    const floorY = Number.isFinite(this.floorY) ? this.floorY : sourceBox.min.y;
    const gap = Math.max(0, s.reflectionGap || 0);
    const strength = Math.max(0.2, Math.min(0.85, s.reflection / 100));
    const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), floorY - 0.01);
    const mirror = new THREE.Group();
    const clone = this.model.clone(true);
    clone.traverse((child) => {
      const mesh = asMesh(child);
      if (!mesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const next = materialsOf(mesh).map((mat) => {
        const reflected = mat ? mat.clone() : new THREE.MeshStandardMaterial({ color: 0xffffff });
        reflected.transparent = true;
        reflected.opacity = strength;
        reflected.depthWrite = false;
        reflected.side = THREE.DoubleSide;
        reflected.clippingPlanes = [clipPlane];
        reflected.clipShadows = true;
        reflected.userData.previewReflection = true;
        reflected.needsUpdate = true;
        return reflected;
      });
      mesh.material = Array.isArray(mesh.material) ? next : next[0];
    });
    mirror.add(clone);
    mirror.scale.set(1, -1, 1);
    mirror.position.set(0, 2 * floorY - gap, 0);
    mirror.renderOrder = -2;
    this.reflection = mirror;
    this.turntable.add(mirror);
  }

  private applyLights() {
    const s = this.settings;
    const maxDim = Math.max(this.modelSize.x, this.modelSize.y, this.modelSize.z, 20);
    const reach = maxDim * 3.2;
    const az = (s.lightRot * Math.PI) / 180;
    const el = (s.lightHeight * Math.PI) / 180;
    const lookY = this.modelSize.y * 0.4;
    this.key.position.set(Math.sin(az) * Math.cos(el) * reach, Math.sin(el) * reach, Math.cos(az) * Math.cos(el) * reach);
    this.key.target.position.set(0, lookY, 0);
    this.key.target.updateMatrixWorld();
    this.key.intensity = (s.even ? 0.35 : s.light / 100) * LIGHT;
    this.key.castShadow = !s.even && s.shadow > 0 && !s.transparent;
    this.key.shadow.radius = 1 + (s.shadowSmooth / 100) * 10;
    const cam = this.key.shadow.camera;
    const extent = maxDim * 1.5;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 0.5;
    cam.far = reach * 3;
    cam.updateProjectionMatrix();
    this.fill.position.set(-reach * 0.7, reach * 0.35, -reach * 0.4);
    this.fill.intensity = (s.even ? 0.85 : 0.28) * LIGHT;
    this.back.position.set(reach * 0.15, reach * 0.55, -reach * 0.85);
    this.back.intensity = (s.even ? 0.55 : 0.22) * LIGHT;
    this.ambient.intensity = (s.even ? 1.05 : 0.42) * LIGHT;
    this.hemi.intensity = (s.even ? 0.7 : 0.32) * LIGHT;
    this.renderer.shadowMap.enabled = !s.even && s.shadow > 0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const showBox = !s.transparent && s.background !== 'gradient';
    this.ground.visible = showBox;
    this.ground.receiveShadow = showBox && s.shadow > 0 && !s.even;
    this.ground.material.color.copy(this.backdropColor());
    const strength = Math.max(0, Math.min(1, s.reflection / 100));
    this.floor.material.opacity = 0.12 + (1 - strength) * 0.2;
    this.floor.material.metalness = 0.06;
    this.floor.material.roughness = 0.5;
    this.floor.material.envMapIntensity = 0.15;
    this.floor.material.needsUpdate = true;
  }

  private applySettings(settings: StudioSettings, options: ApplyOptions = {}) {
    const s = settings;
    if (s.transparent) {
      this.gradient?.dispose();
      this.gradient = null;
      this.scene.background = null;
    } else if (s.background === 'gradient') {
      const hex = backdropHex(s);
      const top = new THREE.Color(hex).offsetHSL(0, 0, 0.08);
      const bottom = new THREE.Color(hex).offsetHSL(0, 0, -0.12);
      this.scene.background = this.gradientTexture(`#${top.getHexString()}`, `#${bottom.getHexString()}`);
    } else {
      this.gradient?.dispose();
      this.gradient = null;
      this.scene.background = this.backdropColor();
    }
    this.scene.environment = this.envTarget ? this.envTarget.texture : null;
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    if (this.controls) {
      this.controls.autoRotate = !!s.autoRotate;
      this.controls.autoRotateSpeed = 2 * Math.max(0.1, (s.rotateSpeed || 100) / 100);
    }
    this.room.visible = !s.transparent;
    this.grid.visible = !!s.grid && !s.transparent;
    if (this.model) this.updateGround(this.model);
    if (options.onlyLights) {
      this.applyLights();
      return;
    }
    this.wireframe = !!s.wireframe;
    if (options.materials !== false) this.applySurface();
    else if (options.edges !== false) this.updateEdges();
    this.applyWireframe();
    if (options.room !== false) this.rebuildRoom();
    this.applyLights();
    if (options.reflection !== false) this.updateReflection();
    if (this.model && this.focusPartId === 'all') {
      this.seatOnFloor(this.model, 0);
      this.placeBox();
      this.floor.position.y = this.floorY + 0.02;
      this.grid.position.y = this.floorY + 0.03;
    }
  }

  private animate = () => {
    this.frame = requestAnimationFrame(this.animate);
    this.controls?.update();
    this.renderer.render(this.scene, this.camera);
  };
}
