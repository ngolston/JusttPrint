'use strict';

/**
 * Low-stock alerts and the reorder list (docs/merge-10.md, Phase 8; after FilamentHub's alert
 * rules). A rule says when a spool is low and when it is critical, in percent of what it held,
 * for every material or one (base material, as the filament check compares). A spool is told
 * about once per breach: when it first falls under a rule, and again when it gets worse (low to
 * critical). Weighed or refilled above the line, it may be told about again later.
 *
 * Without any rule, DEFAULT_RULE applies (20 % low, 10 % critical, every material, in JusttPrint
 * notifications only), so the reorder list and the notifications work out of the box.
 */

const v = require('./filament-values');

const DEFAULT_RULE = {
  id: 0,
  name: 'Low stock',
  low_threshold_pct: 20,
  critical_threshold_pct: 10,
  material_filter: null,
  notify_discord: 0,
  notify_email: 0,
  is_active: 1
};

function listRules(db) {
  return db.prepare('SELECT * FROM low_stock_rules ORDER BY name COLLATE NOCASE, id').all();
}

/** The rules that apply: the active ones, or the default when there are none at all. */
function activeRules(db) {
  const rules = listRules(db);
  return rules.length ? rules.filter((rule) => rule.is_active) : [DEFAULT_RULE];
}

/** Add a rule (no id) or change one. Low must be above critical. */
function saveRule(db, input = {}, { userId = null } = {}) {
  const name = v.text(input.name, 100) || 'Low stock';
  const low = v.number(input.low_threshold_pct, 'Low', { min: 1, max: 99 }) ?? 20;
  const critical = v.number(input.critical_threshold_pct, 'Critical', { min: 0, max: 99 }) ?? 10;
  if (critical >= low) throw new Error('Critical must be below low');
  const values = {
    name,
    low,
    critical,
    material: v.baseMaterial(v.text(input.material_filter, 50)),
    discord: input.notify_discord ? 1 : 0,
    email: input.notify_email ? 1 : 0,
    active: input.is_active === false || input.is_active === 0 ? 0 : 1
  };
  const id = v.id(input.id);
  if (id) {
    const changed = db
      .prepare(
        `UPDATE low_stock_rules SET name = @name, low_threshold_pct = @low, critical_threshold_pct = @critical, material_filter = @material,
          notify_discord = @discord, notify_email = @email, is_active = @active WHERE id = @id`
      )
      .run({ ...values, id }).changes;
    if (!changed) throw new Error('That rule no longer exists');
    db.prepare('DELETE FROM low_stock_fired WHERE rule_id = ?').run(id);
    return db.prepare('SELECT * FROM low_stock_rules WHERE id = ?').get(id);
  }
  const info = db
    .prepare(
      `INSERT INTO low_stock_rules (name, low_threshold_pct, critical_threshold_pct, material_filter, notify_discord, notify_email, is_active, created_by, created_at)
       VALUES (@name, @low, @critical, @material, @discord, @email, @active, @createdBy, @at)`
    )
    .run({ ...values, createdBy: v.id(userId), at: v.now() });
  return db.prepare('SELECT * FROM low_stock_rules WHERE id = ?').get(info.lastInsertRowid);
}

function deleteRule(db, id) {
  return db.prepare('DELETE FROM low_stock_rules WHERE id = ?').run(id).changes > 0;
}

/** Spools (not archived, holding something) with their share left: { id, name, ..., remaining, pct }. */
function spoolLevels(db) {
  return db
    .prepare(
      `SELECT s.id, s.name, s.material, s.material_type, s.color_hex, s.initial_weight, s.used_weight, s.supplier, s.product_url, s.purchase_price,
         p.name AS profile_name, p.product_url AS profile_url, b.name AS brand_name, l.name AS location_name
       FROM spools s LEFT JOIN filament_profiles p ON p.id = s.profile_id LEFT JOIN filament_brands b ON b.id = s.brand_id
       LEFT JOIN storage_locations l ON l.id = s.location_id
       WHERE s.status != 'archived' AND s.initial_weight > 0`
    )
    .all()
    .map((row) => {
      const remaining = Math.max(0, row.initial_weight - row.used_weight);
      return {
        id: row.id,
        name: row.name || row.profile_name || [row.material, row.material_type].filter(Boolean).join(' ') || 'Spool',
        brand: row.brand_name,
        material: row.material,
        color: row.color_hex,
        remaining,
        initial: row.initial_weight,
        pct: Math.round((remaining / row.initial_weight) * 1000) / 10,
        supplier: row.supplier,
        productUrl: row.product_url || row.profile_url || null,
        price: row.purchase_price,
        location: row.location_name
      };
    });
}

/** How a spool stands against a rule: 'critical', 'low', or null (fine, or not this rule's material). */
function severityFor(rule, spool) {
  if (rule.material_filter && v.baseMaterial(spool.material) !== v.baseMaterial(rule.material_filter)) return null;
  if (spool.pct <= rule.critical_threshold_pct) return 'critical';
  if (spool.pct <= rule.low_threshold_pct) return 'low';
  return null;
}

/**
 * The reorder list: every spool a rule finds low or critical, most urgent first, with where to
 * buy it again (shop, product page, last price).
 */
function reorderList(db) {
  const rules = activeRules(db);
  const out = [];
  for (const spool of spoolLevels(db)) {
    /** @type {'low' | 'critical' | null} */
    let worst = null;
    for (const rule of rules) {
      const severity = severityFor(rule, spool);
      if (severity === 'critical' || (severity === 'low' && !worst)) worst = severity;
    }
    if (worst) out.push({ ...spool, severity: worst });
  }
  return out.sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || a.pct - b.pct);
}

/**
 * What to tell now: per rule, the spools newly low or gone from low to critical. Records them in
 * low_stock_fired, and forgets spools that are back above a rule's line. Returns
 * [{ rule, alerts: [{ spool, severity }] }] (the default rule has id 0 and is not recorded by id).
 */
function evaluate(db, now = new Date()) {
  const rules = activeRules(db);
  const levels = spoolLevels(db);
  const groups = [];
  db.transaction(() => {
    for (const rule of rules) {
      // The default rule has no row in low_stock_rules (low_stock_fired's foreign key needs one),
      // so what it has told about is kept in the settings table instead.
      const fired = rule.id
        ? new Map(
            db
              .prepare('SELECT spool_id, severity FROM low_stock_fired WHERE rule_id = ?')
              .all(rule.id)
              .map((row) => [row.spool_id, row.severity])
          )
        : defaultFired(db);
      const alerts = [];
      const still = new Map();
      for (const spool of levels) {
        const severity = severityFor(rule, spool);
        if (!severity) continue;
        still.set(spool.id, severity);
        const before = fired.get(spool.id);
        if (!before || (before === 'low' && severity === 'critical')) alerts.push({ spool, severity });
      }
      if (rule.id) {
        db.prepare('DELETE FROM low_stock_fired WHERE rule_id = ?').run(rule.id);
        const keep = db.prepare('INSERT INTO low_stock_fired (rule_id, spool_id, severity, fired_at) VALUES (?, ?, ?, ?)');
        for (const [spoolId, severity] of still) keep.run(rule.id, spoolId, severity, now.toISOString());
      } else {
        saveDefaultFired(db, still);
      }
      if (alerts.length) groups.push({ rule, alerts });
    }
  })();
  return groups;
}

const DEFAULT_FIRED_KEY = 'lowStockDefaultFired';
function defaultFired(db) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(DEFAULT_FIRED_KEY);
    return new Map(Object.entries(row ? JSON.parse(row.value) : {}).map(([id, severity]) => [Number(id), severity]));
  } catch (_) {
    return new Map();
  }
}
function saveDefaultFired(db, still) {
  try {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(DEFAULT_FIRED_KEY, JSON.stringify(Object.fromEntries(still)));
  } catch (_) {
    /* no settings table (tests): the default rule then tells every time */
  }
}

module.exports = { DEFAULT_RULE, listRules, activeRules, saveRule, deleteRule, spoolLevels, severityFor, reorderList, evaluate };
