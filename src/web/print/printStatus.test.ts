import { describe, expect, it } from 'vitest';
import {
  badgeClassNames, badgeText, bundleSummary, detailsHint, effectiveStatus, filterLabel,
  friendlyError, modelMatchesPrintFilter, partOptionLabel, printerOptionLabel, toDatetimeLocalValue
} from './printStatus';

describe('effectiveStatus', () => {
  it('prefers print_status and falls back to the printed flag', () => {
    expect(effectiveStatus({ print_status: 'Queued' })).toBe('queued');
    expect(effectiveStatus({ printed: 1 })).toBe('printed');
    expect(effectiveStatus({})).toBe('unprinted');
    expect(effectiveStatus(null)).toBe('unprinted');
  });
});

describe('badges', () => {
  it('counts logged prints on printed models', () => {
    expect(badgeText({ print_status: 'printed', print_count: 3 })).toBe('Printed ×3');
    expect(badgeText({ print_status: 'printed' })).toBe('Printed');
    expect(badgeText({ print_status: 'want' })).toBe('Want');
    expect(badgeText({ print_status: 'bogus' })).toBe('Not printed');
  });

  it('adds the printed class for printed or logged models', () => {
    expect(badgeClassNames({ print_status: 'failed', print_count: 1 })).toBe('print-status print-status-failed printed');
    expect(badgeClassNames({ print_status: 'queued' })).toBe('print-status print-status-queued');
  });
});

describe('detailsHint', () => {
  it('nudges toward logging when printed without history', () => {
    expect(detailsHint({ print_status: 'printed' })).toMatch(/^No logged prints yet/);
    expect(detailsHint({ print_status: 'queued' })).toBe('');
    expect(detailsHint({ print_status: 'printed', print_count: 1, last_printed_at: '2026-01-02T10:00:00Z' })).toMatch(/^Last printed /);
  });
});

describe('modelMatchesPrintFilter', () => {
  const printed = { print_status: 'printed', print_count: 2 };
  const failedOnce = { print_status: 'failed', print_count: 1 };
  const fresh = { print_status: 'unprinted' };
  it('matches each filter value', () => {
    expect(modelMatchesPrintFilter(fresh, 'all')).toBe(true);
    expect(modelMatchesPrintFilter(printed, 'printed')).toBe(true);
    expect(modelMatchesPrintFilter(failedOnce, 'printed')).toBe(false);
    expect(modelMatchesPrintFilter(failedOnce, 'not-printed')).toBe(false);
    expect(modelMatchesPrintFilter(fresh, 'not-printed')).toBe(true);
    expect(modelMatchesPrintFilter(failedOnce, 'ever-printed')).toBe(true);
    expect(modelMatchesPrintFilter(fresh, 'never-printed')).toBe(true);
    expect(modelMatchesPrintFilter(failedOnce, 'failed')).toBe(true);
    expect(modelMatchesPrintFilter(fresh, 'unknown')).toBe(true);
  });
  it('labels filter values', () => {
    expect(filterLabel('ever-printed')).toBe('Ever printed');
    expect(filterLabel('custom')).toBe('custom');
  });
});

describe('bundleSummary', () => {
  it('is printed, mixed or not printed', () => {
    expect(bundleSummary([]).label).toBe('Not printed');
    expect(bundleSummary([{ print_count: 2 }, { printed: 1 }]).label).toBe('Printed ×2');
    expect(bundleSummary([{ print_count: 1 }, {}])).toMatchObject({ label: 'Mixed ×1', printedCount: 1, totalCount: 1 });
  });
});

describe('formatting', () => {
  it('writes datetime-local values in local time', () => {
    expect(toDatetimeLocalValue(new Date(2026, 0, 5, 7, 3))).toBe('2026-01-05T07:03');
  });
  it('labels parts and printers', () => {
    expect(partOptionLabel({ name: 'M3 nut', category: 'Hardware', quantity: 12, unit: 'pcs' })).toBe('M3 nut (Hardware) — 12 pcs');
    expect(printerOptionLabel({ nickname: 'Bob', manufacturer: 'Prusa', model: 'MK4', printer_type: 'FDM' })).toBe('[FDM] Bob (Prusa MK4)');
  });
  it('strips IPC wrappers from errors', () => {
    expect(friendlyError(new Error("Error invoking remote method 'x': Error: Out of stock"))).toBe('Out of stock');
  });
});
