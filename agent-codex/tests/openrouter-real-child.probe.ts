import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { RunAgentInput } from "@ag-ui/core";
import { createAgentResponse } from "../src/agent-run";
import { codexProcessEnvironment, runCodex } from "../src/codex-run";
import { createAgentExecutionTiming } from "../src/execution-timing";
import {
  createOpenRouterCredentialBroker,
  OPENROUTER_UPSTREAM_BASE_URL,
  type OpenRouterCredentialBroker,
} from "../src/openrouter-credential-broker";

const CODEX_BINARY =
  "/opt/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
let secret = `or-${randomUUID()}-${randomBytes(18).toString("hex")}`;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function procMetadataClean(): boolean {
  const needle = Buffer.from(secret);
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    for (const name of ["environ", "cmdline"]) {
      try {
        if (readFileSync(`/proc/${entry}/${name}`).includes(needle)) {
          return false;
        }
      } catch {
        // A process may exit between directory enumeration and reading its metadata.
      }
    }
  }
  return true;
}

function responseObject(status: "in_progress" | "completed") {
  const now = Math.floor(Date.now() / 1000);
  const complete = status === "completed";
  return {
    id: "resp_controlled",
    object: "response",
    created_at: now,
    status,
    background: false,
    completed_at: complete ? now : null,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: "openai/gpt-4o-mini",
    output: complete
      ? [
          {
            id: "msg_controlled",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Controlled progress.",
                annotations: [],
                logprobs: [],
              },
            ],
          },
        ]
      : [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: "low", summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" }, verbosity: "medium" },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: complete
      ? {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 3,
        }
      : null,
    metadata: {},
  };
}

function controlledResponseStream(): ReadableStream<Uint8Array> {
  const message = {
    id: "msg_controlled",
    type: "message",
    role: "assistant",
  };
  const part = {
    type: "output_text",
    text: "",
    annotations: [],
    logprobs: [],
  };
  const events = [
    {
      type: "response.created",
      sequence_number: 0,
      response: responseObject("in_progress"),
    },
    {
      type: "response.in_progress",
      sequence_number: 1,
      response: responseObject("in_progress"),
    },
    {
      type: "response.output_item.added",
      sequence_number: 2,
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      sequence_number: 3,
      item_id: "msg_controlled",
      output_index: 0,
      content_index: 0,
      part,
    },
    {
      type: "response.output_text.delta",
      sequence_number: 4,
      item_id: "msg_controlled",
      output_index: 0,
      content_index: 0,
      delta: "Controlled ",
      logprobs: [],
    },
    {
      type: "response.output_text.delta",
      sequence_number: 5,
      item_id: "msg_controlled",
      output_index: 0,
      content_index: 0,
      delta: "progress.",
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      sequence_number: 6,
      item_id: "msg_controlled",
      output_index: 0,
      content_index: 0,
      text: "Controlled progress.",
      logprobs: [],
    },
    {
      type: "response.content_part.done",
      sequence_number: 7,
      item_id: "msg_controlled",
      output_index: 0,
      content_index: 0,
      part: { ...part, text: "Controlled progress." },
    },
    {
      type: "response.output_item.done",
      sequence_number: 8,
      output_index: 0,
      item: {
        ...message,
        status: "completed",
        content: [{ ...part, text: "Controlled progress." }],
      },
    },
    {
      type: "response.completed",
      sequence_number: 9,
      response: responseObject("completed"),
    },
  ];
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
        if (event.type === "response.output_text.delta") await Bun.sleep(50);
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

const input = {
  agentId: "probe-agent",
  runId: "run-controlled-broker",
  threadId: "thread-controlled-broker",
  messages: [
    {
      id: "message-controlled-broker",
      role: "user",
      content: "Reply with the controlled response.",
    },
  ],
  tools: [],
  context: [],
  state: {},
  forwardedProps: { openbotBotId: "probe-agent" },
} as RunAgentInput;

const timings: unknown[] = [];
const timing = createAgentExecutionTiming(input, {
  requestId: "request-controlled-broker",
  sink: (record) => timings.push(record),
});
let broker: OpenRouterCredentialBroker | undefined;
let child: ChildProcessWithoutNullStreams | undefined;
let config = "";
let modelRequests = 0;
let responsesRequests = 0;
let modelAuthCorrect = true;
let responsesAuthCorrect = true;
let requestBodiesClean = true;
let redirectsDisabled = true;
let upstreamUrlsFixed = true;
let childProcClean = true;

try {
  const controlledUpstreamFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    upstreamUrlsFixed &&=
      request.url === `${OPENROUTER_UPSTREAM_BASE_URL}/models` ||
      request.url === `${OPENROUTER_UPSTREAM_BASE_URL}/responses`;
    redirectsDisabled &&= request.redirect === "error";
    childProcClean &&= procMetadataClean();
    if (path.endsWith("/models")) {
      modelRequests += 1;
      modelAuthCorrect &&=
        request.headers.get("authorization") === `Bearer ${secret}`;
      return Response.json({
        object: "list",
        data: [
          {
            id: "openai/gpt-4o-mini",
            object: "model",
            created: 1,
            owned_by: "controlled",
          },
        ],
      });
    }
    responsesRequests += 1;
    responsesAuthCorrect &&=
      request.headers.get("authorization") === `Bearer ${secret}`;
    requestBodiesClean &&= !(await request.clone().text()).includes(secret);
    return new Response(controlledResponseStream(), {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  };

  const response = createAgentResponse(input, {
    timing,
    run: (runInput, callbacks, runTiming) =>
      runCodex(runInput, callbacks, {
        timing: runTiming,
        providerConnection: { provider: "openrouter", apiKey: secret },
        environment: {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          NO_COLOR: "1",
          OPENROUTER_MODEL: "openai/gpt-4o-mini",
        },
        credentialBrokerFactory: async (apiKey) => {
          check(apiKey === secret, "broker received a different credential");
          broker = await createOpenRouterCredentialBroker({
            apiKey,
            fetch: controlledUpstreamFetch,
          });
          return broker;
        },
        spawn(profile) {
          config = readFileSync(`${profile.codexHome}/config.toml`, "utf8");
          check(!config.includes(secret), "credential entered profile config");
          check(
            !config.includes("openrouter.ai"),
            "upstream entered child config",
          );
          check(!/^auth\s*=/m.test(config), "command auth remained configured");
          child = spawn(CODEX_BINARY, ["app-server"], {
            cwd: "/workspace",
            env: codexProcessEnvironment(profile),
            stdio: ["pipe", "pipe", "pipe"],
          });
          return child;
        },
      }),
  });

  const watchdog = setTimeout(() => child?.kill("SIGKILL"), 60_000);
  const agui = await response.text();
  clearTimeout(watchdog);
  const events = agui
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  const eventTypes = events.map((event) => String(event.type));
  const content = events
    .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => String(event.delta ?? ""))
    .join("");
  const timingJson = JSON.stringify(timings);

  // Codex 0.150.1 can skip model discovery when the server selects an explicit model.
  // The broker's GET /models contract is exercised directly by its security tests.
  check(responsesRequests === 1, "Responses request missing");
  check(modelAuthCorrect, "model catalog credential missing");
  check(responsesAuthCorrect, "Responses credential missing");
  check(requestBodiesClean, "credential entered request body");
  check(redirectsDisabled, "upstream redirects were enabled");
  check(upstreamUrlsFixed, "upstream URL changed");
  check(childProcClean, "credential entered process metadata");
  check(eventTypes.includes("RUN_STARTED"), "RUN_STARTED missing");
  check(eventTypes.includes("TEXT_MESSAGE_START"), "message start missing");
  check(
    eventTypes.filter((type) => type === "TEXT_MESSAGE_CONTENT").length >= 2,
    "progressive text deltas missing",
  );
  check(eventTypes.includes("TEXT_MESSAGE_END"), "message end missing");
  check(eventTypes.at(-1) === "RUN_FINISHED", "terminal event incorrect");
  check(!eventTypes.includes("RUN_ERROR"), "unexpected RUN_ERROR");
  check(content === "Controlled progress.", "controlled response changed");
  check(!agui.includes(secret), "credential entered AG-UI events");
  check(!timingJson.includes(secret), "credential entered timing logs");
  check(
    timings.some(
      (record) => (record as { phase?: unknown }).phase === "first_text_delta",
    ),
    "first text timing missing",
  );
  check(
    timings.some(
      (record) => (record as { phase?: unknown }).phase === "run_completed",
    ),
    "run completion timing missing",
  );
  check(
    child !== undefined &&
      (child.exitCode !== null || child.signalCode !== null),
    "Codex child remained alive",
  );
  check(broker !== undefined, "broker was not created");
  let brokerClosed = false;
  try {
    const closedResponse = await fetch(`${broker.baseUrl}/models`, {
      signal: AbortSignal.timeout(500),
    });
    brokerClosed = closedResponse.status >= 400;
  } catch {
    brokerClosed = true;
  }
  check(brokerClosed, "broker remained reachable");
  const profileRootClean = readdirSync("/run/openbot-codex").length === 0;
  check(profileRootClean, "runtime profile remained on disk");

  console.log(
    JSON.stringify({
      outcome: "PASS",
      realCodexChild: true,
      modelRequests,
      responsesRequests,
      modelAuthCorrect,
      responsesAuthCorrect,
      requestBodiesClean,
      redirectsDisabled,
      upstreamUrlsFixed,
      childProcClean,
      profileContainsCredential: config.includes(secret),
      aguiEventTypes: eventTypes,
      aguiContentDeltaCount: eventTypes.filter(
        (type) => type === "TEXT_MESSAGE_CONTENT",
      ).length,
      timingPhases: timings.map(
        (record) => (record as { phase?: unknown }).phase,
      ),
      aguiCredentialClean: !agui.includes(secret),
      timingCredentialClean: !timingJson.includes(secret),
      brokerClosed,
      profileRootClean,
    }),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      outcome: "FAIL",
      error: message.split(secret).join("[redacted]"),
      modelRequests,
      responsesRequests,
      modelAuthCorrect,
      responsesAuthCorrect,
      requestBodiesClean,
      redirectsDisabled,
      upstreamUrlsFixed,
      childProcClean,
    }),
  );
  process.exitCode = 1;
} finally {
  child?.kill("SIGKILL");
  await broker?.close().catch(() => undefined);
  secret = "";
}
