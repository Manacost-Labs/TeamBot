import { newId } from "../new-id";

export type WorkspaceTimingPhase =
  | "channel_click"
  | "cached_history_painted"
  | "fresh_history_loaded"
  | "runtime_ready"
  | "runtime_joined"
  | "composer_ready"
  | "first_text_painted"
  | "attachment_upload_started"
  | "attachment_upload_completed"
  | "artifact_card_painted";

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

type Trace = {
  id: string;
  operation: WorkspaceTimingOperation;
  startedAt: number;
  seen: Set<WorkspaceTimingPhase>;
};

type FrontendTimingRecorderOptions = {
  now?: () => number;
  id?: () => string;
  sink: (sample: WorkspaceTimingSample) => void;
  maxTraces?: number;
};

type ScheduleFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (handle: number) => void;

const DEFAULT_MAX_TRACES = 32;

/** Small in-memory trace registry; scope keys and channel ids never leave the browser. */
export class FrontendTimingRecorder {
  private readonly traces = new Map<string, Trace>();
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly sink: (sample: WorkspaceTimingSample) => void;
  private readonly maxTraces: number;

  constructor(options: FrontendTimingRecorderOptions) {
    this.now = options.now ?? (() => performance.now());
    this.id = options.id ?? newId;
    this.sink = options.sink;
    const requestedMaxTraces = options.maxTraces;
    this.maxTraces = Math.max(
      1,
      Math.floor(
        requestedMaxTraces !== undefined && Number.isFinite(requestedMaxTraces)
          ? requestedMaxTraces
          : DEFAULT_MAX_TRACES,
      ),
    );
  }

  start(
    scopeKey: string,
    operation: WorkspaceTimingOperation,
    firstPhase?: WorkspaceTimingPhase,
  ): string {
    const trace: Trace = {
      id: this.id(),
      operation,
      startedAt: this.now(),
      seen: new Set(),
    };
    this.traces.delete(scopeKey);
    this.traces.set(scopeKey, trace);
    while (this.traces.size > this.maxTraces) {
      const oldest = this.traces.keys().next().value;
      if (oldest === undefined) break;
      this.traces.delete(oldest);
    }
    if (firstPhase) this.record(scopeKey, firstPhase);
    return trace.id;
  }

  ensure(scopeKey: string, operation: WorkspaceTimingOperation): string {
    return this.traces.get(scopeKey)?.id ?? this.start(scopeKey, operation);
  }

  record(
    scopeKey: string,
    phase: WorkspaceTimingPhase,
  ): WorkspaceTimingSample | null {
    const trace = this.traces.get(scopeKey);
    if (!trace || trace.seen.has(phase)) return null;
    trace.seen.add(phase);
    const sample = {
      operation: trace.operation,
      phase,
      traceId: trace.id,
      elapsedMs: milliseconds(Math.max(0, this.now() - trace.startedAt)),
    };
    this.sink(sample);
    return sample;
  }

  finish(scopeKey: string): void {
    this.traces.delete(scopeKey);
  }
}

const MAX_BUFFERED_SAMPLES = 128;
const MAX_BATCH_SAMPLES = 32;
const FLUSH_AFTER_MS = 250;
const pending: WorkspaceTimingSample[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function enqueue(sample: WorkspaceTimingSample): void {
  if (pending.length >= MAX_BUFFERED_SAMPLES) pending.shift();
  pending.push(sample);
  if (pending.length >= MAX_BATCH_SAMPLES) {
    void flushWorkspaceTimings();
    return;
  }
  flushTimer ??= setTimeout(() => {
    flushTimer = undefined;
    void flushWorkspaceTimings();
  }, FLUSH_AFTER_MS);
}

const recorder = new FrontendTimingRecorder({ sink: enqueue });

/** Measure one upload attempt without accepting filenames, channel IDs, bytes, or message data. */
export async function traceAttachmentUpload<T>(
  upload: () => Promise<T>,
  timing: FrontendTimingRecorder = recorder,
  scopeId: () => string = newId,
): Promise<T> {
  const key = `attachment-upload:${scopeId()}`;
  timing.start(key, "attachment_upload", "attachment_upload_started");
  try {
    return await upload();
  } finally {
    timing.record(key, "attachment_upload_completed");
    timing.finish(key);
  }
}

export function beginChannelTiming(channelId: string): void {
  recorder.start(channelKey(channelId), "channel_switch", "channel_click");
}

export function shouldBeginChannelTiming(
  isOpen: boolean,
  activation: {
    button: number;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  },
): boolean {
  return (
    !isOpen &&
    activation.button === 0 &&
    !activation.altKey &&
    !activation.ctrlKey &&
    !activation.metaKey &&
    !activation.shiftKey
  );
}

export function markChannelTiming(
  channelId: string,
  phase: Exclude<
    WorkspaceTimingPhase,
    | "channel_click"
    | "first_text_painted"
    | "attachment_upload_started"
    | "attachment_upload_completed"
    | "artifact_card_painted"
  >,
): void {
  recorder.record(channelKey(channelId), phase);
}

export function beginAgentRunTiming(messageId: string): void {
  recorder.start(runKey(messageId), "agent_run");
}

export function ensureAgentRunTiming(messageId: string): void {
  recorder.ensure(runKey(messageId), "agent_run");
}

export function markAgentFirstTextPainted(messageId: string): void {
  const key = runKey(messageId);
  recorder.record(key, "first_text_painted");
  recorder.finish(key);
}

export function abandonAgentRunTiming(messageId: string): void {
  recorder.finish(runKey(messageId));
}

/** Start only for a live pending first-party artifact call; callers pass no title or content. */
export function beginArtifactRenderTiming(
  toolCallId: string,
  timing: FrontendTimingRecorder = recorder,
): void {
  timing.start(artifactKey(toolCallId), "artifact_render");
}

export function markArtifactCardPainted(
  toolCallId: string,
  timing: FrontendTimingRecorder = recorder,
): void {
  const key = artifactKey(toolCallId);
  timing.record(key, "artifact_card_painted");
  timing.finish(key);
}

export function abandonArtifactRenderTiming(
  toolCallId: string,
  timing: FrontendTimingRecorder = recorder,
): void {
  timing.finish(artifactKey(toolCallId));
}

/**
 * Run after a committed tree has crossed a browser paint boundary.
 *
 * One animation frame runs immediately before paint. A second frame therefore keeps phases named
 * `*_painted` from being optimistic commit timings. The scheduler is injectable for deterministic
 * tests and the returned cleanup prevents a channel that unmounted from finishing a newer trace.
 */
export function scheduleAfterPaint(
  callback: () => void,
  schedule: ScheduleFrame = requestAnimationFrame,
  cancel: CancelFrame = cancelAnimationFrame,
): () => void {
  let second: number | undefined;
  const first = schedule(() => {
    second = schedule(callback);
  });
  return () => {
    cancel(first);
    if (second !== undefined) cancel(second);
  };
}

/** Best-effort and non-blocking: product work never waits for observability. */
export async function flushWorkspaceTimings(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (pending.length === 0 || typeof fetch !== "function") return;
  const samples = pending.splice(0, MAX_BATCH_SAMPLES);
  try {
    await fetch("/api/telemetry/workspace", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ samples }),
      keepalive: true,
    });
  } catch {
    // Metrics are intentionally lossy. Retrying here would compete with the chat during an outage.
  }
  if (pending.length > 0) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushWorkspaceTimings();
    }, FLUSH_AFTER_MS);
  }
}

function channelKey(channelId: string): string {
  return `channel:${channelId}`;
}

function runKey(messageId: string): string {
  return `run:${messageId}`;
}

function artifactKey(toolCallId: string): string {
  return `artifact:${toolCallId}`;
}

function milliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
