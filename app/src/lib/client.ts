/**
 * The one place the browser talks to the API server.
 *
 * WHAT THIS REPLACES. Every read opened with the same four lines — fetch with `credentials`, check
 * `ok`, throw a sentence, unwrap the envelope — and every entity that wrote more than once grew its
 * own private copy of the same request helper: `agentRequest`, `componentRequest`, and two others,
 * identical apart from the fallback sentence. Four copies of one function is four places for the
 * `body.error` extraction to be forgotten, and it had been, in more than one of them.
 *
 * WHAT IT DOES NOT DO. It owns the transport and nothing about meaning. The envelope key and the
 * sentence a person reads are per-endpoint facts, so they stay at the call site — a client that
 * guessed the envelope would be a client that had to be argued with.
 */

export type ClientOptions = {
  /** Absent means GET. */
  method?: string;
  /** Serialised as JSON, which is also what sets the content type. */
  body?: unknown;
  /**
   * What a person reads when the server sent no message of its own.
   *
   * Name the entity in it — "Could not load coworkers" rather than "Request failed" — because this
   * is the sentence that reaches the screen when the server is the one that broke.
   */
  fallback?: string;
  /** For the calls a Bot makes on a person's behalf, which are abandoned when the turn is. */
  signal?: AbortSignal;
  /**
   * An optional deadline for short requests. Long-running operations should leave this unset and
   * use their own lifecycle signal instead.
   */
  timeoutMs?: number;
};

/** A short request exceeded its caller-owned deadline. */
export class ClientTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms.`);
    this.name = "ClientTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function positiveTimeout(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const timeout = Math.floor(value);
  return timeout > 0 ? timeout : undefined;
}

/** Every request in this app is authenticated, and every one of them is JSON or nothing. */
async function send(path: string, options: ClientOptions): Promise<Response> {
  const timeout = positiveTimeout(options.timeoutMs);
  const controller = timeout === undefined ? undefined : new AbortController();
  const forwardAbort = () => controller?.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (controller) {
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  const signal = controller?.signal ?? options.signal;
  try {
    const request = fetch(path, {
      method: options.method,
      credentials: "include",
      headers:
        options.body === undefined
          ? undefined
          : { "content-type": "application/json" },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      ...(signal ? { signal } : {}),
    });
    if (controller === undefined || timeout === undefined) {
      return await request;
    }

    // Abort the underlying fetch and reject our own promise. The race matters for test doubles and
    // browser adapters that observe AbortSignal but do not reject their fetch promise promptly.
    const deadline = new Promise<Response>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ClientTimeoutError(timeout));
      }, timeout);
    });
    return await Promise.race([request, deadline]);
  } catch (error) {
    // Preserve an explicit caller cancellation. Only an abort caused by our deadline is translated
    // to a stable error type so UI code can distinguish it from a sign-out or an interrupted turn.
    if (error instanceof ClientTimeoutError) throw error;
    if (
      controller?.signal.aborted &&
      !options.signal?.aborted &&
      timeout !== undefined
    ) {
      throw new ClientTimeoutError(timeout);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

/**
 * A request whose failure is a value rather than a throw.
 *
 * For the endpoints where a refusal is the answer: the gateway declining a component call, or the
 * catalogue announcement that is allowed to come back empty. Those callers read the status
 * themselves, and turning a refusal into an exception would make the boundary working look like the
 * boundary breaking.
 */
export function tryClient(
  path: string,
  options: ClientOptions = {},
): Promise<Response> {
  return send(path, options);
}

/**
 * A request that throws when the server says no, carrying the server's own message.
 *
 * With a `key`, the JSON body is parsed and that key unwrapped, so a caller receives the payload
 * rather than the envelope it arrived in. Without one, the `Response` is returned for a caller that
 * only needed to know it worked.
 */
export async function client<T>(
  path: string,
  key: string,
  options?: ClientOptions,
): Promise<T>;
export async function client(
  path: string,
  options?: ClientOptions,
): Promise<Response>;
export async function client<T>(
  path: string,
  keyOrOptions?: string | ClientOptions,
  maybeOptions?: ClientOptions,
): Promise<T | Response> {
  const key = typeof keyOrOptions === "string" ? keyOrOptions : undefined;
  const options =
    (typeof keyOrOptions === "string" ? maybeOptions : keyOrOptions) ?? {};

  const response = await send(path, options);

  if (!response.ok) {
    /*
     * The server's message is the useful one: it names the field or the permission that failed. The
     * fallback is only for the cases where it sent none, or sent something that is not JSON.
     */
    const message = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => undefined);
    throw new Error(message ?? options.fallback ?? "That request failed.");
  }

  if (key === undefined) return response;

  return ((await response.json()) as Record<string, T>)[key];
}
