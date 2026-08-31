export type AgentVisibility = "public" | "private";

export type AgentReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "adaptive";

export type AgentAdaptiveReasoningCeiling = "low" | "medium" | "high" | "xhigh";

export type AgentActor = {
  id: string;
  role: "admin" | "user";
};

export type AgentProfile = {
  id: string;
  name: string;
  title: string;
  roleDescription: string;
  avatarSeed: string;
  visibility: AgentVisibility;
  ownerUserId: string | null;
  systemOwned: boolean;
  hidden: boolean;
  deletedAt: Date | null;
  /** Where this coworker runs. Null for the Bot in the box. */
  endpoint: string | null;
  /** Whether a key is set for it. Never the key. */
  hasAuth: boolean;
  /** Optional managed-runtime model override. Null keeps the deployment/account default. */
  model: string | null;
  /** Optional managed-runtime effort override. Null keeps the runtime default. */
  reasoningEffort: AgentReasoningEffort | null;
  /** Maximum effort an adaptive employee may select. Null unless adaptive mode is enabled. */
  reasoningCeiling: AgentAdaptiveReasoningCeiling | null;
  /**
   * Whether this agent holds a credential for calling tools back.
   *
   * A boolean, never the token: the token exists in a readable form once, in the response that issued
   * it. A surface only needs to know whether to offer "generate" or "rotate".
   */
  hasCallbackToken: boolean;
};

export type CreateAgentInput = Pick<
  AgentProfile,
  "name" | "title" | "roleDescription" | "visibility"
> & {
  /**
   * The AG-UI endpoint this Bot runs on, or undefined for the one in the box.
   *
   * This field is the AG-UI endpoint for a customer-provided agent. Without it the Bot runs on the
   * built-in endpoint.
   */
  endpoint?: string;
  /**
   * A key this agent sits behind, if any.
   *
   * Write-only. It goes to the vault and is never read back to a person: the edit form shows that a
   * key is set, not what it is. Absent on an update means "leave whatever is there alone", which is
   * why it is optional rather than defaulting to empty; a blank field must not drop a key.
   */
  auth?: { header: string; value: string };
  /** Empty/absent keeps the deployment or ChatGPT account default. */
  model?: string | null;
  /** Empty/absent keeps the managed runtime's bounded default. */
  reasoningEffort?: AgentReasoningEffort | null;
  /** Explicit cost ceiling for adaptive reasoning. */
  reasoningCeiling?: AgentAdaptiveReasoningCeiling | null;
  /** Optional deterministic avatar seed; the server mints one when omitted. */
  avatarSeed?: string;
};
