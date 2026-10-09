/**
 * Where everything lives in the JusttPrint 5 shell: the sidebar (spec §7), the Settings page
 * groups (spec §47), the Help page and the account menu. Every action of the old menu bar
 * (menu.ts) has a place here; nav.test.ts checks that nothing is lost (spec §53).
 *
 * Screens that are still dialogs open as dialogs; later phases turn them into pages.
 */
import {
  Archive,
  BarChart3,
  BookOpen,
  Box,
  FolderHeart,
  Link2,
  Brush,
  ClipboardList,
  Copy,
  Cpu,
  Database,
  Globe,
  FileCog,
  FolderTree,
  Gauge,
  HardDrive,
  ExternalLink,
  HelpCircle,
  Home,
  Image,
  Info,
  Keyboard,
  KeyRound,
  Library,
  ListChecks,
  LogOut,
  type LucideIcon,
  Package,
  Printer,
  RefreshCw,
  RotateCcw,
  Scan,
  ScanSearch,
  Settings,
  ShieldCheck,
  Shuffle,
  Smartphone,
  Sparkles,
  Tags,
  Trash2,
  UserCog,
  Wrench
} from 'lucide-react';
import { scanDirectory, scanStlHome } from '../scan/scan';
import { stlHomeDirectories } from '../scan/stlHome';
import { findMenuAction } from './menu';
import { navigate, type PageId } from './routes';
import { roleAllows, type Role } from '../session';

/** Run an old menu action by its label, looked up when clicked. */
const menu = (label: string) => () => {
  void findMenuAction(label)?.();
};
/** An old menu action that changes what the library shows: show the library, then run it. */
const inLibrary = (label: string) => () => {
  navigate('library');
  menu(label)();
};
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
  /** The least role that sees it (default viewer). */
  role?: Role;
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

export const NAV: NavSection[] = [
  {
    items: [
      { id: 'home', label: 'Home', icon: Home, page: 'home' },
      { id: 'library', label: 'Library', icon: Library, page: 'library' },
      { id: 'collections', label: 'Collections', icon: FolderHeart, page: 'collections' }
    ]
  },
  {
    label: 'Printing',
    items: [
      { id: 'queue', label: 'Queue', icon: ListChecks, page: 'queue' },
      { id: 'printers', label: 'Printers', icon: Printer, page: 'printers', replaces: ['Printer Manager'] },
      { id: 'stats', label: 'Statistics', icon: BarChart3, page: 'stats' }
    ]
  },
  {
    label: 'Manage',
    items: [
      { id: 'tags', label: 'Tags', icon: Tags, page: 'tags', replaces: ['Tag Manager'], role: 'editor' },
      { id: 'duplicates', label: 'Duplicates', icon: Copy, page: 'duplicates', replaces: ['De-Dup'], role: 'editor' },
      { id: 'organize', label: 'Organize', icon: FolderTree, page: 'organize', replaces: ['Organize Library'], role: 'admin' },
      {
        id: 'scan',
        label: 'Scan Library',
        icon: ScanSearch,
        run: () => {
          void scanLibrary();
        },
        role: 'editor'
      },
      { id: 'ai', label: 'AI Tagging', icon: Sparkles, run: open('openAiConfig'), replaces: ['AI Config'], role: 'admin' }
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
  /** A settings form shown inside the Settings page: its dialog's id and the global that opens it. */
  embed?: { dialog: string; open: string };
  /** The least role that sees it (default admin: settings change the whole server). */
  role?: Role;
}

export interface SettingsGroup {
  id: string;
  label: string;
  items: SettingsItem[];
}

export const SETTINGS: SettingsGroup[] = [
  {
    id: 'general',
    label: 'General',
    items: [
      {
        id: 'performance',
        label: 'Performance',
        description: 'File size limit, memory and worker settings.',
        icon: Gauge,
        run: menu('Performance'),
        replaces: ['Performance'],
        embed: { dialog: 'performance-settings-dialog', open: 'openPerformanceSettings' }
      }
    ]
  },
  {
    id: 'appearance',
    label: 'Appearance',
    items: [
      {
        id: 'theme',
        label: 'Theme',
        description: 'Your color scheme; for admins also the model color, lighting and background of thumbnails.',
        icon: Brush,
        run: menu('Theme'),
        replaces: ['Theme'],
        embed: { dialog: 'settings-dialog', open: 'openThemeSettings' },
        role: 'viewer'
      },
      {
        id: 'install',
        label: 'Install App',
        description: 'Add JusttPrint to your home screen or desktop.',
        icon: Smartphone,
        run: open('openInstallApp'),
        role: 'viewer'
      }
    ]
  },
  {
    id: 'library',
    label: 'Library',
    items: [
      {
        id: 'metadata',
        label: 'Metadata Manager',
        description: 'Rename or remove designers, licenses and parent models across the library.',
        icon: FileCog,
        run: menu('Metadata Manager'),
        replaces: ['Metadata Manager'],
        role: 'editor'
      },
      {
        id: 'stats',
        label: 'Library Stats',
        description: 'Model counts, sizes and how complete the metadata is.',
        icon: Database,
        run: menu('Library Stats'),
        replaces: ['Library Stats'],
        role: 'viewer'
      },
      {
        id: 'entire',
        label: 'View Entire Library',
        description: 'Clear every filter and show all models.',
        icon: Library,
        run: inLibrary('View Entire Library'),
        replaces: ['View Entire Library'],
        role: 'viewer'
      },
      {
        id: 'roulette',
        label: 'Print Roulette',
        description: 'Pick random models to print.',
        icon: Shuffle,
        run: inLibrary('Print Roulette'),
        replaces: ['Print Roulette'],
        role: 'viewer'
      },
      {
        id: 'clear-new',
        label: 'Clear New Flag',
        description: 'Mark every model as seen.',
        icon: RotateCcw,
        run: menu('Clear New Flag'),
        replaces: ['Clear New Flag'],
        role: 'editor'
      },
      {
        id: 'purge',
        label: 'Purge Models',
        description: 'Remove models of chosen file types from the library.',
        icon: Trash2,
        run: menu('Purge Models'),
        replaces: ['Purge Models'],
        danger: true
      }
    ]
  },
  {
    id: 'sharing',
    label: 'Sharing',
    items: [
      {
        id: 'links',
        label: 'Share Links',
        description: 'Every read-only link to a model or collection, and turning them off.',
        icon: Link2,
        run: open('openShareLinks'),
        embed: { dialog: 'share-links-dialog', open: 'openShareLinks' },
        role: 'editor'
      }
    ]
  },
  {
    id: 'scanning',
    label: 'Scanning',
    items: [
      {
        id: 'stl-home',
        label: 'STL Home',
        description: 'Library folders scanned at startup and on a schedule.',
        icon: HardDrive,
        run: menu('STL Home'),
        replaces: ['STL Home'],
        embed: { dialog: 'stl-home-dialog', open: 'openStlHome' }
      },
      {
        id: 'file-types',
        label: 'File Types',
        description: 'Extra file types to scan, and models inside ZIP files.',
        icon: Box,
        run: menu('File Type'),
        replaces: ['File Type'],
        embed: { dialog: 'file-type-settings-dialog', open: 'openFileTypeSettings' }
      },
      {
        id: 'scan-folder',
        label: 'Scan a Folder',
        description: 'Scan one folder once, outside STL Home.',
        icon: Scan,
        run: menu('Scan Directory'),
        replaces: ['Scan Directory']
      }
    ]
  },
  {
    id: 'slicer',
    label: 'Slicer',
    items: [
      {
        id: 'slicers',
        label: 'Slicers',
        description: 'OrcaSlicer (no helper needed), or other slicers through the helper on each computer.',
        icon: Wrench,
        run: menu('Slicer'),
        replaces: ['Slicer'],
        embed: { dialog: 'slicer-dialog', open: 'openSlicerSettings' }
      }
    ]
  },
  {
    id: 'printers',
    label: 'Printers',
    items: [
      {
        id: 'printers',
        label: 'Printers',
        description: 'Your printers, their web pages and maintenance reminders.',
        icon: Printer,
        run: () => navigate('printers'),
        role: 'viewer'
      },
      {
        id: 'parts',
        label: 'Parts Manager',
        description: 'Spare parts stock for your printers.',
        icon: Package,
        run: menu('Parts Manager'),
        replaces: ['Parts Manager'],
        role: 'editor'
      }
    ]
  },
  {
    id: 'integrations',
    label: 'Integrations',
    items: [
      {
        id: 'thingiverse',
        label: 'Thingiverse',
        description: 'The API token Add Links downloads Thingiverse files with.',
        icon: KeyRound,
        run: open('openThingiverseSettings'),
        embed: { dialog: 'thingiverse-settings-dialog', open: 'openThingiverseSettings' }
      },
      {
        id: 'makerworld',
        label: 'MakerWorld',
        description: 'The sign-in for downloads, and English names for MakerWorld files.',
        icon: Globe,
        run: open('openMakerWorldSettings'),
        embed: { dialog: 'makerworld-settings-dialog', open: 'openMakerWorldSettings' }
      },
      {
        id: 'mcp',
        label: 'MCP Server',
        description: 'Connect an AI app (Claude, Cursor, VS Code) to your library.',
        icon: Cpu,
        run: open('openMcpServerSettings'),
        replaces: ['Settings'],
        embed: { dialog: 'mcp-server-settings-dialog', open: 'openMcpServerSettings' }
      }
    ]
  },
  {
    id: 'ai',
    label: 'AI',
    items: [
      {
        id: 'ai',
        label: 'AI Tagging',
        description: 'AI service, model, and how tags are generated.',
        icon: Sparkles,
        run: menu('AI Config'),
        embed: { dialog: 'ai-config-dialog', open: 'openAiConfig' }
      }
    ]
  },
  {
    id: 'server',
    label: 'JusttPrint Backend',
    items: [
      {
        id: 'https',
        label: 'HTTPS / SSL',
        description: 'Listen port and certificates.',
        icon: ShieldCheck,
        run: menu('HTTPS / SSL'),
        replaces: ['HTTPS / SSL'],
        embed: { dialog: 'https-settings-dialog', open: 'openHttpsSettings' }
      },
      {
        id: 'restart',
        label: 'Restart JusttPrint Backend',
        description: 'Disconnects everyone for a moment.',
        icon: RefreshCw,
        run: menu('Restart JusttPrint Backend'),
        replaces: ['Restart JusttPrint Backend']
      }
    ]
  },
  {
    id: 'authentication',
    label: 'Authentication',
    items: [
      {
        id: 'users',
        label: 'Users',
        description: 'Who can log in, and what each one may do.',
        icon: UserCog,
        run: open('openUsers'),
        embed: { dialog: 'users-dialog', open: 'openUsers' }
      },
      {
        id: 'password',
        label: 'Change Password',
        description: 'Change the password you log in with.',
        icon: KeyRound,
        run: open('openChangePassword'),
        role: 'viewer'
      },
      {
        id: 'access',
        label: 'JusttPrint Backend Access',
        description: 'The API token for MCP clients and scripts.',
        icon: KeyRound,
        run: menu('JusttPrint Backend Access'),
        replaces: ['JusttPrint Backend Access'],
        embed: { dialog: 'server-access-dialog', open: 'openServerAccess' }
      },
      { id: 'logout', label: 'Log Out', description: 'Log out of this browser.', icon: LogOut, run: menu('Log Out'), replaces: ['Log Out'], role: 'viewer' }
    ]
  },
  {
    id: 'backup',
    label: 'Backup',
    items: [
      {
        id: 'backup',
        label: 'Backup and Restore',
        description: 'Back up the library database or restore one.',
        icon: Archive,
        run: menu('Backup/Restore'),
        replaces: ['Backup/Restore'],
        embed: { dialog: 'backup-restore-dialog', open: 'openBackupRestore' }
      }
    ]
  },
  {
    id: 'advanced',
    label: 'Advanced',
    items: [
      {
        id: 'regenerate',
        label: 'Regenerate Thumbnails',
        description: 'Render every thumbnail again.',
        icon: Image,
        run: menu('Regenerate Thumbnails'),
        replaces: ['Regenerate Thumbnails'],
        role: 'editor'
      },
      {
        id: 'missing',
        label: 'Generate Missing Thumbnails',
        description: 'Render thumbnails for models without one.',
        icon: Image,
        run: menu('Generate Missing Thumbnails'),
        replaces: ['Generate Missing Thumbnails'],
        role: 'editor'
      },
      {
        id: 'report',
        label: 'System Report',
        description: 'JusttPrint backend, GPU and database details for troubleshooting.',
        icon: ClipboardList,
        run: menu('System Report'),
        replaces: ['System Report']
      }
    ]
  },
  {
    id: 'about',
    label: 'About',
    items: [
      {
        id: 'about',
        label: 'About JusttPrint',
        description: 'Version, updates and license.',
        icon: Info,
        run: menu('About'),
        replaces: ['About'],
        role: 'viewer'
      }
    ]
  }
];

export const HELP: SettingsItem[] = [
  {
    id: 'guide',
    label: 'Quick Start Guide',
    description: 'A short tour of JusttPrint.',
    icon: BookOpen,
    run: menu('Quick Start Guide'),
    replaces: ['Quick Start Guide']
  },
  { id: 'install', label: 'Install App', description: 'Add JusttPrint to your home screen or desktop.', icon: Smartphone, run: open('openInstallApp') },
  {
    id: 'shortcuts',
    label: 'Keyboard Shortcuts',
    description: 'Every shortcut in one list.',
    icon: Keyboard,
    run: menu('Keyboard Shortcuts'),
    replaces: ['Keyboard Shortcuts']
  },
  {
    id: 'docs',
    label: 'Installing and Setup',
    description: 'The README: Docker, environment variables, network shares.',
    icon: Info,
    run: menu('Server Mode Info'),
    replaces: ['Server Mode Info']
  },
  { id: 'github', label: 'GitHub', description: 'Releases, issues and source code.', icon: ExternalLink, run: menu('GitHub'), replaces: ['GitHub'] },
  {
    id: 'report',
    label: 'System Report',
    description: 'Details to include when reporting a problem.',
    icon: ClipboardList,
    run: menu('System Report'),
    role: 'admin'
  },
  { id: 'about', label: 'About JusttPrint', description: 'Version, updates and license.', icon: Info, run: menu('About') }
];

/** The account button in the top bar. */
export const ACCOUNT: SettingsItem[] = [
  { id: 'password', label: 'Change Password', description: '', icon: KeyRound, run: open('openChangePassword'), role: 'viewer' },
  { id: 'users', label: 'Users', description: '', icon: UserCog, run: () => navigate('settings', 'authentication') },
  { id: 'access', label: 'JusttPrint Backend Access', description: '', icon: KeyRound, run: menu('JusttPrint Backend Access') },
  { id: 'logout', label: 'Log Out', description: '', icon: LogOut, run: menu('Log Out'), role: 'viewer' }
];

/** Navigation entries the user's role may use. */
export const navFor = (role: string | null | undefined) =>
  NAV.map((section) => ({ ...section, items: section.items.filter((item) => roleAllows(role, item.role || 'viewer')) })).filter(
    (section) => section.items.length > 0
  );

/** Settings, Help or account entries the user's role may use (settings default to admin, Help to viewer). */
export const itemsFor = (items: SettingsItem[], role: string | null | undefined, fallback: Role = 'admin') =>
  items.filter((item) => roleAllows(role, item.role || fallback));

/** Settings groups with at least one entry for this role. */
export const settingsFor = (role: string | null | undefined) =>
  SETTINGS.map((group) => ({ ...group, items: itemsFor(group.items, role) })).filter((group) => group.items.length > 0);

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
