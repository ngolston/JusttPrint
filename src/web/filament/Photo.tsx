import { useState } from 'react';
import { ImagePlus, Link2, Trash2 } from 'lucide-react';
import { type PhotoInput } from '../api';
import { Button } from '../components/Button';
import { EditOnly } from '../components/EditOnly';
import { askText, showMessage } from '../page';
import { choosePictures, shrinkImage } from './photos';

/*
 * A spool's or filament's photo with Add photo, Link and Remove for editors (docs/plan-10.1.md,
 * Phase 2). `onSave` sends the picture or link (or null to remove it); the caller reloads.
 */

export function PhotoBlock({
  photo,
  label,
  onSave,
  idPrefix
}: {
  photo: string | null | undefined;
  label: string;
  onSave: (photo: PhotoInput | null) => Promise<unknown>;
  idPrefix: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const upload = () =>
    run(async () => {
      const [file] = await choosePictures();
      if (file) await onSave({ dataUrl: await shrinkImage(file) });
    });
  const link = () =>
    run(async () => {
      const url = await askText('Photo link', 'The address of a picture on the web (https://…):', photo && /^https?:/.test(photo) ? photo : '');
      if (url && url.trim()) await onSave({ url: url.trim() });
    });
  const remove = () =>
    run(async () => {
      if ((await showMessage('Remove photo?', `Remove the photo of ${label}?`, ['Remove', 'Cancel'])) === 'Remove') await onSave(null);
    });
  return (
    <div className="jp-photo-block">
      {photo && (
        <a href={photo} target="_blank" rel="noopener noreferrer" className="jp-photo-block__frame">
          <img src={photo} alt={`Photo of ${label}`} className="jp-photo-block__img" loading="lazy" />
        </a>
      )}
      <EditOnly>
        <div className="jp-photo-block__actions">
          <Button size="sm" icon={ImagePlus} onClick={() => void upload()} disabled={busy} id={`${idPrefix}-photo-upload`}>
            {busy ? 'Saving…' : photo ? 'New photo' : 'Add photo'}
          </Button>
          <Button size="sm" variant="ghost" icon={Link2} onClick={() => void link()} disabled={busy}>
            Link
          </Button>
          {photo && (
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void remove()} disabled={busy}>
              Remove
            </Button>
          )}
        </div>
      </EditOnly>
      {error && (
        <p className="jp-filament-form__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
