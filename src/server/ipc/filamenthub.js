'use strict';

// Settings → Integrations → Import from FilamentHub (src/core/filamenthub-import.js; docs/merge-10.md, Phase 9).
// Takes the filamenthub.db from FilamentHub's data volume, or one of its backup ZIPs, as base64.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const database = require('../../core/database');
const { ipcMain } = require('../runtime');
const fhImport = require('../../core/filamenthub-import');

const MAX_BYTES = 200 * 1024 * 1024;

/** Read an uploaded file's FilamentHub rows (a database, or a backup ZIP holding filamenthub.db). */
async function readUpload(payload) {
  const base64 = payload && typeof payload.base64 === 'string' ? payload.base64 : '';
  if (!base64) throw new Error('Choose the filamenthub.db file (or a FilamentHub backup ZIP)');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_BYTES) throw new Error('That file is too large for a FilamentHub database');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justtprint-fh-'));
  try {
    let dbFile = path.join(dir, 'upload.db');
    fs.writeFileSync(dbFile, bytes);
    if (bytes.subarray(0, 2).toString('latin1') === 'PK') {
      const StreamZip = require('node-stream-zip');
      const zip = new StreamZip.async({ file: dbFile });
      try {
        const entries = Object.values(await zip.entries());
        const entry = entries.find((e) => /(^|\/)filamenthub\.db$/i.test(e.name));
        if (!entry) throw new Error('This ZIP has no filamenthub.db: choose a FilamentHub backup');
        dbFile = path.join(dir, 'filamenthub.db');
        await zip.extract(entry.name, dbFile);
      } finally {
        await zip.close();
      }
    }
    if (fs.readFileSync(dbFile).subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new Error('This is not a FilamentHub database file');
    const source = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      return fhImport.readSource(source);
    } finally {
      source.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const accounts = () => database.db.prepare('SELECT id, username FROM users').all();

ipcMain.handle('preview-filamenthub-import', async (event, payload) => fhImport.preview(await readUpload(payload), database.db, accounts()));

ipcMain.handle('run-filamenthub-import', async (event, payload) => {
  const data = await readUpload(payload);
  const { getServerAuth } = require('../auth');
  const result = fhImport.runImport(data, database.db, {
    accounts: accounts(),
    createUser: (username, role) => {
      const user = getServerAuth().createUser({ username, password: fhImport.randomPassword() + crypto.randomBytes(2).toString('hex'), role });
      if (!user) throw new Error(`Could not make the account ${username}`);
      return user.id;
    },
    alertDelivery: require('../alert-delivery')
  });
  require('../low-stock-alerts').soon();
  require('../events').broadcast('refresh-grid');
  return result;
});
