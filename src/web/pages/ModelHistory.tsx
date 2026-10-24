import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { callAction, uploadFile, uploads } from '../api';
import { Button } from '../components/Button';
import { showMessage } from '../page';
import { useCan } from '../session';
import { invalidateThumbnail } from '../thumbnails/cache';

/** How each detail reads in the list of changes. */
export const FIELD_LABELS: Record<string, string> = {
  fileName: 'Name',
  designer: 'Designer',
  source: 'Source',
  title: 'Title',
  license: 'License',
  notes: 'Notes',
  description: 'Description',
  tags: 'Tags',
  rating: 'Rating',
  categories: 'Categories'
};

export const when = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** A value in the list of changes: short, "(none)" when empty; long text cut. */
export function shownValue(field: string, value: string | null): string {
  const text = String(value ?? '').trim();
  if (!text) return '(none)';
  if (field === 'rating') return text === '0' ? 'not rated' : `${'★'.repeat(Number(text) || 0)}`;
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A picture of the model's file as it is now, as its first picture (after Upload New Version). A
 * 3MF's own preview is used when it has one; the earlier pictures stay as extra pictures.
 */
export async function newPictureFrom(filePath: string) {
  try {
    const { makeThumbnail } = await import('../thumbnails/pipeline');
    const made = await makeThumbnail(filePath, { lighting: window.currentRenderLighting });
    const image = made.image && made.image.startsWith('data:image') ? made.image : null;
    if (!image) return void (await showMessage('Upload New Version', 'No picture could be made from the new file. The current picture stays.'));
    if (made.stored) {
      // A 3MF's previews were added as pictures: put the first one first.
      const pictures = await callAction<string[]>('get-all-thumbnails', filePath);
      const index = pictures.indexOf(image);
      if (index > 0) await callAction('set-default-thumbnail', filePath, index);
    } else {
      await callAction('add-thumbnail', filePath, image);
    }
    invalidateThumbnail(filePath);
    window.libraryGrid?.refresh();
  } catch (error) {
    await showMessage('Upload New Version', `No new picture: ${errorText(error)}`);
  }
}

/**
 * Upload New Version (a model's page): the file is replaced in place (same name and folder) and
 * the old one is kept in the history (the History page).
 */
export function UploadVersionButton({ filePath, folder, buttonless = false }: { filePath: string; folder: string; buttonless?: boolean }) {
  const canEdit = useCan('editor');
  const [progress, setProgress] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function uploadVersion(file: File) {
    const name = filePath.split(/[\\/]/).pop() || filePath;
    const answer = await showMessage('Upload New Version', `Replace ${name} with ${file.name}? The current file is kept in the History and can be put back.`, [
      'Replace',
      'Cancel'
    ]);
    if (answer !== 'Replace') return;
    setProgress(0);
    try {
      const info = await uploads.info().catch(() => null);
      const sent = await uploadFile(file, folder, { chunkBytes: info?.chunkBytes || 16 * 1024 * 1024, onProgress: setProgress });
      await callAction('replace-model-file', filePath, sent.filePath);
      const picture = await showMessage('Upload New Version', 'Make a new picture from the new file? The current pictures stay as extra pictures.', [
        'Make a New Picture',
        'Keep the Current Picture'
      ]);
      if (picture === 'Make a New Picture') await newPictureFrom(filePath);
    } catch (error) {
      await showMessage('Upload New Version', errorText(error));
    } finally {
      setProgress(null);
    }
  }

  if (!canEdit) return null;
  return (
    <>
      {buttonless ? (
        progress !== null && (
          <span className="jp-meta jp-model-upload__busy" role="status">
            Uploading the new version: {Math.round(progress * 100)}%
          </span>
        )
      ) : (
        <Button icon={Upload} id="jp-upload-version" disabled={progress !== null} onClick={() => input.current?.click()}>
          {progress !== null ? `Uploading ${Math.round(progress * 100)}%` : 'New Version'}
        </Button>
      )}
      <input
        ref={input}
        type="file"
        hidden
        id="jp-upload-version-file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void uploadVersion(file);
        }}
      />
    </>
  );
}
