import { once } from "node:events";
import { Readable } from "node:stream";
import Busboy, {
  type BusboyFileStream,
  type BusboyInstance,
} from "@fastify/busboy";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  AttachmentUploadBusyError,
  type AttachmentUploadService,
} from "./lifecycle";
import {
  AttachmentQueryError,
  type AttachmentRecord,
  type AttachmentStore,
} from "./store";
import { AttachmentValidationError } from "./validation";

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const ARTIFACT_PREVIEW_MIME_TYPES = new Set([
  "text/markdown",
  "text/plain",
  "application/json",
  "text/csv",
  "image/svg+xml",
  "text/html",
  "application/pdf",
]);

type AttachmentReadStore = Pick<AttachmentStore, "delete" | "get" | "list">;
type AttachmentBlobReader = {
  open(storageKey: string): Promise<ReadableStream<Uint8Array>>;
};

export type AttachmentRouteDependencies = {
  store: AttachmentReadStore;
  uploads: AttachmentUploadService;
  blobs: AttachmentBlobReader;
  maxUploadBytes?: number;
};

type PublicAttachmentDto = {
  id: string;
  channelId: string;
  messageId: string | null;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  source: AttachmentRecord["source"];
  createdAt: string;
};

class MultipartRequestError extends Error {
  override readonly name = "MultipartRequestError";
}

class UploadTooLargeError extends Error {
  override readonly name = "UploadTooLargeError";
}

class UploadLeaseExpiredError extends Error {
  override readonly name = "UploadLeaseExpiredError";
}

function publicAttachment(record: AttachmentRecord): PublicAttachmentDto {
  return {
    id: record.id,
    channelId: record.channelId,
    messageId: record.messageId,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    sha256: record.sha256,
    source: record.source,
    createdAt: record.createdAt.toISOString(),
  };
}

function notFound() {
  return new Response(JSON.stringify({ error: "Attachment not found." }), {
    status: 404,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

function internalFailure() {
  return new Response(JSON.stringify({ error: "Attachment request failed." }), {
    status: 500,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

function malformedRequest() {
  return new Response(
    JSON.stringify({
      error: 'Expected one multipart file field named "file".',
    }),
    {
      status: 400,
      headers: { "content-type": "application/json; charset=UTF-8" },
    },
  );
}

function invalidQuery() {
  return new Response(
    JSON.stringify({ error: "Attachment query is invalid." }),
    {
      status: 400,
      headers: { "content-type": "application/json; charset=UTF-8" },
    },
  );
}

function lostLease() {
  return new Response(
    JSON.stringify({ error: "Attachment upload lease was lost." }),
    {
      status: 409,
      headers: { "content-type": "application/json; charset=UTF-8" },
    },
  );
}

function uploadFailure(error: unknown): Response {
  if (error instanceof UploadTooLargeError) {
    return new Response(
      JSON.stringify({ error: "Attachment exceeds the upload limit." }),
      {
        status: 413,
        headers: { "content-type": "application/json; charset=UTF-8" },
      },
    );
  }
  if (error instanceof UploadLeaseExpiredError) return lostLease();
  if (error instanceof MultipartRequestError) return malformedRequest();
  if (error instanceof AttachmentValidationError) {
    return new Response(
      JSON.stringify({
        error: "Attachment content was rejected.",
        code: error.code,
      }),
      {
        status: 422,
        headers: { "content-type": "application/json; charset=UTF-8" },
      },
    );
  }
  if (error instanceof AttachmentUploadBusyError) {
    return new Response(
      JSON.stringify({ error: "Attachment upload capacity is busy." }),
      {
        status: 429,
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "retry-after": "1",
        },
      },
    );
  }
  return internalFailure();
}

function positiveUploadLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_UPLOAD_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      "Attachment route maxUploadBytes must be a positive integer",
    );
  }
  return value;
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new MultipartRequestError("Multipart parsing failed");
}

function deferred() {
  let resolve = () => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  // The upload owns the rejection once a file exists. Missing-file requests still need a handler.
  void promise.catch(() => {});
  return { promise, reject, resolve };
}

async function feedMultipart(
  body: ReadableStream<Uint8Array>,
  parser: BusboyInstance,
  maxBodyBytes: number,
  terminalSignal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  let receivedBytes = 0;
  let cancellation: Promise<void> | undefined;
  const cancelReader = (reason: unknown) => {
    cancellation ??= reader.cancel(reason).catch(() => {});
    return cancellation;
  };
  const onTerminalAbort = () => {
    void cancelReader(terminalSignal.reason);
  };
  terminalSignal.addEventListener("abort", onTerminalAbort, { once: true });
  try {
    terminalSignal.throwIfAborted();
    while (true) {
      const next = await reader.read();
      terminalSignal.throwIfAborted();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        throw new MultipartRequestError("Multipart body is not binary");
      }
      receivedBytes += next.value.byteLength;
      if (
        !Number.isSafeInteger(receivedBytes) ||
        receivedBytes > maxBodyBytes
      ) {
        throw new UploadTooLargeError("Multipart body limit exceeded");
      }
      if (!parser.write(Buffer.from(next.value))) await once(parser, "drain");
    }
    parser.end();
  } catch (error) {
    const failure = asError(error);
    if (!parser.destroyed) parser.destroy(failure);
    await cancelReader(failure);
    throw failure;
  } finally {
    terminalSignal.removeEventListener("abort", onTerminalAbort);
    try {
      reader.releaseLock();
    } catch {
      // A parser error may still be propagating through the request stream.
    }
  }
}

async function parseUpload(
  request: Request,
  dependencies: AttachmentRouteDependencies,
  actorUserId: string,
  channelId: string,
  reservation: Awaited<ReturnType<AttachmentUploadService["reserve"]>> & {},
  maxUploadBytes: number,
): Promise<AttachmentRecord | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    throw new MultipartRequestError("Expected multipart/form-data");
  }
  if (!request.body) throw new MultipartRequestError("Upload body is missing");

  let parser: BusboyInstance;
  try {
    parser = new Busboy({
      headers: { "content-type": contentType },
      preservePath: false,
      limits: {
        fieldNameSize: 64,
        fieldSize: 1,
        fields: 0,
        fileSize: maxUploadBytes,
        files: 1,
        parts: 1,
        headerPairs: 20,
        headerSize: 8 * 1024,
      },
    });
  } catch {
    throw new MultipartRequestError("Multipart boundary is malformed");
  }

  const readyToFinalize = deferred();
  const uploadAbort = new AbortController();
  let failure: unknown;
  let upload: Promise<AttachmentRecord | null> | undefined;
  let activeFile: BusboyFileStream | undefined;
  let fileSeen = false;
  let parseDoneResolve = () => {};
  let parseDoneReject = (_error: unknown) => {};
  const parseDone = new Promise<void>((resolve, reject) => {
    parseDoneResolve = resolve;
    parseDoneReject = reject;
  });

  const fail = (error: unknown) => {
    if (failure !== undefined) return;
    failure = error;
    readyToFinalize.reject(error);
    uploadAbort.abort(error);
    if (activeFile && !activeFile.destroyed) activeFile.destroy(asError(error));
  };

  const destroyAfterEvent = (error: unknown) => {
    fail(error);
    queueMicrotask(() => {
      if (!parser.destroyed) parser.destroy(asError(error));
    });
  };

  parser.on(
    "file",
    (
      fieldName: string,
      stream: BusboyFileStream,
      filename: string,
      transferEncoding: string,
      mimeType: string,
    ) => {
      if (
        fileSeen ||
        fieldName !== "file" ||
        !["7bit", "8bit", "binary"].includes(transferEncoding.toLowerCase())
      ) {
        stream.resume();
        destroyAfterEvent(
          new MultipartRequestError("Multipart contains an unexpected file"),
        );
        return;
      }
      fileSeen = true;
      activeFile = stream;
      stream.once("close", () => {
        if (activeFile === stream) activeFile = undefined;
      });
      stream.once("limit", () => {
        destroyAfterEvent(new UploadTooLargeError("File limit exceeded"));
      });
      stream.once("error", () => {
        destroyAfterEvent(
          new MultipartRequestError("Multipart file stream failed"),
        );
      });

      const webBody = Readable.toWeb(
        stream,
      ) as unknown as ReadableStream<Uint8Array>;
      upload = dependencies.uploads.upload(
        actorUserId,
        channelId,
        "user_upload",
        reservation,
        { name: filename, mimeType },
        webBody,
        {
          signal: uploadAbort.signal,
          readyToFinalize: readyToFinalize.promise,
        },
      );
      void upload.catch((error) => destroyAfterEvent(error));
    },
  );
  parser.on("field", () => {
    destroyAfterEvent(
      new MultipartRequestError("Multipart fields are not accepted"),
    );
  });
  parser.on("partsLimit", () => {
    destroyAfterEvent(
      new MultipartRequestError("Multipart contains too many parts"),
    );
  });
  parser.on("filesLimit", () => {
    destroyAfterEvent(
      new MultipartRequestError("Multipart contains too many files"),
    );
  });
  parser.on("fieldsLimit", () => {
    destroyAfterEvent(
      new MultipartRequestError("Multipart fields are not accepted"),
    );
  });
  parser.once("error", (error) => {
    const normalized =
      failure ??
      (error instanceof UploadTooLargeError
        ? error
        : new MultipartRequestError("Multipart parsing failed"));
    fail(normalized);
    parseDoneReject(normalized);
  });
  parser.once("finish", () => {
    if (!fileSeen) {
      fail(new MultipartRequestError("Multipart file is missing"));
    }
    if (failure === undefined) readyToFinalize.resolve();
    parseDoneResolve();
  });

  if (request.signal.aborted) {
    destroyAfterEvent(
      request.signal.reason ?? new MultipartRequestError("Upload aborted"),
    );
  }
  const onRequestAbort = () => {
    destroyAfterEvent(
      request.signal.reason ?? new MultipartRequestError("Upload aborted"),
    );
  };
  request.signal.addEventListener("abort", onRequestAbort, { once: true });

  const leaseExpiry = reservation.leaseExpiresAt.getTime();
  const leaseDelay = Number.isFinite(leaseExpiry)
    ? Math.min(Math.max(0, leaseExpiry - Date.now()), 2_147_483_647)
    : 0;
  const leaseTimer = setTimeout(() => {
    destroyAfterEvent(
      new UploadLeaseExpiredError("Attachment upload lease expired"),
    );
  }, leaseDelay);
  leaseTimer.unref?.();

  const feeding = feedMultipart(
    request.body,
    parser,
    maxUploadBytes + MAX_MULTIPART_OVERHEAD_BYTES,
    uploadAbort.signal,
  );
  try {
    try {
      await Promise.all([feeding, parseDone]);
    } catch (error) {
      fail(
        failure ??
          (error instanceof UploadTooLargeError
            ? error
            : new MultipartRequestError("Multipart parsing failed")),
      );
      await Promise.allSettled([feeding, parseDone, upload]);
    }

    if (failure !== undefined) {
      if (upload) await upload.catch(() => null);
      throw failure;
    }
    if (!upload) throw new MultipartRequestError("Multipart file is missing");
    return await upload;
  } finally {
    clearTimeout(leaseTimer);
    request.signal.removeEventListener("abort", onRequestAbort);
  }
}

function cancelRequestBody(request: Request, reason: unknown): void {
  if (!request.body || request.body.locked) return;
  void request.body.cancel(reason).catch(() => {});
}

function listQuery(url: URL): {
  cursor?: string;
  limit?: number;
  messageId?: string;
} {
  const query: { cursor?: string; limit?: number; messageId?: string } = {};
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
  if (url.searchParams.has("messageId")) {
    const messageId = url.searchParams.get("messageId") ?? "";
    if (!messageId || messageId.length > 255) throw new AttachmentQueryError();
    query.messageId = messageId;
  }
  return query;
}

function encodedFilename(
  filename: string,
  disposition: "attachment" | "inline" = "attachment",
): string {
  const encoded = [...Buffer.from(filename, "utf8")]
    .map((byte) => {
      const character = String.fromCharCode(byte);
      return /^[A-Za-z0-9!#$&+.^_`|~-]$/.test(character)
        ? character
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
  return `${disposition}; filename="attachment"; filename*=UTF-8''${encoded}`;
}

function isPreviewableArtifact(record: AttachmentRecord): boolean {
  return (
    record.source === "agent_generated" &&
    record.messageId?.startsWith("artifact:") === true &&
    ARTIFACT_PREVIEW_MIME_TYPES.has(record.mimeType)
  );
}

function artifactPreviewContentType(mimeType: string): string {
  if (mimeType === "application/pdf") return mimeType;
  if (mimeType === "text/markdown") return "text/markdown; charset=utf-8";
  // HTML and SVG are deliberately source previews. text/plain prevents parsing, script execution,
  // resource requests, cookies and storage even if the model-authored bytes contain active markup.
  return "text/plain; charset=utf-8";
}

export function createAttachmentRoutes(
  dependencies: AttachmentRouteDependencies,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const maxUploadBytes = positiveUploadLimit(dependencies.maxUploadBytes);

  routes.post("/:channelId/attachments", requireUser, async (context) => {
    const actorUserId = context.var.actor.id;
    const channelId = context.req.param("channelId");
    let reservation: Awaited<ReturnType<AttachmentUploadService["reserve"]>>;
    try {
      reservation = await dependencies.uploads.reserve(actorUserId, channelId);
    } catch {
      cancelRequestBody(
        context.req.raw,
        new Error("Attachment reservation failed"),
      );
      return internalFailure();
    }
    if (!reservation) {
      cancelRequestBody(context.req.raw, new Error("Attachment not found"));
      return notFound();
    }

    try {
      const record = await parseUpload(
        context.req.raw,
        dependencies,
        actorUserId,
        channelId,
        reservation,
        maxUploadBytes,
      );
      if (!record) {
        return lostLease();
      }
      return context.json({ attachment: publicAttachment(record) }, 201);
    } catch (error) {
      void dependencies.uploads
        .cancel(actorUserId, channelId, reservation)
        .catch(() => false);
      return uploadFailure(error);
    }
  });

  routes.get("/:channelId/attachments", requireUser, async (context) => {
    try {
      const page = await dependencies.store.list(
        context.var.actor.id,
        context.req.param("channelId"),
        listQuery(new URL(context.req.url)),
      );
      return context.json({
        attachments: page.attachments.map(publicAttachment),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      return error instanceof AttachmentQueryError
        ? invalidQuery()
        : internalFailure();
    }
  });

  routes.get(
    "/:channelId/attachments/:attachmentId/download",
    requireUser,
    async (context) => {
      try {
        const record = await dependencies.store.get(
          context.var.actor.id,
          context.req.param("channelId"),
          context.req.param("attachmentId"),
        );
        if (!record) return notFound();
        const body = await dependencies.blobs.open(record.storageKey);
        return new Response(body, {
          headers: {
            "cache-control": "private, no-store",
            "content-disposition": encodedFilename(record.name),
            "content-length": String(record.size),
            "content-security-policy": "default-src 'none'; sandbox",
            "content-type": record.mimeType,
            "cross-origin-resource-policy": "same-origin",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          },
        });
      } catch {
        return internalFailure();
      }
    },
  );

  routes.get(
    "/:channelId/attachments/:attachmentId/preview",
    requireUser,
    async (context) => {
      try {
        const record = await dependencies.store.get(
          context.var.actor.id,
          context.req.param("channelId"),
          context.req.param("attachmentId"),
        );
        if (!record || !isPreviewableArtifact(record)) return notFound();
        const body = await dependencies.blobs.open(record.storageKey);
        return new Response(body, {
          headers: {
            "cache-control": "private, no-store",
            "content-disposition": encodedFilename(record.name, "inline"),
            "content-length": String(record.size),
            "content-security-policy": "default-src 'none'; sandbox",
            "content-type": artifactPreviewContentType(record.mimeType),
            "cross-origin-resource-policy": "same-origin",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          },
        });
      } catch {
        return internalFailure();
      }
    },
  );

  routes.get(
    "/:channelId/attachments/:attachmentId",
    requireUser,
    async (context) => {
      try {
        const record = await dependencies.store.get(
          context.var.actor.id,
          context.req.param("channelId"),
          context.req.param("attachmentId"),
        );
        return record
          ? context.json({ attachment: publicAttachment(record) })
          : notFound();
      } catch {
        return internalFailure();
      }
    },
  );

  routes.delete(
    "/:channelId/attachments/:attachmentId",
    requireUser,
    async (context) => {
      try {
        const deleted = await dependencies.store.delete(
          context.var.actor.id,
          context.req.param("channelId"),
          context.req.param("attachmentId"),
        );
        return deleted ? context.body(null, 204) : notFound();
      } catch {
        return internalFailure();
      }
    },
  );

  return routes;
}
