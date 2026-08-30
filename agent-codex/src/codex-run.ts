import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import type { RunAgentInput } from "@ag-ui/core";
import { DataControlWorkflow } from "./data-control-workflow";
import {
  deploymentToolNames,
  instructionsFor,
  isDataControlRun,
  isHeartPulseControlRun,
  isResearchRun,
  permissionProfileFor,
  runAssertion,
  transcriptFor,
} from "./history";

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

const HEARTPULSE_WORKSPACE = "/workspace-heartpulse";
const RESEARCH_WORKSPACE = "/research-runs";

export function workspaceFor(input: RunAgentInput): string {
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
  if (isResearchRun(input) && REASONING_EFFORTS.has(RESEARCH_REASONING_EFFORT)) {
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
    (isDataControlRun(input) || isHeartPulseControlRun(input)) &&
    modelFor(input) === "gpt-5.6-luna"
  ) {
    return "xhigh";
  }

  return REASONING_EFFORT;
}

export async function runCodex(
  input: RunAgentInput,
  callbacks: CodexCallbacks,
): Promise<void> {
  const client = new CodexProcess(input, callbacks);
  try {
    await client.run();
  } finally {
    client.close();
  }
}

class CodexProcess {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private readonly finished: Promise<void>;
  private finish!: () => void;
  private fail!: (error: Error) => void;
  private nextId = 1;
  private turnCompleted = false;
  private stderr = "";
  private readonly protocolTrace: string[] = [];
  private readonly toolNames = new Map<string, string>();
  private readonly dataControlWorkflow: DataControlWorkflow | undefined;
  private threadId: string | undefined;
  private correctionTurns = 0;

  constructor(
    private readonly input: RunAgentInput,
    private readonly callbacks: CodexCallbacks,
  ) {
    this.dataControlWorkflow = isDataControlRun(input)
      ? new DataControlWorkflow()
      : undefined;
    this.finished = new Promise<void>((resolve, reject) => {
      this.finish = resolve;
      this.fail = reject;
    });
    this.process = spawn("codex", ["app-server"], {
      cwd: workspaceFor(input),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    readline
      .createInterface({ input: this.process.stdout })
      .on("line", (line) => this.onLine(line));
    this.process.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-4000);
    });
    this.process.once("error", (error) => this.fail(error));
    this.process.once("exit", (code) => {
      if (!this.turnCompleted) {
        const trace =
          this.protocolTrace.length > 0
            ? ` Protocol: ${this.protocolTrace.join(" -> ")}`
            : "";
        this.fail(
          new Error(
            `Codex app-server stopped with code ${code ?? "unknown"}.${trace} ${this.stderr}`.trim(),
          ),
        );
      }
    });
  }

  async run(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "openbot", title: "OpenBot", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
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

    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: transcriptFor(this.input) }],
      effort: reasoningEffortFor(this.input),
      summary: REASONING_SUMMARY,
    });
    await this.finished;
  }

  close(): void {
    if (!this.process.killed) this.process.kill("SIGTERM");
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
      const turn = message.params?.turn as
        | { status?: string; error?: unknown }
        | undefined;
      if (turn?.status === "failed")
        this.fail(
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
          }).catch(this.fail);
        } else if (correction) {
          this.fail(
            new Error(
              `Контроль данных did not complete required repairs for: ${this.dataControlWorkflow?.unresolvedSourceIds().join(", ")}`,
            ),
          );
        } else {
          this.turnCompleted = true;
          this.finish();
        }
      }
      return;
    }
    if (message.method === "error") {
      if (message.params?.willRetry === true) return;
      this.fail(new Error(JSON.stringify(message.params ?? "Codex error.")));
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
    const result = await callDeploymentTool(this.input, deploymentName, args);
    this.dataControlWorkflow?.recordToolResult(deploymentName, args, result);
    this.callbacks.onToolResult(callId, result);
    this.write({
      id,
      result: {
        contentItems: [{ type: "inputText", text: result }],
        success: !result.startsWith("Refused."),
      },
    });
  }
}

async function callDeploymentTool(
  input: RunAgentInput,
  name: string,
  args: JsonObject,
): Promise<string> {
  if (!deploymentToolNames(input).has(name))
    return "Refused. This tool is not governed by this OpenBot deployment.";
  if (!TOOL_TOKEN)
    return "Refused. The Codex adapter has no deployment tool credential.";
  const run = runAssertion(input);
  if (!run) return "Refused. This run has no signed OpenBot assertion.";

  try {
    const response = await fetch(TOOL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-agent-token": TOOL_TOKEN,
      },
      body: JSON.stringify({ name, args, run }),
    });
    const body = (await response.json()) as { text?: string };
    return (
      body.text ?? `The tool returned HTTP ${response.status} without a result.`
    );
  } catch (error) {
    return `The tool could not be called: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeDiagnostic(value: unknown): string {
  return JSON.stringify(value)?.slice(0, 600) ?? String(value).slice(0, 600);
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
