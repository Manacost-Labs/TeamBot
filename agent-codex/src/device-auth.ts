import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodexRuntimeProfile,
  createCodexRuntimeProfile,
} from "./runtime-profile";

const DEFAULT_FLOW_TTL_MS = 15 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_MAX_FLOWS = 64;
const DEFAULT_TERMINAL_RETENTION_MS = 60_000;
const MAX_PROMPT_BYTES = 32 * 1_024;
const MAX_AUTH_DOCUMENT_BYTES = 256 * 1_024;
const FLOW_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Codex 0.150 emits a four-character first group followed by a five-character group. Keep the
// previous four-character group compatible as well, while retaining a small bounded grammar.
const USER_CODE = /\b[A-Z0-9]{4}(?:-[A-Z0-9]{4,5}){1,3}\b/;
const HTTPS_URL = /https:\/\/[^\s<>"']+/gi;

export type DeviceAuthFlowState =
  | "pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type DeviceAuthPublicStatus = Readonly<{
  flowId: string;
  state: DeviceAuthFlowState;
  expiresAt: string;
}>;

export type DeviceAuthStartResult = Readonly<{
  flowId: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
}>;

export type DeviceAuthProcess = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
};

export type DeviceAuthFlowErrorCode =
  | "invalid_flow"
  | "duplicate_flow"
  | "flow_capacity"
  | "flow_unavailable"
  | "process_failed"
  | "service_stopped";

const FLOW_ERROR_MESSAGES: Record<DeviceAuthFlowErrorCode, string> = {
  invalid_flow: "The device authentication flow is invalid.",
  duplicate_flow: "The device authentication flow already exists.",
  flow_capacity: "The device authentication flow capacity is exhausted.",
  flow_unavailable: "The device authentication flow is unavailable.",
  process_failed: "Device authentication could not be started.",
  service_stopped: "Device authentication is shutting down.",
};

/** A stable failure that never contains child output, a code, an auth document or a local path. */
export class DeviceAuthFlowError extends Error {
  constructor(readonly code: DeviceAuthFlowErrorCode) {
    super(FLOW_ERROR_MESSAGES[code]);
    this.name = "DeviceAuthFlowError";
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  return {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

type ReadyInstructions = {
  verificationUrl: string;
  userCode: string;
};

type FlowRecord = {
  flowId: string;
  state: DeviceAuthFlowState;
  expiresAtMs: number;
  profile: CodexRuntimeProfile;
  process: DeviceAuthProcess;
  ready: Deferred<ReadyInstructions>;
  prompt: string;
  authDocument?: string;
  expiryTimer?: ReturnType<typeof setTimeout>;
  purgeTimer?: ReturnType<typeof setTimeout>;
  cleanup?: Promise<void>;
  transition?: Promise<void>;
};

type CoordinatorOptions = {
  ttlMs?: number;
  readyTimeoutMs?: number;
  terminationGraceMs?: number;
  maxFlows?: number;
  terminalRetentionMs?: number;
  now?: () => number;
  createProfile?: () => Promise<CodexRuntimeProfile>;
  spawn?: (profile: CodexRuntimeProfile) => DeviceAuthProcess;
};

function boundedMilliseconds(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60_000) {
    throw new Error("Device authentication timing is invalid");
  }
  return value;
}

function boundedCount(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("Device authentication capacity is invalid");
  }
  return value;
}

function canonicalFlowId(value: string): string {
  if (!FLOW_ID.test(value)) throw new DeviceAuthFlowError("invalid_flow");
  return value.toLowerCase();
}

function publicStatus(flow: FlowRecord): DeviceAuthPublicStatus {
  return {
    flowId: flow.flowId,
    state: flow.state,
    expiresAt: new Date(flow.expiresAtMs).toISOString(),
  };
}

function stripAnsiSgr(value: string): string {
  let plain = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27 || value[index + 1] !== "[") {
      plain += value[index];
      continue;
    }
    let end = index + 2;
    while (/[0-9;]/.test(value[end] ?? "")) end += 1;
    if (value[end] === "m") {
      index = end;
      continue;
    }
    plain += value[index];
  }
  return plain;
}

function parseInstructions(prompt: string): ReadyInstructions | null {
  // Codex 0.150 emits colour even when stdout is a pipe. Strip only bounded SGR styling before
  // parsing; otherwise the reset sequence becomes part of the URL candidate and changes its path.
  const plainPrompt = stripAnsiSgr(prompt);
  const userCode = plainPrompt.match(USER_CODE)?.[0];
  if (!userCode) return null;

  for (const candidate of plainPrompt.match(HTTPS_URL) ?? []) {
    try {
      const url = new URL(candidate);
      if (
        url.protocol === "https:" &&
        url.hostname === "auth.openai.com" &&
        url.username === "" &&
        url.password === "" &&
        url.port === "" &&
        url.hash === "" &&
        url.search === "" &&
        url.pathname === "/codex/device"
      ) {
        return { verificationUrl: url.toString(), userCode };
      }
    } catch {
      // A child may decorate the prompt. Only a canonical official HTTPS URL is accepted.
    }
  }
  return null;
}

function spawnInstalledCodex(profile: CodexRuntimeProfile): DeviceAuthProcess {
  const child = Bun.spawn(["codex", "login", "--device-auth"], {
    env: profile.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill(signal = "SIGTERM") {
      child.kill(signal);
    },
  };
}

async function safeAuthDocument(profile: CodexRuntimeProfile) {
  const path = join(profile.codexHome, "auth.json");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (
      !details.isFile() ||
      details.nlink !== 1 ||
      (details.mode & 0o077) !== 0 ||
      details.size < 2 ||
      details.size > MAX_AUTH_DOCUMENT_BYTES
    ) {
      throw new Error("Invalid auth document");
    }
    const authDocument = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(authDocument, "utf8") > MAX_AUTH_DOCUMENT_BYTES) {
      throw new Error("Invalid auth document");
    }
    const parsed = JSON.parse(authDocument) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid auth document");
    }
    return authDocument;
  } finally {
    await handle.close();
  }
}

/**
 * Owns temporary Codex device-login processes.
 *
 * Public methods expose only the official verification instruction and bounded state. The sole
 * plaintext escape hatch is `collect`, intended for the already authenticated server-to-server
 * route; callers must never project that result to a browser.
 */
export class ChatGptDeviceAuthCoordinator {
  private readonly flows = new Map<string, FlowRecord>();
  private readonly startingFlowIds = new Set<string>();
  private readonly pendingStarts = new Set<Promise<DeviceAuthStartResult>>();
  private readonly ttlMs: number;
  private readonly readyTimeoutMs: number;
  private readonly terminationGraceMs: number;
  private readonly maxFlows: number;
  private readonly terminalRetentionMs: number;
  private readonly now: () => number;
  private readonly createProfile: () => Promise<CodexRuntimeProfile>;
  private readonly spawn: (profile: CodexRuntimeProfile) => DeviceAuthProcess;
  private stopped = false;

  constructor(options: CoordinatorOptions = {}) {
    this.ttlMs = boundedMilliseconds(options.ttlMs, DEFAULT_FLOW_TTL_MS);
    this.readyTimeoutMs = boundedMilliseconds(
      options.readyTimeoutMs,
      DEFAULT_READY_TIMEOUT_MS,
    );
    this.terminationGraceMs = boundedMilliseconds(
      options.terminationGraceMs,
      DEFAULT_TERMINATION_GRACE_MS,
    );
    this.maxFlows = boundedCount(options.maxFlows, DEFAULT_MAX_FLOWS);
    this.terminalRetentionMs = boundedMilliseconds(
      options.terminalRetentionMs,
      DEFAULT_TERMINAL_RETENTION_MS,
    );
    this.now = options.now ?? Date.now;
    this.createProfile =
      options.createProfile ?? (() => createCodexRuntimeProfile());
    this.spawn = options.spawn ?? spawnInstalledCodex;
  }

  start(requestedFlowId = randomUUID()): Promise<DeviceAuthStartResult> {
    const pending = this.startFlow(requestedFlowId);
    this.pendingStarts.add(pending);
    void pending.then(
      () => this.pendingStarts.delete(pending),
      () => this.pendingStarts.delete(pending),
    );
    return pending;
  }

  private async startFlow(
    requestedFlowId: string,
  ): Promise<DeviceAuthStartResult> {
    if (this.stopped) throw new DeviceAuthFlowError("service_stopped");
    const flowId = canonicalFlowId(requestedFlowId);
    if (this.flows.has(flowId) || this.startingFlowIds.has(flowId)) {
      throw new DeviceAuthFlowError("duplicate_flow");
    }
    if (this.flows.size + this.startingFlowIds.size >= this.maxFlows) {
      throw new DeviceAuthFlowError("flow_capacity");
    }
    this.startingFlowIds.add(flowId);

    let profile: CodexRuntimeProfile;
    try {
      profile = await this.createProfile();
    } catch {
      this.startingFlowIds.delete(flowId);
      throw new DeviceAuthFlowError("process_failed");
    }
    if (this.stopped) {
      this.startingFlowIds.delete(flowId);
      await profile.dispose().catch(() => undefined);
      throw new DeviceAuthFlowError("service_stopped");
    }

    let process: DeviceAuthProcess;
    try {
      process = this.spawn(profile);
    } catch {
      this.startingFlowIds.delete(flowId);
      await profile.dispose().catch(() => undefined);
      throw new DeviceAuthFlowError("process_failed");
    }

    const flow: FlowRecord = {
      flowId,
      state: "pending",
      expiresAtMs: this.now() + this.ttlMs,
      profile,
      process,
      ready: deferred<ReadyInstructions>(),
      prompt: "",
    };
    this.flows.set(flowId, flow);
    this.startingFlowIds.delete(flowId);
    flow.expiryTimer = setTimeout(() => {
      void this.expire(flow);
    }, this.ttlMs);
    void this.watch(flow);

    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const instructions = await Promise.race([
        flow.ready.promise,
        new Promise<never>((_, reject) => {
          readyTimer = setTimeout(
            () => reject(new DeviceAuthFlowError("process_failed")),
            this.readyTimeoutMs,
          );
        }),
      ]);
      return {
        flowId,
        verificationUrl: instructions.verificationUrl,
        userCode: instructions.userCode,
        expiresAt: new Date(flow.expiresAtMs).toISOString(),
      };
    } catch {
      await this.transition(flow, "failed", true);
      throw new DeviceAuthFlowError("process_failed");
    } finally {
      if (readyTimer) clearTimeout(readyTimer);
    }
  }

  async status(flowId: string): Promise<DeviceAuthPublicStatus> {
    const flow = this.flow(flowId);
    return publicStatus(flow);
  }

  async collect(
    flowId: string,
  ): Promise<Readonly<{ provider: "chatgpt"; authDocument: string }>> {
    const flow = this.flow(flowId);
    if (flow.state !== "completed" || flow.authDocument === undefined) {
      throw new DeviceAuthFlowError("flow_unavailable");
    }
    return { provider: "chatgpt", authDocument: flow.authDocument };
  }

  async cancel(flowId: string): Promise<DeviceAuthPublicStatus> {
    const flow = this.flow(flowId);
    if (flow.state === "pending") {
      await this.transition(flow, "cancelled", true);
    } else if (flow.state === "completed") {
      flow.authDocument = undefined;
      flow.state = "cancelled";
      if (flow.expiryTimer) clearTimeout(flow.expiryTimer);
      this.schedulePurge(flow);
    }
    return publicStatus(flow);
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const starts = [...this.pendingStarts];
    await Promise.all([
      Promise.all(
        [...this.flows.values()].map(async (flow) => {
          if (flow.state === "pending") {
            await this.transition(flow, "cancelled", true);
          } else {
            flow.authDocument = undefined;
            if (flow.state === "completed") flow.state = "cancelled";
            if (flow.expiryTimer) clearTimeout(flow.expiryTimer);
            await this.cleanup(flow, false);
            this.schedulePurge(flow);
          }
        }),
      ),
      Promise.allSettled(starts),
    ]);
  }

  private flow(flowId: string): FlowRecord {
    let canonical: string;
    try {
      canonical = canonicalFlowId(flowId);
    } catch {
      throw new DeviceAuthFlowError("flow_unavailable");
    }
    const flow = this.flows.get(canonical);
    if (!flow) throw new DeviceAuthFlowError("flow_unavailable");
    return flow;
  }

  private async watch(flow: FlowRecord) {
    const readers = [flow.process.stdout, flow.process.stderr].flatMap(
      (stream) => (stream ? [this.readPrompt(flow, stream)] : []),
    );
    const exitCode = await flow.process.exited.catch(() => -1);
    await Promise.allSettled(readers);
    if (flow.state !== "pending" || flow.transition) return;
    if (exitCode !== 0) {
      flow.ready.reject(new DeviceAuthFlowError("process_failed"));
      await this.transition(flow, "failed", false);
      return;
    }

    try {
      const authDocument = await safeAuthDocument(flow.profile);
      if (flow.state !== "pending" || flow.transition) return;
      flow.authDocument = authDocument;
      flow.state = "completed";
      flow.prompt = "";
      await this.cleanup(flow, false);
    } catch {
      flow.ready.reject(new DeviceAuthFlowError("process_failed"));
      await this.transition(flow, "failed", false);
    }
  }

  private async readPrompt(
    flow: FlowRecord,
    stream: ReadableStream<Uint8Array>,
  ) {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (
          bytes > MAX_PROMPT_BYTES ||
          flow.state !== "pending" ||
          flow.transition
        ) {
          return;
        }
        flow.prompt += decoder.decode(part.value, { stream: true });
        const instructions = parseInstructions(flow.prompt);
        if (instructions) flow.ready.resolve(instructions);
      }
      flow.prompt += decoder.decode();
      const instructions = parseInstructions(flow.prompt);
      if (instructions) flow.ready.resolve(instructions);
    } catch {
      flow.ready.reject(new DeviceAuthFlowError("process_failed"));
    } finally {
      reader.releaseLock();
    }
  }

  private async expire(flow: FlowRecord) {
    if (flow.state === "pending") {
      await this.transition(flow, "expired", true);
      return;
    }
    if (flow.state === "completed") {
      flow.authDocument = undefined;
      flow.state = "expired";
      this.schedulePurge(flow);
    }
  }

  private transition(
    flow: FlowRecord,
    state: Exclude<DeviceAuthFlowState, "pending" | "completed">,
    kill: boolean,
  ): Promise<void> {
    if (flow.transition) return flow.transition;
    if (flow.state !== "pending") return Promise.resolve();
    flow.transition = (async () => {
      flow.prompt = "";
      flow.authDocument = undefined;
      flow.ready.reject(new DeviceAuthFlowError("process_failed"));
      if (flow.expiryTimer) clearTimeout(flow.expiryTimer);
      await this.cleanup(flow, kill);
      flow.state = state;
      this.schedulePurge(flow);
    })();
    return flow.transition;
  }

  private schedulePurge(flow: FlowRecord): void {
    if (flow.purgeTimer) return;
    flow.purgeTimer = setTimeout(() => {
      flow.prompt = "";
      flow.authDocument = undefined;
      if (this.flows.get(flow.flowId) === flow) {
        this.flows.delete(flow.flowId);
      }
    }, this.terminalRetentionMs);
    flow.purgeTimer.unref?.();
  }

  private async cleanup(flow: FlowRecord, kill: boolean): Promise<void> {
    if (flow.cleanup) return flow.cleanup;
    flow.cleanup = (async () => {
      if (kill) {
        try {
          flow.process.kill("SIGTERM");
        } catch {
          // The process already exited. Disposal below is still mandatory.
        }
        const exitedGracefully = await Promise.race([
          flow.process.exited.then(
            () => true,
            () => true,
          ),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), this.terminationGraceMs),
          ),
        ]);
        if (!exitedGracefully) {
          try {
            flow.process.kill("SIGKILL");
          } catch {
            // The child exited between the grace timeout and the forced kill.
          }
          await Promise.race([
            flow.process.exited.catch(() => undefined),
            new Promise<void>((resolve) =>
              setTimeout(resolve, this.terminationGraceMs),
            ),
          ]);
        }
      }
      await flow.profile.dispose().catch(() => undefined);
    })();
    return flow.cleanup;
  }
}
