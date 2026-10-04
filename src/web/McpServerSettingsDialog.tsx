import { useEffect, useRef, useState } from 'react';
import { mcp, type McpConnectionInfo } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal } from './page';

declare global {
  interface Window {
    openMcpServerSettings?: () => void;
  }
}

/** The endpoint as this browser reaches the server. */
function pageMcpUrl(): string {
  return `${window.location.origin.replace(/\/$/, '')}/mcp`;
}

/** The server's client config (with the API token), pointed at this page's address. */
function clientConfigText(info: McpConnectionInfo | null, url: string): string {
  const servers = info?.clientConfig?.mcpServers ?? { justtprint: { url } };
  const pointed = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, { ...server, url }]));
  return JSON.stringify({ mcpServers: pointed }, null, 2);
}

function CopyButton({ id, text, label }: { id: string; text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }
  return <button type="button" id={id} onClick={copy}>{copied ? 'Copied' : label}</button>;
}

/**
 * Tools → MCP Server → Settings: the endpoint URL and a ready-to-paste client config for
 * MCP clients. The endpoint is always on in the container. Registers window.openMcpServerSettings.
 */
export function McpServerSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<McpConnectionInfo | null>(null);
  const [error, setError] = useState('');

  useEffect(() => exposeGlobal('openMcpServerSettings', () => {
    setError('');
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    mcp.connectionInfo()
      .then(setInfo)
      .catch((reason) => setError(`Could not load the MCP connection details: ${reason instanceof Error ? reason.message : String(reason)}`));
  }), []);

  const url = pageMcpUrl();
  const config = clientConfigText(info, url);
  const otherUrls = (info?.urls ?? []).filter((other) => other && other !== url);

  return (
    <ModalDialog id="mcp-server-settings-dialog" title="MCP Server" dialogRef={dialogRef}
      description={(
        <>
          <p className="warning-text">Experimental feature. MCP Server is unfinished and may change or break. Any client with the API token can read and change your library.</p>
          <p className="setting-description">Connect an AI agent (Cursor, Claude Desktop, VS Code, and similar) to search your library, read model details, and write thumbnails. The URL uses <code>https://</code> when TLS is enabled under Tools → MCP Server → HTTPS / SSL.</p>
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
          <label htmlFor="mcp-server-config">Client config (Cursor / Claude Desktop / VS Code)</label>
          <pre id="mcp-server-config" className="mcp-config">{config}</pre>
          <div className="dialog-buttons mcp-inline-actions">
            <CopyButton id="copy-mcp-server-config" text={config} label="Copy config" />
          </div>
          <p className="setting-description">
            Place this under <code>mcpServers</code> in your MCP client settings. It includes the API token (Tools → Server Access),
            so keep it private. The agent can search the library, manage tags, find duplicates, scan folders, update metadata, and set thumbnails.
          </p>
          {info && info.tools.length > 0 && <p id="mcp-server-tools" className="setting-description">Tools: {info.tools.join(', ')}</p>}
        </div>
      </div>
    </ModalDialog>
  );
}
