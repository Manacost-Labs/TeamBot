import { createHmac } from "node:crypto";
import {
  mintRunAssertion,
  type RunAssertion,
  readRunAssertion,
  runAssertionTtlMs,
} from "../agents/callback-token";
import {
  PersonalAiConnectionRequiredError,
  type PersonalAiCredentialLeaseService,
} from "./leases";

export const PERSONAL_AI_SETTINGS_GUIDANCE =
  "AI недоступен: подключите ChatGPT или OpenRouter в настройках";

const ADMISSION_LABEL = "openbot:actor-admission:v1\0";
const ADMISSION_PREFIX = "oba_";

export type GovernedRemoteRunProperties = Readonly<{
  openbotRun: string;
  openbotCredentialLease: string;
  openbotAdmissionKey: string;
}>;

export type PersonalAiRunGovernanceInput = Readonly<{
  botId: string;
  endpoint: string;
  runId: string;
  threadId: string;
  forwardedProps: Readonly<Record<string, unknown>>;
}>;

/** Carry handoff depth only when the signed chain belongs to this exact trusted actor and Bot. */
export function trustedRunDepth(
  assertion: RunAssertion | null,
  actorUserId: string,
  botId: string,
): number {
  return assertion?.actorId === actorUserId && assertion.botId === botId
    ? (assertion.depth ?? 0)
    : 0;
}

/**
 * Stable queue/admission partition for one actor without forwarding their database identifier.
 *
 * Domain-separated HMAC means two deployments produce unrelated values for the same person, while
 * every replica of one deployment produces the same value. The managed runtime can serialize that
 * partition without ever receiving the identifier which selected it.
 */
export function actorAdmissionKey(
  actorUserId: string,
  encryptionKey: string,
): string {
  if (!actorUserId || !encryptionKey) {
    throw new Error("Actor admission key input is invalid.");
  }
  const digest = createHmac("sha256", encryptionKey)
    .update(ADMISSION_LABEL)
    .update(actorUserId)
    .digest("base64url");
  return `${ADMISSION_PREFIX}${digest}`;
}

/**
 * Prepare one remote run from the actor resolved by the application server.
 *
 * Browser/model ownership fields are accepted only as untrusted input to inspect for a previously
 * server-signed handoff assertion. Even then, only its chain depth is reused, and only when its
 * actor and Bot match this trusted closure. The actual run/thread are always the current AG-UI
 * input, and the lease is always minted for the closure's actor.
 */
export function createPersonalAiRunGovernorForActor(options: {
  actorUserId: string;
  encryptionKey: string;
  managedAgentEndpoint: string;
  leases: Pick<PersonalAiCredentialLeaseService, "mint">;
  now?: () => number;
}) {
  const admissionKey = actorAdmissionKey(
    options.actorUserId,
    options.encryptionKey,
  );
  const now = options.now ?? Date.now;

  return async (
    input: PersonalAiRunGovernanceInput,
  ): Promise<GovernedRemoteRunProperties | undefined> => {
    // Customer-owned AG-UI endpoints keep their own authentication/provider contract. Personal
    // provider delivery belongs only to the deployment-managed Codex runtime.
    if (input.endpoint !== options.managedAgentEndpoint) return undefined;

    const preceding = readRunAssertion(
      input.forwardedProps.openbotRun,
      options.encryptionKey,
      now(),
    );
    const depth = trustedRunDepth(preceding, options.actorUserId, input.botId);

    let lease: string;
    try {
      lease = await options.leases.mint({
        actorUserId: options.actorUserId,
        botId: input.botId,
        runId: input.runId,
      });
    } catch (error) {
      if (error instanceof PersonalAiConnectionRequiredError) {
        throw new Error(PERSONAL_AI_SETTINGS_GUIDANCE);
      }
      throw error;
    }

    return Object.freeze({
      openbotRun: mintRunAssertion(
        {
          botId: input.botId,
          actorId: options.actorUserId,
          runId: input.runId,
          threadId: input.threadId,
          depth,
        },
        options.encryptionKey,
        now(),
        runAssertionTtlMs(input.botId),
      ),
      openbotCredentialLease: lease,
      openbotAdmissionKey: admissionKey,
    });
  };
}
