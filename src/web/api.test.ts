import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A fetch stand-in: records each request; /api/batch answers its calls one line each, the last first. */
function fakeBackend(answer: (name: string, args: unknown[]) => unknown) {
  const requests: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (url === '/api/batch') {
      const lines = body.calls
        .map((call: { name: string; args: unknown[] }, i: number) => {
          const value = answer(call.name, call.args);
          return JSON.stringify(value instanceof Error ? { i, error: value.message, status: 403 } : { i, result: value });
        })
        .reverse();
      return new Response(`${lines.join('\n')}\n`, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
    }
    const name = decodeURIComponent(url.replace('/api/actions/', ''));
    return new Response(JSON.stringify({ result: answer(name, body.args) }), { status: 200 });
  });
  return requests;
}

describe('reads made at once go in one batch (src/server/api.js /api/batch)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', { addEventListener: () => {}, dispatchEvent: () => {}, location: { href: '', pathname: '/', search: '' } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the reads asked for together in one request, each with its own answer', async () => {
    const requests = fakeBackend((name, args) => (name === 'get-setting' ? `value of ${args[0]}` : { counts: true }));
    const { callAction } = await import('./api');
    const answers = await Promise.all([callAction('get-setting', 'homeLayout'), callAction('get-setting', 'uiColorScheme'), callAction('get-library-counts')]);
    expect(answers).toEqual(['value of homeLayout', 'value of uiColorScheme', { counts: true }]);
    expect(requests.map((r) => r.url)).toEqual(['/api/batch']);
    expect(requests[0].body.calls).toHaveLength(3);
  });

  it('asks only once for the same read while it is on its way, and gives each caller a copy', async () => {
    const requests = fakeBackend(() => ({ untagged: 4 }));
    const { callAction } = await import('./api');
    const [a, b] = await Promise.all([callAction<{ untagged: number }>('get-library-attention'), callAction<{ untagged: number }>('get-library-attention')]);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/api/actions/get-library-attention');
    expect(a).toEqual(b);
    a.untagged = 0;
    expect(b.untagged).toBe(4);
  });

  it('a refused call fails alone; changes are never batched', async () => {
    const requests = fakeBackend((name) => (name === 'get-default-ai-prompt' ? new Error('Viewer accounts cannot do this.') : 'ok'));
    const { callAction, ApiError } = await import('./api');
    const read = callAction('get-setting', 'x');
    const refused = callAction('get-default-ai-prompt');
    const change = callAction('save-setting', 'x', 'y');
    await expect(read).resolves.toBe('ok');
    await expect(refused).rejects.toBeInstanceOf(ApiError);
    await expect(change).resolves.toBe('ok');
    // The reads asked for first leave first.
    expect(requests.map((r) => r.url)).toEqual(['/api/batch', '/api/actions/save-setting']);
  });
});
