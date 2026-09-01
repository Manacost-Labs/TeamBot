import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { hasManagedAgentToken } from "../../../shared/agent-authorisation";
import { readRunAssertion } from "../agents/callback-token";
import { isValidChatGptAuthDocument } from "./device-flows";
import {
  PersonalAiCredentialLeaseRefusedError,
  type PersonalAiCredentialLeaseService,
  PersonalAiCredentialRefreshRefusedError,
} from "./leases";

export const PERSONAL_AI_CREDENTIAL_REDEMPTION_PATH =
  "/internal/ai-credentials/redeem";
export const PERSONAL_AI_CREDENTIAL_REFRESH_PATH =
  "/internal/ai-credentials/refresh";
const MAX_REDEMPTION_BODY_BYTES = 16 * 1_024;
// The validated auth.json is at most 256 KiB, but embedding that JSON string in the managed
// request can escape every quote and backslash. Bound the wire representation without rejecting
// a valid worst-case document.
const MAX_REFRESH_BODY_BYTES = 544 * 1_024;
const SAFE_REFUSAL = "Credential lease is unavailable.";
const SAFE_REFRESH_REFUSAL = "Credential refresh is unavailable.";
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

function exactRefreshBody(value: unknown): value is Readonly<{
  lease: string;
  run: string;
  authDocument: string;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  return (
    keys.length === 3 &&
    keys[0] === "authDocument" &&
    keys[1] === "lease" &&
    keys[2] === "run" &&
    typeof source.lease === "string" &&
    typeof source.run === "string" &&
    isValidChatGptAuthDocument(source.authDocument)
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
export type PersonalAiCredentialInternalRoutesOptions = {
  service: Pick<PersonalAiCredentialLeaseService, "redeem" | "refresh">;
  encryptionKey: string;
  managedAgentToken: string;
};

export function createPersonalAiCredentialInternalRoutes(
  options: PersonalAiCredentialInternalRoutesOptions,
) {
  const routes = new Hono();
  const limitBody = bodyLimit({
    maxSize: MAX_REDEMPTION_BODY_BYTES,
    onError: (context) =>
      context.json({ error: "Credential lease request is too large." }, 413),
  });
  const limitRefreshBody = bodyLimit({
    maxSize: MAX_REFRESH_BODY_BYTES,
    onError: (context) =>
      context.json({ error: "Credential refresh request is too large." }, 413),
  });

  routes.use(PERSONAL_AI_CREDENTIAL_REDEMPTION_PATH, async (context, next) => {
    context.header("cache-control", "private, no-store");
    await next();
  });
  routes.use(PERSONAL_AI_CREDENTIAL_REFRESH_PATH, async (context, next) => {
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

  routes.post(
    PERSONAL_AI_CREDENTIAL_REFRESH_PATH,
    limitRefreshBody,
    async (context) => {
      if (
        context.req.url.includes("?") ||
        !jsonMediaType(context.req.header("content-type")) ||
        !hasManagedAgentToken(context.req.raw, options.managedAgentToken)
      ) {
        return context.json({ error: SAFE_REFRESH_REFUSAL }, 403);
      }

      const body = await context.req.json().catch(() => undefined);
      if (!exactRefreshBody(body)) {
        return context.json({ error: SAFE_REFRESH_REFUSAL }, 403);
      }
      const run = readRunAssertion(body.run, options.encryptionKey);
      if (!run) {
        return context.json({ error: SAFE_REFRESH_REFUSAL }, 403);
      }

      try {
        await options.service.refresh({
          lease: body.lease,
          actorUserId: run.actorId,
          botId: run.botId,
          runId: run.runId,
          authDocument: body.authDocument,
        });
        return context.body(null, 204);
      } catch (error) {
        return error instanceof PersonalAiCredentialRefreshRefusedError
          ? context.json({ error: SAFE_REFRESH_REFUSAL }, 403)
          : context.json({ error: SAFE_UNAVAILABLE }, 503);
      }
    },
  );

  return routes;
}
