/**
 * JusttPrint MCP (Model Context Protocol) server.
 * Streamable HTTP JSON-RPC at POST /mcp so local AI agents can search the library,
 * manage tags/print history, update metadata, and write thumbnails
 * while JusttPrint is running.
 */
'use strict';

const crypto = require('crypto');

const MCP_PROTOCOL_VERSION = '2025-03-26';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const SERVER_NAME = 'justtprint';

const TOOL_DEFINITIONS = [
  {
    name: 'search_models',
    description: 'Search and filter the JusttPrint library. Returns model metadata without thumbnail image data. Use get_model for full details.',
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description:
            'Free-text search across name, designer, tags, path, source, and license. Notes are included unless the app setting searchIncludeNotes is off.'
        },
        designer: { type: 'string', description: 'Filter by designer name' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to models that have these tags'
        },
        directory: { type: 'string', description: 'Filter to models under this directory path' },
        fileType: { type: 'string', description: 'File type filter such as stl, 3mf, zip, obj, step' },
        printed: {
          type: 'string',
          description:
            'Print status filter (unprinted, printed, want, queued, printing, failed, ever-printed, never-printed, in-queue (queued or printing), or all)'
        },
        limit: { type: 'integer', description: 'Max results (default 50, max 500)' },
        offset: { type: 'integer', description: 'Result offset for pagination' }
      }
    }
  },
  {
    name: 'get_model',
    description: 'Get full details for one model by id or filePath, including tags. Thumbnail images are omitted unless includeThumbnails is true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Model database id' },
        filePath: { type: 'string', description: 'Exact file path stored in the library' },
        includeThumbnails: { type: 'boolean', description: 'Include thumbnail data URLs (can be large). Default false.' }
      }
    }
  },
  {
    name: 'update_model',
    description:
      'Update metadata for an existing library model. Provide id or filePath plus the fields to change. Tags replace the current tag set when provided.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' },
        designer: { type: 'string' },
        source: { type: 'string', description: 'Source URL or origin' },
        notes: { type: 'string', description: 'Your own notes about the model' },
        description: { type: 'string', description: "What the model is (the site's or the 3MF's description)" },
        license: { type: 'string' },
        title: { type: 'string', description: "The model's Title (shown instead of its file name)" },
        printStatus: { type: 'string', description: 'unprinted, want, queued, printing, printed, failed' },
        rating: { type: 'integer', description: '0-5' },
        favorite: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replacement tag list' }
      }
    }
  },
  {
    name: 'get_library_stats',
    description: 'Return library totals: model counts, file types, disk usage, and tag stats.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_folder_tree',
    description: 'Return the folder tree derived from scanned model paths.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_tags',
    description: 'List all tags with how many models use each tag.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'add_tag',
    description: 'Create a tag if it does not already exist. Returns the tag id and name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tag name' }
      },
      required: ['name']
    }
  },
  {
    name: 'rename_tag',
    description: 'Rename a tag by id or current name. If the new name already exists, model links are merged onto that tag and the old tag is removed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Tag id' },
        name: { type: 'string', description: 'Current tag name' },
        newName: { type: 'string', description: 'New tag name' }
      },
      required: ['newName']
    }
  },
  {
    name: 'delete_tag',
    description: 'Delete a tag by id or name and unlink it from all models. Use list_tags first to confirm the tag and its model_count.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Tag id' },
        name: { type: 'string', description: 'Tag name' }
      }
    }
  },
  {
    name: 'add_model_tags',
    description: 'Add tags to a model without removing existing tags. Creates tags that do not already exist.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag names to add' }
      },
      required: ['tags']
    }
  },
  {
    name: 'remove_model_tags',
    description: 'Remove specific tags from a model. The tags themselves remain in the library.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag names to remove' }
      },
      required: ['tags']
    }
  },
  {
    name: 'get_print_events',
    description: 'List print history events for a model.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' }
      }
    }
  },
  {
    name: 'log_print_event',
    description: 'Record a print outcome for a model (printed, failed, or cancelled).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' },
        outcome: { type: 'string', description: 'printed, failed, or cancelled' },
        quantity: { type: 'integer', description: 'Number of copies (default 1)' },
        printedAt: { type: 'string', description: 'ISO datetime; defaults to now' },
        notes: { type: 'string' },
        printerId: { type: 'integer', description: 'The printer it was printed on' },
        plateIndex: { type: 'integer', description: 'The plate printed (from 1), when only one' },
        spools: {
          type: 'array',
          description: 'Filament taken off spools: { spoolId, grams } (grams for all copies). See list_spools.',
          items: { type: 'object', properties: { spoolId: { type: 'integer' }, grams: { type: 'number' } }, required: ['spoolId', 'grams'] }
        },
        parts: {
          type: 'array',
          description: 'Parts removed from stock. Each item is { id, quantity } where quantity is per copy.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              quantity: { type: 'integer' }
            },
            required: ['id']
          }
        }
      },
      required: ['outcome']
    }
  },
  {
    name: 'list_spools',
    description: 'The filament spools on hand: material, color, grams left, where each is (a place, or loaded in a printer), drying.',
    inputSchema: { type: 'object', properties: { includeArchived: { type: 'boolean', description: 'Also used-up (archived) spools' } } }
  },
  {
    name: 'get_spool',
    description: 'One spool with its weighings and drying sessions.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] }
  },
  {
    name: 'weigh_spool',
    description: 'Record what the scale shows for a spool; sets the grams left.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        weight: { type: 'number', description: 'Grams the scale shows' },
        withSpool: { type: 'boolean', description: 'Weighed on its spool (default true; needs the empty spool weight)' },
        notes: { type: 'string' }
      },
      required: ['id', 'weight']
    }
  },
  {
    name: 'check_model_filament',
    description:
      'Whether the spools on hand can print a model: for each color it needs (from its 3MF), the matching spool, grams left after or short. Optionally one plate or several, and a printer whose loaded spools come first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' },
        plate: { type: 'integer' },
        plates: { type: 'array', items: { type: 'integer' } },
        printerId: { type: 'integer' }
      }
    }
  },
  {
    name: 'what_can_i_print',
    description: 'Models the spools on hand can print now. With printerId: only what that printer has loaded covers, without swapping spools.',
    inputSchema: { type: 'object', properties: { printerId: { type: 'integer' }, limit: { type: 'integer', description: 'Default 50, at most 500' } } }
  },
  {
    name: 'get_reorder_list',
    description: 'Spools running low (by the low-stock rules), most urgent first, with where they were bought.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_print_queue',
    description: 'The print queue in order: each model, plate, printer, and whether the spools cover it (counting earlier items).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'add_to_queue',
    description: 'Add a model (all plates, or one) to the end of the print queue.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer' }, filePath: { type: 'string' }, plate: { type: 'integer' }, printerId: { type: 'integer' } }
    }
  },
  {
    name: 'get_filament_stats',
    description: 'Filament used by logged prints and its cost (at each spool price), per month, model, printer and material.',
    inputSchema: { type: 'object', properties: { months: { type: 'integer', description: 'Months to cover, ending this month (default 12); 0 for all time' } } }
  },
  {
    name: 'delete_print_event',
    description: 'Delete one print history event by its event id.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'integer' }
      },
      required: ['eventId']
    }
  },
  {
    name: 'list_titles',
    description: 'List the distinct model Titles in the library.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'rename_metadata',
    description: 'Rename a designer, title, or license value across all models. Merges if the new name already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'designer, title, or license' },
        oldName: { type: 'string' },
        newName: { type: 'string' }
      },
      required: ['type', 'oldName', 'newName']
    }
  },
  {
    name: 'delete_metadata',
    description: 'Clear a designer, title, or license value from all models that use it.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'designer, title, or license' },
        name: { type: 'string' }
      },
      required: ['type', 'name']
    }
  },
  {
    name: 'list_designers',
    description: 'List distinct designer names in the library.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_licenses',
    description: 'List distinct license values in the library.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_models_missing_thumbnails',
    description: 'List models that have no custom thumbnail. Use filePath to open the model file locally, generate an image, then call set_thumbnail.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max results (default 50, max 500)' }
      }
    }
  },
  {
    name: 'get_thumbnails',
    description: 'Return thumbnail data URLs for a model (primary first).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' }
      }
    }
  },
  {
    name: 'set_thumbnail',
    description:
      'Replace the primary thumbnail for a model. Pass a PNG or JPEG as a data URL (data:image/...) or raw base64. Intended for local AI agents that render thumbnails outside JusttPrint.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' },
        image: { type: 'string', description: 'Image data URL or raw base64' },
        mimeType: { type: 'string', description: 'Used when image is raw base64. Default image/png.' }
      },
      required: ['image']
    }
  },
  {
    name: 'add_thumbnail',
    description: 'Append a thumbnail and make it the default. Same image format as set_thumbnail.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' },
        image: { type: 'string', description: 'Image data URL or raw base64' },
        mimeType: { type: 'string', description: 'Used when image is raw base64. Default image/png.' }
      },
      required: ['image']
    }
  },
  {
    name: 'set_default_thumbnail',
    description: 'Set which thumbnail is the default by 0-based index from get_thumbnails.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' },
        index: { type: 'integer', description: '0-based thumbnail index' }
      },
      required: ['index']
    }
  },
  {
    name: 'delete_thumbnail',
    description: 'Delete a non-default thumbnail by 0-based index. Cannot delete the active (index 0) thumbnail or the last remaining thumbnail.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' },
        index: { type: 'integer', description: '0-based thumbnail index' }
      },
      required: ['index']
    }
  },
  {
    name: 'get_model_media',
    description:
      "A model folder's pictures, videos and documents (each { name, size }), its YouTube videos and which picture is the cover. Give a model (id or filePath) or the folder. Only model folders (a folder of its own per model) have media.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'A model in the folder' },
        filePath: { type: 'string', description: 'A model file in the folder' },
        folder: { type: 'string', description: 'The model folder itself' }
      }
    }
  },
  {
    name: 'add_model_media',
    description:
      "Add a picture, video or document to a model's folder (into image/, video/ or document/ by its extension). Give either url (downloaded) or data (base64 or a data URL) with name. A taken name gets a number. The first picture becomes the cover.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'A model in the folder' },
        filePath: { type: 'string', description: 'A model file in the folder' },
        folder: { type: 'string', description: 'The model folder itself' },
        url: { type: 'string', description: 'An https link to download' },
        data: { type: 'string', description: 'The file contents: base64 or a data URL' },
        name: { type: 'string', description: 'File name with extension (required with data; with url, taken from the link when missing)' }
      }
    }
  },
  {
    name: 'set_model_cover',
    description:
      "Make one of the folder's pictures (by name, from get_model_media) its cover: the picture the library shows for its models. Leave name out to take the cover away.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'A model in the folder' },
        filePath: { type: 'string', description: 'A model file in the folder' },
        folder: { type: 'string', description: 'The model folder itself' },
        name: { type: 'string', description: 'Picture name; leave out to remove the cover' }
      }
    }
  },
  {
    name: 'remove_model_media',
    description: 'Move a picture, video or document of a model folder to the Trash. Removing the cover picture removes the cover.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'A model in the folder' },
        filePath: { type: 'string', description: 'A model file in the folder' },
        folder: { type: 'string', description: 'The model folder itself' },
        kind: { type: 'string', enum: ['image', 'video', 'document'] },
        name: { type: 'string' }
      },
      required: ['kind', 'name']
    }
  },
  {
    name: 'add_model_youtube',
    description: 'Keep YouTube videos (links or video ids) with a model folder.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'A model in the folder' },
        filePath: { type: 'string', description: 'A model file in the folder' },
        folder: { type: 'string', description: 'The model folder itself' },
        links: { type: 'array', items: { type: 'string' } }
      },
      required: ['links']
    }
  },
  {
    name: 'find_duplicates',
    description: 'Find duplicate models grouped by file hash (DeDup). Returns hash groups with file paths, names, and sizes. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        includeZip: { type: 'boolean', description: 'Include models inside ZIP archives. Default false.' },
        search: { type: 'string' },
        designer: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        directory: { type: 'string' },
        fileType: { type: 'string' },
        printed: { type: 'string' },
        limit: { type: 'integer', description: 'Max groups (default 50, max 200)' }
      }
    }
  },
  {
    name: 'get_hash_status',
    description: 'Return how many models need a hash and whether hash generation is running.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        designer: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        directory: { type: 'string' },
        fileType: { type: 'string' },
        printed: { type: 'string' }
      }
    }
  },
  {
    name: 'calculate_missing_hashes',
    description:
      'Start background hash generation for models missing a hash (or still on SHA-256). Returns immediately with started/total. Use get_hash_status to poll.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        designer: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        directory: { type: 'string' },
        fileType: { type: 'string' },
        printed: { type: 'string' }
      }
    }
  },
  {
    name: 'check_files_exist',
    description: 'Check whether model files still exist on disk. Pass filePaths, or omit to scan the library (capped). Zip entries check the archive file.',
    inputSchema: {
      type: 'object',
      properties: {
        filePaths: { type: 'array', items: { type: 'string' } },
        missingOnly: { type: 'boolean', description: 'If true, only return missing files. Default true when scanning the library.' },
        limit: { type: 'integer', description: 'Max paths to check when scanning the library (default 500, max 2000)' }
      }
    }
  },
  {
    name: 'get_all_metadata',
    description: 'List designers, parent models, and licenses with model counts.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'pull_3mf_metadata',
    description:
      'Read designer, parent model, notes, and license from 3MF files and write them to the library. If a model already has metadata, pass overwrite: true.',
    inputSchema: {
      type: 'object',
      properties: {
        filePaths: { type: 'array', items: { type: 'string' }, description: '3MF file paths. If omitted, uses id or filePath.' },
        id: { type: 'integer' },
        filePath: { type: 'string' },
        overwrite: { type: 'boolean', description: 'Overwrite existing metadata. Default false.' }
      }
    }
  },
  {
    name: 'generate_tags',
    description: 'AI-generate tags for a model from its thumbnail. Returns suggested tags. Set apply true to merge them onto the model.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' },
        apply: { type: 'boolean', description: 'If true, merge generated tags onto the model. Default false.' }
      }
    }
  },
  {
    name: 'update_models_batch',
    description: 'Update metadata for many models. Each item needs id or filePath plus fields to change.',
    inputSchema: {
      type: 'object',
      properties: {
        models: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              filePath: { type: 'string' },
              designer: { type: 'string' },
              source: { type: 'string' },
              notes: { type: 'string' },
              license: { type: 'string' },
              title: { type: 'string', description: "The model's Title (shown instead of its file name)" },
              printStatus: { type: 'string' },
              rating: { type: 'integer' },
              favorite: { type: 'boolean' },
              tags: { type: 'array', items: { type: 'string' } }
            }
          }
        }
      },
      required: ['models']
    }
  },
  {
    name: 'log_print_events_batch',
    description: 'Record the same print outcome for many models.',
    inputSchema: {
      type: 'object',
      properties: {
        filePaths: { type: 'array', items: { type: 'string' } },
        modelIds: { type: 'array', items: { type: 'integer' } },
        outcome: { type: 'string', description: 'printed, failed, or cancelled' },
        quantity: { type: 'integer' },
        printedAt: { type: 'string' },
        notes: { type: 'string' },
        parts: {
          type: 'array',
          description: 'Parts removed from stock. Each item is { id, quantity } where quantity is per copy.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              quantity: { type: 'integer' }
            },
            required: ['id']
          }
        }
      },
      required: ['outcome']
    }
  },
  {
    name: 'get_models_by_directory',
    description: 'List models whose file path is under a directory.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory path prefix' },
        limit: { type: 'integer', description: 'Max results (default 100, max 500)' }
      },
      required: ['directory']
    }
  },
  {
    name: 'check_model_links',
    description:
      'Find the Printables, Thingiverse and MakerWorld model links in text or a list, and say which ones are already in the library. Changes nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        links: { type: 'array', items: { type: 'string' }, description: 'Model links' },
        text: { type: 'string', description: 'Text that contains model links (one or many)' }
      }
    }
  },
  {
    name: 'import_model_links',
    description:
      'Add Printables, Thingiverse and MakerWorld models to the library from their links (Library → Add Links), with name, designer, picture and source link. Links already in the library are skipped. With download: true, the model files are downloaded too, into the Upload folder (where Organize takes them from); MakerWorld needs the MakerWorld sign-in and Thingiverse files an API token (Settings → Integrations). At most 50 links per call; slow (each link asks the site).',
    inputSchema: {
      type: 'object',
      properties: {
        links: { type: 'array', items: { type: 'string' }, description: 'Model links' },
        text: { type: 'string', description: 'Text that contains model links' },
        download: { type: 'boolean', description: 'Download the model files into the Upload folder. Omit to add the models as online models only.' },
        downloadFolder: { type: 'string', description: 'Before 8.4: any folder here also means download (into the Upload folder).' }
      }
    }
  },
  {
    name: 'scan_directory',
    description: 'Scan a folder and add/update models in the library. Long-running. Omit directory to rescan the last scanned folder.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string' }
      }
    }
  },
  {
    name: 'remove_model',
    description: 'Remove one or more models from the library only. Files stay on disk. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' },
        filePaths: { type: 'array', items: { type: 'string' } },
        ids: { type: 'array', items: { type: 'integer' } },
        confirm: { type: 'boolean' }
      }
    }
  },
  {
    name: 'trash_file',
    description: 'Move model file(s) to the system trash and remove them from the library. Zip entries are not trashed. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' },
        filePaths: { type: 'array', items: { type: 'string' } },
        ids: { type: 'array', items: { type: 'integer' } },
        confirm: { type: 'boolean' }
      }
    }
  },
  {
    name: 'list_slicers',
    description: 'List configured slicers (id, name, path).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'open_in_slicer',
    description:
      "Open one or more models in a configured slicer on the user's computer. The open JusttPrint browser tabs hand the files to the JusttPrint helper, which downloads them and starts the slicer there. Nothing runs on the server.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        filePath: { type: 'string' },
        filePaths: { type: 'array', items: { type: 'string' } },
        slicerId: { type: 'integer' },
        slicerName: { type: 'string' }
      }
    }
  },
  {
    name: 'move_files',
    description: 'Move model files to a destination folder and update library paths. Requires confirm: true. Zip entries are not moved.',
    inputSchema: {
      type: 'object',
      properties: {
        filePaths: { type: 'array', items: { type: 'string' } },
        destinationFolder: { type: 'string' },
        confirm: { type: 'boolean' }
      },
      required: ['filePaths', 'destinationFolder']
    }
  },
  {
    name: 'export_library',
    description: 'Export library metadata (no thumbnails) to a JSON file. Writes destPath or a timestamped file next to the database.',
    inputSchema: {
      type: 'object',
      properties: {
        destPath: { type: 'string', description: 'Optional destination JSON path' }
      }
    }
  },
  {
    name: 'backup_database',
    description: 'Copy the SQLite database to destPath or a timestamped file next to the database.',
    inputSchema: {
      type: 'object',
      properties: {
        destPath: { type: 'string', description: 'Optional destination .db path' }
      }
    }
  },
  {
    name: 'get_models_with_default_thumbnails',
    description: 'List models that still have the default/empty thumbnail (same set as missing custom thumbnails).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max results (default 50, max 500)' }
      }
    }
  },
  {
    name: 'list_categories',
    description:
      "List the Categories, each with its Subcategories and their model counts, and how many models have no Subcategory yet. Every model has one place: a Category and one of its Subcategories (MakerWorld's list).",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_model_category',
    description:
      'Give one model (id or filePath) or several (ids or filePaths) a place: a Subcategory name (its Category comes with it) or a Category alone, as the Edit dialog does. An empty category clears the place. Names as list_categories gives them.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Model id' },
        filePath: { type: 'string', description: 'Model file path (instead of id)' },
        ids: { type: 'array', items: { type: 'integer' } },
        filePaths: { type: 'array', items: { type: 'string' } },
        category: { type: 'string', description: 'A Subcategory (e.g. "Puzzles") or a Category (e.g. "Toys & Games"); empty clears it' }
      },
      required: ['category']
    }
  },
  {
    name: 'categorize_library',
    description:
      'Run Categorize Library: every model without a Subcategory gets one, from its site (MakerWorld, Printables, Thingiverse), and with useAi from the AI service in Settings (not Puter.com, which needs a browser); without the AI, from words in its folder, tags and name. One run at a time; get_categorize_status follows it.',
    inputSchema: {
      type: 'object',
      properties: {
        useAi: { type: 'boolean', description: 'Ask the AI service about the models the free step leaves (it may cost)' },
        again: { type: 'boolean', description: 'Sort every model again, except the places a person chose' },
        wait: { type: 'boolean', description: 'Answer when the run is done (default: answer at once)' }
      }
    }
  },
  {
    name: 'get_categorize_status',
    description: 'The Categorize Library run: how far it is, how many models were placed and how (site, words, AI), and any error. null when none ran.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'rename_model',
    description:
      'Rename a model and its file (the extension stays). The only model in its own model folder renames that folder too. Files inside a ZIP (listed before 8.6) keep their names.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Model id' },
        filePath: { type: 'string', description: 'Model file path (instead of id)' },
        name: { type: 'string', description: 'The new name, without the extension' }
      },
      required: ['name']
    }
  },
  {
    name: 'get_site_details',
    description:
      "A model's details from its MakerWorld, Printables or Thingiverse link (its Source): title, designer, license, description, categories, tags and print profiles, with the values it shows after your edits.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Model id' },
        filePath: { type: 'string', description: 'Model file path (instead of id)' },
        refresh: { type: 'boolean', description: 'Fetch them from the site again' }
      }
    }
  },
  {
    name: 'update_site_details',
    description:
      'Change what a model shows of its site details, as the Edit dialog does (the site itself is not changed): changes such as { title, designer, license, description, categories: [..], tags: [..], profiles: { <id>: name } }. reset: true forgets every change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Model id' },
        filePath: { type: 'string', description: 'Model file path (instead of id)' },
        changes: { type: 'object', description: 'The fields to change' },
        reset: { type: 'boolean', description: 'Forget the changes, back to what the site gives' }
      }
    }
  }
];

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  const err = { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return err;
}

function textResult(value, isError) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const out = { content: [{ type: 'text', text }] };
  if (isError) out.isError = true;
  return out;
}

function toDataUrl(image, mimeType) {
  if (!image || typeof image !== 'string') {
    throw new Error('image is required');
  }
  const trimmed = image.trim();
  if (trimmed.startsWith('data:image/')) return trimmed;
  const compact = trimmed.replace(/\s/g, '');
  let mime = (mimeType && String(mimeType).trim()) || 'image/png';
  if (!mime.startsWith('image/')) mime = 'image/png';
  if (compact.startsWith('/9j/')) mime = 'image/jpeg';
  else if (compact.startsWith('iVBOR')) mime = 'image/png';
  else if (compact.startsWith('R0lGOD')) mime = 'image/gif';
  else if (compact.startsWith('UklGR')) mime = 'image/webp';
  return `data:${mime};base64,${compact}`;
}

function clampLimit(value, fallback, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function buildMcpClientConfig(url, apiToken) {
  const server = { url };
  if (apiToken) server.headers = { Authorization: `Bearer ${apiToken}` };
  return {
    mcpServers: {
      justtprint: server
    }
  };
}

function listToolDefinitions() {
  return TOOL_DEFINITIONS.slice();
}

async function callTool(name, args, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  if (typeof ctx.assertToolArgs === 'function') ctx.assertToolArgs(name, a);
  switch (name) {
    case 'search_models':
      return ctx.searchModels({
        search: a.search,
        designer: a.designer,
        tags: a.tags,
        directory: a.directory,
        fileType: a.fileType,
        printed: a.printed,
        limit: clampLimit(a.limit, 50, 500),
        offset: Number.isFinite(parseInt(a.offset, 10)) ? Math.max(0, parseInt(a.offset, 10)) : 0
      });
    case 'get_model':
      return ctx.getModel({
        id: a.id,
        filePath: a.filePath,
        includeThumbnails: !!a.includeThumbnails
      });
    case 'update_model':
      return ctx.updateModel(a);
    case 'get_library_stats':
      return ctx.getLibraryStats();
    case 'get_folder_tree':
      return ctx.getFolderTree();
    case 'list_tags':
      return ctx.listTags();
    case 'add_tag':
      return ctx.addTag(a.name);
    case 'rename_tag':
      return ctx.renameTag({ id: a.id, name: a.name, newName: a.newName });
    case 'delete_tag':
      return ctx.deleteTag({ id: a.id, name: a.name });
    case 'add_model_tags':
      return ctx.addModelTags({ id: a.id, filePath: a.filePath, tags: a.tags });
    case 'remove_model_tags':
      return ctx.removeModelTags({ id: a.id, filePath: a.filePath, tags: a.tags });
    case 'get_print_events':
      return ctx.getPrintEvents({ id: a.id, filePath: a.filePath });
    case 'log_print_event':
      return ctx.logPrintEvent(a);
    case 'list_spools':
      return ctx.listSpools({ includeArchived: !!a.includeArchived });
    case 'get_spool':
      return ctx.getSpool({ id: a.id });
    case 'weigh_spool':
      return ctx.weighSpool(a);
    case 'check_model_filament':
      return ctx.checkModelFilament(a);
    case 'what_can_i_print':
      return ctx.whatCanIPrint(a);
    case 'get_reorder_list':
      return ctx.getReorderList();
    case 'get_print_queue':
      return ctx.getPrintQueue();
    case 'add_to_queue':
      return ctx.addToQueue(a);
    case 'get_filament_stats':
      return ctx.getFilamentStats(a);
    case 'delete_print_event':
      return ctx.deletePrintEvent(a.eventId);
    // list_parent_models: its name before 8.0.
    case 'list_titles':
    case 'list_parent_models':
      return ctx.listTitles();
    case 'rename_metadata':
      return ctx.renameMetadata({ type: a.type, oldName: a.oldName, newName: a.newName });
    case 'delete_metadata':
      return ctx.deleteMetadata({ type: a.type, name: a.name });
    case 'list_designers':
      return ctx.listDesigners();
    case 'list_licenses':
      return ctx.listLicenses();
    case 'get_models_missing_thumbnails':
      return ctx.getModelsMissingThumbnails(clampLimit(a.limit, 50, 500));
    case 'get_thumbnails':
      return ctx.getThumbnails({ id: a.id, filePath: a.filePath });
    case 'set_thumbnail':
      return ctx.setThumbnail({
        id: a.id,
        filePath: a.filePath,
        image: toDataUrl(a.image, a.mimeType)
      });
    case 'add_thumbnail':
      return ctx.addThumbnail({
        id: a.id,
        filePath: a.filePath,
        image: toDataUrl(a.image, a.mimeType)
      });
    case 'set_default_thumbnail':
      return ctx.setDefaultThumbnail({ id: a.id, filePath: a.filePath, index: a.index });
    case 'delete_thumbnail':
      return ctx.deleteThumbnail({ id: a.id, filePath: a.filePath, index: a.index });
    case 'get_model_media':
      return ctx.getModelMedia(a);
    case 'add_model_media':
      return ctx.addModelMedia(a);
    case 'set_model_cover':
      return ctx.setModelCover(a);
    case 'remove_model_media':
      return ctx.removeModelMedia(a);
    case 'add_model_youtube':
      return ctx.addModelYoutube(a);
    case 'find_duplicates':
      return ctx.findDuplicates({
        includeZip: !!a.includeZip,
        search: a.search,
        designer: a.designer,
        tags: a.tags,
        directory: a.directory,
        fileType: a.fileType,
        printed: a.printed,
        limit: clampLimit(a.limit, 50, 200)
      });
    case 'get_hash_status':
      return ctx.getHashStatus({
        search: a.search,
        designer: a.designer,
        tags: a.tags,
        directory: a.directory,
        fileType: a.fileType,
        printed: a.printed
      });
    case 'calculate_missing_hashes':
      return ctx.calculateMissingHashes({
        search: a.search,
        designer: a.designer,
        tags: a.tags,
        directory: a.directory,
        fileType: a.fileType,
        printed: a.printed
      });
    case 'check_files_exist':
      return ctx.checkFilesExist({
        filePaths: a.filePaths,
        missingOnly: a.missingOnly,
        limit: clampLimit(a.limit, 500, 2000)
      });
    case 'get_all_metadata':
      return ctx.getAllMetadata();
    case 'pull_3mf_metadata':
      return ctx.pull3mfMetadata(a);
    case 'generate_tags':
      return ctx.generateTags({ id: a.id, filePath: a.filePath, apply: !!a.apply });
    case 'update_models_batch':
      return ctx.updateModelsBatch(a.models);
    case 'log_print_events_batch':
      return ctx.logPrintEventsBatch(a);
    case 'get_models_by_directory':
      return ctx.getModelsByDirectory({
        directory: a.directory,
        limit: clampLimit(a.limit, 100, 500)
      });
    case 'check_model_links':
      return ctx.checkModelLinks({ links: a.links, text: a.text });
    case 'import_model_links':
      return ctx.importModelLinks({ links: a.links, text: a.text, download: a.download, downloadFolder: a.downloadFolder });
    case 'scan_directory':
      return ctx.scanDirectory({ directory: a.directory });
    case 'remove_model':
      return ctx.removeModel(a);
    case 'trash_file':
      return ctx.trashFile(a);
    case 'list_slicers':
      return ctx.listSlicers();
    case 'open_in_slicer':
      return ctx.openInSlicer(a);
    case 'move_files':
      return ctx.moveFiles(a);
    case 'export_library':
      return ctx.exportLibrary({ destPath: a.destPath });
    case 'backup_database':
      return ctx.backupDatabase({ destPath: a.destPath });
    case 'get_models_with_default_thumbnails':
      return ctx.getModelsMissingThumbnails(clampLimit(a.limit, 50, 500));
    case 'list_categories':
      return ctx.listCategories();
    case 'set_model_category':
      return ctx.setModelCategory(a);
    case 'categorize_library':
      return ctx.categorizeLibrary(a);
    case 'get_categorize_status':
      return ctx.getCategorizeStatus();
    case 'rename_model':
      return ctx.renameModel(a);
    case 'get_site_details':
      return ctx.getSiteDetails(a);
    case 'update_site_details':
      return ctx.updateSiteDetails(a);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function initializeResult(params, getVersion) {
  const requested = params && params.protocolVersion;
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : MCP_PROTOCOL_VERSION;
  return {
    protocolVersion,
    capabilities: {
      tools: { listChanged: false }
    },
    serverInfo: {
      name: SERVER_NAME,
      version: typeof getVersion === 'function' ? String(getVersion() || '0') : '0'
    },
    instructions:
      'JusttPrint library MCP. Search and update models, manage tags/print history, find duplicates, scan folders, add models from Printables/Thingiverse/MakerWorld links, pull 3MF metadata, and write thumbnails. Destructive tools (remove_model, trash_file, move_files) require confirm: true. filePath is on disk for local thumbnail rendering.'
  };
}

async function handleMcpJsonRpc(message, ctx) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return jsonRpcError(message.id ?? null, -32600, 'Invalid Request');
  }

  const { id, method, params } = message;
  const isNotification = id === undefined;

  try {
    if (method === 'initialize') {
      if (isNotification) return null;
      return jsonRpcResult(id, initializeResult(params, ctx.getVersion));
    }
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null;
    }
    if (method === 'ping') {
      if (isNotification) return null;
      return jsonRpcResult(id, {});
    }
    if (method === 'tools/list') {
      if (isNotification) return null;
      return jsonRpcResult(id, { tools: listToolDefinitions() });
    }
    if (method === 'tools/call') {
      if (isNotification) return null;
      const name = params && params.name;
      if (!name) return jsonRpcError(id, -32602, 'Missing tool name');
      try {
        const result = await callTool(name, (params && params.arguments) || {}, ctx);
        return jsonRpcResult(id, textResult(result === undefined ? { ok: true } : result));
      } catch (err) {
        return jsonRpcResult(id, textResult({ error: err.message || String(err) }, true));
      }
    }
    if (isNotification) return null;
    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    if (isNotification) return null;
    return jsonRpcError(id, -32603, err.message || String(err));
  }
}

function wantsSse(req) {
  const accept = String(req.headers.accept || '');
  return accept.includes('text/event-stream') && !accept.includes('application/json');
}

function writeSseMessage(res, payload) {
  res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

function setMcpHeaders(res, sessionId) {
  res.setHeader('MCP-Protocol-Version', MCP_PROTOCOL_VERSION);
  if (sessionId) res.setHeader('Mcp-Session-Id', sessionId);
}

async function handleMcpPost(req, res, ctx) {
  const sessionId = req.headers['mcp-session-id'] || crypto.randomUUID();
  const body = req.body;

  if (body == null || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)) {
    setMcpHeaders(res, sessionId);
    return res.status(400).json(jsonRpcError(null, -32700, 'Parse error'));
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of messages) {
    const response = await handleMcpJsonRpc(msg, ctx);
    if (response) responses.push(response);
  }

  setMcpHeaders(res, sessionId);

  if (responses.length === 0) {
    return res.status(202).end();
  }

  const payload = Array.isArray(body) ? responses : responses[0];
  if (wantsSse(req)) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    writeSseMessage(res, payload);
    res.end();
    return;
  }

  return res.status(200).json(payload);
}

function handleMcpGet(req, res, ctx) {
  const sessionId = req.headers['mcp-session-id'] || crypto.randomUUID();
  setMcpHeaders(res, sessionId);
  const accept = String(req.headers.accept || '');
  if (accept.includes('text/event-stream')) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(': connected\n\n');
    const iv = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (_) {
        clearInterval(iv);
      }
    }, 15000);
    req.on('close', () => clearInterval(iv));
    return;
  }
  const version = typeof ctx.getVersion === 'function' ? ctx.getVersion() : '0';
  return res.status(200).json({
    name: SERVER_NAME,
    version,
    transport: 'streamable-http',
    protocolVersion: MCP_PROTOCOL_VERSION,
    endpoint: '/mcp',
    tools: listToolDefinitions().map((t) => t.name)
  });
}

function handleMcpDelete(req, res) {
  setMcpHeaders(res, req.headers['mcp-session-id']);
  return res.status(200).end();
}

function registerMcpRoutes(expressApp, ctx) {
  const handlerCtx = ctx || {};
  const post = (req, res) => handleMcpPost(req, res, handlerCtx);
  const get = (req, res) => handleMcpGet(req, res, handlerCtx);
  const del = (req, res) => handleMcpDelete(req, res);
  expressApp.post('/mcp', post);
  expressApp.post('/mcp/', post);
  expressApp.get('/mcp', get);
  expressApp.get('/mcp/', get);
  expressApp.delete('/mcp', del);
  expressApp.delete('/mcp/', del);
}

module.exports = {
  MCP_PROTOCOL_VERSION,
  SERVER_NAME,
  TOOL_DEFINITIONS,
  listToolDefinitions,
  buildMcpClientConfig,
  toDataUrl,
  handleMcpJsonRpc,
  registerMcpRoutes,
  jsonRpcResult,
  jsonRpcError
};
