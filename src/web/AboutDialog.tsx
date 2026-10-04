import { useEffect, useRef, useState } from 'react';
import { callAction, settings } from './api';
import { exposeGlobal } from './page';

declare global {
  interface Window {
    openAbout?: () => void;
  }
}

const REPO_URL = 'https://github.com/ngolston/JusttPrint';

/**
 * Help → About: version, project link, the startup update check, and the license summary.
 * Registers window.openAbout.
 */
export function AboutDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [version, setVersion] = useState('Loading...');
  const [checkUpdates, setCheckUpdates] = useState(true);

  useEffect(() => exposeGlobal('openAbout', () => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    (async () => {
      const current = await settings.get<string | null>('currentVersion').catch(() => null)
        || await callAction<string>('get-app-version').catch(() => null);
      setVersion(current || 'Unknown');
    })();
    settings.get<string | null>('autoUpdateCheck')
      .then((value) => setCheckUpdates(value !== '0'))
      .catch(() => {});
  }), []);

  function changeCheckUpdates(checked: boolean) {
    setCheckUpdates(checked);
    settings.save('autoUpdateCheck', checked ? '1' : '0').catch((error) => {
      console.error('Could not save the update check setting:', error);
      setCheckUpdates(!checked);
    });
  }

  const close = () => dialogRef.current?.close();

  return (
    <dialog id="about-dialog" className="modal" ref={dialogRef}>
      <form method="dialog" onSubmit={(event) => event.preventDefault()}>
        <div className="about-header">
          <button type="button" className="about-close-x" aria-label="Close" onClick={close}>×</button>
          <img src="logo.png" alt="JusttPrint Logo" className="about-logo" />
          <h2>JusttPrint</h2>
          <p className="about-version-text" id="about-version">Version: {version}</p>
        </div>
        <div className="about-content">
          <div className="about-main-column">
            <div className="about-section">
              <div className="about-link-item">
                <span className="link-icon">🌐</span>
                <a href={REPO_URL} id="website-link" className="about-link" target="_blank" rel="noopener noreferrer">{REPO_URL}</a>
              </div>
            </div>

            <div className="about-section about-card">
              <div className="about-card-header">
                <span className="card-icon">🔄</span>
                <h3>Updates</h3>
              </div>
              <div className="about-card-content">
                <div className="about-option-item">
                  <input type="checkbox" id="auto-update-check" checked={checkUpdates}
                    onChange={(event) => changeCheckUpdates(event.target.checked)} />
                  <label htmlFor="auto-update-check">Check for updates on startup</label>
                </div>
                <p className="about-card-description">Asks GitHub for the latest JusttPrint release. Nothing else is sent.</p>
              </div>
            </div>
          </div>

          <div className="about-terms-column">
            <div className="about-section about-card about-terms-card">
              <div className="about-card-header">
                <span className="card-icon">📜</span>
                <h3>Terms of Service</h3>
              </div>
              <div className="about-card-content">
                <p className="about-card-description">JusttPrint is licensed under the MIT License:</p>
                <ul className="about-terms-list">
                  <li>Free to use, copy, modify, merge, publish, distribute, sublicense, and/or sell.</li>
                  <li>Must include copyright and permission notices in all copies.</li>
                  <li>Software provided "as is" without warranty.</li>
                  <li>Authors not liable for claims, damages, or other liability.</li>
                  <li>You are responsible for backing up your data.</li>
                </ul>
                <p className="about-card-description about-license-note">
                  See <a href={`${REPO_URL}/blob/main/LICENSE.txt`} id="license-link" target="_blank" rel="noopener noreferrer">LICENSE.txt</a> for full text.
                </p>
              </div>
            </div>
          </div>
        </div>
      </form>
    </dialog>
  );
}
