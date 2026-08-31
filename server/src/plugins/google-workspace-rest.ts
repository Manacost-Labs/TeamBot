import * as docs from "./google-docs-rest";
import * as drive from "./google-drive-rest";
import * as sheets from "./google-sheets-rest";
import type { McpCallResult, McpTool } from "./mcp";

type Connection = {
  url: string;
  token?: string;
  actorId?: string;
  botId?: string;
  runId?: string;
  threadId?: string;
};

type Backend = {
  name: string;
  url: string;
  listTools(connection: Connection): Promise<McpTool[]>;
  callTool(
    connection: Connection,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult>;
};

/**
 * One per-person OAuth grant, three pinned Google APIs.
 *
 * The stored server row still points at Drive for backwards compatibility, but it must never decide
 * where a Docs or Sheets bearer token goes. Each destination is reviewed and fixed here; neither a
 * model argument, an administrator-entered URL nor a redirect response can replace it.
 */
const BACKENDS: readonly Backend[] = Object.freeze([
  {
    name: "Drive",
    url: "https://www.googleapis.com/drive/v3",
    listTools: drive.listTools,
    callTool: drive.callTool,
  },
  {
    name: "Docs",
    url: "https://docs.googleapis.com/v1",
    listTools: docs.listTools,
    callTool: docs.callTool,
  },
  {
    name: "Sheets",
    url: "https://sheets.googleapis.com/v4/spreadsheets",
    listTools: sheets.listTools,
    callTool: sheets.callTool,
  },
]);

export const listNeedsCredential = false;

const forBackend = (connection: Connection, backend: Backend): Connection => ({
  ...connection,
  url: backend.url,
});

async function ownedTools(
  connection: Connection,
): Promise<Array<{ backend: Backend; tools: McpTool[] }>> {
  return Promise.all(
    BACKENDS.map(async (backend) => ({
      backend,
      tools: await backend.listTools(forBackend(connection, backend)),
    })),
  );
}

export async function listTools(connection: Connection): Promise<McpTool[]> {
  const owned = await ownedTools(connection);
  const seen = new Set<string>();
  const tools: McpTool[] = [];
  for (const { backend, tools: candidates } of owned) {
    for (const tool of candidates) {
      if (seen.has(tool.name)) {
        throw new Error(
          `Google Workspace tool ${tool.name} is advertised by more than one backend; ${backend.name} cannot be selected safely.`,
        );
      }
      seen.add(tool.name);
      tools.push({ ...tool });
    }
  }
  return tools;
}

const failure = (text: string): McpCallResult => ({
  text,
  isError: true,
  truncated: false,
});

export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const owners = (await ownedTools(connection)).filter(({ tools }) =>
    tools.some((tool) => tool.name === toolName),
  );
  if (owners.length !== 1) {
    return failure(
      owners.length === 0
        ? `${toolName} is not a Google Workspace tool in this build. Refresh the connector tool list.`
        : `${toolName} is ambiguous between Google Workspace APIs and was not called.`,
    );
  }
  const { backend } = owners[0];
  return backend.callTool(forBackend(connection, backend), toolName, args);
}

/** Internal editor planner; deliberately absent from listTools and model discovery. */
export async function planConfirmedDocumentEdit(
  connection: Connection,
  input: { documentId: string; sourceText: string; candidateText: string },
): Promise<docs.ConfirmedGoogleDocumentPlanResult> {
  const backend = BACKENDS.find((candidate) => candidate.name === "Docs");
  if (!backend) {
    return { ok: false, message: "Google Docs is unavailable in this build." };
  }
  return docs.planConfirmedDocumentEdit(forBackend(connection, backend), input);
}

/** Internal confirmed write; deliberately absent from listTools and model discovery. */
export async function applyConfirmedDocumentEdit(
  connection: Connection,
  plan: docs.ConfirmedGoogleDocumentEditPlan,
): Promise<docs.ConfirmedGoogleDocumentApplyResult> {
  const backend = BACKENDS.find((candidate) => candidate.name === "Docs");
  if (!backend) {
    return {
      text: "Google Docs is unavailable in this build.",
      isError: true,
      outcome: "not_applied",
    };
  }
  return docs.applyConfirmedDocumentEdit(forBackend(connection, backend), plan);
}

export type {
  ConfirmedGoogleDocumentApplyResult,
  ConfirmedGoogleDocumentEdit,
  ConfirmedGoogleDocumentEditPlan,
  ConfirmedGoogleDocumentPlanResult,
} from "./google-docs-rest";
