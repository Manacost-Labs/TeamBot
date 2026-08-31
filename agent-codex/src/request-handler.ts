import { type RunAgentInput, RunAgentInputSchema } from "@ag-ui/core";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";
import { createAgentResponse } from "./agent-run";
import {
  type AgentExecutionTiming,
  createAgentExecutionTiming,
  type ExecutionTimingRecord,
} from "./execution-timing";
import {
  type RunAdmission,
  RunDrainingError,
  RunQueueAbortedError,
  RunQueueFullError,
  RunQueueTimeoutError,
} from "./run-admission";

type AgentRequestHandlerOptions = {
  managedAgentToken: string;
  agentId: string;
  now?: () => number;
  sink?: (record: ExecutionTimingRecord) => void;
  admission?: RunAdmission;
  respond?: (
    input: RunAgentInput,
    timing: AgentExecutionTiming,
    onSettled: () => void,
  ) => Response;
};

/**
 * Older trusted internal clients did not send the empty state/context fields
 * introduced as required keys by AG-UI. Both have an unambiguous empty value,
 * so normalize only their absence and keep the rest of the public schema strict.
 */
function withCompatibleDefaults(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }

  const input = body as Record<string, unknown>;
  return {
    ...input,
    ...(!Object.hasOwn(input, "state") ? { state: {} } : {}),
    ...(!Object.hasOwn(input, "context") ? { context: [] } : {}),
  };
}

function invalidFields(
  issues: ReadonlyArray<{ path: PropertyKey[] }>,
): string[] {
  return [
    ...new Set(
      issues
        .map((issue) => issue.path[0])
        .filter((field): field is string => typeof field === "string"),
    ),
  ];
}

function admissionAgentId(input: RunAgentInput, fallback: string): string {
  const forwarded = input.forwardedProps as
    | { openbotBotId?: unknown }
    | undefined;
  const candidate = forwarded?.openbotBotId;
  return typeof candidate === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(candidate)
    ? candidate
    : fallback;
}

/** Authenticate, parse and validate one AG-UI request while timing even pre-run failures. */
export function createAgentRequestHandler(options: AgentRequestHandlerOptions) {
  const now = options.now ?? (() => performance.now());
  const respond =
    options.respond ??
    ((
      input: RunAgentInput,
      timing: AgentExecutionTiming,
      onSettled: () => void,
    ) => createAgentResponse(input, { timing, onSettled }));

  return async (request: Request): Promise<Response> => {
    const receivedAt = now();
    if (!hasManagedAgentToken(request, options.managedAgentToken)) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }

    const timing = createAgentExecutionTiming(undefined, {
      agentId: options.agentId,
      requestId: request.headers.get("x-openbot-request-id") ?? undefined,
      startedAt: receivedAt,
      now,
      ...(options.sink ? { sink: options.sink } : {}),
    });
    timing.recordAt("request_received", receivedAt);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      timing.record("run_error", { errorType: "InvalidJson" });
      return Response.json({ error: "Invalid request body." }, { status: 400 });
    }

    const parsed = RunAgentInputSchema.safeParse(withCompatibleDefaults(body));
    if (!parsed.success) {
      timing.record("run_error", { errorType: "InvalidRequest" });
      return Response.json(
        {
          error: "Invalid request body.",
          invalidFields: invalidFields(parsed.error.issues),
        },
        { status: 400 },
      );
    }

    timing.correlate(parsed.data, options.agentId);
    timing.record("request_accepted");
    let release = () => {};
    if (options.admission) {
      try {
        const lease = await options.admission.acquire(
          admissionAgentId(parsed.data, options.agentId),
          request.signal,
        );
        release = lease.release;
      } catch (error) {
        const queueFailure =
          error instanceof RunQueueFullError
            ? {
                status: 429,
                errorType: "RunQueueFull",
                message: "Managed run queue is full.",
              }
            : error instanceof RunDrainingError
              ? {
                  status: 503,
                  errorType: "RunDraining",
                  message: "Managed runtime is draining for deployment.",
                }
              : error instanceof RunQueueTimeoutError
                ? {
                    status: 503,
                    errorType: "RunQueueTimeout",
                    message: "Managed run queue timed out.",
                  }
                : error instanceof RunQueueAbortedError
                  ? {
                      status: 499,
                      errorType: "RunQueueAborted",
                      message: "Managed run request was cancelled.",
                    }
                  : undefined;
        if (!queueFailure) throw error;
        timing.record("run_error", { errorType: queueFailure.errorType });
        return Response.json(
          { error: queueFailure.message },
          {
            status: queueFailure.status,
            ...(queueFailure.status === 499
              ? {}
              : { headers: { "retry-after": "5" } }),
          },
        );
      }
    }

    try {
      return respond(parsed.data, timing, release);
    } catch (error) {
      release();
      throw error;
    }
  };
}
