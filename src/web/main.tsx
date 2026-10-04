/**
 * React screens, mounted into the existing page one at a time. Each screen replaces markup in
 * index.html and the matching code in renderer.js, and keeps the global function the rest of
 * the page calls to open it (window.openServerAccess, window.openTagManager, ...).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PartsManagerDialog } from './PartsManagerDialog';
import { ServerAccessDialog } from './ServerAccessDialog';
import { TagManagerDialog } from './TagManagerDialog';

function Screens() {
  return (
    <>
      <ServerAccessDialog />
      <TagManagerDialog />
      <PartsManagerDialog />
    </>
  );
}

const root = document.getElementById('react-root');
if (root) {
  createRoot(root).render(<StrictMode><Screens /></StrictMode>);
}
