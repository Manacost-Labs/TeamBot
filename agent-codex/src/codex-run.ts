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
import {
  createOpenRouterCredentialBroker,
  type OpenRouterCredentialBroker,
} from "./openrouter-credential-broker";
import type { PersonalProviderConnection } from "./provider-connection";
import {
  buildCodexChildEnvironment,
  type CodexRuntimeProfile,
  createCodexRuntimeProfile,
  createOpenRouterRuntimeProfile,
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
const MODEL_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const OPENROUTER_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const ISOLATED_CODEX_BINARY =
  "/opt/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
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
  if (isResearchRun(input) && MODEL_ID.test(RESEARCH_MODEL)) {
    return RESEARCH_MODEL;
  }
  const forwarded = input.forwardedProps as
    | { openbotAgentModel?: unknown }
    | undefined;
  const override =
    typeof forwarded?.openbotAgentModel === "string"
      ? forwarded.openbotAgentModel.trim()
      : "";
  return MODEL_ID.test(override) ? override : MODEL;
}

export function reasoningEffortFor(
  input: RunAgentInput,
  selectedModel = modelFor(input),
): string {
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
    selectedModel === "gpt-5.6-luna"
  ) {
    return "xhigh";
  }

  return REASONING_EFFORT;
}

function openRouterModel(environment: NodeJS.ProcessEnv): string {
  const model = environment.OPENROUTER_MODEL?.trim() ?? "";
  if (!OPENROUTER_MODEL_ID.test(model)) {
    throw new Error("OpenRouter model configuration is invalid.");
  }
  return model;
}

function redactProviderError(
  error: unknown,
  providerConnection: PersonalProviderConnection | undefined,
  additionalSensitiveValues: readonly string[] = [],
): Error {
  if (
    providerConnection?.provider !== "openrouter" &&
    additionalSensitiveValues.length === 0
  ) {
    return error instanceof Error ? error : new Error("Codex run failed.");
  }
  const source = error instanceof Error ? error.message : String(error);
  const sensitiveValues = [
    ...(providerConnection?.provider === "openrouter"
      ? [providerConnection.apiKey]
      : []),
    ...additionalSensitiveValues,
  ].filter(Boolean);
  const redacted = sensitiveValues.reduce(
    (value, sensitive) => value.split(sensitive).join("[redacted]"),
    source,
  );
  const safe = new Error(redacted || "Codex run failed.");
  safe.name = error instanceof Error ? error.name : "Error";
  return safe;
}

function providerSecret(
  providerConnection: PersonalProviderConnection | undefined,
): string | undefined {
  return providerConnection?.provider === "openrouter"
    ? providerConnection.apiKey
    : undefined;
}

function containsSecret(value: unknown, secret: string | undefined): boolean {
  if (!secret) return false;
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value))
    return value.some((entry) => containsSecret(entry, secret));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, entry]) => key.includes(secret) || containsSecret(entry, secret),
  );
}

function redactSecret(value: string, secret: string | undefined): string {
  return secret ? value.split(secret).join("[redacted]") : value;
}

function redactStreamingSecret(
  buffered: string,
  chunk: string,
  secret: string | undefined,
): { emitted: string; buffered: string } {
  if (!secret) return { emitted: chunk, buffered: "" };
  const redacted = redactSecret(`${buffered}${chunk}`, secret);
  let bufferedCharacters = 0;
  const maximum = Math.min(secret.length - 1, redacted.length);
  for (let length = maximum; length > 0; length -= 1) {
    if (redacted.endsWith(secret.slice(0, length))) {
      bufferedCharacters = length;
      break;
    }
  }
  return {
    emitted: redacted.slice(0, redacted.length - bufferedCharacters),
    buffered: redacted.slice(redacted.length - bufferedCharacters),
  };
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
    /** Redeemed once after admission and consumed only by the isolated runtime profile. */
    providerConnection?: PersonalProviderConnection;
    environment?: NodeJS.ProcessEnv;
    /** Trusted test seam; production requests cannot provide a broker or upstream transport. */
    credentialBrokerFactory?: (
      apiKey: string,
    ) => Promise<OpenRouterCredentialBroker>;
  } = {},
): Promise<void> {
  const youtubeContext = isYoutubeAnalystRun(input)
    ? await (options.youtubeContext ?? youtubeTranscriptContext)(input)
    : "";
  const environment = options.environment ?? process.env;
  if (options.providerConnection?.provider === "chatgpt") {
    // Task 25 materialises actor-owned ChatGPT auth. Until then, never fall through to a host or
    // unauthenticated profile when a ChatGPT credential was selected.
    throw new Error("Personal AI connection is unavailable.");
  }
  const selectedModel =
    options.providerConnection?.provider === "openrouter"
      ? openRouterModel(environment)
      : modelFor(input);
  const selectedReasoningEffort = reasoningEffortFor(input, selectedModel);
  const additionalEnvironmentKeys = additionalEnvironmentKeysFor(input);
  let credentialBroker: OpenRouterCredentialBroker | undefined;
  let profile: CodexRuntimeProfile;
  try {
    if (options.providerConnection?.provider === "openrouter") {
      credentialBroker = await (
        options.credentialBrokerFactory ??
        ((apiKey: string) => createOpenRouterCredentialBroker({ apiKey }))
      )(options.providerConnection.apiKey);
      profile = await createOpenRouterRuntimeProfile({
        broker: credentialBroker,
        environment,
        additionalEnvironmentKeys,
      });
    } else {
      profile = await createCodexRuntimeProfile({
        environment,
        additionalEnvironmentKeys,
      });
    }
  } catch (error) {
    await credentialBroker?.close().catch(() => undefined);
    throw redactProviderError(error, options.providerConnection);
  }
  let client: CodexProcess | undefined;
  let failure: unknown;
  let failed = false;
  try {
    client = new CodexProcess(
      input,
      callbacks,
      selectedModel,
      selectedReasoningEffort,
      providerSecret(options.providerConnection),
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
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await client?.close();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  try {
    await profile.dispose();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  try {
    await credentialBroker?.close();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) {
    const brokerSecrets = credentialBroker
      ? [credentialBroker.baseUrl, new URL(credentialBroker.baseUrl).pathname]
      : [];
    throw redactProviderError(
      failure,
      options.providerConnection,
      brokerSecrets,
    );
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
  private stderrSecretBuffer = "";
  private readonly protocolTrace: string[] = [];
  private readonly toolNames = new Map<string, string>();
  private readonly dataControlWorkflow: DataControlWorkflow | undefined;
  private readonly textSecretBuffers = new Map<string, string>();
  private readonly reasoningSecretBuffers = new Map<
    string,
    { buffered: string; summaryIndex: number }
  >();
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
    private readonly selectedModel: string | undefined,
    private readonly selectedReasoningEffort: string,
    private readonly secret: string | undefined,
    private readonly timing: AgentExecutionTiming | undefined,
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
      const streamed = redactStreamingSecret(
        this.stderrSecretBuffer,
        String(chunk),
        this.secret,
      );
      this.stderrSecretBuffer = streamed.buffered;
      this.stderr = `${this.stderr}${streamed.emitted}`.slice(-4000);
    });
    this.process.once("error", (error) => {
      if (this.process.pid === undefined) this.markStopped();
      this.failRun(error);
    });
    this.process.once("exit", (code) => {
      this.flushStderrSecretBuffer();
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

  private flushStderrSecretBuffer(): void {
    if (!this.stderrSecretBuffer) return;
    const safe = this.secret ? "[redacted]" : this.stderrSecretBuffer;
    this.stderr = `${this.stderr}${safe}`.slice(-4000);
    this.stderrSecretBuffer = "";
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
      ...(this.selectedModel ? { model: this.selectedModel } : {}),
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
      effort: this.selectedReasoningEffort,
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
        pending.reject(
          new Error(redactSecret(JSON.stringify(message.error), this.secret)),
        );
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
        const streamed = redactStreamingSecret(
          this.textSecretBuffers.get(itemId) ?? "",
          delta,
          this.secret,
        );
        if (streamed.buffered)
          this.textSecretBuffers.set(itemId, streamed.buffered);
        else this.textSecretBuffers.delete(itemId);
        const safeDelta = streamed.emitted;
        if (isResearchRun(this.input)) {
          this.researchText = `${this.researchText}${safeDelta}`.slice(-24_000);
        }
        if (safeDelta)
          this.callbacks.onText(safeDelta, redactSecret(itemId, this.secret));
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
        const streamed = redactStreamingSecret(
          this.reasoningSecretBuffers.get(itemId)?.buffered ?? "",
          delta,
          this.secret,
        );
        if (streamed.buffered)
          this.reasoningSecretBuffers.set(itemId, {
            buffered: streamed.buffered,
            summaryIndex,
          });
        else this.reasoningSecretBuffers.delete(itemId);
        if (streamed.emitted)
          this.callbacks.onReasoning(
            streamed.emitted,
            redactSecret(itemId, this.secret),
            summaryIndex,
          );
      }
      return;
    }
    if (message.method === "turn/completed") {
      this.clearResearchDeadline();
      this.flushSecretBuffers();
      const turn = message.params?.turn as
        | { status?: string; error?: unknown }
        | undefined;
      if (turn?.status === "failed")
        this.failRun(
          new Error(
            redactSecret(
              JSON.stringify(turn.error ?? "Codex turn failed."),
              this.secret,
            ),
          ),
        );
      else {
        const correction = this.dataControlWorkflow?.correctionMessage();
        if (correction && this.correctionTurns < 2) {
          this.correctionTurns += 1;
          void this.request("turn/start", {
            threadId: this.threadId,
            input: [{ type: "text", text: correction }],
            effort: this.selectedReasoningEffort,
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
              effort: this.selectedReasoningEffort,
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
              effort: this.selectedReasoningEffort,
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
      this.failRun(
        new Error(
          redactSecret(
            JSON.stringify(message.params ?? "Codex error."),
            this.secret,
          ),
        ),
      );
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
      entry = `${entry}:error=${this.safeDiagnostic(message.error)}`;
    if (message.method === "error")
      entry = `${entry}:${this.safeDiagnostic(message.params)}`;
    if (message.method === "turn/completed") {
      const turn = message.params?.turn as
        | { status?: unknown; error?: unknown }
        | undefined;
      entry = `${entry}:status=${String(turn?.status ?? "unknown")}`;
      if (turn?.error !== undefined)
        entry = `${entry}:error=${this.safeDiagnostic(turn.error)}`;
    }
    this.protocolTrace.push(entry.slice(0, 800));
    if (this.protocolTrace.length > 24) this.protocolTrace.shift();
  }

  private flushSecretBuffers(): void {
    for (const [itemId, buffered] of this.textSecretBuffers) {
      const safeBuffered = this.secret ? "[redacted]" : buffered;
      if (isResearchRun(this.input)) {
        this.researchText = `${this.researchText}${safeBuffered}`.slice(
          -24_000,
        );
      }
      this.callbacks.onText(safeBuffered, redactSecret(itemId, this.secret));
    }
    this.textSecretBuffers.clear();
    for (const [itemId, value] of this.reasoningSecretBuffers) {
      this.callbacks.onReasoning(
        this.secret ? "[redacted]" : value.buffered,
        redactSecret(itemId, this.secret),
        value.summaryIndex,
      );
    }
    this.reasoningSecretBuffers.clear();
  }

  private async handleToolCall(id: number, params: JsonObject): Promise<void> {
    const sensitiveCall = containsSecret(params, this.secret);
    const callId =
      typeof params.callId === "string" ? params.callId : `call_${id}`;
    const wireName = typeof params.tool === "string" ? params.tool : "unknown";
    const { deploymentName, eventName } = toolCallNames(
      wireName,
      this.toolNames,
    );
    const args = isObject(params.arguments) ? params.arguments : {};
    const safeArgs = sensitiveCall ? {} : args;
    /*
     * Report the same safe name Codex was offered. Turning it back into `mcp__...` in the AG-UI
     * event made CopilotKit reject the event because that namespace is reserved, so opening a
     * conversation replayed a run error instead of restoring it. The deployment call still needs
     * the original governed name, which is kept separately above.
     */
    this.callbacks.onToolStart(
      redactSecret(callId, this.secret),
      redactSecret(eventName, this.secret),
      safeArgs,
    );
    const duplicateDeliverableArtifact =
      deploymentName === "mcp__artifacts__create_artifact" &&
      ((isYoutubeAnalystRun(this.input) && this.youtubeArtifactCreated) ||
        (isResearchRun(this.input) && this.researchArtifactCreated));
    const result = sensitiveCall
      ? {
          text: "Refused. Provider credentials cannot be passed to a deployment tool.",
          isError: true,
        }
      : duplicateDeliverableArtifact
        ? {
            text: "Refused. This run already created its one allowed deliverable artifact.",
            isError: true,
          }
        : await this.deploymentToolCaller(this.input, deploymentName, args);
    const safeResult = {
      ...result,
      text: redactSecret(result.text, this.secret),
    };
    if (
      isResearchRun(this.input) &&
      deploymentName === "mcp__artifacts__create_artifact" &&
      !safeResult.isError
    ) {
      this.researchArtifactCreated = true;
    }
    if (
      isYoutubeAnalystRun(this.input) &&
      deploymentName === "mcp__artifacts__create_artifact" &&
      !safeResult.isError
    ) {
      this.youtubeArtifactCreated = true;
    }
    this.dataControlWorkflow?.recordToolResult(
      deploymentName,
      safeArgs,
      safeResult.text,
    );
    this.callbacks.onToolResult(
      redactSecret(callId, this.secret),
      safeResult.text,
    );
    this.write({
      id,
      result: {
        contentItems: [{ type: "inputText", text: safeResult.text }],
        success: !safeResult.isError,
      },
    });
  }

  private safeDiagnostic(value: unknown): string {
    return redactSecret(safeDiagnostic(value), this.secret);
  }
}

function spawnCodexProcess(
  input: RunAgentInput,
  profile: CodexRuntimeProfile,
): ChildProcessWithoutNullStreams {
  return spawn(ISOLATED_CODEX_BINARY, ["app-server"], {
    cwd: workspaceFor(input),
    env: codexProcessEnvironment(profile),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function codexProcessEnvironment(
  profile: Pick<CodexRuntimeProfile, "environment">,
): NodeJS.ProcessEnv {
  const environment = { ...profile.environment };
  delete environment.LD_PRELOAD;
  delete environment.LD_LIBRARY_PATH;
  return environment;
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
