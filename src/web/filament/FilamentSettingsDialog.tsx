import { useEffect, useRef, useState } from 'react';
import { settings } from '../api';
import { Button } from '../components/Button';
import { ModalDialog } from '../components/ModalDialog';
import { exposeGlobal } from '../page';
import { currencyChanged, useCurrency } from './currency';
import { CURRENCIES, formatMoney } from './format';
import { formatDay, formatLength, formatTemperature, formatWeightIn, getUnits, saveUnits, type Units } from '../units';

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

/** The day the date examples show. */
const SAMPLE_DAY = new Date(2026, 9, 30);

export function FilamentSettingsDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const saved = useCurrency();
  const [code, setCode] = useState(saved);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Units and date format (docs/plan-10.1.md, Phase 6); saving them reloads the page.
  const [units, setUnits] = useState<Units>(getUnits());
  const unitsChanged = JSON.stringify(units) !== JSON.stringify(getUnits());
  // The price of electricity per kWh, for the cost of a print (Phase 8).
  const [kwhSaved, setKwhSaved] = useState('');
  const [kwh, setKwh] = useState('');
  const kwhChanged = kwh.trim() !== kwhSaved;
  const setUnit =
    <K extends keyof Units>(key: K) =>
    (event: { target: { value: string } }) =>
      setUnits((u) => ({ ...u, [key]: event.target.value as Units[K] }));

  useEffect(
    () =>
      exposeGlobal('openFilamentSettings', () => {
        setError('');
        setUnits(getUnits());
        settings.get<string | null>('electricityPrice').then(
          (value) => {
            const text = value === null || value === undefined ? '' : String(value);
            setKwhSaved(text);
            setKwh(text);
          },
          () => {}
        );
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
      }),
    []
  );
  useEffect(() => setCode(saved), [saved]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (code !== saved) {
        await settings.save('currency', code);
        currencyChanged(code);
      }
      if (kwhChanged) {
        const value = kwh.trim().replace(',', '.');
        if (value && (!Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error('The electricity price is a number, such as 0.30');
        await settings.save('electricityPrice', value);
        setKwhSaved(value);
      }
      if (unitsChanged) {
        await saveUnits(units);
        window.location.reload();
        return;
      }
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
          <Button variant="primary" disabled={busy || (code === saved && !unitsChanged && !kwhChanged)} onClick={() => void save()} id="filament-settings-save">
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
      <div className="form-group">
        <label htmlFor="filament-electricity-price">Electricity price per kWh ({code})</label>
        <input id="filament-electricity-price" inputMode="decimal" placeholder="0.30" value={kwh} onChange={(event) => setKwh(event.target.value)} />
        <p className="setting-description">
          For the cost of a print on a model&apos;s page, with each printer&apos;s power (Printers). Empty: no electricity in the cost.
        </p>
      </div>
      <div className="form-group">
        <label htmlFor="filament-weight-unit">Weight</label>
        <select id="filament-weight-unit" value={units.weight} onChange={setUnit('weight')}>
          <option value="g">
            Grams, kilograms from 1,000 g ({formatWeightIn(640, 'g')}, {formatWeightIn(1500, 'g')})
          </option>
          <option value="kg">Kilograms ({formatWeightIn(640, 'kg')})</option>
          <option value="oz">Ounces ({formatWeightIn(640, 'oz')})</option>
          <option value="lb">Pounds ({formatWeightIn(640, 'lb')})</option>
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="filament-temperature-unit">Temperature</label>
        <select id="filament-temperature-unit" value={units.temperature} onChange={setUnit('temperature')}>
          <option value="C">Celsius ({formatTemperature(210, 'C')})</option>
          <option value="F">Fahrenheit ({formatTemperature(210, 'F')})</option>
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="filament-length-unit">Length</label>
        <select id="filament-length-unit" value={units.length} onChange={setUnit('length')}>
          <option value="mm">Millimetres ({formatLength(1.75, 'mm')})</option>
          <option value="in">Inches ({formatLength(1.75, 'in')})</option>
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="filament-date-format">Dates</label>
        <select id="filament-date-format" value={units.date} onChange={setUnit('date')}>
          <option value="locale">This browser&apos;s way ({formatDay(SAMPLE_DAY, 'locale')})</option>
          <option value="ymd">{formatDay(SAMPLE_DAY, 'ymd')}</option>
          <option value="dmy">{formatDay(SAMPLE_DAY, 'dmy')} (day first)</option>
          <option value="mdy">{formatDay(SAMPLE_DAY, 'mdy')} (month first)</option>
        </select>
        <p className="setting-description">
          For everyone on this library. Spools and filaments are kept in grams, °C and millimetres; these only change how they are shown and typed. Saving these
          reloads the page.
        </p>
      </div>
    </ModalDialog>
  );
}
