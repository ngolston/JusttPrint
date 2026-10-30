'use strict';

/** Where spools are kept: shelves, dry boxes (docs/merge-10.md, Phase 3). Shared by the library. */

const v = require('./filament-values');

/** Every place, A–Z, with how many spools (not archived) are in it. */
function listLocations(db) {
  return db
    .prepare(
      `SELECT l.*, (SELECT COUNT(*) FROM spools s WHERE s.location_id = l.id AND s.status != 'archived') AS spool_count
       FROM storage_locations l ORDER BY l.name COLLATE NOCASE`
    )
    .all();
}

/** Add a place (no id) or change one. Names are unique, in any case. */
function saveLocation(db, input = {}, { userId = null } = {}) {
  const name = v.text(input.name, 100);
  if (!name) throw new Error('A place needs a name');
  const id = v.id(input.id);
  const clash = db.prepare('SELECT id FROM storage_locations WHERE name = ? COLLATE NOCASE AND id != ?').get(name, id || 0);
  if (clash) throw new Error(`There is already a place called ${name}`);
  const values = { name, description: v.text(input.description, 300), is_dry_box: input.is_dry_box ? 1 : 0, at: v.now() };
  if (id) {
    if (
      !db
        .prepare('UPDATE storage_locations SET name = @name, description = @description, is_dry_box = @is_dry_box, updated_at = @at WHERE id = @id')
        .run({ ...values, id }).changes
    ) {
      throw new Error('That place no longer exists');
    }
    return db.prepare('SELECT * FROM storage_locations WHERE id = ?').get(id);
  }
  const info = db
    .prepare(
      'INSERT INTO storage_locations (name, description, is_dry_box, created_by, created_at, updated_at) VALUES (@name, @description, @is_dry_box, @created_by, @at, @at)'
    )
    .run({ ...values, created_by: v.id(userId) });
  return db.prepare('SELECT * FROM storage_locations WHERE id = ?').get(info.lastInsertRowid);
}

/** Delete a place; its spools are then in no place. */
function deleteLocation(db, id) {
  return db.prepare('DELETE FROM storage_locations WHERE id = ?').run(id).changes > 0;
}

module.exports = { listLocations, saveLocation, deleteLocation };
