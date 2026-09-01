import { describe, expect, it } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { RunAgentInput } from "@ag-ui/core";
import {
  codexEnvironmentFor,
  codexProcessEnvironment,
  codexToolName,
  modelFor,
  reasoningEffortFor,
  researchFinalisationIssue,
  runCodex,
  toolCallNames,
  turnInputFor,
  workspaceFor,
  youtubeArtifactFinalisationIssue,
} from "../src/codex-run";
import {
  createAgentExecutionTiming,
  type ExecutionTimingRecord,
} from "../src/execution-timing";
import { OPENROUTER_API_KEY_ENVIRONMENT_KEY } from "../src/runtime-profile";

describe("Codex dynamic tool names", () => {
  it("moves governed MCP tools out of Codex's reserved namespace", () => {
    expect(codexToolName("mcp__parser-ops__audit_all_sources")).toBe(
      "openbot__parser-ops__audit_all_sources",
    );
  });

  it("does not rename ordinary deployment tools", () => {
    expect(codexToolName("workspace_status")).toBe("workspace_status");
  });

  it("reports the safe wire name while calling the governed deployment name", () => {
    const names = toolCallNames(
      "openbot__parser-ops__audit_all_sources",
      new Map([
        [
          "openbot__parser-ops__audit_all_sources",
          "mcp__parser-ops__audit_all_sources",
        ],
      ]),
    );

    expect(names).toEqual({
      deploymentName: "mcp__parser-ops__audit_all_sources",
      eventName: "openbot__parser-ops__audit_all_sources",
    });
  });

  it("uses the managed coworker's model and workspace override", () => {
    const input = {
      agentId: "heartpulse-control",
      forwardedProps: { openbotAgentModel: "gpt-5.6-luna" },
    } as never;
    expect(modelFor(input)).toBe("gpt-5.6-luna");
    expect(reasoningEffortFor(input)).toBe("xhigh");
    expect(workspaceFor(input)).toBe("/workspace-heartpulse");
  });

  it("uses the research model, xhigh effort and isolated report workspace", () => {
    const input = {
      agentId: process.env.RESEARCH_AGENT_ID?.trim() || "research-analyst",
    } as never;
    expect(modelFor(input)).toBe("gpt-5.6-luna");
    expect(reasoningEffortFor(input)).toBe("xhigh");
    expect(workspaceFor(input)).toBe("/research-runs");
  });

  it("uses a read-only YouTube workspace and requires a Markdown artifact", () => {
    const input = {
      agentId:
        process.env.YOUTUBE_ANALYST_AGENT_ID?.trim() || "youtube-analyst",
      messages: [
        {
          id: "user",
          role: "user",
          content: "https://www.youtube.com/watch?v=9TLANtoG9c8",
        },
      ],
      forwardedProps: { openbotAgentModel: "gpt-5.6-luna" },
    } as never;
    expect(modelFor(input)).toBe("gpt-5.6-luna");
    expect(reasoningEffortFor(input)).toBe("xhigh");
    expect(workspaceFor(input)).toBe("/youtube-workspace");
    expect(youtubeArtifactFinalisationIssue(false)).toContain("artifact");
    expect(youtubeArtifactFinalisationIssue(true)).toBeNull();
    expect(
      codexEnvironmentFor(input, {
        PATH: "/usr/bin",
        AGENT_TOOL_TOKEN: "agent-secret",
        MANAGED_AGENT_TOKEN: "managed-secret",
        RESEARCH_SOURCE_GATEWAY_TOKEN: "gateway-secret",
      }),
    ).toEqual({ PATH: "/usr/bin" });
    expect(turnInputFor(input, "<youtube_transcript_data />")).toContain(
      "<youtube_transcript_data />",
    );
  });

  it("requests finalisation when research ends as progress-only text", () => {
    expect(
      researchFinalisationIssue(
        "Начинаю исследование. План зафиксирован. Первый проход завершён.",
        false,
      ),
    ).toContain("progress");
    expect(
      researchFinalisationIssue("## Результат\nWin rate: 54%.", false),
    ).toContain("Источники");
  });

  it("does not mark an analyst update with promised follow-up work as complete", () => {
    expect(
      researchFinalisationIssue(
        [
          "Первый статистический срез доступен. Теперь проверяю конкретные списки карт и парные матчапы.",
          "Параллельно проверяю актуальные списки и независимые практические разборы.",
          "Осталось оформить доказательства, контраргументы и финальную проверку.",
        ].join("\n\n"),
        false,
      ),
    ).toContain("progress");
  });

  it("rejects the exact promised-result wording seen in production", () => {
    expect(
      researchFinalisationIssue(
        "Срез подтверждён. Поэтому итог будет строго ограничен свежестью доступного API.",
        false,
      ),
    ).not.toBeNull();
  });

  it("allows a bounded final result that describes completed verification", () => {
    expect(
      researchFinalisationIssue(
        "## Результат\nПроверка завершена: Pure Paladin имеет 54,6% побед.\n\nФайл: `/research-runs/pure-paladin/report.md`\n\n## Источники\n- API snapshot",
        true,
      ),
    ).toBeNull();
  });

  it("requires the downloadable research artifact", () => {
    expect(
      researchFinalisationIssue(
        "## Результат\nПроверка завершена.\n\nФайл: `/research-runs/check/report.md`\n\n## Источники\n- API snapshot",
        false,
      ),
    ).toContain("artifact");
  });

  it("does not accept an HSReplay/HSGuru access failure without the first-party API", () => {
    expect(
      researchFinalisationIssue(
        "HSReplay и HSGuru не открылись, поэтому данных нет.",
        false,
      ),
    ).toContain("first-party API");
    expect(
      researchFinalisationIssue(
        "## Результат\nHSReplay HTML недоступен, но stats-api вернул dataset из api.kolodahearthstone.com.\n\nФайл: `/research-runs/api-check/report.md`\n\n## Источники\n- first-party API",
        true,
      ),
    ).toBeNull();
  });

  it("ignores unsafe model overrides", () => {
    const input = {
      forwardedProps: { openbotAgentModel: "gpt-5.6-luna-xhigh;rm" },
    } as never;
    expect(modelFor(input)).not.toBe("gpt-5.6-luna-xhigh;rm");
  });

  it("accepts only a known reasoning effort override", () => {
    const input = {
      forwardedProps: { openbotAgentReasoningEffort: "xhigh" },
    } as never;
    expect(reasoningEffortFor(input)).toBe("xhigh");
  });

  it("falls back for an unsafe reasoning effort override", () => {
    const input = {
      forwardedProps: { openbotAgentReasoningEffort: "xhigh;rm" },
    } as never;
    expect(reasoningEffortFor(input)).toBe("low");
  });
});

describe("Codex process timing", () => {
  it("strips dynamic-loader overrides before the image-owned guarded child", () => {
    expect(
      codexProcessEnvironment({
        environment: {
          PATH: "/usr/bin",
          LD_PRELOAD: "/attacker/library.so",
          LD_LIBRARY_PATH: "/attacker",
        },
      }),
    ).toEqual({
      PATH: "/usr/bin",
    });
  });

  it("runs OpenRouter with the fixed provider and server-configured model", async () => {
    const privateKey = "private-openrouter-run-key";
    const requests: Array<{
      method?: string;
      params?: Record<string, unknown>;
    }> = [];
    let codexHome = "";
    let config = "";
    let brokerBaseUrl = "";
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    const input = {
      ...processInput(),
      forwardedProps: {
        openbotBotId: "codex",
        openbotAgentModel: "client-openai-only-model",
        openbotProviderBaseUrl: "https://attacker.invalid/v1",
      },
    } as RunAgentInput;

    await runCodex(input, emptyCallbacks, {
      providerConnection: { provider: "openrouter", apiKey: privateKey },
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_MODEL: "openrouter/tool-model",
      },
      spawn: (profile) => {
        codexHome = profile.codexHome;
        childEnvironment = profile.environment;
        config = readFileSync(`${profile.codexHome}/config.toml`, "utf8");
        brokerBaseUrl = configuredProviderBaseUrl(config);
        return fakeCodexProcess({ requests });
      },
    });

    const parsedBrokerBaseUrl = new URL(brokerBaseUrl);
    expect(parsedBrokerBaseUrl.protocol).toBe("http:");
    expect(parsedBrokerBaseUrl.hostname).toBe("127.0.0.1");
    expect(parsedBrokerBaseUrl.pathname).toMatch(/^\/[A-Za-z0-9_-]{43}\/v1$/);
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('default_permissions = "openbot-agent"');
    expect(config).not.toContain("attacker.invalid");
    expect(config).not.toContain("openrouter.ai");
    expect(config).not.toMatch(/^auth\s*=/m);
    expect(config).not.toContain(privateKey);
    expect(
      requests.find((request) => request.method === "thread/start")?.params,
    ).toMatchObject({ model: "openrouter/tool-model" });
    expect(JSON.stringify(requests)).not.toContain("client-openai-only-model");
    expect(
      childEnvironment?.[OPENROUTER_API_KEY_ENVIRONMENT_KEY],
    ).toBeUndefined();
    await expect(access(codexHome)).rejects.toThrow();
    await expect(
      fetch(`${brokerBaseUrl}/models`, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
  });

  it("fails OpenRouter before spawn when its server model is absent", async () => {
    let spawned = false;
    await expect(
      runCodex(processInput(), emptyCallbacks, {
        providerConnection: {
          provider: "openrouter",
          apiKey: "private-openrouter-key",
        },
        environment: { PATH: process.env.PATH },
        spawn: () => {
          spawned = true;
          return fakeCodexProcess();
        },
      }),
    ).rejects.toThrow("OpenRouter model configuration is invalid.");
    expect(spawned).toBe(false);
  });

  it("redacts an OpenRouter key from spawn failures and removes its profile", async () => {
    const privateKey = "private-openrouter-error-key";
    let codexHome = "";
    let thrown: unknown;
    try {
      await runCodex(processInput(), emptyCallbacks, {
        providerConnection: { provider: "openrouter", apiKey: privateKey },
        environment: {
          PATH: process.env.PATH,
          OPENROUTER_MODEL: "openrouter/tool-model",
        },
        spawn: (profile) => {
          codexHome = profile.codexHome;
          throw new Error(`child echoed ${privateKey}`);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("[redacted]");
    expect(String(thrown)).not.toContain(privateKey);
    await expect(access(codexHome)).rejects.toThrow();
  });

  it("redacts streamed provider secrets and refuses sensitive tool arguments", async () => {
    const privateKey = "private-openrouter-stream-key";
    const observed: unknown[] = [];
    let deploymentCalls = 0;
    const input = toolProcessInput();

    await runCodex(
      input,
      {
        onText(delta, itemId) {
          observed.push({ type: "text", delta, itemId });
        },
        onReasoning(delta, itemId, summaryIndex) {
          observed.push({ type: "reasoning", delta, itemId, summaryIndex });
        },
        onToolStart(callId, name, args) {
          observed.push({ type: "tool-start", callId, name, args });
        },
        onToolResult(callId, result) {
          observed.push({ type: "tool-result", callId, result });
        },
      },
      {
        providerConnection: { provider: "openrouter", apiKey: privateKey },
        environment: {
          PATH: process.env.PATH,
          OPENROUTER_MODEL: "openrouter/tool-model",
        },
        spawn: () => secretToolCodexProcess(privateKey, true),
        deploymentToolCaller: async () => {
          deploymentCalls += 1;
          return { text: "unexpected", isError: false };
        },
      },
    );

    const publicEvents = JSON.stringify(observed);
    expect(publicEvents).not.toContain(privateKey);
    expect(publicEvents).toContain("[redacted]");
    expect(publicEvents).toContain("Provider credentials cannot be passed");
    expect(deploymentCalls).toBe(0);
  });

  it("redacts provider secrets returned by a governed deployment tool", async () => {
    const privateKey = "private-openrouter-tool-result-key";
    const observed: unknown[] = [];
    await runCodex(
      toolProcessInput(),
      {
        ...emptyCallbacks,
        onToolResult(callId, result) {
          observed.push({ callId, result });
        },
      },
      {
        providerConnection: { provider: "openrouter", apiKey: privateKey },
        environment: {
          PATH: process.env.PATH,
          OPENROUTER_MODEL: "openrouter/tool-model",
        },
        spawn: () => secretToolCodexProcess(privateKey, false),
        deploymentToolCaller: async () => ({
          text: `deployment echoed ${privateKey}`,
          isError: false,
        }),
      },
    );

    expect(JSON.stringify(observed)).not.toContain(privateKey);
    expect(JSON.stringify(observed)).toContain("[redacted]");
  });

  it("redacts a provider secret from a terminal protocol failure", async () => {
    const privateKey = "private-openrouter-protocol-key";
    await expect(
      runCodex(processInput(), emptyCallbacks, {
        providerConnection: { provider: "openrouter", apiKey: privateKey },
        environment: {
          PATH: process.env.PATH,
          OPENROUTER_MODEL: "openrouter/tool-model",
        },
        spawn: () => secretFailureCodexProcess(privateKey),
      }),
    ).rejects.toThrow("[redacted]");
    try {
      await runCodex(processInput(), emptyCallbacks, {
        providerConnection: { provider: "openrouter", apiKey: privateKey },
        environment: {
          PATH: process.env.PATH,
          OPENROUTER_MODEL: "openrouter/tool-model",
        },
        spawn: () => secretFailureCodexProcess(privateKey),
      });
    } catch (error) {
      expect(String(error)).not.toContain(privateKey);
    }
  });

  it("redacts a maximum-length provider key before bounding stderr", async () => {
    const privateKey = `K${"a".repeat(4094)}Z`;
    let thrown: unknown;
    try {
      await runCodex(processInput(), emptyCallbacks, {
        providerConnection: { provider: "openrouter", apiKey: privateKey },
        environment: {
          PATH: process.env.PATH,
          OPENROUTER_MODEL: "openrouter/tool-model",
        },
        spawn: () => stderrSecretFailureCodexProcess([privateKey]),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("[redacted]");
    expect(String(thrown)).not.toContain(privateKey.slice(-512));
  });

  it("redacts a maximum-length provider key split across stderr chunks", async () => {
    const privateKey = `S${"b".repeat(4094)}T`;
    const split = 2_003;
    let thrown: unknown;
    try {
      await runCodex(processInput(), emptyCallbacks, {
        providerConnection: { provider: "openrouter", apiKey: privateKey },
        environment: {
          PATH: process.env.PATH,
          OPENROUTER_MODEL: "openrouter/tool-model",
        },
        spawn: () =>
          stderrSecretFailureCodexProcess([
            privateKey.slice(0, split),
            privateKey.slice(split),
          ]),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("[redacted]");
    expect(String(thrown)).not.toContain(privateKey.slice(-512));
  });

  it("does not start an unauthenticated fallback for a ChatGPT context", async () => {
    let spawned = false;
    await expect(
      runCodex(processInput(), emptyCallbacks, {
        providerConnection: { provider: "chatgpt", authDocument: "{}" },
        spawn: () => {
          spawned = true;
          return fakeCodexProcess();
        },
      }),
    ).rejects.toThrow("Personal AI connection is unavailable.");
    expect(spawned).toBe(false);
  });

  it("removes the isolated runtime profile after success", async () => {
    let codexHome = "";

    await runCodex(processInput(), emptyCallbacks, {
      spawn: (profile) => {
        codexHome = profile.codexHome;
        expect(profile.environment.CODEX_HOME).toBe(codexHome);
        return fakeCodexProcess();
      },
    });

    expect(codexHome).not.toBe("");
    await expect(access(codexHome)).rejects.toThrow();
  });

  it("removes the isolated runtime profile after failure", async () => {
    let codexHome = "";

    await expect(
      runCodex(processInput(), emptyCallbacks, {
        spawn: (profile) => {
          codexHome = profile.codexHome;
          return failingCodexProcess("error");
        },
      }),
    ).rejects.toThrow("early spawn failure");

    expect(codexHome).not.toBe("");
    await expect(access(codexHome)).rejects.toThrow();
  });

  it("removes the isolated runtime profile after a cancelled turn", async () => {
    let codexHome = "";
    let brokerBaseUrl = "";

    await runCodex(processInput(), emptyCallbacks, {
      providerConnection: {
        provider: "openrouter",
        apiKey: "private-cancelled-key",
      },
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_MODEL: "openrouter/tool-model",
      },
      spawn: (profile) => {
        codexHome = profile.codexHome;
        brokerBaseUrl = configuredProviderBaseUrl(
          readFileSync(`${profile.codexHome}/config.toml`, "utf8"),
        );
        return fakeCodexProcess({ turnStatus: "cancelled" });
      },
    });

    expect(codexHome).not.toBe("");
    await expect(access(codexHome)).rejects.toThrow();
    await expect(
      fetch(`${brokerBaseUrl}/models`, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
  });

  it("records spawn, initialization, thread and turn acknowledgements in order", async () => {
    const input = {
      agentId: "spoofed-agent",
      runId: "run-process",
      threadId: "thread-process",
      messages: [{ id: "u", role: "user", content: "Do not log me" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: { openbotBotId: "codex" },
    } as unknown as RunAgentInput;
    const records: ExecutionTimingRecord[] = [];
    const timing = createAgentExecutionTiming(input, {
      requestId: "request-process",
      now: () => records.length,
      sink: (record) => records.push(record),
    });

    await runCodex(
      input,
      {
        onText() {},
        onReasoning() {},
        onToolStart() {},
        onToolResult() {},
      },
      { timing, spawn: fakeCodexProcess },
    );

    expect(records.map((record) => record.phase)).toEqual([
      "child_process_spawned",
      "codex_initialized",
      "codex_thread_started",
      "codex_turn_started",
    ]);
    expect(JSON.stringify(records)).not.toContain("Do not log me");
  });

  it("keeps a research run open for a finalisation turn after an incomplete update", async () => {
    const turnInputs: string[] = [];
    const input = {
      ...researchProcessInput(),
    } as RunAgentInput;

    await runCodex(input, emptyCallbacks, {
      spawn: () => researchFinalisationProcess(turnInputs),
      deploymentToolCaller: successfulArtifactCall,
    });

    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[1]).toContain("Finalise the research now");
  });

  it("steers an overlong collection pass before forcing a bounded final report", async () => {
    const methods: string[] = [];
    const turnInputs: string[] = [];
    const input = {
      ...researchProcessInput(),
    } as RunAgentInput;

    await runCodex(input, emptyCallbacks, {
      spawn: () => researchDeadlineProcess(methods, turnInputs),
      researchCollectionMaxMs: 5,
      researchFinalisationMaxMs: 5,
      deploymentToolCaller: successfulArtifactCall,
    });

    expect(methods).toContain("turn/steer");
    expect(methods).toContain("turn/interrupt");
    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[1]).toContain(
      "do not start another broad collection pass",
    );
  });

  it("fails a research run when the runtime ignores the bounded interrupt", async () => {
    const methods: string[] = [];

    await expect(
      runCodex(researchProcessInput(), emptyCallbacks, {
        spawn: () => researchDeadlineProcess(methods, [], false),
        researchCollectionMaxMs: 5,
        researchFinalisationMaxMs: 5,
        researchInterruptGraceMs: 5,
      }),
    ).rejects.toThrow("did not stop after its bounded finalisation deadline");

    expect(methods).toContain("turn/steer");
    expect(methods).toContain("turn/interrupt");
  });

  it("rejects an initialize request when the child process fails before spawn", async () => {
    await expect(
      runCodex(processInput(), emptyCallbacks, {
        spawn: () => failingCodexProcess("error"),
      }),
    ).rejects.toThrow("early spawn failure");
  });

  it("rejects an initialize request when the spawned child exits before replying", async () => {
    await expect(
      runCodex(processInput(), emptyCallbacks, {
        spawn: () => failingCodexProcess("exit"),
      }),
    ).rejects.toThrow("stopped with code 17");
  });

  it("waits for process exit and escalates a stuck SIGTERM before resolving", async () => {
    const signals: NodeJS.Signals[] = [];
    let providerEnvironment: NodeJS.ProcessEnv | undefined;
    let brokerBaseUrl = "";

    await runCodex(processInput(), emptyCallbacks, {
      providerConnection: {
        provider: "openrouter",
        apiKey: "private-forced-kill-key",
      },
      environment: {
        PATH: process.env.PATH,
        OPENROUTER_MODEL: "openrouter/tool-model",
      },
      spawn: (profile) => {
        providerEnvironment = profile.environment;
        brokerBaseUrl = configuredProviderBaseUrl(
          readFileSync(`${profile.codexHome}/config.toml`, "utf8"),
        );
        return fakeCodexProcess({
          signals,
          exitOnSignal: "SIGKILL",
        });
      },
      processExitGraceMs: 5,
    });

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(providerEnvironment?.OPENROUTER_API_KEY).toBeUndefined();
    await expect(
      fetch(`${brokerBaseUrl}/models`, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
  });
});

const emptyCallbacks = {
  onText() {},
  onReasoning() {},
  onToolStart() {},
  onToolResult() {},
};

function configuredProviderBaseUrl(config: string): string {
  const match = config.match(/^base_url = "([^"]+)"$/m);
  if (!match?.[1]) throw new Error("fixture provider base URL is missing");
  return match[1];
}

function processInput(): RunAgentInput {
  return {
    agentId: "spoofed-agent",
    runId: "run-process-failure",
    threadId: "thread-process-failure",
    messages: [],
    tools: [],
    context: [],
    state: {},
    forwardedProps: { openbotBotId: "codex" },
  } as unknown as RunAgentInput;
}

function researchProcessInput(): RunAgentInput {
  const agentId = process.env.RESEARCH_AGENT_ID?.trim() || "research-analyst";
  return {
    ...processInput(),
    agentId,
    tools: [
      {
        name: "mcp__artifacts__create_artifact",
        description: "Create a Markdown artifact.",
        parameters: { type: "object" },
      },
    ],
    forwardedProps: {
      openbotBotId: agentId,
      openbotDeploymentTools: ["mcp__artifacts__create_artifact"],
      openbotRun: "signed-run",
    },
  } as unknown as RunAgentInput;
}

function toolProcessInput(): RunAgentInput {
  return {
    ...processInput(),
    tools: [
      {
        name: "mcp__artifacts__create_artifact",
        description: "Create an artifact.",
        parameters: { type: "object" },
      },
    ],
    forwardedProps: {
      openbotBotId: "codex",
      openbotDeploymentTools: ["mcp__artifacts__create_artifact"],
      openbotRun: "signed-run",
    },
  } as unknown as RunAgentInput;
}

async function successfulArtifactCall() {
  return { text: '{"ok":true}', isError: false };
}

function fakeCodexProcess(
  options: {
    signals?: NodeJS.Signals[];
    exitOnSignal?: NodeJS.Signals;
    turnStatus?: string;
    requests?: Array<{
      method?: string;
      params?: Record<string, unknown>;
    }>;
  } = {},
) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill(signal?: NodeJS.Signals): boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    options.signals?.push(signal);
    if (!options.exitOnSignal || options.exitOnSignal === signal) {
      queueMicrotask(() => child.emit("exit", 0, signal));
    }
    return true;
  };
  queueMicrotask(() => child.emit("spawn"));
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk)) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    options.requests?.push(request);
    if (request.id === undefined) return;
    const result =
      request.method === "thread/start"
        ? { thread: { id: "codex-thread" } }
        : {};
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method === "turn/start") {
        child.stdout.write(
          `${JSON.stringify({
            method: "turn/completed",
            params: { turn: { status: options.turnStatus ?? "completed" } },
          })}\n`,
        );
      }
    });
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

function secretToolCodexProcess(privateKey: string, sensitiveArgs: boolean) {
  const child = fakeChildShell();
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk)) as {
      id?: number;
      method?: string;
    };
    if (request.id === undefined) return;
    if (request.id === 900) {
      queueMicrotask(() => {
        child.stdout.write(
          `${JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } })}\n`,
        );
      });
      return;
    }
    const result =
      request.method === "thread/start"
        ? { thread: { id: "codex-secret-thread" } }
        : {};
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method !== "turn/start") return;
      const split = Math.floor(privateKey.length / 2);
      for (const delta of [
        privateKey.slice(0, split),
        privateKey.slice(split),
      ]) {
        child.stdout.write(
          `${JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: "answer", delta } })}\n`,
        );
      }
      child.stdout.write(
        `${JSON.stringify({ method: "item/reasoning/summaryTextDelta", params: { itemId: "reasoning", summaryIndex: 0, delta: `reason ${privateKey}` } })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          id: 900,
          method: "item/tool/call",
          params: {
            callId: "tool-call",
            tool: "openbot__artifacts__create_artifact",
            arguments: sensitiveArgs
              ? { content: `unsafe ${privateKey}` }
              : { content: "safe" },
          },
        })}\n`,
      );
    });
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

function secretFailureCodexProcess(privateKey: string) {
  const child = fakeChildShell();
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk)) as {
      id?: number;
      method?: string;
    };
    if (request.id === undefined) return;
    const result =
      request.method === "thread/start"
        ? { thread: { id: "codex-secret-failure-thread" } }
        : {};
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method === "turn/start") {
        child.stdout.write(
          `${JSON.stringify({ method: "turn/completed", params: { turn: { status: "failed", error: `protocol echoed ${privateKey}` } } })}\n`,
        );
      }
    });
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

function stderrSecretFailureCodexProcess(chunks: string[]) {
  const child = fakeChildShell();
  child.stdin.once("data", () => {
    queueMicrotask(() => {
      for (const chunk of chunks) child.stderr.write(chunk);
      child.emit("exit", 17);
    });
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

function fakeChildShell() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill(signal?: NodeJS.Signals): boolean;
  };
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
  return child;
}

function researchFinalisationProcess(turnInputs: string[]) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill(signal?: NodeJS.Signals): boolean;
  };
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
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk)) as {
      id?: number;
      method?: string;
      params?: { input?: Array<{ text?: string }> };
    };
    if (request.id === undefined) return;
    const result =
      request.method === "thread/start"
        ? { thread: { id: "codex-research-thread" } }
        : {};
    queueMicrotask(() => {
      if (request.method === undefined && request.id === 900) {
        child.stdout.write(
          `${JSON.stringify({
            method: "item/agentMessage/delta",
            params: {
              itemId: "answer-2",
              delta:
                "## Результат\nПроверка завершена.\n\nФайл: `/research-runs/test/report.md`\n\n## Источники\n- API snapshot",
            },
          })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          })}\n`,
        );
        return;
      }
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method !== "turn/start") return;
      turnInputs.push(request.params?.input?.[0]?.text ?? "");
      const finalising = turnInputs.length > 1;
      if (finalising) {
        child.stdout.write(
          `${JSON.stringify({
            id: 900,
            method: "item/tool/call",
            params: {
              callId: "research-artifact",
              tool: "openbot__artifacts__create_artifact",
              arguments: {
                title: "Research report",
                filename: "report.md",
                mimeType: "text/markdown",
                content: "# Research report",
              },
            },
          })}\n`,
        );
        return;
      }
      child.stdout.write(
        `${JSON.stringify({
          method: "item/agentMessage/delta",
          params: {
            itemId: "answer-1",
            delta:
              "Теперь проверяю списки. Осталось оформить доказательства и финальную проверку.",
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          method: "turn/completed",
          params: { turn: { status: "completed" } },
        })}\n`,
      );
    });
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

function researchDeadlineProcess(
  methods: string[],
  turnInputs: string[],
  completeOnInterrupt = true,
) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill(signal?: NodeJS.Signals): boolean;
  };
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
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(String(chunk)) as {
      id?: number;
      method?: string;
      params?: { input?: Array<{ text?: string }> };
    };
    if (request.id === undefined) return;
    if (request.method) methods.push(request.method);
    queueMicrotask(() => {
      if (request.method === undefined && request.id === 901) {
        child.stdout.write(
          `${JSON.stringify({
            method: "item/agentMessage/delta",
            params: {
              itemId: "final-answer",
              delta:
                "## Результат\nПроверка завершена.\n\nФайл: `/research-runs/deadline/report.md`\n\n## Источники\n- API snapshot",
            },
          })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          })}\n`,
        );
        return;
      }
      if (request.method === "thread/start") {
        child.stdout.write(
          `${JSON.stringify({ id: request.id, result: { thread: { id: "deadline-thread" } } })}\n`,
        );
        return;
      }
      if (request.method === "turn/start") {
        turnInputs.push(request.params?.input?.[0]?.text ?? "");
        const finalising = turnInputs.length > 1;
        child.stdout.write(
          `${JSON.stringify({
            id: request.id,
            result: {
              turn: { id: finalising ? "final-turn" : "collection-turn" },
            },
          })}\n`,
        );
        if (!finalising) return;
        child.stdout.write(
          `${JSON.stringify({
            id: 901,
            method: "item/tool/call",
            params: {
              callId: "deadline-research-artifact",
              tool: "openbot__artifacts__create_artifact",
              arguments: {
                title: "Research report",
                filename: "report.md",
                mimeType: "text/markdown",
                content: "# Research report",
              },
            },
          })}\n`,
        );
        return;
      }
      child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      if (request.method === "turn/interrupt" && completeOnInterrupt) {
        child.stdout.write(
          `${JSON.stringify({
            method: "turn/completed",
            params: { turn: { status: "interrupted" } },
          })}\n`,
        );
      }
    });
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

function failingCodexProcess(kind: "error" | "exit") {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill(): boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  queueMicrotask(() => {
    if (kind === "error") {
      child.emit("error", new Error("early spawn failure"));
      return;
    }
    child.emit("spawn");
    queueMicrotask(() => child.emit("exit", 17));
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}
