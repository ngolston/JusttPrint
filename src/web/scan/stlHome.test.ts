import { describe, expect, it } from 'vitest';
import { parseDirectoryList, parseLegacyStlHome } from './stlHome';

describe('STL Home settings', () => {
  it('reads the JSON list without blanks or duplicates', () => {
    expect(parseDirectoryList('["/models/", " /models", "", "/Prints", "/prints/"]')).toEqual(['/models/', '/Prints']);
    expect(parseDirectoryList('not json')).toEqual([]);
    expect(parseDirectoryList('{"a":1}')).toEqual([]);
  });

  it('reads the older single setting in each of its forms', () => {
    expect(parseLegacyStlHome('/models')).toEqual(['/models']);
    expect(parseLegacyStlHome('/a; /b,/c\n/a')).toEqual(['/a', '/b', '/c']);
    expect(parseLegacyStlHome('["/x"]')).toEqual(['/x']);
    expect(parseLegacyStlHome('  ')).toEqual([]);
  });
});
