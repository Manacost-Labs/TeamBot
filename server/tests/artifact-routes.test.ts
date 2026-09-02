import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createArtifactRoutes } from "../src/artifacts/routes";
import {
  AttachmentQueryError,
  type AttachmentRecord,
} from "../src/attachments/store";
import type { AppVariables } from "../src/auth/guards";

const actor = {
  id: "user-a",
  email: "member@openbot.test",
  role: "user",
} as const;

const generated: AttachmentRecord = {
  id: "10000000-0000-4000-8000-000000000001",
  ownerUserId: actor.id,
  channelId: "channel-a",
  messageId: "artifact:run-1",
  name: "research.md",
  mimeType: "text/markdown",
  size: 123,
  sha256: "a".repeat(64),
  storageKey: "20000000-0000-4000-8000-000000000001",
  source: "agent_generated",
  createdAt: new Date("2026-08-30T12:00:00.000Z"),
};

const userUpload: AttachmentRecord = {
  ...generated,
  id: "10000000-0000-4000-8000-000000000002",
  messageId: null,
  name: "photo.png",
  mimeType: "image/png",
  source: "user_upload",
};

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
  Promise.resolve(context.json({ error: "denied" }, 401));

function appFor(
  listGenerated: (
    actorUserId: string,
    query?: { cursor?: string; limit?: number },
  ) => Promise<{ attachments: AttachmentRecord[]; nextCursor: string | null }>,
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = requireUser,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createArtifactRoutes({ store: { listGenerated } }, middleware),
  );
  return app;
}

describe("generated artifact index route", () => {
  test("authenticates before reading the owner-scoped index", async () => {
    let invoked = false;
    const response = await appFor(async () => {
      invoked = true;
      return { attachments: [], nextCursor: null };
    }, denied).request("http://openbot.test/");

    expect(response.status).toBe(401);
    expect(invoked).toBe(false);
  });

  test("returns generated artifact metadata and never private storage fields", async () => {
    let received:
      | { actorUserId: string; query?: { cursor?: string; limit?: number } }
      | undefined;
    const response = await appFor(async (actorUserId, query) => {
      received = { actorUserId, query };
      return {
        attachments: [generated, userUpload],
        nextCursor: "next-page",
      };
    }).request("http://openbot.test/?limit=10&cursor=page-one");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      attachments: [
        {
          id: generated.id,
          channelId: generated.channelId,
          messageId: generated.messageId,
          name: generated.name,
          mimeType: generated.mimeType,
          size: generated.size,
          sha256: generated.sha256,
          source: generated.source,
          createdAt: generated.createdAt.toISOString(),
        },
      ],
      nextCursor: "next-page",
    });
    expect(received).toEqual({
      actorUserId: actor.id,
      query: { limit: 10, cursor: "page-one" },
    });
    expect(JSON.stringify(await response.clone().text())).not.toContain(
      generated.ownerUserId,
    );
    expect(JSON.stringify(await response.clone().text())).not.toContain(
      generated.storageKey,
    );
  });

  test("rejects malformed pagination before calling the store", async () => {
    let invoked = 0;
    const app = appFor(async () => {
      invoked += 1;
      return { attachments: [], nextCursor: null };
    });

    for (const suffix of ["?limit=0", "?limit=101", "?cursor="]) {
      const response = await app.request(`http://openbot.test/${suffix}`);
      expect(response.status).toBe(400);
    }
    expect(invoked).toBe(0);
  });

  test("maps a malformed store cursor to a safe 400 response", async () => {
    const response = await appFor(async () => {
      throw new AttachmentQueryError();
    }).request("http://openbot.test/?cursor=malformed");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Results query is invalid.",
    });
  });
});
