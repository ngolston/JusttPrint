/**
 * Print status and print history wording: labels, card badges, the sidebar print filter and the
 * bundle summary. Same rules as the server's src/core/print-events.js.
 */

export const STATUSES = ['unprinted', 'want', 'queued', 'printing', 'printed', 'failed'] as const;
export type PrintStatus = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<PrintStatus, string> = {
  unprinted: 'Not printed',
  want: 'Want',
  queued: 'Queued',
  printing: 'Printing',
  printed: 'Printed',
  failed: 'Failed'
};

const FILTER_LABELS: Record<string, string> = {
  printed: 'Printed',
  'not-printed': 'Not printed',
  unprinted: 'Unprinted',
  want: 'Want',
  queued: 'Queued',
  printing: 'Printing',
  failed: 'Failed',
  'ever-printed': 'Ever printed',
  'never-printed': 'Never printed',
  'in-queue': 'In queue'
};

export const OUTCOME_LABELS: Record<string, string> = {
  printed: 'Printed',
  failed: 'Failed',
  cancelled: 'Cancelled'
};

/** The print fields of a model. */
export interface PrintModel {
  print_status?: string | null;
  printed?: number | boolean | null;
  print_count?: number | null;
  last_printed_at?: string | null;
}

export function effectiveStatus(model: PrintModel | null | undefined): string {
  if (model?.print_status) return String(model.print_status).toLowerCase();
  return model?.printed ? 'printed' : 'unprinted';
}

const statusLabel = (status: string) => STATUS_LABELS[status as PrintStatus];

export function badgeText(model: PrintModel): string {
  const status = effectiveStatus(model);
  const count = Number(model?.print_count) || 0;
  if (status === 'printed') return count > 0 ? `Printed ×${count}` : 'Printed';
  return statusLabel(status) || STATUS_LABELS.unprinted;
}

export function badgeClassNames(model: PrintModel): string {
  const status = effectiveStatus(model);
  const classes = ['print-status', `print-status-${status}`];
  if (status === 'printed' || Number(model?.print_count) > 0) classes.push('printed');
  return classes.join(' ');
}

export function formatPrintDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function badgeTitle(model: PrintModel): string {
  const status = effectiveStatus(model);
  const count = Number(model?.print_count) || 0;
  const parts = [`Status: ${statusLabel(status) || status}`];
  if (count > 0) parts.push(`${count} logged print${count === 1 ? '' : 's'}`);
  else if (status === 'printed') parts.push('No logged prints yet');
  if (model?.last_printed_at) parts.push(`Last printed: ${formatPrintDate(model.last_printed_at)}`);
  parts.push('Click to log a print. Shift-click to set status.');
  return parts.join('\n');
}

/** The line under the details panel's status picker. */
export function detailsHint(model: PrintModel): string {
  const count = Number(model?.print_count) || 0;
  if (effectiveStatus(model) === 'printed' && count === 0) return 'No logged prints yet. Logging a print keeps a dated history.';
  if (model?.last_printed_at) return `Last printed ${formatPrintDate(model.last_printed_at)}`;
  return '';
}

export function modelMatchesPrintFilter(model: PrintModel, value: string | null | undefined): boolean {
  if (!value || value === 'all') return true;
  const v = String(value).trim().toLowerCase();
  const status = effectiveStatus(model);
  const count = Number(model?.print_count) || 0;
  const printed = Number(model?.printed) ? 1 : (status === 'printed' || count > 0 ? 1 : 0);
  if (v === 'printed') return status === 'printed';
  if (v === 'not-printed') return !printed;
  if (v === 'ever-printed') return count > 0;
  if (v === 'never-printed') return count === 0;
  if (v === 'in-queue') return status === 'queued' || status === 'printing';
  if ((STATUSES as readonly string[]).includes(v)) return status === v;
  return true;
}

export function filterLabel(value: string | null | undefined): string {
  return FILTER_LABELS[value as string] || String(value || '');
}

export interface BundleSummary {
  label: string;
  className: string;
  printedCount: number;
  totalCount: number;
}

/** One badge for a group or ZIP bundle: printed, mixed or not printed. */
export function bundleSummary(children: PrintModel[] | null | undefined): BundleSummary {
  const list = Array.isArray(children) ? children : [];
  let everPrinted = 0;
  let totalCount = 0;
  for (const child of list) {
    const count = Number(child?.print_count) || 0;
    totalCount += count;
    if (count > 0 || child?.printed || effectiveStatus(child) === 'printed') everPrinted += 1;
  }
  if (!list.length || everPrinted === 0) {
    return { label: 'Not printed', className: 'print-status print-status-unprinted', printedCount: 0, totalCount: 0 };
  }
  if (everPrinted === list.length) {
    return {
      label: totalCount > 0 ? `Printed ×${totalCount}` : 'Printed',
      className: 'print-status print-status-printed printed',
      printedCount: everPrinted,
      totalCount
    };
  }
  return {
    label: totalCount > 0 ? `Mixed ×${totalCount}` : 'Mixed',
    className: 'print-status print-status-mixed mixed',
    printedCount: everPrinted,
    totalCount
  };
}

/** A value for <input type="datetime-local"> in local time. */
export function toDatetimeLocalValue(date: Date): string {
  const d = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Option text for a part: "Name (Category) — 12 pcs". */
export function partOptionLabel(part: { name: string; category?: string | null; quantity?: number | null; unit?: string | null }): string {
  const category = part.category ? ` (${part.category})` : '';
  const unit = part.unit ? ` ${part.unit}` : '';
  return `${part.name}${category} — ${Number(part.quantity) || 0}${unit}`;
}

/** Option text for a printer: "[FDM] Nickname (Maker Model)". */
export function printerOptionLabel(printer: { nickname: string; manufacturer?: string | null; model?: string | null; printer_type?: string | null }): string {
  const mfg = [printer.manufacturer, printer.model].filter(Boolean).join(' ');
  const typeTag = printer.printer_type ? `[${printer.printer_type}] ` : '';
  return `${typeTag}${printer.nickname}${mfg ? ` (${mfg})` : ''}`;
}

/** Remove the IPC wrapper text from an error message. */
export function friendlyError(error: unknown): string {
  const message = String((error as Error)?.message || error || 'Failed to log print');
  return message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
}
