/**
 * Coalesce high-frequency streamed text snapshots before they reach an expensive renderer.
 *
 * The runtime already delivers the newest complete message snapshot. Keeping only the latest value
 * is therefore safer than appending deltas here: a reconnect or a duplicate event cannot duplicate
 * text. The scheduler only controls paint frequency; it never changes the text itself.
 */
export const STREAM_FLUSH_MS = 32;
export const MAX_RENDER_LAG_MS = 100;

// Browser timers are numbers, while Node's type definitions expose timer objects. The scheduler is
// intentionally runtime-agnostic so its clock can be replaced by deterministic test timers.
type TimerHandle = object | number;

type StreamTextSchedulerOptions = {
  flushMs?: number;
  maxRenderLagMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
};

/**
 * Small, cancelable latest-value scheduler for a streaming message.
 *
 * It follows a trailing-edge policy so one React update represents all protocol events received in
 * the window. A hard maximum render lag prevents a busy tab from keeping stale text indefinitely.
 */
export class StreamTextScheduler {
  private readonly flushMs: number;
  private readonly maxRenderLagMs: number;
  private readonly now: () => number;
  private readonly schedule: (
    callback: () => void,
    delay: number,
  ) => TimerHandle;
  private readonly cancel: (handle: TimerHandle) => void;
  private readonly onFlush: (value: string) => void;
  private pending: string | null = null;
  private timer: TimerHandle | null = null;
  private lastFlushAt: number | null = null;

  constructor(
    onFlush: (value: string) => void,
    options: StreamTextSchedulerOptions = {},
  ) {
    this.onFlush = onFlush;
    this.flushMs = Math.max(1, Math.floor(options.flushMs ?? STREAM_FLUSH_MS));
    this.maxRenderLagMs = Math.max(
      this.flushMs,
      Math.floor(options.maxRenderLagMs ?? MAX_RENDER_LAG_MS),
    );
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((callback, delay) =>
        setTimeout(callback, delay) as unknown as TimerHandle);
    this.cancel =
      options.cancel ??
      ((handle) => {
        clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
      });
  }

  push(value: string): void {
    this.pending = value;
    if (this.lastFlushAt !== null) {
      const elapsed = Math.max(0, this.now() - this.lastFlushAt);
      if (elapsed >= this.maxRenderLagMs) {
        this.flush();
        return;
      }
    }
    this.scheduleFlush();
  }

  flush(): void {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    if (this.pending === null) return;
    const value = this.pending;
    this.pending = null;
    this.lastFlushAt = this.now();
    this.onFlush(value);
  }

  cancelPending(): void {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return;
    const elapsed =
      this.lastFlushAt === null
        ? 0
        : Math.max(0, this.now() - this.lastFlushAt);
    const untilDeadline = Math.max(1, this.maxRenderLagMs - elapsed);
    this.timer = this.schedule(
      () => {
        this.timer = null;
        this.flush();
      },
      Math.min(this.flushMs, untilDeadline),
    );
  }
}
