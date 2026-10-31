import { useEffect, useRef, useState } from 'react';
import { signInSecurity, type MyApiKey, type MySession, type UserRole } from './api';
import { Button } from './components/Button';
import { ModalDialog } from './components/ModalDialog';
import { copyText, exposeGlobal, showMessage } from './page';
import { useCurrentUser } from './session';
import { formatDayTime } from './units';

declare global {
  interface Window {
    openSignInSecurity?: () => void;
  }
}

/*
 * Settings → Authentication → Sign-in & security (docs/plan-10.1.md, Phase 12), each person their
 * own: two-factor sign-in with an authenticator app (and recovery codes, shown once), where they
 * are signed in (end one, or all the others), and their API keys (shown once).
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** "Chrome on macOS" from a browser's user agent; the raw text when it is not one of those. */
export function deviceName(agent: string | null): string {
  if (!agent) return 'Unknown device';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : /curl|node|python|Go-http/i.test(agent)
            ? 'A script'
            : null;
  const os = /iPhone|iPad/.test(agent)
    ? 'iOS'
    : /Android/.test(agent)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(agent)
        ? 'macOS'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Linux/.test(agent)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || agent.slice(0, 60);
}

const ROLES: [UserRole, string][] = [
  ['viewer', 'Viewer (look and download)'],
  ['editor', 'Editor (also change the library)'],
  ['admin', 'Admin (also settings and accounts)']
];
const RANK: Record<UserRole, number> = { viewer: 0, editor: 1, admin: 2 };

function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="jp-security__codes" id="security-recovery-codes">
      <p className="setting-description">
        <strong>Your recovery codes.</strong> Keep them somewhere safe: each signs you in once without your phone. They are not shown again.
      </p>
      <ul>
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <Button size="sm" onClick={() => void copyText(codes.join('\n')).then(setCopied)}>
        {copied ? 'Copied' : 'Copy them'}
      </Button>
    </div>
  );
}

function TwoFactor() {
  const [state, setState] = useState<{ enabled: boolean; recoveryCodesLeft: number; required: boolean } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => signInSecurity.twoFactor().then(setState, (failure) => setError(errorText(failure)));
  useEffect(() => {
    void load();
  }, []);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="jp-security__part" aria-labelledby="security-2fa-title">
      <h3 id="security-2fa-title">Two-factor sign-in</h3>
      {state && !state.enabled && !setup && (
        <>
          <p className="setting-description">
            Sign in with a code from an authenticator app (Google Authenticator, 1Password, Aegis…) as well as your password.
            {state.required ? ' This library requires it.' : ''}
          </p>
          <Button onClick={() => void run(async () => setSetup(await signInSecurity.startTwoFactor()))} disabled={busy} id="security-2fa-start">
            Set Up
          </Button>
        </>
      )}
      {setup && !codes && (
        <div className="jp-security__setup">
          <p className="setting-description">Scan this with your authenticator app, then enter the code it shows.</p>
          <div className="jp-security__qr" aria-label="QR code for your authenticator app" role="img" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
          <p className="jp-security__secret" id="security-2fa-secret">
            Or type this key: <code>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
          </p>
          <div className="form-group">
            <label htmlFor="security-2fa-code">Code</label>
            <input id="security-2fa-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
          </div>
          <Button
            variant="primary"
            disabled={busy || !code.trim()}
            id="security-2fa-enable"
            onClick={() =>
              void run(async () => {
                setCodes((await signInSecurity.enableTwoFactor(code.trim())).recoveryCodes);
                setCode('');
                await load();
              })
            }
          >
            Turn On
          </Button>
        </div>
      )}
      {codes && <RecoveryCodes codes={codes} />}
      {state?.enabled && !codes && (
        <>
          <p className="setting-description" id="security-2fa-on">
            On: you sign in with a code from your app. {state.recoveryCodesLeft} recovery {state.recoveryCodesLeft === 1 ? 'code' : 'codes'} left.
          </p>
          <div className="form-group">
            <label htmlFor="security-2fa-password">Your password (to change this)</label>
            <input
              id="security-2fa-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div className="jp-security__row">
            <Button
              disabled={busy || !password}
              onClick={() =>
                void run(async () => {
                  setCodes((await signInSecurity.newRecoveryCodes(password)).recoveryCodes);
                  setPassword('');
                  await load();
                })
              }
            >
              New Recovery Codes
            </Button>
            {!state.required && (
              <Button
                disabled={busy || !password}
                id="security-2fa-off"
                onClick={() =>
                  void run(async () => {
                    await signInSecurity.disableTwoFactor(password);
                    setPassword('');
                    setSetup(null);
                    await load();
                  })
                }
              >
                Turn Off
              </Button>
            )}
          </div>
        </>
      )}
      {error && (
        <p className="jp-fh-import__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function Sessions() {
  const [list, setList] = useState<MySession[] | null>(null);
  const [error, setError] = useState('');
  const load = () => signInSecurity.sessions().then(setList, (failure) => setError(errorText(failure)));
  useEffect(() => {
    void load();
  }, []);
  const end = async (session: MySession) => {
    try {
      await signInSecurity.endSession(session.id);
      await load();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const endOthers = async () => {
    if ((await showMessage('End the other sessions', 'Sign out everywhere but this browser?', ['Sign Out', 'Cancel'])) !== 'Sign Out') return;
    try {
      await signInSecurity.endOtherSessions();
      await load();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  return (
    <section className="jp-security__part" aria-labelledby="security-sessions-title">
      <h3 id="security-sessions-title">Where you are signed in</h3>
      <table className="jp-security__table" id="security-sessions">
        <thead>
          <tr>
            <th scope="col">Device</th>
            <th scope="col">Address</th>
            <th scope="col">Last seen</th>
            <th scope="col">
              <span className="jp-sr-only">End</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(list || []).map((session) => (
            <tr key={session.id}>
              <td title={session.userAgent || ''}>{deviceName(session.userAgent)}</td>
              <td>{session.ip || '—'}</td>
              <td>{formatDayTime(session.lastSeenAt)}</td>
              <td>
                {session.current ? (
                  <span className="jp-meta">This browser</span>
                ) : (
                  <Button size="sm" onClick={() => void end(session)}>
                    End
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="setting-description">Sign-ins from before JusttPrint 10.2 are not listed; End All Others ends those too.</p>
      <Button onClick={() => void endOthers()} id="security-end-others">
        End All Others
      </Button>
      {error && (
        <p className="jp-fh-import__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ApiKeys() {
  const me = useCurrentUser();
  const myRank = me?.role ? RANK[me.role as UserRole] : 0;
  const [list, setList] = useState<MyApiKey[] | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('viewer');
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const load = () => signInSecurity.apiKeys().then(setList, (failure) => setError(errorText(failure)));
  useEffect(() => {
    void load();
  }, []);
  const create = async () => {
    setError('');
    try {
      const result = await signInSecurity.createApiKey({ name: name.trim(), role });
      setMade(result.token);
      setCopied(false);
      setName('');
      await load();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const remove = async (key: MyApiKey) => {
    if ((await showMessage('Delete API key', `Delete the key "${key.name}"? Whatever uses it stops working.`, ['Delete', 'Cancel'])) !== 'Delete') return;
    await signInSecurity.deleteApiKey(key.id).catch((failure) => setError(errorText(failure)));
    await load();
  };
  return (
    <section className="jp-security__part" aria-labelledby="security-keys-title">
      <h3 id="security-keys-title">API keys</h3>
      <p className="setting-description">
        For scripts and apps that use JusttPrint as you (<code>Authorization: Bearer jpk_…</code>), with a role no higher than yours. A key cannot change how
        you sign in.
      </p>
      {list && list.length > 0 && (
        <table className="jp-security__table" id="security-keys">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Role</th>
              <th scope="col">Starts</th>
              <th scope="col">Last used</th>
              <th scope="col">
                <span className="jp-sr-only">Delete</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((key) => (
              <tr key={key.id}>
                <td>{key.name}</td>
                <td>{key.role}</td>
                <td>
                  <code>{key.prefix}…</code>
                </td>
                <td>{key.lastUsedAt ? formatDayTime(key.lastUsedAt) : 'Never'}</td>
                <td>
                  <Button size="sm" onClick={() => void remove(key)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {made && (
        <div className="jp-security__made" id="security-key-made">
          <p className="setting-description">
            <strong>Your new key</strong> (shown once):
          </p>
          <code className="jp-security__token">{made}</code>
          <Button size="sm" onClick={() => void copyText(made).then(setCopied)}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
      <div className="jp-security__row">
        <input
          className="jp-input"
          aria-label="Name of the new key"
          id="security-key-name"
          placeholder="What uses it (Home script, OctoPrint…)"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          className="jp-input"
          aria-label="Role of the new key"
          id="security-key-role"
          value={role}
          onChange={(event) => setRole(event.target.value as UserRole)}
        >
          {ROLES.filter(([r]) => RANK[r] <= myRank).map(([r, label]) => (
            <option key={r} value={r}>
              {label}
            </option>
          ))}
        </select>
        <Button onClick={() => void create()} disabled={!name.trim()} id="security-key-create">
          New Key
        </Button>
      </div>
      {error && (
        <p className="jp-fh-import__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function SignInSecurityDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // A new key for each opening, so the parts load afresh.
  const [opened, setOpened] = useState(0);
  useEffect(
    () =>
      exposeGlobal('openSignInSecurity', () => {
        setOpened((n) => n + 1);
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
      }),
    []
  );
  return (
    <ModalDialog
      id="sign-in-security-dialog"
      title="Sign-in & security"
      dialogRef={dialogRef}
      footer={<Button onClick={() => dialogRef.current?.close()}>Close</Button>}
    >
      {opened > 0 && (
        <div key={opened} className="jp-security">
          <TwoFactor />
          <Sessions />
          <ApiKeys />
        </div>
      )}
    </ModalDialog>
  );
}
