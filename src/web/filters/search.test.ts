import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A page with a grid that has 2000 models loaded and is scrolled to 840; the server answers in pages. */
function setupPage() {
  const grid = { scrollTop: 840, currentModels: new Array(2000).fill(null).map((_, i) => ({ filePath: `m${i}.stl` })) };
  const renders: number[] = [];
  const pages: Record<string, number> = { '500:0': 500, '1200:500': 1200, '1200:1700': 300 };
  vi.stubGlobal('document', {
    getElementById: () => null,
    querySelector: (selector: string) => (selector === '.file-grid' ? grid : null)
  });
  vi.stubGlobal('window', {
    location: { href: 'http://test/', pathname: '/', search: '' },
    gridRefresh: {
      shouldHoldProgressiveRender: (keep: boolean, length: number, shown: number, complete: boolean) => keep && !complete && length < shown
    },
    renderFiles: async (models: unknown[]) => {
      grid.scrollTop = 0;
      renders.push(models.length);
    }
  });
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0));
  vi.stubGlobal('requestIdleCallback', (fn: () => void) => setTimeout(fn, 0));
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const [filters] = JSON.parse(init.body).args as [{ limit: number; offset?: number }];
    const offset = filters.offset || 0;
    const count = pages[`${filters.limit}:${offset}`] ?? 0;
    const result = new Array(count).fill(null).map((_, i) => ({ filePath: `p${offset + i}.stl` }));
    return { ok: true, status: 200, text: async () => JSON.stringify({ result }) };
  });
  return { grid, renders };
}

const until = async (check: () => boolean) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('runSearch', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('restores scroll on a background refresh and skips the short first page', async () => {
    const { grid, renders } = setupPage();
    const { runSearch } = await import('./search');
    await runSearch({ preserveScroll: true });
    await until(() => (window as unknown as { _progressiveLibraryLoadActive?: boolean })._progressiveLibraryLoadActive === false && renders.length > 0);
    expect(renders).toEqual([2000]);
    expect(grid.scrollTop).toBe(840);
  });

  it('renders the first page at once for a user search, then everything', async () => {
    const { renders } = setupPage();
    const { runSearch } = await import('./search');
    await runSearch();
    expect(renders[0]).toBe(500);
    await until(() => renders.includes(2000));
  });

  it('a newer search stops the older one', async () => {
    const { renders } = setupPage();
    const { runSearch } = await import('./search');
    const first = runSearch({ force: true });
    const second = runSearch({ force: true });
    await Promise.all([first, second]);
    await until(() => renders.includes(2000));
    expect(renders.filter((n) => n === 2000)).toHaveLength(1);
  });
});
