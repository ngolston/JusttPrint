import { useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { prints, type PrintPhoto } from '../api';
import { IconButton } from '../components/Button';
import { choosePictures, shrinkImage } from '../filament/photos';
import { showMessage } from '../page';

/*
 * A logged print's photos (docs/plan-10.1.md, Phase 2): small pictures that open full size; editors
 * add more (up to 12) and remove them. Kept in this component's state, so the list need not reload.
 */

export function PrintPhotos({ eventId, photos, canEdit }: { eventId: number; photos: PrintPhoto[] | undefined; canEdit: boolean }) {
  const [list, setList] = useState<PrintPhoto[]>(photos || []);
  const [busy, setBusy] = useState(false);
  if (!list.length && !canEdit) return null;
  const add = async () => {
    const files = await choosePictures({ multiple: true });
    if (!files.length) return;
    setBusy(true);
    try {
      for (const file of files) {
        const added = await prints.addPhoto(eventId, { dataUrl: await shrinkImage(file) });
        setList((current) => [...current, added]);
      }
    } catch (error) {
      void showMessage('Photo not added', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (photo: PrintPhoto) => {
    if ((await showMessage('Remove photo?', 'Remove this photo of the print?', ['Remove', 'Cancel'])) !== 'Remove') return;
    try {
      await prints.removePhoto(photo.id);
      setList((current) => current.filter((p) => p.id !== photo.id));
    } catch (error) {
      void showMessage('Photo not removed', error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <div className="jp-print-photos" aria-label="Photos of this print">
      {list.map((photo) => (
        <span key={photo.id} className="jp-print-photos__item">
          <a href={photo.url} target="_blank" rel="noopener noreferrer" title={photo.caption || 'Open the photo'}>
            <img src={photo.url} alt={photo.caption || 'Photo of the print'} loading="lazy" />
          </a>
          {canEdit && <IconButton size="sm" icon={X} label="Remove this photo" className="jp-print-photos__remove" onClick={() => void remove(photo)} />}
        </span>
      ))}
      {canEdit && list.length < 12 && (
        <IconButton size="sm" icon={ImagePlus} label={busy ? 'Adding photos…' : 'Add photos of this print'} disabled={busy} onClick={() => void add()} />
      )}
    </div>
  );
}
