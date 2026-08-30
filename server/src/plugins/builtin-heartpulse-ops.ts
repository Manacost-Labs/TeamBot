import { createHash } from "node:crypto";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

const SERVICE_URL =
  process.env.HEARTPULSE_OPS_URL?.trim() || "http://host.docker.internal:4032";

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "audit_strategy_data",
    description:
      "Audit the complete API-to-HeartPulse Battlegrounds strategy payload. Validates HTTP, count, fetchedAt, card coverage, tier distribution and HSReplay all-D-without-metrics regression.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "diagnose_rendering",
    description:
      "Compare parser API data with the local/public HeartPulse endpoint and classify the issue as parser, API transformation, cache or UI rendering.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "codegraph_explore",
    description:
      "Explore the isolated HeartPulse repository with CodeGraph before implementation changes.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 3, maxLength: 1000 },
      },
      required: ["question"],
    },
  },
  {
    name: "workspace_status",
    description:
      "Show the isolated HeartPulse repair branch, commit, changed paths and bounded diff summary without secrets or runtime files.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "validate_workspace",
    description:
      "Run targeted, full or security validation in the isolated HeartPulse worktree and record the exact commit result.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["targeted", "full", "security"] },
        testPaths: {
          type: "array",
          maxItems: 10,
          uniqueItems: true,
          items: {
            type: "string",
            pattern: "^tests/[A-Za-z0-9_./-]+\\.(ts|mjs)$",
          },
        },
      },
      required: ["mode"],
    },
  },
  {
    name: "publish_and_verify",
    description:
      "Publish the tested HeartPulse repair through the canonical release path, verify production data and rendering, and roll back automatically on failure.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string", minLength: 5, maxLength: 300 } },
      required: ["summary"],
    },
  },
]);

export const listNeedsCredential = false;

export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

type Connection = { actorId?: string; botId?: string };

function serviceToken(): string | null {
  const boundarySecret = process.env.AGENT_TOOL_TOKEN?.trim();
  if (!boundarySecret) return null;
  return createHash("sha256")
    .update(`openbot-heartpulse-ops\0${boundarySecret}`)
    .digest("hex");
}

function result(text: string, isError = false): McpCallResult {
  if (text.length <= MAX_RESULT_CHARS)
    return { text, isError, truncated: false };
  return {
    text: `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: heartpulse-ops returned ${text.length} characters]`,
    isError: true,
    truncated: true,
  };
}

export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (!TOOLS.some((tool) => tool.name === toolName)) {
    return result(`HeartPulse Ops does not offer ${toolName}.`, true);
  }
  const token = serviceToken();
  if (!token)
    return result(
      "HeartPulse Ops is not configured with its internal credential.",
      true,
    );
  try {
    const response = await fetch(`${SERVICE_URL.replace(/\/+$/, "")}/call`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tool: toolName,
        arguments: args,
        actorId: connection.actorId,
        botId: connection.botId,
      }),
      signal: AbortSignal.timeout(
        toolName === "publish_and_verify" || toolName === "validate_workspace"
          ? 30 * 60_000
          : 10 * 60_000,
      ),
    });
    const body = (await response.json().catch(() => null)) as {
      text?: unknown;
      error?: unknown;
    } | null;
    const text =
      typeof body?.text === "string"
        ? body.text
        : typeof body?.error === "string"
          ? body.error
          : `HeartPulse Ops answered HTTP ${response.status} without a readable result.`;
    return result(text, !response.ok || typeof body?.error === "string");
  } catch (error) {
    return result(
      `HeartPulse Ops could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}
