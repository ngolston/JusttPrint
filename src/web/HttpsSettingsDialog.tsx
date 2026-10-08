import { useEffect, useRef, useState } from 'react';
import { tls, type TlsMode, type TlsResult, type TlsSettings, type TlsStatus } from './api';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal, showMessage } from './page';

declare global {
  interface Window {
    openHttpsSettings?: () => void;
  }
}

interface Form extends TlsSettings {
  mode: TlsMode;
  /** Self-signed hostname; saved as tlsDomain when the mode is self-signed. */
  selfSignedHost: string;
}

const EMPTY_FORM: Form = {
  mode: 'off', selfSignedHost: '', tlsCertPath: '', tlsKeyPath: '', tlsCaPath: '', tlsDomain: '', tlsEmail: '',
  tlsAgreeTos: false, tlsUseStaging: false, tlsRedirectHttp: false, serverHttpPort: '5000'
};

function formFromStatus(status: TlsStatus): Form {
  const settings = status.settings || ({} as TlsSettings);
  return {
    ...EMPTY_FORM,
    ...settings,
    mode: status.tlsMode || 'off',
    selfSignedHost: settings.tlsDomain || '',
    serverHttpPort: String(settings.serverHttpPort || status.appPort || 5000)
  };
}

function statusLine(status: TlsStatus): string {
  const port = status.appPort || 5000;
  const parts = [status.scheme === 'https' ? `Certificate ready for HTTPS on port ${port}` : `Certificate off — HTTP on port ${port}`];
  if (status.source && status.source !== 'none') parts.push(`Certificate source: ${status.source}`);
  if (status.cert?.expiresAt) {
    const days = status.cert.daysRemaining;
    parts.push(`Expires ${status.cert.expiresAt.slice(0, 10)}${typeof days === 'number' ? ` (${days} days)` : ''}`);
  }
  if (status.missingFiles) parts.push('Certificate files are missing.');
  if (status.lastError) parts.push(`Last error: ${status.lastError}`);
  return parts.join(' · ');
}

/**
 * Settings → MCP Server → HTTPS / SSL: the listen port, and TLS from certificate files, Let's
 * Encrypt or a self-signed certificate. Locked when JUSTTPRINT_TLS_CERT/KEY are set.
 * Registers window.openHttpsSettings.
 */
export function HttpsSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<TlsStatus | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  useEffect(() => exposeGlobal('openHttpsSettings', () => {
    tls.status()
      .then((result) => {
        setStatus(result);
        setForm(formFromStatus(result));
      })
      .catch((error) => setStatus({
        envOverride: false, tlsMode: 'off', scheme: 'http', source: 'none', cert: null, missingFiles: false, appPort: 5000,
        lastError: error instanceof Error ? error.message : String(error), settings: EMPTY_FORM
      }))
      .finally(() => { if (!dialogRef.current?.open) dialogRef.current?.showModal(); });
  }), []);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((previous) => ({ ...previous, [key]: value }));
  const text = (key: keyof Form) => (event: { target: { value: string } }) => set(key, event.target.value as never);
  const flag = (key: keyof Form) => (event: { target: { checked: boolean } }) => set(key, event.target.checked as never);

  const locked = !!status?.envOverride;
  const port = parseInt(form.serverHttpPort, 10);
  const listenPort = Number.isInteger(port) && port > 0 ? port : 5000;

  function payload() {
    return {
      tlsMode: form.mode,
      tlsCertPath: form.tlsCertPath.trim(),
      tlsKeyPath: form.tlsKeyPath.trim(),
      tlsCaPath: form.tlsCaPath.trim(),
      tlsDomain: (form.mode === 'selfsigned' ? form.selfSignedHost : form.tlsDomain).trim(),
      tlsEmail: form.tlsEmail.trim(),
      tlsAgreeTos: form.tlsAgreeTos,
      tlsUseStaging: form.tlsUseStaging,
      tlsRedirectHttp: form.tlsRedirectHttp,
      serverHttpPort: form.serverHttpPort.trim()
    };
  }

  /** Runs a TLS change; reports the result and closes on success. */
  async function run(title: string, work: () => Promise<TlsResult>, failure: string, success: string) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await work();
      if (!result?.success) {
        if (result?.status) setStatus(result.status);
        await showMessage(title, result?.message || failure);
        return;
      }
      dialogRef.current?.close();
      await showMessage(title, result.message || success);
    } catch (error) {
      await showMessage(title, `${failure} ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  const save = () => run('HTTPS / SSL', () => tls.apply(payload()), 'Failed to apply TLS settings.',
    'Settings applied. Reconnect with https:// if TLS is on.');
  const issueLetsEncrypt = () => run("Let's Encrypt", () => tls.apply({ ...payload(), tlsMode: 'letsencrypt', issueNow: true }),
    'Certificate request failed.', 'Certificate issued. Reopen the app as https://<domain>:<port>.');
  const generateSelfSigned = () => run('Self-signed certificate', () => {
    const values = payload();
    return tls.generateSelfSigned({
      hostname: form.selfSignedHost.trim() || values.tlsDomain,
      tlsDomain: values.tlsDomain,
      tlsRedirectHttp: values.tlsRedirectHttp,
      serverHttpPort: values.serverHttpPort
    });
  }, 'Failed to generate certificate.', 'Certificate generated. Reopen as https:// — the browser will warn until you trust it.');

  const input = (key: keyof Form, id: string, label: string, placeholder: string, type = 'text') => (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <input type={type} id={id} placeholder={placeholder} autoComplete="off" value={String(form[key])} onChange={text(key)} />
    </div>
  );

  return (
    <ModalDialog id="https-settings-dialog" title="HTTPS / SSL" dialogRef={dialogRef}
      description={<p className="setting-description">Use a custom certificate, Let's Encrypt, or a self-signed certificate for the web UI (<code>https://</code> and <code>wss://</code>) on the listen port below. After enabling TLS, use the matching <code>https://</code> URL in the Chrome extension and MCP client.</p>}
      footer={(
        <>
          {!locked && <button type="button" id="save-https-settings" className="is-primary" disabled={busy} onClick={save}>Save and apply</button>}
          <button type="button" id="cancel-https-settings" onClick={() => dialogRef.current?.close()}>Cancel</button>
        </>
      )}>
      <div className="settings-group" id="https-settings-fields" data-disabled={locked ? '1' : '0'}>
        <p id="https-settings-status" className="setting-description" role="status">{status ? statusLine(status) : ''}</p>
        {locked && (
          <p id="https-settings-env-note" className="warning-text">TLS is controlled by <code>JUSTTPRINT_TLS_CERT</code> / <code>JUSTTPRINT_TLS_KEY</code> (or <code>SSL_*</code>) on this process. Unset those environment variables to configure certificates here.</p>
        )}
        <div className="form-group" id="tls-listen-port-group">
          <label htmlFor="tls-listen-port">Listen port</label>
          <input type="number" id="tls-listen-port" min="1" max="65535" value={form.serverHttpPort}
            disabled={locked || !!status?.portEnvOverride} onChange={text('serverHttpPort')} />
          <p className="setting-description">Port JusttPrint binds inside the container (default 5000). On Synology or Docker, also publish that port on the host (for example <code>5001:5001</code> if you change this to 5001). DSM already uses host port 5000, so pick another host mapping. <code>JUSTTPRINT_PORT</code> seeds this when the setting is empty.</p>
        </div>
        <div className="form-group">
          <label htmlFor="tls-mode">Mode</label>
          <select id="tls-mode" value={form.mode} disabled={locked} onChange={(event) => set('mode', event.target.value as TlsMode)}>
            <option value="off">Off (HTTP only)</option>
            <option value="custom">Custom certificate files</option>
            <option value="letsencrypt">Let's Encrypt</option>
            <option value="selfsigned">Self-signed (LAN)</option>
          </select>
        </div>
        {form.mode === 'custom' && (
          <div id="tls-panel-custom" className="tls-mode-panel">
            {input('tlsCertPath', 'tls-cert-path', 'Certificate (PEM)', '/certs/fullchain.pem')}
            {input('tlsKeyPath', 'tls-key-path', 'Private key (PEM)', '/certs/privkey.pem')}
            {input('tlsCaPath', 'tls-ca-path', 'Certificate chain (optional)', '/certs/chain.pem')}
            <p className="setting-description">Use absolute paths the JusttPrint backend can read. In Docker, mount files (for example <code>./certs:/certs:ro</code>) and enter container paths.</p>
          </div>
        )}
        {form.mode === 'letsencrypt' && (
          <div id="tls-panel-letsencrypt" className="tls-mode-panel">
            <p className="setting-description">Let's Encrypt issues a trusted certificate for a <strong>public DNS name</strong>. Port <strong>80</strong> must reach this host (Docker: publish <code>80:80</code>). This will not work for LAN-only IPs — use self-signed or a custom certificate instead.</p>
            {input('tlsDomain', 'tls-domain', 'Domain', 'justtprint.example.com')}
            {input('tlsEmail', 'tls-email', 'Contact email', 'admin@example.com', 'email')}
            <div className="form-group checkbox-container">
              <input type="checkbox" id="tls-agree-tos" checked={form.tlsAgreeTos} onChange={flag('tlsAgreeTos')} />
              <label htmlFor="tls-agree-tos">I agree to the <a href="https://letsencrypt.org/repository/" target="_blank" rel="noopener noreferrer">Let's Encrypt Terms of Service</a></label>
            </div>
            <div className="form-group checkbox-container">
              <input type="checkbox" id="tls-use-staging" checked={form.tlsUseStaging} onChange={flag('tlsUseStaging')} />
              <label htmlFor="tls-use-staging">Use Let's Encrypt staging (testing only; browsers will not trust it)</label>
            </div>
            <div className="dialog-buttons mcp-inline-actions">
              <button type="button" id="tls-issue-letsencrypt" disabled={locked || busy} onClick={issueLetsEncrypt}>Issue / renew certificate</button>
            </div>
          </div>
        )}
        {form.mode === 'selfsigned' && (
          <div id="tls-panel-selfsigned" className="tls-mode-panel">
            <p className="setting-description">Generates a local certificate for LAN access. Browsers will show a warning until you trust it. Enter the hostname or IP you type in the address bar.</p>
            {input('selfSignedHost', 'tls-selfsigned-host', 'Hostname or IP', 'localhost')}
            <div className="dialog-buttons mcp-inline-actions">
              <button type="button" id="tls-generate-selfsigned" disabled={locked || busy} onClick={generateSelfSigned}>Generate certificate</button>
            </div>
          </div>
        )}
        <div className="form-group checkbox-container">
          <input type="checkbox" id="tls-redirect-http" checked={form.tlsRedirectHttp} onChange={flag('tlsRedirectHttp')} />
          <label htmlFor="tls-redirect-http" id="tls-redirect-http-label">Redirect HTTP on port 80 to https://&lt;host&gt;:{listenPort}</label>
        </div>
        <p className="setting-description">Certificates issued by Let's Encrypt or generated here are stored under the app data directory (Docker volume <code>./data</code>), not in the settings database.</p>
      </div>
    </ModalDialog>
  );
}
