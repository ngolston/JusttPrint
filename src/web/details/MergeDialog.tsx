import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { Modal } from '../components/Overlay';

const nameOf = (filePath: string) => filePath.split(/[\\/]/).pop() || filePath;

/**
 * Multi-edit's Merge: pick the main model; the other chosen models are merged into it
 * (core/models.js setModelParts): one card in the library, its page lists them.
 */
export function MergeDialog({
  open,
  filePaths,
  onCancel,
  onSubmit
}: {
  open: boolean;
  filePaths: string[];
  onCancel: () => void;
  /** Resolves when done; a thrown error is shown in the dialog. */
  onSubmit: (mainPath: string) => Promise<void>;
}) {
  const [main, setMain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setMain(filePaths[0] || '');
      setError('');
    }
    // Only when it opens: the chosen models come with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit() {
    if (!main) return;
    setBusy(true);
    try {
      await onSubmit(main);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  const others = filePaths.length - 1;
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Merge Models"
      className="jp-group-name"
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" id="jp-merge-submit" disabled={busy || !main} onClick={() => void submit()}>
            {busy ? 'Merging…' : 'Merge'}
          </Button>
        </>
      }
    >
      <label className="jp-group-name__label" htmlFor="jp-merge-main">
        The main model
      </label>
      <select className="jp-input" id="jp-merge-main" value={main} onChange={(event) => setMain(event.target.value)}>
        {filePaths.map((filePath) => (
          <option key={filePath} value={filePath}>
            {nameOf(filePath)}
          </option>
        ))}
      </select>
      <p className="jp-meta">
        {others === 1 ? 'The other model is merged into it' : `The other ${others} models are merged into it`}: one card in the library, and its page lists them
        (3D view, Open, Download). Deleting it deletes them too; Un-merge on a merged model's page takes one back out.
      </p>
      {error && (
        <p className="jp-meta jp-group-name__error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
