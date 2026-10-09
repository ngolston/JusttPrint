import { useEffect, useRef, useState } from 'react';
import { callAction } from '../api';
import { ModalDialog } from '../components/ModalDialog';
import { exposeGlobal, showMessage } from '../page';
import { ThingiverseSteps } from './SiteSetup';

declare global {
  interface Window {
    openThingiverseSettings?: () => void;
  }
}

/**
 * Settings → Thingiverse: the API token Add Links downloads Thingiverse files with. It is checked
 * with Thingiverse before it is kept, and never shown again. Registers window.openThingiverseSettings.
 */
export function ThingiverseSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [hasToken, setHasToken] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      exposeGlobal('openThingiverseSettings', () => {
        setValue('');
        callAction<{ hasToken: boolean }>('thingiverse-token-status')
          .then((status) => setHasToken(status.hasToken))
          .catch(() => {})
          .finally(() => {
            if (!dialogRef.current?.open) dialogRef.current?.showModal();
          });
      }),
    []
  );

  async function save(token: string) {
    setBusy(true);
    try {
      const status = await callAction<{ hasToken: boolean }>('set-thingiverse-token', token);
      setHasToken(status.hasToken);
      setValue('');
      await showMessage(
        'Thingiverse',
        status.hasToken ? 'Thingiverse accepted the token. Add Links now downloads Thingiverse files.' : 'The token was removed.'
      );
    } catch (error) {
      await showMessage('Thingiverse', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      id="thingiverse-settings-dialog"
      title="Thingiverse"
      dialogRef={dialogRef}
      footer={
        <>
          <button type="button" id="save-thingiverse-token" className="is-primary" disabled={busy || !value.trim()} onClick={() => save(value)}>
            Save Token
          </button>
          {hasToken && (
            <button type="button" id="remove-thingiverse-token" disabled={busy} onClick={() => save('')}>
              Remove Token
            </button>
          )}
          <button type="button" onClick={() => dialogRef.current?.close()}>
            Close
          </button>
        </>
      }
    >
      <div className="settings-group">
        <h4>API token</h4>
        <p className="setting-description" id="thingiverse-token-status">
          {hasToken ? 'A token is set: Add Links downloads Thingiverse files.' : 'No token: Thingiverse links are added as online models, without their files.'}
        </p>
        <div className="form-group">
          <label htmlFor="thingiverse-token">{hasToken ? 'Replace the token' : 'Token'}</label>
          <input
            type="password"
            id="thingiverse-token"
            autoComplete="off"
            value={value}
            placeholder="Paste your Thingiverse app token"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && value.trim()) void save(value);
            }}
          />
          <p className="setting-description">
            Thingiverse only gives files to apps with a token. JusttPrint checks it with Thingiverse, keeps it on the JusttPrint backend and never shows it
            again.
          </p>
          {!hasToken && <ThingiverseSteps />}
        </div>
      </div>
    </ModalDialog>
  );
}
