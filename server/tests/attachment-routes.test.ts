import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createApp } from "../src/app";
import {
  AttachmentUploadBusyError,
  type AttachmentUploadService,
} from "../src/attachments/lifecycle";
import {
  type AttachmentRouteDependencies,
  createAttachmentRoutes,
} from "../src/attachments/routes";
import {
  AttachmentQueryError,
  type AttachmentRecord,
  type AttachmentReservation,
  type AttachmentStore,
} from "../src/attachments/store";
import { AttachmentValidationError } from "../src/attachments/validation";
import type { AppVariables } from "../src/auth/guards";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const actor = {
  id: "user-a",
  email: "member@openbot.test",
  role: "user",
} as const;
const reservation: AttachmentReservation = {
  storageKey: "20000000-0000-4000-8000-000000000001",
  leaseToken: "30000000-0000-4000-8000-000000000001",
  leaseExpiresAt: new Date("2026-08-30T12:05:00.000Z"),
};
const attachment: AttachmentRecord = {
  id: "10000000-0000-4000-8000-000000000001",
  ownerUserId: actor.id,
  channelId: "channel-a",
  messageId: null,
  name: "proof документ.txt",
  mimeType: "text/plain",
  size: 5,
  sha256: "a".repeat(64),
  storageKey: reservation.storageKey,
  source: "user_upload",
  createdAt: new Date("2026-08-30T12:00:00.000Z"),
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

type Call = [method: string, ...args: unknown[]];

function bytes(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs = 500) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("request did not settle")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function fakeDependencies(
  overrides: {
    store?: Partial<AttachmentStore>;
    uploads?: Partial<AttachmentUploadService>;
    open?: (storageKey: string) => Promise<ReadableStream<Uint8Array>>;
    maxUploadBytes?: number;
  } = {},
): AttachmentRouteDependencies & { calls: Call[] } {
  const calls: Call[] = [];
  const store: AttachmentStore = {
    reserve: () => Promise.resolve(null),
    withUploadingLease: () => Promise.resolve({ acquired: false }),
    cancel: () => Promise.resolve(false),
    async list(actorId, channelId, query) {
      calls.push(["list", actorId, channelId, query]);
      return { attachments: [attachment], nextCursor: "next-page" };
    },
    async listGenerated(actorId, query) {
      calls.push(["listGenerated", actorId, query]);
      return { attachments: [attachment], nextCursor: "next-page" };
    },
    async get(actorId, channelId, attachmentId) {
      calls.push(["get", actorId, channelId, attachmentId]);
      return attachment;
    },
    async delete(actorId, channelId, attachmentId) {
      calls.push(["delete", actorId, channelId, attachmentId]);
      return true;
    },
    ...overrides.store,
  };
  const uploads: AttachmentUploadService = {
    async reserve(actorId, channelId) {
      calls.push(["reserve", actorId, channelId]);
      return reservation;
    },
    async cancel(actorId, channelId, receivedReservation) {
      calls.push(["cancel", actorId, channelId, receivedReservation]);
      return true;
    },
    async upload(
      actorId,
      channelId,
      source,
      receivedReservation,
      input,
      body,
      options,
    ) {
      calls.push([
        "upload",
        actorId,
        channelId,
        source,
        receivedReservation,
        input,
      ]);
      expect(await text(body)).toBe("hello");
      await options?.readyToFinalize;
      return attachment;
    },
    ...overrides.uploads,
  };
  return {
    store,
    uploads,
    blobs: {
      open:
        overrides.open ??
        (async (storageKey) => {
          calls.push(["open", storageKey]);
          return bytes("hello");
        }),
    },
    maxUploadBytes: overrides.maxUploadBytes,
    calls,
  };
}

function appFor(
  dependencies: AttachmentRouteDependencies,
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = requireUser,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createAttachmentRoutes(dependencies, middleware));
  return app;
}

function uploadForm(...entries: Array<[string, Blob, string]>): FormData {
  const form = new FormData();
  for (const [field, blob, name] of entries) form.append(field, blob, name);
  return form;
}

function uploadRequest(form: FormData): Request {
  return new Request("http://openbot.test/channel-a/attachments", {
    method: "POST",
    body: form,
  });
}

describe("attachment upload route", () => {
  test("reserves authorization before reading and streams one file through the fenced upload", async () => {
    let bodyRead = false;
    const boundary = "openbot-stream-boundary";
    const raw = [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="file"; filename="note.txt"\r\n',
      "Content-Type: text/plain\r\n\r\n",
      "hello",
      `\r\n--${boundary}--\r\n`,
    ].join("");
    const dependencies = fakeDependencies({
      uploads: {
        reserve: async (actorId, channelId) => {
          expect(bodyRead).toBe(false);
          expect([actorId, channelId]).toEqual([actor.id, "channel-a"]);
          return reservation;
        },
      },
    });
    const requestBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyRead = true;
        controller.enqueue(new TextEncoder().encode(raw));
        controller.close();
      },
    });
    const response = await appFor(dependencies).request(
      new Request("http://openbot.test/channel-a/attachments", {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body: requestBody,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      attachment: {
        id: attachment.id,
        channelId: "channel-a",
        messageId: null,
        name: "proof документ.txt",
        mimeType: "text/plain",
        size: 5,
        sha256: "a".repeat(64),
        source: "user_upload",
        createdAt: "2026-08-30T12:00:00.000Z",
      },
    });
    expect(JSON.stringify(await response.clone().text())).not.toContain(
      reservation.storageKey,
    );
    expect(dependencies.calls).toContainEqual([
      "upload",
      actor.id,
      "channel-a",
      "user_upload",
      reservation,
      { name: "note.txt", mimeType: "text/plain" },
    ]);
  });

  test("returns the same not-found result for an unavailable or foreign channel without reading the body", async () => {
    let pulled = false;
    const dependencies = fakeDependencies({
      uploads: {
        reserve: () => {
          expect(pulled).toBe(false);
          return Promise.resolve(null);
        },
      },
    });
    const response = await appFor(dependencies).request(
      new Request("http://openbot.test/foreign/attachments", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x" },
        body: new ReadableStream({
          pull(controller) {
            pulled = true;
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(404);
    expect(dependencies.calls.some(([method]) => method === "upload")).toBe(
      false,
    );
  });

  test("rejects an extra multipart part before the upload can finalize", async () => {
    let finalized = false;
    const dependencies = fakeDependencies({
      uploads: {
        upload: async (
          _actorId,
          _channelId,
          _source,
          _reservation,
          _input,
          body,
          options,
        ) => {
          await text(body);
          await options?.readyToFinalize;
          finalized = true;
          return attachment;
        },
      },
    });
    const form = uploadForm(
      ["file", new Blob(["hello"], { type: "text/plain" }), "note.txt"],
      ["extra", new Blob(["bad"], { type: "text/plain" }), "extra.txt"],
    );

    const response = await appFor(dependencies).request(uploadRequest(form));

    expect(response.status).toBe(400);
    expect(finalized).toBe(false);
  });

  test("rejects a non-file field and releases the reservation", async () => {
    const dependencies = fakeDependencies();
    const form = new FormData();
    form.append("message", "not allowed");

    const response = await appFor(dependencies).request(uploadRequest(form));

    expect(response.status).toBe(400);
    expect(dependencies.calls).toContainEqual([
      "cancel",
      actor.id,
      "channel-a",
      reservation,
    ]);
  });

  test("cancels a never-ending raw body after an invalid multipart field", async () => {
    const boundary = "stalled-invalid-field";
    let bodyCancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              `--${boundary}\r\n`,
              'Content-Disposition: form-data; name="unexpected"\r\n\r\n',
              "bad",
              `\r\n--${boundary}\r\n`,
            ].join(""),
          ),
        );
      },
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        bodyCancellations += 1;
      },
    });
    const dependencies = fakeDependencies();

    const response = await settlesWithin(
      appFor(dependencies).request(
        new Request("http://openbot.test/channel-a/attachments", {
          method: "POST",
          headers: {
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          body,
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      ),
    );

    expect(response.status).toBe(400);
    expect(bodyCancellations).toBe(1);
  });

  test("returns 413 when the streamed file exceeds the route limit", async () => {
    const dependencies = fakeDependencies({ maxUploadBytes: 4 });
    const response = await appFor(dependencies).request(
      uploadRequest(
        uploadForm([
          "file",
          new Blob(["hello"], { type: "text/plain" }),
          "note.txt",
        ]),
      ),
    );

    expect(response.status).toBe(413);
  });

  test("bounds the whole multipart stream even when an attacker sends only preamble", async () => {
    const dependencies = fakeDependencies({ maxUploadBytes: 4 });
    const response = await appFor(dependencies).request(
      "http://openbot.test/channel-a/attachments",
      {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=never-arrives",
        },
        body: "x".repeat(70 * 1024),
      },
    );

    expect(response.status).toBe(413);
  });

  test("returns 400 for a truncated multipart body", async () => {
    const dependencies = fakeDependencies();
    const response = await appFor(dependencies).request(
      "http://openbot.test/channel-a/attachments",
      {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=truncated" },
        body: "--truncated\r\nContent-Disposition: form-data",
      },
    );

    expect(response.status).toBe(400);
  });

  test("keeps the request abort signal connected through validation and finalization", async () => {
    let parserReadyResolve = () => {};
    const parserReady = new Promise<void>((resolve) => {
      parserReadyResolve = resolve;
    });
    let releaseUpload = () => {};
    const uploadMayReturn = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let uploadWasAborted = false;
    const dependencies = fakeDependencies({
      uploads: {
        upload: async (
          _actorId,
          _channelId,
          _source,
          _reservation,
          _input,
          body,
          options,
        ) => {
          await text(body);
          await options?.readyToFinalize;
          parserReadyResolve();
          await uploadMayReturn;
          uploadWasAborted = options?.signal?.aborted ?? false;
          return null;
        },
      },
    });
    const abort = new AbortController();
    const responsePromise = appFor(dependencies).request(
      new Request("http://openbot.test/channel-a/attachments", {
        method: "POST",
        body: uploadForm([
          "file",
          new Blob(["hello"], { type: "text/plain" }),
          "note.txt",
        ]),
        signal: abort.signal,
      }),
    );
    await parserReady;
    await Promise.resolve();
    abort.abort(new Error("client left"));
    releaseUpload();
    await responsePromise;

    expect(uploadWasAborted).toBe(true);
  });

  test("cancels and settles when the request aborts during a pending raw body read", async () => {
    const boundary = "stalled-request-abort";
    let pendingReadResolve = () => {};
    const pendingRead = new Promise<void>((resolve) => {
      pendingReadResolve = resolve;
    });
    let pulls = 0;
    let bodyCancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(
            new TextEncoder().encode(
              [
                `--${boundary}\r\n`,
                'Content-Disposition: form-data; name="file"; filename="note.txt"\r\n',
                "Content-Type: text/plain\r\n\r\n",
                "partial",
              ].join(""),
            ),
          );
          return;
        }
        pendingReadResolve();
        return new Promise<void>(() => {});
      },
      cancel() {
        bodyCancellations += 1;
      },
    });
    const abort = new AbortController();
    const dependencies = fakeDependencies({
      uploads: {
        upload: async (
          _actorId,
          _channelId,
          _source,
          _reservation,
          _input,
          uploadBody,
        ) => {
          await text(uploadBody);
          return attachment;
        },
      },
    });
    const responsePromise = appFor(dependencies).request(
      new Request("http://openbot.test/channel-a/attachments", {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
        signal: abort.signal,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    await pendingRead;

    abort.abort(new Error("client left"));
    const response = await settlesWithin(responsePromise);

    expect(response.status).toBe(500);
    expect(bodyCancellations).toBe(1);
  });

  test("expires a stalled multipart preamble with the reservation lease", async () => {
    const expiringReservation = {
      ...reservation,
      leaseExpiresAt: new Date(Date.now() + 25),
    };
    let bodyCancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("slow preamble"));
      },
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        bodyCancellations += 1;
      },
    });
    const dependencies = fakeDependencies({
      uploads: { reserve: () => Promise.resolve(expiringReservation) },
    });

    const response = await settlesWithin(
      appFor(dependencies).request(
        new Request("http://openbot.test/channel-a/attachments", {
          method: "POST",
          headers: {
            "content-type": "multipart/form-data; boundary=never-arrives",
          },
          body,
          duplex: "half",
        } as RequestInit & { duplex: "half" }),
      ),
    );

    expect(response.status).toBe(409);
    expect(bodyCancellations).toBe(1);
    expect(dependencies.calls).toContainEqual([
      "cancel",
      actor.id,
      "channel-a",
      expiringReservation,
    ]);
  });

  test("maps validation, capacity, and lost-lease failures without exposing internals", async () => {
    const cases: Array<{
      error: Error | null;
      status: number;
      retryAfter?: string;
    }> = [
      {
        error: new AttachmentValidationError("unsafe_content", "unsafe script"),
        status: 422,
      },
      { error: new AttachmentUploadBusyError(), status: 429, retryAfter: "1" },
      { error: null, status: 409 },
      { error: new Error("private filesystem path"), status: 500 },
    ];

    for (const item of cases) {
      const dependencies = fakeDependencies({
        uploads: {
          upload: async () => {
            if (item.error) throw item.error;
            return null;
          },
        },
      });
      const response = await appFor(dependencies).request(
        uploadRequest(
          uploadForm([
            "file",
            new Blob(["hello"], { type: "text/plain" }),
            "note.txt",
          ]),
        ),
      );
      const responseText = await response.text();

      expect(response.status).toBe(item.status);
      expect(response.headers.get("retry-after")).toBe(item.retryAfter ?? null);
      expect(responseText).not.toContain("private filesystem path");
    }
  });

  test("rejects a malformed content type and cancels its already-authorized reservation", async () => {
    const dependencies = fakeDependencies();
    const response = await appFor(dependencies).request(
      "http://openbot.test/channel-a/attachments",
      { method: "POST", headers: { "content-type": "application/json" } },
    );

    expect(response.status).toBe(400);
    expect(dependencies.calls).toContainEqual([
      "cancel",
      actor.id,
      "channel-a",
      reservation,
    ]);
  });

  test("authenticates before reserving or parsing", async () => {
    const dependencies = fakeDependencies();
    const response = await appFor(dependencies, denied).request(
      uploadRequest(
        uploadForm([
          "file",
          new Blob(["hello"], { type: "text/plain" }),
          "note.txt",
        ]),
      ),
    );

    expect(response.status).toBe(401);
    expect(dependencies.calls).toEqual([]);
  });
});

describe("attachment metadata routes", () => {
  test("lists a bounded page with ISO dates and no private metadata", async () => {
    const dependencies = fakeDependencies();
    const response = await appFor(dependencies).request(
      "http://openbot.test/channel-a/attachments?limit=25&cursor=page-1&messageId=message-a",
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(dependencies.calls).toEqual([
      [
        "list",
        actor.id,
        "channel-a",
        { limit: 25, cursor: "page-1", messageId: "message-a" },
      ],
    ]);
    expect(body).toEqual({
      attachments: [
        {
          id: attachment.id,
          channelId: "channel-a",
          messageId: null,
          name: "proof документ.txt",
          mimeType: "text/plain",
          size: 5,
          sha256: "a".repeat(64),
          source: "user_upload",
          createdAt: "2026-08-30T12:00:00.000Z",
        },
      ],
      nextCursor: "next-page",
    });
    expect(JSON.stringify(body)).not.toContain("ownerUserId");
    expect(JSON.stringify(body)).not.toContain("storageKey");
  });

  test("maps malformed limits and cursors to 400", async () => {
    const invalidLimit = await appFor(fakeDependencies()).request(
      "http://openbot.test/channel-a/attachments?limit=2.5",
    );
    expect(invalidLimit.status).toBe(400);

    const dependencies = fakeDependencies({
      store: {
        list: () => Promise.reject(new AttachmentQueryError()),
      },
    });
    const invalidCursor = await appFor(dependencies).request(
      "http://openbot.test/channel-a/attachments?cursor=bad",
    );
    expect(invalidCursor.status).toBe(400);
  });

  test("returns one safe metadata record and a uniform 404 for an unavailable record", async () => {
    const found = await appFor(fakeDependencies()).request(
      `http://openbot.test/channel-a/attachments/${attachment.id}`,
    );
    const foundBody = await found.json();
    expect(found.status).toBe(200);
    expect(foundBody.attachment.createdAt).toBe("2026-08-30T12:00:00.000Z");
    expect(JSON.stringify(foundBody)).not.toContain(reservation.storageKey);

    const missing = await appFor(
      fakeDependencies({ store: { get: () => Promise.resolve(null) } }),
    ).request(`http://openbot.test/channel-a/attachments/${attachment.id}`);
    expect(missing.status).toBe(404);
  });

  test("deletes only an actor-owned live record and otherwise returns the same 404", async () => {
    const dependencies = fakeDependencies();
    const deleted = await appFor(dependencies).request(
      `http://openbot.test/channel-a/attachments/${attachment.id}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(204);

    const missing = await appFor(
      fakeDependencies({ store: { delete: () => Promise.resolve(false) } }),
    ).request(`http://openbot.test/channel-a/attachments/${attachment.id}`, {
      method: "DELETE",
    });
    expect(missing.status).toBe(404);
  });
});

describe("attachment route composition", () => {
  test("mounts the optional routes behind createApp authentication", async () => {
    const dependencies = fakeDependencies();
    let session: { user: { id: string; email: string } } | null = null;
    const args = [
      loadConfig(testEnvironment()),
      {
        handler: () => new Response(null, { status: 204 }),
        api: { getSession: () => Promise.resolve(session) },
      },
      { rolesForUser: () => Promise.resolve(["user"] as const) },
    ] as unknown as Parameters<typeof createApp>;
    args[24] = dependencies;
    const app = createApp(...args);

    const deniedResponse = await app.request(
      "http://openbot.test/api/channels/channel-a/attachments",
    );
    expect(deniedResponse.status).toBe(401);
    expect(dependencies.calls).toEqual([]);

    session = { user: { id: actor.id, email: actor.email } };
    const allowedResponse = await app.request(
      "http://openbot.test/api/channels/channel-a/attachments",
    );
    expect(allowedResponse.status).toBe(200);
    expect(dependencies.calls[0]).toEqual(["list", actor.id, "channel-a", {}]);
  });
});

describe("attachment download route", () => {
  test("streams private bytes with safe download and anti-sniffing headers", async () => {
    const dependencies = fakeDependencies();
    const response = await appFor(dependencies).request(
      `http://openbot.test/channel-a/attachments/${attachment.id}/download`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("content-disposition")).toContain(
      "attachment; filename=\"attachment\"; filename*=UTF-8''proof%20",
    );
    expect(response.headers.get("content-disposition")).not.toContain("\r");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(dependencies.calls).toEqual([
      ["get", actor.id, "channel-a", attachment.id],
      ["open", reservation.storageKey],
    ]);
  });

  test("does not open storage for an unavailable or foreign attachment", async () => {
    let opened = false;
    const dependencies = fakeDependencies({
      store: { get: () => Promise.resolve(null) },
      open: () => {
        opened = true;
        return Promise.resolve(bytes("private"));
      },
    });
    const response = await appFor(dependencies).request(
      `http://openbot.test/channel-a/attachments/${attachment.id}/download`,
    );

    expect(response.status).toBe(404);
    expect(opened).toBe(false);
  });
});

describe("artifact preview route", () => {
  test.each([
    ["text/markdown", "text/markdown; charset=utf-8"],
    ["text/plain", "text/plain; charset=utf-8"],
    ["application/json", "text/plain; charset=utf-8"],
    ["text/csv", "text/plain; charset=utf-8"],
    ["image/svg+xml", "text/plain; charset=utf-8"],
    ["text/html", "text/plain; charset=utf-8"],
    ["application/pdf", "application/pdf"],
  ])(
    "streams a private generated %s artifact inline",
    async (mimeType, expected) => {
      const generated = {
        ...attachment,
        messageId: "artifact:10000000-0000-4000-8000-000000000002",
        mimeType,
        source: "agent_generated" as const,
      };
      const dependencies = fakeDependencies({
        store: { get: () => Promise.resolve(generated) },
      });
      const response = await appFor(dependencies).request(
        `http://openbot.test/channel-a/attachments/${attachment.id}/preview`,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello");
      expect(response.headers.get("content-type")).toBe(expected);
      expect(response.headers.get("content-disposition")).toStartWith(
        "inline;",
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-security-policy")).toBe(
        "default-src 'none'; sandbox",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    },
  );

  test("does not open user uploads or unsupported content", async () => {
    for (const unavailable of [
      attachment,
      {
        ...attachment,
        messageId: "artifact:10000000-0000-4000-8000-000000000002",
        mimeType: "image/png",
        source: "agent_generated" as const,
      },
    ]) {
      let opened = false;
      const response = await appFor(
        fakeDependencies({
          store: { get: () => Promise.resolve(unavailable) },
          open: () => {
            opened = true;
            return Promise.resolve(bytes("private"));
          },
        }),
      ).request(
        `http://openbot.test/channel-a/attachments/${attachment.id}/preview`,
      );
      expect(response.status).toBe(404);
      expect(opened).toBe(false);
    }
  });
});
