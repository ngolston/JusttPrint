import { describe, expect, it } from 'vitest';
import {
  buildDisplayRecords, buildLayoutRows, cellPosition, dedupeModels, normalizePath, scrollTopForSelection,
  viewMetrics, visibleRows, type GridModel
} from './layout';

const none = { bundles: new Set<string>(), parentModels: new Set<string>() };
const model = (id: number, filePath: string, extra: Partial<GridModel> = {}): GridModel => ({ id, filePath, ...extra });

describe('normalizePath', () => {
  it('uses forward slashes, decodes, trims and upper-cases the drive letter', () => {
    expect(normalizePath(' c:\\Models\\a%20b.stl ')).toBe('C:/Models/a b.stl');
    expect(normalizePath('/srv/models/x.stl')).toBe('/srv/models/x.stl');
    expect(normalizePath('/bad%zz')).toBe('/bad%zz');
  });
});

describe('dedupeModels', () => {
  it('keeps one model per path, preferring the copy with an id', () => {
    const noId = { filePath: 'C:\\a.stl' } as GridModel;
    const withId = model(7, 'c:/a.stl');
    expect(dedupeModels([noId, model(2, '/b.stl'), withId])).toEqual([withId, model(2, '/b.stl')]);
  });
});

describe('buildDisplayRecords', () => {
  it('groups models with the same parent model at the first one, case-insensitively', () => {
    const records = buildDisplayRecords([
      model(1, '/a.stl', { parentModel: 'Dragon' }),
      model(2, '/b.stl'),
      model(3, '/c.stl', { parentModel: 'dragon ' })
    ], none);
    expect(records.map((record) => record.type)).toEqual(['group', 'model']);
    const group = records[0];
    expect(group.type === 'group' && [group.groupKind, group.groupKey, group.groupLabel, group.children.length, group.expanded])
      .toEqual(['parentModel', 'parent:dragon', 'Dragon', 2, false]);
  });

  it('shows the children after an expanded group', () => {
    const records = buildDisplayRecords([
      model(1, '/a.stl', { parentModel: 'P' }),
      model(2, '/b.stl', { parentModel: 'P' })
    ], { bundles: new Set(), parentModels: new Set(['parent:p']) });
    expect(records.map((record) => record.key)).toEqual(['group:parent:p', 'child:parent:p:id:1', 'child:parent:p:id:2']);
    expect(records[1].type === 'model' && records[1].parentGroupKey).toBe('parent:p');
  });

  it('bundles ZIP entries by archive before grouping by parent model', () => {
    const records = buildDisplayRecords([
      model(1, '/z/pack.zip::a.stl'),
      model(2, '/z/pack.zip::b.stl'),
      model(3, '/loose.stl')
    ], none);
    const bundle = records[0];
    expect(bundle.type === 'group' && [bundle.groupKind, bundle.groupKey, bundle.groupLabel]).toEqual(['bundle', 'bundle:zip:/z/pack.zip', 'pack.zip']);
  });

  it('a group of one stays a plain model, and a repeated path is shown once', () => {
    const records = buildDisplayRecords([model(1, '/a.stl', { parentModel: 'Solo' }), model(1, '/a.stl')], none);
    expect(records).toEqual([{ type: 'model', key: 'model:id:1', model: model(1, '/a.stl', { parentModel: 'Solo' }) }]);
  });
});

describe('layout', () => {
  const five = buildDisplayRecords([1, 2, 3, 4, 5].map((id) => model(id, `/${id}.stl`)), none);

  it('fills rows to the column count and stacks them with gaps', () => {
    const layout = buildLayoutRows(five, 2, 'detailed', 490, 450, 10, 20);
    expect(layout.rows.map((row) => [row.records.length, row.top])).toEqual([[2, 10], [2, 520], [1, 1030]]);
    expect(layout.totalHeight).toBe(1030 + 490 + 10);
  });

  it('gives groups their own row in list view', () => {
    const records = buildDisplayRecords([model(1, '/a', { parentModel: 'P' }), model(2, '/b', { parentModel: 'P' }), model(3, '/c')], none);
    const layout = buildLayoutRows(records, 1, 'list', 52, 52, 10, 4);
    expect(layout.rows.map((row) => row.type)).toEqual(['group', 'models']);
  });

  it('works out detailed columns and centers them', () => {
    const metrics = viewMetrics({ view: 'detailed', width: 1000, previewSize: 'm', mobileColumns: 0 });
    expect([metrics.columns, metrics.centeredOffset]).toEqual([3, (960 - 940) / 2]);
    const row = buildLayoutRows(five, 3, 'detailed', 490, 450, 10, 20).rows[0];
    expect(cellPosition(row, 2, metrics, 'detailed')).toEqual({ top: 10, left: 2 * 320 + 20 + 10, width: 300, height: 490 });
  });

  it('scales preview tiles to fill the width with a fixed column count', () => {
    const metrics = viewMetrics({ view: 'preview', width: 1000, previewSize: 'm', mobileColumns: 0 });
    expect([metrics.columns, metrics.cellWidth]).toEqual([6, Math.floor((1000 - 10) / 6)]);
    expect(viewMetrics({ view: 'preview', width: 600, previewSize: 'l', mobileColumns: 2 }).columns).toBe(2);
  });

  it('lists only rows near the viewport, and centers the selection', () => {
    const many = buildDisplayRecords(Array.from({ length: 40 }, (_, i) => model(i, `/${i}.stl`)), none);
    const layout = buildLayoutRows(many, 1, 'list', 52, 52, 10, 4);
    const shown = visibleRows(layout, 560, 300, 104);
    expect(shown[0].top).toBeGreaterThanOrEqual(560 - 104 - 52);
    expect(shown[shown.length - 1].top).toBeLessThanOrEqual(560 + 300 + 104);
    const target = scrollTopForSelection(layout, 300, (path) => path === '/20.stl');
    const row = layout.rows[20];
    expect(target).toBe(row.top - (300 - 52) / 2);
    expect(scrollTopForSelection(layout, 300, () => false)).toBeNull();
  });
});
