import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { mintRunAssertion } from "../src/agents/callback-token";
import { type CallbackRunTools, createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { GrantedTool } from "../src/plugins/tools";
import { vendorToolConnection } from "../src/plugins/transport";
import { testEnvironment } from "./support/environment";

const LEGACY_TOKEN = "test-agent-tool-token";

type CapturedCall = {
  ref: string;
  args: Record<string, unknown>;
  botId: string;
  actorId: string;
  runId: string;
  threadId?: string;
};

function testApp(calls: CapturedCall[], callbackRunTools?: CallbackRunTools) {
  const config = loadConfig(
    testEnvironment({ AGENT_TOOL_TOKEN: LEGACY_TOKEN }),
  );
  const pluginStore = {
    callTool: async (input: CapturedCall) => {
      calls.push(input);
      return { text: "ok", isError: false };
    },
  };
  const args: Parameters<typeof createApp> = [
    config,
    undefined, // auth
    undefined, // roleRepository
    undefined, // auditReader
    undefined, // credentialService
    undefined, // packageStatusReader
    undefined, // copilotHandler
    undefined, // computerGateway
    undefined, // computerPolicy
    undefined, // agentProfileStore
    undefined, // channelStore
    undefined, // channelEvents
    undefined, // auditStore
    undefined, // componentStore
    pluginStore as never,
    undefined, // sandboxedStore
    undefined, // threadIdentity
    undefined, // peopleStore
    undefined, // identityProviders
    undefined, // intentRouter
    undefined, // pageFrames
    undefined, // routineRunner
    undefined, // routineStore
    undefined, // workspaceTimingStore
    undefined, // attachmentRoutes
    undefined, // googleDocumentEdits
    callbackRunTools,
  ];
  return {
    app: createApp(...args),
    config,
  };
}

describe("the trusted context of an agent tool call", () => {
  test("comes only from the signed run assertion, never from tool arguments", async () => {
    const calls: CapturedCall[] = [];
    const { app, config } = testApp(calls);
    const forged = {
      actorId: "forged-actor",
      botId: "forged-bot",
      runId: "forged-run",
      threadId: "forged-thread",
      channelId: "forged-channel",
    };
    const run = mintRunAssertion(
      {
        actorId: "signed-actor",
        botId: "signed-bot",
        runId: "signed-run",
        threadId: "signed-thread",
      },
      config.keyEncryptionKey,
    );

    const response = await app.request(
      "http://openbot.test/api/agent-tools/call",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": LEGACY_TOKEN,
        },
        body: JSON.stringify({
          name: "mcp__attachments__list_conversation_attachments",
          args: forged,
          run,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        ref: "attachments/list_conversation_attachments",
        args: forged,
        actorId: "signed-actor",
        botId: "signed-bot",
        runId: "signed-run",
        threadId: "signed-thread",
      },
    ]);
  });

  test("rebuilds a remote handoff tool only from the signed run", async () => {
    const calls: CapturedCall[] = [];
    const trustedRuns: Parameters<CallbackRunTools>[0][] = [];
    const executed: unknown[] = [];
    const callbackTool: GrantedTool = {
      ref: "bot/message_bot",
      name: "message_bot",
      description: "Hand work to another Bot.",
      parameters: z.object({ bot: z.string(), task: z.string() }),
      execute: async (args) => {
        executed.push(args);
        return "sent securely";
      },
    };
    const { app, config } = testApp(calls, async (run) => {
      trustedRuns.push(run);
      return [callbackTool];
    });
    const args = {
      bot: "Editor",
      task: "Tighten the copy",
      actorId: "forged-actor",
      botId: "forged-bot",
      depth: 99,
    };
    const run = mintRunAssertion(
      {
        actorId: "signed-actor",
        botId: "signed-bot",
        runId: "signed-run",
        threadId: "signed-thread",
        depth: 2,
      },
      config.keyEncryptionKey,
    );

    const response = await app.request(
      "http://openbot.test/api/agent-tools/call",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openbot-agent-token": LEGACY_TOKEN,
        },
        body: JSON.stringify({ name: "message_bot", args, run }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: "sent securely",
      isError: false,
    });
    expect(trustedRuns).toEqual([
      {
        actorId: "signed-actor",
        botId: "signed-bot",
        runId: "signed-run",
        threadId: "signed-thread",
        depth: 2,
      },
    ]);
    expect(executed).toEqual([args]);
    expect(calls).toEqual([]);
  });

  test("is copied to a transport connection without consulting tool arguments", () => {
    const forgedArgs = {
      actorId: "forged-actor",
      botId: "forged-bot",
      runId: "forged-run",
      threadId: "forged-thread",
      channelId: "forged-channel",
    };
    const trustedContextBesideUntrustedArgs = {
      actorId: "signed-actor",
      botId: "signed-bot",
      runId: "signed-run",
      threadId: "signed-thread",
      args: forgedArgs,
    };

    expect(
      vendorToolConnection(
        { url: "builtin://attachments" },
        trustedContextBesideUntrustedArgs,
      ),
    ).toEqual({
      url: "builtin://attachments",
      actorId: "signed-actor",
      botId: "signed-bot",
      runId: "signed-run",
      threadId: "signed-thread",
    });
  });
});
