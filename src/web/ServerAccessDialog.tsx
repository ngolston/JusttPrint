import { useEffect, useRef, useState } from 'react';
import { serverAccess, type ServerAccessInfo } from './api';
import { ModalDialog } from './components/ModalDialog';
import { copyText, exposeGlobal } from './page';

declare global {
  interface Window {
    openServerAccess?: () => void;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Settings → Server Access (admins): show or regenerate the API token. Passwords are per user:
 * Change Password (ChangePasswordDialog.tsx) and Settings → Users (UsersDialog.tsx).
 * Registers window.openServerAccess, which the menu and the rest of the page call.
 */
export function ServerAccessDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const [info, setInfo] = useState<ServerAccessInfo | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let openCount = 0;
    return exposeGlobal('openServerAccess', () => {
      const open = ++openCount;
      setStatus('');
      if (!dialogRef.current?.open) dialogRef.current?.showModal();
      serverAccess.info()
        .then((result) => { if (open === openCount) setInfo(result); })
        .catch((error) => { if (open === openCount) setStatus(`Could not load the JusttPrint backend access settings: ${errorText(error)}`); });
    });
  }, []);

  async function copyToken() {
    if (!info?.apiToken) return;
    if (await copyText(info.apiToken)) {
      setStatus('Token copied.');
    } else {
      tokenRef.current?.select();
      setStatus('Select the token and copy it.');
    }
  }

  async function regenerateToken() {
    if (!window.confirm('Regenerate the API token? MCP clients using the old token stop working until you update them.')) return;
    try {
      const result = await serverAccess.regenerateToken();
      setInfo((previous) => (previous ? { ...previous, apiToken: result.apiToken } : previous));
      setStatus('New token created.');
    } catch (error) {
      setStatus(`Could not regenerate the token: ${errorText(error)}`);
    }
  }

  return (
    <ModalDialog id="server-access-dialog" title="JusttPrint Backend Access" dialogRef={dialogRef}
      footer={<button type="button" id="close-server-access" onClick={() => dialogRef.current?.close()}>Close</button>}>
      <p className="setting-description">People log in with their own user name and password (Settings → Users). MCP clients and scripts use the API token, which acts as an admin.</p>
      <div className="settings-group">
        {info?.passwordFromEnv && (
          <p className="setting-description">
            The password of <strong>{info.envUsername}</strong> is set by the <code>JUSTTPRINT_PASSWORD</code> environment variable. Change it there and restart the container.
          </p>
        )}
        <p id="server-access-status" className="setting-description" role="status">{status}</p>
        <div className="form-group">
          <label htmlFor="server-access-api-token">API token</label>
          <input type="text" id="server-access-api-token" readOnly ref={tokenRef} value={info?.apiToken ?? ''} />
          <div className="dialog-buttons mcp-inline-actions">
            <button type="button" id="server-access-copy-token" onClick={copyToken}>Copy token</button>
            <button type="button" id="server-access-regenerate-token" onClick={regenerateToken}>Regenerate</button>
          </div>
          <p className="setting-description">
            Send as <code>Authorization: Bearer &lt;token&gt;</code>. The MCP client config already includes it.
            Regenerating disconnects clients that use the old token.
          </p>
        </div>
      </div>
    </ModalDialog>
  );
}
