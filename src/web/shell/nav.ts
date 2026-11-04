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
  BellRing,
  Coins,
  Box,
  CircleDot,
  FolderHeart,
  FolderInput,
  Shapes,
  Link2,
  Brush,
  ClipboardList,
  Copy,
  Cpu,
  Database,
  Globe,
  FileCog,
  FolderTree,
  Gift,
  Gauge,
  HardDrive,
  ExternalLink,
  HelpCircle,
  History,
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
  Upload,
  UserCog,
  Wrench
} from 'lucide-react';
import { scanDirectory, scanStlHome } from '../scan/scan';
import { stlHomeDirectories } from '../scan/stlHome';
import { findMenuAction } from './menu';
import { navigate, type PageId } from './routes';
import { getCurrentUser, roleAllows, type Role } from '../session';
import { openFolderSetup } from '../startup/FolderSetup';
import { runOrganize } from '../upload/inbox';

/** Run an old menu action by its label, looked up when clicked. */
const menu = (label: string) => () => {
  void findMenuAction(label)?.();
};
/** An old menu action that changes what the library shows: show the library, then run it. */
const inLibrary = (label: string) => () => {
  navigate('models');
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
  /** One line on what it is, under its name in a fly-out menu. */
  description?: string;
  /** The pages in its fly-out menu (Models: Collections, Categories, Tags, Duplicates). */
  children?: NavItem[];
  /** Old menu bar labels this item replaces. */
  replaces?: string[];
  /** The least role that sees it (default viewer). */
  role?: Role;
}

/** Scan the STL Home folders; without any, an admin chooses them (startup/FolderSetup.tsx), others scan one folder. */
export async function scanLibrary() {
  const dirs = await stlHomeDirectories().catch(() => []);
  if (dirs.length) await scanStlHome();
  else if (getCurrentUser()?.role === 'admin') openFolderSetup();
  else await scanDirectory();
}

/**
 * The sidebar, a rail of five: each name opens its page, and Models, Printing and Settings have a
 * fly-out menu with the pages under them. Printing opens Printers.
 */
export const NAV: NavItem[] = [
  { id: 'home', label: 'Home', icon: Home, page: 'home' },
  {
    id: 'models',
    label: 'Models',
    icon: Library,
    page: 'models',
    children: [
      { id: 'collections', label: 'Collections', description: 'Your saved sets of models.', icon: FolderHeart, page: 'collections' },
      { id: 'categories', label: 'Categories', description: 'A Category and Subcategory for every model.', icon: Shapes, page: 'categories' },
      {
        id: 'tags',
        label: 'Tags',
        description: 'Rename, merge and remove tags.',
        icon: Tags,
        page: 'tags',
        replaces: ['Tag Manager'],
        role: 'editor'
      },
      {
        id: 'duplicates',
        label: 'Duplicates',
        description: 'Find the same model twice.',
        icon: Copy,
        page: 'duplicates',
        replaces: ['De-Dup'],
        role: 'editor'
      }
    ]
  },
  { id: 'filament', label: 'Filament', icon: CircleDot, page: 'filament' },
  {
    id: 'printing',
    label: 'Printing',
    icon: Printer,
    page: 'printers',
    children: [
      { id: 'queue', label: 'Queue', description: 'What you print next.', icon: ListChecks, page: 'queue' },
      {
        id: 'printers',
        label: 'Printers',
        description: 'Status, AMS slots and maintenance.',
        icon: Printer,
        page: 'printers',
        replaces: ['Printer Manager']
      },
      { id: 'stats', label: 'Statistics', description: 'Prints, time and filament used.', icon: BarChart3, page: 'stats' }
    ]
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    page: 'settings',
    children: [{ id: 'history', label: 'History', description: 'What changed, and who changed it.', icon: History, page: 'history' }]
  }
];

/** The Models page's Tools menu: actions that run at once (or open their dialog). */
export const MODEL_TOOLS: NavItem[] = [
  // Runs Organize at once (upload/inbox.ts), with its settings (Settings → Scanning → Organize).
  { id: 'organize', label: 'Organize', icon: FolderTree, run: () => void runOrganize(), replaces: ['Organize Library'], role: 'editor' },
  { id: 'scan', label: 'Scan Library', icon: ScanSearch, run: () => void scanLibrary(), role: 'editor' },
  // Tags models now (tags/AiTagRunDialog.tsx); without an AI service, its settings open.
  { id: 'ai', label: 'AI Tagging', icon: Sparkles, run: open('openAiTagging'), replaces: ['AI Config'], role: 'admin' }
];

/** Every sidebar entry, the ones in fly-out menus too. */
export const navItems = (items: NavItem[] = NAV): NavItem[] => items.flatMap((item) => [item, ...(item.children ?? [])]);

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
  /** Shown beside the group in the Settings page's list. */
  icon: LucideIcon;
  items: SettingsItem[];
}

export const SETTINGS: SettingsGroup[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Brush,
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
    icon: Library,
    items: [
      {
        id: 'metadata',
        label: 'Metadata Manager',
        description: 'Rename or remove designers, licenses and titles across the library.',
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
    icon: Link2,
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
    icon: ScanSearch,
    items: [
      {
        id: 'stl-home',
        label: 'STL Home',
        description: 'The folders that hold your models.',
        icon: HardDrive,
        run: menu('STL Home'),
        replaces: ['STL Home'],
        embed: { dialog: 'stl-home-dialog', open: 'openStlHome' }
      },
      {
        id: 'organize',
        label: 'Organize',
        description: 'The scanned directory (Upload folder), the destination, the folder structure and what Organize does.',
        icon: FolderInput,
        run: open('openOrganizeSettings'),
        embed: { dialog: 'organize-settings-dialog', open: 'openOrganizeSettings' }
      },
      {
        id: 'file-types',
        label: 'File Types',
        description: 'Extra file types to scan, folders to skip, and what 3MF metadata fills in.',
        icon: Box,
        run: menu('File Type'),
        replaces: ['File Type'],
        embed: { dialog: 'file-type-settings-dialog', open: 'openFileTypeSettings' }
      },
      {
        id: 'performance',
        label: 'File Size',
        description: 'The largest file a scan adds to the library.',
        icon: Gauge,
        run: menu('Performance'),
        replaces: ['Performance'],
        embed: { dialog: 'performance-settings-dialog', open: 'openPerformanceSettings' }
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
    icon: Box,
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
    icon: Printer,
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
        id: 'filament',
        label: 'Filament',
        description: 'Your spools, how much is left, where they are, drying, and the Spoolman import.',
        icon: CircleDot,
        run: () => navigate('filament'),
        role: 'viewer'
      },
      {
        id: 'filament-settings',
        label: 'Filament settings',
        description: 'The currency, units (weight, temperature, length) and date format for spools, prices and prints.',
        icon: Coins,
        run: open('openFilamentSettings'),
        embed: { dialog: 'filament-settings-dialog', open: 'openFilamentSettings' },
        role: 'admin'
      },
      {
        id: 'alerts',
        label: 'Alerts & webhooks',
        description: 'When spools run low (rules), Discord and email for the alerts, and webhooks.',
        icon: BellRing,
        run: open('openAlertsSettings'),
        embed: { dialog: 'alerts-settings-dialog', open: 'openAlertsSettings' },
        role: 'admin'
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
    icon: Globe,
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
        id: 'catalog-sources',
        label: 'Filament catalogue',
        description: 'What Add from catalogue searches: the bundled catalogue, and SpoolmanDB when downloaded.',
        icon: BookOpen,
        run: open('openCatalogSources'),
        embed: { dialog: 'catalog-sources-dialog', open: 'openCatalogSources' },
        role: 'admin'
      },
      {
        id: 'home-assistant',
        label: 'Home Assistant',
        description: 'A sensor per spool in Home Assistant: grams left, material, color and when it runs out.',
        icon: Home,
        run: open('openHomeAssistant'),
        embed: { dialog: 'home-assistant-dialog', open: 'openHomeAssistant' },
        role: 'admin'
      },
      {
        id: 'filamenthub',
        label: 'Import from FilamentHub',
        description: 'Bring over FilamentHub’s spools, filaments, printers, prints and alerts from its database or a backup.',
        icon: Upload,
        run: open('openFilamentHubImport'),
        embed: { dialog: 'filamenthub-import-dialog', open: 'openFilamentHubImport' },
        role: 'admin'
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
    icon: Sparkles,
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
    icon: Cpu,
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
    icon: ShieldCheck,
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
        id: 'sign-in-security',
        label: 'Sign-in & security',
        description: 'Two-factor sign-in, where you are signed in, and your API keys.',
        icon: ShieldCheck,
        run: open('openSignInSecurity'),
        embed: { dialog: 'sign-in-security-dialog', open: 'openSignInSecurity' },
        role: 'viewer'
      },
      {
        id: 'my-alerts',
        label: 'My alerts',
        description: 'Which alerts reach you in the bell, by email and on Discord; quiet hours; a weekly digest.',
        icon: BellRing,
        run: open('openMyAlerts'),
        embed: { dialog: 'my-alerts-dialog', open: 'openMyAlerts' },
        role: 'viewer'
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
    icon: Archive,
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
    icon: Wrench,
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
    icon: Info,
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
  { id: 'whats-new', label: "What's New", description: 'The changes in this version.', icon: Gift, run: open('openWhatsNew') },
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

const allowed = (role: string | null | undefined) => (item: NavItem) => roleAllows(role, item.role || 'viewer');

/** Sidebar entries the user's role may use (none before anyone logs in). */
export const navFor = (role: string | null | undefined): NavItem[] =>
  role ? NAV.filter(allowed(role)).map((item) => (item.children ? { ...item, children: item.children.filter(allowed(role)) } : item)) : [];

/** The Models page's tools the user's role may use. */
export const toolsFor = (role: string | null | undefined): NavItem[] => (role ? MODEL_TOOLS.filter(allowed(role)) : []);

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
  navItems().forEach(add);
  MODEL_TOOLS.forEach(add);
  SETTINGS.forEach((group) => group.items.forEach(add));
  HELP.forEach(add);
  ACCOUNT.forEach(add);
  return labels;
}
