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
  'get-model': ['string'],
  'save-model': ['object'],
  'save-model-batch': ['array'],
  'update-models-batch': ['array'],
  'get-designers': [],
  'get-licenses': [],
  'get-all-models': ['string?', 'number?'],
  'get-models-filtered': ['object?'],
  'get-parent-models': [],
  'get-additional-file-types-catalog': [],
  'get-model-count-by-file-type-ids': ['array'],
  'remove-models-by-file-type-ids': ['array'],
  'clear-new-model-flags': [],
  getTotalModelCount: [],
  'get-folder-tree': [],
  'get-all-model-references': [],

  // Uploads (the files arrive on POST /api/upload, src/server/uploads.js)
  'get-upload-info': [],
  'add-uploaded-files': ['string', 'array?'],

  // Scanning and library folders
  'load-directory': [],
  'save-directory': ['string'],
  'browse-folders': ['string?'],
  'scan-directory': ['string', 'object?'],

  // Files
  'trash-file': ['string'],
  'delete-file': ['string'],
  'purge-models': ['object?'],
  'move-files': ['array', 'string'],
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
  'report-server-thumbnail-progress': ['object?'],
  'report-server-thumbnail-complete': ['object?'],
  'report-server-thumbnail-error': ['object?'],

  // Tags and metadata
  'get-all-tags': [],
  'save-tag': ['string'],
  'rename-tag': ['id', 'string'],
  'delete-tag': ['id'],
  'get-model-tags': ['id?'],
  'get-group-tags': ['array'],
  'get-all-metadata': [],
  'rename-metadata': ['string', 'string', 'string'],
  'delete-metadata': ['string', 'string'],
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

  // AI tagging, web pages, system report
  'test-ai-config': ['string?', 'string?', 'string?', 'string?'],
  'get-default-ai-prompt': [],
  'fetch-thangs-page': ['string'],
  'get-stats': [],
  'get-library-storage': [],
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
  'get-model', 'get-designers', 'get-licenses', 'get-all-models', 'get-models-filtered', 'get-parent-models',
  'get-additional-file-types-catalog', 'get-model-count-by-file-type-ids', 'getTotalModelCount', 'get-folder-tree',
  'get-all-model-references', 'load-directory', 'extract-model-from-zip', 'delete-temp-file', 'get-file-stats',
  'get3MFImages', 'getLYSImages', 'getF3DImages', 'getChituboxImages', 'getVoxlImages', 'get3MFSTL', 'read-model-file',
  'parse-3mf-preview', 'cancel-3mf-preview', 'getThumbnail', 'get-all-thumbnails', 'get-server-thumbnail-job-status',
  'get-all-tags', 'get-model-tags', 'get-group-tags', 'get-all-metadata', 'get-duplicates', 'is-generating-hashes',
  'getModelsWithoutHash', 'show-context-menu', 'execute-context-menu-action',
  'get-all-parts', 'get-all-printers', 'get-printer-maintenance-logs', 'get-printer-reminders', 'get-print-events',
  'get-slicers', 'open-file-in-slicer', 'get-upload-info',
  // Each user changes their own password.
  'set-server-password',
  // Settings: non-admins read only what is not secret, and save only display preferences (ipc/settings.js).
  'get-setting', 'save-setting', 'get-app-version', 'check-for-updates', 'open-update-page',
  'get-stats', 'get-library-storage', 'get-library-counts', 'get-recent-activity', 'get-recent-prints', 'get-print-statistics',
  // The thumbnail renderer reads the GPU backend in every browser.
  'get-gpu-info',
  'get-collections', 'get-collection', 'get-collection-membership'
]);

/** Actions that change the library: editors and admins. */
const EDITOR_ACTIONS = new Set([
  'save-model', 'save-model-batch', 'update-models-batch', 'clear-new-model-flags', 'add-uploaded-files',
  'browse-folders', 'scan-directory', 'save-directory', 'trash-file', 'delete-file', 'move-files', 'calculate-file-hash',
  'save-thumbnail', 'add-thumbnail', 'add-multiple-thumbnails', 'set-default-thumbnail', 'delete-thumbnail',
  'get-models-without-thumbnails', 'get-models-with-default-thumbnails', 'start-server-thumbnail-job', 'cancel-server-thumbnail-job',
  'save-tag', 'rename-tag', 'delete-tag', 'rename-metadata', 'delete-metadata', 'pull-3mf-metadata', 'generateMissingHashes',
  'save-part', 'delete-part', 'save-printer', 'delete-printer',
  'save-printer-maintenance-log', 'delete-printer-maintenance-log', 'save-printer-reminder', 'delete-printer-reminder',
  'complete-printer-reminder', 'log-print-event', 'log-print-events-batch', 'delete-print-event', 'set-print-status',
  'set-print-status-batch', 'fetch-thangs-page',
  'create-collection', 'update-collection', 'delete-collection', 'add-to-collection', 'remove-from-collection',
  'create-share-link', 'get-share-links', 'revoke-share-link'
]);

/** The least role an action needs: viewer, editor or admin. */
function requiredRole(name) {
  if (VIEWER_ACTIONS.has(name)) return 'viewer';
  if (EDITOR_ACTIONS.has(name)) return 'editor';
  return 'admin';
}

function matchesKind(kind, value) {
  switch (kind) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'id': return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value !== '');
    case 'any': return true;
    default: throw new Error(`Unknown argument kind: ${kind}`);
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
    if (!matchesKind(kind, value)) throw new Error(`${name}: argument ${index + 1} must be ${kind === 'id' ? 'an id' : `a${/^[aeiou]/.test(kind) ? 'n' : ''} ${kind}`}`);
  });
}

function isAction(name) {
  return Object.prototype.hasOwnProperty.call(ACTIONS, name);
}

module.exports = { ACTIONS, VIEWER_ACTIONS, EDITOR_ACTIONS, assertActionArgs, isAction, requiredRole };
