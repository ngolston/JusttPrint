'use strict';

// Every IPC handler module registers its channels with ipcMain when it loads.
require('./ai');
require('./collections');
require('./backup');
require('./context-menu');
require('./files');
require('./hashes');
require('./link-import');
require('./makerworld');
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
require('./uploads');
