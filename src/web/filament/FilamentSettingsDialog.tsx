import { useEffect, useRef, useState } from 'react';
import { settings } from '../api';
import { Button } from '../components/Button';
import { ModalDialog } from '../components/ModalDialog';
import { exposeGlobal } from '../page';
import { currencyChanged, useCurrency } from './currency';
import { CURRENCIES, formatMoney } from './format';

declare global {
  interface Window {
    openFilamentSettings?: () => void;
  }
}

/*
 * Settings → Printers → Filament settings (docs/merge-10.md, Phase 10): the currency spool prices
 * are in, used for prices, the reorder list, what the spools are worth and the cost on
 * Statistics. Amounts are not converted. Admins only.
 */

export function FilamentSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const saved = useCurrency();
  const [code, setCode] = useState(saved);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      exposeGlobal('openFilamentSettings', () => {
        setError('');
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
      }),
    []
  );
  useEffect(() => setCode(saved), [saved]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await settings.save('currency', code);
      currencyChanged(code);
      dialogRef.current?.close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const names = (() => {
    try {
      return new Intl.DisplayNames(undefined, { type: 'currency' });
    } catch {
      return null;
    }
  })();

  return (
    <ModalDialog
      id="filament-settings-dialog"
      title="Filament settings"
      dialogRef={dialogRef}
      footer={
        <>
          {error && (
            <span className="jp-fh-import__error" role="alert">
              {error}
            </span>
          )}
          <Button variant="primary" disabled={busy || code === saved} onClick={() => void save()} id="filament-settings-save">
            Save
          </Button>
          <Button onClick={() => dialogRef.current?.close()}>Cancel</Button>
        </>
      }
    >
      <div className="form-group">
        <label htmlFor="filament-currency">Currency</label>
        <select id="filament-currency" value={code} onChange={(event) => setCode(event.target.value)}>
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
              {names?.of(c) ? ` · ${names.of(c)}` : ''}
            </option>
          ))}
        </select>
        <p className="setting-description">
          What you pay for spools in. Prices, the reorder list, what your spools are worth and the filament cost on Statistics show in it (for example{' '}
          {formatMoney(19.99, code)}). Amounts already entered are not converted.
        </p>
      </div>
    </ModalDialog>
  );
}
