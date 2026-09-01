import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { hasManagedAgentToken } from "../../../shared/agent-authorisation";
import { readRunAssertion } from "../agents/callback-token";
import {
  PersonalAiCredentialLeaseRefusedError,
  type PersonalAiCredentialLeaseService,
} from "./leases";

export const PERSONAL_AI_CREDENTIAL_REDEMPTION_PATH =
  "/internal/ai-credentials/redeem";
const MAX_REDEMPTION_BODY_BYTES = 16 * 1_024;
const SAFE_REFUSAL = "Credential lease is unavailable.";
const SAFE_UNAVAILABLE = "Credential service is temporarily unavailable.";

function exactBody(
  value: unknown,
): value is Readonly<{ lease: string; run: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  return (
    keys.length === 2 &&
    keys[0] === "lease" &&
    keys[1] === "run" &&
    typeof source.lease === "string" &&
    typeof source.run === "string"
  );
}

function jsonMediaType(value: string | undefined) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

/**
 * Private agent-to-server redemption boundary.
 *
 * The managed token proves which deployment process is calling. The signed run supplies the actor,
 * Bot and run identifiers; the request has no separate ownership fields it could swap. The lease
 * service compares that signed tuple to the durable row and live connection before returning a
 * provider-discriminated secret exactly once.
 */
export function createPersonalAiCredentialInternalRoutes(options: {
  service: Pick<PersonalAiCredentialLeaseService, "redeem">;
  encryptionKey: string;
  managedAgentToken: string;
}) {
  const routes = new Hono();
  const limitBody = bodyLimit({
    maxSize: MAX_REDEMPTION_BODY_BYTES,
    onError: (context) =>
      context.json({ error: "Credential lease request is too large." }, 413),
  });

  routes.use(PERSONAL_AI_CREDENTIAL_REDEMPTION_PATH, async (context, next) => {
    context.header("cache-control", "private, no-store");
    await next();
  });

  routes.post(
    PERSONAL_AI_CREDENTIAL_REDEMPTION_PATH,
    limitBody,
    async (context) => {
      if (
        context.req.url.includes("?") ||
        !jsonMediaType(context.req.header("content-type")) ||
        !hasManagedAgentToken(context.req.raw, options.managedAgentToken)
      ) {
        return context.json({ error: SAFE_REFUSAL }, 403);
      }

      const body = await context.req.json().catch(() => undefined);
      if (!exactBody(body)) {
        return context.json({ error: SAFE_REFUSAL }, 403);
      }
      const run = readRunAssertion(body.run, options.encryptionKey);
      if (!run) return context.json({ error: SAFE_REFUSAL }, 403);

      try {
        const credential = await options.service.redeem({
          lease: body.lease,
          actorUserId: run.actorId,
          botId: run.botId,
          runId: run.runId,
        });
        // This is the sole plaintext response boundary. It is never spread into an error or log,
        // and no browser route mounts this factory.
        return context.json(credential);
      } catch (error) {
        return error instanceof PersonalAiCredentialLeaseRefusedError
          ? context.json({ error: SAFE_REFUSAL }, 403)
          : context.json({ error: SAFE_UNAVAILABLE }, 503);
      }
    },
  );

  return routes;
}
