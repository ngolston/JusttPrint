import { describe, expect, it } from 'vitest';
import { BACKGROUND_PRIORITY, DroppedError, LOW_PRIORITY, RenderQueue, type RenderTask } from './queue';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(render: (task: RenderTask<string | null>) => Promise<string | null> = async (t) => `img:${t.filePath}`) {
  const order: string[] = [];
  let drops = 0;
  const queue = new RenderQueue<string | null>({
    render: async (task) => {
      order.push(task.filePath);
      return render(task);
    },
    wait: () => Promise.resolve(),
    onDrop: () => {
      drops++;
    }
  });
  return { queue, order, drops: () => drops };
}

function task(filePath: string, priority: number, over: Partial<RenderTask<string | null>> = {}) {
  const result: { value?: string | null; error?: Error } = {};
  const t: RenderTask<string | null> = {
    filePath,
    priority,
    resolve: (v) => {
      result.value = v;
    },
    reject: (e) => {
      result.error = e;
    },
    ...over
  };
  return { t, result };
}

const card = (connected = true) => ({ isConnected: connected }) as HTMLElement;

describe('RenderQueue', () => {
  it('runs the lowest priority number first, within the limit', async () => {
    const { queue, order } = setup();
    queue.paused = true;
    queue.add(task('/bg', BACKGROUND_PRIORITY).t);
    queue.add(task('/far', LOW_PRIORITY + 10, { element: card() }).t);
    queue.add(task('/top', 5, { element: card() }).t);
    queue.max = 1;
    queue.paused = false;
    queue.pump();
    for (let i = 0; i < 6; i++) await flush();
    expect(order).toEqual(['/top', '/far', '/bg']);
  });

  it('uses the lower limit when only background work is left, and none while paused', () => {
    const { queue } = setup();
    queue.paused = true;
    queue.add(task('/a', BACKGROUND_PRIORITY).t);
    expect(queue.concurrency()).toBe(0);
    queue.paused = false;
    expect(queue.concurrency()).toBe(2);
  });

  it('drops a card job once its card leaves the page, but keeps scan work', async () => {
    const { queue, order, drops } = setup();
    queue.paused = true;
    const gone = task('/gone', 1, { element: card(false) });
    const scan = task('/scan', BACKGROUND_PRIORITY);
    queue.add(gone.t);
    queue.add(scan.t);
    queue.prune();
    expect(gone.result.error).toBeInstanceOf(DroppedError);
    expect(drops()).toBe(1);
    queue.paused = false;
    queue.pump();
    await flush();
    expect(order).toEqual(['/scan']);
  });

  it('when full, drops the lowest-priority card jobs first', () => {
    const { queue } = setup();
    queue.paused = true;
    queue.softCap = 3;
    const near = task('/near', 1, { element: card() });
    const far = task('/far', LOW_PRIORITY, { element: card() });
    const scan = task('/scan', BACKGROUND_PRIORITY);
    queue.add(near.t);
    queue.add(far.t);
    queue.add(scan.t);
    queue.add(task('/new', 2, { element: card() }).t);
    expect(far.result.error).toBeInstanceOf(DroppedError);
    expect(near.result.error).toBeUndefined();
    expect(scan.result.error).toBeUndefined();
    expect(queue.size).toBe(3);
  });

  it('finds a waiting card job, and re-ranks card jobs only', () => {
    const { queue } = setup();
    queue.paused = true;
    const a = task('/a', 50, { element: card() });
    const s = task('/s', BACKGROUND_PRIORITY);
    queue.add(a.t);
    queue.add(s.t);
    expect(queue.find('/a')).toBe(a.t);
    expect(queue.find('/s')).toBeUndefined();
    queue.rerank(() => 7);
    expect(a.t.priority).toBe(7);
    expect(s.t.priority).toBe(BACKGROUND_PRIORITY);
  });

  it('retries a failed render once, then gives up', async () => {
    let calls = 0;
    const { queue } = setup(async () => {
      calls++;
      throw new Error('bad mesh');
    });
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as { setTimeout: unknown }).setTimeout = (fn: () => void) => realSetTimeout(fn, 0);
    try {
      const t = task('/x', 1);
      queue.add(t.t);
      for (let i = 0; i < 10; i++) await flush();
      expect(calls).toBe(2);
      expect(t.result.error?.message).toBe('bad mesh');
    } finally {
      (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;
    }
  });

  it('does not retry without WebGL', async () => {
    let calls = 0;
    const { queue } = setup(async () => {
      calls++;
      throw new Error('Error creating WebGL context.');
    });
    const t = task('/x', 1);
    queue.add(t.t);
    for (let i = 0; i < 4; i++) await flush();
    expect(calls).toBe(1);
    expect(t.result.error).toBeTruthy();
  });
});
