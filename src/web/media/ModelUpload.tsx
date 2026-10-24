import { useCallback, useRef, useState } from 'react';
import { FolderUp } from 'lucide-react';
import { callAction, uploadFile, uploads, type MediaKind } from '../api';
import { Button } from '../components/Button';
import { showMessage } from '../page';
import { useCan } from '../session';
import { navigate } from '../shell/routes';
import { modelUploadTarget } from '../upload/plan';
import { folderOf, media as mediaApi } from './media';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const COUNT_LABELS: Record<MediaKind | 'model', [string, string]> = {
  image: ['picture', 'pictures'],
  video: ['video', 'videos'],
  document: ['document', 'documents'],
  other: ['other file', 'other files'],
  model: ['model file', 'model files']
};

/** "2 pictures, 1 model file". */
function countLine(counts: Partial<Record<MediaKind | 'model', number>>): string {
  return (Object.keys(COUNT_LABELS) as (MediaKind | 'model')[])
    .filter((kind) => counts[kind])
    .map((kind) => `${counts[kind]} ${COUNT_LABELS[kind][counts[kind] === 1 ? 0 : 1]}`)
    .join(', ');
}

/**
 * A model page's Upload (and files dropped on the page): anything into the model's own folder, made
 * first when it has none (src/server/tidy-model-folders.js ownFolder). Pictures, videos and
 * documents go into their subfolders, model files beside the model's files as its parts (listed on
 * its page, not in the library), anything else into other/.
 */
export function useModelUpload(filePath: string) {
  const [busy, setBusy] = useState('');
  const running = useRef(false);

  const upload = useCallback(
    async (files: File[]) => {
      if (!files.length || running.current) return;
      running.current = true;
      setBusy('Uploading…');
      try {
        const [info, found] = await Promise.all([uploads.info(), mediaApi.get(folderOf(filePath))]);
        let folder = found.isModelFolder && found.folder ? found.folder : '';
        let movedTo: string | null = null;
        if (!folder) {
          const answer = await showMessage(
            'Upload',
            'This model has no folder of its own yet, and uploads go into it. Make one first? When the model shares its folder with other models, it moves into a new folder named after it, with the files that belong to it; when it is alone there, that folder becomes its own and nothing moves.',
            ['Make Its Folder', 'Cancel']
          );
          if (answer !== 'Make Its Folder') return;
          setBusy('Making its folder…');
          const own = await callAction<{ folder: string; filePath: string; moved: boolean }>('model-own-folder', filePath);
          folder = own.folder;
          if (own.moved) movedTo = own.filePath;
        }
        const sent: string[] = [];
        const failed: string[] = [];
        const counts: Partial<Record<MediaKind | 'model', number>> = {};
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const target = modelUploadTarget(folder, file.name, info);
          const of = files.length > 1 ? ` (${i + 1} of ${files.length})` : '';
          setBusy(`Uploading ${file.name}${of}…`);
          try {
            const result = await uploadFile(file, target.folder, {
              chunkBytes: info.chunkBytes || 16 * 1024 * 1024,
              onProgress: (progress) => setBusy(`Uploading ${file.name}${of}: ${Math.round(progress * 100)}%`)
            });
            sent.push(result.filePath);
            counts[target.kind] = (counts[target.kind] || 0) + 1;
          } catch (error) {
            failed.push(`${file.name}: ${errorText(error)}`);
          }
        }
        let notAdded: string[] = [];
        if (sent.length) {
          setBusy('Adding…');
          const done = await uploads.finish(folder, sent, movedTo || filePath);
          notAdded = (done.notAdded || []).map((item) => `${item.name}: ${item.reason}`);
        }
        const lines = [
          sent.length ? `Added to the model's folder: ${countLine(counts)}.` : 'Nothing was added.',
          movedTo ? 'The model moved into its new folder.' : '',
          notAdded.length ? `Uploaded, not added as models:\n${notAdded.join('\n')}` : '',
          failed.length ? `Not uploaded:\n${failed.join('\n')}` : ''
        ].filter(Boolean);
        await showMessage('Upload', lines.join('\n\n'));
        if (movedTo) navigate('model', movedTo);
      } catch (error) {
        await showMessage('Upload', errorText(error));
      } finally {
        running.current = false;
        setBusy('');
      }
    },
    [filePath]
  );

  return { upload, busy };
}

/**
 * The Upload button: any files (several at once) into the model's folder. `buttonless` (the model
 * page, whose More menu opens it): only the file picker (`#<id>-file`) and the progress line.
 */
export function ModelUploadButton({
  upload,
  busy,
  id,
  buttonless = false
}: {
  upload: (files: File[]) => Promise<void>;
  busy: string;
  id: string;
  buttonless?: boolean;
}) {
  const canEdit = useCan('editor');
  const input = useRef<HTMLInputElement>(null);
  if (!canEdit) return null;
  return (
    <>
      {!buttonless && (
        <Button
          icon={FolderUp}
          id={id}
          disabled={!!busy}
          title="Add files to this model: pictures, videos, documents, more model files or anything else (or drop them on the page)"
          onClick={() => input.current?.click()}
        >
          {busy ? 'Uploading…' : 'Upload'}
        </Button>
      )}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        id={`${id}-file`}
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          event.target.value = '';
          if (files.length) void upload(files);
        }}
      />
      {busy && (
        <span className="jp-meta jp-model-upload__busy" role="status">
          {busy}
        </span>
      )}
    </>
  );
}
