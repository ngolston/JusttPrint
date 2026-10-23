'use strict';

/**
 * Groups are gone since 8.11 (Merge took their place). Once, at startup: each top group, with the
 * groups inside it, becomes one merged model. Its first model by name is the main one and the
 * others are merged into it (models.partOf, model-parts.js). The main model takes the group's name
 * as its Title and the group's description when it has none. Then the group tables go and
 * models.parentModel (which only groups wrote since 8.0) is cleared, so the grid no longer groups by it.
 */

const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const columnsOf = (db) =>
  new Set(
    db
      .prepare('PRAGMA table_info(models)')
      .all()
      .map((column) => column.name)
  );
const clean = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
const byName = (a, b) => String(a.fileName || a.filePath).localeCompare(String(b.fileName || b.filePath), undefined, { numeric: true, sensitivity: 'base' });

/** Answers { merged, groups }: how many models were merged into others, from how many groups. */
function groupsToMerges(db) {
  const columns = columnsOf(db);
  const hasGroups = tableExists(db, 'model_groups') && tableExists(db, 'model_group_members');
  const hasParent = columns.has('parentModel');
  if (!columns.has('partOf') || (!hasGroups && !hasParent)) return { merged: 0, groups: 0 };
  if (!hasGroups && !db.prepare("SELECT 1 FROM models WHERE parentModel IS NOT NULL AND TRIM(parentModel) != '' LIMIT 1").get()) {
    return { merged: 0, groups: 0 };
  }

  return db.transaction(() => {
    /** key -> { name, description, ids } */
    const buckets = new Map();
    const bucket = (key, name, description) => {
      if (!buckets.has(key)) buckets.set(key, { name: clean(name), description: description || '', ids: new Set() });
      return buckets.get(key);
    };
    const rootNames = new Map();
    if (hasGroups) {
      const groups = new Map(
        db
          .prepare('SELECT id, name, parent_id, description FROM model_groups')
          .all()
          .map((g) => [g.id, g])
      );
      const rootOf = (id) => {
        let group = groups.get(id);
        for (let hops = 0; group && group.parent_id != null && groups.has(group.parent_id) && hops < 100; hops++) group = groups.get(group.parent_id);
        return group || null;
      };
      for (const group of groups.values()) if (group.parent_id == null) rootNames.set(clean(group.name).toLocaleLowerCase(), group);
      for (const member of db.prepare('SELECT model_id, group_id FROM model_group_members').all()) {
        const root = rootOf(member.group_id);
        if (root) bucket(`g${root.id}`, root.name, root.description).ids.add(member.model_id);
      }
    }
    // A model whose group name is only in parentModel (reconcile kept the two in step).
    if (hasParent) {
      for (const row of db.prepare("SELECT id, parentModel FROM models WHERE parentModel IS NOT NULL AND TRIM(parentModel) != ''").all()) {
        const name = clean(row.parentModel);
        const root = rootNames.get(name.toLocaleLowerCase());
        bucket(root ? `g${root.id}` : `n${name.toLocaleLowerCase()}`, root ? root.name : name, root ? root.description : '').ids.add(row.id);
      }
    }

    const hasTitle = columns.has('title');
    const hasDescription = columns.has('description');
    const rowOf = db.prepare('SELECT id, filePath, fileName, partOf FROM models WHERE id = ?');
    const merge = db.prepare('UPDATE models SET partOf = ? WHERE id = ?');
    const moveParts = db.prepare('UPDATE models SET partOf = ? WHERE partOf = ?');
    let merged = 0;
    let groupCount = 0;
    for (const { name, description, ids } of buckets.values()) {
      // Models merged into one outside the group stay where they are.
      const rows = [...ids].map((id) => rowOf.get(id)).filter((row) => row && !row.partOf);
      if (!rows.length) continue;
      rows.sort(byName);
      const main = rows[0];
      for (const row of rows.slice(1)) {
        merge.run(main.id, row.id);
        moveParts.run(main.id, row.id);
        merged++;
      }
      if (hasTitle && name) db.prepare("UPDATE models SET title = ? WHERE id = ? AND (title IS NULL OR TRIM(title) = '')").run(name, main.id);
      if (hasDescription && clean(description)) {
        db.prepare("UPDATE models SET description = ? WHERE id = ? AND (description IS NULL OR TRIM(description) = '')").run(description, main.id);
      }
      groupCount++;
    }
    if (hasParent) db.prepare('UPDATE models SET parentModel = NULL WHERE parentModel IS NOT NULL').run();
    if (hasGroups) {
      db.prepare('DROP TABLE IF EXISTS model_group_members').run();
      db.prepare('DROP TABLE IF EXISTS model_groups').run();
    }
    return { merged, groups: groupCount };
  })();
}

module.exports = { groupsToMerges };
