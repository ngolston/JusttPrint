import { describe, expect, it } from 'vitest';
import {
  STUDIO_DEFAULTS,
  applyOptionsFor,
  backdropHex,
  exportBasename,
  friendlyPreviewError,
  isImageOnlyExtension,
  isPreviewablePath,
  loadStudioSettings,
  normalizeStudioSettings,
  previewExtension
} from './studio';

describe('studio settings', () => {
  it('fills missing settings with defaults and renames lightbox', () => {
    expect(normalizeStudioSettings({ color: '#ff0000', background: 'lightbox' })).toEqual({ ...STUDIO_DEFAULTS, color: '#ff0000', background: 'solid' });
    expect(normalizeStudioSettings(null)).toEqual(STUDIO_DEFAULTS);
  });
  it('survives broken storage', () => {
    expect(loadStudioSettings({ getItem: () => '{not json' })).toEqual(STUDIO_DEFAULTS);
    expect(loadStudioSettings(null)).toEqual(STUDIO_DEFAULTS);
  });
  it('picks the backdrop color', () => {
    expect(backdropHex({ backdrop: 'charcoal', customBg: '#000000' })).toBe('#3a3d46');
    expect(backdropHex({ backdrop: 'custom', customBg: '#123456' })).toBe('#123456');
  });
  it('groups settings by the part of the scene they change', () => {
    expect(applyOptionsFor('light')).toEqual({ onlyLights: true });
    expect(applyOptionsFor('backdrop')).toEqual({ materials: false, room: true, reflection: true });
    expect(applyOptionsFor('reflectionGap')).toEqual({ materials: false, room: false, reflection: true });
    expect(applyOptionsFor('wireframe')).toEqual({ materials: false, room: false, reflection: false });
    expect(applyOptionsFor('color')).toEqual({});
    expect(applyOptionsFor('panelOpen')).toBeNull();
  });
});

describe('preview files', () => {
  it('reads extensions, inside ZIPs too', () => {
    expect(previewExtension('/m/a.STL')).toBe('stl');
    expect(previewExtension('/m/pack.zip::parts/b.3mf')).toBe('3mf');
    expect(isPreviewablePath('/m/x.step')).toBe(true);
    expect(isPreviewablePath('/m/x.gcode')).toBe(false);
    expect(isImageOnlyExtension('voxl')).toBe(true);
  });
  it('makes a safe image name and a readable error', () => {
    expect(exportBasename('My: model?.stl')).toBe('My- model-');
    expect(exportBasename('')).toBe('model-preview');
    expect(friendlyPreviewError(new Error("Error invoking remote method 'parse-3mf-preview': Error: Bad zip"))).toBe('Bad zip');
    expect(friendlyPreviewError(new Error('FATAL heap out of memory'))).toMatch(/ran out of memory/);
  });
});
