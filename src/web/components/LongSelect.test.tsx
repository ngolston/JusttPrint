import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LongSelect, drawnItems } from './LongSelect';

const values = ['alpha', 'beta', 'gamma'];

describe('long select', () => {
  it('draws only the fixed choices and the shown value while closed', () => {
    const out = renderToStaticMarkup(
      <LongSelect id="pick" value="beta" onChange={() => {}} items={values}>
        <option value="">All</option>
      </LongSelect>
    );
    expect(out).toContain('id="pick"');
    expect(out).toContain('<option value="">All</option>');
    expect(out).toContain('<option value="beta" selected="">beta</option>');
    expect(out).not.toContain('alpha');
    expect(out).not.toContain('gamma');
  });

  it('labels the items its own way', () => {
    const tags = [
      { name: 'red', count: 2 },
      { name: 'blue', count: 5 }
    ];
    const out = renderToStaticMarkup(
      <LongSelect value="blue" onChange={() => {}} items={tags} optionValue={(t) => t.name} optionLabel={(t) => `${t.name} (${t.count})`} />
    );
    expect(out).toContain('<option value="blue" selected="">blue (5)</option>');
    expect(out).not.toContain('red');
  });

  it('draws every item once open, and none but the shown value while closed', () => {
    const same = (v: string) => v;
    expect(drawnItems(values, same, 'gamma', true)).toEqual(values);
    expect(drawnItems(values, same, 'gamma', false)).toEqual(['gamma']);
    expect(drawnItems(values, same, '', false)).toEqual([]);
    expect(drawnItems(values, same, 'delta', false)).toEqual([]);
  });
});
