import { useEffect, useRef, useState } from 'react';
import { thumbnails as thumbnailApi } from './api';
import { exposeGlobal, onServerEvent, showMessage } from './page';

declare global {
  interface Window {
    /** Open Manage Thumbnails for one model. */
    openManageThumbnails?: (filePath: string) => Promise<void>;
    /** renderer.js: redraw a model's card after its images changed. */
    refreshModelThumbnails?: (filePath: string) => Promise<void>;
  }
}

/** Stored images only: data URLs (the '3d.png' placeholder is not an image of the model). */
const usable = (list: string[] | null | undefined) =>
  (list || []).filter((t) => typeof t === 'string' && t !== '3d.png' && t.startsWith('data:image'));

const errorText = (error: unknown) => String((error as Error)?.message || error);

/**
 * Manage Thumbnails (#manage-thumbnails-dialog): pick the model's active image or delete others.
 * The card is redrawn when the dialog closes. Registers window.openManageThumbnails and answers
 * the server's 'manage-thumbnails-request' (the card's context menu).
 */
export function ManageThumbnailsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const changed = useRef(false);

  async function open(path: string) {
    let list: string[];
    try {
      list = usable(await thumbnailApi.list(path));
    } catch (error) {
      await showMessage('Manage Thumbnails', `Could not load the thumbnails: ${errorText(error)}`);
      return;
    }
    if (!list.length) {
      await showMessage('Manage Thumbnails', 'This model has no thumbnails to manage.');
      return;
    }
    changed.current = false;
    setFilePath(path);
    setImages(list);
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }

  useEffect(() => exposeGlobal('openManageThumbnails', open), []);
  useEffect(() => onServerEvent('manage-thumbnails-request', (path: string) => { if (path) open(path); }), []);

  async function reload() {
    if (filePath) setImages(usable(await thumbnailApi.list(filePath)));
  }

  async function makeActive(index: number) {
    if (!filePath || index === 0 || busy) return;
    setBusy(true);
    try {
      await thumbnailApi.setDefault(filePath, index);
      changed.current = true;
      await reload();
    } catch (error) {
      await showMessage('Error', `Error setting active thumbnail: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(index: number) {
    if (!filePath || busy) return;
    const answer = await showMessage('Delete Thumbnail', 'Are you sure you want to delete this thumbnail?', ['Delete', 'Cancel']);
    if (answer !== 'Delete') return;
    setBusy(true);
    try {
      await thumbnailApi.remove(filePath, index);
      changed.current = true;
      await reload();
    } catch (error) {
      await showMessage('Error', `Error deleting thumbnail: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function onClose() {
    if (filePath && changed.current) {
      changed.current = false;
      window.refreshModelThumbnails?.(filePath).catch((error) => console.error('Error refreshing the card:', error));
    }
  }

  return (
    <dialog id="manage-thumbnails-dialog" className="modal" ref={dialogRef} onClose={onClose}>
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); dialogRef.current?.close(); }}>
        <h3>Manage Thumbnails</h3>
        <div className="form-group">
          <p style={{ margin: '0 0 16px 0', color: '#aaa', fontSize: '0.9rem' }}>
            Select a thumbnail to set it as active, or delete thumbnails (the active thumbnail cannot be deleted).
          </p>
          <div id="thumbnails-grid" className="thumbnails-grid">
            {images.map((src, index) => (
              <div key={`${index}:${src.length}:${src.slice(-24)}`} className={`thumbnail-item${index === 0 ? ' active' : ''}`} data-index={index}
                onClick={(event) => { if (!(event.target as Element).closest('.thumbnail-item-button')) makeActive(index); }}>
                <img src={src} alt={`Thumbnail ${index + 1}`} />
                <div className="thumbnail-item-label">{index === 0 ? 'Active' : `Image ${index + 1}`}</div>
                <div className="thumbnail-item-overlay">
                  <button type="button" className="thumbnail-item-button set-active" disabled={index === 0 || busy}
                    onClick={(event) => { event.stopPropagation(); makeActive(index); }}>{index === 0 ? 'Active' : 'Set as Active'}</button>
                  {index !== 0 && images.length > 1 && (
                    <button type="button" className="thumbnail-item-button delete" disabled={busy}
                      onClick={(event) => { event.stopPropagation(); remove(index); }}>Delete</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="dialog-buttons">
          <button type="button" onClick={() => dialogRef.current?.close()}>Close</button>
        </div>
      </form>
    </dialog>
  );
}
