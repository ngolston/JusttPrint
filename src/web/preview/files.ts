/**
 * Read a library file's bytes for parsing in this browser: over HTTP from the server
 * (/api/file, or /api/download for ZIP entries), falling back to the bridge's IPC read.
 */

interface FileBridge {
  readModelFile?: (filePath: string) => Promise<unknown>;
  isServerMode?: () => Promise<boolean>;
}

const bridge = () => window.electron as (FileBridge & typeof window.electron) | undefined;

function toArrayBuffer(raw: unknown): ArrayBuffer | null {
  if (!raw) return null;
  if (raw instanceof ArrayBuffer) return raw;
  if (ArrayBuffer.isView(raw)) return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const view = raw as { buffer?: ArrayBuffer; byteOffset?: number; byteLength?: number; length?: number };
  if (view.buffer) {
    const start = view.byteOffset || 0;
    return view.buffer.slice(start, start + (view.byteLength || view.length || 0));
  }
  return null;
}

/** An error page or JSON instead of a model file. */
function looksLikeHtmlOrJson(buf: ArrayBuffer): boolean {
  if (!buf || buf.byteLength < 1) return true;
  const start = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(80, buf.byteLength))).trimStart().slice(0, 20).toLowerCase();
  return start.startsWith('<!') || start.startsWith('<html') || start.startsWith('{') || start.startsWith('file not');
}

export async function loadLibraryFileBuffer(filePath: string): Promise<ArrayBuffer> {
  const tryIpc = async () => (bridge()?.readModelFile ? toArrayBuffer(await bridge()!.readModelFile!(filePath)) : null);
  let serverMode = false;
  try {
    serverMode = !!(await bridge()?.isServerMode?.());
  } catch { /* desktop */ }
  const isZipEntry = String(filePath || '').includes('::');

  // Desktop local files: IPC first (the UI origin can answer /api/file with HTML).
  if (!serverMode && !isZipEntry) {
    const ipcBuf = await tryIpc();
    if (ipcBuf && ipcBuf.byteLength > 0 && !looksLikeHtmlOrJson(ipcBuf)) return ipcBuf;
  }

  const origin = window.location?.origin;
  if (origin && origin !== 'null' && /^https?:/i.test(origin) && filePath) {
    const url = `${origin}${isZipEntry ? '/api/download/' : '/api/file/'}${encodeURIComponent(filePath)}`;
    try {
      const response = await fetch(url);
      if (response.ok) {
        const httpBuf = await response.arrayBuffer();
        if (httpBuf && httpBuf.byteLength > 0 && !looksLikeHtmlOrJson(httpBuf)) return httpBuf;
      }
    } catch (error) {
      console.warn('[Preview] HTTP model fetch failed, falling back to IPC:', error);
    }
  }

  const ipcBuf = await tryIpc();
  if (ipcBuf && ipcBuf.byteLength > 0) return ipcBuf;
  throw new Error('Cannot read model file');
}
