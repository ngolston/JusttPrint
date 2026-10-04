import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The React screens (src/web/) build into web-build/app.js, which index.html loads as a module.
// Screens mount into the existing page one at a time (see src/web/main.tsx).
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'web-build',
    emptyOutDir: true,
    // No inline scripts or eval: the page's CSP only runs script files from the server.
    modulePreload: false,
    rollupOptions: {
      input: 'src/web/main.tsx',
      output: {
        // A fixed name, so index.html can load it; the server sends JS with Cache-Control: no-cache.
        entryFileNames: 'app.js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]'
      }
    }
  }
});
