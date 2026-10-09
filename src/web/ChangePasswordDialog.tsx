import { useEffect, useRef, useState } from 'react';
import { serverAccess } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal } from './page';
import { useCurrentUser } from './session';

const MIN_PASSWORD_LENGTH = 8;

declare global {
  interface Window {
    openChangePassword?: () => void;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Change Password (account menu, Settings → Authentication): the logged-in user changes their own
 * password. Every browser they are logged in on, this one too, then asks them to log in again.
 */
export function ChangePasswordDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const user = useCurrentUser();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      exposeGlobal('openChangePassword', () => {
        setStatus('');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
      }),
    []
  );

  async function changePassword() {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setStatus(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setStatus('The new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await serverAccess.setPassword(currentPassword, newPassword);
      setStatus('Password changed. Log in again with the new password.');
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalDialog
      id="change-password-dialog"
      title="Change Password"
      dialogRef={dialogRef}
      footer={
        <button type="button" id="close-change-password" onClick={() => dialogRef.current?.close()}>
          Close
        </button>
      }
    >
      <p className="setting-description">
        {user ? (
          <>
            You are logged in as <strong>{user.username}</strong> ({user.roleLabel}).
          </>
        ) : null}{' '}
        Changing your password logs you out in every browser.
      </p>
      <div className="form-group">
        <label htmlFor="change-password-current">Current password</label>
        <input
          type="password"
          id="change-password-current"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <label htmlFor="change-password-new">New password</label>
        <input
          type="password"
          id="change-password-new"
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <label htmlFor="change-password-confirm">Confirm new password</label>
        <input
          type="password"
          id="change-password-confirm"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
        />
        <div className="dialog-buttons mcp-inline-actions">
          <button type="button" id="change-password-save" disabled={busy} onClick={changePassword}>
            Change password
          </button>
        </div>
      </div>
      <p id="change-password-status" className="setting-description" role="status">
        {status}
      </p>
    </ModalDialog>
  );
}
