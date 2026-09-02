import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  AttachmentQueryError,
  type AttachmentRecord,
  type AttachmentStore,
} from "../attachments/store";

const MAX_PAGE_SIZE = 100;

type ArtifactIndexStore = Pick<AttachmentStore, "listGenerated">;

export type ArtifactRouteDependencies = {
  store: ArtifactIndexStore;
};

type ArtifactListQuery = {
  cursor?: string;
  limit?: number;
};

type PublicArtifactAttachment = {
  id: string;
  channelId: string;
  messageId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  source: "agent_generated";
  createdAt: string;
};

function invalidQuery() {
  return new Response(JSON.stringify({ error: "Results query is invalid." }), {
    status: 400,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

function listQuery(url: URL): ArtifactListQuery {
  const query: ArtifactListQuery = {};
  if (url.searchParams.has("cursor")) {
    const cursor = url.searchParams.get("cursor") ?? "";
    if (!cursor) throw new AttachmentQueryError();
    query.cursor = cursor;
  }
  if (url.searchParams.has("limit")) {
    const raw = url.searchParams.get("limit") ?? "";
    if (!/^[1-9][0-9]*$/.test(raw)) throw new AttachmentQueryError();
    const limit = Number(raw);
    if (!Number.isSafeInteger(limit) || limit > MAX_PAGE_SIZE) {
      throw new AttachmentQueryError();
    }
    query.limit = limit;
  }
  return query;
}

function publicArtifactAttachment(
  record: AttachmentRecord,
): PublicArtifactAttachment | null {
  if (
    record.source !== "agent_generated" ||
    !record.messageId?.startsWith("artifact:")
  ) {
    return null;
  }
  return {
    id: record.id,
    channelId: record.channelId,
    messageId: record.messageId,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    sha256: record.sha256,
    source: "agent_generated",
    createdAt: record.createdAt.toISOString(),
  };
}

/** Read-only, owner-scoped index for generated files from all active channels. */
export function createArtifactRoutes(
  dependencies: ArtifactRouteDependencies,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    try {
      const page = await dependencies.store.listGenerated(
        context.var.actor.id,
        listQuery(new URL(context.req.url)),
      );
      return context.json({
        attachments: page.attachments.flatMap((record) => {
          const artifact = publicArtifactAttachment(record);
          return artifact ? [artifact] : [];
        }),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      return error instanceof AttachmentQueryError
        ? invalidQuery()
        : new Response(JSON.stringify({ error: "Results request failed." }), {
            status: 500,
            headers: { "content-type": "application/json; charset=UTF-8" },
          });
    }
  });

  return routes;
}
