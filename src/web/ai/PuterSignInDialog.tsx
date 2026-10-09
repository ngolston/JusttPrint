import { useEffect, useRef } from 'react';
import { ModalDialog } from '../components/ModalDialog';
import { cancelSignIn, openSignInWindow, signInNeedsClick, subscribe } from './puterAuth';

/**
 * Shown when AI tagging needs a Puter login and the browser blocked the sign-in popup: the
 * button's click is what lets the popup open.
 */
export function PuterSignInDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(
    () =>
      subscribe(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        if (signInNeedsClick() && !dialog.open) dialog.showModal();
        else if (!signInNeedsClick() && dialog.open) dialog.close();
      }),
    []
  );

  return (
    <ModalDialog
      id="puter-signin-dialog"
      title="Sign in to Puter"
      dialogRef={dialogRef}
      onClose={() => {
        if (signInNeedsClick()) cancelSignIn();
      }}
      description={
        <p className="setting-description">
          AI tagging with Puter.com needs your Puter account. Sign in in the window that opens; usage counts against your Puter account.
        </p>
      }
      footer={
        <>
          <button
            type="button"
            id="puter-signin-open"
            onClick={() => {
              openSignInWindow();
            }}
          >
            Sign in with Puter
          </button>
          <button type="button" id="puter-signin-cancel" onClick={() => cancelSignIn()}>
            Cancel
          </button>
        </>
      }
    >
      <p>
        The browser blocked the sign-in window. Click <strong>Sign in with Puter</strong> to open it.
      </p>
    </ModalDialog>
  );
}
