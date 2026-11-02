import { useEffect, useState } from 'react';
import { Droplets, Plus, Trash2 } from 'lucide-react';
import { filament, printers as printerApi, type LoadedSpool, type PrinterLive, type PrinterLoads, type Spool } from '../api';
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

type LiveTray = { type: string | null; name: string | null; color: string | null; remain: number | null } | null;

function Slot({
  label,
  spool,
  onClick,
  canEdit,
  tray,
  live,
  feeding
}: {
  label: string;
  spool: LoadedSpool | null;
  onClick: () => void;
  canEdit: boolean;
  /** What the printer last said is in the tray (stored). */
  tray?: { type: string | null; color: string | null } | null;
  /** The tray as the printer says now (live), with what is left on Bambu spools. */
  live?: LiveTray;
  feeding?: boolean;
}) {
  const printerSays = live || tray;
  const inner = (
    <>
      {spool ? (
        <SpoolRing color={spool.color_hex || '#9aa4b4'} remaining={spool.remaining} capacity={spool.initial_weight} size={48} />
      ) : printerSays ? (
        <span className="jp-loaded-slot__empty is-unmatched" style={{ borderColor: printerSays.color || undefined }} aria-hidden="true" />
      ) : (
        <span className="jp-loaded-slot__empty" aria-hidden="true" />
      )}
      <span className="jp-loaded-slot__label">
        {label}
        {feeding && <span className="jp-loaded-slot__feeding"> · printing</span>}
      </span>
      <span className="jp-loaded-slot__name">{spool ? spool.name : printerSays ? live?.name || printerSays.type || 'Unknown filament' : 'Empty'}</span>
      {spool && <span className={cx('jp-loaded-slot__grams', spool.remaining < 50 && 'is-empty')}>{formatWeight(spool.remaining)}</span>}
      {!spool && printerSays && <span className="jp-loaded-slot__printer">Which spool?</span>}
      {spool && live && live.remain !== null && (
        <span className="jp-loaded-slot__printer" title="What the printer reads from the spool's RFID">
          Printer: {live.remain}%
        </span>
      )}
      {canEdit && <span className="jp-sr-only">, change</span>}
    </>
  );
  const title = !spool && printerSays ? `The printer has ${printerSays.type || 'filament'} in ${label}: load its spool` : `Load ${label}`;
  return canEdit ? (
    <button type="button" className={cx('jp-loaded-slot', !spool && 'is-empty')} onClick={onClick} title={title}>
      {inner}
    </button>
  ) : (
    <span className={cx('jp-loaded-slot', !spool && 'is-empty')}>{inner}</span>
  );
}

/** The printer page's Filament loaded section. */
export function LoadedSection({ printerId, loads, live = null }: { printerId: number; loads: PrinterLoads | null; live?: PrinterLive | null }) {
  const canEdit = useCan('editor');
  const [target, setTarget] = useState<Target | null>(null);
  const fail = (error: unknown) => showMessage('Filament', errorText(error));
  // The printer's live report for a unit (Bambu): its trays and humidity level.
  const liveUnit = (unit: PrinterLoads['units'][number]) =>
    live?.connected && unit.live_id !== null ? live.ams.find((entry) => entry.id === unit.live_id) || null : null;

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
                {unit.humidity !== null ? (
                  <span className="jp-meta">
                    <Droplets size={12} aria-hidden="true" /> {unit.humidity}%
                  </span>
                ) : (
                  liveUnit(unit)?.humidityLevel != null && (
                    <span className="jp-meta" title="The humidity level the printer gives this AMS (1 to 5), as on its screen">
                      <Droplets size={12} aria-hidden="true" /> Humidity level {liveUnit(unit)!.humidityLevel}
                    </span>
                  )
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
                    tray={slot.printer_tray}
                    live={liveUnit(unit)?.trays[slot.slot_index] ?? undefined}
                    feeding={live?.feeding === slot.label}
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
                live={live?.external ? { ...live.external, name: live.external.type, remain: null } : undefined}
                feeding={live?.feeding === 'Holder'}
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
