import { Hono, type MiddlewareHandler } from "hono";
import { authoriseAgentCall } from "../agents/callback-token";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import type { GoogleDocumentEditService } from "./google-document-edits";

const operationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const documentIdPattern = /^[A-Za-z0-9_-]{1,256}$/;

export function createGoogleDocumentEditRoutes(options: {
  service: GoogleDocumentEditService;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  canUseBot: BotAccessCheck;
  encryptionKey: string;
  legacyAgentToken: string;
  agentProfiles?: AgentProfileStore;
  allowedOrigins?: Array<string | undefined>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const configuredOrigins = new Set(
    (options.allowedOrigins ?? []).flatMap((value) => {
      if (!value) return [];
      try {
        return [new URL(value).origin];
      } catch {
        return [];
      }
    }),
  );

  routes.post("/internal/editor/google-doc-edits", async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      run?: unknown;
      documentId?: unknown;
      sourceText?: unknown;
      candidateText?: unknown;
    } | null;
    const verdict = await authoriseAgentCall({
      presented: context.req.header("x-openbot-agent-token") ?? "",
      run: body?.run,
      encryptionKey: options.encryptionKey,
      legacyToken: options.legacyAgentToken,
      lookup: async (hash) =>
        (await options.agentProfiles?.agentForCallbackToken(hash)) ?? null,
    });
    if (!verdict.ok) {
      return context.json({ error: verdict.reason }, verdict.status);
    }
    if (
      !verdict.threadId ||
      typeof body?.documentId !== "string" ||
      !documentIdPattern.test(body.documentId) ||
      typeof body.sourceText !== "string" ||
      typeof body.candidateText !== "string"
    ) {
      return context.json(
        {
          error:
            "A signed thread and a bounded Google Docs correction are required.",
        },
        400,
      );
    }

    try {
      const prepared = await options.service.prepare({
        actorId: verdict.actorId,
        botId: verdict.botId,
        runId: verdict.runId,
        threadId: verdict.threadId,
        documentId: body.documentId,
        sourceText: body.sourceText,
        candidateText: body.candidateText,
      });
      return context.json(prepared, 201);
    } catch (error) {
      return context.json(
        {
          error:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "The Google Docs save could not be prepared.",
        },
        422,
      );
    }
  });

  routes.get(
    "/api/editor/google-doc-edits/:id",
    options.requireUser,
    async (context) => {
      const id = context.req.param("id");
      if (!operationIdPattern.test(id)) {
        return context.json({ error: "That edit does not exist." }, 404);
      }
      const review = await options.service.get(id, context.var.actor.id);
      if (
        !review ||
        !(await options.canUseBot(context.var.actor, review.botId))
      ) {
        return context.json({ error: "That edit does not exist." }, 404);
      }
      return context.json({ edit: review });
    },
  );

  routes.post(
    "/api/editor/google-doc-edits/:id/decision",
    options.requireUser,
    async (context) => {
      const id = context.req.param("id");
      if (!operationIdPattern.test(id)) {
        return context.json({ error: "That edit does not exist." }, 404);
      }
      const origin = context.req.header("origin");
      const requestOrigin = new URL(context.req.url).origin;
      if (
        !origin ||
        (origin !== requestOrigin && !configuredOrigins.has(origin))
      ) {
        return context.json(
          { error: "This decision must come from this app." },
          403,
        );
      }
      if (
        !(context.req.header("content-type") ?? "")
          .toLowerCase()
          .startsWith("application/json")
      ) {
        return context.json({ error: "A JSON decision is required." }, 415);
      }
      const body = (await context.req.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (
        !body ||
        Object.keys(body).length !== 1 ||
        (body.decision !== "approve" && body.decision !== "decline")
      ) {
        return context.json(
          { error: "The decision must be approve or decline." },
          400,
        );
      }

      const current = await options.service.get(id, context.var.actor.id);
      if (
        !current ||
        !(await options.canUseBot(context.var.actor, current.botId))
      ) {
        return context.json({ error: "That edit does not exist." }, 404);
      }
      const edit = await options.service.decide(
        id,
        context.var.actor.id,
        body.decision,
      );
      return edit
        ? context.json({ edit })
        : context.json({ error: "That edit does not exist." }, 404);
    },
  );

  return routes;
}
