import { useEffect, useState } from 'react';
import { callAction } from '../api';
import { Button } from '../components/Button';
import { showMessage } from '../page';
import { accountLabel, MAKERWORLD_ACCOUNT_CHANGED, type SavedAccount } from './makerworld';

/**
 * Download from MakerWorld and Add Links: which MakerWorld account the download uses, with a menu
 * to switch when more than one is signed in, and Sign In Again when its sign-in has expired.
 * Shows nothing with one account that works (or none: the sign-in is asked for on download).
 */
export function MakerWorldAccountNote({ disabled = false }: { disabled?: boolean }) {
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);

  useEffect(() => {
    let current = true;
    const load = () =>
      callAction<SavedAccount[]>('makerworld-accounts').then(
        (found) => current && setAccounts(found),
        () => current && setAccounts([])
      );
    void load();
    window.addEventListener(MAKERWORLD_ACCOUNT_CHANGED, load);
    return () => {
      current = false;
      window.removeEventListener(MAKERWORLD_ACCOUNT_CHANGED, load);
    };
  }, []);

  const active = accounts.find((saved) => saved.active);
  if (!active || (accounts.length < 2 && !active.expired)) return null;

  async function use(email: string) {
    try {
      await callAction('makerworld-activate-account', email);
    } catch (error) {
      await showMessage('MakerWorld', error instanceof Error ? error.message : String(error));
    }
    window.dispatchEvent(new Event(MAKERWORLD_ACCOUNT_CHANGED));
  }

  return (
    <div className="jp-mw-account" id="jp-mw-account">
      {accounts.length > 1 ? (
        <label className="jp-mw-account__pick">
          <span className="jp-label">Downloads with</span>
          <select
            className="jp-input"
            id="jp-mw-account-select"
            value={active.account || ''}
            disabled={disabled}
            onChange={(event) => void use(event.target.value)}
          >
            {[...accounts]
              .sort((a, b) => accountLabel(a).localeCompare(accountLabel(b)))
              .map((saved) => (
                <option key={saved.account} value={saved.account || ''}>
                  {accountLabel(saved)}
                  {saved.expired ? ' (sign-in expired)' : ''}
                </option>
              ))}
          </select>
        </label>
      ) : (
        <span className="jp-meta">Downloads with {accountLabel(active)}</span>
      )}
      {active.expired && (
        <p className="jp-mw-download__problem" role="alert">
          The sign-in for this account has expired.{' '}
          <Button size="sm" disabled={disabled} onClick={() => void window.signInMakerWorld?.(undefined, active.account || '')}>
            Sign In Again…
          </Button>
        </p>
      )}
    </div>
  );
}
