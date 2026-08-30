import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppVariables, requireAdmin } from "./auth/guards";

export const WORKSPACE_TIMING_PHASES = [
  "channel_click",
  "cached_history_painted",
  "fresh_history_loaded",
  "runtime_ready",
  "runtime_joined",
  "composer_ready",
  "first_text_painted",
  "attachment_upload_started",
  "attachment_upload_completed",
  "artifact_card_painted",
] as const;

export type WorkspaceTimingPhase = (typeof WORKSPACE_TIMING_PHASES)[number];
export type WorkspaceTimingOperation =
  | "channel_switch"
  | "agent_run"
  | "attachment_upload"
  | "artifact_render";

export type WorkspaceTimingSample = {
  operation: WorkspaceTimingOperation;
  phase: WorkspaceTimingPhase;
  traceId: string;
  elapsedMs: number;
};

export type WorkspaceTimingRecord = WorkspaceTimingSample & {
  type: "workspace-timing";
  component: "frontend";
};

export type WorkspaceTimingMetric = {
  operation: WorkspaceTimingOperation;
  phase: WorkspaceTimingPhase;
  count: number;
  p50: number;
  p95: number;
  p99: number;
};

type WorkspaceTimingStoreOptions = {
  maxSamplesPerMetric?: number;
  sink?: (record: WorkspaceTimingRecord) => void;
};

const DEFAULT_MAX_SAMPLES_PER_METRIC = 512;
const MAX_BATCH_SAMPLES = 32;
const MAX_ELAPSED_MS = 30 * 60_000;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024;
const SAFE_TRACE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PHASES_BY_OPERATION: Record<
  WorkspaceTimingOperation,
  ReadonlySet<WorkspaceTimingPhase>
> = {
  channel_switch: new Set([
    "channel_click",
    "cached_history_painted",
    "fresh_history_loaded",
    "runtime_ready",
    "runtime_joined",
    "composer_ready",
  ]),
  agent_run: new Set(["first_text_painted"]),
  attachment_upload: new Set([
    "attachment_upload_started",
    "attachment_upload_completed",
  ]),
  artifact_render: new Set(["artifact_card_painted"]),
};

/** Bounded rolling frontend measurements; no user or conversation content is accepted. */
export class WorkspaceTimingStore {
  private readonly samples = new Map<string, number[]>();
  private readonly maxSamplesPerMetric: number;
  private readonly sink: (record: WorkspaceTimingRecord) => void;

  constructor(options: WorkspaceTimingStoreOptions = {}) {
    const requestedLimit = options.maxSamplesPerMetric;
    this.maxSamplesPerMetric = Math.max(
      1,
      Math.floor(
        requestedLimit !== undefined && Number.isFinite(requestedLimit)
          ? requestedLimit
          : DEFAULT_MAX_SAMPLES_PER_METRIC,
      ),
    );
    this.sink = options.sink ?? writeWorkspaceTiming;
  }

  record(sample: WorkspaceTimingSample): void {
    const elapsedMs = milliseconds(sample.elapsedMs);
    const key = metricKey(sample.operation, sample.phase);
    const values = this.samples.get(key) ?? [];
    values.push(elapsedMs);
    if (values.length > this.maxSamplesPerMetric) {
      values.splice(0, values.length - this.maxSamplesPerMetric);
    }
    this.samples.set(key, values);
    this.sink({
      type: "workspace-timing",
      component: "frontend",
      ...sample,
      elapsedMs,
    });
  }

  recordMany(samples: readonly WorkspaceTimingSample[]): void {
    for (const sample of samples) this.record(sample);
  }

  snapshot(): WorkspaceTimingMetric[] {
    return [...this.samples.entries()]
      .map(([key, values]) => {
        const [operation, phase] = key.split(":") as [
          WorkspaceTimingOperation,
          WorkspaceTimingPhase,
        ];
        const sorted = [...values].sort((left, right) => left - right);
        return {
          operation,
          phase,
          count: sorted.length,
          p50: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
          p99: percentile(sorted, 0.99),
        };
      })
      .sort((left, right) =>
        metricKey(left.operation, left.phase).localeCompare(
          metricKey(right.operation, right.phase),
        ),
      );
  }
}

type WorkspaceTimingIngestLimiterOptions = {
  maxSamplesPerWindow?: number;
  windowMs?: number;
  maxActors?: number;
  now?: () => number;
};

type IngestWindow = { count: number; startedAt: number };

/** Per-actor log protection with bounded state; metrics must not become an availability hazard. */
export class WorkspaceTimingIngestLimiter {
  private readonly windows = new Map<string, IngestWindow>();
  private readonly maxSamplesPerWindow: number;
  private readonly windowMs: number;
  private readonly maxActors: number;
  private readonly now: () => number;

  constructor(options: WorkspaceTimingIngestLimiterOptions = {}) {
    this.maxSamplesPerWindow = positiveInteger(
      options.maxSamplesPerWindow,
      256,
    );
    this.windowMs = positiveInteger(options.windowMs, 60_000);
    this.maxActors = positiveInteger(options.maxActors, 1_024);
    this.now = options.now ?? Date.now;
  }

  take(
    actorId: string,
    sampleCount: number,
  ): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.now();
    const previous = this.windows.get(actorId);
    const window =
      previous && now - previous.startedAt < this.windowMs
        ? previous
        : { count: 0, startedAt: now };

    // Refresh insertion order so the bounded map evicts the least-recently-seen actor.
    this.windows.delete(actorId);
    while (this.windows.size >= this.maxActors) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
    this.windows.set(actorId, window);

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((window.startedAt + this.windowMs - now) / 1_000),
    );
    if (window.count + sampleCount > this.maxSamplesPerWindow) {
      return { allowed: false, retryAfterSeconds };
    }
    window.count += sampleCount;
    return { allowed: true, retryAfterSeconds };
  }
}

export function createWorkspaceTimingIngestLimiter(
  options: WorkspaceTimingIngestLimiterOptions = {},
): WorkspaceTimingIngestLimiter {
  return new WorkspaceTimingIngestLimiter(options);
}

export function createWorkspaceTimingStore(
  options: WorkspaceTimingStoreOptions = {},
): WorkspaceTimingStore {
  return new WorkspaceTimingStore(options);
}

/** Strictly parse the small allowlisted wire shape; extra keys could carry private content. */
export function parseWorkspaceTimingBatch(
  value: unknown,
): WorkspaceTimingSample[] | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["samples"])) return null;
  if (
    !Array.isArray(value.samples) ||
    value.samples.length === 0 ||
    value.samples.length > MAX_BATCH_SAMPLES
  ) {
    return null;
  }

  const parsed: WorkspaceTimingSample[] = [];
  for (const candidate of value.samples) {
    const sample = parseWorkspaceTimingSample(candidate);
    if (!sample) return null;
    parsed.push(sample);
  }
  return parsed;
}

export function createWorkspaceTelemetryRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  store: WorkspaceTimingStore,
  options: {
    limiter?: WorkspaceTimingIngestLimiter;
    maxBodyBytes?: number;
  } = {},
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const limiter = options.limiter ?? createWorkspaceTimingIngestLimiter();
  const maxBodyBytes = positiveInteger(
    options.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
  );

  routes.post(
    "/workspace",
    requireUser,
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: (context) =>
        context.json({ error: "Workspace timing batch is too large." }, 413),
    }),
    async (context) => {
      const body = await context.req.json().catch(() => undefined);
      const samples = parseWorkspaceTimingBatch(body);
      if (!samples) {
        return context.json({ error: "Invalid workspace timing batch." }, 400);
      }
      const admission = limiter.take(context.var.actor.id, samples.length);
      if (!admission.allowed) {
        context.header("retry-after", String(admission.retryAfterSeconds));
        return context.json(
          { error: "Workspace timing rate limit exceeded." },
          429,
        );
      }
      store.recordMany(samples);
      return context.json({ accepted: samples.length }, 202);
    },
  );

  routes.get("/workspace/summary", requireUser, (context) => {
    const denied = requireAdmin(context);
    return denied ?? context.json({ metrics: store.snapshot() });
  });

  return routes;
}

function parseWorkspaceTimingSample(
  value: unknown,
): WorkspaceTimingSample | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["operation", "phase", "traceId", "elapsedMs"])
  ) {
    return null;
  }
  const operation = value.operation;
  const phase = value.phase;
  if (!isOperation(operation) || !isPhase(phase)) return null;
  if (!PHASES_BY_OPERATION[operation].has(phase)) return null;
  if (typeof value.traceId !== "string" || !SAFE_TRACE_ID.test(value.traceId)) {
    return null;
  }
  if (
    typeof value.elapsedMs !== "number" ||
    !Number.isFinite(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > MAX_ELAPSED_MS
  ) {
    return null;
  }
  return {
    operation,
    phase,
    traceId: value.traceId,
    elapsedMs: milliseconds(value.elapsedMs),
  };
}

function isOperation(value: unknown): value is WorkspaceTimingOperation {
  return (
    value === "channel_switch" ||
    value === "agent_run" ||
    value === "attachment_upload" ||
    value === "artifact_render"
  );
}

function isPhase(value: unknown): value is WorkspaceTimingPhase {
  return (
    typeof value === "string" &&
    (WORKSPACE_TIMING_PHASES as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  );
}

function metricKey(
  operation: WorkspaceTimingOperation,
  phase: WorkspaceTimingPhase,
): string {
  return `${operation}:${phase}`;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

function milliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}

function writeWorkspaceTiming(record: WorkspaceTimingRecord): void {
  console.info(JSON.stringify(record));
}
