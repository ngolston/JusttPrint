'use strict';

/**
 * The actions browsers may call over the HTTP API (`POST /api/actions/<name>`), with the
 * arguments each one takes, by position. Anything not listed here is refused, even when an
 * IPC handler of that name exists (MCP and the server call those directly).
 *
 * Argument kinds: string, number, boolean, object (not an array), array, id (number or
 * string), any. A trailing `?` means the argument may be left out or null.
 *
 * Each action also needs a role (users.js): VIEWER_ACTIONS only read, EDITOR_ACTIONS change
 * the library, and everything else (settings, server, backups, accounts) needs an admin.
 */
const ACTIONS = {
  // Models
  'get-model': ['string', 'object?'],
  'get-model-pictures': ['string'],
  'get-folder': ['string'],
  'get-model-history': ['string'],
  'get-all-history': ['object?'],
  'replace-model-file': ['string', 'string', 'string?'],
  'restore-model-version': ['number'],
  'delete-model-version': ['number'],
  'download-model-version': ['number'],
  'get-versions-usage': [],
  'set-versions-keep': ['number'],
  'undo-model-change': ['number'],
  'undo-detail-change': ['number'],
  'get-assembly': ['string'],
  'save-assembly': ['string', 'object?'],
  'get-kit': ['string'],
  'set-kit-part': ['string', 'number', 'boolean'],
  'get-kit-summaries': ['array'],
  'get-kits-in-progress': ['object?'],
  'save-folder-notes': ['string', 'string'],
  'make-model-folder': ['string', 'string'],
  'register-model-folder': ['string'],
  'model-own-folder': ['string'],
  'get-model-media': ['string'],
  'get-background-activity': [],
  'set-model-cover': ['string', 'string?'],
  'remove-model-media': ['string', 'string', 'string'],
  'add-model-youtube': ['string', 'any'],
  'remove-model-youtube': ['string', 'string'],
  'tidy-model-folders-preview': ['string?'],
  'tidy-model-folders': ['string?', 'array?', 'boolean?'],
  'search-by-meaning': ['string'],
  'translate-notes': ['string'],
  'search-by-photo': ['string'],
  'look-alike-models': ['string'],
  'get-folder-models': ['string'],
  'save-model': ['object'],
  'save-model-batch': ['array'],
  'update-models-batch': ['array'],
  'get-designers': [],
  'get-filter-facets': [],
  'get-licenses': [],
  'get-all-models': ['string?', 'number?'],
  'get-models-filtered': ['object?'],
  'get-titles': [],
  'get-additional-file-types-catalog': [],
  'get-model-count-by-file-type-ids': ['array'],
  'remove-models-by-file-type-ids': ['array'],
  'clear-new-model-flags': [],
  getTotalModelCount: [],
  'get-folder-tree': [],
  'get-all-model-references': [],

  // Uploads (the files arrive on POST /api/upload, src/server/uploads.js)
  'get-upload-info': [],
  'add-uploaded-files': ['string', 'array?', 'string?'],
  // Parts of a model (core/models.js setModelParts).
  'set-model-parts': ['string?', 'array'],
  // The Upload folder and Organize Uploads (ipc/upload-inbox.js)
  'get-upload-folder': [],
  'save-upload-folder': ['string', 'string', 'object?'],
  'organize-uploads': ['object?'],
  'get-organize-uploads': [],
  'stop-organize-uploads': [],

  // Bulk import from Printables, Thingiverse and MakerWorld links (ipc/link-import.js)
  'check-model-links': ['string'],
  'list-model-links': ['string', 'object?'],
  'import-model-link': ['string', 'object?'],
  'list-site-files': ['string'],
  'site-download-files': ['object'],
  'thingiverse-token-status': [],
  'set-thingiverse-token': ['string'],

  // MakerWorld details, sign-in and downloads (ipc/makerworld.js)
  'get-site-details': ['string', 'boolean?'],
  'makerworld-account-status': [],
  'makerworld-sign-in': ['object'],
  'makerworld-sign-out': [],
  'google-translate-status': [],
  'set-google-translate-key': ['string'],
  'makerworld-download': ['object'],
  'save-site-edits': ['string', 'object?'],
  'get-geometry-duplicates': ['object?'],
  'start-geometry-scan': ['object?'],
  'get-geometry-scan': [],
  'stop-geometry-scan': [],
  'makerworld-check-folder': ['string'],
  'makerworld-prepare-folder': ['object'],
  'makerworld-add-files': ['object'],

  // Scanning and library folders
  'load-directory': [],
  'save-directory': ['string'],
  'browse-folders': ['string?'],
  'scan-directory': ['string', 'object?'],
  'remove-missing-models': ['string', 'object?'],

  // Files
  'trash-file': ['string'],
  'delete-models': ['array', 'string'],
  'delete-file': ['string'],
  'purge-models': ['object?'],
  'move-files': ['array', 'string'],
  'rename-model': ['string', 'string'],
  'extract-model-from-zip': ['string'],
  'delete-temp-file': ['string'],
  'get-file-stats': ['string'],

  // Previews
  get3MFImages: ['string', 'object?'],
  getLYSImages: ['string', 'object?'],
  getF3DImages: ['string', 'object?'],
  getChituboxImages: ['string', 'object?'],
  getVoxlImages: ['string', 'object?'],
  get3MFSTL: ['string'],
  'read-model-file': ['string'],
  'parse-3mf-preview': ['string', 'any?'],
  'cancel-3mf-preview': ['any?'],

  // Thumbnails
  getThumbnail: ['string'],
  'get-all-thumbnails': ['string'],
  'save-thumbnail': ['string', 'string'],
  'add-thumbnail': ['string', 'string'],
  'add-multiple-thumbnails': ['string', 'array'],
  'set-default-thumbnail': ['string', 'any'],
  'delete-thumbnail': ['string', 'any'],
  'purge-thumbnails': [],
  'get-models-without-thumbnails': [],
  'get-models-with-default-thumbnails': [],
  'start-server-thumbnail-job': ['object?'],
  'cancel-server-thumbnail-job': [],
  'get-server-thumbnail-job-status': [],
  'get-ai-tag-job': [],
  'stop-ai-tag-job': [],
  'dismiss-ai-tag-job': ['number?'],
  'report-server-thumbnail-progress': ['object?'],
  'report-server-thumbnail-complete': ['object?'],
  'report-server-thumbnail-error': ['object?'],

  // Tags and metadata
  'get-all-tags': [],

  // Categories (ipc/categories.js)
  'get-categories': [],
  'update-category': ['number', 'object'],
  'set-models-category': ['array', 'string'],
  'set-model-categories': ['string', 'array', 'string?'],
  'start-category-scan': ['object?'],
  'get-category-scan': [],
  'stop-category-scan': [],
  'dismiss-category-scan': [],
  'save-tag': ['string'],
  'rename-tag': ['id', 'string'],
  'delete-tag': ['id'],
  'restore-tag': ['object'],
  'get-model-tags': ['id?'],
  'get-group-tags': ['array'],
  'get-all-metadata': [],
  // Notifications (notifications.js): the caller's list, and how far they have read.
  'get-notifications': ['object?'],
  'mark-notifications-read': ['number'],
  'clear-notifications': ['number'],
  'rename-metadata': ['string', 'string', 'string'],
  'delete-metadata': ['string', 'string'],
  'restore-metadata': ['object'],
  'pull-3mf-metadata': ['array'],

  // Duplicates and hashes
  'get-duplicates': ['any?'],
  'is-generating-hashes': [],
  getModelsWithoutHash: ['object?'],
  generateMissingHashes: ['object?'],
  'calculate-file-hash': ['string'],

  // Context menu
  'show-context-menu': ['any'],
  'execute-context-menu-action': ['any', 'any', 'any?'],

  // Organize
  'list-organize-sources': [],
  'organize-library-preview': ['object'],
  'organize-library-run': ['object'],

  // Parts, printers, print history
  'get-all-parts': [],
  'save-part': ['object'],
  'delete-part': ['id'],
  // Filament (Phase 3 of docs/merge-10.md)
  'get-spools': ['object?'],
  'get-spool': ['id'],
  'get-filament-summary': [],
  'save-spool': ['object'],
  'weigh-spool': ['id', 'object'],
  'move-spool': ['id', 'id?'],
  'archive-spool': ['id', 'boolean?'],
  'delete-spool': ['id'],
  'import-spoolman': ['any'],
  'get-filament-brands': [],
  'get-filament-profiles': ['object?'],
  'save-filament-profile': ['object'],
  'delete-filament-profile': ['id'],
  'search-filament-catalog': ['string', 'object?'],
  'add-catalog-filament': ['string'],
  'get-storage-locations': [],
  'save-storage-location': ['object'],
  'delete-storage-location': ['id'],
  'get-drying-sessions': [],
  'get-model-filament': ['string', 'object?'],
  'get-printer-loads': ['id?'],
  'get-print-queue': [],
  'get-month-summary': [],
  'get-reorder-list': [],
  'check-low-stock': [],
  'get-low-stock-rules': [],
  'save-low-stock-rule': ['object'],
  'delete-low-stock-rule': ['id'],
  'get-alert-delivery': [],
  'save-alert-delivery': ['object'],
  'test-alert-delivery': ['string'],
  'get-webhooks': [],
  'save-webhook': ['object'],
  'delete-webhook': ['id'],
  'test-webhook': ['id'],
  'add-to-queue': ['string', 'object?'],
  'update-queue-item': ['id', 'object'],
  'move-queue-item': ['id', 'number'],
  'remove-from-queue': ['id'],
  'start-queue-item': ['id'],
  'add-ams-unit': ['id', 'object?'],
  'update-ams-unit': ['id', 'object'],
  'delete-ams-unit': ['id'],
  'set-loaded-spool': ['object', 'id?'],
  'list-bambu-printers': [],
  'import-bambu-printers': [],
  'read-plate-filaments': [],
  'start-drying': ['id', 'object?'],
  'finish-drying': ['id', 'object?'],
  'get-all-printers': [],
  'save-printer': ['object'],
  'delete-printer': ['id'],
  'get-printer-maintenance-logs': ['id?'],
  'save-printer-maintenance-log': ['object'],
  'delete-printer-maintenance-log': ['id'],
  'get-printer-reminders': ['id?'],
  'save-printer-reminder': ['object'],
  'delete-printer-reminder': ['id'],
  'complete-printer-reminder': ['object'],
  'get-print-events': ['id?'],
  'log-print-event': ['object'],
  'log-print-events-batch': ['object'],
  'delete-print-event': ['id'],
  'set-print-status': ['object'],
  'set-print-status-batch': ['object'],

  // Slicers
  'get-slicers': [],
  'save-slicer': ['object'],
  'delete-slicer': ['id'],
  'clear-and-save-slicers': ['array'],
  'open-file-in-slicer': ['object?'],

  // Backup
  'backup-database': [],
  'restore-database': ['object?'],
  'get-auto-backup': [],
  'get-leftover-downloads': [],
  'delete-leftover-downloads': [],
  'get-folder-watch-status': [],
  'save-auto-backup': ['object'],
  'run-auto-backup': [],
  'restore-auto-backup': ['string'],
  'export-library': [],
  'import-library': ['object?'],

  // Collections and share links
  'get-collections': [],
  'get-collection': ['id'],
  'get-collection-membership': ['array'],
  'create-collection': ['object'],
  'update-collection': ['id', 'object'],
  'delete-collection': ['id'],
  'add-to-collection': ['id', 'array'],
  'remove-from-collection': ['id', 'array'],
  'create-share-link': ['object'],
  'get-share-links': ['object?'],
  'revoke-share-link': ['string'],

  // User accounts
  'list-users': [],
  'create-user': ['object'],
  'update-user': ['id', 'object'],
  'delete-user': ['id'],

  // Settings, server access, updates
  'get-setting': ['string'],
  'save-setting': ['string', 'any'],
  'get-app-version': [],
  'get-server-access-info': [],
  'set-server-password': ['string?', 'string'],
  'regenerate-server-api-token': [],
  'restart-server': [],
  'get-tls-status': [],
  'apply-tls-settings': ['object?'],
  'generate-self-signed-cert': ['object?'],
  'get-mcp-connection-info': [],
  'check-for-updates': ['any?'],
  'open-update-page': ['any?'],

  // AI tagging, system report
  'test-ai-config': ['string?', 'string?', 'string?', 'string?'],
  // The caller's own Puter.com sign-in (ipc/settings.js).
  'get-puter-login': [],
  'save-puter-login': ['string?'],
  'get-default-ai-prompt': [],
  'get-stats': [],
  'get-library-storage': [],
  'get-library-attention': [],
  'get-library-counts': [],
  'get-recent-activity': ['number?'],
  'get-recent-prints': ['number?', 'string?', 'number?'],
  'get-print-statistics': ['object?'],
  'get-gpu-info': [],
  'benchmark-filesystem': [],
  'benchmark-database': []
};

/** Actions that only read: every logged-in user. */
const VIEWER_ACTIONS = new Set([
  'translate-notes',
  'search-by-meaning',
  'search-by-photo',
  'look-alike-models',
  'get-categories',
  'get-folder',
  'get-model-media',
  'get-background-activity',
  'get-model-history',
  'get-all-history',
  'download-model-version',
  'get-assembly',
  'get-kit',
  'get-kit-summaries',
  'get-kits-in-progress',
  'get-folder-models',
  'get-notifications',
  'mark-notifications-read',
  'clear-notifications',
  'get-model-pictures',
  'get-model',
  'get-designers',
  'get-filter-facets',
  'get-licenses',
  'get-all-models',
  'get-models-filtered',
  'get-titles',
  'get-additional-file-types-catalog',
  'get-model-count-by-file-type-ids',
  'getTotalModelCount',
  'get-folder-tree',
  'get-all-model-references',
  'load-directory',
  'extract-model-from-zip',
  'delete-temp-file',
  'get-file-stats',
  'get3MFImages',
  'getLYSImages',
  'getF3DImages',
  'getChituboxImages',
  'getVoxlImages',
  'get3MFSTL',
  'read-model-file',
  'parse-3mf-preview',
  'cancel-3mf-preview',
  'getThumbnail',
  'get-all-thumbnails',
  'get-server-thumbnail-job-status',
  'get-ai-tag-job',
  'get-all-tags',
  'get-model-tags',
  'get-group-tags',
  'get-all-metadata',
  'get-duplicates',
  'is-generating-hashes',
  'getModelsWithoutHash',
  'show-context-menu',
  'execute-context-menu-action',
  'get-all-parts',
  'get-all-printers',
  'get-spools',
  'get-spool',
  'get-filament-summary',
  'get-filament-brands',
  'get-filament-profiles',
  'search-filament-catalog',
  'get-storage-locations',
  'get-drying-sessions',
  'get-model-filament',
  'get-printer-loads',
  'get-print-queue',
  'get-month-summary',
  'get-reorder-list',
  'get-low-stock-rules',
  'get-printer-maintenance-logs',
  'get-printer-reminders',
  'get-print-events',
  'get-slicers',
  'open-file-in-slicer',
  'get-upload-info',
  'get-upload-folder',
  'get-organize-uploads',
  // Each user changes their own password.
  'set-server-password',
  // Settings: non-admins read only what is not secret, and save only display preferences (ipc/settings.js).
  'get-setting',
  'save-setting',
  // Each account keeps its own Puter.com sign-in.
  'get-puter-login',
  'save-puter-login',
  'get-app-version',
  'check-for-updates',
  'open-update-page',
  'get-stats',
  'get-library-storage',
  'get-library-attention',
  'get-library-counts',
  'get-recent-activity',
  'get-recent-prints',
  'get-print-statistics',
  // The thumbnail renderer reads the GPU backend in every browser.
  'get-gpu-info',
  'get-collections',
  'get-collection',
  'get-collection-membership',
  'get-site-details',
  'get-geometry-duplicates',
  'get-geometry-scan'
]);

/** Actions that change the library: editors and admins. */
const EDITOR_ACTIONS = new Set([
  'save-model',
  'save-model-batch',
  'update-models-batch',
  'clear-new-model-flags',
  'add-uploaded-files',
  'set-model-parts',
  'organize-uploads',
  'stop-organize-uploads',
  'start-geometry-scan',
  'stop-geometry-scan',
  'check-model-links',
  'list-model-links',
  'import-model-link',
  'list-site-files',
  'site-download-files',
  'thingiverse-token-status',
  'makerworld-account-status',
  'makerworld-sign-in',
  'makerworld-sign-out',
  'makerworld-download',
  'save-site-edits',
  'makerworld-check-folder',
  'makerworld-prepare-folder',
  'makerworld-add-files',
  'browse-folders',
  'scan-directory',
  'remove-missing-models',
  'save-directory',
  'trash-file',
  'delete-models',
  'delete-file',
  'move-files',
  'rename-model',
  'save-folder-notes',
  'make-model-folder',
  'register-model-folder',
  'model-own-folder',
  'set-model-cover',
  'remove-model-media',
  'add-model-youtube',
  'remove-model-youtube',
  'save-assembly',
  'replace-model-file',
  'restore-model-version',
  'delete-model-version',
  'undo-detail-change',
  'undo-model-change',
  'set-kit-part',
  'update-category',
  'set-models-category',
  'set-model-categories',
  'start-category-scan',
  'get-category-scan',
  'stop-category-scan',
  'dismiss-category-scan',
  'calculate-file-hash',
  'save-thumbnail',
  'add-thumbnail',
  'add-multiple-thumbnails',
  'set-default-thumbnail',
  'delete-thumbnail',
  'get-models-without-thumbnails',
  'get-models-with-default-thumbnails',
  'start-server-thumbnail-job',
  'cancel-server-thumbnail-job',
  'stop-ai-tag-job',
  'dismiss-ai-tag-job',
  'save-tag',
  'rename-tag',
  'delete-tag',
  'restore-tag',
  'rename-metadata',
  'delete-metadata',
  'restore-metadata',
  'pull-3mf-metadata',
  'generateMissingHashes',
  'save-part',
  'delete-part',
  'save-printer',
  'save-spool',
  'weigh-spool',
  'move-spool',
  'archive-spool',
  'delete-spool',
  'import-spoolman',
  'save-filament-profile',
  'delete-filament-profile',
  'add-catalog-filament',
  'save-storage-location',
  'delete-storage-location',
  'start-drying',
  'finish-drying',
  'read-plate-filaments',
  'add-ams-unit',
  'update-ams-unit',
  'delete-ams-unit',
  'set-loaded-spool',
  'check-low-stock',
  'add-to-queue',
  'update-queue-item',
  'move-queue-item',
  'remove-from-queue',
  'start-queue-item',
  'delete-printer',
  'save-printer-maintenance-log',
  'delete-printer-maintenance-log',
  'save-printer-reminder',
  'delete-printer-reminder',
  'complete-printer-reminder',
  'log-print-event',
  'log-print-events-batch',
  'delete-print-event',
  'set-print-status',
  'set-print-status-batch',
  'create-collection',
  'update-collection',
  'delete-collection',
  'add-to-collection',
  'remove-from-collection',
  'create-share-link',
  'get-share-links',
  'revoke-share-link'
]);

/** The least role an action needs: viewer, editor or admin. */
function requiredRole(name) {
  if (VIEWER_ACTIONS.has(name)) return 'viewer';
  if (EDITOR_ACTIONS.has(name)) return 'editor';
  return 'admin';
}

function matchesKind(kind, value) {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'id':
      return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value !== '');
    case 'any':
      return true;
    default:
      throw new Error(`Unknown argument kind: ${kind}`);
  }
}

/** Throws when the arguments do not fit the action's list. */
function assertActionArgs(name, args) {
  const spec = ACTIONS[name];
  if (!spec) throw new Error(`Unknown action: ${name}`);
  if (!Array.isArray(args)) throw new Error('args must be an array');
  if (args.length > spec.length) {
    throw new Error(`${name} takes at most ${spec.length} argument(s), got ${args.length}`);
  }
  spec.forEach((entry, index) => {
    const optional = entry.endsWith('?');
    const kind = optional ? entry.slice(0, -1) : entry;
    const value = args[index];
    if (value === undefined || value === null) {
      if (!optional) throw new Error(`${name}: argument ${index + 1} is required (${kind})`);
      return;
    }
    if (!matchesKind(kind, value))
      throw new Error(`${name}: argument ${index + 1} must be ${kind === 'id' ? 'an id' : `a${/^[aeiou]/.test(kind) ? 'n' : ''} ${kind}`}`);
  });
}

function isAction(name) {
  return Object.prototype.hasOwnProperty.call(ACTIONS, name);
}

module.exports = { ACTIONS, VIEWER_ACTIONS, EDITOR_ACTIONS, assertActionArgs, isAction, requiredRole };
