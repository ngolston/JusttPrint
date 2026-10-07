import { useEffect, useRef, useState } from 'react';
import { mcp, type McpConnectionInfo } from './api';
import { ModalDialog } from './components/ModalDialog';
import { mcpClientSetups, tokenFromClientConfig, type McpClientId } from './mcp/clients';
import { copyText, exposeGlobal } from './page';

declare global {
  interface Window {
    openMcpServerSettings?: () => void;
  }
}

/** The endpoint as this browser reaches the server. */
function pageMcpUrl(): string {
  return `${window.location.origin.replace(/\/$/, '')}/mcp`;
}

const CLIENT_KEY = 'justtprint.mcpClient';

function savedClient(): McpClientId {
  try {
    return (localStorage.getItem(CLIENT_KEY) as McpClientId) || 'claude-code';
  } catch {
    return 'claude-code';
  }
}

function CopyButton({ id, text, label }: { id: string; text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  }
  return <button type="button" id={id} onClick={copy}>{copied ? 'Copied' : label}</button>;
}

/**
 * Settings → MCP Server → Settings: the endpoint URL, and the setup for the AI app the user picks
 * (Claude Code, Claude Desktop, Cursor, VS Code, or any other client), with this page's address
 * and the API token filled in. The endpoint is always on in the container. Registers
 * window.openMcpServerSettings.
 */
export function McpServerSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<McpConnectionInfo | null>(null);
  const [error, setError] = useState('');
  const [clientId, setClientId] = useState<McpClientId>(savedClient);

  useEffect(() => exposeGlobal('openMcpServerSettings', () => {
    setError('');
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    mcp.connectionInfo()
      .then(setInfo)
      .catch((reason) => setError(`Could not load the MCP connection details: ${reason instanceof Error ? reason.message : String(reason)}`));
  }), []);

  const url = pageMcpUrl();
  const setups = mcpClientSetups(url, tokenFromClientConfig(info?.clientConfig));
  const setup = setups.find((s) => s.id === clientId) ?? setups[0];

  function pickClient(id: McpClientId) {
    setClientId(id);
    try {
      localStorage.setItem(CLIENT_KEY, id);
    } catch { /* remembered for this visit only */ }
  }
  const otherUrls = (info?.urls ?? []).filter((other) => other && other !== url);

  return (
    <ModalDialog id="mcp-server-settings-dialog" title="MCP Server" dialogRef={dialogRef}
      description={(
        <>
          <p className="warning-text">Experimental feature. MCP Server is unfinished and may change or break. Any client with the API token can read and change your library.</p>
          <p className="setting-description">Connect an AI app (Claude Code, Claude Desktop, Cursor, VS Code, and similar) to search and update your library. Pick your app below and copy its setup. The URL uses <code>https://</code> when TLS is enabled under Settings → Server → HTTPS / SSL.</p>
        </>
      )}
      footer={<button type="button" id="cancel-mcp-server-settings" onClick={() => dialogRef.current?.close()}>Close</button>}>
      <div className="settings-group">
        <p id="mcp-server-status" className="setting-description" role="status">
          {error || 'Status: the MCP endpoint is always available on this server.'}
        </p>
        <div className="form-group">
          <label htmlFor="mcp-server-url">MCP URL</label>
          <input type="text" id="mcp-server-url" readOnly value={url} />
          <div className="dialog-buttons mcp-inline-actions">
            <CopyButton id="copy-mcp-server-url" text={url} label="Copy URL" />
          </div>
          {otherUrls.length > 0 && <p id="mcp-server-extra-urls" className="setting-description">Also reachable at: {otherUrls.join('  ·  ')}</p>}
        </div>
        <div className="form-group">
          <label htmlFor="mcp-client-select">Set up in</label>
          <select id="mcp-client-select" value={setup.id} onChange={(event) => pickClient(event.target.value as McpClientId)}>
            {setups.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <p id="mcp-client-where" className="setting-description">{setup.where}</p>
          <pre id="mcp-server-config" className="mcp-config" data-kind={setup.kind}>{setup.text}</pre>
          <div className="dialog-buttons mcp-inline-actions">
            <CopyButton id="copy-mcp-server-config" text={setup.text} label={setup.kind === 'command' ? 'Copy command' : 'Copy config'} />
          </div>
          {setup.note && <p id="mcp-client-note" className="setting-description">{setup.note}</p>}
          <p className="setting-description">
            This includes the API token (Settings → Server Access), so keep it private. The agent can search the library, manage tags,
            find duplicates, scan folders, update metadata, log prints, and set thumbnails.
          </p>
          {info && info.tools.length > 0 && <p id="mcp-server-tools" className="setting-description">Tools: {info.tools.join(', ')}</p>}
        </div>
      </div>
    </ModalDialog>
  );
}
