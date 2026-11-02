import { Flame, Layers, Thermometer, Timer } from 'lucide-react';
import type { Printer, PrinterLive } from '../api';
import { StatusBadge } from '../components/Badge';
import { ProgressBar } from '../components/Panel';
import { openModel } from '../home/HomeSections';
import { navigate } from '../shell/routes';
import { liveLabel, liveTone, minutesText } from './live';

/*
 * Bambu Lab live status over the LAN (src/server/bambu-live.js): a badge on a printer's tile, its
 * job and temperatures on its page, and printers printing now on Home. Only read from the printer.
 */

/** Printing 37%, Idle, Offline. */
export function LiveBadge({ live }: { live: PrinterLive | null | undefined }) {
  if (!live) return null;
  return (
    <StatusBadge tone={liveTone(live)} className="jp-live-badge">
      {liveLabel(live)}
    </StatusBadge>
  );
}

const degrees = (value: number | null, target: number | null) =>
  value === null ? '—' : `${Math.round(value)}°${target !== null && target > 0 && Math.abs(target - value) >= 1 ? ` → ${Math.round(target)}°` : ''}`;

/** The job's name, a link to its library model when it has one. */
function JobName({ live }: { live: PrinterLive }) {
  if (!live.job) return null;
  return live.model ? (
    <button type="button" className="jp-link jp-live__job" onClick={() => openModel(live.model!.filePath)} title="Open the model">
      {live.model.title || live.job}
    </button>
  ) : (
    <span className="jp-live__job">{live.job}</span>
  );
}

/** Progress with what is left: 37% · 52 min left · layer 40 of 120. */
function ProgressLine({ live }: { live: PrinterLive }) {
  const parts = [
    live.progress !== null ? `${live.progress}%` : null,
    live.remainingMinutes ? `${minutesText(live.remainingMinutes)} left` : null,
    live.layer !== null && live.totalLayers ? `layer ${live.layer} of ${live.totalLayers}` : null
  ].filter(Boolean);
  return (
    <>
      {live.progress !== null && <ProgressBar value={live.progress} label="Print progress" tone={live.state === 'paused' ? 'warning' : 'accent'} />}
      {parts.length > 0 && <span className="jp-meta jp-live__progress-text">{parts.join(' · ')}</span>}
    </>
  );
}

/** What the server needs before it can follow a Bambu printer, or null when it has it all. */
export function missingForLive(printer: Printer): string | null {
  if (printer.connection_type !== 'bambu') return null;
  const missing = [
    !printer.api_url && 'its address on your network',
    !printer.serial_number && 'its serial number',
    !printer.has_api_secret && 'its access code'
  ].filter(Boolean);
  return missing.length ? `For live status, add ${missing.join(', ').replace(/, ([^,]*)$/, ' and $1')} (Edit).` : null;
}

/** The printer page's Live section: state, job, progress, temperatures, the tray feeding it. */
export function LiveSection({ printer, live }: { printer: Printer; live: PrinterLive | null | undefined }) {
  const missing = missingForLive(printer);
  if (printer.connection_type !== 'bambu') return null;
  const active = live && (live.state === 'printing' || live.state === 'paused');
  return (
    <section className="jp-printer-detail__section jp-live" aria-labelledby="jp-printer-live" id="jp-printer-live-section">
      <div className="jp-printer-detail__section-head">
        <h3 className="jp-details__heading" id="jp-printer-live">
          Live
        </h3>
        <LiveBadge live={live} />
      </div>
      {missing ? (
        <p className="jp-meta">{missing} The printer must be on the same network as the server, with LAN mode or Developer mode turned on.</p>
      ) : !live ? (
        <p className="jp-meta">Connecting…</p>
      ) : !live.connected ? (
        <p className="jp-meta" id="jp-live-error">
          Not connected{live.error ? `: ${live.error}` : ''}. JusttPrint tries again by itself. Check the address and access code (Edit), and that the printer
          is on, on the same network, with LAN mode or Developer mode turned on.
        </p>
      ) : (
        <div className="jp-live__body">
          {(active || live.job) && (
            <div className="jp-live__job-row">
              <JobName live={live} />
              {active && <ProgressLine live={live} />}
            </div>
          )}
          <div className="jp-live__facts">
            <span title="Nozzle">
              <Flame size={14} aria-hidden="true" /> Nozzle {degrees(live.nozzle, live.nozzleTarget)}
            </span>
            <span title="Bed">
              <Thermometer size={14} aria-hidden="true" /> Bed {degrees(live.bed, live.bedTarget)}
            </span>
            {live.feeding && (
              <span title="The tray feeding the printer">
                <Layers size={14} aria-hidden="true" /> Feeding from {live.feeding}
              </span>
            )}
            {active && live.remainingMinutes ? (
              <span>
                <Timer size={14} aria-hidden="true" /> Done about{' '}
                {new Date(Date.now() + live.remainingMinutes * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

/** Home's Printing now: the printers printing, with their job and progress. */
export function LivePrintingRows({ printers, live }: { printers: Printer[] | null; live: PrinterLive[] }) {
  const busy = live.filter((entry) => entry.state === 'printing' || entry.state === 'paused');
  if (!busy.length) return null;
  return (
    <ul className="jp-home-tile__list jp-live-rows" aria-label="Printers printing now">
      {busy.map((entry) => {
        const printer = printers?.find((p) => p.id === entry.printerId);
        return (
          <li key={entry.printerId} className="jp-live-row">
            <span className="jp-live-row__head">
              <button type="button" className="jp-link jp-live-row__printer" onClick={() => navigate('printers', String(entry.printerId))}>
                {printer?.nickname || 'Printer'}
              </button>
              <LiveBadge live={entry} />
            </span>
            <JobName live={entry} />
            <ProgressLine live={entry} />
          </li>
        );
      })}
    </ul>
  );
}
