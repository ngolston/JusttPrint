import { useEffect, useRef, useState, type FormEvent } from 'react';
import { alerts, type AlertDeliveryStatus, type LowStockRule, type Webhook } from '../api';
import { Button } from '../components/Button';
import { ModalDialog } from '../components/ModalDialog';
import { exposeGlobal, showMessage } from '../page';

declare global {
  interface Window {
    openAlertsSettings?: () => void;
  }
}

/*
 * Settings → Filament → Alerts & webhooks (docs/merge-10.md, Phase 8): the low-stock rules, where
 * alerts go besides JusttPrint (Discord, email) and the webhooks. Admins only. The Discord
 * address, the email password and webhook secrets stay on the server: fields for them are empty
 * and say whether one is set; typing replaces it.
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const EVENT_LABELS: Record<string, string> = { 'spool.low_stock': 'A spool runs low', 'print.logged': 'A print is logged', 'models.added': 'Models are added' };

function RuleRow({ rule, onChange }: { rule: LowStockRule | null; onChange: () => void }) {
  const [form, setForm] = useState(() => ({
    name: rule?.name ?? 'Low stock',
    low: String(rule?.low_threshold_pct ?? 20),
    critical: String(rule?.critical_threshold_pct ?? 10),
    material: rule?.material_filter ?? '',
    discord: Boolean(rule?.notify_discord),
    email: Boolean(rule?.notify_email),
    active: rule ? Boolean(rule.is_active) : true
  }));
  const [error, setError] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await alerts.saveRule({
        id: rule?.id,
        name: form.name,
        low_threshold_pct: Number(form.low),
        critical_threshold_pct: Number(form.critical),
        material_filter: form.material || null,
        notify_discord: form.discord,
        notify_email: form.email,
        is_active: form.active
      });
      onChange();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const remove = async () => {
    if (!rule) return;
    if ((await showMessage('Delete rule', `Delete the rule ${rule.name}?`, ['Delete', 'Cancel'])) !== 'Delete') return;
    await alerts.removeRule(rule.id).catch((failure) => setError(errorText(failure)));
    onChange();
  };
  const set = (key: keyof typeof form) => (event: { target: { value: string; checked?: boolean; type?: string } }) =>
    setForm((f) => ({ ...f, [key]: event.target.type === 'checkbox' ? Boolean(event.target.checked) : event.target.value }));
  return (
    <form className="jp-alerts__rule" onSubmit={save} data-rule-id={rule?.id ?? 'new'}>
      <input className="jp-input" aria-label="Rule name" value={form.name} onChange={set('name')} />
      <label className="jp-alerts__num">
        Low ≤ <input className="jp-input" inputMode="numeric" aria-label="Low at percent left" value={form.low} onChange={set('low')} /> %
      </label>
      <label className="jp-alerts__num">
        Critical ≤ <input className="jp-input" inputMode="numeric" aria-label="Critical at percent left" value={form.critical} onChange={set('critical')} /> %
      </label>
      <input
        className="jp-input jp-alerts__material"
        aria-label="Material (empty: every material)"
        placeholder="Every material"
        value={form.material}
        onChange={set('material')}
      />
      <label className="jp-alerts__check">
        <input type="checkbox" checked={form.discord} onChange={set('discord')} /> Discord
      </label>
      <label className="jp-alerts__check">
        <input type="checkbox" checked={form.email} onChange={set('email')} /> Email
      </label>
      <label className="jp-alerts__check">
        <input type="checkbox" checked={form.active} onChange={set('active')} /> On
      </label>
      <Button type="submit" size="sm" variant={rule ? 'secondary' : 'primary'}>
        {rule ? 'Save' : 'Add rule'}
      </Button>
      {rule && (
        <Button size="sm" variant="ghost" onClick={() => void remove()}>
          Delete
        </Button>
      )}
      {error && (
        <p className="jp-alerts__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function WebhookRow({ hook, events, onChange }: { hook: Webhook | null; events: string[]; onChange: () => void }) {
  const [form, setForm] = useState(() => ({
    name: hook?.name ?? '',
    url: hook?.url ?? '',
    events: new Set(hook?.events ?? []),
    secret: '',
    active: hook ? hook.is_active : true
  }));
  const [note, setNote] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setNote('');
    try {
      await alerts.saveWebhook({
        id: hook?.id,
        name: form.name,
        url: form.url,
        events: [...form.events],
        is_active: form.active,
        ...(form.secret ? { secret: form.secret } : {})
      });
      if (!hook) setForm({ name: '', url: '', events: new Set(), secret: '', active: true });
      onChange();
    } catch (failure) {
      setNote(errorText(failure));
    }
  };
  const test = async () => {
    if (!hook) return;
    const status = await alerts.testWebhook(hook.id).catch(() => 0);
    setNote(status ? `The address answered ${status}.` : 'The address did not answer.');
    onChange();
  };
  const remove = async () => {
    if (!hook || (await showMessage('Delete webhook', `Delete the webhook ${hook.name}?`, ['Delete', 'Cancel'])) !== 'Delete') return;
    await alerts.removeWebhook(hook.id);
    onChange();
  };
  const toggle = (event: string) =>
    setForm((f) => {
      const next = new Set(f.events);
      if (next.has(event)) next.delete(event);
      else next.add(event);
      return { ...f, events: next };
    });
  return (
    <form className="jp-alerts__hook" onSubmit={save} data-webhook-id={hook?.id ?? 'new'}>
      <input className="jp-input" aria-label="Webhook name" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input
        className="jp-input jp-alerts__url"
        aria-label="Webhook address"
        placeholder="https://…"
        value={form.url}
        onChange={(e) => setForm({ ...form, url: e.target.value })}
      />
      <input
        className="jp-input"
        type="password"
        autoComplete="new-password"
        aria-label="Signing secret"
        placeholder={hook?.has_secret ? 'Secret saved (type to replace)' : 'Signing secret (optional)'}
        value={form.secret}
        onChange={(e) => setForm({ ...form, secret: e.target.value })}
      />
      <span className="jp-alerts__events">
        {events.map((event) => (
          <label key={event} className="jp-alerts__check">
            <input type="checkbox" checked={form.events.has(event)} onChange={() => toggle(event)} /> {EVENT_LABELS[event] || event}
          </label>
        ))}
        <span className="jp-meta">{form.events.size ? '' : 'none ticked: every event'}</span>
      </span>
      <label className="jp-alerts__check">
        <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> On
      </label>
      <Button type="submit" size="sm" variant={hook ? 'secondary' : 'primary'}>
        {hook ? 'Save' : 'Add webhook'}
      </Button>
      {hook && (
        <>
          <Button size="sm" onClick={() => void test()}>
            Send test
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void remove()}>
            Delete
          </Button>
          {hook.last_triggered_at && (
            <span className="jp-meta">
              Last: {new Date(hook.last_triggered_at).toLocaleString()} → {hook.last_status_code || 'no answer'}
            </span>
          )}
        </>
      )}
      {note && <p className="jp-meta">{note}</p>}
    </form>
  );
}

export function AlertsSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [rules, setRules] = useState<LowStockRule[]>([]);
  const [status, setStatus] = useState<AlertDeliveryStatus | null>(null);
  const [hooks, setHooks] = useState<{ webhooks: Webhook[]; events: string[] }>({ webhooks: [], events: [] });
  const [discord, setDiscord] = useState('');
  const [email, setEmail] = useState({ host: '', port: '', secure: false, user: '', password: '', from: '', to: '' });
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);

  const reload = async () => {
    const [r, d, w] = await Promise.all([alerts.rules(), alerts.delivery(), alerts.webhooks()]);
    setRules(r.rules);
    setStatus(d);
    setHooks(w);
    setEmail({
      host: d.email.host,
      port: d.email.port ? String(d.email.port) : '',
      secure: d.email.secure,
      user: d.email.user,
      password: '',
      from: d.email.from,
      to: d.email.to
    });
    setDiscord('');
    setVersion((n) => n + 1);
  };

  useEffect(
    () =>
      exposeGlobal('openAlertsSettings', () => {
        setMessage('');
        void reload().then(() => {
          if (!dialogRef.current?.open) dialogRef.current?.showModal();
        });
      }),
    []
  );

  const saveDelivery = async (event: FormEvent) => {
    event.preventDefault();
    setMessage('');
    try {
      await alerts.saveDelivery({
        ...(discord ? { discordWebhookUrl: discord } : {}),
        smtp: {
          host: email.host,
          port: email.port || null,
          secure: email.secure,
          user: email.user,
          from: email.from,
          to: email.to,
          ...(email.password ? { password: email.password } : {})
        }
      });
      setMessage('Saved.');
      await reload();
    } catch (failure) {
      setMessage(errorText(failure));
    }
  };
  const clearDiscord = async () => {
    await alerts.saveDelivery({ discordWebhookUrl: '' });
    await reload();
  };
  const test = async (kind: 'discord' | 'email') => {
    setMessage('');
    try {
      await alerts.testDelivery(kind);
      setMessage(kind === 'discord' ? 'Sent a test to Discord.' : `Sent a test email to ${email.to}.`);
    } catch (failure) {
      setMessage(errorText(failure));
    }
  };

  return (
    <ModalDialog id="alerts-settings-dialog" title="Alerts & webhooks" dialogRef={dialogRef} className="jp-alerts">
      <section className="jp-alerts__section" aria-labelledby="jp-alerts-rules">
        <h4 id="jp-alerts-rules">Low-stock rules</h4>
        <p className="setting-description">
          A spool is low, then critical, when its share left falls to these percentages. Each spool is told once per breach (and again when it turns critical),
          as a notification for editors, and on Discord or by email when the rule says so.{' '}
          {rules.length ? '' : 'With no rule, 20 % and 10 % apply to every material, in notifications only.'}
        </p>
        {rules.map((rule) => (
          <RuleRow key={`${rule.id}-${version}`} rule={rule} onChange={() => void reload()} />
        ))}
        <RuleRow key={`new-${version}`} rule={null} onChange={() => void reload()} />
        <div className="jp-alerts__actions">
          <Button
            size="sm"
            id="alerts-check-now"
            onClick={() =>
              void alerts.checkNow().then(
                (told) => setMessage(told ? `${told} ${told === 1 ? 'spool' : 'spools'} told about.` : 'Nothing new to tell.'),
                (failure) => setMessage(errorText(failure))
              )
            }
          >
            Check now
          </Button>
        </div>
      </section>

      <form className="jp-alerts__section" aria-labelledby="jp-alerts-delivery" onSubmit={saveDelivery}>
        <h4 id="jp-alerts-delivery">Where alerts go</h4>
        <div className="form-group">
          <label htmlFor="alerts-discord">Discord webhook</label>
          <input
            id="alerts-discord"
            type="password"
            autoComplete="off"
            placeholder={status?.discord.set ? 'Saved (type to replace)' : 'https://discord.com/api/webhooks/…'}
            value={discord}
            onChange={(e) => setDiscord(e.target.value)}
          />
          {status?.discord.set && (
            <span className="setting-description">
              <button type="button" className="jp-link" onClick={() => void test('discord')}>
                Send a test
              </button>{' '}
              ·{' '}
              <button type="button" className="jp-link" onClick={() => void clearDiscord()}>
                Remove it
              </button>
            </span>
          )}
        </div>
        <div className="jp-alerts__grid">
          <div className="form-group">
            <label htmlFor="alerts-smtp-host">Email server (SMTP)</label>
            <input id="alerts-smtp-host" placeholder="smtp.example.com" value={email.host} onChange={(e) => setEmail({ ...email, host: e.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="alerts-smtp-port">Port</label>
            <input
              id="alerts-smtp-port"
              inputMode="numeric"
              placeholder={email.secure ? '465' : '587'}
              value={email.port}
              onChange={(e) => setEmail({ ...email, port: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label htmlFor="alerts-smtp-user">User</label>
            <input id="alerts-smtp-user" autoComplete="off" value={email.user} onChange={(e) => setEmail({ ...email, user: e.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="alerts-smtp-password">Password</label>
            <input
              id="alerts-smtp-password"
              type="password"
              autoComplete="new-password"
              placeholder={status?.email.passwordSet ? 'Saved (type to replace)' : ''}
              value={email.password}
              onChange={(e) => setEmail({ ...email, password: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label htmlFor="alerts-smtp-from">From</label>
            <input
              id="alerts-smtp-from"
              placeholder="justtprint@example.com"
              value={email.from}
              onChange={(e) => setEmail({ ...email, from: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label htmlFor="alerts-smtp-to">Send alerts to</label>
            <input id="alerts-smtp-to" placeholder="you@example.com" value={email.to} onChange={(e) => setEmail({ ...email, to: e.target.value })} />
          </div>
        </div>
        <label className="jp-alerts__check">
          <input type="checkbox" checked={email.secure} onChange={(e) => setEmail({ ...email, secure: e.target.checked })} /> TLS from the start (port 465);
          otherwise STARTTLS
        </label>
        <div className="jp-alerts__actions">
          <Button type="submit" variant="primary" id="alerts-delivery-save">
            Save
          </Button>
          {status?.email.ready && <Button onClick={() => void test('email')}>Send a test email</Button>}
          {message && (
            <span className="jp-meta" role="status">
              {message}
            </span>
          )}
        </div>
      </form>

      <section className="jp-alerts__section" aria-labelledby="jp-alerts-webhooks">
        <h4 id="jp-alerts-webhooks">Webhooks</h4>
        <p className="setting-description">
          A JSON POST to each address when something happens. With a secret, it is signed: <code>X-JusttPrint-Signature: sha256=…</code>, the HMAC-SHA256 of the
          body.
        </p>
        {hooks.webhooks.map((hook) => (
          <WebhookRow key={`${hook.id}-${version}`} hook={hook} events={hooks.events} onChange={() => void reload()} />
        ))}
        <WebhookRow key={`new-${version}`} hook={null} events={hooks.events} onChange={() => void reload()} />
      </section>
    </ModalDialog>
  );
}
