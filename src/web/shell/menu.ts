/**
 * The app menu: Tools, Settings and Help. The menu bar (MenuBar.tsx) shows it on a computer,
 * the More sheet (MobileShell.tsx) on a phone. Each action opens a screen through the global
 * the screen registers (window.openStats, window.openTagManager, ...).
 */
import { callAction } from '../api';
import { showMessage } from '../page';
import { viewEntireLibrary } from '../filters/SidebarActions';
import { scanDirectory } from '../scan/scan';
import { clearNewFlags, printRoulette } from '../library/actions';

export type MenuItem =
  | { kind: 'action'; label: string; run: () => void | Promise<void> }
  | { kind: 'submenu'; label: string; items: MenuItem[] }
  | { kind: 'separator' };

export interface MenuGroup {
  label: 'Tools' | 'Settings' | 'Help';
  items: MenuItem[];
}

/** Call a screen's global (window[name]), if that screen is loaded. */
const open = (name: string) => () => {
  const fn = (window as unknown as Record<string, unknown>)[name];
  if (typeof fn === 'function') return fn();
};
/** A page event ('regenerate-thumbnails', ...; thumbnails/jobs.ts listens). */
const send = (channel: string) => () => window.electron?.send?.(channel);

const action = (label: string, run: () => void | Promise<void>): MenuItem => ({ kind: 'action', label, run });
const separator: MenuItem = { kind: 'separator' };

async function restartServer() {
  const answer = await showMessage('Restart Server',
    'Restart the server? Everyone connected is disconnected for a moment.', ['Restart', 'Cancel']);
  if (answer !== 'Restart') return;
  try {
    const result = await callAction<{ success?: boolean; message?: string }>('restart-server');
    if (result?.success) await showMessage('Restart Server', 'The server restarted.');
    else await showMessage('Restart Server', `Failed to restart the server: ${result?.message || 'unknown error'}`);
  } catch (error) {
    console.error('Error restarting server:', error);
    await showMessage('Restart Server', `Failed to restart the server: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const MENU: MenuGroup[] = [
  {
    label: 'Tools',
    items: [
      action('Scan Directory', () => scanDirectory()),
      action('View Entire Library', viewEntireLibrary),
      separator,
      action('Print Roulette', printRoulette),
      action('De-Dup', open('openDedup')),
      action('Organize Library', open('openOrganizeLibrary')),
      separator,
      { kind: 'submenu', label: 'MCP Server', items: [action('Settings', open('openMcpServerSettings')), action('HTTPS / SSL', open('openHttpsSettings'))] },
      separator,
      action('Filament Manager', open('openFilamentManager')),
      action('Printer Manager', open('openPrinterManagement')),
      action('Parts Manager', open('openPartsStock')),
      action('Tag Manager', open('openTagManager')),
      action('Metadata Manager', open('openMetadataEditor')),
      separator,
      action('Clear New Flag', clearNewFlags),
      action('Regenerate Thumbnails', send('regenerate-thumbnails')),
      action('Generate Missing Thumbnails', send('generate-missing-thumbnails')),
      action('Purge Models', open('openPurgeModels')),
      separator,
      action('Backup/Restore', open('openBackupRestore')),
      separator,
      action('Restart Server', restartServer),
      action('Server Access', open('openServerAccess')),
      action('Log Out', open('logOutOfServer'))
    ]
  },
  {
    label: 'Settings',
    items: [
      action('AI Config', open('openAiConfig')),
      action('File Type', open('openFileTypeSettings')),
      action('Performance', open('openPerformanceSettings')),
      action('Slicer', open('openSlicerSettings')),
      action('STL Home', open('openStlHome')),
      action('Theme', open('openThemeSettings'))
    ]
  },
  {
    label: 'Help',
    items: [
      action('Quick Start Guide', open('showGuide')),
      action('Keyboard Shortcuts', open('openKeyboardShortcuts')),
      action('About', open('openAbout')),
      separator,
      action('GitHub', () => { window.electron?.openExternal?.('https://github.com/ngolston/JusttPrint'); }),
      separator,
      action('Library Stats', open('openStats')),
      action('System Report', open('openSystemReport')),
      action('Server Mode Info', () => { window.electron?.openExternal?.('https://github.com/ngolston/JusttPrint?tab=readme-ov-file#server-mode'); })
    ]
  }
];

/** Find a menu action by its label (the phone's tool buttons use the menu's actions). */
export function findMenuAction(label: string, items: MenuItem[] = MENU.flatMap((group) => group.items)): (() => void | Promise<void>) | null {
  for (const item of items) {
    if (item.kind === 'action' && item.label === label) return item.run;
    if (item.kind === 'submenu') {
      const found = findMenuAction(label, item.items);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The items without leading, trailing or doubled separators (after some were filtered out).
 */
export function tidySeparators(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of items) {
    if (item.kind === 'separator' && (!out.length || out[out.length - 1].kind === 'separator')) continue;
    out.push(item);
  }
  while (out.length && out[out.length - 1].kind === 'separator') out.pop();
  return out;
}
