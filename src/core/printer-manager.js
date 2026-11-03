'use strict';

/**
 * Backend logic and SQLite data access for Printer Management,
 * maintenance logs, and scheduled maintenance reminders.
 */

function ensurePrinterSchema(db) {
  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      manufacturer TEXT,
      model TEXT,
      printer_type TEXT,
      firmware_type TEXT,
      is_klipper INTEGER DEFAULT 0,
      web_url TEXT,
      notes TEXT,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )
  `
  ).run();

  try {
    const printerCols = db.prepare('PRAGMA table_info(printers)').all();
    if (printerCols.length > 0 && !printerCols.some((col) => col.name === 'printer_type')) {
      db.prepare('ALTER TABLE printers ADD COLUMN printer_type TEXT').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_printers_printer_type ON printers(printer_type)').run();
    }
  } catch (err) {
    // Ignore migration error if already exists
  }

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS printer_maintenance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id INTEGER NOT NULL,
      maintenance_type TEXT NOT NULL,
      title TEXT,
      description TEXT,
      performed_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL,
      FOREIGN KEY(printer_id) REFERENCES printers(id) ON DELETE CASCADE
    )
  `
  ).run();

  db.prepare(
    `
    CREATE TABLE IF NOT EXISTS printer_maintenance_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      printer_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      maintenance_type TEXT,
      due_date DATETIME NOT NULL,
      interval_days INTEGER DEFAULT 0,
      notes TEXT,
      status TEXT DEFAULT 'pending',
      last_completed_at DATETIME,
      created_at DATETIME NOT NULL,
      FOREIGN KEY(printer_id) REFERENCES printers(id) ON DELETE CASCADE
    )
  `
  ).run();

  db.prepare('CREATE INDEX IF NOT EXISTS idx_printers_nickname ON printers(nickname)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_printers_printer_type ON printers(printer_type)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_printer_maintenance_logs_printer_id ON printer_maintenance_logs(printer_id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_printer_maintenance_logs_performed_at ON printer_maintenance_logs(performed_at)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_printer_reminders_printer_id ON printer_maintenance_reminders(printer_id)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_printer_reminders_due_date ON printer_maintenance_reminders(due_date)').run();

  // Ensure print_events table has printer_id column
  try {
    const tableInfo = db.prepare('PRAGMA table_info(print_events)').all();
    if (tableInfo.length > 0 && !tableInfo.some((col) => col.name === 'printer_id')) {
      db.prepare('ALTER TABLE print_events ADD COLUMN printer_id INTEGER REFERENCES printers(id)').run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_print_events_printer_id ON print_events(printer_id)').run();
    }
  } catch (err) {
    // If print_events does not exist yet, it will be added during ensurePrintLifecycleSchema
  }
}

function normalizeDate(value) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/** A date so far ahead that a reminder by print hours alone is never due by date. */
const NO_DATE = '2999-12-31T12:00:00.000Z';

function hasColumn(db, table, column) {
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column);
  } catch (_) {
    return false;
  }
}

/** How many hours a printer has printed: the print times of its logged prints. */
function printerPrintHours(db, printerId) {
  if (!hasTable(db, 'print_events') || !hasColumn(db, 'print_events', 'duration_seconds')) return 0;
  const row = db.prepare('SELECT COALESCE(SUM(duration_seconds), 0) AS s FROM print_events WHERE printer_id = ?').get(printerId);
  return Math.round(((Number(row && row.s) || 0) / 3600) * 10) / 10;
}

/** The SQL of a printer's print hours (p.id), or 0 before the column. */
const hoursSql = (db) =>
  hasTable(db, 'print_events') && hasColumn(db, 'print_events', 'duration_seconds')
    ? '(SELECT COALESCE(SUM(pe2.duration_seconds), 0) / 3600.0 FROM print_events pe2 WHERE pe2.printer_id = p.id)'
    : '0';

function hasTable(db, tableName) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
    return Boolean(row);
  } catch (_) {
    return false;
  }
}

const CONNECTION_TYPES = ['manual', 'octoprint', 'moonraker', 'bambu'];

/**
 * A printer as browsers see it: the API key or access code (api_secret) never leaves the server;
 * has_api_secret says whether one is kept.
 */
function publicPrinter(row) {
  if (!row) return row;
  const { api_secret, ...rest } = row;
  return { ...rest, is_klipper: Boolean(row.is_klipper), has_api_secret: Boolean(api_secret) };
}

function getAllPrinters(db) {
  ensurePrinterSchema(db);
  const hasPrintEvents = hasTable(db, 'print_events');
  const printEventsCols = hasPrintEvents
    ? `, (SELECT COUNT(*) FROM print_events pe WHERE pe.printer_id = p.id) AS total_prints,
       (SELECT MAX(pe.printed_at) FROM print_events pe WHERE pe.printer_id = p.id) AS last_printed_at`
    : ', 0 AS total_prints, NULL AS last_printed_at';

  const hours = hoursSql(db);
  const byHours = hasColumn(db, 'printer_maintenance_reminders', 'interval_hours')
    ? ` OR (pmr.interval_hours > 0 AND ${hours} >= COALESCE(pmr.hours_start, 0) + pmr.interval_hours * 0.95)`
    : '';
  const printers = db
    .prepare(
      `
    SELECT p.*${printEventsCols}, ${hours} AS print_hours,
      (SELECT COUNT(*) FROM printer_maintenance_reminders pmr 
       WHERE pmr.printer_id = p.id AND pmr.status = 'pending' AND (datetime(pmr.due_date) <= datetime('now', '+7 days')${byHours})) AS due_reminders_count
    FROM printers p
    ORDER BY p.nickname COLLATE NOCASE ASC, p.id ASC
  `
    )
    .all();

  return printers.map(publicPrinter);
}

function getPrinterById(db, id) {
  ensurePrinterSchema(db);
  const row = db.prepare('SELECT * FROM printers WHERE id = ?').get(id);
  return row ? publicPrinter(row) : null;
}

/** The printer's connection columns exist (10.0, filament-schema.js); older test databases may not have them. */
function hasConnectionColumns(db) {
  return db
    .prepare('PRAGMA table_info(printers)')
    .all()
    .some((c) => c.name === 'connection_type');
}

/**
 * Connection details from the form (docs/merge-10.md, Phase 5). The API key or access code is
 * changed only when `apiSecret` is given: a string sets it, '' or null clears it.
 */
function saveConnection(db, id, printer) {
  if (!hasConnectionColumns(db)) return;
  const raw = String(printer?.connectionType ?? printer?.connection_type ?? '')
    .trim()
    .toLowerCase();
  const connectionType = CONNECTION_TYPES.includes(raw) ? raw : 'manual';
  const typed =
    String(printer?.serialNumber ?? printer?.serial_number ?? '')
      .trim()
      .slice(0, 100) || null;
  // Bambu Lab serial numbers are capitals (live status subscribes with them).
  const serial = typed && connectionType === 'bambu' ? typed.toUpperCase() : typed;
  const apiUrl =
    String(printer?.apiUrl ?? printer?.api_url ?? '')
      .trim()
      .slice(0, 500) || null;
  db.prepare('UPDATE printers SET connection_type = ?, serial_number = ?, api_url = ? WHERE id = ?').run(connectionType, serial, apiUrl, id);
  if (printer && Object.prototype.hasOwnProperty.call(printer, 'apiSecret')) {
    const secret = printer.apiSecret === null ? '' : String(printer.apiSecret).trim().slice(0, 500);
    db.prepare('UPDATE printers SET api_secret = ? WHERE id = ?').run(secret || null, id);
  }
  // Log finished prints by themselves (Bambu live status, printer-jobs.js); kept when not given.
  if (
    printer &&
    (Object.prototype.hasOwnProperty.call(printer, 'autoLog') || Object.prototype.hasOwnProperty.call(printer, 'auto_log')) &&
    hasColumn(db, 'printers', 'auto_log')
  ) {
    const raw = printer.autoLog ?? printer.auto_log;
    db.prepare('UPDATE printers SET auto_log = ? WHERE id = ?').run(raw === false || raw === 0 || raw === '0' ? 0 : 1, id);
  }
  // Power while printing, for the cost estimate (docs/plan-10.1.md, Phase 8); kept when not given.
  const hasPower = db
    .prepare('PRAGMA table_info(printers)')
    .all()
    .some((c) => c.name === 'power_watts');
  if (hasPower && printer && (Object.prototype.hasOwnProperty.call(printer, 'powerWatts') || Object.prototype.hasOwnProperty.call(printer, 'power_watts'))) {
    const raw = printer.powerWatts ?? printer.power_watts;
    const watts = raw === null || raw === '' || raw === undefined ? null : Number(raw);
    if (watts !== null && (!Number.isFinite(watts) || watts < 0 || watts > 10000)) throw new Error('Power is a number of watts, up to 10,000');
    db.prepare('UPDATE printers SET power_watts = ? WHERE id = ?').run(watts, id);
  }
}

function savePrinter(db, printer) {
  ensurePrinterSchema(db);
  const nickname = String(printer?.nickname || '').trim();
  if (!nickname) throw new Error('Printer nickname is required');

  const manufacturer = String(printer?.manufacturer || '').trim() || null;
  const model = String(printer?.model || '').trim() || null;
  const printerType = String(printer?.printerType || printer?.printer_type || printer?.technology || printer?.type || '').trim() || null;
  const firmwareType = String(printer?.firmwareType || printer?.firmware_type || '').trim() || null;
  const isKlipper = (firmwareType && firmwareType.toLowerCase() === 'klipper') || Boolean(printer?.isKlipper ?? printer?.is_klipper) ? 1 : 0;

  let webUrl = String(printer?.webUrl || printer?.web_url || '').trim() || null;
  if (webUrl && !/^https?:\/\//i.test(webUrl)) {
    webUrl = 'http://' + webUrl;
  }
  const notes = String(printer?.notes || '').trim() || null;
  const now = new Date().toISOString();

  const id = printer?.id != null && printer.id !== '' ? Number(printer.id) : null;
  if (id) {
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid printer ID');
    const existing = db.prepare('SELECT id FROM printers WHERE id = ?').get(id);
    if (!existing) throw new Error('Printer not found');

    db.prepare(
      `
      UPDATE printers
      SET nickname = ?, manufacturer = ?, model = ?, printer_type = ?, firmware_type = ?, is_klipper = ?, web_url = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `
    ).run(nickname, manufacturer, model, printerType, firmwareType, isKlipper, webUrl, notes, now, id);
    saveConnection(db, id, printer);

    return getPrinterById(db, id);
  }

  const result = db
    .prepare(
      `
    INSERT INTO printers (nickname, manufacturer, model, printer_type, firmware_type, is_klipper, web_url, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(nickname, manufacturer, model, printerType, firmwareType, isKlipper, webUrl, notes, now, now);
  saveConnection(db, Number(result.lastInsertRowid), printer);

  return getPrinterById(db, result.lastInsertRowid);
}

function deletePrinter(db, printerId) {
  ensurePrinterSchema(db);
  const id = Number(printerId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid printer ID');

  return db.transaction(() => {
    // Nullify printer_id in print_events to preserve history
    if (hasTable(db, 'print_events')) {
      db.prepare('UPDATE print_events SET printer_id = NULL WHERE printer_id = ?').run(id);
    }
    db.prepare('DELETE FROM printer_maintenance_logs WHERE printer_id = ?').run(id);
    db.prepare('DELETE FROM printer_maintenance_reminders WHERE printer_id = ?').run(id);
    const result = db.prepare('DELETE FROM printers WHERE id = ?').run(id);
    return result.changes > 0;
  })();
}

function getPrinterMaintenanceLogs(db, printerId) {
  ensurePrinterSchema(db);
  const id = Number(printerId);
  if (!Number.isInteger(id) || id <= 0) return [];

  return db
    .prepare(
      `
    SELECT * FROM printer_maintenance_logs
    WHERE printer_id = ?
    ORDER BY performed_at DESC, id DESC
  `
    )
    .all(id);
}

function savePrinterMaintenanceLog(db, logEntry) {
  ensurePrinterSchema(db);
  const printerId = Number(logEntry?.printerId ?? logEntry?.printer_id);
  if (!Number.isInteger(printerId) || printerId <= 0) throw new Error('Valid printer ID is required');

  const maintenanceType = String(logEntry?.maintenanceType || logEntry?.maintenance_type || 'General Maintenance').trim();
  const title = String(logEntry?.title || maintenanceType).trim();
  const description = String(logEntry?.description || '').trim() || null;
  const performedAt = normalizeDate(logEntry?.performedAt ?? logEntry?.performed_at);
  const now = new Date().toISOString();

  const id = logEntry?.id != null && logEntry.id !== '' ? Number(logEntry.id) : null;
  if (id) {
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid log ID');
    db.prepare(
      `
      UPDATE printer_maintenance_logs
      SET maintenance_type = ?, title = ?, description = ?, performed_at = ?
      WHERE id = ? AND printer_id = ?
    `
    ).run(maintenanceType, title, description, performedAt, id, printerId);
    return db.prepare('SELECT * FROM printer_maintenance_logs WHERE id = ?').get(id);
  }

  const result = db
    .prepare(
      `
    INSERT INTO printer_maintenance_logs (printer_id, maintenance_type, title, description, performed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `
    )
    .run(printerId, maintenanceType, title, description, performedAt, now);

  return db.prepare('SELECT * FROM printer_maintenance_logs WHERE id = ?').get(result.lastInsertRowid);
}

function deletePrinterMaintenanceLog(db, logId) {
  ensurePrinterSchema(db);
  const id = Number(logId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid log ID');
  const result = db.prepare('DELETE FROM printer_maintenance_logs WHERE id = ?').run(id);
  return result.changes > 0;
}

function getPrinterReminders(db, printerId) {
  ensurePrinterSchema(db);
  let query = 'SELECT * FROM printer_maintenance_reminders';
  const params = [];

  if (printerId) {
    const id = Number(printerId);
    if (Number.isInteger(id) && id > 0) {
      query += ' WHERE printer_id = ?';
      params.push(id);
    }
  }

  query += ` ORDER BY 
    CASE status WHEN 'pending' THEN 0 ELSE 1 END,
    due_date ASC, id ASC`;

  // Reminders by print hours also say the printer's hours now and the hours they are due at.
  const hoursOf = new Map();
  return db
    .prepare(query)
    .all(...params)
    .map((reminder) => {
      if (!(Number(reminder.interval_hours) > 0)) return reminder;
      if (!hoursOf.has(reminder.printer_id)) hoursOf.set(reminder.printer_id, printerPrintHours(db, reminder.printer_id));
      return {
        ...reminder,
        hours_now: hoursOf.get(reminder.printer_id),
        hours_due: Math.round(((Number(reminder.hours_start) || 0) + Number(reminder.interval_hours)) * 10) / 10
      };
    });
}

function savePrinterReminder(db, reminder) {
  ensurePrinterSchema(db);
  const printerId = Number(reminder?.printerId ?? reminder?.printer_id);
  if (!Number.isInteger(printerId) || printerId <= 0) throw new Error('Valid printer ID is required');

  const title = String(reminder?.title || '').trim();
  if (!title) throw new Error('Reminder title is required');

  const maintenanceType = String(reminder?.maintenanceType || reminder?.maintenance_type || 'General Maintenance').trim();
  // Every N print hours (Bambu printers log their prints' times by themselves); a reminder by hours
  // alone has no date.
  const intervalHoursRaw = Number(reminder?.intervalHours ?? reminder?.interval_hours);
  const intervalHours = Number.isFinite(intervalHoursRaw) && intervalHoursRaw > 0 ? Math.min(100000, Math.round(intervalHoursRaw * 10) / 10) : null;
  const dateGiven = reminder?.dueDate ?? reminder?.due_date;
  const dueDate = intervalHours && !dateGiven ? NO_DATE : normalizeDate(dateGiven);
  const intervalDays = Math.max(0, Math.floor(Number(reminder?.intervalDays ?? reminder?.interval_days) || 0));
  const notes = String(reminder?.notes || '').trim() || null;
  const status = String(reminder?.status || 'pending').toLowerCase() === 'completed' ? 'completed' : 'pending';
  const now = new Date().toISOString();

  const id = reminder?.id != null && reminder.id !== '' ? Number(reminder.id) : null;
  if (id) {
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid reminder ID');
    db.prepare(
      `
      UPDATE printer_maintenance_reminders
      SET title = ?, maintenance_type = ?, due_date = ?, interval_days = ?, notes = ?, status = ?
      WHERE id = ? AND printer_id = ?
    `
    ).run(title, maintenanceType, dueDate, intervalDays, notes, status, id, printerId);
    if (hasColumn(db, 'printer_maintenance_reminders', 'interval_hours')) {
      const old = db.prepare('SELECT interval_hours, hours_start FROM printer_maintenance_reminders WHERE id = ?').get(id);
      const start = old && old.hours_start !== null && Number(old.interval_hours) > 0 ? old.hours_start : printerPrintHours(db, printerId);
      db.prepare('UPDATE printer_maintenance_reminders SET interval_hours = ?, hours_start = ? WHERE id = ?').run(
        intervalHours,
        intervalHours ? start : null,
        id
      );
    }
    return getPrinterReminders(db, printerId).find((r) => r.id === id);
  }

  const result = db
    .prepare(
      `
    INSERT INTO printer_maintenance_reminders (printer_id, title, maintenance_type, due_date, interval_days, notes, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(printerId, title, maintenanceType, dueDate, intervalDays, notes, status, now);
  const newId = Number(result.lastInsertRowid);
  if (intervalHours && hasColumn(db, 'printer_maintenance_reminders', 'interval_hours')) {
    db.prepare('UPDATE printer_maintenance_reminders SET interval_hours = ?, hours_start = ? WHERE id = ?').run(
      intervalHours,
      printerPrintHours(db, printerId),
      newId
    );
  }
  return getPrinterReminders(db, printerId).find((r) => r.id === newId);
}

function deletePrinterReminder(db, reminderId) {
  ensurePrinterSchema(db);
  const id = Number(reminderId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid reminder ID');
  const result = db.prepare('DELETE FROM printer_maintenance_reminders WHERE id = ?').run(id);
  return result.changes > 0;
}

function completePrinterReminder(db, reminderId, notes) {
  ensurePrinterSchema(db);
  const id = Number(reminderId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid reminder ID');

  return db.transaction(() => {
    const reminder = db.prepare('SELECT * FROM printer_maintenance_reminders WHERE id = ?').get(id);
    if (!reminder) throw new Error('Reminder not found');

    const now = new Date().toISOString();
    const completionNotes = notes ? String(notes).trim() : reminder.notes ? `Completed: ${reminder.notes}` : 'Completed scheduled reminder';

    // Automatically record a maintenance log entry
    savePrinterMaintenanceLog(db, {
      printerId: reminder.printer_id,
      maintenanceType: reminder.maintenance_type || 'Scheduled Maintenance',
      title: reminder.title,
      description: completionNotes,
      performedAt: now
    });

    // By print hours: due again interval_hours from now (and by date too when it repeats by days).
    if (Number(reminder.interval_hours) > 0) {
      const nextDue = reminder.interval_days > 0 ? new Date(Date.now() + reminder.interval_days * 24 * 3600 * 1000).toISOString() : reminder.due_date;
      db.prepare(`UPDATE printer_maintenance_reminders SET hours_start = ?, due_date = ?, status = 'pending', last_completed_at = ? WHERE id = ?`).run(
        printerPrintHours(db, reminder.printer_id),
        nextDue,
        now,
        id
      );
    } else if (reminder.interval_days > 0) {
      const nextDue = new Date();
      nextDue.setDate(nextDue.getDate() + reminder.interval_days);
      db.prepare(
        `
        UPDATE printer_maintenance_reminders
        SET due_date = ?, status = 'pending', last_completed_at = ?
        WHERE id = ?
      `
      ).run(nextDue.toISOString(), now, id);
    } else {
      db.prepare(
        `
        UPDATE printer_maintenance_reminders
        SET status = 'completed', last_completed_at = ?
        WHERE id = ?
      `
      ).run(now, id);
    }

    return db.prepare('SELECT * FROM printer_maintenance_reminders WHERE id = ?').get(id);
  })();
}

module.exports = {
  CONNECTION_TYPES,
  publicPrinter,
  ensurePrinterSchema,
  getAllPrinters,
  getPrinterById,
  savePrinter,
  deletePrinter,
  getPrinterMaintenanceLogs,
  savePrinterMaintenanceLog,
  deletePrinterMaintenanceLog,
  getPrinterReminders,
  savePrinterReminder,
  deletePrinterReminder,
  completePrinterReminder,
  printerPrintHours
};
