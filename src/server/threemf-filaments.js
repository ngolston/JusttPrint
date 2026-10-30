'use strict';

/**
 * What each plate of a 3MF project needs (docs/merge-10.md, Phase 4): [{ plate, slot, material,
 * color, grams }]. plate and slot count from 1 as in the slicer; plate 0 means every plate.
 *
 * - Sliced (Metadata/slice_info.config has <filament> lines): exactly what each plate uses, with
 *   grams. Source '3mf'.
 * - Not sliced: the project's filaments (Metadata/project_settings.config: filament_colour and
 *   filament_type) that each plate's objects and parts are set to (model_settings.config), grams
 *   unknown. When the mesh is painted (paint_color, mmu_segmentation), any of the project's
 *   filaments may be used anywhere, so plate 0 needs them all. Source '3mf-project'.
 *
 * Bambu Studio, OrcaSlicer and their forks write these files; others give an empty list.
 */

const { withZipFileLock } = require('../core/zip-extract');

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 400;
const PAINT = /paint_color=|mmu_segmentation=|slic3rpe:mmu_segmentation/;

/** '#F8F8F8FF', 'f8f8f8' → '#f8f8f8'; anything else → null. */
function color(value) {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(value || '').trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}
const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
};
const metadataOf = (block) => {
  const out = {};
  for (const m of block.matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"/g)) if (!(m[1] in out)) out[m[1]] = m[2];
  return out;
};

/** Sliced plates' filaments from slice_info.config; an empty list when the file was not sliced. */
function slicedFilaments(sliceInfo) {
  const rows = [];
  for (const block of String(sliceInfo || '').match(/<plate>[\s\S]*?<\/plate>/g) || []) {
    const plate = Number(metadataOf(block).index);
    if (!Number.isInteger(plate) || plate < 1) continue;
    for (const tag of block.match(/<filament\b[^>]*>/g) || []) {
      const slot = Number(attr(tag, 'id'));
      if (!Number.isInteger(slot) || slot < 1) continue;
      const grams = Number(attr(tag, 'used_g'));
      rows.push({
        plate,
        slot,
        material: attr(tag, 'type') || null,
        color: color(attr(tag, 'color')),
        grams: Number.isFinite(grams) && grams > 0 ? Math.round(grams * 100) / 100 : null
      });
    }
  }
  return rows.slice(0, MAX_ROWS);
}

/** The project's filaments by slot (1-based): { material, color }. */
function projectFilaments(projectSettings) {
  let settings;
  try {
    settings = JSON.parse(String(projectSettings || ''));
  } catch (_) {
    return new Map();
  }
  const colors = Array.isArray(settings.filament_colour) ? settings.filament_colour : [];
  const types = Array.isArray(settings.filament_type) ? settings.filament_type : [];
  const out = new Map();
  for (let i = 0; i < Math.max(colors.length, types.length) && i < 64; i++)
    out.set(i + 1, { material: types[i] ? String(types[i]) : null, color: color(colors[i]) });
  return out;
}

/**
 * Which slots each plate's objects use, from model_settings.config: an object's extruder and its
 * parts' (an object without one uses slot 1). Plates without objects are left out.
 */
function slotsPerPlate(modelSettings) {
  const text = String(modelSettings || '');
  const objectSlots = new Map();
  for (const block of text.match(/<object\b[\s\S]*?<\/object>/g) || []) {
    const id = attr(block.slice(0, block.indexOf('>') + 1), 'id');
    if (!id) continue;
    const slots = new Set();
    const own = Number(metadataOf(block.replace(/<part\b[\s\S]*?<\/part>/g, '')).extruder);
    slots.add(Number.isInteger(own) && own > 0 ? own : 1);
    for (const part of block.match(/<part\b[\s\S]*?<\/part>/g) || []) {
      const extruder = Number(metadataOf(part).extruder);
      if (Number.isInteger(extruder) && extruder > 0) slots.add(extruder);
    }
    objectSlots.set(id, slots);
  }
  const plates = new Map();
  for (const block of text.match(/<plate>[\s\S]*?<\/plate>/g) || []) {
    const plate = Number(metadataOf(block).plater_id);
    if (!Number.isInteger(plate) || plate < 1) continue;
    const slots = new Set();
    for (const instance of block.match(/<model_instance>[\s\S]*?<\/model_instance>/g) || []) {
      for (const slot of objectSlots.get(metadataOf(instance).object_id) || []) slots.add(slot);
    }
    if (slots.size) plates.set(plate, slots);
  }
  // No plates written (an older or simpler project): every object is on plate 1.
  if (!plates.size && objectSlots.size) plates.set(1, new Set([...objectSlots.values()].flatMap((s) => [...s])));
  return plates;
}

/**
 * Filaments from the config texts (no file access). `painted` says whether the mesh has painted
 * colors. Returns { source, rows }; rows empty when the project says nothing usable.
 * @param {{ sliceInfo?: string, projectSettings?: string, modelSettings?: string, painted?: boolean }} input
 */
function plateFilamentsFrom({ sliceInfo = '', projectSettings = '', modelSettings = '', painted = false }) {
  const sliced = slicedFilaments(sliceInfo);
  if (sliced.length) return { source: '3mf', rows: sliced };
  const project = projectFilaments(projectSettings);
  if (!project.size) return { source: '3mf-project', rows: [] };
  const row = (plate, slot) => ({ plate, slot, material: project.get(slot)?.material ?? null, color: project.get(slot)?.color ?? null, grams: null });
  if (painted) return { source: '3mf-project', rows: [...project.keys()].map((slot) => row(0, slot)) };
  const rows = [];
  for (const [plate, slots] of slotsPerPlate(modelSettings)) {
    for (const slot of [...slots].sort((a, b) => a - b)) if (project.has(slot)) rows.push(row(plate, slot));
  }
  // No objects to go by: the first filament, for the whole model.
  if (!rows.length) rows.push(row(0, 1));
  return { source: '3mf-project', rows: rows.slice(0, MAX_ROWS) };
}

/** Does any mesh in the 3MF carry painted colors? Reads each model part until the first sign. */
async function isPainted(zip, entries) {
  for (const entry of Object.values(entries)) {
    if (!/\.model$/i.test(entry.name)) continue;
    const stream = await zip.stream(entry.name);
    const found = await new Promise((resolve, reject) => {
      let tail = '';
      stream.on('data', (chunk) => {
        const text = tail + chunk.toString('latin1');
        if (PAINT.test(text)) {
          stream.destroy();
          resolve(true);
          return;
        }
        tail = text.slice(-64);
      });
      stream.on('end', () => resolve(false));
      stream.on('close', () => resolve(false));
      stream.on('error', reject);
    });
    if (found) return true;
  }
  return false;
}

/** Read a 3MF file's plate filaments (see above). { source, rows }; rows empty for other files. */
async function readPlateFilaments(filePath) {
  if (!/\.3mf$/i.test(String(filePath)) || String(filePath).includes('::')) return { source: '3mf', rows: [] };
  const StreamZip = require('node-stream-zip');
  return withZipFileLock(filePath, async () => {
    const zip = new StreamZip.async({ file: filePath });
    try {
      const entries = await zip.entries();
      const read = async (name) => {
        const entry = Object.values(entries).find((e) => e.name.toLowerCase() === name.toLowerCase());
        if (!entry || entry.size > MAX_CONFIG_BYTES) return '';
        return (await zip.entryData(entry.name)).toString('utf8');
      };
      const sliceInfo = await read('Metadata/slice_info.config');
      if (slicedFilaments(sliceInfo).length) return plateFilamentsFrom({ sliceInfo });
      const projectSettings = await read('Metadata/project_settings.config');
      if (!projectFilaments(projectSettings).size) return { source: '3mf-project', rows: [] };
      return plateFilamentsFrom({
        projectSettings,
        modelSettings: await read('Metadata/model_settings.config'),
        painted: await isPainted(zip, entries)
      });
    } finally {
      await zip.close();
    }
  });
}

module.exports = { plateFilamentsFrom, readPlateFilaments, slicedFilaments, projectFilaments, slotsPerPlate };
