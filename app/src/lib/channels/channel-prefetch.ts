import type { QueryClient, QueryKey } from "@tanstack/react-query";

type PrefetchTask = (signal: AbortSignal) => Promise<unknown>;

type ChannelPrefetchSchedulerOptions = {
  maxConcurrent?: number;
  maxQueued?: number;
  taskTimeoutMs?: number;
};

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUED = 4;
const DEFAULT_TASK_TIMEOUT_MS = 5_000;

type QueuedTask = {
  generation: number;
  task: PrefetchTask;
};

type RunningTask = {
  controller: AbortController;
  finish: () => void;
  generation: number;
};

/**
 * A small latest-wins queue for speculative channel reads.
 *
 * Hover is only a hint. It must not turn a quick pass over the roster into one full history request
 * per row, so at most two channel jobs run and only the newest bounded set waits behind them.
 * Repeating hover/focus for the same channel replaces its queued callback instead of adding work.
 */
export class ChannelPrefetchScheduler {
  private readonly inFlight = new Map<string, RunningTask>();
  private readonly queued = new Map<string, QueuedTask>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly taskTimeoutMs: number;
  private generation = 0;
  private sessionScope: string | null = null;

  constructor(options: ChannelPrefetchSchedulerOptions = {}) {
    this.maxConcurrent = boundedInteger(
      options.maxConcurrent,
      DEFAULT_MAX_CONCURRENT,
      1,
    );
    this.maxQueued = boundedInteger(options.maxQueued, DEFAULT_MAX_QUEUED, 0);
    this.taskTimeoutMs = boundedInteger(
      options.taskTimeoutMs,
      DEFAULT_TASK_TIMEOUT_MS,
      1,
    );
  }

  /**
   * Move speculative work to one authenticated scope.
   *
   * Running callbacks receive an abort signal, while their scheduler records are removed
   * immediately. A callback that ignores cancellation therefore cannot occupy a slot or drain an
   * old queue into the next user's session.
   */
  activateScope(sessionScope: string): string | null {
    if (this.sessionScope === sessionScope) return null;
    const previousScope = this.sessionScope;
    this.generation += 1;
    this.sessionScope = sessionScope;
    this.queued.clear();
    for (const running of this.inFlight.values()) {
      running.controller.abort(new Error("Authenticated session changed"));
      running.finish();
    }
    this.inFlight.clear();
    this.resolveIdle();
    return previousScope;
  }

  cancelScope(sessionScope: string): void {
    if (this.sessionScope !== sessionScope) return;
    this.generation += 1;
    this.sessionScope = null;
    this.queued.clear();
    for (const running of this.inFlight.values()) {
      running.controller.abort(new Error("Authenticated session ended"));
      running.finish();
    }
    this.inFlight.clear();
    this.resolveIdle();
  }

  schedule(sessionScope: string, key: string, task: PrefetchTask): void {
    this.activateScope(sessionScope);
    const generation = this.generation;
    if (this.inFlight.has(key)) return;

    if (this.queued.has(key)) {
      // A second focus/hover carries the newest closures and makes this channel newest in the queue.
      this.queued.delete(key);
      this.queued.set(key, { generation, task });
      return;
    }

    if (this.inFlight.size < this.maxConcurrent) {
      this.start(key, { generation, task });
      return;
    }

    this.queued.set(key, { generation, task });
    while (this.queued.size > this.maxQueued) {
      const oldest = this.queued.keys().next().value;
      if (oldest === undefined) break;
      this.queued.delete(oldest);
    }
  }

  /** Test/diagnostic seam: resolves after both running and retained queued work have settled. */
  whenIdle(): Promise<void> {
    if (this.inFlight.size === 0 && this.queued.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private start(key: string, queued: QueuedTask): void {
    if (queued.generation !== this.generation) return;
    const controller = new AbortController();
    let finish = () => {};
    const stopped = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const running = { controller, finish, generation: queued.generation };
    this.inFlight.set(key, running);

    let deadline: ReturnType<typeof setTimeout> | undefined;
    deadline = setTimeout(() => {
      controller.abort(new Error("Channel prefetch deadline exceeded"));
      finish();
    }, this.taskTimeoutMs);
    const settled = Promise.resolve()
      .then(() => queued.task(controller.signal))
      .then(
        () => {},
        () => {},
      );

    void Promise.race([settled, stopped]).finally(() => {
      if (deadline !== undefined) clearTimeout(deadline);
      if (
        running.generation !== this.generation ||
        this.inFlight.get(key) !== running
      )
        return;
      this.inFlight.delete(key);
      this.drain();
      this.resolveIdle();
    });
  }

  private drain(): void {
    while (this.inFlight.size < this.maxConcurrent) {
      const next = this.queued.entries().next().value;
      if (next === undefined) return;
      const [key, queued] = next;
      this.queued.delete(key);
      if (queued.generation !== this.generation) continue;
      this.start(key, queued);
    }
  }

  private resolveIdle(): void {
    if (this.inFlight.size > 0 || this.queued.size > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

type ChannelPrefetchRequest = {
  channelId: string;
  threadId: string;
  agentId: string;
  /** Authenticated user scope: speculative caches must never deduplicate across sign-ins. */
  sessionScope: string;
  prefetchMetadata: PrefetchTask;
  prefetchHistory?: PrefetchTask;
  /** Clears caches whose query keys are shared across authenticated sessions. */
  onScopeChange?: (previousScope: string) => void;
};

export const channelPrefetchScheduler = new ChannelPrefetchScheduler();

function requestKey(request: ChannelPrefetchRequest): string {
  return [
    request.sessionScope,
    request.channelId,
    request.threadId,
    request.agentId,
  ]
    .map(encodeURIComponent)
    .join(":");
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : fallback;
}

/** Cancel a speculative metadata query only while nobody has promoted it into an active view. */
export async function runMetadataPrefetch({
  signal,
  queryClient,
  queryKey,
  prefetch,
}: {
  signal: AbortSignal;
  queryClient: QueryClient;
  queryKey: QueryKey;
  prefetch: () => Promise<unknown>;
}): Promise<void> {
  const cancelIfUnobserved = () => {
    const query = queryClient.getQueryCache().find({ exact: true, queryKey });
    if (query?.getObserversCount() !== 0) return;
    void queryClient.cancelQueries({ exact: true, queryKey });
  };

  if (signal.aborted) {
    cancelIfUnobserved();
    return;
  }
  signal.addEventListener("abort", cancelIfUnobserved, { once: true });
  try {
    await prefetch();
  } finally {
    signal.removeEventListener("abort", cancelIfUnobserved);
  }
}

/** Warm metadata and recent transcript as one bounded unit without starting a runtime/model run. */
export function scheduleChannelPrefetch(
  request: ChannelPrefetchRequest,
  scheduler: ChannelPrefetchScheduler = channelPrefetchScheduler,
): void {
  const previousScope = scheduler.activateScope(request.sessionScope);
  if (previousScope !== null) request.onScopeChange?.(previousScope);
  scheduler.schedule(
    request.sessionScope,
    requestKey(request),
    async (signal) => {
      const jobs = [request.prefetchMetadata];
      if (request.prefetchHistory) jobs.push(request.prefetchHistory);
      await Promise.allSettled(
        jobs.map((job) => Promise.resolve().then(() => job(signal))),
      );
    },
  );
}

/** Stop queued/running hover work before an authenticated session is discarded. */
export function cancelChannelPrefetchScope(
  sessionScope: string,
  scheduler: ChannelPrefetchScheduler = channelPrefetchScheduler,
): void {
  scheduler.cancelScope(sessionScope);
}
