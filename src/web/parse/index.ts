/** The parse worker's URL for the model loader (src/web/thumbnails/loader.ts). Vite builds it to web-build/parse-worker.js. */
import parseWorkerUrl from './worker.ts?worker&url';

declare global {
  interface Window {
    parseWorkerUrl?: string;
  }
}

window.parseWorkerUrl = parseWorkerUrl;
