import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables, AuthenticatedActor } from "../auth/guards";
import type { ThreadIdentity } from "./thread-identity";

/**
 * A thread id for a conversation this deployment keeps no channel for.
 *
 * The direct Bot chat is CopilotKit's own component, and left to itself it generates an id in the
 * browser that says nothing about where the conversation came from. Minting it here puts those
 * threads in the same namespace as every channel's, so one project shared by two deployments can
 * still tell whose conversations are whose.
 *
 * Behind the session guard because a thread id is the name of somewhere a conversation will be
 * stored, and there is no reason for anybody signed out to be handed one.
 */

/**
 * Answers whether Intelligence still has a given thread for a given person.
 *
 * Two outcomes only, and deliberately not a third: `"known"` means the thread is there, `"unknown"`
 * means Intelligence has clearly said it is not. A check that failed to get either answer — a
 * timeout, a 5xx, a client that was never configured right — is not a value this type can hold; the
 * function that implements it throws instead, so `GET /:threadId` below can tell "this thread is
 * gone" from "this thread could not be checked" and answer 502 for the second rather than quietly
 * reporting it as gone.
 */
export type ThreadReader = (
  threadId: string,
  userId: string,
) => Promise<"known" | "unknown">;

/** Server-authoritative answer about an active run lock for one user/thread/agent tuple. */
export type ThreadExecutionReader = (
  threadId: string,
  userId: string,
  agentId: string,
) => Promise<boolean>;

/** Prove the authenticated actor owns the channel/thread/agent tuple before touching Intelligence. */
export type ThreadExecutionAuthorizer = (
  threadId: string,
  actor: AuthenticatedActor,
  agentId: string,
  channelId: string,
) => Promise<boolean>;

/**
 * A UUID-shaped string, nothing more. Not the format `thread-identity.ts` mints — this route also
 * has to answer for a thread a *different* deployment minted, or one minted before this deployment
 * had a name, and `identity.owns` is false for both of those without either meaning the thread is
 * gone. The only question this route can honestly ask is Intelligence's own; the shape check exists
 * only to keep a string that could not possibly be a thread id from reaching Intelligence at all.
 */
const PLAUSIBLE_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAUSIBLE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PLAUSIBLE_CHANNEL_ID =
  /^channel_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createThreadRoutes(
  identity: ThreadIdentity,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /**
   * Absent when this deployment has no way to ask Intelligence about a thread — no client, or a
   * caller that chose not to build one. `GET /:threadId` is then not registered at all, rather than
   * registered and answering 502 to everyone: a route that cannot possibly succeed should not exist.
   * `POST /mint` needs no reader and is unaffected either way.
   */
  readThread?: ThreadReader,
  readExecution?: ThreadExecutionReader,
  authorizeExecution?: ThreadExecutionAuthorizer,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/mint", requireUser, (context) =>
    context.json({ threadId: identity.mint() }),
  );

  if (readThread) {
    /*
     * What this buys the browser: proof, before it sends a single message, that a thread id it
     * remembers from last time is one Intelligence still has. If the answer is no, it can start a
     * fresh thread knowing there is provably nothing left in the old one to lose. Without this route
     * that is not what happens — the browser sends anyway, Intelligence silently starts a new, empty
     * thread under the remembered id, and the person is answered as though the conversation were new
     * with nothing on screen to say their history is gone.
     */
    routes.get("/:threadId", requireUser, async (context) => {
      const threadId = context.req.param("threadId");
      if (!PLAUSIBLE_THREAD_ID.test(threadId)) {
        return context.json({ error: "Not a thread id." }, 400);
      }

      try {
        const status = await readThread(threadId, context.var.actor.id);
        return context.json({ known: status === "known" });
      } catch {
        // The reader throws for everything short of a clean known/unknown answer, and what it threw
        // may name an upstream host or otherwise be unfit for a browser to see, so only its kind is
        // logged, not its content. The browser gets "the check failed", which is exactly as much as
        // it is owed: enough to know not to trust `known: false`, nothing that was not already true
        // before this request.
        console.error(
          JSON.stringify({
            type: "thread-status-check-failed",
            note: "Could not determine whether Intelligence still has this thread.",
          }),
        );
        return context.json({ error: "Could not check thread status." }, 502);
      }
    });
  }

  if (readExecution && authorizeExecution) {
    routes.get("/:threadId/execution", requireUser, async (context) => {
      const threadId = context.req.param("threadId");
      const agentId = context.req.query("agentId") ?? "";
      const channelId = context.req.query("channelId") ?? "";
      if (!PLAUSIBLE_THREAD_ID.test(threadId)) {
        return context.json({ error: "Not a thread id." }, 400);
      }
      if (!PLAUSIBLE_AGENT_ID.test(agentId)) {
        return context.json({ error: "Not an agent id." }, 400);
      }
      if (!PLAUSIBLE_CHANNEL_ID.test(channelId)) {
        return context.json({ error: "Not a channel id." }, 400);
      }

      try {
        const authorised = await authorizeExecution(
          threadId,
          context.var.actor,
          agentId,
          channelId,
        );
        if (!authorised) {
          // Do not reveal which part of the tuple exists. A caller may ask only about the exact
          // channel/thread/agent relationship already visible through its authenticated roster.
          return context.json({ error: "Conversation not found." }, 404);
        }
        const active = await readExecution(
          threadId,
          context.var.actor.id,
          agentId,
        );
        return context.json({ active });
      } catch {
        console.error(
          JSON.stringify({
            type: "thread-execution-check-failed",
            note: "Could not determine whether Intelligence has an active run for this thread.",
          }),
        );
        return context.json(
          { error: "Could not check thread execution." },
          502,
        );
      }
    });
  }

  return routes;
}
