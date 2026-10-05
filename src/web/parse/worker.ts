/**
 * Parse worker: turns model files (STL, 3MF, OBJ, PLY, STEP, IGES, LYS) into plain geometry
 * arrays off the main thread. src/web/thumbnails/loader.ts posts { id, fileExtension, url,
 * arrayBuffer, extraBuffers } and gets back { id, success, geometries | error }.
 *
 * Built by Vite as a classic worker (web-build/parse-worker.js) so it can importScripts the
 * helpers that are not modules: the XML parser 3MFLoader needs (workers have no DOMParser),
 * OpenCascade (STEP/IGES, WebAssembly), and the 3MF, LYS and STL helpers shared with the server.
 */
import * as THREE from 'three';
import { unzipSync, type Unzipped } from 'three/examples/jsm/libs/fflate.module.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';

interface ParseRequest {
  id: string;
  fileExtension: string;
  url?: string;
  arrayBuffer?: ArrayBuffer;
  extraBuffers?: ArrayBuffer[];
}

interface WorkerGlobals {
  importScripts(...urls: string[]): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ParseRequest>) => void) | null;
  location: { href: string };
  DOMParser?: unknown;
  __xmldom?: { DOMParser: unknown };
  ThreeMFMeshExtract?: {
    zipHasSplitModelParts?: (names: string[]) => boolean;
    extractAllMeshesFast: (xmlParts: string[], targetTriangles: number) => { positions: Float32Array; indices?: Uint32Array };
  };
  parseLysGeometry?: { parseLysGeometries: (bytes: Uint8Array) => { positions: Float32Array; indices?: Uint32Array }[] };
  classifyStlBuffer?: (buffer: ArrayBuffer) => string;
  normalsAreMissing?: (normals: ArrayLike<number>) => boolean;
  repairZeroFaceNormals?: (positions: ArrayLike<number>, normals: ArrayLike<number>) => number;
  occtimportjs?: (options: { locateFile: (path: string) => string }) => Promise<Occt>;
}

interface OcctMesh {
  attributes?: { position?: { array?: number[] } | number[]; normal?: { array?: number[] } | number[] };
  index?: { array?: number[] } | number[];
  color?: number[];
}

interface Occt {
  ReadStepFile(bytes: Uint8Array, params: object): { success?: boolean; meshes?: OcctMesh[]; error?: string; message?: string };
  ReadIgesFile(bytes: Uint8Array, params: object): { success?: boolean; meshes?: OcctMesh[]; error?: string; message?: string };
}

const worker = self as unknown as WorkerGlobals;
/** The app's root, from this script's URL (…/web-build/parse-worker.js). */
const appUrl = (file: string) => new URL(`../${file}`, worker.location.href).href;

worker.importScripts(appUrl('vendor/xmldom-worker-bundle.js'));
if (typeof worker.DOMParser === 'undefined' && worker.__xmldom) worker.DOMParser = worker.__xmldom.DOMParser;
worker.importScripts(
  appUrl('vendor/worker-xmldom-queryselector-polyfill.js'),
  appUrl('threemf-mesh-extract.js'),
  appUrl('parse-lys-geometry.js'),
  appUrl('stl-sanity.js')
);

const THUMBNAIL_3MF_TARGET_TRIANGLES = 200000;
const FAST_3MF_XML_BYTES = 2 * 1024 * 1024;
const STEP_TESS_PARAMS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.01,
  angularDeflection: 0.5
};

function errorMessage(error: unknown): string {
  if (!error) return 'Unknown worker parse error';
  if (typeof error === 'string') return error;
  return (error as Error).message || String(error);
}

async function fetchArrayBuffer(url?: string): Promise<ArrayBuffer> {
  if (!url) throw new Error('No model data');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to read model (${res.status})`);
  return res.arrayBuffer();
}

/** A copy that owns exactly its bytes (some loaders read buffer.byteLength). */
function tightArrayBuffer(data: unknown): ArrayBuffer | null {
  let view: Uint8Array;
  if (data instanceof ArrayBuffer) view = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else return null;
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

// ------------------------------------------------------------------ 3MF

function shouldUseFast3mf(zip: Unzipped): boolean {
  const names = Object.keys(zip);
  if (worker.ThreeMFMeshExtract?.zipHasSplitModelParts?.(names)) return true;
  let modelBytes = 0;
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.model')) continue;
    modelBytes += zip[name]?.length || 0;
    if (modelBytes > FAST_3MF_XML_BYTES) return true;
  }
  return false;
}

/** Big or split 3MF: read the vertex lists directly (simplified), skipping the XML DOM. */
function parse3mfFast(zip: Unzipped): THREE.BufferGeometry {
  const extract = worker.ThreeMFMeshExtract;
  if (!extract) throw new Error('3MF fast extractor is not available');
  const decoder = new TextDecoder();
  const xmlParts = Object.keys(zip).filter((name) => name.toLowerCase().endsWith('.model')).map((name) => decoder.decode(zip[name]));
  if (!xmlParts.length) throw new Error('No .model parts found in 3MF file');
  const mesh = extract.extractAllMeshesFast(xmlParts, THUMBNAIL_3MF_TARGET_TRIANGLES);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  if (mesh.indices && mesh.indices.length >= 3) geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

function parse3mf(buffer: ArrayBuffer): THREE.Object3D | THREE.BufferGeometry {
  let zip: Unzipped | null = null;
  try {
    zip = unzipSync(new Uint8Array(buffer));
  } catch {
    zip = null;
  }
  if (zip && shouldUseFast3mf(zip)) return parse3mfFast(zip);
  try {
    return new ThreeMFLoader().parse(buffer);
  } catch (error) {
    if (zip) return parse3mfFast(zip);
    throw error;
  }
}

// ------------------------------------------------------------------ STEP / IGES

let occtPromise: Promise<Occt> | null = null;

function occt(): Promise<Occt> {
  if (!occtPromise) {
    worker.importScripts(appUrl('vendor/occt-import-js/occt-import-js.js'));
    if (!worker.occtimportjs) throw new Error('STEP importer is not available');
    occtPromise = worker.occtimportjs({
      locateFile: (assetPath) => (String(assetPath).endsWith('.wasm') ? appUrl('vendor/occt-import-js/occt-import-js.wasm') : assetPath)
    });
  }
  return occtPromise;
}

const arrayOf = (value: { array?: number[] } | number[] | undefined) => (Array.isArray(value) ? value : value?.array);
const toFloat32 = (values: ArrayLike<number>) => (values instanceof Float32Array ? values : Float32Array.from(values || []));
function toIndexArray(values: ArrayLike<number> | undefined) {
  if (!values || !values.length) return null;
  if (values instanceof Uint32Array || values instanceof Uint16Array) return values;
  return values.length > 65535 ? Uint32Array.from(values) : Uint16Array.from(values);
}

function appendCadMeshes(group: THREE.Group, meshes: OcctMesh[] | undefined) {
  for (const mesh of meshes || []) {
    const positions = arrayOf(mesh?.attributes?.position);
    if (!positions || positions.length < 9) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(toFloat32(positions), 3));
    const normals = arrayOf(mesh.attributes?.normal);
    if (normals && normals.length >= positions.length) geometry.setAttribute('normal', new THREE.BufferAttribute(toFloat32(normals), 3));
    const index = toIndexArray(arrayOf(mesh.index));
    if (index) geometry.setIndex(new THREE.BufferAttribute(index, 1));
    if (Array.isArray(mesh.color) && mesh.color.length >= 3) geometry.userData.color = mesh.color.slice(0, 3);
    group.add(new THREE.Mesh(geometry));
  }
}

async function parseCad(buffer: ArrayBuffer, extraBuffers: ArrayBuffer[], format: 'step' | 'iges'): Promise<THREE.Group> {
  const lib = await occt();
  const label = format === 'iges' ? 'IGES' : 'STEP';
  const read = (bytes: ArrayBuffer, kind: 'step' | 'iges') => (kind === 'iges'
    ? lib.ReadIgesFile(new Uint8Array(bytes), STEP_TESS_PARAMS)
    : lib.ReadStepFile(new Uint8Array(bytes), STEP_TESS_PARAMS));
  const group = new THREE.Group();
  const primary = read(buffer, format);
  if (!primary || primary.success === false) {
    if (format === 'iges' || !extraBuffers.length) throw new Error(primary?.error || primary?.message || `${label} import failed`);
  } else {
    appendCadMeshes(group, primary.meshes);
  }
  // A STEP assembly whose parts are separate files: the main file has no geometry.
  if (!group.children.length && format === 'step') {
    for (const part of extraBuffers) {
      const result = read(part, 'step');
      if (result && result.success !== false) appendCadMeshes(group, result.meshes);
    }
  }
  if (!group.children.length) throw new Error(`No mesh geometry found in ${label} file`);
  return group;
}

// ------------------------------------------------------------------ LYS

function parseLys(buffer: ArrayBuffer): THREE.Group {
  const api = worker.parseLysGeometry;
  if (!api) throw new Error('LYS geometry parser is not available');
  const group = new THREE.Group();
  for (const mesh of api.parseLysGeometries(new Uint8Array(buffer))) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    if (mesh.indices && mesh.indices.length >= 3) {
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      const flat = geometry.toNonIndexed();
      flat.computeVertexNormals();
      group.add(new THREE.Mesh(flat));
    } else {
      geometry.computeVertexNormals();
      group.add(new THREE.Mesh(geometry));
    }
  }
  if (!group.children.length) throw new Error('No mesh geometry found in LYS file');
  return group;
}

// ------------------------------------------------------------------ results

function ensureRenderableNormals(geometry: THREE.BufferGeometry) {
  const position = geometry.attributes.position;
  if (!position || position.array.length < 9) return;
  const normal = geometry.attributes.normal;
  if (!geometry.index && normal) worker.repairZeroFaceNormals?.(position.array, normal.array);
  if (!normal || worker.normalsAreMissing?.(normal.array)) geometry.computeVertexNormals();
}

function extractGeometry(geometry: THREE.BufferGeometry, matrix: number[] | null, transfer: Transferable[], color: unknown) {
  const position = geometry.attributes.position?.array;
  if (!position || position.length < 9) return null;
  const normal = geometry.attributes.normal?.array || null;
  const uv = geometry.attributes.uv?.array || null;
  const index = geometry.index?.array || null;
  for (const array of [position, normal, uv, index]) if (array) transfer.push(array.buffer as ArrayBuffer);
  return { position, normal, uv, index, matrix, color: Array.isArray(color) && color.length >= 3 ? color : null };
}

function send(id: string, object: THREE.Object3D | THREE.BufferGeometry) {
  const geometries: unknown[] = [];
  const transfer: Transferable[] = [];
  if ((object as THREE.BufferGeometry).isBufferGeometry) {
    const geometry = object as THREE.BufferGeometry;
    geometry.computeBoundingBox();
    geometry.center();
    ensureRenderableNormals(geometry);
    const geo = extractGeometry(geometry, null, transfer, geometry.userData?.color);
    if (geo) geometries.push(geo);
  } else {
    const root = object as THREE.Object3D;
    root.updateMatrixWorld(true);
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      ensureRenderableNormals(mesh.geometry);
      const geo = extractGeometry(mesh.geometry, mesh.matrixWorld.elements.slice(), transfer, mesh.geometry.userData?.color || mesh.userData?.color);
      if (geo) geometries.push(geo);
    });
  }
  if (!geometries.length) {
    worker.postMessage({ id, success: false, error: 'No mesh geometry found in model' });
    return;
  }
  worker.postMessage({ id, success: true, geometries }, transfer);
}

async function parse(request: ParseRequest) {
  const { id, fileExtension: ext, url } = request;
  const buffer = async () => tightArrayBuffer(request.arrayBuffer) || await fetchArrayBuffer(url);
  try {
    if (ext === 'stl') {
      const data = await buffer();
      // Binary STLs with trailing bytes: parse only the declared triangles.
      if (worker.classifyStlBuffer?.(data) === 'binary') {
        const expected = 84 + new DataView(data).getUint32(80, true) * 50;
        send(id, new STLLoader().parse(data.byteLength === expected ? data : data.slice(0, expected)));
      } else {
        send(id, new STLLoader().parse(data));
      }
    } else if (ext === '3mf') {
      send(id, parse3mf(await buffer()));
    } else if (ext === 'obj') {
      const own = tightArrayBuffer(request.arrayBuffer);
      const text = own ? new TextDecoder().decode(own) : await (await fetch(url!)).text();
      send(id, new OBJLoader().parse(text));
    } else if (ext === 'ply') {
      send(id, new PLYLoader().parse(await buffer()));
    } else if (ext === 'step' || ext === 'stp' || ext === 'igs' || ext === 'iges') {
      const extra = (request.extraBuffers || []).map(tightArrayBuffer).filter((b): b is ArrayBuffer => !!b);
      send(id, await parseCad(await buffer(), extra, ext === 'igs' || ext === 'iges' ? 'iges' : 'step'));
    } else if (ext === 'lys') {
      send(id, parseLys(await buffer()));
    } else {
      throw new Error(`Unsupported file type: ${ext}`);
    }
  } catch (error) {
    worker.postMessage({ id, success: false, error: errorMessage(error) });
  }
}

// One file at a time (STEP tessellation is memory-hungry).
let queue: Promise<void> = Promise.resolve();
worker.onmessage = (event) => {
  queue = queue.then(() => parse(event.data)).catch((error) => {
    worker.postMessage({ id: event.data?.id, success: false, error: errorMessage(error) });
  });
};
