import { type McpCallResult, type McpTool, resultText } from "./mcp";

/**
 * The hosted OOMOL Connector gateway for a personal `api_...` key.
 *
 * OOMOL owns the connected provider credentials and their refresh lifecycle. OpenBot only sends
 * the personal Connector key to OOMOL, discovers the gateway's action metadata, and forwards an
 * action input after the normal local grant, policy, and audit checks have passed.
 */
const OOMOL_BASE_URL = "https://connector.oomol.com/v1";
const LIST_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const ACTION_LIST_CONCURRENCY = 8;

type Connection = {
  /** The stored row URL is intentionally ignored; the catalogue pins OOMOL's hosted gateway here. */
  url: string;
  token?: string;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function failureForStatus(status: number, operation: string): string {
  if (status === 401) {
    return "OOMOL rejected the Connector API key (401). Check the personal api_ key in OOMOL Console.";
  }
  if (status === 403) {
    return `OOMOL denied this ${operation} request (403). Check the key's account and Team access.`;
  }
  if (status === 404) {
    return `OOMOL does not provide the requested ${operation} endpoint (404).`;
  }
  if (status === 429) {
    return `OOMOL is rate-limiting this ${operation} request. Try again shortly.`;
  }
  if (status >= 500) {
    return `OOMOL could not complete this ${operation} request (${status}). Try again shortly.`;
  }
  return `OOMOL rejected this ${operation} request (${status}).`;
}

function networkFailure(error: unknown, operation: string): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `OOMOL did not answer the ${operation} request in time.`;
  }
  return `OOMOL could not be reached for this ${operation}. Try again shortly.`;
}

class ResponseTooLargeError extends Error {}

async function responseText(response: Response): Promise<string> {
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function request(
  token: string | undefined,
  operation: string,
  path: string,
  options: Readonly<{
    method: "GET" | "POST";
    body?: Record<string, unknown>;
    timeoutMs: number;
  }>,
): Promise<unknown> {
  const apiKey = token?.trim();
  if (!apiKey) {
    throw new Error(
      "No OOMOL Connector API key is configured. Add it on the Plugins page.",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${OOMOL_BASE_URL}${path}`, {
      method: options.method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      // A bearer key must never follow a redirect to an unreviewed host.
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new Error(networkFailure(error, operation));
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(failureForStatus(response.status, operation));
  }

  let body: string;
  try {
    body = await responseText(response);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw new Error(`OOMOL returned an oversized ${operation} response.`);
    }
    throw new Error(`OOMOL returned an invalid ${operation} response.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`OOMOL returned an invalid ${operation} response.`);
  }

  const envelope = asRecord(parsed);
  if (envelope?.success !== true || !("data" in envelope)) {
    throw new Error(`OOMOL returned an unsuccessful ${operation} response.`);
  }
  return envelope.data;
}

function actionTool(value: unknown, index: number): McpTool {
  const action = asRecord(value);
  if (!action) {
    throw new Error(
      `OOMOL returned an invalid action at position ${index + 1}.`,
    );
  }
  const id = action.id;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > 255 ||
    id.includes("/") ||
    hasControlCharacter(id)
  ) {
    throw new Error(
      `OOMOL returned an invalid action id at position ${index + 1}.`,
    );
  }

  const inputSchema = asRecord(action.inputSchema) ?? {};
  const description =
    typeof action.description === "string"
      ? action.description.slice(0, MAX_DESCRIPTION_CHARS)
      : "";
  return { name: id, description, inputSchema };
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function actionTools(value: unknown): McpTool[] {
  if (!Array.isArray(value)) {
    throw new Error("OOMOL returned an invalid action catalogue.");
  }

  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const tool = actionTool(candidate, index);
    if (seen.has(tool.name)) {
      throw new Error(`OOMOL returned duplicate action id ${tool.name}.`);
    }
    seen.add(tool.name);
    return tool;
  });
}

function connectedServices(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("OOMOL returned an invalid connected-app catalogue.");
  }

  const seen = new Set<string>();
  const services: string[] = [];
  for (const candidate of value) {
    const app = asRecord(candidate);
    const service = app?.service;
    const status = app?.status;
    if (
      typeof service !== "string" ||
      service.length === 0 ||
      service.length > 255 ||
      hasControlCharacter(service)
    ) {
      throw new Error("OOMOL returned an invalid connected-app service.");
    }
    if (status !== undefined && status !== "active") continue;
    if (seen.has(service)) continue;
    seen.add(service);
    services.push(service);
  }
  return services;
}

async function actionToolsForServices(
  token: string | undefined,
  services: string[],
): Promise<McpTool[]> {
  const byService = new Array<McpTool[]>(services.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < services.length) {
      const index = nextIndex;
      nextIndex += 1;
      const service = services[index];
      if (service === undefined) continue;
      const data = await request(
        token,
        "action catalogue",
        `/actions?service=${encodeURIComponent(service)}`,
        { method: "GET", timeoutMs: LIST_TIMEOUT_MS },
      );
      byService[index] = actionTools(data);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(ACTION_LIST_CONCURRENCY, services.length) },
      () => worker(),
    ),
  );
  return byService.flat();
}

function actionResult(data: unknown): McpCallResult {
  const text =
    typeof data === "string"
      ? data
      : data === undefined
        ? undefined
        : JSON.stringify(data);
  const bounded =
    text === undefined ? resultText([]) : resultText([{ type: "text", text }]);
  return {
    text: bounded.text,
    isError: false,
    truncated: bounded.truncated,
  };
}

/** OOMOL's hosted gateway needs the deployment's personal key to enumerate actions. */
export const listNeedsCredential = true;

/** Discover actions for the apps connected to the OOMOL account behind the stored personal key. */
export async function listTools(connection: Connection): Promise<McpTool[]> {
  const apps = await request(connection.token, "connected app list", "/apps", {
    method: "GET",
    timeoutMs: LIST_TIMEOUT_MS,
  });
  return actionToolsForServices(connection.token, connectedServices(apps));
}

/** Execute one OOMOL action; the gateway selects its default connected account. */
export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const data = await request(
    connection.token,
    "action",
    `/actions/${encodeURIComponent(toolName)}`,
    {
      method: "POST",
      body: { input: args },
      timeoutMs: CALL_TIMEOUT_MS,
    },
  );
  return actionResult(data);
}
