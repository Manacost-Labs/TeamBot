import { serve } from "bun";
import { createAgentRequestHandler } from "./request-handler";
import { RunAdmission } from "./run-admission";

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

const PORT = Number.parseInt(process.env.PORT ?? "4202", 10);
const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim();
if (!MANAGED_AGENT_TOKEN) throw new Error("MANAGED_AGENT_TOKEN is required.");
const admission = new RunAdmission({
  globalLimit: positiveInteger("CODEX_MAX_ACTIVE_RUNS", 4),
  perAgentLimit: positiveInteger("CODEX_MAX_ACTIVE_RUNS_PER_AGENT", 2),
  queueLimit: nonNegativeInteger("CODEX_MAX_QUEUED_RUNS", 32),
  maxWaitMs: positiveInteger("CODEX_MAX_QUEUE_WAIT_MS", 60_000),
});
const handleAgentRequest = createAgentRequestHandler({
  managedAgentToken: MANAGED_AGENT_TOKEN,
  agentId: "agent-codex",
  admission,
});

serve({
  port: PORT,
  // Bun caps this at 255 seconds; use the maximum for long validation tool calls.
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        model: process.env.CODEX_MODEL?.trim() || "account-default",
        auth: "chatgpt",
        managedRuns: admission.snapshot(),
      });
    }
    if (url.pathname === "/ag-ui" && request.method === "POST") {
      return handleAgentRequest(request);
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.info(`agent-codex listening on http://localhost:${PORT}/ag-ui`);
