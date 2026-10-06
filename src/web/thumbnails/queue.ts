/**
 * The thumbnail queue: model renders waiting their turn. On-screen grid cards go first (lower
 * priority number = sooner), off-screen cards and scan work after, and a card that leaves the
 * page drops its job. Only a few WebGL renders run at once, fewer while only background work is
 * left, and none while the server's bulk job runs. Plain logic; the render is passed in.
 */

export interface RenderTask<T = unknown> {
  filePath: string;
  /** Lower runs first. */
  priority: number;
  /** A grid card's slot: the job is dropped when it leaves the page. None for scan and bulk work. */
  element?: HTMLElement | null;
  resolve(result: T): void;
  reject(error: Error): void;
  /** Already failed once. */
  retried?: boolean;
}

/** A job was dropped (its card scrolled away, or the queue was full). Not a failure. */
export class DroppedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DroppedError';
  }
}

/** Priorities at or above this are off-screen grid rows and background work. */
export const LOW_PRIORITY = 2e9;
/** Scan and bulk jobs. */
export const BACKGROUND_PRIORITY = 1e12;

export interface QueueOptions<T> {
  render(task: RenderTask<T>): Promise<T>;
  /** Pause after each render (ms), so scrolling stays smooth. */
  wait(ms: number): Promise<void>;
  /** A job was dropped (the grid may want to queue visible cards again). */
  onDrop?(): void;
}

export class RenderQueue<T> {
  private tasks: RenderTask<T>[] = [];
  private running = new Set<string>();
  /** Parallel renders, and the limit while only low-priority work is left. */
  max = 5;
  backgroundMax = 2;
  delay = 200;
  backgroundDelay = 750;
  softCap = 120;
  /** The server's bulk thumbnail job runs: no renders here meanwhile. */
  paused = false;

  constructor(private options: QueueOptions<T>) {}

  get size() { return this.tasks.length; }
  get active() { return this.running.size; }

  /** The waiting job for a model (grid cards only). */
  find(filePath: string): RenderTask<T> | undefined {
    return this.tasks.find((task) => task.filePath === filePath && task.element !== undefined);
  }

  isRunning(filePath: string): boolean {
    return this.running.has(filePath);
  }

  private drop(task: RenderTask<T>, reason: string) {
    task.reject(new DroppedError(reason));
    this.options.onDrop?.();
  }

  /** Drop jobs whose card left the page. */
  prune() {
    this.tasks = this.tasks.filter((task) => {
      const gone = !!task.element && !task.element.isConnected;
      if (gone) this.drop(task, 'Card left the page');
      return !gone;
    });
  }

  add(task: RenderTask<T>) {
    this.prune();
    if (this.tasks.length >= this.softCap) {
      // Make room by dropping the lowest-priority card jobs (never scan or bulk work).
      const droppable = this.tasks.filter((t) => t.element).sort((a, b) => b.priority - a.priority);
      while (this.tasks.length >= this.softCap && droppable.length) {
        const dropped = droppable.shift()!;
        this.tasks.splice(this.tasks.indexOf(dropped), 1);
        this.drop(dropped, 'Queue full');
      }
    }
    this.tasks.push(task);
    this.pump();
  }

  /** Re-rank waiting card jobs (rank returns null to keep a job's priority). */
  rerank(rank: (task: RenderTask<T>) => number | null) {
    for (const task of this.tasks) {
      if (!task.element) continue;
      const priority = rank(task);
      if (priority !== null) task.priority = priority;
    }
  }

  private onlyLowPriority(): boolean {
    return this.tasks.length > 0 && this.tasks.every((task) => task.priority >= LOW_PRIORITY);
  }

  /** How many renders may run now. */
  concurrency(): number {
    if (this.paused) return 0;
    return this.onlyLowPriority() ? Math.min(this.max, this.backgroundMax) : this.max;
  }

  private next(): RenderTask<T> | undefined {
    this.prune();
    if (!this.tasks.length) return undefined;
    let best = 0;
    for (let i = 1; i < this.tasks.length; i++) if (this.tasks[i].priority < this.tasks[best].priority) best = i;
    return this.tasks.splice(best, 1)[0];
  }

  /** Start as many waiting jobs as the limit allows. */
  pump() {
    while (this.running.size < this.concurrency()) {
      const task = this.next();
      if (!task) return;
      this.start(task);
    }
  }

  private async start(task: RenderTask<T>) {
    this.running.add(task.filePath);
    try {
      task.resolve(await this.options.render(task));
    } catch (raw) {
      const error = raw instanceof Error ? raw : new Error(String(raw));
      // Without WebGL, retrying cannot help; other failures get one more try.
      if (error instanceof DroppedError || task.retried || /Error creating WebGL context/i.test(error.message)) {
        task.reject(error);
      } else {
        console.error(`Thumbnail render failed, retrying once: ${error.message}`);
        task.retried = true;
        setTimeout(() => this.add(task), 2000);
      }
    } finally {
      this.running.delete(task.filePath);
      await this.options.wait(task.priority >= LOW_PRIORITY ? this.backgroundDelay : this.delay);
      this.pump();
    }
  }
}
