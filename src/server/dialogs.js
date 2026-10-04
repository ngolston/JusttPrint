'use strict';

const { createClientDialogs } = require('./client-dialogs');

// Message boxes and prompts the server shows in the browser that made the request.
const clientDialogs = createClientDialogs();

module.exports = { clientDialogs };
