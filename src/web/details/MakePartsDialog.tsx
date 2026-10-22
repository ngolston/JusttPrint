import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { Modal } from '../components/Overlay';

const nameOf = (filePath: string) => filePath.split(/[\\/]/).pop() || filePath;

/**
 * Multi-edit's Make Parts of One Model: pick which chosen model the others belong to. They become
 * its parts (core/models.js setModelParts): listed on its page, not in the library.
 */
export function MakePartsDialog({
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
      title="Make Parts of One Model"
      className="jp-group-name"
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" id="jp-make-parts-submit" disabled={busy || !main} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Make Parts'}
          </Button>
        </>
      }
    >
      <label className="jp-group-name__label" htmlFor="jp-make-parts-main">
        The model they belong to
      </label>
      <select className="jp-input" id="jp-make-parts-main" value={main} onChange={(event) => setMain(event.target.value)}>
        {filePaths.map((filePath) => (
          <option key={filePath} value={filePath}>
            {nameOf(filePath)}
          </option>
        ))}
      </select>
      <p className="jp-meta">
        The other {others === 1 ? 'model becomes its part' : `${others} models become its parts`}: listed with its files on its page, with no card of their own
        in the library. Deleting the model takes them along.
      </p>
      {error && (
        <p className="jp-meta jp-group-name__error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
