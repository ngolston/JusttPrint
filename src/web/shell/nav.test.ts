import { describe, expect, it } from 'vitest';
import { MENU, type MenuItem } from './menu';
import { ACCOUNT, HELP, MODEL_TOOLS, NAV, SETTINGS, itemsFor, navFor, navItems, replacedMenuLabels, settingsFor, toolsFor } from './nav';
import { formatRoute, parseRoute } from './routes';

const actionLabels = (items: MenuItem[]): string[] =>
  items.flatMap((item) => (item.kind === 'action' ? [item.label] : item.kind === 'submenu' ? actionLabels(item.items) : []));

describe('shell navigation', () => {
  it('gives every old menu action a place (spec §53)', () => {
    const replaced = replacedMenuLabels();
    const missing = actionLabels(MENU.flatMap((group) => group.items)).filter((label) => !replaced.has(label));
    expect(missing).toEqual([]);
  });

  it('has five entries, three of them with a fly-out menu', () => {
    const tree = NAV.map((item) => [item.label, (item.children ?? []).map((child) => child.label)]);
    expect(tree).toEqual([
      ['Home', []],
      ['Models', ['Collections', 'Categories', 'Tags', 'Duplicates']],
      ['Filament', []],
      ['Printing', ['Queue', 'Printers', 'Statistics']],
      ['Settings', ['History']]
    ]);
    // Printing opens Printers; every fly-out entry says what it is.
    expect(NAV.find((item) => item.id === 'printing')?.page).toBe('printers');
    for (const child of NAV.flatMap((item) => item.children ?? [])) expect(child.description).toBeTruthy();
    expect(MODEL_TOOLS.map((item) => item.label)).toEqual(['Organize', 'Scan Library', 'AI Tagging']);
    expect(SETTINGS.map((g) => g.label)).toEqual([
      'Appearance',
      'Library',
      'Sharing',
      'Scanning',
      'Slicer',
      'Printers',
      'Integrations',
      'AI',
      'JusttPrint Backend',
      'Authentication',
      'Backup',
      'Advanced',
      'About'
    ]);
  });

  it('gives every entry an action or a page, and unique ids', () => {
    for (const item of [...navItems(), ...MODEL_TOOLS]) expect(!!item.page || typeof item.run === 'function').toBe(true);
    const navIds = navItems().map((item) => item.id);
    expect(new Set(navIds).size).toBe(navIds.length);
    const ids = SETTINGS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const list of [HELP, ACCOUNT, ...SETTINGS.map((g) => g.items)]) {
      expect(new Set(list.map((i) => i.id)).size).toBe(list.length);
    }
  });
});

describe('roles', () => {
  const labels = (role: string) => navItems(navFor(role)).map((item) => item.label);
  const tools = (role: string) => toolsFor(role).map((item) => item.label);

  it('shows viewers the pages that only look, editors the library tools, admins everything', () => {
    expect(labels('viewer')).toEqual([
      'Home',
      'Models',
      'Collections',
      'Categories',
      'Filament',
      'Printing',
      'Queue',
      'Printers',
      'Statistics',
      'Settings',
      'History'
    ]);
    expect(labels('editor')).toEqual([
      'Home',
      'Models',
      'Collections',
      'Categories',
      'Tags',
      'Duplicates',
      'Filament',
      'Printing',
      'Queue',
      'Printers',
      'Statistics',
      'Settings',
      'History'
    ]);
    expect(labels('admin')).toEqual(navItems().map((item) => item.label));
    expect(navFor(null)).toEqual([]);
    // Viewers run none of the Models page's tools; editors Organize and Scan Library (Organize's
    // settings are an admin's, Settings → Scanning → Organize); admins AI Tagging too.
    expect(tools('viewer')).toEqual([]);
    expect(tools('editor')).toEqual(['Organize', 'Scan Library']);
    expect(tools('admin')).toEqual(['Organize', 'Scan Library', 'AI Tagging']);
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
    // #/library, the Models page's old address, still opens it.
    expect(parseRoute('#/library')).toEqual({ page: 'models', section: '' });
    // #/help, the old Help page, opens the Settings page's Help tab.
    expect(parseRoute('#/help')).toEqual({ page: 'settings', section: 'help' });
    expect(parseRoute('')).toEqual({ page: 'home', section: '' });
    expect(parseRoute('#/design-system')).toEqual({ page: 'home', section: '' });
    expect(parseRoute('#/nope')).toEqual({ page: 'home', section: '' });
    expect(formatRoute('settings', 'a b')).toBe('#/settings/a%20b');
    // A model's page carries its whole path.
    expect(parseRoute(formatRoute('model', '/library/Cosplay/helmet v2.stl'))).toEqual({ page: 'model', section: '/library/Cosplay/helmet v2.stl' });
    expect(parseRoute(formatRoute('model', 'url::https://makerworld.com/en/models/1'))).toEqual({
      page: 'model',
      section: 'url::https://makerworld.com/en/models/1'
    });
    expect(parseRoute(formatRoute('settings', 'a b')).section).toBe('a b');
  });
});

import { changesData } from '../api';

describe('library change signal', () => {
  it('fires after saves, not after reads or thumbnail and preview work', () => {
    for (const name of ['save-model', 'set-print-status', 'log-print-event', 'scan-directory', 'delete-file', 'save-printer', 'restore-database']) {
      expect(changesData(name)).toBe(true);
    }
    for (const name of [
      'get-library-counts',
      'getThumbnail',
      'getTotalModelCount',
      'read-model-file',
      'save-thumbnail',
      'add-thumbnail',
      'parse-3mf-preview',
      'show-context-menu',
      'calculate-file-hash',
      'report-server-thumbnail-progress',
      'delete-temp-file',
      'start-server-thumbnail-job'
    ]) {
      expect(changesData(name)).toBe(false);
    }
  });
});
