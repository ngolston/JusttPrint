import { describe, expect, it } from 'vitest';
import { sharedPrefix, shortLabel } from './KitChecklist';

describe('kit part labels', () => {
  it('says the model name they all start with once', () => {
    const labels = ['Orbiter - Plate 2', 'Orbiter - Back', 'Orbiter - Wing - Left'];
    const prefix = sharedPrefix(labels);
    expect(prefix).toBe('Orbiter - ');
    expect(labels.map((label) => shortLabel(label, prefix))).toEqual(['Plate 2', 'Back', 'Wing - Left']);
  });
  it('keeps labels with nothing in common, or a single part, whole', () => {
    expect(sharedPrefix(['Right Shoe', 'Left Shoe'])).toBe('');
    expect(sharedPrefix(['Orbiter - Plate 2'])).toBe('');
    expect(shortLabel('Orbiter - ', 'Orbiter - ')).toBe('Orbiter - ');
  });
});
