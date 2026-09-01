import { describe, expect, test } from "bun:test";
import { createOpenRouterCredentialBroker } from "../src/openrouter-credential-broker";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

type Broker = Awaited<ReturnType<typeof createOpenRouterCredentialBroker>>;

function endpoint(broker: Broker, path: string): string {
  return `${broker.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function randomPathToken(url: URL): string | undefined {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .find((segment) => /^[A-Za-z0-9_-]{22,}$/.test(segment));
}

function fakeFetch(
  handler: (request: Request) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof fetch;
}

describe("OpenRouter loopback credential broker", () => {
  test("issues a unique loopback URL containing at least 128 bits of unguessable path material", async () => {
    const upstreamFetch = fakeFetch(() => Response.json({ data: [] }));
    const first = await createOpenRouterCredentialBroker({
      apiKey: "fixture-openrouter-key-a",
      fetch: upstreamFetch,
    });
    const second = await createOpenRouterCredentialBroker({
      apiKey: "fixture-openrouter-key-b",
      fetch: upstreamFetch,
    });

    try {
      const firstUrl = new URL(first.baseUrl);
      const secondUrl = new URL(second.baseUrl);
      const firstToken = randomPathToken(firstUrl);
      const secondToken = randomPathToken(secondUrl);

      expect(firstUrl.protocol).toBe("http:");
      expect(["127.0.0.1", "[::1]"]).toContain(firstUrl.hostname);
      expect(firstUrl.username).toBe("");
      expect(firstUrl.password).toBe("");
      expect(firstUrl.search).toBe("");
      expect(firstUrl.hash).toBe("");
      expect(firstToken).toBeDefined();
      expect(secondToken).toBeDefined();
      expect(firstToken).not.toBe(secondToken);
      // 22 base64url characters carry at least 128 bits of encoded material.
      expect(firstToken?.length).toBeGreaterThanOrEqual(22);
    } finally {
      await first.close();
      await second.close();
    }
  });

  test("proxies only GET models to the fixed OpenRouter URL with its private Bearer credential", async () => {
    const requests: Request[] = [];
    const broker = await createOpenRouterCredentialBroker({
      apiKey: "fixture-models-key",
      fetch: fakeFetch((request) => {
        requests.push(request);
        return Response.json({ data: [{ id: "fixture-model" }] });
      }),
    });

    try {
      const response = await fetch(endpoint(broker, "/models"), {
        headers: {
          authorization: "Bearer caller-controlled-value",
          "x-forwarded-host": "attacker.invalid",
        },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        data: [{ id: "fixture-model" }],
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(`${OPENROUTER_BASE_URL}/models`);
      expect(requests[0]?.method).toBe("GET");
      expect(requests[0]?.headers.get("authorization")).toBe(
        "Bearer fixture-models-key",
      );
      expect(requests[0]?.headers.get("x-forwarded-host")).toBeNull();
      expect(requests[0]?.redirect).toBe("error");
    } finally {
      await broker.close();
    }
  });

  test("proxies only POST responses to the fixed OpenRouter URL without changing its body", async () => {
    const requests: Request[] = [];
    const requestBody = JSON.stringify({
      model: "openai/gpt-5",
      input: "fixture request body",
      stream: true,
    });
    const broker = await createOpenRouterCredentialBroker({
      apiKey: "fixture-responses-key",
      fetch: fakeFetch(async (request) => {
        requests.push(request);
        expect(await request.clone().text()).toBe(requestBody);
        return new Response("data: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }),
    });

    try {
      const response = await fetch(endpoint(broker, "/responses"), {
        method: "POST",
        headers: {
          authorization: "Bearer caller-controlled-value",
          "content-type": "application/json",
        },
        body: requestBody,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      expect(await response.text()).toBe("data: [DONE]\n\n");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(`${OPENROUTER_BASE_URL}/responses`);
      expect(requests[0]?.method).toBe("POST");
      expect(requests[0]?.headers.get("authorization")).toBe(
        "Bearer fixture-responses-key",
      );
      expect(requests[0]?.headers.get("content-type")).toBe("application/json");
      expect(requests[0]?.redirect).toBe("error");
    } finally {
      await broker.close();
    }
  });

  test("bounds and cancels an oversized chunked Responses body before upstream", async () => {
    let upstreamCalls = 0;
    let pulls = 0;
    let cancelled = false;
    const broker = await createOpenRouterCredentialBroker({
      apiKey: "fixture-bounded-body-key",
      fetch: fakeFetch(() => {
        upstreamCalls += 1;
        return Response.json({ unexpected: true });
      }),
    });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 40) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });

    try {
      const response = await fetch(endpoint(broker, "/responses"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      expect(response.status).toBe(413);
      expect(upstreamCalls).toBe(0);
      expect(pulls).toBeLessThan(40);
      expect(cancelled || pulls < 40).toBe(true);
    } finally {
      await broker.close();
    }
  });

  test("aborts an active upstream stream when the broker closes", async () => {
    let upstreamSignal: AbortSignal | undefined;
    let upstreamBodyCancelled = false;
    const broker = await createOpenRouterCredentialBroker({
      apiKey: "fixture-stream-close-key",
      fetch: fakeFetch((request) => {
        upstreamSignal = request.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: started\n\n"));
            },
            cancel() {
              upstreamBodyCancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    });

    const response = await fetch(endpoint(broker, "/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const reader = response.body?.getReader();
    await reader?.read();
    await broker.close();

    expect(upstreamSignal?.aborted).toBe(true);
    expect(upstreamBodyCancelled).toBe(true);
    await reader?.cancel().catch(() => undefined);
  });

  test("rejects arbitrary methods and paths before they reach the upstream fetch", async () => {
    let upstreamCalls = 0;
    const broker = await createOpenRouterCredentialBroker({
      apiKey: "fixture-rejection-key",
      fetch: fakeFetch(() => {
        upstreamCalls += 1;
        return Response.json({ unexpected: true });
      }),
    });

    try {
      const attempts = [
        fetch(endpoint(broker, "/models"), { method: "POST" }),
        fetch(endpoint(broker, "/responses"), { method: "GET" }),
        fetch(endpoint(broker, "/chat/completions"), { method: "POST" }),
        fetch(endpoint(broker, "/responses/extra"), { method: "POST" }),
      ];
      const responses = await Promise.all(attempts);

      expect(responses.every((response) => response.status >= 400)).toBe(true);
      expect(upstreamCalls).toBe(0);
    } finally {
      await broker.close();
    }
  });

  test("cannot be redirected or pointed at a caller-supplied upstream", async () => {
    const requests: Request[] = [];
    const broker = await createOpenRouterCredentialBroker({
      apiKey: "fixture-fixed-upstream-key",
      fetch: fakeFetch((request) => {
        requests.push(request);
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid/collect" },
        });
      }),
      upstreamBaseUrl: "https://attacker.invalid/api",
    } as never);

    try {
      const response = await fetch(endpoint(broker, "/models"), {
        redirect: "manual",
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(`${OPENROUTER_BASE_URL}/models`);
      expect(requests[0]?.redirect).toBe("error");
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("location")).toBeNull();
    } finally {
      await broker.close();
    }
  });

  test("does not log the credential or request body", async () => {
    const apiKey = "fixture-never-log-openrouter-key";
    const privateBody = "fixture-never-log-request-body";
    const capturedLogs: string[] = [];
    const methods = ["debug", "info", "log", "warn", "error"] as const;
    const originals = Object.fromEntries(
      methods.map((method) => [method, console[method]]),
    ) as Record<(typeof methods)[number], typeof console.log>;
    for (const method of methods) {
      console[method] = ((...values: unknown[]) => {
        capturedLogs.push(values.map(String).join(" "));
      }) as typeof console.log;
    }

    let broker: Broker | undefined;
    try {
      broker = await createOpenRouterCredentialBroker({
        apiKey,
        fetch: fakeFetch(() => Response.json({ ok: true })),
      });
      const response = await fetch(endpoint(broker, "/responses"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: privateBody }),
      });
      expect(response.status).toBe(200);
    } finally {
      if (broker) await broker.close();
      for (const method of methods) console[method] = originals[method];
    }

    const serializedLogs = capturedLogs.join("\n");
    expect(serializedLogs).not.toContain(apiKey);
    expect(serializedLogs).not.toContain(privateBody);
  });

  test("makes the loopback endpoint unavailable after close", async () => {
    const broker = await createOpenRouterCredentialBroker({
      apiKey: "fixture-close-key",
      fetch: fakeFetch(() => Response.json({ data: [] })),
    });
    const modelsUrl = endpoint(broker, "/models");

    expect((await fetch(modelsUrl)).status).toBe(200);
    await broker.close();

    let unavailable = false;
    try {
      const response = await fetch(modelsUrl, {
        signal: AbortSignal.timeout(500),
      });
      unavailable = response.status >= 400;
    } catch {
      unavailable = true;
    }
    expect(unavailable).toBe(true);
  });
});
