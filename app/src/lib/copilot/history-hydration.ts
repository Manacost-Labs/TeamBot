export type HistoryHydrationOutcome<Value> =
  | { status: "ready"; value: Value }
  | { status: "failed"; error: unknown };

export type StableHistoryHydrationOutcome<Value, Target extends object> =
  | { status: "ready"; value: Value; target: Target }
  | { status: "failed"; error: unknown; target: Target };

/**
 * One authoritative history refresh shared by every send that reaches the gate while it is loading.
 *
 * A failed refresh is deliberately not remembered as success: the send that observed it stops, while
 * a later retry starts a new bounded read. `reset` separates channel identities and prevents a late
 * response for the previous thread from opening the current thread's gate.
 */
export class HistoryHydrationGate<Value> {
  private generation = 0;
  private hasReadyValue = false;
  private ready: Value | undefined;
  private pending: Promise<HistoryHydrationOutcome<Value>> | null = null;

  ensure(load: () => Promise<Value>): Promise<HistoryHydrationOutcome<Value>> {
    if (this.hasReadyValue) {
      return Promise.resolve({ status: "ready", value: this.ready as Value });
    }
    if (this.pending) return this.pending;

    const generation = this.generation;
    const pending = load().then<
      HistoryHydrationOutcome<Value>,
      HistoryHydrationOutcome<Value>
    >(
      (value) => {
        if (generation !== this.generation) {
          return {
            status: "failed",
            error: new Error("История относится к другому диалогу."),
          };
        }
        this.ready = value;
        this.hasReadyValue = true;
        return { status: "ready", value };
      },
      (error: unknown) => ({ status: "failed", error }),
    );
    this.pending = pending;
    void pending.finally(() => {
      if (generation === this.generation && this.pending === pending) {
        this.pending = null;
      }
    });
    return pending;
  }

  reset(): void {
    this.generation += 1;
    this.hasReadyValue = false;
    this.ready = undefined;
    this.pending = null;
  }
}

export function createHistoryHydrationGate<
  Value,
>(): HistoryHydrationGate<Value> {
  return new HistoryHydrationGate<Value>();
}

/**
 * Keeps an authoritative refresh tied to the runtime object that will consume it.
 *
 * `useAgent` may replace its provisional object while a request is awaiting history. Capturing that
 * object before the await reopens the race the join gate closes: the message and run land on an
 * object the screen no longer renders. This coordinator checks the object again after the await. A
 * replacement invalidates the old snapshot, starts one new shared refresh, and every concurrent
 * sender follows it to the same current target.
 */
export class StableHistoryHydration<Value, Target extends object> {
  private readonly gate = createHistoryHydrationGate<Value>();
  private observedTarget: Target | null = null;

  observeTarget(target: Target): void {
    if (this.observedTarget === target) return;
    if (this.observedTarget !== null) this.gate.reset();
    this.observedTarget = target;
  }

  /** Forget the current result so a person can explicitly retry a failed or stale read. */
  reset(): void {
    this.gate.reset();
  }

  async ensureCurrentTarget(
    currentTarget: () => Target,
    load: () => Promise<Value>,
  ): Promise<StableHistoryHydrationOutcome<Value, Target>> {
    while (true) {
      const target = currentTarget();
      this.observeTarget(target);
      const outcome = await this.gate.ensure(load);

      // Check before interpreting the outcome: another sender may already have observed the
      // replacement and reset this gate, in which case this outcome is deliberately obsolete.
      if (currentTarget() !== target) continue;
      return { ...outcome, target };
    }
  }
}

export function createStableHistoryHydration<
  Value,
  Target extends object,
>(): StableHistoryHydration<Value, Target> {
  return new StableHistoryHydration<Value, Target>();
}
