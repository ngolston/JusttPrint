'use strict';

/**
 * After a model's files are downloaded, its online model (filePath "url::<link>") is folded into
 * them, so the library holds one model, not the link and the files side by side:
 *
 * - every downloaded file gets the online model's tags (added to its own), its notes, rating and
 *   favorite when it has none, and its collections;
 * - the main file (the print profile's 3MF when there is one) also gets its print history, print
 *   status and share links;
 * - then the online model is removed.
 */

const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** Fold the online model at `onlinePath` into the models at `filePaths`; `mainPath` is one of them. False when there was none. */
function mergeOnlineModel(db, onlinePath, filePaths, mainPath) {
  const online = db.prepare('SELECT * FROM models WHERE filePath = ?').get(onlinePath);
  if (!online || !String(onlinePath).startsWith('url::')) return false;
  const targets = (filePaths || []).map((p) => db.prepare('SELECT * FROM models WHERE filePath = ?').get(p)).filter(Boolean);
  if (!targets.length) return false;
  const main = targets.find((t) => t.filePath === mainPath) || targets[0];

  db.transaction(() => {
    for (const target of targets) {
      db.prepare('INSERT OR IGNORE INTO model_tags (model_id, tag_id) SELECT ?, tag_id FROM model_tags WHERE model_id = ?').run(target.id, online.id);
      db.prepare(
        `UPDATE models SET
          notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes END,
          rating = CASE WHEN rating IS NULL OR rating = 0 THEN ? ELSE rating END,
          favorite = CASE WHEN favorite = 1 OR ? = 1 THEN 1 ELSE 0 END
        WHERE id = ?`
      ).run(online.notes || null, online.rating || 0, online.favorite ? 1 : 0, target.id);
      if (tableExists(db, 'collection_models')) {
        db.prepare(
          'INSERT OR IGNORE INTO collection_models (collection_id, model_id, added_at) SELECT collection_id, ?, added_at FROM collection_models WHERE model_id = ?'
        ).run(target.id, online.id);
      }
    }

    // History, print status and share links stay with one model: the main file.
    if (tableExists(db, 'print_events')) db.prepare('UPDATE print_events SET model_id = ? WHERE model_id = ?').run(main.id, online.id);
    if (online.print_status && online.print_status !== 'unprinted' && (!main.print_status || main.print_status === 'unprinted')) {
      db.prepare('UPDATE models SET print_status = ?, printed = ?, print_count = ?, last_printed_at = ? WHERE id = ?').run(
        online.print_status,
        online.printed || 0,
        online.print_count || 0,
        online.last_printed_at || null,
        main.id
      );
    }
    if (tableExists(db, 'share_links')) db.prepare("UPDATE share_links SET target_id = ? WHERE kind = 'model' AND target_id = ?").run(main.id, online.id);

    db.prepare('DELETE FROM model_tags WHERE model_id = ?').run(online.id);
    if (tableExists(db, 'collection_models')) db.prepare('DELETE FROM collection_models WHERE model_id = ?').run(online.id);
    db.prepare('DELETE FROM models WHERE id = ?').run(online.id);
  })();
  return true;
}

module.exports = { mergeOnlineModel };
