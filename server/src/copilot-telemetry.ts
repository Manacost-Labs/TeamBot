export type RuntimeTimingPhase =
  | "request_received"
  | "route_resolved"
  | "request_accepted"
  | "submit_ack"
  | "connect_ack"
  | "request_error";

export type ExecutionTimingRecord = {
  type: "execution-timing";
  component: "server-runtime";
  phase: RuntimeTimingPhase;
  requestId: string;
  elapsedMs: number;
  runId?: string;
  threadId?: string;
  agentId?: string;
  status?: number;
  errorType?: string;
};

type TimingDetails = Pick<ExecutionTimingRecord, "status" | "errorType">;
type TimingCorrelation = Pick<
  ExecutionTimingRecord,
  "requestId" | "runId" | "threadId" | "agentId"
>;

export type RuntimeTimingOptions = {
  now?: () => number;
  requestId?: () => string;
  sink?: (record: ExecutionTimingRecord) => void;
};

/**
 * Records an allowlisted phase schema exactly once per request.
 *
 * There is deliberately no arbitrary metadata argument: request bodies, credentials, tool input and
 * reasoning cannot enter the timing log through this API.
 */
export class RuntimeTimingRecorder {
  private readonly seen = new Set<RuntimeTimingPhase>();

  constructor(
    private readonly correlation: TimingCorrelation,
    private readonly startedAt: number,
    private readonly now: () => number,
    private readonly sink: (record: ExecutionTimingRecord) => void,
  ) {}

  record(phase: RuntimeTimingPhase, details: TimingDetails = {}): void {
    this.recordAt(phase, this.now(), details);
  }

  recordAt(
    phase: RuntimeTimingPhase,
    at: number,
    details: TimingDetails = {},
  ): void {
    if (this.seen.has(phase)) return;
    this.seen.add(phase);
    this.sink({
      type: "execution-timing",
      component: "server-runtime",
      phase,
      ...this.correlation,
      elapsedMs: elapsedMilliseconds(this.startedAt, at),
      ...details,
    });
  }
}

/** Start timing at request receipt, then read only correlation ids from a cloned AG-UI body. */
export async function createRuntimeRequestTiming(
  request: Request,
  path: string,
  options: RuntimeTimingOptions = {},
): Promise<RuntimeTimingRecorder> {
  const now = options.now ?? monotonicNow;
  const startedAt = now();
  const body = await request
    .clone()
    .json()
    .catch(() => undefined);
  const bodyRecord = isRecord(body) ? body : undefined;
  const requestId = safeIdentifier(
    options.requestId?.() ?? crypto.randomUUID(),
  );
  const pathAgentId = agentIdFromPath(path);
  const correlation: TimingCorrelation = {
    requestId: requestId ?? crypto.randomUUID(),
    ...(safeIdentifier(bodyRecord?.runId)
      ? { runId: safeIdentifier(bodyRecord?.runId) }
      : {}),
    ...(safeIdentifier(bodyRecord?.threadId)
      ? { threadId: safeIdentifier(bodyRecord?.threadId) }
      : {}),
    ...((pathAgentId ?? safeIdentifier(bodyRecord?.agentId))
      ? {
          agentId: pathAgentId ?? safeIdentifier(bodyRecord?.agentId),
        }
      : {}),
  };
  const timing = new RuntimeTimingRecorder(
    correlation,
    startedAt,
    now,
    options.sink ?? writeRuntimeTiming,
  );
  timing.recordAt("request_received", startedAt);
  return timing;
}

function agentIdFromPath(path: string): string | undefined {
  return safeIdentifier(path.match(/\/agent\/([^/]+)\/(?:run|connect)$/)?.[1]);
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elapsedMilliseconds(startedAt: number, at: number): number {
  return Math.round(Math.max(0, at - startedAt) * 1_000) / 1_000;
}

function monotonicNow(): number {
  return performance.now();
}

function writeRuntimeTiming(record: ExecutionTimingRecord): void {
  const message = JSON.stringify(record);
  if (record.phase === "request_error") console.warn(message);
  else console.info(message);
}
