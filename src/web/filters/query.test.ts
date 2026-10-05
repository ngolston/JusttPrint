import { describe, expect, it } from 'vitest';
import {
  appendClause, appendNot, appendOp, awaitingOperand, clearedState, consumeIntoQuery, describePayload, emptyFilterState,
  filterStrip, invertNext, normalizeTokens, payloadIsFiltered, removeToken, serverFilters, type FilterState, type Labels
} from './query';

const labels: Labels = {
  printed: (v) => ({ printed: 'Printed', 'ever-printed': 'Ever printed' } as Record<string, string>)[v] || v,
  filament: (id) => ({ '7': 'Acme PLA (PLA)' } as Record<string, string>)[id] || id
};
const state = (patch: Partial<FilterState> = {}): FilterState => ({ ...emptyFilterState(), ...patch });

describe('serverFilters', () => {
  it('sends nothing narrowing for the empty state', () => {
    const f = serverFilters(state());
    expect(f).toMatchObject({
      designerInverted: false, dateAdded: null, printed: undefined, isNew: undefined, favorite: undefined,
      rating: undefined, ratingMin: undefined, fileType: '', search: '', searchIncludeNotes: true
    });
    expect(f).not.toHaveProperty('designers');
    expect(payloadIsFiltered(f)).toBe(false);
  });

  it('sends multi-value filters with their combine mode (one value is OR)', () => {
    const f = serverFilters(state({ designer: ['Bob'], tags: ['a', 'b'], filaments: ['7'], printed: 'printed', directory: '/m' }));
    expect(f).toMatchObject({
      designers: ['Bob'], designerCombine: 'OR', tags: ['a', 'b'], tagCombine: 'AND', filaments: ['7'], filamentCombine: 'OR',
      printed: 'printed', directory: '/m'
    });
    expect(payloadIsFiltered(f)).toBe(true);
  });

  it('sends the query and drops sidebar filters of kinds the query decides', () => {
    const f = serverFilters(state({
      designer: ['Bob'], printed: 'printed',
      tokens: [{ t: 'clause', field: 'all', value: 'cube' }, { t: 'op', op: 'AND' }, { t: 'filter', kind: 'designer', value: 'Ann' }, { t: 'op', op: 'OR' }]
    }));
    expect(f.searchTokens).toEqual([{ t: 'clause', field: 'all', value: 'cube' }, { t: 'op', op: 'AND' }, { t: 'filter', kind: 'designer', value: 'Ann' }]);
    expect(f).not.toHaveProperty('designers');
    expect(f.printed).toBe('printed');
    expect(f).not.toHaveProperty('search');
  });
});

describe('normalizeTokens', () => {
  it('drops empty and invalid tokens, collapses repeated operators and trailing ones', () => {
    expect(normalizeTokens([
      { t: 'clause', field: 'all', value: ' ' },
      { t: 'clause', field: 'all', value: 'a' }, { t: 'op', op: 'AND' }, { t: 'op', op: 'AND' },
      { t: 'filter', kind: 'printed', value: 'bogus' }, { t: 'filter', kind: 'rating', value: '4' }, { t: 'op', op: 'OR' }, { t: 'not' }
    ])).toEqual([{ t: 'clause', field: 'all', value: 'a' }, { t: 'op', op: 'AND' }, { t: 'filter', kind: 'rating', value: '4' }]);
  });
});

describe('query editing', () => {
  it('joins searches with AND', () => {
    const s = appendClause(appendClause(state(), 'all', ' cube '), 'designer', 'Bob');
    expect(s.tokens).toEqual([{ t: 'clause', field: 'all', value: 'cube' }, { t: 'op', op: 'AND' }, { t: 'clause', field: 'designer', value: 'Bob' }]);
    expect(appendClause(s, 'all', '  ')).toBe(s);
  });

  it('moves the sidebar filters into the query on the first operator, then waits for an operand', () => {
    const s = appendOp(state({ designer: ['Bob'], printed: 'printed' }), 'OR');
    expect(s.tokens).toEqual([
      { t: 'filter', kind: 'printed', value: 'printed' }, { t: 'op', op: 'AND' }, { t: 'filter', kind: 'designer', value: 'Bob' }, { t: 'op', op: 'OR' }
    ]);
    expect(s.designer).toEqual([]);
    expect(s.printed).toBe('all');
    expect(awaitingOperand(s)).toBe(true);
    const switched = appendOp(s, 'AND');
    expect(switched.tokens[switched.tokens.length - 1]).toEqual({ t: 'op', op: 'AND' });
    const picked = consumeIntoQuery(s, { t: 'filter', kind: 'tag', value: 'x' })!;
    expect(picked.tokens[picked.tokens.length - 1]).toEqual({ t: 'filter', kind: 'tag', value: 'x' });
    expect(picked.awaiting).toBe(false);
    expect(consumeIntoQuery(picked, { t: 'filter', kind: 'tag', value: 'y' })).toBeNull();
  });

  it('adds NOT after an operand with AND, and does nothing for AND with no query', () => {
    expect(appendNot(appendClause(state(), 'all', 'a')).tokens).toEqual([{ t: 'clause', field: 'all', value: 'a' }, { t: 'op', op: 'AND' }, { t: 'not' }]);
    expect(appendNot(state()).tokens).toEqual([{ t: 'not' }]);
    expect(appendOp(state(), 'AND').tokens).toEqual([]);
    expect(removeToken(appendClause(state(), 'all', 'a'), 0).tokens).toEqual([]);
  });

  it('inverts the first active kind in order', () => {
    expect(invertNext(state({ designer: ['Bob'], tags: ['t'] }))!.inverted.tag).toBe(true);
    expect(invertNext(state({ designer: ['Bob'] }))!.inverted.designer).toBe(true);
    expect(invertNext(state(), 'typed')!.inverted.search).toBe(true);
    expect(invertNext(state())).toBeNull();
  });

  it('clears filters but keeps sort, notes and combine choices', () => {
    const cleared = clearedState(state({ sort: 'name-asc', includeNotes: false, tags: ['a'], directory: '/x', dateAdded: '2026', inverted: { ...emptyFilterState().inverted, tag: true } }));
    expect(cleared).toMatchObject({ sort: 'name-asc', includeNotes: false, tags: [], directory: '', dateAdded: null, viewingEntireLibrary: true });
    expect(cleared.inverted.tag).toBe(false);
  });
});

describe('describePayload', () => {
  it('summarizes a payload', () => {
    const f = serverFilters(state({ designer: ['Bob'], filaments: ['7'], printed: 'ever-printed', directory: '/m/Shapes', includeNotes: false, tokens: [{ t: 'clause', field: 'all', value: 'x' }] }));
    expect(describePayload(f, labels)).toBe('Designer: Bob · Filament: Acme PLA (PLA) · Ever printed · Folder: Shapes · Query · notes off');
    expect(describePayload({ search: 'cube' }, labels)).toBe('Search: cube');
  });
});

describe('filterStrip', () => {
  it('is inactive with no filters', () => {
    expect(filterStrip(state(), labels)).toEqual({ active: false, chain: [], chips: [] });
  });

  it('shows the query, then the tags joined by AND, then the other filters', () => {
    const strip = filterStrip(state({
      tokens: [{ t: 'clause', field: 'all', value: 'cube' }],
      tags: ['a', 'b'], designer: ['__none__'], rating: '1', directory: '/m', includeNotes: false
    }), labels);
    expect(strip.active).toBe(true);
    expect(strip.chain.map((i) => i.kind === 'chip' || i.kind === 'op' || i.kind === 'combineHint' ? i.text : i.kind)).toEqual([
      'Search: "cube"', 'connector', 'Tag: a', 'connector', 'Tag: b', '(all)'
    ]);
    expect(strip.chain[0]).toMatchObject({ notesOff: true, remove: { type: 'token', index: 0 } });
    expect(strip.chips.map((i) => (i.kind === 'chip' ? i.text : ''))).toEqual(['Designer: No designer', 'Rating: 1 star', 'Directory: /m']);
  });

  it('labels filters moved into the query and marks inverted ones', () => {
    const strip = filterStrip(state({
      tokens: [{ t: 'filterMulti', kind: 'tag', values: ['a', 'b'], combine: 'OR' }, { t: 'op', op: 'AND' }, { t: 'filter', kind: 'filament', value: '7' }],
      inverted: { ...emptyFilterState().inverted, tag: true }
    }), labels);
    expect(strip.chain).toMatchObject([
      { kind: 'chip', text: 'Tag: a, b (any)', inverted: true }, { kind: 'op', text: 'AND' }, { kind: 'chip', text: 'Filament: Acme PLA (PLA)', inverted: false }
    ]);
  });
});
