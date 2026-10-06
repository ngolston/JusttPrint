import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The React screens (src/web/) build into web-build/app.js, which index.html loads as a module.
// Screens mount into the existing page one at a time (see src/web/main.tsx).
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  // URLs relative to app.js (web-build/), e.g. the parse worker's.
  base: './',
  // The parse worker (src/web/parse/worker.ts) is a classic script so it can importScripts
  // the helpers that are not modules (XML parser, OpenCascade, the 3MF/LYS/STL helpers).
  worker: {
    format: 'iife',
    rollupOptions: { output: { entryFileNames: 'parse-worker.js' } }
  },
  build: {
    outDir: 'web-build',
    emptyOutDir: true,
    // No inline scripts or eval: the page's CSP only runs script files from the server.
    modulePreload: false,
    // three.js (three.js chunk) is loaded only when a preview opens or a thumbnail is drawn.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: 'src/web/main.tsx',
      output: {
        // A fixed name, so index.html can load it; the server sends JS with Cache-Control: no-cache.
        entryFileNames: 'app.js',
        chunkFileNames: '[name].js',
        // The stylesheet is app.css (index.html links it); fonts keep their names.
        assetFileNames: (asset) => (asset.names?.some((n) => n.endsWith('.css')) ? 'app.css' : '[name][extname]'),
        // three.js in its own chunk (three.js), shared by the 3D preview and the thumbnail renderer.
        manualChunks: (id) => (id.includes('/node_modules/three/') ? 'three' : undefined)
      }
    }
  }
});
