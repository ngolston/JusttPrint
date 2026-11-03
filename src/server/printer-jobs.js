'use strict';

/**
 * What a Bambu printer's prints do, from its live reports (bambu-live.js): when one finishes, fails
 * or is cancelled it is logged by itself (print-events.js logPrintEvent) on the library model of
 * the same name, with its plate, how long it took, the spools and grams the filament check finds
 * (spools loaded in that printer first; a failed print counts the part it got through) and a
 * picture from the camera; and alerts go out (finished, failed, paused). Each print is logged
 * once: its key is kept on the printer (printers.live_last_job), also across restarts.
 * Printers whose `auto_log` is 0 are not logged, but still alert.
 */

const CANCELLED = 0x0300400c;
const MAX_SECONDS = 30 * 24 * 3600;

const num = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/** The print a report is about: the same key from start to end, a new one for the next print. */
function jobKey(print) {
  return [print.task_id, print.subtask_id, print.gcode_start_time, print.subtask_name || print.gcode_file].map((v) => String(v ?? '')).join('|');
}

/** The plate from "Metadata/plate_2.gcode", else null. */
function plateOf(print) {
  const m = /plate_(\d+)\.gcode/i.exec(String((print && print.gcode_file) || ''));
  return m ? Number(m[1]) : null;
}

const minutes = (seconds) => {
  if (!seconds) return '';
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim();
};

/**
 * @param {{
 *   db: () => any,
 *   now?: () => number,
 *   log?: (message: string) => void,
 *   alert?: (kind: any, alert: any) => Promise<any> | any,
 *   snapshot?: (printerId: number) => Promise<Buffer | null>,
 *   afterLogged?: (payload: any, result: any) => void
 * }} deps
 */
function createJobs(deps) {
  const now = deps.now || Date.now;
  const log = deps.log || ((message) => console.log(`[Bambu prints] ${message}`));
  const alert = deps.alert || ((/** @type {any} */ kind, a) => require('./personal-alerts').alert(kind, a));
  const snapshot =
    deps.snapshot ||
    (async (printerId) => {
      const picture = await require('./bambu-camera').shared().frame(printerId, { waitMs: 12000 });
      return picture && picture.jpeg ? picture.jpeg : null;
    });

  function printer(printerId) {
    try {
      return deps.db().prepare('SELECT id, nickname, auto_log, live_last_job FROM printers WHERE id = ?').get(printerId) || null;
    } catch (_) {
      return deps.db().prepare('SELECT id, nickname FROM printers WHERE id = ?').get(printerId) || null;
    }
  }

  /**
   * After each report: `before` is the state the summary had before this report (null at first).
   * @param {any} entry bambu-live's entry (print, model, job)
   * @param {string | null} before
   * @param {{ state: string | null, progress: number | null, errors?: { code: string, text: string | null }[] }} summary
   */
  function observe(entry, before, summary) {
    const print = entry.print || {};
    const state = summary.state;
    const active = state === 'printing' || state === 'paused';
    if (active) {
      const key = jobKey(print);
      if (!entry.job || entry.job.key !== key) {
        const started = num(print.gcode_start_time);
        entry.job = {
          key,
          name: String(print.subtask_name || print.gcode_file || 'A print').trim(),
          // The printer's own start time; else now, when the start was seen here (it was idle a
          // moment ago); else not known (JusttPrint connected partway through).
          startedAt: started && started > 1e9 ? started * 1000 : before && before !== 'printing' && before !== 'paused' ? now() : null,
          plate: plateOf(print),
          progress: summary.progress
        };
      }
      entry.job.progress = summary.progress ?? entry.job.progress;
      if (before === 'printing' && state === 'paused') void paused(entry, summary);
      return;
    }
    if ((before === 'printing' || before === 'paused') && (state === 'finished' || state === 'failed') && entry.job) {
      const job = entry.job;
      entry.job = null;
      const outcome = state === 'finished' ? 'printed' : num(print.print_error) === CANCELLED ? 'cancelled' : 'failed';
      void finished(entry, job, outcome, summary);
    }
  }

  async function paused(entry, summary) {
    const row = printer(entry.printerId);
    if (!row) return;
    const reason = (summary.errors || []).map((e) => e.text || `error ${e.code}`).join('; ');
    try {
      await alert('printPaused', {
        title: `${row.nickname}: ${entry.job ? entry.job.name : 'the print'} paused`,
        body: reason ? `The printer says: ${reason}` : 'The print is paused on the printer.',
        link: `#/printers/${row.id}`,
        level: 'warning',
        minRole: 'viewer',
        key: `printer-paused-${row.id}-${entry.job ? entry.job.key : ''}`
      });
    } catch (error) {
      log(`could not send the paused alert: ${error.message}`);
    }
  }

  /** The spools and grams the filament check finds for the model (loaded in this printer first); scaled to `share`. */
  function spoolsFor(db, modelId, plate, printerId, share) {
    try {
      const check = require('../core/filament-check').checkModel(db, modelId, { plate, printerId });
      if (!check) return [];
      return check.needs
        .filter((need) => need.spool && need.grams !== null && need.grams !== undefined && Number(need.grams) > 0)
        .map((need) => ({ spoolId: /** @type {{ id: number }} */ (need.spool).id, grams: Math.round(Number(need.grams) * share * 100) / 100 }))
        .filter((use) => use.grams > 0);
    } catch (error) {
      log(`could not work out the filament used: ${error.message}`);
      return [];
    }
  }

  async function finished(entry, job, outcome, summary) {
    const db = deps.db();
    const row = printer(entry.printerId);
    if (!row) return;
    if (row.live_last_job === job.key) return; // logged before (a reconnect, a restart)
    try {
      db.prepare('UPDATE printers SET live_last_job = ? WHERE id = ?').run(job.key, row.id);
    } catch (_) {
      /* before the column */
    }
    const at = now();
    const seconds = job.startedAt ? Math.min(MAX_SECONDS, Math.max(0, Math.round((at - job.startedAt) / 1000))) : null;
    const model = entry.model ? db.prepare('SELECT id, filePath FROM models WHERE filePath = ?').get(entry.model.filePath) : null;
    const wantLog = row.auto_log === undefined || row.auto_log === null || Number(row.auto_log) !== 0;
    /** @type {{ eventId: number | bigint } | null} */
    let logged = null;
    if (model && wantLog) {
      const share = outcome === 'printed' ? 1 : Math.max(0, Math.min(1, (job.progress ?? summary.progress ?? 0) / 100));
      const payload = {
        filePath: model.filePath,
        outcome,
        quantity: 1,
        printedAt: new Date(at).toISOString(),
        printerId: row.id,
        durationSeconds: seconds,
        plateIndex: job.plate,
        plates: job.plate ? [job.plate] : [],
        spools: spoolsFor(db, model.id, job.plate, row.id, share),
        notes: `Logged by itself from ${row.nickname}.`
      };
      try {
        logged = require('../core/print-events').logPrintEvent(db, payload);
        log(`logged ${job.name} on ${row.nickname} as ${outcome}`);
        if (deps.afterLogged) deps.afterLogged(payload, logged);
      } catch (error) {
        log(`could not log ${job.name}: ${error.message}`);
      }
      if (logged && logged.eventId) {
        try {
          const jpeg = await snapshot(row.id);
          if (jpeg)
            require('./photos').addPrintPhoto(db, Number(logged.eventId), {
              dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
              caption: `${row.nickname}, at the end`
            });
        } catch (error) {
          log(`could not keep a camera picture: ${error.message}`);
        }
      }
    }
    if (outcome === 'cancelled') return;
    const took = minutes(seconds);
    const notLogged = !model ? ` Not logged: no model in your library is named ${job.name}.` : !wantLog ? '' : logged ? ' Logged in the print history.' : '';
    const reason = (summary.errors || []).map((e) => e.text || `error ${e.code}`).join('; ');
    try {
      await alert(outcome === 'printed' ? 'printFinished' : 'printFailed', {
        title: `${row.nickname}: ${job.name} ${outcome === 'printed' ? 'finished' : 'failed'}`,
        body: `${outcome === 'printed' ? 'Done' : 'It failed'}${took ? ` after ${took}` : ''}.${reason ? ` The printer says: ${reason}.` : ''}${notLogged}`,
        link: model ? `#/model/${encodeURIComponent(model.filePath)}` : `#/printers/${row.id}`,
        level: outcome === 'printed' ? 'info' : 'error',
        minRole: 'viewer',
        key: `printer-job-${row.id}-${job.key}`
      });
    } catch (error) {
      log(`could not send the alert: ${error.message}`);
    }
  }

  return { observe, jobKey, plateOf };
}

module.exports = { createJobs, jobKey, plateOf, CANCELLED };
