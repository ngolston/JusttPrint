import { useEffect, useRef, useState } from 'react';
import { purge } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, showMessage } from './page';

declare global {
  interface Window {
    openPurgeModels?: () => void;
  }
}

/** Settings → Purge Models: remove every model from the database. Registers window.openPurgeModels. */
export function PurgeModelsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [purging, setPurging] = useState(false);

  useEffect(
    () =>
      exposeGlobal('openPurgeModels', () => {
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
      }),
    []
  );

  async function purgeAll() {
    setPurging(true);
    try {
      if (!(await purge.allModels())) throw new Error('The JusttPrint backend did not purge the models.');
      dialogRef.current?.close();
      await window.afterModelsPurged?.();
      await showMessage('Success', 'All models have been purged from the database.');
    } catch (error) {
      console.error('Error purging models:', error);
      await showMessage('Error', 'Failed to purge models from the database.');
    } finally {
      setPurging(false);
    }
  }

  return (
    <ModalDialog
      id="purge-models-dialog"
      title="Purge Models"
      dialogRef={dialogRef}
      footer={
        <>
          <button type="button" id="confirm-purge-button" className="danger-button" disabled={purging} onClick={purgeAll}>
            {purging ? 'Purging...' : 'Purge All Models'}
          </button>
          <button type="button" id="cancel-purge-button" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
        </>
      }
    >
      <p className="setting-description">
        This removes every model from the database, along with its tags and print history. Files on disk are not deleted. This action cannot be undone.
      </p>
    </ModalDialog>
  );
}
