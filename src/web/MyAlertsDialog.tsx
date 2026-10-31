import { useEffect, useRef, useState } from 'react';
import { myAlerts, type AlertChannel, type AlertPrefs } from './api';
import { Button } from './components/Button';
import { ModalDialog } from './components/ModalDialog';
import { exposeGlobal } from './page';

declare global {
  interface Window {
    openMyAlerts?: () => void;
  }
}

/*
 * Settings → Authentication → My alerts (docs/plan-10.1.md, Phase 9): each person chooses which
 * alerts reach them in the bell, by email (their own address) and on Discord (their own webhook),
 * quiet hours for email and Discord, and a weekly digest by email. The library's email server is
 * the admin's (Settings → Printers → Alerts & webhooks).
 */

const CHANNELS: [AlertChannel, string][] = [
  ['bell', 'Bell'],
  ['email', 'Email'],
  ['discord', 'Discord']
];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function MyAlertsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [prefs, setPrefs] = useState<AlertPrefs | null>(null);
  const [webhook, setWebhook] = useState('');
  const [removeWebhook, setRemoveWebhook] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    myAlerts.get().then(
      (found) => {
        setPrefs(found);
        setWebhook('');
        setRemoveWebhook(false);
      },
      (failure) => setError(errorText(failure))
    );

  useEffect(
    () =>
      exposeGlobal('openMyAlerts', () => {
        setStatus('');
        setError('');
        void load();
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
      }),
    []
  );

  const set = (next: Partial<AlertPrefs>) => setPrefs((p) => (p ? { ...p, ...next } : p));
  const toggle = (kind: string, channel: AlertChannel) =>
    setPrefs((p) => (p ? { ...p, kinds: { ...p.kinds, [kind]: { ...p.kinds[kind], [channel]: !p.kinds[kind][channel] } } } : p));

  const save = async () => {
    if (!prefs) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const { discordSet: _set, kinds_meta: _meta, ...rest } = prefs;
      const saved = await myAlerts.save({ ...rest, ...(webhook.trim() ? { discordWebhook: webhook.trim() } : removeWebhook ? { discordWebhook: '' } : {}) });
      setPrefs({ ...saved, kinds_meta: prefs.kinds_meta });
      setWebhook('');
      setRemoveWebhook(false);
      setStatus('Saved.');
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  // The test goes to what is saved: save first.
  const test = async () => {
    await save();
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await myAlerts.test();
      setStatus(`A test went to your ${result.sent.join(' and ')}.`);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const kinds = prefs ? Object.entries(prefs.kinds_meta || {}) : [];
  return (
    <ModalDialog
      id="my-alerts-dialog"
      title="My alerts"
      dialogRef={dialogRef}
      footer={
        <>
          {error && (
            <span className="jp-fh-import__error" role="alert">
              {error}
            </span>
          )}
          {status && <span className="jp-meta">{status}</span>}
          <Button onClick={() => void test()} disabled={busy || !prefs || (!prefs.email && !prefs.discordSet)} id="my-alerts-test">
            Send a test
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !prefs} id="my-alerts-save">
            Save
          </Button>
          <Button onClick={() => dialogRef.current?.close()}>Close</Button>
        </>
      }
    >
      {prefs && (
        <>
          <p className="setting-description">
            Which alerts reach you, and where. Email goes through the library&apos;s email server (an admin sets it up under Settings → Printers → Alerts &amp;
            webhooks).
          </p>
          <div className="form-group">
            <label htmlFor="my-alerts-email">Your email address</label>
            <input id="my-alerts-email" type="email" value={prefs.email || ''} onChange={(event) => set({ email: event.target.value || null })} />
          </div>
          <div className="form-group">
            <label htmlFor="my-alerts-discord">Your Discord webhook</label>
            <input
              id="my-alerts-discord"
              type="password"
              autoComplete="off"
              placeholder={prefs.discordSet && !removeWebhook ? 'Set (type a new one to replace it)' : 'https://discord.com/api/webhooks/…'}
              value={webhook}
              onChange={(event) => setWebhook(event.target.value)}
            />
            {prefs.discordSet && (
              <label className="checkbox-container">
                <input type="checkbox" checked={removeWebhook} onChange={(event) => setRemoveWebhook(event.target.checked)} />
                <span>Remove my Discord webhook</span>
              </label>
            )}
          </div>
          <table className="jp-my-alerts" id="my-alerts-table">
            <thead>
              <tr>
                <th scope="col">Alert</th>
                {CHANNELS.map(([channel, label]) => (
                  <th key={channel} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {kinds.map(([kind, label]) => (
                <tr key={kind}>
                  <th scope="row">{label}</th>
                  {CHANNELS.map(([channel, channelLabel]) => (
                    <td key={channel}>
                      <input
                        type="checkbox"
                        aria-label={`${label}: ${channelLabel}`}
                        checked={!!prefs.kinds[kind]?.[channel]}
                        disabled={(channel === 'email' && !prefs.email) || (channel === 'discord' && !prefs.discordSet && !webhook.trim())}
                        onChange={() => toggle(kind, channel)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form-group">
            <label className="checkbox-container">
              <input
                type="checkbox"
                id="my-alerts-quiet"
                checked={!!prefs.quietHours}
                onChange={(event) => set({ quietHours: event.target.checked ? { from: '22:00', to: '07:00' } : null })}
              />
              <span>Quiet hours: hold email and Discord, then send them when they end</span>
            </label>
            {prefs.quietHours && (
              <div className="jp-my-alerts__quiet">
                <input
                  type="time"
                  aria-label="Quiet from"
                  value={prefs.quietHours.from}
                  onChange={(event) => set({ quietHours: { ...prefs.quietHours!, from: event.target.value } })}
                />
                <span>to</span>
                <input
                  type="time"
                  aria-label="Quiet until"
                  value={prefs.quietHours.to}
                  onChange={(event) => set({ quietHours: { ...prefs.quietHours!, to: event.target.value } })}
                />
                <span className="jp-meta">(the server&apos;s time)</span>
              </div>
            )}
          </div>
          <div className="form-group">
            <label className="checkbox-container">
              <input
                type="checkbox"
                id="my-alerts-digest"
                checked={prefs.weeklyDigest}
                disabled={!prefs.email}
                onChange={(event) => set({ weeklyDigest: event.target.checked })}
              />
              <span>A weekly digest by email on Monday morning: what runs low or out soon, and last week&apos;s prints and filament</span>
            </label>
          </div>
        </>
      )}
    </ModalDialog>
  );
}
