import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { RunAgentInput } from "@ag-ui/core";
import {
  deploymentToolNames,
  instructionsFor,
  runAssertion,
  transcriptFor,
} from "./history";

type JsonObject = Record<string, unknown>;
type Notification = { method?: string; params?: JsonObject; id?: number; result?: unknown; error?: unknown };

export type CodexCallbacks = {
  onText(delta: string, itemId: string): void;
  onToolStart(callId: string, name: string, args: JsonObject): void;
  onToolResult(callId: string, result: string): void;
};

const TOOL_URL = process.env.OPENBOT_TOOL_URL ?? "http://openbot:3001/api/agent-tools/call";
const TOOL_TOKEN = process.env.AGENT_TOOL_TOKEN?.trim() ?? "";
const MODEL = process.env.CODEX_MODEL?.trim();

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
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly finished: Promise<void>;
  private finish!: () => void;
  private fail!: (error: Error) => void;
  private nextId = 1;
  private turnCompleted = false;
  private stderr = "";

  constructor(
    private readonly input: RunAgentInput,
    private readonly callbacks: CodexCallbacks,
  ) {
    this.finished = new Promise<void>((resolve, reject) => {
      this.finish = resolve;
      this.fail = reject;
    });
    this.process = spawn("codex", ["app-server"], {
      cwd: "/workspace",
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    readline.createInterface({ input: this.process.stdout }).on("line", (line) => this.onLine(line));
    this.process.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-4000);
    });
    this.process.once("error", (error) => this.fail(error));
    this.process.once("exit", (code) => {
      if (!this.turnCompleted) {
        this.fail(new Error(`Codex app-server stopped with code ${code ?? "unknown"}. ${this.stderr}`.trim()));
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
      .map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      }));
    const started = (await this.request("thread/start", {
      ...(MODEL ? { model: MODEL } : {}),
      cwd: "/workspace",
      approvalPolicy: "never",
      permissions: "openbot-agent",
      baseInstructions: instructionsFor(this.input),
      ephemeral: true,
      serviceName: "openbot_codex",
      dynamicTools,
    })) as { thread?: { id?: string } };
    const threadId = started.thread?.id;
    if (!threadId) throw new Error("Codex did not return a thread id.");

    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: transcriptFor(this.input) }],
    });
    await this.finished;
  }

  close(): void {
    if (!this.process.killed) this.process.kill("SIGTERM");
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
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
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
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
    if (message.method === "turn/completed") {
      const turn = message.params?.turn as { status?: string; error?: unknown } | undefined;
      this.turnCompleted = true;
      if (turn?.status === "failed") this.fail(new Error(JSON.stringify(turn.error ?? "Codex turn failed.")));
      else this.finish();
      return;
    }
    if (message.method === "error") {
      if (message.params?.willRetry === true) return;
      this.fail(new Error(JSON.stringify(message.params ?? "Codex error.")));
    }
  }

  private async handleToolCall(id: number, params: JsonObject): Promise<void> {
    const callId = typeof params.callId === "string" ? params.callId : `call_${id}`;
    const name = typeof params.tool === "string" ? params.tool : "unknown";
    const args = isObject(params.arguments) ? params.arguments : {};
    this.callbacks.onToolStart(callId, name, args);
    const result = await callDeploymentTool(this.input, name, args);
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
  if (!deploymentToolNames(input).has(name)) return "Refused. This tool is not governed by this OpenBot deployment.";
  if (!TOOL_TOKEN) return "Refused. The Codex adapter has no deployment tool credential.";
  const run = runAssertion(input);
  if (!run) return "Refused. This run has no signed OpenBot assertion.";

  try {
    const response = await fetch(TOOL_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openbot-agent-token": TOOL_TOKEN },
      body: JSON.stringify({ name, args, run }),
    });
    const body = (await response.json()) as { text?: string };
    return body.text ?? `The tool returned HTTP ${response.status} without a result.`;
  } catch (error) {
    return `The tool could not be called: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
