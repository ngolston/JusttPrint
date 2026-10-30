import { useEffect, useState } from 'react';
import { Droplets, Plus, Trash2 } from 'lucide-react';
import { filament, printers as printerApi, type LoadedSpool, type PrinterLoads, type Spool } from '../api';
import { Button, cx } from '../components/Button';
import { EditOnly } from '../components/EditOnly';
import { SpoolRing } from '../components/Filament';
import { Modal } from '../components/Overlay';
import { formatWeight } from '../filament/format';
import { askText, showMessage } from '../page';
import { useCan } from '../session';

/*
 * What is loaded in a printer (docs/merge-10.md, Phase 5): a strip of rings on its tile, and on
 * its page the AMS units with their slots and the printer's own holder, each loaded or emptied
 * with a spool from the Filament page.
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Every spool a printer holds, AMS slots first: [{ label, spool }]. */
export function loadedSpools(loads: PrinterLoads | null | undefined): { label: string; spool: LoadedSpool | null }[] {
  if (!loads) return [];
  return [
    ...loads.units.flatMap((unit) => unit.slots.map((slot) => ({ label: slot.label, spool: slot.spool }))),
    ...(loads.direct ? [{ label: 'Holder', spool: loads.direct }] : [])
  ];
}

/** The rings on a printer's tile: its slots, empty ones as empty rings. */
export function LoadedStrip({ loads }: { loads: PrinterLoads | null | undefined }) {
  const slots = loadedSpools(loads);
  if (!slots.length) return null;
  return (
    <span className="jp-loaded-strip" aria-label="Loaded filament">
      {slots.map(({ label, spool }) => (
        <span
          key={label}
          className="jp-loaded-strip__slot"
          title={spool ? `${label}: ${spool.name}, ${formatWeight(spool.remaining)} left` : `${label}: empty`}
        >
          {spool ? (
            <SpoolRing
              color={spool.color_hex || '#9aa4b4'}
              remaining={spool.remaining}
              capacity={spool.initial_weight}
              size={30}
              name={`${label}: ${spool.name}`}
            />
          ) : (
            <span className="jp-loaded-strip__empty" role="img" aria-label={`${label}: empty`} />
          )}
          <span className="jp-loaded-strip__label">{label}</span>
        </span>
      ))}
    </span>
  );
}

type Target = { label: string; slotId?: number; printerId?: number; current: LoadedSpool | null };

/** Choose the spool for a slot or the holder, or empty it. */
function LoadDialog({ target, onClose }: { target: Target; onClose: () => void }) {
  const [spools, setSpools] = useState<Spool[] | null>(null);
  const [chosen, setChosen] = useState(target.current ? String(target.current.id) : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    filament.spools(false).then(setSpools, (failure) => setError(errorText(failure)));
  }, []);
  const save = async (spoolId: number | null) => {
    setBusy(true);
    setError('');
    try {
      await printerApi.load({ slotId: target.slotId, printerId: target.printerId }, spoolId);
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Load ${target.label}`}
      id="jp-load-spool-dialog"
      className="jp-filament-form"
      footer={
        <>
          {error && (
            <p className="jp-filament-form__error" role="alert">
              {error}
            </p>
          )}
          {target.current && (
            <Button variant="ghost" onClick={() => void save(null)} disabled={busy} id="jp-load-empty">
              Empty it
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !chosen} onClick={() => void save(Number(chosen))} id="jp-load-save">
            Load
          </Button>
        </>
      }
    >
      {spools && !spools.length ? (
        <p className="jp-meta">No spools yet: add them on the Filament page.</p>
      ) : (
        <label className="jp-edit__field">
          <span className="jp-edit__label">Spool</span>
          <select id="jp-load-spool" className="jp-input" value={chosen} onChange={(event) => setChosen(event.target.value)} autoFocus>
            <option value="">Choose a spool…</option>
            {(spools || []).map((spool) => (
              <option key={spool.id} value={spool.id}>
                {spool.display_name}
                {spool.brand_name ? ` (${spool.brand_name})` : ''} · {formatWeight(spool.remaining)} left
                {spool.loaded.length ? ` · now in ${spool.loaded[0].label}` : ''}
              </option>
            ))}
          </select>
          <span className="jp-edit__hint">A spool loaded elsewhere moves here.</span>
        </label>
      )}
    </Modal>
  );
}

function Slot({ label, spool, onClick, canEdit }: { label: string; spool: LoadedSpool | null; onClick: () => void; canEdit: boolean }) {
  const inner = (
    <>
      {spool ? (
        <SpoolRing color={spool.color_hex || '#9aa4b4'} remaining={spool.remaining} capacity={spool.initial_weight} size={48} />
      ) : (
        <span className="jp-loaded-slot__empty" aria-hidden="true" />
      )}
      <span className="jp-loaded-slot__label">{label}</span>
      <span className="jp-loaded-slot__name">{spool ? spool.name : 'Empty'}</span>
      {spool && <span className={cx('jp-loaded-slot__grams', spool.remaining < 50 && 'is-empty')}>{formatWeight(spool.remaining)}</span>}
      {canEdit && <span className="jp-sr-only">, change</span>}
    </>
  );
  return canEdit ? (
    <button type="button" className={cx('jp-loaded-slot', !spool && 'is-empty')} onClick={onClick} title={`Load ${label}`}>
      {inner}
    </button>
  ) : (
    <span className={cx('jp-loaded-slot', !spool && 'is-empty')}>{inner}</span>
  );
}

/** The printer page's Filament loaded section. */
export function LoadedSection({ printerId, loads }: { printerId: number; loads: PrinterLoads | null }) {
  const canEdit = useCan('editor');
  const [target, setTarget] = useState<Target | null>(null);
  const fail = (error: unknown) => showMessage('Filament', errorText(error));

  const addAms = () => printerApi.addAms(printerId).catch(fail);
  const rename = async (unit: PrinterLoads['units'][number]) => {
    const name = await askText('Rename AMS', 'Name of this AMS unit:', unit.name);
    if (name !== null) await printerApi.updateAms(unit.id, { name }).catch(fail);
  };
  const humidity = async (unit: PrinterLoads['units'][number]) => {
    const value = await askText('AMS humidity', 'Humidity in this unit (%), or empty if not known:', unit.humidity === null ? '' : String(unit.humidity));
    if (value !== null) await printerApi.updateAms(unit.id, { humidity: value.trim() === '' ? null : Number(value) }).catch(fail);
  };
  const removeAms = async (unit: PrinterLoads['units'][number]) => {
    const answer = await showMessage('Remove AMS', `Remove ${unit.name}? Its spools stay on the Filament page, loaded nowhere.`, ['Remove', 'Cancel']);
    if (answer === 'Remove') await printerApi.removeAms(unit.id).catch(fail);
  };

  return (
    <section className="jp-printer-detail__section" aria-labelledby="jp-printer-loaded">
      <div className="jp-printer-detail__section-head">
        <h3 className="jp-details__heading" id="jp-printer-loaded">
          Filament loaded
        </h3>
        <EditOnly>
          <button type="button" className="jp-link" onClick={() => void addAms()} id="jp-add-ams">
            <Plus size={14} aria-hidden="true" /> Add AMS
          </button>
        </EditOnly>
      </div>
      {!loads ? null : (
        <div className="jp-loaded">
          {loads.units.map((unit) => (
            <div key={unit.id} className="jp-loaded__unit">
              <div className="jp-loaded__unit-head">
                <span className="jp-loaded__unit-name">{unit.name}</span>
                {unit.humidity !== null && (
                  <span className="jp-meta">
                    <Droplets size={12} aria-hidden="true" /> {unit.humidity}%
                  </span>
                )}
                <EditOnly>
                  <span className="jp-loaded__unit-actions">
                    <button type="button" className="jp-link" onClick={() => void rename(unit)}>
                      Rename
                    </button>
                    <button type="button" className="jp-link" onClick={() => void humidity(unit)}>
                      Humidity
                    </button>
                    <button type="button" className="jp-link" aria-label={`Remove ${unit.name}`} onClick={() => void removeAms(unit)}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </span>
                </EditOnly>
              </div>
              <div className="jp-loaded__slots">
                {unit.slots.map((slot) => (
                  <Slot
                    key={slot.id}
                    label={slot.label}
                    spool={slot.spool}
                    canEdit={canEdit}
                    onClick={() => setTarget({ label: slot.label, slotId: slot.id, current: slot.spool })}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="jp-loaded__unit">
            <div className="jp-loaded__unit-head">
              <span className="jp-loaded__unit-name">Own holder</span>
              <span className="jp-meta">outside any AMS</span>
            </div>
            <div className="jp-loaded__slots">
              <Slot
                label="Holder"
                spool={loads.direct}
                canEdit={canEdit}
                onClick={() => setTarget({ label: 'the holder', printerId, current: loads.direct })}
              />
            </div>
          </div>
        </div>
      )}
      {target && <LoadDialog target={target} onClose={() => setTarget(null)} />}
    </section>
  );
}
