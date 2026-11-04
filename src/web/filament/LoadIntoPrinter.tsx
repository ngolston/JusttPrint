import { useEffect, useState } from 'react';
import { LogOut, Printer as PrinterIcon } from 'lucide-react';
import { printers as printerApi, type LoadedSpool, type Printer, type PrinterLoads, type Spool } from '../api';
import { Button, cx } from '../components/Button';
import { ColorDot } from '../components/Filament';
import { Modal } from '../components/Overlay';
import { navigate } from '../shell/routes';

/*
 * From a spool (SpoolDrawer.tsx): load it into one of the printers' AMS slots or a printer's own
 * holder, or take it out. Loading moves it from wherever it was (src/core/printer-ams.js loadSpool).
 */

interface Place {
  key: string;
  label: string;
  where: { slotId?: number; printerId?: number };
  current: LoadedSpool | null;
}

/** A printer's places for a spool: its AMS slots, then its own holder. */
export function placesOf(printer: Printer, loads: PrinterLoads | undefined): Place[] {
  const slots = (loads?.units || []).flatMap((unit) =>
    unit.slots.map((slot) => ({
      key: `slot-${slot.id}`,
      label: loads!.units.length > 1 ? `${unit.name} · ${slot.label}` : slot.label,
      where: { slotId: slot.id },
      current: slot.spool
    }))
  );
  return [
    ...slots,
    { key: `holder-${printer.id}`, label: slots.length ? 'Own holder' : 'Holder', where: { printerId: printer.id }, current: loads?.direct || null }
  ];
}

export function LoadIntoPrinterDialog({ spool, onClose }: { spool: Spool; onClose: () => void }) {
  const [list, setList] = useState<Printer[] | null>(null);
  const [loads, setLoads] = useState<PrinterLoads[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    Promise.all([printerApi.list(), printerApi.loads()]).then(
      ([found, loaded]) => {
        if (!alive) return;
        setList(found);
        setLoads(loaded);
      },
      (failure) => alive && setError(failure instanceof Error ? failure.message : String(failure))
    );
    return () => {
      alive = false;
    };
  }, []);

  const here = (place: Place) => place.current?.id === spool.id;
  const loadedAt = (list || []).flatMap((printer) =>
    placesOf(
      printer,
      loads.find((l) => l.printerId === printer.id)
    ).filter(here)
  );

  async function put(where: Place['where'] | null) {
    setBusy(true);
    setError('');
    try {
      if (where) await printerApi.load(where, spool.id);
      else for (const place of loadedAt) await printerApi.load(place.where, null);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Load ${spool.display_name}`}
      id="jp-load-spool-dialog"
      footer={
        <>
          {loadedAt.length > 0 && (
            <Button icon={LogOut} disabled={busy} id="jp-load-spool-out" onClick={() => void put(null)}>
              Take Out of Printer
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      {error && (
        <p className="jp-mw-download__problem" role="alert">
          {error}
        </p>
      )}
      {!list ? (
        !error && <p className="jp-meta">Loading your printers…</p>
      ) : !list.length ? (
        <div className="jp-load-spool__empty">
          <p className="jp-meta">You have no printers yet. Add one, then load spools into it.</p>
          <Button
            icon={PrinterIcon}
            onClick={() => {
              onClose();
              navigate('printers');
              window.openPrinterManagement?.({ action: 'add' });
            }}
          >
            Add a Printer
          </Button>
        </div>
      ) : (
        <>
          <p className="jp-meta">Pick where it goes. A spool already there is taken out, and this spool leaves anywhere else it was loaded.</p>
          <div className="jp-load-spool" id="jp-load-spool-printers">
            {list.map((printer) => (
              <section key={printer.id} className="jp-load-spool__printer" aria-label={printer.nickname} data-printer={printer.id}>
                <h3 className="jp-load-spool__name">{printer.nickname}</h3>
                <div className="jp-load-spool__places">
                  {placesOf(
                    printer,
                    loads.find((l) => l.printerId === printer.id)
                  ).map((place) => (
                    <button
                      key={place.key}
                      type="button"
                      className={cx('jp-load-spool__place', here(place) && 'is-here')}
                      disabled={busy || here(place)}
                      data-place={place.label}
                      onClick={() => void put(place.where)}
                    >
                      <span className="jp-load-spool__label">{place.label}</span>
                      <span className="jp-load-spool__what">
                        {place.current ? (
                          <>
                            <ColorDot color={place.current.color_hex || '#9aa4b4'} size={12} />
                            {here(place) ? 'This spool' : place.current.name}
                          </>
                        ) : (
                          'Empty'
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
          <p className="jp-meta">To add AMS units, open the printer on the Printers page.</p>
        </>
      )}
    </Modal>
  );
}
