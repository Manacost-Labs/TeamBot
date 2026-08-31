import { describe, expect, it } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { RunAgentInput } from "@ag-ui/core";
import {
  codexEnvironmentFor,
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
      ),
    ).toContain("progress");
    expect(
      researchFinalisationIssue("## Результат\nWin rate: 54%."),
    ).toBeNull();
  });

  it("does not mark an analyst update with promised follow-up work as complete", () => {
    expect(
      researchFinalisationIssue(
        [
          "Первый статистический срез доступен. Теперь проверяю конкретные списки карт и парные матчапы.",
          "Параллельно проверяю актуальные списки и независимые практические разборы.",
          "Осталось оформить доказательства, контраргументы и финальную проверку.",
        ].join("\n\n"),
      ),
    ).toContain("progress");
  });

  it("allows a bounded final result that describes completed verification", () => {
    expect(
      researchFinalisationIssue(
        "## Результат\nПроверка завершена: Pure Paladin имеет 54,6% побед.\n\n## Источники\n- API snapshot",
      ),
    ).toBeNull();
  });

  it("does not accept an HSReplay/HSGuru access failure without the first-party API", () => {
    expect(
      researchFinalisationIssue(
        "HSReplay и HSGuru не открылись, поэтому данных нет.",
      ),
    ).toContain("first-party API");
    expect(
      researchFinalisationIssue(
        "HSReplay HTML недоступен, но stats-api вернул dataset из api.kolodahearthstone.com.",
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
      ...processInput(),
      agentId: process.env.RESEARCH_AGENT_ID?.trim() || "research-analyst",
    } as RunAgentInput;

    await runCodex(input, emptyCallbacks, {
      spawn: () => researchFinalisationProcess(turnInputs),
    });

    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[1]).toContain("Finalise the research now");
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

    await runCodex(processInput(), emptyCallbacks, {
      spawn: () =>
        fakeCodexProcess({
          signals,
          exitOnSignal: "SIGKILL",
        }),
      processExitGraceMs: 5,
    });

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

const emptyCallbacks = {
  onText() {},
  onReasoning() {},
  onToolStart() {},
  onToolResult() {},
};

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

function fakeCodexProcess(
  options: { signals?: NodeJS.Signals[]; exitOnSignal?: NodeJS.Signals } = {},
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
    };
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
            params: { turn: { status: "completed" } },
          })}\n`,
        );
      }
    });
  });
  return child as unknown as ChildProcessWithoutNullStreams;
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
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method !== "turn/start") return;
      turnInputs.push(request.params?.input?.[0]?.text ?? "");
      const finalising = turnInputs.length > 1;
      child.stdout.write(
        `${JSON.stringify({
          method: "item/agentMessage/delta",
          params: {
            itemId: `answer-${turnInputs.length}`,
            delta: finalising
              ? "## Результат\nПроверка завершена.\n\n## Источники\n- API snapshot"
              : "Теперь проверяю списки. Осталось оформить доказательства и финальную проверку.",
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
