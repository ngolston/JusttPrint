import { describe, expect, it } from 'vitest';
import type { CategoryScan } from '../api';
import { scanSummary } from './CategoriesPage';

const run = (changes: Partial<CategoryScan>): CategoryScan => ({
  id: 1,
  running: false,
  stopping: false,
  phase: 'done',
  useAi: false,
  total: 10,
  processed: 10,
  placed: {},
  left: 0,
  aiTotal: 0,
  aiDone: 0,
  noPicture: 0,
  error: null,
  suggestions: [],
  ...changes
});

describe('Categorize Library summary', () => {
  it('says where the categories came from and what is left', () => {
    expect(scanSummary(run({ placed: { site: 3, folder: 1 }, left: 6 }))).toEqual([
      '3 models placed from the site they came from.',
      '1 model placed from their folder names.',
      '6 models still in no category.'
    ]);
  });

  it('counts what the AI looked at, without the models it skipped', () => {
    expect(scanSummary(run({ useAi: true, placed: { tag: 2 }, left: 8, aiTotal: 8, aiDone: 8, noPicture: 2, error: 'Rate limit exceeded' }))).toEqual([
      '2 models placed from their tags.',
      'The AI looked at 6 models (2 models without a picture skipped).',
      'Stopped: Rate limit exceeded'
    ]);
  });

  it('has nothing to do when every model has a category', () => {
    expect(scanSummary(run({ total: 0 }))).toEqual(['Every model is already in a category.']);
  });
});
