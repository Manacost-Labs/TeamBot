import { randomBytes } from "node:crypto";

export const OPENROUTER_UPSTREAM_BASE_URL = "https://openrouter.ai/api/v1";

const PRIVATE_PATH_BYTES = 32;
const MAX_PROVIDER_KEY_BYTES = 4_096;
const MAX_RESPONSES_BODY_BYTES = 32 * 1024 * 1024;
const LOOPBACK_HOST = "127.0.0.1";

type UpstreamFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OpenRouterCredentialBroker = Readonly<{
  /** Capability URL consumed only by the task-owned Codex profile. */
  baseUrl: string;
  /** Idempotently stop the listener, abort upstream work and wipe the broker-owned key copy. */
  close(): Promise<void>;
}>;

export type CreateOpenRouterCredentialBrokerOptions = Readonly<{
  apiKey: string;
  /** Code-owned dependency seam for localhost tests; it cannot change the fixed upstream URL. */
  fetch?: UpstreamFetch;
}>;

function validApiKey(apiKey: string): boolean {
  return (
    apiKey.length > 0 &&
    apiKey.length <= MAX_PROVIDER_KEY_BYTES &&
    [...apiKey].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x21 && code <= 0x7e;
    })
  );
}

function privateResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function allowedResponseHeaders(source: Headers): Headers {
  const target = new Headers();
  for (const name of [
    "cache-control",
    "content-type",
    "retry-after",
    "x-request-id",
  ]) {
    const value = source.get(name);
    if (value !== null) target.set(name, value);
  }
  return target;
}

function loopbackPeer(server: Bun.Server<unknown>, request: Request): boolean {
  const peer = server.requestIP(request);
  return (
    peer?.address === "127.0.0.1" ||
    peer?.address === "::1" ||
    peer?.address === "::ffff:127.0.0.1"
  );
}

async function boundedRequestBody(
  request: Request,
): Promise<{ body?: Uint8Array; tooLarge: boolean }> {
  if (!request.body) return { body: new Uint8Array(), tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSES_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, tooLarge: false };
}

/**
 * Start one per-run credential broker.
 *
 * The public surface deliberately accepts no upstream, base URL, model or header configuration.
 * A 256-bit path capability prevents other same-container processes from discovering the endpoint;
 * the API key itself remains in this adapter process and never reaches Codex configuration,
 * environment or command-line state.
 */
export async function createOpenRouterCredentialBroker(
  options: CreateOpenRouterCredentialBrokerOptions,
): Promise<OpenRouterCredentialBroker> {
  if (!validApiKey(options.apiKey)) {
    throw new Error("An OpenRouter API key is required.");
  }

  const upstreamFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  let credential: Buffer | null = Buffer.from(options.apiKey, "utf8");
  const capability = randomBytes(PRIVATE_PATH_BYTES).toString("base64url");
  const basePath = `/${capability}/v1`;
  const activeRequests = new Set<{
    controller: AbortController;
    cancelBody?: () => Promise<void>;
  }>();
  let closed = false;

  let server: Bun.Server<unknown>;
  try {
    server = Bun.serve({
      hostname: LOOPBACK_HOST,
      port: 0,
      async fetch(request, bunServer) {
        if (closed || !credential || !loopbackPeer(bunServer, request)) {
          return privateResponse(404);
        }

        const requestUrl = new URL(request.url);
        if (requestUrl.search !== "" || requestUrl.hash !== "") {
          return privateResponse(404);
        }
        const route =
          requestUrl.pathname === `${basePath}/models` &&
          request.method === "GET"
            ? "models"
            : requestUrl.pathname === `${basePath}/responses` &&
                request.method === "POST"
              ? "responses"
              : null;
        if (!route) return privateResponse(404);

        let body: Uint8Array | undefined;
        if (route === "responses") {
          const contentType = request.headers
            .get("content-type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          const declaredLength = request.headers.get("content-length");
          if (
            contentType !== "application/json" ||
            (declaredLength !== null &&
              (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) ||
                Number(declaredLength) > MAX_RESPONSES_BODY_BYTES))
          ) {
            return privateResponse(400);
          }
          const bounded = await boundedRequestBody(request);
          if (bounded.tooLarge) {
            return privateResponse(413);
          }
          body = bounded.body;
        }

        const controller = new AbortController();
        const active: {
          controller: AbortController;
          cancelBody?: () => Promise<void>;
        } = { controller };
        activeRequests.add(active);
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          request.signal.removeEventListener("abort", abortUpstream);
          activeRequests.delete(active);
        };
        const abortUpstream = () => {
          controller.abort();
          void active.cancelBody?.();
        };
        request.signal.addEventListener("abort", abortUpstream, { once: true });
        try {
          if (closed || !credential) {
            release();
            return privateResponse(503);
          }
          const headers = new Headers({
            accept:
              request.headers.get("accept") ??
              (route === "responses"
                ? "text/event-stream"
                : "application/json"),
            authorization: `Bearer ${credential.toString("utf8")}`,
          });
          if (route === "responses") {
            headers.set("content-type", "application/json");
          }
          const upstreamRequest = new Request(
            `${OPENROUTER_UPSTREAM_BASE_URL}/${route}`,
            {
              method: route === "models" ? "GET" : "POST",
              headers,
              body,
              redirect: "error",
              signal: controller.signal,
            },
          );
          const upstream = await upstreamFetch(upstreamRequest);
          if (upstream.status >= 300 && upstream.status < 400) {
            await upstream.body?.cancel().catch(() => undefined);
            release();
            return privateResponse(502);
          }
          if (!upstream.body) {
            release();
            return new Response(null, {
              status: upstream.status,
              headers: allowedResponseHeaders(upstream.headers),
            });
          }
          const upstreamReader = upstream.body.getReader();
          active.cancelBody = async () => {
            await upstreamReader.cancel().catch(() => undefined);
          };
          const responseBody = new ReadableStream<Uint8Array>({
            async pull(streamController) {
              try {
                const part = await upstreamReader.read();
                if (part.done) {
                  release();
                  streamController.close();
                } else {
                  streamController.enqueue(part.value);
                }
              } catch (error) {
                release();
                streamController.error(error);
              }
            },
            async cancel(reason) {
              controller.abort();
              await upstreamReader.cancel(reason).catch(() => undefined);
              release();
            },
          });
          return new Response(responseBody, {
            status: upstream.status,
            headers: allowedResponseHeaders(upstream.headers),
          });
        } catch {
          release();
          return privateResponse(closed ? 503 : 502);
        }
      },
    });
  } catch (error) {
    credential.fill(0);
    credential = null;
    throw error;
  }

  const baseUrl = `http://${LOOPBACK_HOST}:${server.port}${basePath}`;
  let closing: Promise<void> | undefined;
  return Object.freeze({
    baseUrl,
    close() {
      if (closing) return closing;
      closing = (async () => {
        closed = true;
        try {
          for (const active of activeRequests) active.controller.abort();
          await Promise.allSettled(
            [...activeRequests].map((active) => active.cancelBody?.()),
          );
          await server.stop(true);
        } finally {
          credential?.fill(0);
          credential = null;
        }
      })();
      return closing;
    },
  });
}
