import { useEffect, useRef, useState } from 'react';
import { callAction, settings } from '../api';
import { ModalDialog } from '../components/ModalDialog';
import { exposeGlobal, showMessage } from '../page';
import { accountStatus, type AccountStatus } from './makerworld';
import { MakerWorldSteps } from '../links/SiteSetup';

declare global {
  interface Window {
    openMakerWorldSettings?: () => void;
  }
}

const TRANSLATION_KEY = 'makerWorldTranslation';

/**
 * Settings → MakerWorld: the MakerWorld sign-in downloads use (sign in, sign out), and where the
 * English names of MakerWorld files come from. Registers window.openMakerWorldSettings.
 */
export function MakerWorldSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [translation, setTranslation] = useState('free');
  const [saving, setSaving] = useState(false);

  const refresh = () => accountStatus().then(setStatus, () => setStatus(null));

  useEffect(
    () =>
      exposeGlobal('openMakerWorldSettings', () => {
        void refresh();
        settings
          .get<string | null>(TRANSLATION_KEY)
          .then((value) => setTranslation(value || 'free'))
          .catch(() => {})
          .finally(() => {
            if (!dialogRef.current?.open) dialogRef.current?.showModal();
          });
      }),
    []
  );

  async function signIn() {
    if (await window.signInMakerWorld?.()) await refresh();
  }

  async function signOut() {
    setStatus(await callAction<AccountStatus>('makerworld-sign-out'));
  }

  async function save() {
    setSaving(true);
    try {
      await settings.save(TRANSLATION_KEY, translation);
      dialogRef.current?.close();
      await showMessage(
        'Saved',
        'MakerWorld settings saved. Models already shown get the new English names when you press Refresh in their MakerWorld section.'
      );
    } catch (error) {
      await showMessage('Error', error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  const who = status?.name && status.account ? `${status.name} (${status.account})` : status?.name || status?.account || '';

  return (
    <ModalDialog
      id="makerworld-settings-dialog"
      title="MakerWorld"
      dialogRef={dialogRef}
      footer={
        <>
          <button type="button" id="save-makerworld-settings" className="is-primary" disabled={saving} onClick={save}>
            Save
          </button>
          <button type="button" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
        </>
      }
    >
      <div className="settings-group">
        <h4>Account</h4>
        <p className="setting-description" id="makerworld-account-status">
          {status?.signedIn
            ? `Signed in as ${who}. Downloads from MakerWorld use this account.`
            : 'Not signed in. MakerWorld asks for a sign-in before the first download.'}
        </p>
        {!status?.signedIn && <MakerWorldSteps />}
        {status?.signedIn ? (
          <button type="button" id="makerworld-sign-out" onClick={signOut}>
            Sign Out
          </button>
        ) : (
          <button type="button" id="makerworld-sign-in" onClick={signIn}>
            Sign In…
          </button>
        )}
      </div>
      <div className="settings-group">
        <h4>English file names</h4>
        <div className="form-group">
          <label htmlFor="makerworld-translation">Translate file names with:</label>
          <select id="makerworld-translation" value={translation} onChange={(event) => setTranslation(event.target.value)}>
            <option value="free">Free translation service (MyMemory)</option>
            <option value="ai">AI service (Settings → AI Tagging)</option>
            <option value="off">Off: original names only</option>
          </select>
          <p className="setting-description">
            MakerWorld does not translate file names. Names already in English are left alone. The free service needs no account (about 5,000 characters a day);
            the AI service uses the one set up for AI Tagging and its costs. Either way, only the file names are sent.
          </p>
        </div>
      </div>
    </ModalDialog>
  );
}
