import { describe, expect, it } from 'vitest';
import { MENU, type MenuItem } from './menu';
import { ACCOUNT, HELP, NAV, SETTINGS, itemsFor, navFor, replacedMenuLabels, settingsFor } from './nav';
import { formatRoute, parseRoute } from './routes';

const actionLabels = (items: MenuItem[]): string[] => items.flatMap((item) =>
  item.kind === 'action' ? [item.label] : item.kind === 'submenu' ? actionLabels(item.items) : []);

describe('shell navigation', () => {
  it('gives every old menu action a place (spec §53)', () => {
    const replaced = replacedMenuLabels();
    const missing = actionLabels(MENU.flatMap((group) => group.items)).filter((label) => !replaced.has(label));
    expect(missing).toEqual([]);
  });

  it('follows the spec navigation order', () => {
    expect(NAV.map((s) => s.label ?? '')).toEqual(['', 'Printing', 'Manage', 'System']);
    expect(NAV.flatMap((s) => s.items.map((i) => i.label))).toEqual([
      'Home', 'Library', 'Collections', 'Queue', 'Printers', 'Statistics', 'Tags', 'Duplicates', 'Organize', 'Scan Library', 'AI Tagging', 'Settings', 'Help'
    ]);
    expect(SETTINGS.map((g) => g.label)).toEqual([
      'General', 'Appearance', 'Library', 'Sharing', 'Scanning', 'Slicer', 'Printers', 'Integrations', 'AI', 'JusttPrint Backend', 'Authentication', 'Backup', 'Advanced', 'About'
    ]);
  });

  it('gives every entry an action or a page, and unique ids', () => {
    for (const section of NAV) for (const item of section.items) expect(!!item.page || typeof item.run === 'function').toBe(true);
    const ids = SETTINGS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const list of [HELP, ACCOUNT, ...SETTINGS.map((g) => g.items)]) {
      expect(new Set(list.map((i) => i.id)).size).toBe(list.length);
    }
  });
});

describe('roles', () => {
  const labels = (role: string) => navFor(role).flatMap((s) => s.items.map((i) => i.label));

  it('shows viewers the pages that only look, editors the library tools, admins everything', () => {
    expect(labels('viewer')).toEqual(['Home', 'Library', 'Collections', 'Queue', 'Printers', 'Statistics', 'Settings', 'Help']);
    expect(labels('editor')).toEqual(['Home', 'Library', 'Collections', 'Queue', 'Printers', 'Statistics', 'Tags', 'Duplicates', 'Scan Library', 'Settings', 'Help']);
    expect(labels('admin')).toEqual(NAV.flatMap((s) => s.items.map((i) => i.label)));
    expect(navFor(null)).toEqual([]);
  });

  it('keeps server settings, backups and accounts for admins', () => {
    const viewerSettings = settingsFor('viewer').flatMap((g) => g.items.map((i) => i.id));
    for (const id of ['users', 'access', 'backup', 'https', 'restart', 'ai', 'mcp', 'stl-home', 'purge']) expect(viewerSettings).not.toContain(id);
    expect(viewerSettings).toEqual(expect.arrayContaining(['password', 'logout', 'about', 'stats']));
    expect(settingsFor('admin').flatMap((g) => g.items)).toHaveLength(SETTINGS.flatMap((g) => g.items).length);
    expect(itemsFor(ACCOUNT, 'viewer').map((i) => i.id)).toEqual(['password', 'logout']);
    expect(itemsFor(HELP, 'viewer', 'viewer').map((i) => i.id)).not.toContain('report');
  });
});

describe('routes', () => {
  it('reads pages and sections from the hash, and falls back to Home', () => {
    expect(parseRoute('#/settings/ai')).toEqual({ page: 'settings', section: 'ai' });
    expect(parseRoute('#/home')).toEqual({ page: 'home', section: '' });
    expect(parseRoute('')).toEqual({ page: 'home', section: '' });
    expect(parseRoute('#/design-system')).toEqual({ page: 'home', section: '' });
    expect(parseRoute('#/nope')).toEqual({ page: 'home', section: '' });
    expect(formatRoute('settings', 'a b')).toBe('#/settings/a%20b');
    expect(parseRoute(formatRoute('settings', 'a b')).section).toBe('a b');
  });
});

import { changesData } from '../api';

describe('library change signal', () => {
  it('fires after saves, not after reads or thumbnail and preview work', () => {
    for (const name of ['save-model', 'set-print-status', 'log-print-event', 'scan-directory', 'delete-file', 'save-printer', 'restore-database']) {
      expect(changesData(name)).toBe(true);
    }
    for (const name of ['get-library-counts', 'getThumbnail', 'getTotalModelCount', 'read-model-file', 'save-thumbnail', 'add-thumbnail',
      'parse-3mf-preview', 'show-context-menu', 'calculate-file-hash', 'report-server-thumbnail-progress', 'delete-temp-file', 'start-server-thumbnail-job']) {
      expect(changesData(name)).toBe(false);
    }
  });
});
