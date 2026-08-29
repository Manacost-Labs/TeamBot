import { createHash } from "node:crypto";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

const SERVICE_URL =
  process.env.PARSER_OPS_URL?.trim() || "http://host.docker.internal:4031";

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "audit_all_sources",
    description:
      "Audit every configured api.kolodahearthstone.com parser source. Returns exact health and 24h/7d/30d reliability, including stale, disabled, cached/LKG, provisional, failed and upstream-pending sources. This is the required first action of every control cycle.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "diagnose_source",
    description:
      "Return the current sanitized health, schedule and reliability evidence for one parser source before deciding whether to wait, retry, or repair code.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: {
          type: "string",
          pattern: "^[A-Za-z0-9_.:-]{1,120}$",
          description: "A source id from audit_all_sources.",
        },
      },
      required: ["sourceId"],
    },
  },
  {
    name: "retry_sources",
    description:
      "Run a bounded refresh for one to five known sources and wait for terminal outcomes. Use for transient transport/rate-limit failures, never to conceal upstream_pending. Only fresh_published confirms freshness.",
    inputSchema: {
      type: "object",
      properties: {
        sourceIds: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
          items: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,120}$" },
        },
        reason: { type: "string", maxLength: 300 },
      },
      required: ["sourceIds"],
    },
  },
  {
    name: "codegraph_explore",
    description:
      "Explore relationships in the dedicated parser repository with its CodeGraph index. Required before implementation-code search or repair.",
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
      "Show the dedicated repair branch, commits, changed paths and a bounded diff summary. It never returns secret or runtime files.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "validate_workspace",
    description:
      "Validate the dedicated parser workspace. Run targeted with the regression test paths first, then full, then security. Real premium/provider network calls are not permitted in tests.",
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
            pattern: "^tests/test_[A-Za-z0-9_./-]+\\.py$",
          },
        },
      },
      required: ["mode"],
    },
  },
  {
    name: "publish_and_verify",
    description:
      "Publish the tested repair branch, deploy through the canonical rollback-capable procedure, refresh one to five affected sources, and require fresh_published. On deploy or verification failure it creates and deploys a reverting commit automatically.",
    inputSchema: {
      type: "object",
      properties: {
        sourceIds: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          uniqueItems: true,
          items: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,120}$" },
        },
        summary: { type: "string", minLength: 5, maxLength: 300 },
      },
      required: ["sourceIds", "summary"],
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
    .update(`openbot-parser-ops\0${boundarySecret}`)
    .digest("hex");
}

function result(text: string, isError = false): McpCallResult {
  if (text.length <= MAX_RESULT_CHARS) {
    return { text, isError, truncated: false };
  }
  return {
    text: `${text.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: parser-ops returned ${text.length} characters]`,
    isError,
    truncated: true,
  };
}

export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (!TOOLS.some((tool) => tool.name === toolName)) {
    return result(`Parser Ops does not offer ${toolName}.`, true);
  }
  const token = serviceToken();
  if (!token) {
    return result(
      "Parser Ops is not configured with its internal credential.",
      true,
    );
  }

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
          : `Parser Ops answered HTTP ${response.status} without a readable result.`;
    return result(text, !response.ok || typeof body?.error === "string");
  } catch (error) {
    return result(
      `Parser Ops could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}
