import { useCallback, useEffect, useState } from 'react';
import { ScanEye, Settings2 } from 'lucide-react';
import { failureDetection, type DetectionWatch, type FailureDetection, type Printer, type PrinterLive } from '../api';
import { Button } from '../components/Button';
import { StatusBadge } from '../components/Badge';
import { timeAgo } from '../home/format';
import { useCan } from '../session';
import { usePrinterLive } from './live';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the detector thinks of this print now, in words. */
function WatchStatus({ watch, printer }: { watch: DetectionWatch | null; printer: Printer }) {
  if (!watch) return <p className="jp-meta">It watches the camera while {printer.nickname} prints.</p>;
  const checked = watch.checkedAt ? `checked ${timeAgo(watch.checkedAt)}` : 'not checked yet';
  const badge =
    watch.level === 'failing' ? (
      <StatusBadge tone="danger">Looks like it is failing</StatusBadge>
    ) : watch.level === 'warning' ? (
      <StatusBadge tone="warning">Watching closely</StatusBadge>
    ) : watch.warmingUp ? (
      <StatusBadge tone="neutral">Warming up</StatusBadge>
    ) : (
      <StatusBadge tone="success">Looks fine</StatusBadge>
    );
  return (
    <div className="jp-detect__status">
      <p className="jp-detect__line">
        {badge}
        <span className="jp-meta">
          {[`${watch.pictures} ${watch.pictures === 1 ? 'picture' : 'pictures'}`, watch.score !== null ? `score ${watch.score.toFixed(2)}` : null, checked]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </p>
      {watch.warmingUp && watch.level !== 'failing' && <p className="jp-meta">Nothing counts in the first five minutes of a print.</p>}
      {watch.error && (
        <p className="jp-send__error" role="alert">
          {watch.error}
        </p>
      )}
      {watch.alertedAt && (
        <p className="jp-meta">
          Alert sent {timeAgo(watch.alertedAt)}
          {watch.paused ? ', and JusttPrint paused the print. Look at it, then resume or stop it above.' : '.'}
        </p>
      )}
      {watch.flagged && (
        <figure className="jp-detect__picture">
          <img
            src={`/api/printers/${printer.id}/detection-picture?at=${encodeURIComponent(watch.alertedAt || '')}`}
            alt={`What the camera saw on ${printer.nickname}`}
          />
          <figcaption className="jp-meta">The picture that set off the alert.</figcaption>
        </figure>
      )}
    </div>
  );
}

/** The detector's settings (admins): the same for every printer. */
function DetectorForm({
  config,
  printer,
  live,
  onSaved
}: {
  config: FailureDetection;
  printer: Printer;
  live: PrinterLive | null;
  onSaved: (next: FailureDetection) => void;
}) {
  const [draft, setDraft] = useState({
    enabled: config.enabled || !config.url,
    url: config.url,
    selfUrl: config.selfUrl,
    intervalSeconds: config.intervalSeconds,
    sensitivity: config.sensitivity,
    autoPause: config.autoPause
  });
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft((d) => ({ ...d, [key]: value }));

  async function save() {
    setBusy('save');
    setNote(null);
    try {
      const next = await failureDetection.save({ ...draft, printers: config.printers, ...(token ? { token } : {}) });
      setToken('');
      onSaved(next);
      setNote({ ok: true, text: 'Saved.' });
    } catch (error) {
      setNote({ ok: false, text: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    setNote(null);
    try {
      const next = await failureDetection.save({ ...draft, printers: config.printers, ...(token ? { token } : {}) });
      setToken('');
      onSaved(next);
      const camera = live?.connected ? printer.id : null;
      const answer = await failureDetection.test(camera);
      setNote({
        ok: true,
        text: `The detector answers and gets pictures from JusttPrint${camera ? ` (${printer.nickname}'s camera: ${answer.detections} found, score ${answer.score.toFixed(2)})` : ''}.`
      });
    } catch (error) {
      setNote({ ok: false, text: errorText(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      className="jp-detect__form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="jp-meta">
        The detector is Obico&rsquo;s ML API, a container you run next to JusttPrint (the Guide shows the Docker Compose lines). It works on the CPU; no
        graphics card is needed.
      </p>
      <label className="jp-send__field">
        <span>Detector address</span>
        <input
          id="jp-detect-url"
          className="jp-input"
          value={draft.url}
          onChange={(e) => set('url', e.target.value)}
          placeholder="http://obico-ml:3333"
          spellCheck={false}
        />
      </label>
      <label className="jp-send__field">
        <span>JusttPrint&rsquo;s address, as the detector reaches it</span>
        <input
          id="jp-detect-self"
          className="jp-input"
          value={draft.selfUrl}
          onChange={(e) => set('selfUrl', e.target.value)}
          placeholder="http://justtprint-server:5000"
          spellCheck={false}
        />
        <span className="jp-meta jp-detect__hint">
          The detector downloads each camera picture from here. In the same Docker Compose file, use the container name; otherwise this computer&rsquo;s address
          on the network.
        </span>
      </label>
      <label className="jp-send__field">
        <span>Token (the detector&rsquo;s ML_API_TOKEN, if you set one)</span>
        <input
          className="jp-input"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={config.tokenSet ? 'Set: type to replace it' : 'None'}
        />
      </label>
      <div className="jp-detect__row">
        <label className="jp-send__field">
          <span>Check every</span>
          <select className="jp-input" value={draft.intervalSeconds} onChange={(e) => set('intervalSeconds', Number(e.target.value))}>
            {[10, 20, 30, 60].map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
          </select>
        </label>
        <label className="jp-send__field">
          <span>Sensitivity</span>
          <select className="jp-input" value={draft.sensitivity} onChange={(e) => set('sensitivity', e.target.value as FailureDetection['sensitivity'])}>
            <option value="low">Low (fewer false alarms)</option>
            <option value="medium">Medium</option>
            <option value="high">High (catches more)</option>
          </select>
        </label>
      </div>
      <label className="jp-detect__check">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        <span>Watch prints</span>
      </label>
      <label className="jp-detect__check">
        <input id="jp-detect-autopause" type="checkbox" checked={draft.autoPause} onChange={(e) => set('autoPause', e.target.checked)} />
        <span>Pause the print when it looks like it is failing (otherwise only alert)</span>
      </label>
      <div className="jp-detect__actions">
        <Button type="submit" variant="primary" size="sm" disabled={!!busy}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" disabled={!!busy || !draft.url || !draft.selfUrl} onClick={() => void test()} id="jp-detect-test">
          {busy === 'test' ? 'Testing…' : 'Test'}
        </Button>
      </div>
      {note && (
        <p className={note.ok ? 'jp-meta' : 'jp-send__error'} role={note.ok ? 'status' : 'alert'}>
          {note.text}
        </p>
      )}
    </form>
  );
}

/**
 * The printer page's Failure detection (Bambu Lab): while it prints, the camera is checked for
 * spaghetti by the detector (src/server/failure-detection.js); an alert when a print looks like
 * it is failing, and a pause when the admin turned that on.
 */
export function FailureDetectionSection({ printer, live }: { printer: Printer; live: PrinterLive | null | undefined }) {
  const [config, setConfig] = useState<FailureDetection | null>(null);
  const [open, setOpen] = useState(false);
  const admin = useCan('admin');
  const followed = usePrinterLive();
  const load = useCallback(() => {
    failureDetection.get().then(setConfig, () => setConfig(null));
  }, []);
  const printing = live?.state === 'printing' || live?.state === 'paused';
  useEffect(() => {
    load();
    if (!printing) return undefined;
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [load, printing]);
  if (printer.connection_type !== 'bambu' || !config) return null;
  const set = config.enabled && !!config.url;
  if (!set && !admin) return null;
  const watchesThis = !config.printers || config.printers.includes(printer.id);
  const watch = config.watching.find((w) => w.printerId === printer.id) || null;

  async function toggleThis(on: boolean) {
    if (!config) return;
    const all = followed.map((entry) => entry.printerId);
    const current = config.printers || all;
    const next = on ? [...new Set([...current, printer.id])] : current.filter((id) => id !== printer.id);
    const printers = all.every((id) => next.includes(id)) ? null : next;
    try {
      setConfig(await failureDetection.save({ ...config, printers }));
    } catch {
      load();
    }
  }

  return (
    <section className="jp-printer-detail__section jp-detect" aria-labelledby="jp-detect-heading" id="jp-detect-section">
      <div className="jp-printer-detail__section-head">
        <h3 className="jp-details__heading" id="jp-detect-heading">
          Failure detection
        </h3>
        {admin && (
          <button type="button" className="jp-link" onClick={() => setOpen(!open)} aria-expanded={open} id="jp-detect-settings">
            <Settings2 size={14} aria-hidden="true" /> {set ? 'Settings' : 'Set Up'}
          </button>
        )}
      </div>
      {!set ? (
        !open && (
          <p className="jp-meta">
            <ScanEye size={14} aria-hidden="true" /> Check the camera for spaghetti while it prints, and get an alert (or a pause) when a print looks like it is
            failing. It needs a detector you run yourself: choose Set Up.
          </p>
        )
      ) : (
        <>
          {admin && (
            <label className="jp-detect__check">
              <input type="checkbox" checked={watchesThis} onChange={(e) => void toggleThis(e.target.checked)} />
              <span>Watch {printer.nickname}&rsquo;s prints</span>
            </label>
          )}
          {watchesThis ? <WatchStatus watch={watch} printer={printer} /> : <p className="jp-meta">{printer.nickname}&rsquo;s prints are not watched.</p>}
          {watchesThis && !config.autoPause && <p className="jp-meta">It alerts only; it does not pause the print.</p>}
        </>
      )}
      {admin && open && <DetectorForm config={config} printer={printer} live={live || null} onSaved={setConfig} />}
    </section>
  );
}
