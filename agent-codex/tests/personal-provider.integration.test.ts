import { describe, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { RunAgentInput } from "@ag-ui/core";
import { createAgentResponse } from "../src/agent-run";
import { runCodex } from "../src/codex-run";
import {
  createAgentExecutionTiming,
  type ExecutionTimingRecord,
} from "../src/execution-timing";
import type { CodexRuntimeProfile } from "../src/runtime-profile";

type ProtocolRequest = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
};

function managedInput(input: {
  actor: string;
  run: string;
  tools?: boolean;
}): RunAgentInput {
  return {
    agentId: "shared-research-employee",
    runId: input.run,
    threadId: `thread-${input.actor}`,
    state: {},
    context: [],
    messages: [
      {
        id: `message-${input.actor}`,
        role: "user",
        content: `Private task for ${input.actor}`,
      },
    ],
    tools: input.tools
      ? [
          {
            name: "mcp__artifacts__create_artifact",
            description: "Create one governed artifact.",
            parameters: { type: "object" },
          },
        ]
      : [],
    forwardedProps: {
      openbotBotId: "shared-research-employee",
      openbotRun: `signed-${input.actor}-${input.run}`,
      openbotDeploymentTools: input.tools
        ? ["mcp__artifacts__create_artifact"]
        : [],
    },
  } as unknown as RunAgentInput;
}

function protocolChild(options: {
  label: string;
  requests: ProtocolRequest[];
  onTurn?: (child: FakeChild) => void;
  toolResponseIds?: number[];
}): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    queueMicrotask(() => child.emit("exit", 0, signal));
    return true;
  };
  queueMicrotask(() => child.emit("spawn"));

  const pendingToolResponses = new Set(options.toolResponseIds ?? []);
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk)) as ProtocolRequest;
    options.requests.push(request);
    if (
      typeof request.id === "number" &&
      !request.method &&
      pendingToolResponses.delete(request.id)
    ) {
      if (pendingToolResponses.size === 0) {
        queueMicrotask(() => {
          child.stdout.write(
            `${JSON.stringify({
              method: "turn/completed",
              params: { turn: { status: "completed" } },
            })}\n`,
          );
        });
      }
      return;
    }
    if (request.id === undefined) return;

    const result =
      request.method === "thread/start"
        ? { thread: { id: `codex-${options.label}` } }
        : request.method === "turn/start"
          ? { turn: { id: `turn-${options.label}` } }
          : {};
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method !== "turn/start") return;
      if (options.onTurn) {
        options.onTurn(child);
      } else {
        child.stdout.write(
          `${JSON.stringify({
            method: "item/agentMessage/delta",
            params: {
              itemId: `answer-${options.label}`,
              delta: `completed-${options.label}`,
            },
          })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          })}\n`,
        );
      }
    });
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

async function isAbsent(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

describe("personal OpenRouter provider isolation", () => {
  test("runs one shared employee with distinct provider state and ephemeral histories", async () => {
    const actors = ["first-actor", "second-actor"] as const;
    const keys = [
      "first-provider-canary-that-must-stay-private",
      "second-provider-canary-that-must-stay-private",
    ] as const;
    const requests: ProtocolRequest[][] = [[], []];
    const profiles: CodexRuntimeProfile[] = [];
    const brokerUrls = new Map<string, string>();

    await Promise.all(
      actors.map((actor, index) =>
        runCodex(
          managedInput({ actor, run: `run-${index}` }),
          {
            onText() {},
            onReasoning() {},
            onToolStart() {},
            onToolResult() {},
          },
          {
            providerConnection: {
              provider: "openrouter",
              apiKey: keys[index]!,
            },
            environment: {
              PATH: process.env.PATH,
              OPENROUTER_MODEL: "openrouter/task-21-model",
            },
            spawn: (profile) => {
              profiles.push(profile);
              const config = readFileSync(
                `${profile.codexHome}/config.toml`,
                "utf8",
              );
              const brokerUrl = config.match(/^base_url = "([^"]+)"$/m)?.[1];
              if (!brokerUrl) throw new Error("fixture broker URL is missing");
              expect(config).not.toContain(keys[index]);
              expect(config).not.toContain("openrouter.ai");
              brokerUrls.set(actor, brokerUrl);
              return protocolChild({
                label: actor,
                requests: requests[index]!,
              });
            },
          },
        ),
      ),
    );

    expect(new Set(brokerUrls.values()).size).toBe(2);
    expect(new Set(profiles.map(({ codexHome }) => codexHome)).size).toBe(2);
    expect(
      await Promise.all(profiles.map(({ codexHome }) => isAbsent(codexHome))),
    ).toEqual([true, true]);
    expect(
      profiles.every(({ environment }) => !environment.OPENROUTER_API_KEY),
    ).toBe(true);
    for (const brokerUrl of brokerUrls.values()) {
      await expect(
        fetch(`${brokerUrl}/models`, { signal: AbortSignal.timeout(500) }),
      ).rejects.toThrow();
    }

    for (const actorRequests of requests) {
      const threadStart = actorRequests.find(
        ({ method }) => method === "thread/start",
      );
      expect(threadStart?.params).toMatchObject({
        model: "openrouter/task-21-model",
        ephemeral: true,
      });
      expect(JSON.stringify(actorRequests).includes(keys[0])).toBe(false);
      expect(JSON.stringify(actorRequests).includes(keys[1])).toBe(false);
    }
  });

  test("keeps secret canaries out of AG-UI events, tool results and bounded logs", async () => {
    const secret = "browser-event-secret-canary-that-must-never-escape";
    const timingRows: ExecutionTimingRecord[] = [];
    const timing = createAgentExecutionTiming(
      managedInput({ actor: "canary-actor", run: "canary-run", tools: true }),
      {
        agentId: "shared-research-employee",
        requestId: "task-21-canary-request",
        sink: (row) => timingRows.push(row),
      },
    );
    let deploymentCalls = 0;
    const input = managedInput({
      actor: "canary-actor",
      run: "canary-run",
      tools: true,
    });
    const response = createAgentResponse(input, {
      timing,
      run: (runInput, callbacks, runTiming) =>
        runCodex(runInput, callbacks, {
          timing: runTiming,
          providerConnection: { provider: "openrouter", apiKey: secret },
          environment: {
            PATH: process.env.PATH,
            OPENROUTER_MODEL: "openrouter/task-21-model",
          },
          deploymentToolCaller: async () => {
            deploymentCalls += 1;
            return {
              text: `governed tool accidentally echoed ${secret}`,
              isError: false,
            };
          },
          spawn: () =>
            protocolChild({
              label: "canary",
              requests: [],
              toolResponseIds: [900, 901],
              onTurn: (child) => {
                const split = Math.floor(secret.length / 2);
                for (const delta of [
                  secret.slice(0, split),
                  secret.slice(split),
                ]) {
                  child.stdout.write(
                    `${JSON.stringify({
                      method: "item/agentMessage/delta",
                      params: { itemId: "secret-answer", delta },
                    })}\n`,
                  );
                }
                child.stdout.write(
                  `${JSON.stringify({
                    method: "item/reasoning/summaryTextDelta",
                    params: {
                      itemId: "secret-reasoning",
                      summaryIndex: 0,
                      delta: `reasoning echoed ${secret}`,
                    },
                  })}\n`,
                );
                child.stdout.write(
                  `${JSON.stringify({
                    id: 900,
                    method: "item/tool/call",
                    params: {
                      callId: "sensitive-tool",
                      tool: "openbot__artifacts__create_artifact",
                      arguments: { content: `unsafe ${secret}` },
                    },
                  })}\n`,
                );
                child.stdout.write(
                  `${JSON.stringify({
                    id: 901,
                    method: "item/tool/call",
                    params: {
                      callId: "safe-tool",
                      tool: "openbot__artifacts__create_artifact",
                      arguments: { content: "safe artifact" },
                    },
                  })}\n`,
                );
                child.stderr.write(`stderr echoed ${secret}`);
              },
            }),
        }),
    });

    const browserEvents = await response.text();
    const boundedLogs = JSON.stringify(timingRows);
    expect(deploymentCalls).toBe(1);
    expect(browserEvents.includes(secret)).toBe(false);
    expect(browserEvents).toContain("[redacted]");
    expect(browserEvents).toContain(
      "Provider credentials cannot be passed to a deployment tool.",
    );
    expect(boundedLogs.includes(secret)).toBe(false);
    expect(boundedLogs.length).toBeLessThan(16_384);
    expect(browserEvents.length).toBeLessThan(32_768);
  });

  test("passes only the original signed run context to a governed tool callback", async () => {
    const input = managedInput({
      actor: "signed-actor",
      run: "signed-run",
      tools: true,
    });
    const captured: Array<{
      run: unknown;
      name: string;
      args: Record<string, unknown>;
    }> = [];
    await runCodex(
      input,
      {
        onText() {},
        onReasoning() {},
        onToolStart() {},
        onToolResult() {},
      },
      {
        providerConnection: {
          provider: "openrouter",
          apiKey: "signed-run-provider-key",
        },
        environment: {
          PATH: process.env.PATH,
          OPENROUTER_MODEL: "openrouter/task-21-model",
        },
        deploymentToolCaller: async (runInput, name, args) => {
          captured.push({
            run: (runInput.forwardedProps as Record<string, unknown>)
              .openbotRun,
            name,
            args,
          });
          return { text: "governed", isError: false };
        },
        spawn: () =>
          protocolChild({
            label: "signed-run",
            requests: [],
            toolResponseIds: [902],
            onTurn: (child) => {
              child.stdout.write(
                `${JSON.stringify({
                  id: 902,
                  method: "item/tool/call",
                  params: {
                    callId: "forged-output-context",
                    tool: "openbot__artifacts__create_artifact",
                    arguments: {
                      actorId: "provider-forged-actor",
                      run: "provider-forged-run",
                      content: "safe artifact",
                    },
                  },
                })}\n`,
              );
            },
          }),
      },
    );

    expect(captured).toEqual([
      {
        run: "signed-signed-actor-signed-run",
        name: "mcp__artifacts__create_artifact",
        args: {
          actorId: "provider-forged-actor",
          run: "provider-forged-run",
          content: "safe artifact",
        },
      },
    ]);
  });

  test("denies the shared profile root to every employee sandbox profile", async () => {
    const config = await readFile(
      new URL("../config.toml", import.meta.url),
      "utf8",
    );
    expect(config.match(/^"~\/\.codex" = "deny"$/gm)?.length).toBe(5);
  });
});
