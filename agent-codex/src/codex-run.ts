import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import type { RunAgentInput } from "@ag-ui/core";
import { DataControlWorkflow } from "./data-control-workflow";
import type { AgentExecutionTiming } from "./execution-timing";
import {
  deploymentToolNames,
  instructionsFor,
  isDataControlRun,
  isHeartPulseControlRun,
  isResearchRun,
  isYoutubeAnalystRun,
  permissionProfileFor,
  runAssertion,
  transcriptFor,
} from "./history";
import type { PersonalProviderConnection } from "./provider-connection";
import {
  buildCodexChildEnvironment,
  type CodexRuntimeProfile,
  createCodexRuntimeProfile,
} from "./runtime-profile";
import { youtubeTranscriptContext } from "./youtube-transcript-context";

type JsonObject = Record<string, unknown>;
type Notification = {
  method?: string;
  params?: JsonObject;
  id?: number;
  result?: unknown;
  error?: unknown;
};

export type CodexCallbacks = {
  onText(delta: string, itemId: string): void;
  /** Official concise reasoning summary, never the model's private reasoning tokens. */
  onReasoning(delta: string, itemId: string, summaryIndex: number): void;
  onToolStart(callId: string, name: string, args: JsonObject): void;
  onToolResult(callId: string, result: string): void;
};

const TOOL_URL =
  process.env.OPENBOT_TOOL_URL ?? "http://openbot:3001/api/agent-tools/call";
const TOOL_TOKEN = process.env.AGENT_TOOL_TOKEN?.trim() ?? "";
const MODEL = process.env.CODEX_MODEL?.trim();
const REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT?.trim() || "low";
const REASONING_SUMMARY =
  process.env.CODEX_REASONING_SUMMARY?.trim() || "concise";
const PROCESS_EXIT_GRACE_MS = positiveMilliseconds(
  "CODEX_PROCESS_EXIT_GRACE_MS",
  5_000,
);
const REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const RESEARCH_MODEL = process.env.RESEARCH_MODEL?.trim() || "gpt-5.6-luna";
const RESEARCH_REASONING_EFFORT =
  process.env.RESEARCH_REASONING_EFFORT?.trim() || "xhigh";
const RESEARCH_COLLECTION_MAX_MS = positiveMilliseconds(
  "RESEARCH_COLLECTION_MAX_MS",
  8 * 60_000,
);
const RESEARCH_FINALISATION_MAX_MS = positiveMilliseconds(
  "RESEARCH_FINALISATION_MAX_MS",
  2 * 60_000,
);
const RESEARCH_INTERRUPT_GRACE_MS = positiveMilliseconds(
  "RESEARCH_INTERRUPT_GRACE_MS",
  15_000,
);

const RESEARCH_PROGRESS_MARKERS = [
  "начинаю исследование",
  "план зафиксирован",
  "первый проход",
  "сбор углублён",
  "итоговый проход",
  "starting research",
  "plan locked",
  "first pass",
  "deepened collection",
  "final pass",
];

const RESEARCH_PENDING_WORK_PATTERNS = [
  /(?:теперь|сейчас|далее|дальше|параллельно)\s+(?:я\s+)?(?:проверя|ищу|собира|сопоставля|анализиру|изуча|оформля|перехож)/,
  /(?:осталось|оста[её]тся|предстоит)\s+(?:ещ[её]\s+)?(?:проверить|оформить|собрать|сопоставить|подготовить|провести|добавить|завершить)/,
  /(?:продолжаю|продолжу)\s+(?:провер|исслед|собира|анализ|поиск|оформ)/,
  /(?:now|still|next|in parallel)\s+(?:i\s+(?:am|'m|will)\s+)?(?:check|research|collect|compare|analy[sz]|review|prepare|finali[sz])(?:e|ing)?/,
  /(?:i still need to|what remains is to|work remains to)\s+(?:check|research|collect|compare|analy[sz]e|review|prepare|finali[sz]e)/,
];

const RESEARCH_RESULT_HEADING =
  /(?:^|\n)##[ \t]+(?:результат|findings|result)[ \t]*(?:\n|$)/;
const RESEARCH_SOURCES_HEADING =
  /(?:^|\n)##[ \t]+(?:источники|sources)[ \t]*(?:\n|$)/;
const RESEARCH_REPORT_PATH = /\/research-runs\/[^\s`]+\/report\.md\b/;

const RESEARCH_API_ACCESS_MARKERS = [
  "stats-api",
  "api.kolodahearthstone.com",
  "first-party",
  "набор данных",
  "датасет",
  "dataset",
];

/**
 * Research progress is useful while a run is live, but it is not a deliverable on its own.
 * Returning a reason lets the run ask Codex for one bounded finalisation pass instead of showing a
 * polished status log as if it were an answer.
 */
export function researchFinalisationIssue(
  text: string,
  artifactCreated: boolean,
): string | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return "The research run ended without an assistant result.";
  }
  const progressMarkers = RESEARCH_PROGRESS_MARKERS.filter((marker) =>
    normalized.includes(marker),
  );
  const explicitlyHasPendingWork = RESEARCH_PENDING_WORK_PATTERNS.some(
    (pattern) => pattern.test(normalized),
  );

  const namesWebsite = /hsreplay|hsguru/.test(normalized);
  const saysWebsiteBlocked =
    /нет доступ|нет данных|не откр|не удалось|не отда[её]т|blocked|unavailable|could not access/.test(
      normalized,
    );
  const mentionsFirstPartyApi = RESEARCH_API_ACCESS_MARKERS.some((marker) =>
    normalized.includes(marker),
  );
  if (namesWebsite && saysWebsiteBlocked && !mentionsFirstPartyApi) {
    return "The previous response treated an inaccessible HSReplay/HSGuru page as if the first-party API data were unavailable.";
  }
  if (!RESEARCH_RESULT_HEADING.test(normalized)) {
    return progressMarkers.length >= 2 || explicitlyHasPendingWork
      ? "The previous response only described research progress and did not deliver a result."
      : "The research result is missing the required `## Результат` section.";
  }
  if (!RESEARCH_SOURCES_HEADING.test(normalized)) {
    return "The research result is missing the required `## Источники` section.";
  }
  if (!RESEARCH_REPORT_PATH.test(normalized)) {
    return "The research result does not include an exact `/research-runs/.../report.md` path.";
  }
  if (!artifactCreated) {
    return "The research run ended without the required downloadable Markdown artifact.";
  }
  return null;
}

const RESEARCH_FINALISATION_PROMPT =
  "Finalise the research now from the evidence and files already collected. The previous response was not a complete deliverable. Do not repeat the plan and do not start another broad collection pass. Make at most one narrowly necessary source call, then stop collecting. Ensure a validated `/research-runs/.../report.md` exists. Read that completed report and call the governed `create_artifact` tool exactly once with exactly four fields: `title`, a safe `filename` ending in `.md`, `mimeType` set to `text/markdown`, and the report as non-empty inline `content`; do not send `workspacePath` or extra fields. Then return a bounded Markdown answer with `## Результат`, verified findings or an explicit `Результат не получен` explanation, the exact report.md path, freshness/limitations, and `## Источники`. Finish this turn even when some sources remain blocked, and never print tool JSON.";

const YOUTUBE_ARTIFACT_FINALISATION_PROMPT =
  "Create the required deliverable now. Call the governed `create_artifact` tool exactly once with exactly four fields: `title`, a safe `filename` ending in `.md`, `mimeType` set to `text/markdown`, and the completed report as non-empty inline `content`. Do not send `workspacePath` or any extra field. Even when every transcript failed, create a Markdown status report with the original links and exact limitations. Do not print the report or tool JSON in chat.";

export function youtubeArtifactFinalisationIssue(
  artifactCreated: boolean,
): string | null {
  return artifactCreated
    ? null
    : "The YouTube run ended without the required Markdown artifact.";
}

const HEARTPULSE_WORKSPACE = "/workspace-heartpulse";
const RESEARCH_WORKSPACE = "/research-runs";
const YOUTUBE_WORKSPACE = "/youtube-workspace";

export function workspaceFor(input: RunAgentInput): string {
  if (isYoutubeAnalystRun(input)) return YOUTUBE_WORKSPACE;
  if (isResearchRun(input)) return RESEARCH_WORKSPACE;
  return isHeartPulseControlRun(input) ? HEARTPULSE_WORKSPACE : "/workspace";
}

export function modelFor(input: RunAgentInput): string | undefined {
  if (isResearchRun(input) && /^[A-Za-z0-9._:-]{1,120}$/.test(RESEARCH_MODEL)) {
    return RESEARCH_MODEL;
  }
  const forwarded = input.forwardedProps as
    | { openbotAgentModel?: unknown }
    | undefined;
  const override =
    typeof forwarded?.openbotAgentModel === "string"
      ? forwarded.openbotAgentModel.trim()
      : "";
  return /^[A-Za-z0-9._:-]{1,120}$/.test(override) ? override : MODEL;
}

export function reasoningEffortFor(input: RunAgentInput): string {
  if (
    isResearchRun(input) &&
    REASONING_EFFORTS.has(RESEARCH_REASONING_EFFORT)
  ) {
    return RESEARCH_REASONING_EFFORT;
  }
  const forwarded = input.forwardedProps as
    | { openbotAgentReasoningEffort?: unknown }
    | undefined;
  const override =
    typeof forwarded?.openbotAgentReasoningEffort === "string"
      ? forwarded.openbotAgentReasoningEffort.trim()
      : "";
  if (REASONING_EFFORTS.has(override)) return override;

  // Control agents use the affordable Luna model with the deeper effort needed for
  // parser/UI repairs. The model id and effort are independent Codex settings;
  // keeping this fallback here prevents the invalid `gpt-5.6-luna-xhigh` model name.
  if (
    (isDataControlRun(input) ||
      isHeartPulseControlRun(input) ||
      isYoutubeAnalystRun(input)) &&
    modelFor(input) === "gpt-5.6-luna"
  ) {
    return "xhigh";
  }

  return REASONING_EFFORT;
}

export async function runCodex(
  input: RunAgentInput,
  callbacks: CodexCallbacks,
  options: {
    timing?: AgentExecutionTiming;
    spawn?: (profile: CodexRuntimeProfile) => ChildProcessWithoutNullStreams;
    processExitGraceMs?: number;
    researchCollectionMaxMs?: number;
    researchFinalisationMaxMs?: number;
    researchInterruptGraceMs?: number;
    youtubeContext?: (input: RunAgentInput) => Promise<string>;
    deploymentToolCaller?: typeof callDeploymentTool;
    /** Redeemed once after admission; Task 20 selects the matching isolated child profile. */
    providerConnection?: PersonalProviderConnection;
  } = {},
): Promise<void> {
  const youtubeContext = isYoutubeAnalystRun(input)
    ? await (options.youtubeContext ?? youtubeTranscriptContext)(input)
    : "";
  const profile = await createCodexRuntimeProfile({
    environment: process.env,
    additionalEnvironmentKeys: additionalEnvironmentKeysFor(input),
  });
  let client: CodexProcess | undefined;
  try {
    client = new CodexProcess(
      input,
      callbacks,
      options.timing,
      () =>
        options.spawn
          ? options.spawn(profile)
          : spawnCodexProcess(input, profile),
      options.processExitGraceMs,
      options.researchCollectionMaxMs ?? RESEARCH_COLLECTION_MAX_MS,
      options.researchFinalisationMaxMs ?? RESEARCH_FINALISATION_MAX_MS,
      options.researchInterruptGraceMs ?? RESEARCH_INTERRUPT_GRACE_MS,
      youtubeContext,
      options.deploymentToolCaller,
    );
    await client.run();
  } finally {
    try {
      await client?.close();
    } finally {
      await profile.dispose();
    }
  }
}

class CodexProcess {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private readonly finished: Promise<void>;
  private readonly stopped: Promise<void>;
  private finish!: () => void;
  private fail!: (error: Error) => void;
  private markStopped!: () => void;
  private stoppedObserved = false;
  private nextId = 1;
  private turnCompleted = false;
  private terminalFailure: Error | undefined;
  private stderr = "";
  private readonly protocolTrace: string[] = [];
  private readonly toolNames = new Map<string, string>();
  private readonly dataControlWorkflow: DataControlWorkflow | undefined;
  private threadId: string | undefined;
  private correctionTurns = 0;
  private researchCorrectionTurns = 0;
  private researchText = "";
  private researchArtifactCreated = false;
  private youtubeArtifactCreated = false;
  private youtubeArtifactCorrectionTurns = 0;
  private researchDeadline: ReturnType<typeof setTimeout> | undefined;
  private researchInterruptDeadline: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly input: RunAgentInput,
    private readonly callbacks: CodexCallbacks,
    private readonly timing?: AgentExecutionTiming,
    spawnProcess: () => ChildProcessWithoutNullStreams,
    private readonly processExitGraceMs = PROCESS_EXIT_GRACE_MS,
    private readonly researchCollectionMaxMs = RESEARCH_COLLECTION_MAX_MS,
    private readonly researchFinalisationMaxMs = RESEARCH_FINALISATION_MAX_MS,
    private readonly researchInterruptGraceMs = RESEARCH_INTERRUPT_GRACE_MS,
    private readonly youtubeContext = "",
    private readonly deploymentToolCaller = callDeploymentTool,
  ) {
    this.dataControlWorkflow = isDataControlRun(input)
      ? new DataControlWorkflow()
      : undefined;
    this.finished = new Promise<void>((resolve, reject) => {
      this.finish = resolve;
      this.fail = reject;
    });
    // A process can fail while run() is still awaiting an earlier JSON-RPC response.
    // Keep the terminal promise observed until run() reaches it.
    void this.finished.catch(() => undefined);
    this.stopped = new Promise<void>((resolve) => {
      this.markStopped = () => {
        if (this.stoppedObserved) return;
        this.stoppedObserved = true;
        resolve();
      };
    });
    this.process = spawnProcess();
    this.process.once("spawn", () =>
      this.timing?.record("child_process_spawned"),
    );
    readline
      .createInterface({ input: this.process.stdout })
      .on("line", (line) => this.onLine(line));
    this.process.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-4000);
    });
    this.process.once("error", (error) => {
      if (this.process.pid === undefined) this.markStopped();
      this.failRun(error);
    });
    this.process.once("exit", (code) => {
      this.markStopped();
      if (!this.turnCompleted) {
        const trace =
          this.protocolTrace.length > 0
            ? ` Protocol: ${this.protocolTrace.join(" -> ")}`
            : "";
        this.failRun(
          new Error(
            `Codex app-server stopped with code ${code ?? "unknown"}.${trace} ${this.stderr}`.trim(),
          ),
        );
      }
    });
    this.process.once("close", this.markStopped);
  }

  async run(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "openbot", title: "OpenBot", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.timing?.record("codex_initialized");
    this.notify("initialized", {});

    const dynamicTools = this.input.tools
      .filter((tool) => deploymentToolNames(this.input).has(tool.name))
      .map((tool) => {
        const name = codexToolName(tool.name);
        this.toolNames.set(name, tool.name);
        return {
          type: "function",
          name,
          description: tool.description,
          inputSchema: tool.parameters,
        };
      });
    const started = (await this.request("thread/start", {
      ...(modelFor(this.input) ? { model: modelFor(this.input) } : {}),
      cwd: workspaceFor(this.input),
      approvalPolicy: "never",
      permissions: permissionProfileFor(this.input),
      baseInstructions: instructionsFor(this.input),
      ephemeral: true,
      serviceName: "openbot_codex",
      dynamicTools,
    })) as { thread?: { id?: string } };
    const threadId = started.thread?.id;
    if (!threadId) throw new Error("Codex did not return a thread id.");
    this.threadId = threadId;
    this.timing?.record("codex_thread_started");

    const turn = (await this.request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: turnInputFor(this.input, this.youtubeContext),
        },
      ],
      effort: reasoningEffortFor(this.input),
      summary: REASONING_SUMMARY,
    })) as { turn?: { id?: string } };
    this.armResearchDeadline(turn.turn?.id);
    this.timing?.record("codex_turn_started");
    await this.finished;
  }

  async close(): Promise<void> {
    this.clearResearchDeadline();
    if (this.stoppedObserved) return;
    this.signal("SIGTERM");
    if (await this.waitForStop(this.processExitGraceMs)) return;
    this.signal("SIGKILL");
    // Keep the admission slot until the operating system confirms that the process is gone.
    await this.stopped;
  }

  private signal(signal: NodeJS.Signals): void {
    if (this.stoppedObserved) return;
    try {
      this.process.kill(signal);
    } catch (error) {
      if (this.process.pid === undefined) {
        this.markStopped();
        return;
      }
      throw error;
    }
  }

  private async waitForStop(timeoutMs: number): Promise<boolean> {
    if (this.stoppedObserved) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.stopped.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { resolve, reject }),
    );
    this.write({ method, id, params });
    return response;
  }

  private notify(method: string, params: JsonObject): void {
    this.write({ method, params });
  }

  private write(message: unknown): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failRun(error: Error): void {
    if (this.terminalFailure) return;
    this.clearResearchDeadline();
    this.terminalFailure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.fail(error);
  }

  private onLine(line: string): void {
    let message: Notification;
    try {
      message = JSON.parse(line) as Notification;
    } catch {
      return;
    }
    this.recordProtocol(message);
    if (
      typeof message.id === "number" &&
      ("result" in message || "error" in message)
    ) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.method === "item/tool/call" && typeof message.id === "number") {
      void this.handleToolCall(message.id, message.params ?? {});
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const delta = message.params?.delta;
      const itemId = message.params?.itemId;
      if (typeof delta === "string" && typeof itemId === "string") {
        if (isResearchRun(this.input)) {
          this.researchText = `${this.researchText}${delta}`.slice(-24_000);
        }
        this.callbacks.onText(delta, itemId);
      }
      return;
    }
    if (message.method === "item/reasoning/summaryTextDelta") {
      const delta = message.params?.delta;
      const itemId = message.params?.itemId;
      const summaryIndex = message.params?.summaryIndex;
      if (
        typeof delta === "string" &&
        typeof itemId === "string" &&
        typeof summaryIndex === "number"
      ) {
        this.callbacks.onReasoning(delta, itemId, summaryIndex);
      }
      return;
    }
    if (message.method === "turn/completed") {
      this.clearResearchDeadline();
      const turn = message.params?.turn as
        | { status?: string; error?: unknown }
        | undefined;
      if (turn?.status === "failed")
        this.failRun(
          new Error(JSON.stringify(turn.error ?? "Codex turn failed.")),
        );
      else {
        const correction = this.dataControlWorkflow?.correctionMessage();
        if (correction && this.correctionTurns < 2) {
          this.correctionTurns += 1;
          void this.request("turn/start", {
            threadId: this.threadId,
            input: [{ type: "text", text: correction }],
            effort: reasoningEffortFor(this.input),
            summary: REASONING_SUMMARY,
          }).catch((error) => this.failRun(error));
        } else if (correction) {
          this.failRun(
            new Error(
              `Контроль данных did not complete required repairs for: ${this.dataControlWorkflow?.unresolvedSourceIds().join(", ")}`,
            ),
          );
        } else {
          const researchIssue = isResearchRun(this.input)
            ? researchFinalisationIssue(
                this.researchText,
                this.researchArtifactCreated,
              )
            : null;
          if (researchIssue && this.researchCorrectionTurns < 1) {
            this.researchCorrectionTurns += 1;
            // Validate only the bounded correction turn. The progress text from the interrupted
            // collection pass is still streamed to the conversation, but must not poison (or
            // accidentally satisfy) the final deliverable contract.
            this.researchText = "";
            void this.request("turn/start", {
              threadId: this.threadId,
              input: [{ type: "text", text: RESEARCH_FINALISATION_PROMPT }],
              effort: reasoningEffortFor(this.input),
              summary: REASONING_SUMMARY,
            })
              .then((result) => {
                const turn = result as { turn?: { id?: string } };
                this.armResearchFinalisationDeadline(turn.turn?.id);
              })
              .catch((error) => this.failRun(error));
            return;
          }
          if (researchIssue) {
            this.failRun(
              new Error(`${researchIssue} The run was not marked complete.`),
            );
            return;
          }
          const youtubeIssue = isYoutubeAnalystRun(this.input)
            ? youtubeArtifactFinalisationIssue(this.youtubeArtifactCreated)
            : null;
          if (youtubeIssue && this.youtubeArtifactCorrectionTurns < 1) {
            this.youtubeArtifactCorrectionTurns += 1;
            void this.request("turn/start", {
              threadId: this.threadId,
              input: [
                { type: "text", text: YOUTUBE_ARTIFACT_FINALISATION_PROMPT },
              ],
              effort: reasoningEffortFor(this.input),
              summary: REASONING_SUMMARY,
            }).catch((error) => this.failRun(error));
            return;
          }
          if (youtubeIssue) {
            this.failRun(
              new Error(`${youtubeIssue} The run was not marked complete.`),
            );
            return;
          }
          this.turnCompleted = true;
          this.finish();
        }
      }
      return;
    }
    if (message.method === "error") {
      if (message.params?.willRetry === true) return;
      this.failRun(new Error(JSON.stringify(message.params ?? "Codex error.")));
    }
  }

  private armResearchDeadline(turnId: string | undefined): void {
    if (!isResearchRun(this.input) || !turnId) return;
    this.clearResearchDeadline();
    this.researchDeadline = setTimeout(() => {
      if (this.terminalFailure || this.turnCompleted || !this.threadId) return;
      void this.request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text: RESEARCH_FINALISATION_PROMPT }],
      }).catch(() => undefined);
      this.armResearchFinalisationDeadline(turnId);
    }, this.researchCollectionMaxMs);
  }

  private armResearchFinalisationDeadline(turnId: string | undefined): void {
    if (!isResearchRun(this.input) || !turnId) return;
    if (this.researchDeadline) clearTimeout(this.researchDeadline);
    this.researchDeadline = setTimeout(() => {
      if (this.terminalFailure || this.turnCompleted || !this.threadId) return;
      void this.request("turn/interrupt", {
        threadId: this.threadId,
        turnId,
      }).catch(() => undefined);
      this.researchInterruptDeadline = setTimeout(() => {
        if (this.terminalFailure || this.turnCompleted) return;
        this.failRun(
          new Error(
            "The research run did not stop after its bounded finalisation deadline. The run was not marked complete.",
          ),
        );
      }, this.researchInterruptGraceMs);
    }, this.researchFinalisationMaxMs);
  }

  private clearResearchDeadline(): void {
    if (this.researchDeadline) {
      clearTimeout(this.researchDeadline);
      this.researchDeadline = undefined;
    }
    if (this.researchInterruptDeadline) {
      clearTimeout(this.researchInterruptDeadline);
      this.researchInterruptDeadline = undefined;
    }
  }

  private recordProtocol(message: Notification): void {
    let entry =
      typeof message.method === "string"
        ? message.method
        : `response:${message.id ?? "?"}`;
    if (message.error !== undefined)
      entry = `${entry}:error=${safeDiagnostic(message.error)}`;
    if (message.method === "error")
      entry = `${entry}:${safeDiagnostic(message.params)}`;
    if (message.method === "turn/completed") {
      const turn = message.params?.turn as
        | { status?: unknown; error?: unknown }
        | undefined;
      entry = `${entry}:status=${String(turn?.status ?? "unknown")}`;
      if (turn?.error !== undefined)
        entry = `${entry}:error=${safeDiagnostic(turn.error)}`;
    }
    this.protocolTrace.push(entry.slice(0, 800));
    if (this.protocolTrace.length > 24) this.protocolTrace.shift();
  }

  private async handleToolCall(id: number, params: JsonObject): Promise<void> {
    const callId =
      typeof params.callId === "string" ? params.callId : `call_${id}`;
    const wireName = typeof params.tool === "string" ? params.tool : "unknown";
    const { deploymentName, eventName } = toolCallNames(
      wireName,
      this.toolNames,
    );
    const args = isObject(params.arguments) ? params.arguments : {};
    /*
     * Report the same safe name Codex was offered. Turning it back into `mcp__...` in the AG-UI
     * event made CopilotKit reject the event because that namespace is reserved, so opening a
     * conversation replayed a run error instead of restoring it. The deployment call still needs
     * the original governed name, which is kept separately above.
     */
    this.callbacks.onToolStart(callId, eventName, args);
    const duplicateDeliverableArtifact =
      deploymentName === "mcp__artifacts__create_artifact" &&
      ((isYoutubeAnalystRun(this.input) && this.youtubeArtifactCreated) ||
        (isResearchRun(this.input) && this.researchArtifactCreated));
    const result = duplicateDeliverableArtifact
      ? {
          text: "Refused. This run already created its one allowed deliverable artifact.",
          isError: true,
        }
      : await this.deploymentToolCaller(this.input, deploymentName, args);
    if (
      isResearchRun(this.input) &&
      deploymentName === "mcp__artifacts__create_artifact" &&
      !result.isError
    ) {
      this.researchArtifactCreated = true;
    }
    if (
      isYoutubeAnalystRun(this.input) &&
      deploymentName === "mcp__artifacts__create_artifact" &&
      !result.isError
    ) {
      this.youtubeArtifactCreated = true;
    }
    this.dataControlWorkflow?.recordToolResult(
      deploymentName,
      args,
      result.text,
    );
    this.callbacks.onToolResult(callId, result.text);
    this.write({
      id,
      result: {
        contentItems: [{ type: "inputText", text: result.text }],
        success: !result.isError,
      },
    });
  }
}

function spawnCodexProcess(
  input: RunAgentInput,
  profile: CodexRuntimeProfile,
): ChildProcessWithoutNullStreams {
  return spawn("codex", ["app-server"], {
    cwd: workspaceFor(input),
    env: profile.environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function turnInputFor(
  input: RunAgentInput,
  youtubeContext = "",
): string {
  return [transcriptFor(input), youtubeContext].filter(Boolean).join("\n\n");
}

export function codexEnvironmentFor(
  input: RunAgentInput,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return buildCodexChildEnvironment(environment, {
    additionalEnvironmentKeys: additionalEnvironmentKeysFor(input),
  });
}

function additionalEnvironmentKeysFor(input: RunAgentInput): readonly string[] {
  return isResearchRun(input)
    ? ["RESEARCH_SOURCES_URL", "RESEARCH_SOURCE_GATEWAY_TOKEN"]
    : [];
}

async function callDeploymentTool(
  input: RunAgentInput,
  name: string,
  args: JsonObject,
): Promise<{ text: string; isError: boolean }> {
  if (!deploymentToolNames(input).has(name))
    return {
      text: "Refused. This tool is not governed by this OpenBot deployment.",
      isError: true,
    };
  if (!TOOL_TOKEN)
    return {
      text: "Refused. The Codex adapter has no deployment tool credential.",
      isError: true,
    };
  const run = runAssertion(input);
  if (!run)
    return {
      text: "Refused. This run has no signed OpenBot assertion.",
      isError: true,
    };

  try {
    const response = await fetch(TOOL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": TOOL_TOKEN,
      },
      body: JSON.stringify({ name, args, run }),
    });
    const body = (await response.json()) as {
      text?: string;
      isError?: boolean;
    };
    return {
      text:
        body.text ??
        `The tool returned HTTP ${response.status} without a result.`,
      isError: !response.ok || body.isError !== false,
    };
  } catch (error) {
    return {
      text: `The tool could not be called: ${error instanceof Error ? error.message : "unknown error"}`,
      isError: true,
    };
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeDiagnostic(value: unknown): string {
  return JSON.stringify(value)?.slice(0, 600) ?? String(value).slice(0, 600);
}

function positiveMilliseconds(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function codexToolName(name: string): string {
  return name.startsWith("mcp__")
    ? `openbot__${name.slice("mcp__".length)}`
    : name;
}

export function toolCallNames(
  wireName: string,
  deploymentNames: ReadonlyMap<string, string>,
): { deploymentName: string; eventName: string } {
  return {
    deploymentName: deploymentNames.get(wireName) ?? wireName,
    eventName: wireName,
  };
}
