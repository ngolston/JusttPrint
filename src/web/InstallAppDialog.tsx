import { useEffect, useRef, useState } from 'react';
import { ModalDialog } from './components/ModalDialog';
import { currentInstallContext, installWay, onInstallOfferChange, promptInstall, type InstallWay } from './install';
import { exposeGlobal } from './page';
import { useCan } from './session';

declare global {
  interface Window {
    openInstallApp?: () => void;
  }
}

/**
 * Settings → Install App: add JusttPrint to the home screen or the desktop, with the steps for
 * this browser (src/web/install.ts). Installed, it opens in its own window without the address bar.
 */
export function InstallAppDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [way, setWay] = useState<InstallWay>(() => installWay(currentInstallContext()));
  const [status, setStatus] = useState('');
  const isAdmin = useCan('admin');

  useEffect(
    () =>
      exposeGlobal('openInstallApp', () => {
        setStatus('');
        setWay(installWay(currentInstallContext()));
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
      }),
    []
  );
  useEffect(() => onInstallOfferChange(() => setWay(installWay(currentInstallContext()))), []);

  const install = async () => {
    const done = await promptInstall();
    setStatus(done ? 'Installed. Open JusttPrint from your home screen or apps.' : 'Not installed. You can install it later from here.');
    setWay(installWay(currentInstallContext()));
  };

  const httpsNote = (
    <p className="setting-description">
      {isAdmin ? (
        <>
          Set up HTTPS in{' '}
          <button
            type="button"
            className="jp-link"
            onClick={() => {
              dialogRef.current?.close();
              window.openHttpsSettings?.();
            }}
          >
            Settings → HTTPS / SSL
          </button>
          , or put JusttPrint behind a reverse proxy with a certificate (see the Guide).
        </>
      ) : (
        <>Ask your JusttPrint admin to set up HTTPS (Settings → HTTPS / SSL).</>
      )}
    </p>
  );

  return (
    <ModalDialog
      id="install-app-dialog"
      title="Install App"
      dialogRef={dialogRef}
      footer={
        <button type="button" id="close-install-app" onClick={() => dialogRef.current?.close()}>
          Close
        </button>
      }
    >
      <p className="setting-description">
        Installed, JusttPrint opens from its own icon in a window without the browser&apos;s address bar. It is still this same JusttPrint in your Docker
        container: nothing is copied to the device.
      </p>
      <div id="install-app-steps" data-way={way}>
        {way === 'installed' && (
          <p>
            <strong>JusttPrint is already installed</strong> and running as an app.
          </p>
        )}
        {way === 'prompt' && (
          <div className="dialog-buttons mcp-inline-actions">
            <button type="button" id="install-app-button" onClick={install}>
              Install JusttPrint
            </button>
          </div>
        )}
        {way === 'ios' && (
          <ol>
            <li>
              Open JusttPrint in <strong>Safari</strong>.
            </li>
            <li>
              Tap <strong>Share</strong> (the square with an arrow).
            </li>
            <li>
              Tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
            </li>
          </ol>
        )}
        {way === 'browser-menu' && (
          <p>
            Open the browser&apos;s menu (⋮) and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>. If it is not there, JusttPrint may
            already be installed on this device.
          </p>
        )}
        {way === 'needs-https' && (
          <>
            <p>
              <strong>This browser installs apps only over HTTPS.</strong> JusttPrint is open over plain http, so the browser&apos;s menu (⋮) offers{' '}
              <strong>Add to Home screen</strong> as a shortcut that opens in the browser.
            </p>
            {httpsNote}
          </>
        )}
        {way === 'unsupported' && (
          <p>This browser does not install web apps. Use Chrome or Edge (Android, Windows, Mac, Linux) or Safari (iPhone, iPad), or add a bookmark.</p>
        )}
      </div>
      <p id="install-app-status" className="setting-description" role="status">
        {status}
      </p>
    </ModalDialog>
  );
}
