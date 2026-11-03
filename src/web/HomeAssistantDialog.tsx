import { useEffect, useRef, useState } from 'react';
import { homeAssistant, type HomeAssistantStatus } from './api';
import { Button } from './components/Button';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal } from './page';
import { formatDayTime } from './units';

declare global {
  interface Window {
    openHomeAssistant?: () => void;
  }
}

/*
 * Settings → Integrations → Home Assistant (docs/plan-10.1.md, Phase 11; admins): Home Assistant's
 * address and a long-lived access token. JusttPrint then keeps one sensor per spool there,
 * sensor.justtprint_spool_<id>, after spools change and every hour. The token never comes back
 * to the browser.
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function HomeAssistantDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<HomeAssistantStatus | null>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const show = (next: HomeAssistantStatus) => {
    setState(next);
    setUrl(next.url);
    setEnabled(next.enabled);
    setToken('');
  };
  useEffect(
    () =>
      exposeGlobal('openHomeAssistant', () => {
        setStatus('');
        setError('');
        // The fields wait for what is saved: typing before it came would be overwritten.
        setState(null);
        homeAssistant.get().then(show, (failure) => setError(errorText(failure)));
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
      }),
    []
  );

  const run = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const message = await work();
      if (message) setStatus(message);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      show(await homeAssistant.save({ url, enabled, ...(token.trim() ? { token: token.trim() } : {}) }));
      return 'Saved.';
    });
  const test = () =>
    run(async () => {
      if (url !== state?.url || token.trim()) show(await homeAssistant.save({ url, ...(token.trim() ? { token: token.trim() } : {}) }));
      const result = await homeAssistant.test();
      if (!result.ok) throw new Error(result.message);
      return `Home Assistant answered: ${result.message}`;
    });
  const pushNow = () =>
    run(async () => {
      const result = await homeAssistant.push();
      show(await homeAssistant.get());
      return result.skipped
        ? 'Turn it on first.'
        : `Sent ${result.pushed} ${result.pushed === 1 ? 'spool' : 'spools'}${result.errors ? `, ${result.errors} failed` : ''}.`;
    });
  const removeToken = () =>
    run(async () => {
      show(await homeAssistant.save({ token: '', enabled: false }));
      return 'Token removed.';
    });

  const last = state?.lastPush;
  return (
    <ModalDialog
      id="home-assistant-dialog"
      title="Home Assistant"
      dialogRef={dialogRef}
      footer={
        <>
          {error && (
            <span className="jp-fh-import__error" role="alert">
              {error}
            </span>
          )}
          {status && <span className="jp-meta">{status}</span>}
          <Button onClick={() => void test()} disabled={busy || !url || (!state?.tokenSet && !token.trim())} id="home-assistant-test">
            Test
          </Button>
          <Button onClick={() => void pushNow()} disabled={busy || !state?.enabled} id="home-assistant-push">
            Send now
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !state} id="home-assistant-save">
            Save
          </Button>
          <Button onClick={() => dialogRef.current?.close()}>Close</Button>
        </>
      }
    >
      <p className="setting-description">
        JusttPrint keeps one sensor per spool in Home Assistant: <code>sensor.justtprint_spool_&lt;id&gt;</code>, its state the grams left, with the material,
        color, percent, place and when it runs out as attributes. It sends them after spools change and every hour, and removes the sensors of spools you
        archive or delete.
      </p>
      <div className="form-group">
        <label htmlFor="home-assistant-url">Home Assistant&apos;s address</label>
        <input
          id="home-assistant-url"
          placeholder="http://homeassistant.local:8123"
          value={url}
          disabled={!state}
          onChange={(event) => setUrl(event.target.value)}
        />
      </div>
      <div className="form-group">
        <label htmlFor="home-assistant-token">Long-lived access token</label>
        <input
          id="home-assistant-token"
          type="password"
          autoComplete="off"
          placeholder={state?.tokenSet ? 'Set (paste a new one to replace it)' : 'From your Home Assistant profile → Security → Long-lived access tokens'}
          value={token}
          disabled={!state}
          onChange={(event) => setToken(event.target.value)}
        />
        {state?.tokenSet && (
          <button type="button" className="jp-link-button" onClick={() => void removeToken()} disabled={busy}>
            Remove the token
          </button>
        )}
      </div>
      <label className="checkbox-container">
        <input type="checkbox" id="home-assistant-enabled" checked={enabled} disabled={!state} onChange={(event) => setEnabled(event.target.checked)} />
        <span>Send the spools to Home Assistant</span>
      </label>
      {last && (
        <p className="jp-meta" id="home-assistant-last">
          Last sent {formatDayTime(last.at)}: {last.pushed} {last.pushed === 1 ? 'spool' : 'spools'}
          {last.removed ? `, ${last.removed} removed` : ''}
          {last.errors ? `, ${last.errors} failed (${last.message})` : ''}.
        </p>
      )}
    </ModalDialog>
  );
}
