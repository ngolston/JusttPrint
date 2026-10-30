#!/usr/bin/env node
'use strict';

/**
 * Builds src/core/data/filament-catalog.json, the filament catalogue behind "Add from catalogue"
 * on the Filament page, from FilamentHub's app/data/filament_profiles_db.json (a snapshot of
 * 3dfilamentprofiles.com). Keeps only what JusttPrint uses, as rows under one list of fields, and
 * drops exact repeats.
 *
 *   node scripts/build-filament-catalog.js ../filamenthub/app/data/filament_profiles_db.json
 */

const fs = require('fs');
const path = require('path');

const FIELDS = [
  'id',
  'brand',
  'name',
  'material',
  'color_name',
  'color_hex',
  'diameter',
  'weight',
  'spool_weight',
  'density',
  'print_temp_min',
  'print_temp_max',
  'bed_temp_min',
  'bed_temp_max',
  'product_url'
];

const text = (value) => (value == null ? null : String(value).trim() || null);
const number = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);
const hex = (value) => {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
  return match ? `#${match[1].toLowerCase()}` : null;
};

function row(item) {
  const weight = Array.isArray(item.weights) && item.weights.length ? item.weights[0] : {};
  let density = number(item.density);
  // The source gives kg/m³ (1240); JusttPrint keeps g/cm³ (1.24).
  if (density !== null && density > 20) density = Math.round(density) / 1000;
  return [
    text(item.id),
    text(item.manufacturer),
    text(item.name),
    text(item.material),
    text(item.color_name),
    hex(item.color_hex),
    number(item.diameter),
    number(weight.weight),
    number(weight.spool_weight),
    density,
    number(item.print_temp_min),
    number(item.print_temp_max),
    number(item.bed_temp_min),
    number(item.bed_temp_max),
    text(item.product_url)
  ];
}

function main() {
  const source = process.argv[2];
  if (!source) {
    console.error('Usage: node scripts/build-filament-catalog.js <filament_profiles_db.json>');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(source, 'utf8'));
  const seen = new Set();
  const rows = [];
  for (const item of data.filaments || []) {
    const values = row(item);
    if (!values[0] || !values[1] || !values[2] || !values[3]) continue;
    const key = JSON.stringify(values.slice(1));
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(values);
  }
  rows.sort((a, b) => a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]) || a[3].localeCompare(b[3]));
  const out = path.join(__dirname, '..', 'src', 'core', 'data', 'filament-catalog.json');
  const body = { source: '3dfilamentprofiles.com, through FilamentHub', fetchedAt: data.fetched_at || null, fields: FIELDS, rows };
  fs.writeFileSync(out, `${JSON.stringify(body)}\n`);
  console.log(`${rows.length} filaments (${(data.filaments || []).length - rows.length} left out) → ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
}

main();
