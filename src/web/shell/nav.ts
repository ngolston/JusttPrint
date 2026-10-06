/**
 * Where everything lives in the JusttPrint 5 shell: the sidebar (spec §7), the Settings page
 * groups (spec §47), the Help page and the account menu. Every action of the old menu bar
 * (menu.ts) has a place here; nav.test.ts checks that nothing is lost (spec §53).
 *
 * Screens that are still dialogs open as dialogs; later phases turn them into pages.
 */
import {
  Archive, BookOpen, Box, Brush, Cable, ClipboardList, Copy, Cpu, Database, FileCog, FolderTree, Gauge, HardDrive,
  ExternalLink, HelpCircle, Home, Image, Info, Keyboard, KeyRound, Library, ListChecks, LogOut, type LucideIcon, Package, Printer,
  RefreshCw, RotateCcw, Scan, ScanSearch, Settings, ShieldCheck, Shuffle, Sparkles, Tags, Trash2, Wrench
} from 'lucide-react';
import { filterActions } from '../filters/store';
import { scanDirectory, scanStlHome } from '../scan/scan';
import { stlHomeDirectories } from '../scan/stlHome';
import { findMenuAction } from './menu';
import { navigate, type PageId } from './routes';

/** Run an old menu action by its label, looked up when clicked. */
const menu = (label: string) => () => { void findMenuAction(label)?.(); };
/** Call a screen's global (window.openX), if that screen is loaded. */
const open = (name: string) => () => {
  const fn = (window as unknown as Record<string, unknown>)[name];
  if (typeof fn === 'function') fn();
};

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** A page of the shell, shown as the active row while open. */
  page?: PageId;
  /** Otherwise an action (most still open dialogs). */
  run?: () => void;
  /** Old menu bar labels this item replaces. */
  replaces?: string[];
}

export interface NavSection {
  /** Section label ('PRINTING'); none for the first group. */
  label?: string;
  items: NavItem[];
}

/** Scan Library: the STL Home folders, or one folder when STL Home is not set up. */
async function scanLibrary() {
  const dirs = await stlHomeDirectories().catch(() => []);
  if (dirs.length) await scanStlHome();
  else await scanDirectory();
}

/** The queue until it has its own page (Phase 6): the library filtered to Queued. */
function showQueue() {
  navigate('library');
  filterActions.setSingle('printed', 'queued');
}

export const NAV: NavSection[] = [
  {
    items: [
      { id: 'home', label: 'Home', icon: Home, page: 'home' },
      { id: 'library', label: 'Library', icon: Library, page: 'library' }
    ]
  },
  {
    label: 'Printing',
    items: [
      { id: 'queue', label: 'Queue', icon: ListChecks, run: showQueue },
      { id: 'printers', label: 'Printers', icon: Printer, run: open('openPrinterManagement'), replaces: ['Printer Manager'] },
      { id: 'filament', label: 'Filament', icon: Cable, run: open('openFilamentManager'), replaces: ['Filament Manager'] }
    ]
  },
  {
    label: 'Manage',
    items: [
      { id: 'tags', label: 'Tags', icon: Tags, run: open('openTagManager'), replaces: ['Tag Manager'] },
      { id: 'duplicates', label: 'Duplicates', icon: Copy, run: open('openDedup'), replaces: ['De-Dup'] },
      { id: 'organize', label: 'Organize', icon: FolderTree, run: open('openOrganizeLibrary'), replaces: ['Organize Library'] },
      { id: 'scan', label: 'Scan Library', icon: ScanSearch, run: () => { void scanLibrary(); } },
      { id: 'ai', label: 'AI Tagging', icon: Sparkles, run: open('openAiConfig'), replaces: ['AI Config'] }
    ]
  },
  {
    label: 'System',
    items: [
      { id: 'settings', label: 'Settings', icon: Settings, page: 'settings' },
      { id: 'help', label: 'Help', icon: HelpCircle, page: 'help' }
    ]
  }
];

export interface SettingsItem {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  run: () => void;
  replaces?: string[];
  danger?: boolean;
}

export interface SettingsGroup {
  id: string;
  label: string;
  items: SettingsItem[];
}

export const SETTINGS: SettingsGroup[] = [
  { id: 'general', label: 'General', items: [
    { id: 'performance', label: 'Performance', description: 'File size limit, memory and worker settings.', icon: Gauge, run: menu('Performance'), replaces: ['Performance'] }
  ] },
  { id: 'appearance', label: 'Appearance', items: [
    { id: 'theme', label: 'Theme', description: 'Accent color, model color, lighting and background of previews.', icon: Brush, run: menu('Theme'), replaces: ['Theme'] }
  ] },
  { id: 'library', label: 'Library', items: [
    { id: 'metadata', label: 'Metadata Manager', description: 'Rename or remove designers, licenses and parent models across the library.', icon: FileCog, run: menu('Metadata Manager'), replaces: ['Metadata Manager'] },
    { id: 'stats', label: 'Library Stats', description: 'Model counts, sizes and how complete the metadata is.', icon: Database, run: menu('Library Stats'), replaces: ['Library Stats'] },
    { id: 'entire', label: 'View Entire Library', description: 'Clear every filter and show all models.', icon: Library, run: menu('View Entire Library'), replaces: ['View Entire Library'] },
    { id: 'roulette', label: 'Print Roulette', description: 'Pick random models to print.', icon: Shuffle, run: menu('Print Roulette'), replaces: ['Print Roulette'] },
    { id: 'clear-new', label: 'Clear New Flag', description: 'Mark every model as seen.', icon: RotateCcw, run: menu('Clear New Flag'), replaces: ['Clear New Flag'] },
    { id: 'purge', label: 'Purge Models', description: 'Remove models of chosen file types from the library.', icon: Trash2, run: menu('Purge Models'), replaces: ['Purge Models'], danger: true }
  ] },
  { id: 'scanning', label: 'Scanning', items: [
    { id: 'stl-home', label: 'STL Home', description: 'Library folders scanned at startup and on a schedule.', icon: HardDrive, run: menu('STL Home'), replaces: ['STL Home'] },
    { id: 'file-types', label: 'File Types', description: 'Extra file types to scan, and models inside ZIP files.', icon: Box, run: menu('File Type'), replaces: ['File Type'] },
    { id: 'scan-folder', label: 'Scan a Folder', description: 'Scan one folder once, outside STL Home.', icon: Scan, run: menu('Scan Directory'), replaces: ['Scan Directory'] }
  ] },
  { id: 'slicer', label: 'Slicer', items: [
    { id: 'slicers', label: 'Slicers', description: 'Slicers for Send to Slicer, and the helper for this computer.', icon: Wrench, run: menu('Slicer'), replaces: ['Slicer'] }
  ] },
  { id: 'printers', label: 'Printers', items: [
    { id: 'printers', label: 'Printer Manager', description: 'Your printers, their web pages and maintenance reminders.', icon: Printer, run: menu('Printer Manager') },
    { id: 'parts', label: 'Parts Manager', description: 'Spare parts stock for your printers.', icon: Package, run: menu('Parts Manager'), replaces: ['Parts Manager'] }
  ] },
  { id: 'filament', label: 'Filament', items: [
    { id: 'filament', label: 'Filament Manager', description: 'Your filament catalog, and Spoolman sync.', icon: Cable, run: menu('Filament Manager') }
  ] },
  { id: 'integrations', label: 'Integrations', items: [
    { id: 'mcp', label: 'MCP Server', description: 'Connect an AI app (Claude, Cursor, VS Code) to your library.', icon: Cpu, run: open('openMcpServerSettings'), replaces: ['Settings'] }
  ] },
  { id: 'ai', label: 'AI', items: [
    { id: 'ai', label: 'AI Tagging', description: 'AI service, model, and how tags are generated.', icon: Sparkles, run: menu('AI Config') }
  ] },
  { id: 'server', label: 'Server', items: [
    { id: 'https', label: 'HTTPS / SSL', description: 'Listen port and certificates.', icon: ShieldCheck, run: menu('HTTPS / SSL'), replaces: ['HTTPS / SSL'] },
    { id: 'restart', label: 'Restart Server', description: 'Disconnects everyone for a moment.', icon: RefreshCw, run: menu('Restart Server'), replaces: ['Restart Server'] }
  ] },
  { id: 'authentication', label: 'Authentication', items: [
    { id: 'access', label: 'Server Access', description: 'Password and API token.', icon: KeyRound, run: menu('Server Access'), replaces: ['Server Access'] },
    { id: 'logout', label: 'Log Out', description: 'Log out of this browser.', icon: LogOut, run: menu('Log Out'), replaces: ['Log Out'] }
  ] },
  { id: 'backup', label: 'Backup', items: [
    { id: 'backup', label: 'Backup and Restore', description: 'Back up the library database or restore one.', icon: Archive, run: menu('Backup/Restore'), replaces: ['Backup/Restore'] }
  ] },
  { id: 'advanced', label: 'Advanced', items: [
    { id: 'regenerate', label: 'Regenerate Thumbnails', description: 'Render every thumbnail again.', icon: Image, run: menu('Regenerate Thumbnails'), replaces: ['Regenerate Thumbnails'] },
    { id: 'missing', label: 'Generate Missing Thumbnails', description: 'Render thumbnails for models without one.', icon: Image, run: menu('Generate Missing Thumbnails'), replaces: ['Generate Missing Thumbnails'] },
    { id: 'report', label: 'System Report', description: 'Server, GPU and database details for troubleshooting.', icon: ClipboardList, run: menu('System Report'), replaces: ['System Report'] }
  ] },
  { id: 'about', label: 'About', items: [
    { id: 'about', label: 'About JusttPrint', description: 'Version, updates and license.', icon: Info, run: menu('About'), replaces: ['About'] }
  ] }
];

export const HELP: SettingsItem[] = [
  { id: 'guide', label: 'Quick Start Guide', description: 'A short tour of JusttPrint.', icon: BookOpen, run: menu('Quick Start Guide'), replaces: ['Quick Start Guide'] },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', description: 'Every shortcut in one list.', icon: Keyboard, run: menu('Keyboard Shortcuts'), replaces: ['Keyboard Shortcuts'] },
  { id: 'docs', label: 'Installing and Setup', description: 'The README: Docker, environment variables, network shares.', icon: Info, run: menu('Server Mode Info'), replaces: ['Server Mode Info'] },
  { id: 'github', label: 'GitHub', description: 'Releases, issues and source code.', icon: ExternalLink, run: menu('GitHub'), replaces: ['GitHub'] },
  { id: 'report', label: 'System Report', description: 'Details to include when reporting a problem.', icon: ClipboardList, run: menu('System Report') },
  { id: 'about', label: 'About JusttPrint', description: 'Version, updates and license.', icon: Info, run: menu('About') }
];

/** The account button in the top bar. There are no user accounts: one password per server. */
export const ACCOUNT: SettingsItem[] = [
  { id: 'access', label: 'Server Access', description: '', icon: KeyRound, run: menu('Server Access') },
  { id: 'logout', label: 'Log Out', description: '', icon: LogOut, run: menu('Log Out') }
];

/** Old menu labels that have a place in the shell. */
export function replacedMenuLabels(): Set<string> {
  const labels = new Set<string>();
  const add = (item: { replaces?: string[] }) => item.replaces?.forEach((label) => labels.add(label));
  NAV.forEach((section) => section.items.forEach(add));
  SETTINGS.forEach((group) => group.items.forEach(add));
  HELP.forEach(add);
  ACCOUNT.forEach(add);
  return labels;
}
