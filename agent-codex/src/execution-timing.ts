import type { RunAgentInput } from "@ag-ui/core";

export type AgentTimingPhase =
  | "request_received"
  | "request_accepted"
  | "run_started"
  | "child_process_spawned"
  | "codex_initialized"
  | "codex_thread_started"
  | "codex_turn_started"
  | "first_reasoning"
  | "first_tool"
  | "first_text_delta"
  | "stream_cancelled"
  | "run_completed"
  | "run_error";

export type ExecutionTimingRecord = {
  type: "execution-timing";
  component: "agent-codex";
  phase: AgentTimingPhase;
  requestId: string;
  elapsedMs: number;
  runId?: string;
  threadId?: string;
  agentId?: string;
  errorType?: string;
};

type TimingDetails = Pick<ExecutionTimingRecord, "errorType">;

export type AgentExecutionTimingOptions = {
  /** Trusted adapter identity used when the managed runtime did not forward a bot id. */
  agentId?: string;
  requestId?: string;
  startedAt?: number;
  now?: () => number;
  sink?: (record: ExecutionTimingRecord) => void;
};

/** A monotonic, once-only, allowlisted recorder for one accepted AG-UI request. */
export class AgentExecutionTiming {
  private readonly seen = new Set<AgentTimingPhase>();

  constructor(
    private readonly correlation: Pick<
      ExecutionTimingRecord,
      "requestId" | "runId" | "threadId" | "agentId"
    >,
    private readonly startedAt: number,
    private readonly now: () => number,
    private readonly sink: (record: ExecutionTimingRecord) => void,
  ) {}

  /** Add only schema-validated correlation ids after the request body has been accepted. */
  correlate(input: RunAgentInput, fallbackAgentId?: string): void {
    const forwarded = input.forwardedProps as
      | { openbotBotId?: unknown }
      | undefined;
    const agentId =
      safeIdentifier(forwarded?.openbotBotId) ??
      safeIdentifier(fallbackAgentId);
    if (safeIdentifier(input.runId)) this.correlation.runId = input.runId;
    if (safeIdentifier(input.threadId))
      this.correlation.threadId = input.threadId;
    if (agentId) this.correlation.agentId = agentId;
  }

  record(phase: AgentTimingPhase, details: TimingDetails = {}): void {
    this.recordAt(phase, this.now(), details);
  }

  recordAt(
    phase: AgentTimingPhase,
    at: number,
    details: TimingDetails = {},
  ): void {
    if (this.seen.has(phase)) return;
    this.seen.add(phase);
    this.sink({
      type: "execution-timing",
      component: "agent-codex",
      phase,
      ...this.correlation,
      elapsedMs: elapsedMilliseconds(this.startedAt, at),
      ...details,
    });
  }
}

export function createAgentExecutionTiming(
  input: RunAgentInput | undefined,
  options: AgentExecutionTimingOptions = {},
): AgentExecutionTiming {
  const now = options.now ?? monotonicNow;
  const startedAt = options.startedAt ?? now();
  const requestId = safeIdentifier(options.requestId) ?? crypto.randomUUID();
  const timing = new AgentExecutionTiming(
    { requestId },
    startedAt,
    now,
    options.sink ?? writeAgentTiming,
  );
  if (input) timing.correlate(input, options.agentId);
  return timing;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)
    ? value
    : undefined;
}

function elapsedMilliseconds(startedAt: number, at: number): number {
  return Math.round(Math.max(0, at - startedAt) * 1_000) / 1_000;
}

function monotonicNow(): number {
  return performance.now();
}

function writeAgentTiming(record: ExecutionTimingRecord): void {
  const message = JSON.stringify(record);
  if (record.phase === "run_error") console.warn(message);
  else console.info(message);
}
