import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { BotAccessCheck } from "../agents/profile-policy";
import type { AppVariables } from "../auth/guards";
import { requireAdmin } from "../auth/guards";
import type { ManacostTeamService } from "./manacost-team";
import {
  MANACOST_APPROVAL_TTL_MS,
  ManacostTeamRefusedError,
  PARSER_ACTIONS,
  type ParserAction,
} from "./manacost-team";

export type { ManacostTeamService } from "./manacost-team";

function objectBody(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function action(value: unknown): ParserAction | null {
  return typeof value === "string" &&
    PARSER_ACTIONS.includes(value as ParserAction)
    ? (value as ParserAction)
    : null;
}

function errorResponse(
  context: { json: (body: unknown, status?: number) => Response },
  error: unknown,
) {
  if (error instanceof ManacostTeamRefusedError) {
    return context.json({ error: error.message }, 400);
  }
  // Keep credentials and upstream URLs out of logs; the run record already stores a bounded error.
  console.warn("[manacost-team] request failed");
  return context.json({ error: "The ManacostTeam operation failed." }, 500);
}

/** Server-owned skill and bounded autonomy endpoints. */
export function createManacostTeamRoutes(
  service: ManacostTeamService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  canUseBot: BotAccessCheck,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/catalogue", requireUser, async (context) =>
    context.json({ skills: await service.catalogue() }),
  );

  routes.get(
    "/skills/:slug/for-agent/:agentId",
    requireUser,
    async (context) => {
      const agentId = context.req.param("agentId");
      if (!(await canUseBot(context.var.actor, agentId))) {
        return context.json({ error: "There is no such Bot." }, 404);
      }
      const skill = await service.instructionsForAgent(
        agentId,
        context.req.param("slug"),
      );
      return skill
        ? context.json(skill)
        : context.json(
            { error: "There is no approved skill for this Bot." },
            404,
          );
    },
  );

  routes.get("/profile", requireUser, async (context) =>
    context.json({ profile: await service.profile() }),
  );

  routes.put("/profile", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = objectBody(await context.req.json().catch(() => null));
    if (!body)
      return context.json({ error: "A profile object is required." }, 400);
    try {
      return context.json({
        profile: await service.updateProfile(context.var.actor.id, {
          ...(body.maxSteps !== undefined
            ? { maxSteps: body.maxSteps as number }
            : {}),
          ...(body.maxDurationMs !== undefined
            ? { maxDurationMs: body.maxDurationMs as number }
            : {}),
          ...(body.maxRetries !== undefined
            ? { maxRetries: body.maxRetries as number }
            : {}),
          ...(body.maxOutputChars !== undefined
            ? { maxOutputChars: body.maxOutputChars as number }
            : {}),
        }),
      });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  routes.post("/catalogue/sync", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    try {
      return context.json(await service.importCanonicalSkills());
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  routes.post("/runs", requireUser, async (context) => {
    const body = objectBody(await context.req.json().catch(() => null));
    const agentId = typeof body?.agentId === "string" ? body.agentId : null;
    const skillSlug =
      typeof body?.skillSlug === "string" ? body.skillSlug : null;
    const selectedAction = action(body?.action);
    if (!agentId || !skillSlug || !selectedAction) {
      return context.json(
        {
          error: "agentId, skillSlug, and a valid parser action are required.",
        },
        400,
      );
    }
    if (!(await canUseBot(context.var.actor, agentId))) {
      return context.json({ error: "There is no such Bot." }, 404);
    }
    const input = body?.input === undefined ? {} : objectBody(body.input);
    if (!input) return context.json({ error: "input must be an object." }, 400);
    try {
      const result = await service.startRun({
        actorId: context.var.actor.id,
        botId: agentId,
        skillSlug,
        action: selectedAction,
        input,
      });
      // Runs continue in the server after this request; callers follow the durable run id.
      return context.json(result, 202);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  routes.get("/runs/:id", requireUser, async (context) => {
    const run = await service.getRun(
      context.req.param("id"),
      context.var.actor.id,
      context.var.actor.role === "admin",
    );
    return run
      ? context.json(run)
      : context.json({ error: "There is no such autonomy run." }, 404);
  });

  routes.post("/runs/:id/resume", requireUser, async (context) => {
    try {
      const run = await service.resumeRun({
        runId: context.req.param("id"),
        actorId: context.var.actor.id,
        isAdmin: context.var.actor.role === "admin",
      });
      return run
        ? context.json({ run }, 202)
        : context.json({ error: "There is no such autonomy run." }, 404);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  routes.post("/runs/:id/approve", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = objectBody(await context.req.json().catch(() => null));
    if (typeof body?.approvalToken !== "string" || !body.approvalToken) {
      return context.json(
        { error: "A one-time approvalToken is required." },
        400,
      );
    }
    try {
      const run = await service.approveRun({
        runId: context.req.param("id"),
        token: body.approvalToken,
      });
      return context.json({ run, approvalTtlMs: MANACOST_APPROVAL_TTL_MS });
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  return routes;
}
