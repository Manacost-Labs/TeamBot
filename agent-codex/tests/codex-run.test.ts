import { describe, expect, it } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { RunAgentInput } from "@ag-ui/core";
import { ARTIFACT_RESULT_SCHEMA } from "../../shared/artifact-contract";
import {
  codexEnvironmentFor,
  codexProcessEnvironment,
  codexToolName,
  isValidMarkdownArtifactResult,
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

const CHATGPT_LEASE = "8f1dd4f8-5311-48c2-ac71-7ae00ee69a63";
const CHATGPT_RUN = "signed-chatgpt-run-assertion";
const CHATGPT_AUTH = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "initial-chatgpt-access-canary",
    refresh_token: "initial-chatgpt-refresh-canary",
    id_token: "initial-chatgpt-id-canary",
  },
});
const REFRESHED_CHATGPT_AUTH = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "refreshed-chatgpt-access-canary",
    refresh_token: "refreshed-chatgpt-refresh-canary",
    id_token: "refreshed-chatgpt-id-canary",
  },
});

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

  it("accepts only the canonical Markdown artifact result", () => {
    const result = JSON.stringify({
      schema: ARTIFACT_RESULT_SCHEMA,
      artifact: {
        attachmentId: "69bb8eb0-1ac8-4c67-aeca-2362e2f507cd",
        filename: "report.md",
        mimeType: "text/markdown",
        size: 42,
        title: "Report",
      },
    });
    expect(
      isValidMarkdownArtifactResult("mcp__artifacts__create_artifact", result),
    ).toBe(true);
    expect(
      isValidMarkdownArtifactResult(
        "mcp__artifacts__create_artifact",
        JSON.stringify({ ok: true }),
      ),
    ).toBe(false);
    expect(
      isValidMarkdownArtifactResult(
        "mcp__artifacts__create_artifact",
        JSON.stringify({
          schema: ARTIFACT_RESULT_SCHEMA,
          artifact: {
            attachmentId: "69bb8eb0-1ac8-4c67-aeca-2362e2f507cd",
            filename: "report.txt",
            mimeType: "text/plain",
            size: 42,
            title: "Report",
          },
        }),
      ),
    ).toBe(false);
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

  it("does not start a host fallback for a malformed ChatGPT context", async () => {
    let spawned = false;
    await expect(
      runCodex(processInput(), emptyCallbacks, {
        providerConnection: { provider: "chatgpt", authDocument: "{}" },
        spawn: () => {
          spawned = true;
          return fakeCodexProcess();
        },
      }),
    ).rejects.toThrow("Reconnect ChatGPT in Settings");
    expect(spawned).toBe(false);
  });

  it("runs ChatGPT in its private profile and uploads a changed valid document only after forced child exit", async () => {
    const signals: NodeJS.Signals[] = [];
    let codexHome = "";
    let refreshed: string | undefined;
    let refreshReference: unknown;
    const input = chatGptProcessInput();

    await runCodex(input, emptyCallbacks, {
      providerConnection: { provider: "chatgpt", authDocument: CHATGPT_AUTH },
      providerConnectionReference: {
        lease: CHATGPT_LEASE,
        run: CHATGPT_RUN,
      },
      refreshProviderConnection: async (reference, authDocument) => {
        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(existsSync(codexHome)).toBe(true);
        refreshReference = reference;
        refreshed = authDocument;
      },
      environment: {
        PATH: process.env.PATH,
        CODEX_HOME: "/host/.codex",
        CODEX_AUTH_PATH: "/host/.codex/auth.json",
        OPENAI_API_KEY: "host-fallback-secret",
      },
      spawn: (profile) => {
        codexHome = profile.codexHome;
        expect(profile.environment.CODEX_HOME).toBe(codexHome);
        expect(profile.environment.CODEX_AUTH_PATH).toBeUndefined();
        expect(profile.environment.OPENAI_API_KEY).toBeUndefined();
        expect(readFileSync(`${codexHome}/auth.json`, "utf8")).toBe(
          CHATGPT_AUTH,
        );
        writeFileSync(`${codexHome}/auth.json`, REFRESHED_CHATGPT_AUTH, {
          mode: 0o600,
        });
        return fakeCodexProcess({ signals, exitOnSignal: "SIGKILL" });
      },
      processExitGraceMs: 5,
    });

    expect(refreshReference).toEqual({
      lease: CHATGPT_LEASE,
      run: CHATGPT_RUN,
    });
    expect(refreshed).toBe(REFRESHED_CHATGPT_AUTH);
    expect(codexHome).not.toBe("");
    await expect(access(codexHome)).rejects.toThrow();
  });

  it("does not upload an unchanged ChatGPT document", async () => {
    let refreshCalls = 0;
    await runCodex(chatGptProcessInput(), emptyCallbacks, {
      providerConnection: { provider: "chatgpt", authDocument: CHATGPT_AUTH },
      providerConnectionReference: {
        lease: CHATGPT_LEASE,
        run: CHATGPT_RUN,
      },
      refreshProviderConnection: async () => {
        refreshCalls += 1;
      },
      spawn: fakeCodexProcess,
    });
    expect(refreshCalls).toBe(0);
  });

  it("redacts ChatGPT auth values from streamed events and refuses them in tool arguments", async () => {
    const observed: unknown[] = [];
    let deploymentCalls = 0;
    await runCodex(
      {
        ...toolProcessInput(),
        forwardedProps: {
          ...(toolProcessInput().forwardedProps as Record<string, unknown>),
          openbotCredentialLease: CHATGPT_LEASE,
          openbotRun: CHATGPT_RUN,
        },
      },
      {
        onText(delta, itemId) {
          observed.push({ delta, itemId });
        },
        onReasoning(delta, itemId, summaryIndex) {
          observed.push({ delta, itemId, summaryIndex });
        },
        onToolStart(callId, name, args) {
          observed.push({ callId, name, args });
        },
        onToolResult(callId, result) {
          observed.push({ callId, result });
        },
      },
      {
        providerConnection: {
          provider: "chatgpt",
          authDocument: CHATGPT_AUTH,
        },
        providerConnectionReference: {
          lease: CHATGPT_LEASE,
          run: CHATGPT_RUN,
        },
        refreshProviderConnection: async () => undefined,
        spawn: () =>
          secretToolCodexProcess("initial-chatgpt-access-canary", true),
        deploymentToolCaller: async () => {
          deploymentCalls += 1;
          return { text: "unexpected", isError: false };
        },
      },
    );

    const publicEvents = JSON.stringify(observed);
    expect(publicEvents).not.toContain("initial-chatgpt-access-canary");
    expect(publicEvents).not.toContain("initial-chatgpt-refresh-canary");
    expect(publicEvents).toContain("[redacted]");
    expect(publicEvents).toContain("Provider credentials cannot be passed");
    expect(deploymentCalls).toBe(0);
  });

  it("redacts a near-limit ChatGPT document split across stream chunks in linear time", async () => {
    const accessToken = "near-limit-chatgpt-access-canary";
    const refreshToken = "near-limit-chatgpt-refresh-canary";
    const authDocument = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
      },
      private_metadata: `near-limit-private-${"x".repeat(240 * 1_024)}`,
    });
    const observed: unknown[] = [];

    await runCodex(
      toolProcessInput(),
      {
        onText(delta, itemId) {
          observed.push({ delta, itemId });
        },
        onReasoning(delta, itemId, summaryIndex) {
          observed.push({ delta, itemId, summaryIndex });
        },
        onToolStart(callId, name, args) {
          observed.push({ callId, name, args });
        },
        onToolResult(callId, result) {
          observed.push({ callId, result });
        },
      },
      {
        providerConnection: { provider: "chatgpt", authDocument },
        providerConnectionReference: {
          lease: CHATGPT_LEASE,
          run: CHATGPT_RUN,
        },
        refreshProviderConnection: async () => undefined,
        spawn: () => secretToolCodexProcess(authDocument, false),
        deploymentToolCaller: async () => ({
          text: '{"ok":true}',
          isError: false,
        }),
      },
    );

    const publicEvents = JSON.stringify(observed);
    expect(publicEvents).toContain("[redacted]");
    expect(publicEvents).not.toContain(accessToken);
    expect(publicEvents).not.toContain(refreshToken);
    expect(publicEvents).not.toContain("near-limit-private-");
    expect(publicEvents.length).toBeLessThan(2_000);
  }, 5_000);

  it("keeps ChatGPT redaction linear across thousands of one-character deltas", async () => {
    const authDocument = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "many-delta-access-token",
        refresh_token: "many-delta-refresh-token",
      },
      private_metadata: `many-delta-private-${"y".repeat(24 * 1_024)}`,
    });
    const observed: string[] = [];

    await runCodex(
      toolProcessInput(),
      {
        onText(delta) {
          observed.push(delta);
        },
        onReasoning(delta) {
          observed.push(delta);
        },
        onToolStart() {},
        onToolResult() {},
      },
      {
        providerConnection: { provider: "chatgpt", authDocument },
        providerConnectionReference: {
          lease: CHATGPT_LEASE,
          run: CHATGPT_RUN,
        },
        refreshProviderConnection: async () => undefined,
        spawn: () => secretToolCodexProcess(authDocument, false, 1),
        deploymentToolCaller: async () => ({
          text: '{"ok":true}',
          isError: false,
        }),
      },
    );

    const publicText = observed.join("");
    expect(publicText).toContain("[redacted]");
    expect(publicText).not.toContain("many-delta-access-token");
    expect(publicText).not.toContain("many-delta-refresh-token");
    expect(publicText).not.toContain("many-delta-private-");
    expect(publicText.length).toBeLessThan(500);
  }, 5_000);

  it("never emits overlapping ChatGPT secrets across callback boundaries", async () => {
    const authDocument = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "aa", refresh_token: "ab" },
    });
    const observed: string[] = [];

    await runCodex(
      toolProcessInput(),
      {
        onText(delta) {
          observed.push(delta);
        },
        onReasoning(delta) {
          observed.push(delta);
        },
        onToolStart() {},
        onToolResult() {},
      },
      {
        providerConnection: { provider: "chatgpt", authDocument },
        providerConnectionReference: {
          lease: CHATGPT_LEASE,
          run: CHATGPT_RUN,
        },
        refreshProviderConnection: async () => undefined,
        // The first match ends at the boundary while the second secret still holds a shared
        // prefix. This is the exact ordering that previously emitted "aa" in separate callbacks.
        spawn: () => secretToolCodexProcess("aaa", false, 2),
        deploymentToolCaller: async () => ({
          text: '{"ok":true}',
          isError: false,
        }),
      },
    );

    const publicText = observed.join("");
    expect(publicText).toContain("[redacted]");
    expect(publicText).not.toContain("aa");
    expect(publicText).not.toContain("ab");
  });

  it("cleans the stopped child profile and emits only Settings guidance when refresh is refused", async () => {
    let codexHome = "";
    let thrown: unknown;
    try {
      await runCodex(chatGptProcessInput(), emptyCallbacks, {
        providerConnection: {
          provider: "chatgpt",
          authDocument: CHATGPT_AUTH,
        },
        providerConnectionReference: {
          lease: CHATGPT_LEASE,
          run: CHATGPT_RUN,
        },
        refreshProviderConnection: async () => {
          throw new Error(
            `server echoed ${REFRESHED_CHATGPT_AUTH} initial-chatgpt-access-canary`,
          );
        },
        spawn: (profile) => {
          codexHome = profile.codexHome;
          writeFileSync(
            `${profile.codexHome}/auth.json`,
            REFRESHED_CHATGPT_AUTH,
            { mode: 0o600 },
          );
          return fakeCodexProcess();
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("Settings");
    expect(String(thrown)).not.toContain("chatgpt-access-canary");
    expect(String(thrown)).not.toContain("chatgpt-refresh-canary");
    await expect(access(codexHome)).rejects.toThrow();
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
      spawn: () => artifactFinalisationProcess(turnInputs),
      deploymentToolCaller: successfulArtifactCall,
    });

    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[1]).toContain("Finalise the research now");
  });

  it("does not finish research when the artifact gateway returns an unverified success", async () => {
    const turnInputs: string[] = [];

    await expect(
      runCodex(researchProcessInput(), emptyCallbacks, {
        spawn: () => artifactFinalisationProcess(turnInputs),
        deploymentToolCaller: async () => ({
          text: JSON.stringify({ ok: true }),
          isError: false,
        }),
      }),
    ).rejects.toThrow("artifact");

    expect(turnInputs).toHaveLength(2);
  });

  it("does not finish research for a non-Markdown artifact", async () => {
    const turnInputs: string[] = [];

    await expect(
      runCodex(researchProcessInput(), emptyCallbacks, {
        spawn: () => artifactFinalisationProcess(turnInputs),
        deploymentToolCaller: async () => ({
          text: JSON.stringify({
            ...VALID_MARKDOWN_ARTIFACT,
            artifact: {
              ...VALID_MARKDOWN_ARTIFACT.artifact,
              filename: "report.txt",
              mimeType: "text/plain",
            },
          }),
          isError: false,
        }),
      }),
    ).rejects.toThrow("artifact");

    expect(turnInputs).toHaveLength(2);
  });

  it("fails a YouTube run after the bounded correction turn creates no artifact", async () => {
    const turnInputs: string[] = [];

    await expect(
      runCodex(youtubeProcessInput(), emptyCallbacks, {
        spawn: () => artifactFinalisationProcess(turnInputs, false),
      }),
    ).rejects.toThrow("required Markdown artifact");

    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[1]).toContain("Create the required deliverable now");
  });

  it("does not finish a YouTube run for an unverified artifact result", async () => {
    const turnInputs: string[] = [];

    await expect(
      runCodex(youtubeProcessInput(), emptyCallbacks, {
        spawn: () => artifactFinalisationProcess(turnInputs),
        deploymentToolCaller: async () => ({
          text: JSON.stringify({ ok: true }),
          isError: false,
        }),
      }),
    ).rejects.toThrow("required Markdown artifact");

    expect(turnInputs).toHaveLength(2);
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

function chatGptProcessInput(): RunAgentInput {
  return {
    ...processInput(),
    forwardedProps: {
      openbotBotId: "codex",
      openbotCredentialLease: CHATGPT_LEASE,
      openbotRun: CHATGPT_RUN,
    },
  } as RunAgentInput;
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

function youtubeProcessInput(): RunAgentInput {
  const agentId =
    process.env.YOUTUBE_ANALYST_AGENT_ID?.trim() || "youtube-analyst";
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

const VALID_MARKDOWN_ARTIFACT = {
  schema: ARTIFACT_RESULT_SCHEMA,
  artifact: {
    attachmentId: "69bb8eb0-1ac8-4c67-aeca-2362e2f507cd",
    filename: "report.md",
    mimeType: "text/markdown",
    size: 42,
    title: "Research report",
  },
};

async function successfulArtifactCall() {
  return { text: JSON.stringify(VALID_MARKDOWN_ARTIFACT), isError: false };
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

function secretToolCodexProcess(
  privateKey: string,
  sensitiveArgs: boolean,
  textChunkSize?: number,
) {
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
      const split =
        textChunkSize ?? Math.max(1, Math.floor(privateKey.length / 2));
      for (let offset = 0; offset < privateKey.length; offset += split) {
        const delta = privateKey.slice(offset, offset + split);
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

function artifactFinalisationProcess(
  turnInputs: string[],
  createArtifact = true,
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
      if (finalising && createArtifact) {
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
