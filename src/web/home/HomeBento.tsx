import { ClipboardPen, Printer as PrinterIcon } from 'lucide-react';
import { type GridModel } from '../grid/layout';
import type { FilamentSummary, MonthSummary, Printer, PrinterLoads, QueueItem, Spool } from '../api';
import { Tile, TileFigure } from '../components/Bento';
import { Button } from '../components/Button';
import { EditOnly } from '../components/EditOnly';
import { ColorDot, FilamentCheck, FitBadge, IsoThumb, SpoolRing } from '../components/Filament';
import { cardTitle } from '../grid/ModelCard';
import { formatWeight } from '../filament/format';
import { loadedSpools } from '../printers/LoadedFilament';
import { checkRows, itemName, plateLabel } from '../queue/QueueParts';
import { navigate } from '../shell/routes';
import { openModel, useThumbnail } from './HomeSections';

/*
 * Home in the Bento look (docs/design-bento.md, J2 · Bento; docs/merge-10.md, Phase 7). Each tile
 * answers one question from real data, and is left out when there is nothing to say.
 */

/** Models that are printing now, with Log Print. */
export function PrintingTile({ models }: { models: GridModel[] | null }) {
  if (!models?.length) return null;
  return (
    <Tile
      title="Printing now"
      cols={2}
      className="jp-home-printing"
      action={<span className="jp-meta">{models.length === 1 ? '1 model' : `${models.length} models`}</span>}
    >
      <ul className="jp-home-tile__list">
        {models.slice(0, 4).map((model) => (
          <li key={model.filePath} className="jp-home-tile__row">
            <button type="button" className="jp-home-tile__name" onClick={() => openModel(model.filePath)}>
              <span className="jp-model-title">{cardTitle(model)}</span>
              {typeof model.designer === 'string' && model.designer && <span className="jp-meta">{model.designer}</span>}
            </button>
            <EditOnly>
              <Button size="sm" variant="primary" icon={ClipboardPen} onClick={() => void window.PrintHistory?.openLogDialog({ filePaths: [model.filePath] })}>
                Log Print
              </Button>
            </EditOnly>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

export interface NeedsYouItem {
  key: string;
  text: string;
  go: () => void;
}

/** What needs doing: queued prints short of filament, maintenance due, nearly empty spools. */
export function needsYou(queue: QueueItem[] | null, printers: Printer[] | null, spools: Spool[] | null): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  for (const item of queue || []) {
    if (!item.check || item.check.ready) continue;
    const short = item.check.needs.filter((need) => !need.ok);
    const what = short
      .map((need) => `${need.colorName}${need.material ? ` ${need.material}` : ''}${need.short ? ` (${formatWeight(need.short)} short)` : ''}`)
      .join(', ');
    items.push({ key: `queue-${item.id}`, text: `${itemName(item)} needs ${what}`, go: () => navigate('queue') });
  }
  for (const printer of printers || []) {
    const due = Number(printer.due_reminders_count) || 0;
    if (due)
      items.push({
        key: `printer-${printer.id}`,
        text: `${printer.nickname}: ${due === 1 ? 'maintenance due' : `${due} maintenance tasks due`}`,
        go: () => navigate('printers', String(printer.id))
      });
  }
  for (const spool of spools || []) {
    if (spool.status !== 'archived' && spool.remaining < 50)
      items.push({
        key: `spool-${spool.id}`,
        text: `${spool.display_name} is nearly empty (${formatWeight(spool.remaining)})`,
        go: () => navigate('filament')
      });
  }
  return items;
}

export function NeedsYouTile({ items }: { items: NeedsYouItem[] }) {
  if (!items.length) return null;
  return (
    <Tile variant="accent" title="Needs you" className="jp-home-needs" action={<span className="jp-home-needs__count">{items.length}</span>}>
      <ul className="jp-home-needs__list">
        {items.slice(0, 4).map((item) => (
          <li key={item.key}>
            <button type="button" className="jp-home-needs__item" onClick={item.go}>
              {item.text}
            </button>
          </li>
        ))}
      </ul>
      {items.length > 4 && <span className="jp-home-needs__more">and {items.length - 4} more</span>}
    </Tile>
  );
}

/** The grams on hand and the fullest spools. */
export function SpoolsTile({ summary, spools }: { summary: FilamentSummary | null; spools: Spool[] | null }) {
  if (!summary?.spoolCount || !spools) return null;
  const shown = spools.filter((spool) => spool.status !== 'archived').slice(0, 6);
  return (
    <Tile
      title="Spools"
      rows={2}
      className="jp-home-spools"
      action={
        <button type="button" className="jp-link" onClick={() => navigate('filament')}>
          All {summary.spoolCount}
        </button>
      }
    >
      <TileFigure value={formatWeight(summary.grams)} label={summary.lowCount ? `${summary.lowCount} running low` : 'on hand'} />
      <ul className="jp-home-tile__list">
        {shown.map((spool) => (
          <li key={spool.id} className="jp-home-spools__row">
            <SpoolRing color={spool.color_hex || '#9aa4b4'} remaining={spool.remaining} capacity={spool.initial_weight} />
            <span className="jp-home-spools__name">{spool.display_name}</span>
            <span className={spool.remaining < 50 ? 'jp-home-spools__grams is-empty' : 'jp-home-spools__grams'}>{formatWeight(spool.remaining)}</span>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

/** The first queued print and whether the spools cover it. */
export function UpNextTile({ items }: { items: QueueItem[] | null }) {
  const first = items?.[0];
  if (!first) return null;
  const more = (items?.length || 1) - 1;
  const rows = checkRows(first.check);
  return (
    <Tile
      title="Up next"
      className="jp-home__upnext"
      action={
        <button type="button" className="jp-link" onClick={() => navigate('queue')}>
          Queue
        </button>
      }
    >
      <div className="jp-home__upnext-head">
        <span className="jp-model-title">{itemName(first)}</span>
        <span className="jp-meta">{[plateLabel(first), first.printerName, more ? `then ${more} more` : ''].filter(Boolean).join(' · ')}</span>
      </div>
      {first.check && (
        <div className="jp-home__upnext-dots">
          {first.check.needs.map((need) => (
            <ColorDot
              key={need.slot}
              color={need.color || '#9aa4b4'}
              short={!need.ok}
              size={18}
              name={`${need.colorName}${need.material ? ` ${need.material}` : ''}`}
            />
          ))}
          <FitBadge missing={first.check.missing} />
        </div>
      )}
      {rows.length > 0 && first.check && !first.check.ready && <FilamentCheck needs={rows} label={`Filament for ${itemName(first)}`} />}
    </Tile>
  );
}

function NewModel({ model }: { model: GridModel }) {
  const src = useThumbnail(model.filePath);
  return (
    <li>
      <button type="button" className="jp-home-new__model" onClick={() => openModel(model.filePath)}>
        <span className="jp-home-new__picture">{src ? <img src={src} alt="" loading="lazy" /> : <IsoThumb color="#8b8f96" size={56} />}</span>
        <span className="jp-home-new__name">{cardTitle(model)}</span>
      </button>
    </li>
  );
}

/** The newest models, and how many came this week. */
export function NewTile({ models, thisWeek }: { models: GridModel[] | null; thisWeek: number }) {
  if (!models?.length) return null;
  return (
    <Tile
      title="New in your library"
      cols={2}
      className="jp-home-new"
      action={thisWeek > 0 ? <span className="jp-meta">{thisWeek} this week</span> : undefined}
    >
      <ul className="jp-home-new__grid">
        {models.slice(0, 4).map((model) => (
          <NewModel key={model.filePath} model={model} />
        ))}
      </ul>
    </Tile>
  );
}

/** Prints this month, how many worked, the filament used, and four weeks of prints. */
export function MonthTile({ month }: { month: MonthSummary | null }) {
  if (!month || (!month.prints && !month.weeks.some((week) => week.prints))) return null;
  const top = Math.max(1, ...month.weeks.map((week) => week.prints));
  return (
    <Tile title="This month" className="jp-home-month">
      <div className="jp-home-month__figures">
        <TileFigure value={month.prints.toLocaleString()} label={month.prints === 1 ? 'print' : 'prints'} />
        {month.successRate !== null && <TileFigure value={`${month.successRate}%`} label="worked" />}
        {month.grams > 0 && <TileFigure value={formatWeight(month.grams)} label="filament" />}
      </div>
      <div className="jp-home-month__bars" role="img" aria-label={`Prints per week: ${month.weeks.map((week) => week.prints).join(', ')}`}>
        {month.weeks.map((week, index) => (
          <span
            key={week.start}
            className={index === month.weeks.length - 1 ? 'is-now' : undefined}
            style={{ height: `${Math.max(6, Math.round((week.prints / top) * 100))}%` }}
          />
        ))}
      </div>
    </Tile>
  );
}

/** Each printer with what is loaded and what is due; empty when there are none. */
export function PrintersTile({ printers, loads }: { printers: Printer[] | null; loads: PrinterLoads[] | null }) {
  if (!printers) return null;
  return (
    <Tile
      variant="quiet"
      title="Printers"
      className="jp-home-printers"
      action={
        <button type="button" className="jp-link" onClick={() => navigate('printers')}>
          Manage
        </button>
      }
    >
      {!printers.length ? (
        <div className="jp-home-printers__empty">
          <p className="jp-meta">No printers yet</p>
          <EditOnly>
            <Button size="sm" icon={PrinterIcon} onClick={() => window.openPrinterManagement?.({ action: 'add' })}>
              Add a Printer
            </Button>
          </EditOnly>
        </div>
      ) : (
        <ul className="jp-home-tile__list jp-printer-list">
          {printers.slice(0, 4).map((printer) => {
            const slots = loadedSpools(loads?.find((l) => l.printerId === printer.id)).filter((slot) => slot.spool);
            const due = Number(printer.due_reminders_count) || 0;
            return (
              <li key={printer.id}>
                <button type="button" className="jp-home-printers__row" onClick={() => navigate('printers', String(printer.id))}>
                  <span className="jp-home-printers__name">{printer.nickname}</span>
                  <span className={due ? 'jp-home-printers__meta is-due' : 'jp-home-printers__meta'}>
                    {due
                      ? 'Maintenance due'
                      : slots.length
                        ? `${slots.length} ${slots.length === 1 ? 'spool' : 'spools'} loaded`
                        : [printer.manufacturer, printer.model].filter(Boolean).join(' ') || 'Free'}
                  </span>
                  <span className="jp-home-printers__dots">
                    {slots.slice(0, 6).map((slot) => (
                      <ColorDot key={slot.label} color={slot.spool?.color_hex || '#9aa4b4'} size={14} />
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Tile>
  );
}
