import { serve } from "bun";
import { createAgentRequestHandler } from "./request-handler";

const PORT = Number.parseInt(process.env.PORT ?? "4202", 10);
const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim();
if (!MANAGED_AGENT_TOKEN) throw new Error("MANAGED_AGENT_TOKEN is required.");
const handleAgentRequest = createAgentRequestHandler({
  managedAgentToken: MANAGED_AGENT_TOKEN,
  agentId: "agent-codex",
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
      });
    }
    if (url.pathname === "/ag-ui" && request.method === "POST") {
      return handleAgentRequest(request);
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  },
});

console.info(`agent-codex listening on http://localhost:${PORT}/ag-ui`);
