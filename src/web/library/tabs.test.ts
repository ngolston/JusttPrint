import { describe, expect, it } from 'vitest';
import { emptyFilterState } from '../filters/query';
import { LIBRARY_TABS, extraFilterCount, tabInfo, tabOf } from './tabs';

describe('library tabs', () => {
  it('maps each tab to its filters and back', () => {
    for (const tab of LIBRARY_TABS) expect(tabOf({ printed: tab.printed, favorite: tab.favorite })).toBe(tab.id);
    expect(tabInfo('queue').printed).toBe('in-queue');
    expect(tabInfo('favorites')).toMatchObject({ printed: 'all', favorite: 'favorited' });
  });

  it('matches no tab for other print filters or mixed choices', () => {
    expect(tabOf({ printed: 'failed', favorite: 'all' })).toBeNull();
    expect(tabOf({ printed: 'printed', favorite: 'favorited' })).toBeNull();
    expect(tabOf({ printed: '', favorite: '' })).toBe('all');
  });

  it('counts the filters set besides the tab', () => {
    const state = emptyFilterState();
    expect(extraFilterCount(state)).toBe(0);
    expect(extraFilterCount({ ...state, printed: 'printed' })).toBe(0);
    expect(extraFilterCount({ ...state, printed: 'failed' })).toBe(1);
    expect(extraFilterCount({ ...state, printed: 'printed', favorite: 'favorited' })).toBe(2);
    expect(extraFilterCount({
      ...state, designer: ['A'], tags: ['x', 'y'], fileType: 'stl', ratingMin: '3', directory: '/lib/a',
      tokens: [{ t: 'clause', field: 'all', value: 'cube' }, { t: 'op', op: 'OR' }, { t: 'filter', kind: 'license', value: 'MIT' }]
    })).toBe(7);
  });
});
