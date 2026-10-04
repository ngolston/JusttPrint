/**
 * React screens, mounted into the existing page one at a time. Each screen replaces markup in
 * index.html and the matching code in renderer.js, and keeps the global function the rest of
 * the page calls to open it.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ServerAccessDialog } from './ServerAccessDialog';

const serverAccessRoot = document.getElementById('server-access-root');
if (serverAccessRoot) {
  createRoot(serverAccessRoot).render(<StrictMode><ServerAccessDialog /></StrictMode>);
}
