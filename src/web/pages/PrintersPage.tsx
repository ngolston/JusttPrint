import { useCallback, type ReactNode } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  ExternalLink,
  Package,
  Pencil,
  Plus,
  Printer as PrinterIcon,
  Trash2,
  Wrench,
  XCircle,
  type LucideIcon
} from 'lucide-react';
import { library, printers as printerApi, type MaintenanceLog, type PrintActivity, type Printer, type PrinterReminder } from '../api';
import { StatusBadge } from '../components/Badge';
import { Button, cx } from '../components/Button';
import { EmptyState, Panel, Skeleton } from '../components/Panel';
import { cardTitle } from '../grid/ModelCard';
import { timeAgo } from '../home/format';
import { showModelDetails } from '../library/details';
import { askText, showMessage } from '../page';
import { selection } from '../selection';
import { useLibraryData } from '../shell/libraryData';
import { navigate } from '../shell/routes';
import { EditOnly } from '../components/EditOnly';

const loadPrinters = () => printerApi.list();

/** A printer's web page as a link target (http:// added when the scheme is missing), or null. */
export function webLink(url: string | null | undefined): string | null {
  const value = String(url || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return `http://${value}`;
}

/** "Oct 6, 2026"; '' for a bad date. */
function day(value: string | null | undefined): string {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

/** Klipper runs on the printer, and the firmware name does not already say so. */
const klipperExtra = (printer: Printer) => !!printer.is_klipper && !/klipper/i.test(printer.firmware_type || '');

const makeModel = (printer: Printer) => [printer.manufacturer, printer.model].filter(Boolean).join(' ');

/** Things that changed printers elsewhere (the Printer Manager dialog listens to it too). */
const printersChanged = () => document.dispatchEvent(new CustomEvent('printers-changed'));

function PrinterCard({ printer, selected, onSelect }: { printer: Printer; selected: boolean; onSelect: () => void }) {
  const due = Number(printer.due_reminders_count) || 0;
  const prints = Number(printer.total_prints) || 0;
  return (
    <li>
      <button type="button" className={cx('jp-printer-card', selected && 'is-selected')} aria-pressed={selected} onClick={onSelect}>
        <span className="jp-printer-card__icon">
          <PrinterIcon size={26} aria-hidden="true" />
        </span>
        <span className="jp-printer-card__text">
          <span className="jp-printer-card__name">{printer.nickname}</span>
          <span className="jp-printer-card__meta">{makeModel(printer) || printer.printer_type || 'Printer'}</span>
          <span className="jp-printer-card__chips">
            {printer.printer_type && <span className="jp-badge">{printer.printer_type}</span>}
            {printer.firmware_type && <span className="jp-badge">{printer.firmware_type}</span>}
            {klipperExtra(printer) && <span className="jp-badge">Klipper</span>}
          </span>
        </span>
        <span className="jp-printer-card__side">
          {due > 0 && (
            <StatusBadge tone="warning" icon={Wrench}>
              Maintenance due
            </StatusBadge>
          )}
          <span className="jp-printer-card__prints">
            {prints.toLocaleString()} {prints === 1 ? 'print' : 'prints'}
          </span>
          {printer.last_printed_at && <span className="jp-printer-card__prints">Last {timeAgo(printer.last_printed_at)}</span>}
        </span>
      </button>
    </li>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="jp-prop">
      <span className="jp-prop__label">{label}</span>
      <span className="jp-prop__value">{children}</span>
    </div>
  );
}

const OUTCOMES: Record<string, { tone: 'success' | 'danger' | 'neutral'; icon: LucideIcon; label: string }> = {
  printed: { tone: 'success', icon: CheckCircle2, label: 'Successful' },
  failed: { tone: 'danger', icon: XCircle, label: 'Failed' },
  cancelled: { tone: 'neutral', icon: CircleSlash, label: 'Cancelled' }
};

interface Detail {
  printerId: number;
  reminders: PrinterReminder[];
  logs: MaintenanceLog[];
  prints: PrintActivity[];
}

/** The selected printer (spec §44): details, maintenance and its recent prints. */
function PrinterDetail({ printer, onDeleted }: { printer: Printer; onDeleted: () => void }) {
  const load = useCallback(async (): Promise<Detail> => {
    const [reminders, logs, prints] = await Promise.all([
      printerApi.reminders(printer.id).catch(() => []),
      printerApi.logs(printer.id).catch(() => []),
      library.recentPrints(8, null, printer.id).catch(() => [])
    ]);
    return { printerId: printer.id, reminders: reminders || [], logs: logs || [], prints: prints || [] };
  }, [printer.id]);
  const loaded = useLibraryData(load);
  const detail = loaded && loaded.printerId === printer.id ? loaded : null;
  const link = webLink(printer.web_url);
  const pending = (detail?.reminders || []).filter((reminder) => reminder.status === 'pending');
  const now = Date.now();

  async function complete(reminder: PrinterReminder) {
    const notes = await askText('Complete Reminder', `Mark "${reminder.title}" as completed? Optional notes for the maintenance log:`, reminder.notes || '');
    if (notes === null) return;
    try {
      await printerApi.completeReminder(reminder.id, notes);
      printersChanged();
    } catch (error) {
      await showMessage('Error', `Failed to complete reminder: ${(error as Error)?.message || error}`);
    }
  }

  async function remove() {
    const answer = await showMessage('Delete Printer', `Delete printer "${printer.nickname}"? Past print logs will be preserved.`, ['Delete', 'Cancel']);
    if (answer !== 'Delete') return;
    try {
      await printerApi.remove(printer.id);
      printersChanged();
      onDeleted();
    } catch (error) {
      await showMessage('Error', `Failed to delete printer: ${(error as Error)?.message || error}`);
    }
  }

  return (
    <div className="jp-printer-detail" aria-label={`${printer.nickname} details`}>
      <header className="jp-printer-detail__header">
        <span className="jp-printer-detail__icon">
          <PrinterIcon size={32} aria-hidden="true" />
        </span>
        <div className="jp-printer-detail__identity">
          <h2 className="jp-printer-detail__name">{printer.nickname}</h2>
          <p className="jp-meta">{makeModel(printer) || 'No make or model set'}</p>
        </div>
      </header>
      <div className="jp-printer-detail__actions">
        {link && (
          <a className="jp-btn jp-btn--primary jp-btn--md" href={link} target="_blank" rel="noopener noreferrer" id="jp-printer-open-web">
            <ExternalLink size={16} aria-hidden="true" />
            <span>Open Web UI</span>
          </a>
        )}
        <EditOnly>
          <Button icon={Pencil} onClick={() => window.openPrinterManagement?.({ printerId: printer.id, action: 'edit' })}>
            Edit
          </Button>
          <Button icon={Wrench} onClick={() => window.openPrinterManagement?.({ printerId: printer.id, tab: 'maintenance' })}>
            Maintenance
          </Button>
          <Button variant="ghost" icon={Trash2} onClick={remove} aria-label={`Delete ${printer.nickname}`}>
            Delete
          </Button>
        </EditOnly>
      </div>

      <section className="jp-printer-detail__section">
        <h3 className="jp-details__heading">Details</h3>
        <div className="jp-props">
          <Prop label="Type">{printer.printer_type || '—'}</Prop>
          <Prop label="Firmware">
            {printer.firmware_type || '—'}
            {klipperExtra(printer) ? ' (Klipper)' : ''}
          </Prop>
          <Prop label="Web page">
            {link ? (
              <a className="jp-link" href={link} target="_blank" rel="noopener noreferrer">
                {printer.web_url}
              </a>
            ) : (
              '—'
            )}
          </Prop>
          <Prop label="Prints">
            {(Number(printer.total_prints) || 0).toLocaleString()}
            {printer.last_printed_at ? `, last ${timeAgo(printer.last_printed_at)}` : ''}
          </Prop>
          {printer.created_at && <Prop label="Added">{day(printer.created_at)}</Prop>}
          {printer.notes && (
            <Prop label="Notes">
              <span className="jp-printer-detail__notes">{printer.notes}</span>
            </Prop>
          )}
        </div>
      </section>

      <section className="jp-printer-detail__section">
        <div className="jp-printer-detail__section-head">
          <h3 className="jp-details__heading">Maintenance</h3>
          <button type="button" className="jp-link" onClick={() => window.openPrinterManagement?.({ printerId: printer.id, tab: 'maintenance' })}>
            Schedule or log
          </button>
        </div>
        {!detail ? (
          <Skeleton height={36} />
        ) : (
          <>
            {pending.length ? (
              <ul className="jp-printer-detail__list" aria-label="Reminders">
                {pending.map((reminder) => {
                  const overdue = Date.parse(reminder.due_date) < now;
                  return (
                    <li key={reminder.id} className="jp-printer-detail__item">
                      <CalendarClock size={18} aria-hidden="true" className={overdue ? 'is-warning' : undefined} />
                      <span className="jp-printer-detail__item-text">
                        <span className="jp-printer-detail__item-title">{reminder.title}</span>
                        <span className="jp-printer-detail__item-meta">
                          Due {day(reminder.due_date)}
                          {reminder.interval_days ? ` • every ${reminder.interval_days} days` : ''}
                        </span>
                      </span>
                      {overdue && <StatusBadge tone="warning">Due</StatusBadge>}
                      <EditOnly>
                        <Button size="sm" icon={CheckCircle2} onClick={() => complete(reminder)}>
                          Done
                        </Button>
                      </EditOnly>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="jp-printer-detail__empty">No maintenance scheduled.</p>
            )}
            {detail.logs.length > 0 && (
              <ul className="jp-printer-detail__list jp-printer-detail__list--log" aria-label="Maintenance log">
                {detail.logs.slice(0, 5).map((log) => (
                  <li key={log.id} className="jp-printer-detail__item">
                    <Wrench size={16} aria-hidden="true" />
                    <span className="jp-printer-detail__item-text">
                      <span className="jp-printer-detail__item-title">{log.title || log.maintenance_type}</span>
                      <span className="jp-printer-detail__item-meta">
                        {day(log.performed_at)}
                        {log.description ? ` • ${log.description}` : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="jp-printer-detail__section">
        <h3 className="jp-details__heading">Recent prints</h3>
        {!detail ? (
          <Skeleton height={36} />
        ) : !detail.prints.length ? (
          <p className="jp-printer-detail__empty">No prints logged on this printer yet. Pick it when you log a print.</p>
        ) : (
          <ul className="jp-printer-detail__list" aria-label="Recent prints">
            {detail.prints.map((event) => {
              const outcome = OUTCOMES[event.outcome] || OUTCOMES.printed;
              return (
                <li key={event.id} className="jp-printer-detail__item">
                  <button
                    type="button"
                    className="jp-printer-detail__item-text jp-printer-detail__model"
                    onClick={() => {
                      navigate('library');
                      selection.set([event.filePath]);
                      void showModelDetails(event.filePath);
                    }}
                  >
                    <span className="jp-printer-detail__item-title">{cardTitle({ filePath: event.filePath, fileName: event.fileName })}</span>
                    <span className="jp-printer-detail__item-meta">{day(event.at)}</span>
                  </button>
                  <StatusBadge tone={outcome.tone} icon={outcome.icon}>
                    {outcome.label}
                  </StatusBadge>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Printers (spec §44): a card per saved printer with its make, type, firmware, print count and
 * maintenance; the selected one (#/printers/<id>) shows its details, maintenance and recent
 * prints. Adding and editing use the Printer Manager's form. No live status: JusttPrint does not
 * connect to printers yet (docs/redesign-5.md).
 */
export function PrintersPage({ section }: { section: string }) {
  // Reloads after any change, also those saved in the Printer Manager dialog.
  const list = useLibraryData(loadPrinters);

  const selectedId = Number(section) || list?.[0]?.id || null;
  const selected = list?.find((printer) => printer.id === selectedId) || null;
  const due = (list || []).filter((printer) => Number(printer.due_reminders_count) > 0).length;
  const add = () => window.openPrinterManagement?.({ action: 'add' });

  return (
    <div className="jp-page__inner jp-printers">
      <header className="jp-page__header jp-queue__header">
        <div>
          <h1 className="jp-page-title">Printers</h1>
          <p className="jp-meta">
            {list
              ? `${list.length} ${list.length === 1 ? 'printer' : 'printers'}${due ? ` • ${due} with maintenance due` : ''}`
              : 'Your printers, their web pages and maintenance.'}
          </p>
        </div>
        <div className="jp-printers__header-actions">
          <EditOnly>
            <Button icon={Package} onClick={() => window.openPartsStock?.()}>
              Parts
            </Button>
            <Button variant="primary" icon={Plus} onClick={add} id="jp-add-printer">
              Add Printer
            </Button>
          </EditOnly>
        </div>
      </header>
      {!list ? (
        <div className="jp-home__skeleton">
          <Skeleton height={88} />
          <Skeleton height={88} />
        </div>
      ) : !list.length ? (
        <Panel>
          <EmptyState
            icon={PrinterIcon}
            title="No printers yet"
            action={
              <EditOnly>
                <Button variant="primary" icon={Plus} onClick={add}>
                  Add Printer
                </Button>
              </EditOnly>
            }
          >
            Add your printers to keep their web pages, maintenance reminders and print history together.
          </EmptyState>
        </Panel>
      ) : (
        <div className="jp-printers__layout">
          <ul className="jp-printers__list" aria-label="Printers">
            {list.map((printer) => (
              <PrinterCard
                key={printer.id}
                printer={printer}
                selected={printer.id === selected?.id}
                onSelect={() => navigate('printers', String(printer.id))}
              />
            ))}
          </ul>
          {selected && (
            <div className="jp-card jp-printers__detail">
              <PrinterDetail printer={selected} onDeleted={() => navigate('printers')} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
