export type RunAdmissionSnapshot = {
  active: number;
  queued: number;
  draining: boolean;
  globalLimit: number;
  perAgentLimit: number;
  perActorLimit: 1;
  queueLimit: number;
  maxWaitMs: number;
};

export type RunAdmissionEvent = RunAdmissionSnapshot & {
  type: "managed-run-admission";
  event: "queued" | "admitted" | "released" | "rejected" | "timed_out";
  agentId: string;
  waitMs?: number;
};

export type RunAdmissionLease = {
  waitMs: number;
  release(): void;
};

export class RunQueueFullError extends Error {
  constructor() {
    super("managed run queue is full");
    this.name = "RunQueueFullError";
  }
}

export class RunQueueTimeoutError extends Error {
  constructor() {
    super("managed run queue wait timed out");
    this.name = "RunQueueTimeoutError";
  }
}

export class RunQueueAbortedError extends Error {
  constructor() {
    super("managed run queue wait was aborted");
    this.name = "RunQueueAbortedError";
  }
}

export class RunDrainingError extends Error {
  constructor() {
    super("managed runtime is draining for deployment");
    this.name = "RunDrainingError";
  }
}

type QueueEntry = {
  agentId: string;
  actorAdmissionKey: string;
  queuedAt: number;
  signal?: AbortSignal;
  timeout: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  resolve: (lease: RunAdmissionLease) => void;
  reject: (error: Error) => void;
};

type RunAdmissionOptions = {
  globalLimit: number;
  perAgentLimit: number;
  queueLimit: number;
  maxWaitMs: number;
  now?: () => number;
  sink?: (event: RunAdmissionEvent) => void;
};

/** A process-local, bounded gate for the single managed Codex runtime container. */
export class RunAdmission {
  private active = 0;
  private readonly activeByAgent = new Map<string, number>();
  private readonly activeByActor = new Map<string, number>();
  private readonly queued: QueueEntry[] = [];
  private readonly now: () => number;
  private readonly sink: (event: RunAdmissionEvent) => void;
  private draining = false;

  constructor(private readonly options: RunAdmissionOptions) {
    for (const [name, value] of Object.entries({
      globalLimit: options.globalLimit,
      perAgentLimit: options.perAgentLimit,
      maxWaitMs: options.maxWaitMs,
    })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive integer`);
      }
    }
    if (!Number.isSafeInteger(options.queueLimit) || options.queueLimit < 0) {
      throw new TypeError("queueLimit must be a non-negative integer");
    }
    this.now = options.now ?? (() => performance.now());
    this.sink =
      options.sink ?? ((event) => console.info(JSON.stringify(event)));
  }

  snapshot(): RunAdmissionSnapshot {
    return {
      active: this.active,
      queued: this.queued.length,
      draining: this.draining,
      globalLimit: this.options.globalLimit,
      perAgentLimit: this.options.perAgentLimit,
      perActorLimit: 1,
      queueLimit: this.options.queueLimit,
      maxWaitMs: this.options.maxWaitMs,
    };
  }

  acquire(
    agentId: string,
    actorAdmissionKey: string,
    signal?: AbortSignal,
  ): Promise<RunAdmissionLease> {
    if (!agentId) throw new TypeError("agentId is required");
    if (!isActorAdmissionKey(actorAdmissionKey)) {
      throw new TypeError("actor admission key is invalid");
    }
    if (signal?.aborted) return Promise.reject(new RunQueueAbortedError());
    if (this.draining) {
      this.emit("rejected", agentId);
      return Promise.reject(new RunDrainingError());
    }

    if (this.canAdmit(agentId, actorAdmissionKey)) {
      return Promise.resolve(
        this.admit(agentId, actorAdmissionKey, this.now()),
      );
    }
    if (this.queued.length >= this.options.queueLimit) {
      this.emit("rejected", agentId);
      return Promise.reject(new RunQueueFullError());
    }

    return new Promise<RunAdmissionLease>((resolve, reject) => {
      const entry: QueueEntry = {
        agentId,
        actorAdmissionKey,
        queuedAt: this.now(),
        signal,
        timeout: setTimeout(() => {
          if (!this.remove(entry)) return;
          this.cleanup(entry);
          this.emit("timed_out", agentId, this.now() - entry.queuedAt);
          reject(new RunQueueTimeoutError());
          this.drainQueue();
        }, this.options.maxWaitMs),
        resolve,
        reject,
      };
      if (signal) {
        entry.onAbort = () => {
          if (!this.remove(entry)) return;
          this.cleanup(entry);
          reject(new RunQueueAbortedError());
          this.drainQueue();
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.queued.push(entry);
      this.emit("queued", agentId);
      this.drainQueue();
    });
  }

  /** Stop admitting new work and fail queued work before a deployment waits for active runs. */
  startDraining(): RunAdmissionSnapshot {
    if (this.draining) return this.snapshot();
    this.draining = true;
    for (const entry of this.queued.splice(0)) {
      this.cleanup(entry);
      entry.reject(new RunDrainingError());
    }
    return this.snapshot();
  }

  /** Re-open admission when a deployment is cancelled or updated only a sibling service. */
  resume(): RunAdmissionSnapshot {
    this.draining = false;
    this.drainQueue();
    return this.snapshot();
  }

  private canAdmit(agentId: string, actorAdmissionKey: string): boolean {
    return (
      this.active < this.options.globalLimit &&
      (this.activeByAgent.get(agentId) ?? 0) < this.options.perAgentLimit &&
      (this.activeByActor.get(actorAdmissionKey) ?? 0) < 1
    );
  }

  private admit(
    agentId: string,
    actorAdmissionKey: string,
    queuedAt: number,
  ): RunAdmissionLease {
    this.active += 1;
    this.activeByAgent.set(agentId, (this.activeByAgent.get(agentId) ?? 0) + 1);
    this.activeByActor.set(
      actorAdmissionKey,
      (this.activeByActor.get(actorAdmissionKey) ?? 0) + 1,
    );
    const waitMs = Math.max(0, this.now() - queuedAt);
    this.emit("admitted", agentId, waitMs);
    let released = false;
    return {
      waitMs,
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        const remaining = (this.activeByAgent.get(agentId) ?? 1) - 1;
        if (remaining === 0) this.activeByAgent.delete(agentId);
        else this.activeByAgent.set(agentId, remaining);
        const actorRemaining =
          (this.activeByActor.get(actorAdmissionKey) ?? 1) - 1;
        if (actorRemaining === 0) {
          this.activeByActor.delete(actorAdmissionKey);
        } else {
          this.activeByActor.set(actorAdmissionKey, actorRemaining);
        }
        this.emit("released", agentId);
        this.drainQueue();
      },
    };
  }

  /** Admit the oldest request that is eligible, without one busy agent blocking another. */
  private drainQueue(): void {
    if (this.draining) return;
    while (this.active < this.options.globalLimit) {
      const index = this.queued.findIndex((entry) =>
        this.canAdmit(entry.agentId, entry.actorAdmissionKey),
      );
      if (index < 0) return;
      const [entry] = this.queued.splice(index, 1);
      if (!entry) return;
      this.cleanup(entry);
      if (entry.signal?.aborted) {
        entry.reject(new RunQueueAbortedError());
        continue;
      }
      entry.resolve(
        this.admit(entry.agentId, entry.actorAdmissionKey, entry.queuedAt),
      );
    }
  }

  private remove(entry: QueueEntry): boolean {
    const index = this.queued.indexOf(entry);
    if (index < 0) return false;
    this.queued.splice(index, 1);
    return true;
  }

  private cleanup(entry: QueueEntry): void {
    clearTimeout(entry.timeout);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
  }

  private emit(
    event: RunAdmissionEvent["event"],
    agentId: string,
    waitMs?: number,
  ): void {
    this.sink({
      type: "managed-run-admission",
      event,
      agentId,
      ...(waitMs === undefined ? {} : { waitMs: Math.round(waitMs) }),
      ...this.snapshot(),
    });
  }
}

/** Stable, opaque HMAC key stamped by the server; never expose or log its value. */
export function isActorAdmissionKey(value: unknown): value is string {
  return typeof value === "string" && /^oba_[A-Za-z0-9_-]{43}$/.test(value);
}
