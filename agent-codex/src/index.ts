import { serve } from "bun";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";
import {
  ChatGptDeviceAuthCoordinator,
  DeviceAuthFlowError,
  type DeviceAuthPublicStatus,
  type DeviceAuthStartResult,
} from "./device-auth";
import { createAgentRequestHandler } from "./request-handler";
import { RunAdmission } from "./run-admission";

const MAX_DEVICE_AUTH_BODY_BYTES = 4_096;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export const DEVICE_AUTH_PATHS = Object.freeze({
  start: "/internal/chatgpt-device-auth/start",
  status: "/internal/chatgpt-device-auth/status",
  cancel: "/internal/chatgpt-device-auth/cancel",
  collect: "/internal/chatgpt-device-auth/collect",
});

const DEVICE_AUTH_PATH_SET = new Set<string>(Object.values(DEVICE_AUTH_PATHS));

export type DeviceAuthCoordinator = {
  start(flowId?: string): Promise<DeviceAuthStartResult>;
  status(flowId: string): Promise<DeviceAuthPublicStatus>;
  cancel(flowId: string): Promise<DeviceAuthPublicStatus>;
  collect(
    flowId: string,
  ): Promise<Readonly<{ provider: "chatgpt"; authDocument: string }>>;
  shutdown(): Promise<void>;
};

type AgentCodexServiceOptions = {
  managedAgentToken: string;
  admission?: RunAdmission;
  deviceAuth?: DeviceAuthCoordinator;
  model?: string;
  handleAgentRequest?: (request: Request) => Promise<Response>;
};

type BodyFailureStatus = 400 | 413 | 415;

class DeviceAuthBodyError extends Error {
  constructor(readonly status: BodyFailureStatus) {
    super("Invalid internal device authentication request body");
    this.name = "DeviceAuthBodyError";
  }
}

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function portFromEnvironment(environment: NodeJS.ProcessEnv): number {
  const port = positiveInteger(environment, "PORT", 4_202);
  if (port > 65_535) throw new Error("PORT must be a valid TCP port.");
  return port;
}

function defaultAdmission(environment: NodeJS.ProcessEnv = process.env) {
  return new RunAdmission({
    globalLimit: positiveInteger(environment, "CODEX_MAX_ACTIVE_RUNS", 4),
    perAgentLimit: positiveInteger(
      environment,
      "CODEX_MAX_ACTIVE_RUNS_PER_AGENT",
      2,
    ),
    queueLimit: nonNegativeInteger(environment, "CODEX_MAX_QUEUED_RUNS", 32),
    maxWaitMs: positiveInteger(environment, "CODEX_MAX_QUEUE_WAIT_MS", 60_000),
  });
}

function noStoreJson(
  value: unknown,
  options: { status?: number; headers?: HeadersInit } = {},
) {
  const headers = new Headers(options.headers);
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  return Response.json(value, { status: options.status, headers });
}

async function readBoundedJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    throw new DeviceAuthBodyError(415);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new DeviceAuthBodyError(400);
    }
    if (Number(contentLength) > MAX_DEVICE_AUTH_BODY_BYTES) {
      throw new DeviceAuthBodyError(413);
    }
  }
  if (!request.body) throw new DeviceAuthBodyError(400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_DEVICE_AUTH_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DeviceAuthBodyError(413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let body: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    body = JSON.parse(text) as unknown;
  } catch {
    throw new DeviceAuthBodyError(400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DeviceAuthBodyError(400);
  }
  return body as Record<string, unknown>;
}

function exactFlowBody(
  body: Record<string, unknown>,
  options: { optional: boolean },
): string | undefined {
  const keys = Object.keys(body);
  if (options.optional && keys.length === 0) return undefined;
  if (
    keys.length !== 1 ||
    keys[0] !== "flowId" ||
    typeof body.flowId !== "string"
  ) {
    throw new DeviceAuthBodyError(400);
  }
  return body.flowId;
}

function deviceAuthError(error: unknown): Response {
  if (error instanceof DeviceAuthBodyError) {
    return noStoreJson(
      { error: "Invalid request body." },
      { status: error.status },
    );
  }
  if (error instanceof DeviceAuthFlowError) {
    const status =
      error.code === "invalid_flow"
        ? 400
        : error.code === "duplicate_flow"
          ? 409
          : error.code === "flow_capacity"
            ? 429
            : error.code === "flow_unavailable"
              ? 404
              : error.code === "service_stopped"
                ? 503
                : 502;
    return noStoreJson(
      {
        error: "Device authentication request failed.",
        code: error.code,
      },
      {
        status,
        ...(status === 429 || status === 503
          ? { headers: { "retry-after": "5" } }
          : {}),
      },
    );
  }
  return noStoreJson(
    { error: "Device authentication request failed." },
    { status: 500 },
  );
}

export function createAgentCodexService(options: AgentCodexServiceOptions) {
  const managedAgentToken = options.managedAgentToken.trim();
  if (!managedAgentToken) throw new Error("MANAGED_AGENT_TOKEN is required.");
  const admission = options.admission ?? defaultAdmission();
  const deviceAuth = options.deviceAuth ?? new ChatGptDeviceAuthCoordinator();
  const handleAgentRequest =
    options.handleAgentRequest ??
    createAgentRequestHandler({
      managedAgentToken,
      agentId: "agent-codex",
      admission,
    });
  let shutdown: Promise<void> | undefined;

  return {
    admission,
    deviceAuth,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return Response.json({
          status: admission.snapshot().draining ? "draining" : "ok",
          model: options.model?.trim() || "account-default",
          auth: "chatgpt",
          managedRuns: admission.snapshot(),
        });
      }

      if (DEVICE_AUTH_PATH_SET.has(url.pathname) && url.search === "") {
        if (!hasManagedAgentToken(request, managedAgentToken)) {
          return noStoreJson({ error: "Unauthorized." }, { status: 401 });
        }
        if (request.method !== "POST") {
          return noStoreJson(
            { error: "Method not allowed." },
            { status: 405, headers: { allow: "POST" } },
          );
        }

        try {
          const body = await readBoundedJsonObject(request);
          if (url.pathname === DEVICE_AUTH_PATHS.start) {
            const flowId = exactFlowBody(body, { optional: true });
            const result =
              flowId === undefined
                ? await deviceAuth.start()
                : await deviceAuth.start(flowId);
            return noStoreJson(result, { status: 201 });
          }

          const flowId = exactFlowBody(body, { optional: false });
          if (!flowId) throw new DeviceAuthBodyError(400);
          if (url.pathname === DEVICE_AUTH_PATHS.status) {
            return noStoreJson(await deviceAuth.status(flowId));
          }
          if (url.pathname === DEVICE_AUTH_PATHS.cancel) {
            return noStoreJson(await deviceAuth.cancel(flowId));
          }
          return noStoreJson(await deviceAuth.collect(flowId));
        } catch (error) {
          return deviceAuthError(error);
        }
      }

      if (
        (url.pathname === "/admin/drain" || url.pathname === "/admin/resume") &&
        request.method === "POST"
      ) {
        if (!hasManagedAgentToken(request, managedAgentToken)) {
          return Response.json({ error: "Unauthorized." }, { status: 401 });
        }
        return Response.json(
          url.pathname === "/admin/drain"
            ? admission.startDraining()
            : admission.resume(),
        );
      }
      if (url.pathname === "/ag-ui" && request.method === "POST") {
        return handleAgentRequest(request);
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    },
    shutdown(): Promise<void> {
      shutdown ??= (async () => {
        admission.startDraining();
        await deviceAuth.shutdown();
      })();
      return shutdown;
    },
  };
}

export function createAgentCodexServiceFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const managedAgentToken = environment.MANAGED_AGENT_TOKEN?.trim();
  if (!managedAgentToken) throw new Error("MANAGED_AGENT_TOKEN is required.");
  return createAgentCodexService({
    managedAgentToken,
    admission: defaultAdmission(environment),
    model: environment.CODEX_MODEL,
  });
}

export function startAgentCodexServer(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const service = createAgentCodexServiceFromEnvironment(environment);
  const port = portFromEnvironment(environment);
  const server = serve({
    port,
    // Bun caps this at 255 seconds; use the maximum for long validation tool calls.
    idleTimeout: 255,
    fetch: service.fetch,
  });
  let shutdown: Promise<void> | undefined;
  return {
    port,
    server,
    service,
    shutdown(): Promise<void> {
      shutdown ??= (async () => {
        await service.shutdown();
        await server.stop(false);
      })();
      return shutdown;
    },
  };
}

if (import.meta.main) {
  const running = startAgentCodexServer();
  let signalReceived = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (signalReceived) return;
      signalReceived = true;
      void running.shutdown().finally(() => process.exit(0));
    });
  }
  console.info(
    `agent-codex listening on http://localhost:${running.port}/ag-ui`,
  );
}
