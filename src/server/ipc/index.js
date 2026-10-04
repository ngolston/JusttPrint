'use strict';

// Every IPC handler module registers its channels with ipcMain when it loads.
require('./ai');
require('./backup');
require('./context-menu');
require('./filaments');
require('./files');
require('./hashes');
require('./metadata');
require('./models');
require('./organize');
require('./parts');
require('./previews');
require('./print-events');
require('./printers');
require('./scan');
require('./server-access');
require('./settings');
require('./slicers');
require('./system-report');
require('./tags');
require('./thumbnails');
require('./updates');
require('./web-pages');
