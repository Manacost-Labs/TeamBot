import * as builtinArtifacts from "./builtin-artifacts";
import * as builtinAttachments from "./builtin-conversation-attachments";
import * as builtinHeartPulseOps from "./builtin-heartpulse-ops";
import * as builtinParserOps from "./builtin-parser-ops";
import * as builtinRoutines from "./builtin-routines";
import type { CatalogueEntry } from "./catalogue";
import * as googleWorkspaceRest from "./google-workspace-rest";
import type { McpCallResult, McpTool } from "./mcp";
import * as mcp from "./mcp";

/**
 * Identity resolved by this deployment before a tool runs.
 *
 * These fields never come from the model's tool arguments. Remote callbacks get them from the
 * signed run assertion; in-process runs get the actor and Bot from the runtime that built the tool.
 * A transport that needs a current conversation may require `runId`/`threadId` and refuse when an
 * older in-process caller did not provide them.
 */
export type TrustedToolCallContext = {
  actorId: string;
  botId: string;
  runId?: string;
  threadId?: string;
};

export type VendorToolConnection = {
  url: string;
  token?: string;
} & TrustedToolCallContext;

/** Build the vendor-facing connection without ever merging model-produced tool arguments into it. */
export function vendorToolConnection(
  connection: { url: string; token?: string },
  context: TrustedToolCallContext,
): VendorToolConnection {
  return {
    ...connection,
    actorId: context.actorId,
    botId: context.botId,
    ...(context.runId !== undefined ? { runId: context.runId } : {}),
    ...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
  };
}

/**
 * How this deployment reaches one vendor: which protocol, chosen per catalogue entry.
 *
 * WHY THIS EXISTS. Every connector used to be MCP, so "the transport" was an import. Google's Drive
 * MCP server turned out to be gated behind a developer preview, and the same product's ordinary REST
 * API is generally available — so one vendor needed a second way in, and a second way in wants a
 * seam rather than a branch at each call site.
 *
 * The interface is MCP's OWN, unchanged: `listTools` and `callTool`, the two functions
 * {@link ./mcp} already exported, with the shapes it already used. That direction matters. Had the
 * REST adapter been given its own interface with MCP adapted to fit, MCP would have become a special
 * case of a shape invented for Drive. As it is, MCP is the contract and the adapter conforms to it,
 * which is why swapping back is one field on one entry and not a refactor.
 *
 * There are exactly two call sites in the whole system — the tool listing and the tool call — and
 * both take a transport from here. Nothing else, including the OAuth flow, the per-person credential
 * selection, the grants, the policy engine and the audit trail, knows which protocol is underneath.
 */
export type VendorTransport = {
  /**
   * Whether discovering the tool list needs somebody's credential.
   *
   * True for MCP, where the list is an answer from a remote server that will not give it up
   * unauthenticated. False for an adapter whose tool list is this code, where there is nothing to ask
   * and nobody to ask it of.
   *
   * It is on the transport rather than assumed by the caller because getting it wrong is a whole
   * broken setup flow. Assumed true, an administrator configuring Drive was sent to their own
   * settings page to connect a personal account, purely so a token could be minted, passed to a
   * function that ignores it, and discarded — then sent back to press refresh. Nothing about that
   * sequence hinted that the middle step was doing no work.
   */
  listNeedsCredential: boolean;
  listTools(connection: {
    url: string;
    token?: string;
    /**
     * Who this call is for, and which Bot is making it.
     *
     * Ignored by every transport that dials a vendor: MCP and Drive answer to a credential, and who
     * holds it is already decided by the time the connection is built. The builtin transport has no
     * credential and no vendor — it acts on this deployment's own tables — so the actor is not
     * context, it is the authorization, and it refuses without one. A routine is somebody's.
     */
    actorId?: string;
    /** The Bot the run belongs to. A routine runs as its Bot, which is never a name a model supplies. */
    botId?: string;
  }): Promise<McpTool[]>;
  callTool(
    connection: VendorToolConnection,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult>;
};

/**
 * The protocols a catalogue entry may name.
 *
 * A closed union rather than a string, so adding one is a change to this file and to the registry
 * below together. An entry naming a transport that does not exist should not typecheck.
 */
export type TransportKind =
  | "mcp"
  | "google-workspace-rest"
  | "builtin-artifacts"
  | "builtin-attachments"
  | "builtin-routines"
  | "builtin-parser-ops"
  | "builtin-heartpulse-ops";

const TRANSPORTS: Record<TransportKind, VendorTransport> = {
  mcp,
  "google-workspace-rest": googleWorkspaceRest,
  "builtin-artifacts": builtinArtifacts,
  "builtin-attachments": builtinAttachments,
  "builtin-routines": builtinRoutines,
  "builtin-parser-ops": builtinParserOps,
  "builtin-heartpulse-ops": builtinHeartPulseOps,
};

/**
 * Which transport serves this entry.
 *
 * MCP for anything that does not say otherwise, which covers every catalogue entry that omits the
 * field and — importantly — every server an administrator added by URL, where there is no entry at
 * all. A custom server is somebody else's MCP endpoint by definition, so the absent case and the
 * default case are the same answer for the same reason.
 */
export function transportFor(entry: CatalogueEntry | null): VendorTransport {
  return TRANSPORTS[entry?.transport ?? "mcp"];
}
