import { serve } from "bun";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";
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

const server = serve({
  port: PORT,
  // Bun caps this at 255 seconds; use the maximum for long validation tool calls.
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        status: admission.snapshot().draining ? "draining" : "ok",
        model: process.env.CODEX_MODEL?.trim() || "account-default",
        auth: "chatgpt",
        managedRuns: admission.snapshot(),
      });
    }
    if (
      (url.pathname === "/admin/drain" || url.pathname === "/admin/resume") &&
      request.method === "POST"
    ) {
      if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN)) {
        return Response.json({ error: "Unauthorized." }, { status: 401 });
      }
      return Response.json(
        url.pathname === "/admin/drain"
          ? admission.startDraining()
          : admission.resume(),
      );
    }
    if (url.pathname === "/ag-ui" && request.method === "POST") {
      return handleAgentRequest(request);
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

let shutdownStarted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    admission.startDraining();
    void server.stop(false).finally(() => process.exit(0));
  });
}

console.info(`agent-codex listening on http://localhost:${PORT}/ag-ui`);
