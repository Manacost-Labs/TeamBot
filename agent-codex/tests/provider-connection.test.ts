import { describe, expect, test } from "bun:test";
import {
  createPersonalProviderConnectionResolver,
  PersonalProviderConnectionUnavailableError,
} from "../src/provider-connection";

const MANAGED_TOKEN = "managed-provider-token";
const LEASE = "8f1dd4f8-5311-48c2-ac71-7ae00ee69a63";
const RUN = "signed-run-assertion";

describe("personal provider connection resolver", () => {
  test("posts the opaque lease and signed run only to the configured internal endpoint", async () => {
    const calls: Request[] = [];
    const resolver = createPersonalProviderConnectionResolver({
      serverUrl: "http://openbot.internal:3001",
      managedAgentToken: MANAGED_TOKEN,
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return Response.json({
          provider: "openrouter",
          apiKey: "personal-openrouter-key",
        });
      },
    });

    const connection = await resolver({
      lease: LEASE,
      run: RUN,
      // Runtime/browser input is not part of this typed contract. Even a hostile cast cannot
      // select the destination, credential or provider.
      endpoint: "https://attacker.invalid/redeem",
      token: "attacker-token",
      provider: "attacker",
    } as never);

    expect(connection).toEqual({
      provider: "openrouter",
      apiKey: "personal-openrouter-key",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "http://openbot.internal:3001/internal/ai-credentials/redeem",
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.headers.get("x-openbot-agent-token")).toBe(MANAGED_TOKEN);
    expect(await calls[0]?.json()).toEqual({ lease: LEASE, run: RUN });
    expect(JSON.stringify(calls)).not.toContain("attacker.invalid");
    expect(JSON.stringify(calls)).not.toContain("attacker-token");
  });

  test("returns the exact typed ChatGPT provider context in memory", async () => {
    const authDocument = JSON.stringify({ tokens: "private-chatgpt-auth" });
    const resolver = createPersonalProviderConnectionResolver({
      serverUrl: "http://openbot.internal:3001/",
      managedAgentToken: MANAGED_TOKEN,
      fetch: async () => Response.json({ provider: "chatgpt", authDocument }),
    });

    await expect(resolver({ lease: LEASE, run: RUN })).resolves.toEqual({
      provider: "chatgpt",
      authDocument,
    });
  });

  test("uses one safe error for refusal, malformed payloads and network failures", async () => {
    const privateValue = "PRIVATE-PROVIDER-VALUE";
    const responses = [
      async () =>
        Response.json(
          { error: `upstream included ${privateValue}` },
          { status: 403 },
        ),
      async () =>
        Response.json({
          provider: "openrouter",
          apiKey: privateValue,
          extra: privateValue,
        }),
      async () => {
        throw new Error(`network included ${privateValue}`);
      },
    ];

    for (const fetch of responses) {
      const resolver = createPersonalProviderConnectionResolver({
        serverUrl: "http://openbot.internal:3001",
        managedAgentToken: MANAGED_TOKEN,
        fetch,
      });
      let thrown: unknown;
      try {
        await resolver({ lease: LEASE, run: RUN });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(PersonalProviderConnectionUnavailableError);
      expect(thrown).toMatchObject({
        name: "PersonalProviderConnectionUnavailableError",
        message: "Personal AI connection is unavailable.",
      });
      expect(JSON.stringify(thrown)).not.toContain(privateValue);
    }
  });

  test("cancels an oversized chunked response before buffering it", async () => {
    let cancelled = false;
    const resolver = createPersonalProviderConnectionResolver({
      serverUrl: "http://openbot.internal:3001",
      managedAgentToken: MANAGED_TOKEN,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(258 * 1_024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });

    await expect(resolver({ lease: LEASE, run: RUN })).rejects.toBeInstanceOf(
      PersonalProviderConnectionUnavailableError,
    );
    expect(cancelled).toBe(true);
  });

  test("rejects invalid startup configuration and unbounded request fields without echoing them", async () => {
    expect(() =>
      createPersonalProviderConnectionResolver({
        serverUrl: "https://user:password@attacker.invalid/path?secret=value",
        managedAgentToken: MANAGED_TOKEN,
      }),
    ).toThrow("Personal provider connection configuration is invalid.");

    const resolver = createPersonalProviderConnectionResolver({
      serverUrl: "http://openbot.internal:3001",
      managedAgentToken: MANAGED_TOKEN,
      fetch: async () => {
        throw new Error("must not fetch");
      },
    });
    const privateValue = "PRIVATE-LEASE-VALUE";
    let thrown: unknown;
    try {
      await resolver({ lease: privateValue, run: "" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PersonalProviderConnectionUnavailableError);
    expect(String(thrown)).not.toContain(privateValue);
  });
});
