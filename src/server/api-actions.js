'use strict';

/**
 * The actions browsers may call over the HTTP API (`POST /api/actions/<name>`), with the
 * arguments each one takes, by position. Anything not listed here is refused, even when an
 * IPC handler of that name exists (MCP and the server call those directly).
 *
 * Argument kinds: string, number, boolean, object (not an array), array, id (number or
 * string), any. A trailing `?` means the argument may be left out or null.
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

  // Filament, parts, printers, print history
  'get-all-filaments': [],
  'save-filament': ['object'],
  'delete-filament': ['id'],
  'get-model-filaments': ['id?'],
  'test-spoolman-connection': ['string?', 'string?'],
  'sync-spoolman-filaments': ['string?', 'string?'],
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
  'export-library': [],
  'import-library': ['object?'],

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
  'get-gpu-info': [],
  'benchmark-filesystem': [],
  'benchmark-database': []
};

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

module.exports = { ACTIONS, assertActionArgs, isAction };
