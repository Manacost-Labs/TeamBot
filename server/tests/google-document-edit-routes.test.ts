import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createGoogleDocumentEditRoutes } from "../src/editor/google-document-edit-routes";
import type {
  GoogleDocumentEditReview,
  GoogleDocumentEditService,
} from "../src/editor/google-document-edits";

const operationId = "11111111-1111-4111-8111-111111111111";
const actor = {
  id: "user-1",
  email: "owner@openbot.test",
  role: "user",
} as const;

const review: GoogleDocumentEditReview = {
  id: operationId,
  state: "pending",
  botId: "chief-editor",
  documentId: "document_1",
  editCount: 1,
  removedCharacters: 5,
  insertedCharacters: 6,
  expiresAt: "2026-08-31T12:00:00.000Z",
  edits: [{ position: 8, before: "было", after: "стало" }],
};

type DecisionCall = [string, string, "approve" | "decline"];

function appFor(options: {
  get?: (
    id: string,
    actorId: string,
  ) => Promise<GoogleDocumentEditReview | null>;
  canUseBot?: (botId: string) => boolean;
}) {
  const decisions: DecisionCall[] = [];
  const service = {
    async prepare() {
      throw new Error("not used");
    },
    get:
      options.get ??
      (async (id: string, actorId: string) =>
        id === operationId && actorId === actor.id ? review : null),
    async decide(id: string, actorId: string, decision: "approve" | "decline") {
      decisions.push([id, actorId, decision]);
      return {
        ...review,
        state: decision === "approve" ? "succeeded" : "declined",
      } as GoogleDocumentEditReview;
    },
  } as unknown as GoogleDocumentEditService;
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", actor);
    await next();
  };
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/",
    createGoogleDocumentEditRoutes({
      service,
      requireUser,
      canUseBot: async (_requestActor, botId) =>
        options.canUseBot?.(botId) ?? true,
      encryptionKey: "unused-by-owner-routes",
      legacyAgentToken: "unused-by-owner-routes",
      allowedOrigins: ["https://work.example.test"],
    }),
  );
  return { app, decisions };
}

describe("confirmed Google Docs owner routes", () => {
  test("returns only the signed-in owner's server-side review", async () => {
    const calls: Array<[string, string]> = [];
    const { app } = appFor({
      get: async (id, actorId) => {
        calls.push([id, actorId]);
        return review;
      },
    });

    const response = await app.request(
      `https://work.example.test/api/editor/google-doc-edits/${operationId}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ edit: review });
    expect(calls).toEqual([[operationId, actor.id]]);
  });

  test("hides unknown and inaccessible edits as not found", async () => {
    const unknown = appFor({ get: async () => null });
    const inaccessible = appFor({ canUseBot: () => false });

    expect(
      (
        await unknown.app.request(
          `https://work.example.test/api/editor/google-doc-edits/${operationId}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await inaccessible.app.request(
          `https://work.example.test/api/editor/google-doc-edits/${operationId}`,
        )
      ).status,
    ).toBe(404);
  });

  test("requires a same-origin strict JSON decision", async () => {
    const { app, decisions } = appFor({});
    const url = `https://work.example.test/api/editor/google-doc-edits/${operationId}/decision`;

    expect(
      (
        await app.request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "approve" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://attacker.example",
          },
          body: JSON.stringify({ decision: "approve" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://work.example.test",
          },
          body: JSON.stringify({ decision: "approve", documentId: "swapped" }),
        })
      ).status,
    ).toBe(400);
    expect(decisions).toEqual([]);
  });

  test("passes only the stored edit id, session actor and explicit decision", async () => {
    const { app, decisions } = appFor({});
    const response = await app.request(
      `https://work.example.test/api/editor/google-doc-edits/${operationId}/decision`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://work.example.test",
        },
        body: JSON.stringify({ decision: "approve" }),
      },
    );

    expect(response.status).toBe(200);
    expect(decisions).toEqual([[operationId, actor.id, "approve"]]);
  });
});
