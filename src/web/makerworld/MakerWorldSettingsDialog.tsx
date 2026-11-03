import { useEffect, useRef, useState } from 'react';
import { callAction, settings } from '../api';
import { ModalDialog } from '../components/ModalDialog';
import { askText, exposeGlobal, showMessage } from '../page';
import { accountLabel, accountStatus, MAKERWORLD_ACCOUNT_CHANGED, type AccountStatus, type SavedAccount } from './makerworld';
import { GoogleTranslateSteps, MakerWorldSteps } from '../links/SiteSetup';
import { googleFirst, move, orderOf, rowsFor, savedOrder, TRANSLATOR_LABELS, usageLine, type TranslatorRow } from './translators';

declare global {
  interface Window {
    openMakerWorldSettings?: () => void;
  }
}

const TRANSLATION_KEY = 'makerWorldTranslation';
const ORDER_KEY = 'translationOrder';
const AT_LIMIT_KEY = 'googleTranslateAtLimit';
const FREE_KEY = 'googleTranslateFreeChars';

/** google-translate-status (src/server/google-translate.js). */
interface GoogleStatus {
  hasKey: boolean;
  keyHint: string | null;
  used: number;
  free: number;
  percent: number;
  month: string;
  daysLeft: number;
  resetsOn: string;
  atLimit: 'stop' | 'pay';
  stopped: boolean;
}

/**
 * Settings → MakerWorld: the MakerWorld sign-ins (sign in, sign out, switch to another account
 * signed in before, nicknames, signing in again when one has expired), and where the English names
 * of MakerWorld files come from. Registers window.openMakerWorldSettings.
 */
export function MakerWorldSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [rows, setRows] = useState<TranslatorRow[]>(rowsFor(['free']));
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [googleKey, setGoogleKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [atLimit, setAtLimit] = useState<'stop' | 'pay'>('stop');
  const [freeChars, setFreeChars] = useState('500000');
  const [saving, setSaving] = useState(false);

  const loadGoogle = () =>
    callAction<GoogleStatus>('google-translate-status').then(
      (found) => {
        setGoogle(found);
        setAtLimit(found.atLimit);
        setFreeChars(String(found.free));
        return found;
      },
      () => null
    );

  async function saveKey(remove = false) {
    setKeyBusy(true);
    try {
      const had = google?.hasKey;
      const found = await callAction<GoogleStatus>('set-google-translate-key', remove ? '' : googleKey);
      setGoogle(found);
      setGoogleKey('');
      // A new key: Google goes first (move it in the list to change that).
      if (found.hasKey && !had) setRows((now) => googleFirst(now));
      if (!found.hasKey) setRows((now) => now.map((row) => (row.id === 'google' ? { ...row, on: false } : row)));
    } catch (error) {
      await showMessage('Google Cloud Translation', error instanceof Error ? error.message : String(error));
    } finally {
      setKeyBusy(false);
    }
  }

  const refresh = () =>
    Promise.all([
      accountStatus().then(setStatus, () => setStatus(null)),
      callAction<SavedAccount[]>('makerworld-accounts').then(setAccounts, () => setAccounts([]))
    ]);

  async function changeAccount(action: string, ...args: (string | null)[]) {
    try {
      await callAction(action, ...args);
      window.dispatchEvent(new Event(MAKERWORLD_ACCOUNT_CHANGED));
      await refresh();
    } catch (error) {
      await showMessage('MakerWorld', error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(
    () =>
      exposeGlobal('openMakerWorldSettings', () => {
        void refresh();
        void loadGoogle();
        Promise.all([settings.get<string | null>(ORDER_KEY), settings.get<string | null>(TRANSLATION_KEY)])
          .then(([order, legacy]) => setRows(rowsFor(savedOrder(order, legacy))))
          .catch(() => {})
          .finally(() => {
            if (!dialogRef.current?.open) dialogRef.current?.showModal();
          });
      }),
    []
  );

  async function signIn(email = '') {
    if (await window.signInMakerWorld?.(undefined, email)) await refresh();
  }

  async function signOut() {
    setStatus(await callAction<AccountStatus>('makerworld-sign-out'));
    window.dispatchEvent(new Event(MAKERWORLD_ACCOUNT_CHANGED));
    await refresh();
  }

  async function rename(saved: SavedAccount) {
    const nickname = await askText(
      'Account Nickname',
      `A short name for ${saved.account}, such as Personal or Home (leave it empty for none).`,
      saved.nickname || ''
    );
    if (nickname !== null) await changeAccount('makerworld-rename-account', saved.account, nickname);
  }

  async function save() {
    setSaving(true);
    try {
      const order = orderOf(rows);
      await settings.save(ORDER_KEY, JSON.stringify(order));
      // The older single choice, for anything still reading it.
      await settings.save(TRANSLATION_KEY, order.find((id) => id !== 'google') || (order.length ? 'free' : 'off'));
      await settings.save(AT_LIMIT_KEY, atLimit);
      const free = Math.floor(Number(freeChars));
      if (Number.isFinite(free) && free > 0) await settings.save(FREE_KEY, String(free));
      dialogRef.current?.close();
      await showMessage(
        'Saved',
        'MakerWorld settings saved. Models already shown get the new English names when you press Refresh in their MakerWorld section.'
      );
    } catch (error) {
      await showMessage('Error', error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalDialog
      id="makerworld-settings-dialog"
      title="MakerWorld"
      dialogRef={dialogRef}
      footer={
        <>
          <button type="button" id="save-makerworld-settings" className="is-primary" disabled={saving} onClick={save}>
            Save
          </button>
          <button type="button" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
        </>
      }
    >
      <div className="settings-group">
        <h4>Account</h4>
        <p className="setting-description" id="makerworld-account-status">
          {!status?.signedIn
            ? 'Not signed in. MakerWorld asks for a sign-in before the first download.'
            : status.expired
              ? `The sign-in for ${accountLabel(status)} has expired. Sign in again to download from MakerWorld.`
              : `Downloads from MakerWorld use ${accountLabel(status)}.`}
        </p>
        {!status?.signedIn && <MakerWorldSteps />}
        {accounts.length > 0 && (
          <ul className="translator-list makerworld-accounts" id="makerworld-accounts">
            {accounts.map((saved) => (
              <li key={saved.account} className={saved.active ? 'is-on' : undefined}>
                <span className="makerworld-accounts__who">
                  <span>{accountLabel(saved)}</span>
                  {saved.active && <span className="makerworld-accounts__tag">In use</span>}
                  {saved.expired && <span className="makerworld-accounts__tag is-expired">Sign-in expired</span>}
                </span>
                <span className="makerworld-accounts__buttons">
                  {!saved.active && (
                    <button type="button" onClick={() => void changeAccount('makerworld-activate-account', saved.account)}>
                      Use
                    </button>
                  )}
                  {saved.expired && (
                    <button type="button" onClick={() => void signIn(saved.account || '')}>
                      Sign In Again…
                    </button>
                  )}
                  <button type="button" onClick={() => void rename(saved)}>
                    Rename…
                  </button>
                  {saved.active ? (
                    <button type="button" id="makerworld-sign-out" onClick={signOut}>
                      Sign Out
                    </button>
                  ) : (
                    <button type="button" onClick={() => void changeAccount('makerworld-forget-account', saved.account)}>
                      Forget
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {accounts.length > 1 && <p className="setting-description">Use switches accounts without the password. Downloads use one account at a time.</p>}
        <div className="translator-key-buttons">
          <button type="button" id={accounts.length ? 'makerworld-add-account' : 'makerworld-sign-in'} onClick={() => void signIn()}>
            {accounts.length ? 'Add Another Account…' : 'Sign In…'}
          </button>
        </div>
      </div>
      <div className="settings-group">
        <h4>English file names and notes</h4>
        <p className="setting-description">
          MakerWorld does not translate file names, and designers often write their descriptions in their own language. Names and notes already in English are
          left alone. A model's page shows English under notes in another language, and a new model's notes are saved in English with the original under them.
          The translators below are tried from the top: when one fails, is not set up or has used up its free characters, the next one is used. Untick them all
          to keep the original names and notes. Only the names and notes are sent.
        </p>
        <ol className="translator-list" id="translator-list">
          {rows.map((row, index) => (
            <li key={row.id} className={row.on ? 'is-on' : undefined}>
              <label>
                <input
                  type="checkbox"
                  checked={row.on}
                  disabled={row.id === 'google' && !google?.hasKey}
                  onChange={(event) => setRows((now) => now.map((r) => (r.id === row.id ? { ...r, on: event.target.checked } : r)))}
                />
                <span>
                  {TRANSLATOR_LABELS[row.id]}
                  <span className="setting-description">
                    {row.id === 'google'
                      ? google?.hasKey
                        ? ` · key ${google.keyHint}`
                        : ' · add an API key below'
                      : row.id === 'free'
                        ? ' · no account, about 5,000 characters a day'
                        : ' · its costs'}
                  </span>
                </span>
              </label>
              <span className="translator-list__move">
                <button
                  type="button"
                  aria-label={`Move ${TRANSLATOR_LABELS[row.id]} up`}
                  disabled={index === 0}
                  onClick={() => setRows((now) => move(now, index, -1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${TRANSLATOR_LABELS[row.id]} down`}
                  disabled={index === rows.length - 1}
                  onClick={() => setRows((now) => move(now, index, 1))}
                >
                  ↓
                </button>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <div className="settings-group" id="google-translate-settings">
        <h4>Google Cloud Translation</h4>
        <p className="setting-description">
          An API key from a Google Cloud project with the Cloud Translation API turned on (and billing, which Google asks for even within the free characters).
          Google gives {Number(google?.free || 500000).toLocaleString('en-US')} characters a month free and then charges about $20 per million; JusttPrint
          counts what it sends and warns in the notifications at 80% and 95% and when they are used up.
        </p>
        <details className="google-translate-help" open={!google?.hasKey}>
          <summary>How to get an API key</summary>
          <GoogleTranslateSteps />
          <p className="setting-description">
            Google sometimes moves things in its console: searching its top bar for “Credentials” or “Cloud Translation API” always gets there.
          </p>
        </details>
        <div className="form-group">
          <label htmlFor="google-translate-key">{google?.hasKey ? `API key (${google.keyHint}): replace it` : 'API key'}</label>
          <input
            id="google-translate-key"
            type="password"
            autoComplete="off"
            value={googleKey}
            placeholder={google?.hasKey ? 'A new key' : 'AIza…'}
            onChange={(event) => setGoogleKey(event.target.value)}
          />
          <div className="translator-key-buttons">
            <button type="button" id="google-translate-save-key" disabled={keyBusy || !googleKey.trim()} onClick={() => void saveKey()}>
              {keyBusy ? 'Checking…' : 'Check and Save Key'}
            </button>
            {google?.hasKey && (
              <button type="button" disabled={keyBusy} onClick={() => void saveKey(true)}>
                Remove Key
              </button>
            )}
          </div>
        </div>
        {google?.hasKey && (
          <>
            <div className={`google-usage${google.percent >= 95 ? ' is-danger' : google.percent >= 80 ? ' is-warning' : ''}`} id="google-translate-usage">
              <div
                className="google-usage__bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={google.percent}
                aria-label="Free characters used"
              >
                <span style={{ width: `${google.percent}%` }} />
              </div>
              <p className="setting-description">
                {usageLine(google)}
                {google.stopped ? ' · used up: JusttPrint is not using Google until then' : ''}
              </p>
            </div>
            <div className="form-group">
              <span className="google-usage__label">When the free characters are used up:</span>
              <label className="translator-radio">
                <input type="radio" name="google-at-limit" checked={atLimit === 'stop'} onChange={() => setAtLimit('stop')} />
                <span>Stop using Google until the month resets (the next translator is used)</span>
              </label>
              <label className="translator-radio">
                <input type="radio" name="google-at-limit" id="google-at-limit-pay" checked={atLimit === 'pay'} onChange={() => setAtLimit('pay')} />
                <span>Keep using Google and pay for the characters over the free ones</span>
              </label>
            </div>
            <div className="form-group">
              <label htmlFor="google-translate-free">Free characters a month</label>
              <input id="google-translate-free" type="number" min={1000} step={1000} value={freeChars} onChange={(event) => setFreeChars(event.target.value)} />
              <p className="setting-description">Google's free allowance; change it only if Google changes it.</p>
            </div>
          </>
        )}
      </div>
    </ModalDialog>
  );
}
