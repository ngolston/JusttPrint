/**
 * Load a model file and parse it in the parse worker (src/web/parse/worker.ts) into plain
 * geometry arrays, for the thumbnail render (render.ts) to turn into three.js meshes.
 * STEP files that reference other STEP files (assemblies) bring those files along.
 */
import { loadLibraryFileBuffer } from '../preview/files';
import { extensionOf, isRenderable3d } from './formats';
import type { GeometryData } from '../three/models';

declare global {
  interface Window {
    /** The parse worker's script URL (src/web/parse/index.ts). */
    parseWorkerUrl?: string;
    /** step-assembly.js: the files a STEP assembly names, and where they sit beside it. */
    StepAssembly?: {
      listStepExternalFileNames: (buffer: ArrayBuffer) => string[];
      siblingStepPath: (filePath: string, name: string) => string | null;
    };
  }
}

export interface ModelData {
  geometries: GeometryData[];
  fileExtension: string;
}

interface WorkerReply {
  id: string;
  success: boolean;
  error?: string;
  geometries?: GeometryData[];
}

const MAX_ASSEMBLY_FILES = 24;

async function tryRead(filePath: string): Promise<ArrayBuffer | null> {
  try {
    const buffer = await loadLibraryFileBuffer(filePath);
    return buffer && buffer.byteLength ? buffer : null;
  } catch {
    return null;
  }
}

/** The leaf files of a STEP assembly (the root is passed separately), at most 24. */
async function stepAssemblyBuffers(rootPath: string, rootBuffer: ArrayBuffer): Promise<ArrayBuffer[]> {
  const assembly = window.StepAssembly;
  if (!assembly) return [];
  const visited = new Set<string>();
  const leaves: ArrayBuffer[] = [];
  const walk = async (filePath: string, buffer: ArrayBuffer) => {
    if (leaves.length >= MAX_ASSEMBLY_FILES || visited.has(filePath.toLowerCase())) return;
    visited.add(filePath.toLowerCase());
    const names = assembly.listStepExternalFileNames(buffer);
    if (!names.length) {
      if (filePath !== rootPath) leaves.push(buffer);
      return;
    }
    for (const name of names) {
      if (leaves.length >= MAX_ASSEMBLY_FILES) return;
      const childPath = assembly.siblingStepPath(filePath, name);
      const child = childPath ? await tryRead(childPath) : null;
      if (childPath && child) await walk(childPath, child);
    }
  };
  await walk(rootPath, rootBuffer);
  return leaves;
}

/** STEP and IGES load a large WebAssembly module: keep one worker for them. */
let sharedWorker: Worker | null = null;
const sharedJobs = new Map<string, (reply: WorkerReply) => void>();

function cadWorker(): Worker {
  if (sharedWorker) return sharedWorker;
  const worker = new Worker(window.parseWorkerUrl!);
  worker.onmessage = (event: MessageEvent<WorkerReply>) => sharedJobs.get(event.data?.id)?.(event.data);
  worker.onerror = (event) => {
    console.error('Shared STEP parse worker failed:', event.message);
    const pending = [...sharedJobs.entries()];
    sharedJobs.clear();
    worker.terminate();
    sharedWorker = null;
    for (const [id, done] of pending) done({ id, success: false, error: event.message || 'STEP worker failed' });
  };
  sharedWorker = worker;
  return worker;
}

/** Parse a model file. Resolves to null when there is nothing to draw (URL models, other formats). */
export async function loadModelData(filePath: string): Promise<ModelData | null> {
  if (!filePath || filePath.startsWith('url::')) return null;
  const fileExtension = extensionOf(filePath);
  if (!isRenderable3d(fileExtension)) return null;
  if (!window.parseWorkerUrl) throw new Error('The parse worker is not available.');

  const buffer = await tryRead(filePath);
  const extraBuffers = buffer && (fileExtension === 'step' || fileExtension === 'stp')
    ? await stepAssemblyBuffers(filePath, buffer).catch((error) => {
      console.warn('STEP assembly resolve failed:', error);
      return [];
    })
    : [];
  // Without the bytes the worker fetches the file itself.
  const url = `${window.location.origin}${filePath.includes('::') ? '/api/download/' : '/api/file/'}${encodeURIComponent(filePath)}`;

  const shared = ['step', 'stp', 'igs', 'iges'].includes(fileExtension);
  const worker = shared ? cadWorker() : new Worker(window.parseWorkerUrl);
  const id = `${Date.now()}-${Math.random()}`;
  return new Promise<ModelData>((resolve, reject) => {
    const done = (reply: WorkerReply) => {
      if (shared) sharedJobs.delete(id);
      else worker.terminate();
      if (reply.success) resolve({ geometries: reply.geometries || [], fileExtension });
      else reject(new Error(reply.error || 'Unknown worker parse error'));
    };
    if (shared) {
      sharedJobs.set(id, done);
    } else {
      worker.onmessage = (event: MessageEvent<WorkerReply>) => { if (event.data?.id === id) done(event.data); };
      worker.onerror = (event) => done({ id, success: false, error: event.message || 'Parse worker failed' });
    }
    const transfer = [buffer, ...extraBuffers].filter((b): b is ArrayBuffer => !!b);
    worker.postMessage({
      id, fileExtension, url,
      arrayBuffer: buffer || undefined,
      extraBuffers: extraBuffers.length ? extraBuffers : undefined
    }, transfer);
  });
}
