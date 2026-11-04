import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, ClipboardPen, Copy, FolderInput, Link2, ListPlus, Shuffle, Upload, Wand2 } from 'lucide-react';
import {
  alerts,
  callAction,
  library,
  printers as printerApi,
  printQueue,
  type LibraryAttention,
  type Printer,
  type PrinterLive,
  type PrinterReminder,
  type ReorderItem
} from '../api';
import { Tile, TileFigure } from '../components/Bento';
import { Button } from '../components/Button';
import { EditOnly } from '../components/EditOnly';
import { IsoThumb } from '../components/Filament';
import { ReorderTile } from '../filament/ReorderAndLabels';
import { cardTitle } from '../grid/ModelCard';
import type { GridModel } from '../grid/layout';
import { showMessage } from '../page';
import { CameraView } from '../printers/LiveStatus';
import { useCan } from '../session';
import { useLibraryData } from '../shell/libraryData';
import { navigate } from '../shell/routes';
import { organizeUploads, showUnorganized, useOrganizeRun } from '../upload/inbox';
import { attentionItems } from './attention';
import { ATTENTION, openModel, useThumbnail } from './HomeSections';

/*
 * Home's widgets added in 10.10 (pages/HomeDashboard.tsx places them, home/homeLayout.ts lists
 * them). Like the other tiles, each is left out when it has nothing to say.
 */

const plural = (n: number, word: string) => `${n.toLocaleString()} ${n === 1 ? word : `${word}s`}`;

// ---- Camera ---------------------------------------------------------------------------------

/** A Bambu printer's camera: the one chosen in the tile, else the first connected. */
export function CameraWidget({
  printers,
  live,
  printerId,
  onPick
}: {
  printers: Printer[] | null;
  live: PrinterLive[];
  printerId?: number;
  onPick: (id: number) => void;
}) {
  const bambu = (printers || []).filter((p) => p.connection_type === 'bambu');
  const connected = bambu.filter((p) => live.some((entry) => entry.printerId === p.id && entry.connected));
  const chosen = bambu.find((p) => p.id === printerId) || connected[0] || bambu[0];
  if (!chosen) return null;
  const state = live.find((entry) => entry.printerId === chosen.id);
  return (
    <Tile
      title="Camera"
      className="jp-home-camera"
      action={
        bambu.length > 1 ? (
          <select
            className="jp-input jp-home-camera__pick"
            aria-label="Printer"
            id="jp-home-camera-printer"
            value={chosen.id}
            onChange={(event) => onPick(Number(event.target.value))}
          >
            {bambu.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nickname}
              </option>
            ))}
          </select>
        ) : (
          <button type="button" className="jp-link" onClick={() => navigate('printers', String(chosen.id))}>
            {chosen.nickname}
          </button>
        )
      }
    >
      {state?.connected ? (
        <CameraView key={chosen.id} printerId={chosen.id} />
      ) : (
        <p className="jp-meta">
          {state ? `${chosen.nickname} is not connected${state.error ? `: ${state.error}` : ''}.` : `Connecting to ${chosen.nickname}…`}
        </p>
      )}
    </Tile>
  );
}

// ---- Maintenance due ------------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;
// Reminders by print hours only are stored with a date far ahead (src/core/printer-manager.js).
const NO_DATE_YEAR = 2999;

export interface DueReminder {
  reminder: PrinterReminder;
  /** Days until due by date, or print hours until due by hours; below 0 when over. */
  left: number;
  unit: 'days' | 'hours';
  text: string;
}

/** Pending reminders, soonest first (print hours count as about a day per 24 hours). */
export function dueReminders(reminders: PrinterReminder[], now = Date.now()): DueReminder[] {
  const out: DueReminder[] = [];
  for (const reminder of reminders) {
    if (reminder.status !== 'pending') continue;
    if (Number(reminder.interval_hours) > 0 && reminder.hours_due != null) {
      const left = Math.round((reminder.hours_due - (reminder.hours_now || 0)) * 10) / 10;
      out.push({ reminder, left, unit: 'hours', text: left <= 0 ? `${Math.abs(left)} h over` : `${left} h left` });
      continue;
    }
    const due = Date.parse(reminder.due_date);
    if (!Number.isFinite(due) || new Date(due).getUTCFullYear() >= NO_DATE_YEAR) continue;
    const left = Math.ceil((due - now) / DAY_MS);
    out.push({ reminder, left, unit: 'days', text: left < 0 ? `${plural(-left, 'day')} over` : left === 0 ? 'Due today' : `In ${plural(left, 'day')}` });
  }
  const soon = (item: DueReminder) => (item.unit === 'hours' ? item.left / 24 : item.left);
  return out.sort((a, b) => soon(a) - soon(b));
}

export function MaintenanceWidget({ printers }: { printers: Printer[] | null }) {
  const [tick, setTick] = useState(0);
  const [reminders, setReminders] = useState<PrinterReminder[] | null>(null);
  useEffect(() => {
    let alive = true;
    callAction<PrinterReminder[]>('get-printer-reminders').then(
      (list) => alive && setReminders(list),
      () => alive && setReminders([])
    );
    return () => {
      alive = false;
    };
  }, [tick, printers]);
  const due = useMemo(() => dueReminders(reminders || []), [reminders]);
  if (!due.length) return null;
  const name = (id: number) => printers?.find((p) => p.id === id)?.nickname || 'Printer';
  async function done(item: DueReminder) {
    try {
      await printerApi.completeReminder(item.reminder.id, '');
      setTick((n) => n + 1);
    } catch (error) {
      await showMessage('Maintenance', error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <Tile title="Maintenance due" className="jp-home-maintenance" action={<span className="jp-meta">{due.length}</span>}>
      <ul className="jp-home-tile__list" id="jp-home-maintenance">
        {due.slice(0, 5).map((item) => (
          <li key={item.reminder.id} className="jp-home-tile__row">
            <button type="button" className="jp-home-tile__name" onClick={() => navigate('printers', String(item.reminder.printer_id))}>
              <span className="jp-model-title">{item.reminder.title}</span>
              <span className={item.left <= 0 ? 'jp-meta is-due' : 'jp-meta'}>
                {name(item.reminder.printer_id)} · {item.text}
              </span>
            </button>
            <EditOnly>
              <Button size="sm" icon={CheckCircle2} onClick={() => void done(item)} title={`Mark ${item.reminder.title} done`}>
                Done
              </Button>
            </EditOnly>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

// ---- Reorder list ---------------------------------------------------------------------------

const loadReorder = () => alerts.reorder().catch(() => [] as ReorderItem[]);

/** The Filament page's Reorder tile; its shopping list opens on the Filament page. */
export function ReorderWidget() {
  const items = useLibraryData(loadReorder);
  return <ReorderTile items={items} onOpen={() => navigate('filament', 'shopping')} />;
}

// ---- Forgotten model ------------------------------------------------------------------------

const loadForgotten = () =>
  callAction<GridModel[]>('get-models-filtered', { printed: 'never-printed', sortOption: 'dateadded-asc', limit: 60 }).catch(() => [] as GridModel[]);

/** One of the oldest models never printed; Another picks a different one. */
export function ForgottenWidget() {
  const models = useLibraryData(loadForgotten);
  const [pick, setPick] = useState(() => Math.random());
  const [queued, setQueued] = useState('');
  const model = models?.length ? models[Math.floor(pick * models.length) % models.length] : null;
  const src = useThumbnail(model?.filePath || null);
  if (!model) return null;
  async function queue() {
    if (!model) return;
    try {
      await printQueue.add(model.filePath);
      setQueued(model.filePath);
    } catch (error) {
      await showMessage('Queue', error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <Tile title="Forgotten model" className="jp-home-forgotten">
      <button type="button" className="jp-home-forgotten__model" onClick={() => openModel(model.filePath)} id="jp-home-forgotten-model">
        <span className="jp-home-forgotten__picture">{src ? <img src={src} alt="" loading="lazy" /> : <IsoThumb color="#8b8f96" size={56} />}</span>
        <span className="jp-home-forgotten__text">
          <span className="jp-model-title">{cardTitle(model)}</span>
          <span className="jp-meta">Never printed{typeof model.designer === 'string' && model.designer ? ` · ${model.designer}` : ''}</span>
        </span>
      </button>
      <div className="jp-home-forgotten__actions">
        <EditOnly>
          <Button size="sm" variant="primary" icon={ListPlus} disabled={queued === model.filePath} onClick={() => void queue()}>
            {queued === model.filePath ? 'Queued' : 'Queue It'}
          </Button>
        </EditOnly>
        {models!.length > 1 && (
          <Button
            size="sm"
            icon={Shuffle}
            id="jp-home-forgotten-another"
            onClick={() => setPick((p) => (p + 1 / models!.length + Math.random() / models!.length) % 1)}
          >
            Another
          </Button>
        )}
      </div>
    </Tile>
  );
}

// ---- Quick actions --------------------------------------------------------------------------

/**
 * For editors: add models, scan (`scan`: Home's Scan Library button, which shows a scan running),
 * and log a print (of the model printing now, else from the library).
 */
export function QuickActionsWidget({ printing, scan }: { printing: GridModel[] | null; scan: ReactNode }) {
  const canEdit = useCan('editor');
  if (!canEdit) return null;
  async function logPrint() {
    if (printing?.length) {
      await window.PrintHistory?.openLogDialog({ filePaths: [printing[0].filePath] });
      return;
    }
    navigate('library');
    await showMessage('Log a Print', 'Choose the model you printed, then Log Print from its menu or its details. Models marked Printing get it here at once.');
  }
  return (
    <Tile title="Quick actions" className="jp-home-quick">
      <div className="jp-home-quick__buttons" id="jp-home-quick">
        <Button icon={Link2} onClick={() => window.openLinkImport?.()}>
          Add Links
        </Button>
        <Button icon={Upload} onClick={() => window.openUpload?.()}>
          Upload
        </Button>
        {scan}
        <Button icon={ClipboardPen} onClick={() => void logPrint()}>
          Log a Print
        </Button>
      </div>
    </Tile>
  );
}

// ---- Upload inbox, Tidy up, Duplicates found (library.attention) ------------------------------

const loadAttention = () => library.attention().catch(() => null);

/** Models waiting in the Upload folder, with Organize. */
export function UploadInboxWidget() {
  const canEdit = useCan('editor');
  const found = useLibraryData<LibraryAttention | null>(loadAttention);
  const organizing = useOrganizeRun();
  const waiting = found?.unorganized || 0;
  if (!canEdit || !waiting) return null;
  return (
    <Tile title="Upload inbox" className="jp-home-inbox">
      <TileFigure value={waiting.toLocaleString()} label={waiting === 1 ? 'model waiting to be organized' : 'models waiting to be organized'} />
      <div className="jp-home-forgotten__actions">
        <Button size="sm" variant="primary" icon={Wand2} id="jp-home-inbox-organize" disabled={!!organizing?.running} onClick={() => void organizeUploads()}>
          {organizing?.running ? 'Organizing…' : 'Organize'}
        </Button>
        <Button size="sm" icon={FolderInput} onClick={showUnorganized}>
          Show Them
        </Button>
      </div>
    </Tile>
  );
}

const TIDY_KEYS = ['untagged', 'uncategorized', 'unlicensed', 'thumbnails'] as const;

/** Models without tags, a category, a license or a picture, each a click from where it is fixed. */
export function TidyUpWidget() {
  const canEdit = useCan('editor');
  const found = useLibraryData<LibraryAttention | null>(loadAttention);
  if (!canEdit || !found) return null;
  const items = attentionItems(found, 0, true).filter((item) => (TIDY_KEYS as readonly string[]).includes(item.key));
  if (!items.length) return null;
  return (
    <Tile title="Tidy up" className="jp-home-tidy">
      <ul className="jp-home-tile__list" id="jp-home-tidy">
        {items.map((item) => {
          const { icon: Icon, run } = ATTENTION[item.key];
          return (
            <li key={item.key}>
              <button type="button" className="jp-home-tidy__row" data-attention={item.key} onClick={run}>
                <Icon size={16} aria-hidden="true" />
                <span>{item.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Tile>
  );
}

/** How many sets of identical files there are. */
export function DuplicatesWidget() {
  const canEdit = useCan('editor');
  const found = useLibraryData<LibraryAttention | null>(loadAttention);
  const sets = found?.duplicateSets || 0;
  if (!canEdit || !sets) return null;
  return (
    <Tile title="Duplicates found" className="jp-home-duplicates">
      <TileFigure value={sets.toLocaleString()} label={sets === 1 ? 'set of identical files' : 'sets of identical files'} />
      <div className="jp-home-forgotten__actions">
        <Button size="sm" icon={Copy} id="jp-home-duplicates-open" onClick={() => navigate('duplicates')}>
          Keep One of Each
        </Button>
      </div>
    </Tile>
  );
}
