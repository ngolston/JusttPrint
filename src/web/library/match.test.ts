import { describe, expect, it } from 'vitest';
import { emptyFilterState, type FilterState } from '../filters/query';
import { isModelNew, modelMatchesFilters, ratingOf, type MatchModel } from './match';

const state = (over: Partial<FilterState>): FilterState => ({ ...emptyFilterState(), ...over });
const model = (over: Partial<MatchModel> = {}): MatchModel => ({ filePath: '/lib/a.stl', fileName: 'a.stl', ...over });

describe('modelMatchesFilters', () => {
  it('matches everything without filters', () => {
    expect(modelMatchesFilters(model(), state({}))).toBe(true);
  });

  it('compares the designer without case, and "None" means blank', () => {
    expect(modelMatchesFilters(model({ designer: 'Ann ' }), state({ designer: ['ann'] }))).toBe(true);
    expect(modelMatchesFilters(model({ designer: 'Bob' }), state({ designer: ['ann'] }))).toBe(false);
    expect(modelMatchesFilters(model({ designer: '  ' }), state({ designer: ['__none__'] }))).toBe(true);
    expect(modelMatchesFilters(model({ designer: 'Ann' }), state({ designer: ['__none__'] }))).toBe(false);
  });

  it('checks license and parent model exactly, and skips several values (the search decides)', () => {
    expect(modelMatchesFilters(model({ license: 'CC-BY' }), state({ license: ['CC-BY'] }))).toBe(true);
    expect(modelMatchesFilters(model({ parentModel: 'Kit' }), state({ parentModel: ['kit'] }))).toBe(false);
    expect(modelMatchesFilters(model({ designer: 'Zed' }), state({ designer: ['Ann', 'Bob'] }))).toBe(true);
  });

  it('checks new, favorite and ratings', () => {
    expect(modelMatchesFilters(model({ isNew: '1' }), state({ isNew: 'new' }))).toBe(true);
    expect(modelMatchesFilters(model({ isNew: 0 }), state({ isNew: 'new' }))).toBe(false);
    expect(modelMatchesFilters(model({ favorite: 1 }), state({ favorite: 'not-favorited' }))).toBe(false);
    expect(modelMatchesFilters(model({ rating: 0 }), state({ rating: 'unrated' }))).toBe(true);
    expect(modelMatchesFilters(model({ rating: '4' }), state({ rating: '4' }))).toBe(true);
    expect(modelMatchesFilters(model({ rating: 3 }), state({ ratingMin: '4' }))).toBe(false);
  });

  it('checks the file type by extension, and ZIP by entry path', () => {
    expect(modelMatchesFilters(model(), state({ fileType: 'STL' }))).toBe(true);
    expect(modelMatchesFilters(model(), state({ fileType: '3mf' }))).toBe(false);
    expect(modelMatchesFilters(model({ filePath: '/x.zip::a.stl' }), state({ fileType: 'zip' }))).toBe(true);
  });

  it('reads new flags and ratings in their stored forms', () => {
    expect([1, true, '1', 0, null].map((v) => isModelNew({ isNew: v }))).toEqual([true, true, true, false, false]);
    expect([undefined, 'x', -2, 3, 9].map(ratingOf)).toEqual([0, 0, 0, 3, 5]);
  });
});
