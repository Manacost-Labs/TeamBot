import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import {
  type ChatGptDeviceFlowService,
  type ChatGptDeviceFlowStart,
  type ChatGptDeviceFlowStatus,
  ChatGptDeviceFlowUnavailableError,
} from "./device-flows";
import type {
  OpenRouterKeyValidationFailureCode,
  OpenRouterKeyValidator,
} from "./openrouter";
import type {
  createPersonalAiConnectionStore,
  PersonalAiConnectionStatus,
  PersonalAiSafeMetadata,
} from "./store";

const CONNECTION_PATH = "/api/ai-connections";
const CHATGPT_DEVICE_FLOW_PATH = `${CONNECTION_PATH}/chatgpt/device-flow`;
const MAX_MUTATION_BODY_BYTES = 16 * 1_024;

export type PersonalAiConnectionRouteStore = Pick<
  ReturnType<typeof createPersonalAiConnectionStore>,
  "connect" | "status" | "disconnect"
>;

export type PersonalAiConnectionRoutesOptions = Readonly<{
  store: PersonalAiConnectionRouteStore;
  validator: OpenRouterKeyValidator;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  allowedOrigins: readonly string[];
  deviceFlows?: ChatGptDeviceFlowService;
}>;

type PublicConnection = Readonly<{
  provider: "chatgpt" | "openrouter";
  state: "active" | "disconnected";
  validatedAt: string;
  disconnectedAt: string | null;
  updatedAt: string;
  safeMetadata: PersonalAiSafeMetadata;
}>;

type ValidatorFailure = Readonly<{
  status: 422 | 429 | 502 | 503;
  error: string;
}>;

const validatorFailures: Readonly<
  Record<OpenRouterKeyValidationFailureCode, ValidatorFailure>
> = Object.freeze({
  invalid_key: Object.freeze({
    status: 422,
    error: "OpenRouter API key is invalid.",
  }),
  forbidden: Object.freeze({
    status: 422,
    error: "OpenRouter rejected this API key.",
  }),
  rate_limited: Object.freeze({
    status: 429,
    error: "OpenRouter key validation is rate limited.",
  }),
  provider_unavailable: Object.freeze({
    status: 503,
    error: "OpenRouter is temporarily unavailable.",
  }),
  provider_refused: Object.freeze({
    status: 502,
    error: "OpenRouter refused key validation.",
  }),
  invalid_response: Object.freeze({
    status: 502,
    error: "OpenRouter returned an invalid response.",
  }),
});

function safeMetadata(metadata: PersonalAiSafeMetadata) {
  const projected: PersonalAiSafeMetadata = {};
  if (metadata.usageUsd !== undefined) projected.usageUsd = metadata.usageUsd;
  if (metadata.limitUsd !== undefined) projected.limitUsd = metadata.limitUsd;
  if (metadata.limitRemainingUsd !== undefined) {
    projected.limitRemainingUsd = metadata.limitRemainingUsd;
  }
  if (metadata.isFreeTier !== undefined) {
    projected.isFreeTier = metadata.isFreeTier;
  }
  return projected;
}

/** Explicit browser projection. Never spread a vault/store object across the HTTP boundary. */
function publicConnection(
  status: PersonalAiConnectionStatus,
): PublicConnection {
  return {
    provider: status.provider,
    state: status.state,
    validatedAt: status.validatedAt.toISOString(),
    disconnectedAt: status.disconnectedAt?.toISOString() ?? null,
    updatedAt: status.updatedAt.toISOString(),
    safeMetadata: safeMetadata(status.safeMetadata),
  };
}

function noQuery(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    // `URL.search` drops a trailing bare `?`; the singleton contract forbids that spelling too.
    if (context.req.url.includes("?")) {
      return context.json({ error: "Query parameters are not allowed." }, 400);
    }
    await next();
  };
}

function mutationOrigin(
  configuredOrigins: ReadonlySet<string>,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const origin = context.req.header("origin");
    const requestOrigin = new URL(context.req.url).origin;
    if (
      !origin ||
      (origin !== requestOrigin && !configuredOrigins.has(origin))
    ) {
      return context.json(
        { error: "This request must come from this app." },
        403,
      );
    }
    await next();
  };
}

function exactJsonMediaType(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const mediaType = context.req
      .header("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      return context.json(
        { error: "An application/json body is required." },
        415,
      );
    }
    await next();
  };
}

function strictOpenRouterBody(
  value: unknown,
): value is { provider: "openrouter"; apiKey: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  return (
    keys.length === 2 &&
    keys[0] === "apiKey" &&
    keys[1] === "provider" &&
    body.provider === "openrouter" &&
    typeof body.apiKey === "string"
  );
}

function connectionEnvelope(status: PersonalAiConnectionStatus | null): {
  connection: PublicConnection | null;
} {
  return { connection: status ? publicConnection(status) : null };
}

function publicDeviceFlow(
  flow: ChatGptDeviceFlowStatus | ChatGptDeviceFlowStart,
) {
  const projected: Record<string, unknown> = {
    flowId: flow.flowId,
    state: flow.state,
    expiresAt: flow.expiresAt.toISOString(),
    retryable: flow.retryable,
  };
  if ("verificationUrl" in flow && "userCode" in flow) {
    projected.verificationUrl = flow.verificationUrl;
    projected.userCode = flow.userCode;
  }
  return { flow: projected };
}

function deviceFlowFailure(
  context: Context<{ Variables: AppVariables }>,
  error: unknown,
) {
  return error instanceof ChatGptDeviceFlowUnavailableError
    ? context.json({ error: "ChatGPT connection flow is unavailable." }, 404)
    : context.json(
        { error: "ChatGPT connection is temporarily unavailable." },
        503,
      );
}

function unavailable(context: Context<{ Variables: AppVariables }>) {
  return context.json(
    { error: "Personal AI connection is temporarily unavailable." },
    503,
  );
}

function canonicalOrigins(values: readonly string[]) {
  const origins = new Set<string>();
  for (const value of values) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("Personal AI allowed origins must be canonical origins");
    }
    if (parsed.origin !== value || parsed.href !== `${value}/`) {
      throw new Error("Personal AI allowed origins must be canonical origins");
    }
    origins.add(value);
  }
  return origins;
}

/**
 * Actor-owned singleton routes. The only ownership input is the authenticated session actor set by
 * `requireUser`; there is intentionally no user, credential or connection identifier in the path,
 * query, body or store call surface.
 */
export function createPersonalAiConnectionRoutes(
  options: PersonalAiConnectionRoutesOptions,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const configuredOrigins = canonicalOrigins(options.allowedOrigins);
  const deviceFlows = options.deviceFlows;
  const rejectQuery = noQuery();
  const requireMutationOrigin = mutationOrigin(configuredOrigins);
  const requireJson = exactJsonMediaType();
  const limitMutationBody = bodyLimit({
    maxSize: MAX_MUTATION_BODY_BYTES,
    onError: (context) =>
      context.json(
        { error: "Personal AI connection request is too large." },
        413,
      ),
  });

  routes.use(CONNECTION_PATH, async (context, next) => {
    context.header("cache-control", "private, no-store");
    await next();
  });

  routes.get(
    CONNECTION_PATH,
    options.requireUser,
    rejectQuery,
    async (context) => {
      try {
        const status = await options.store.status(context.var.actor.id);
        return context.json(connectionEnvelope(status));
      } catch {
        return unavailable(context);
      }
    },
  );

  routes.put(
    CONNECTION_PATH,
    options.requireUser,
    rejectQuery,
    requireMutationOrigin,
    requireJson,
    limitMutationBody,
    async (context) => {
      const body = await context.req.json().catch(() => undefined);
      if (!strictOpenRouterBody(body)) {
        return context.json(
          { error: "An exact OpenRouter provider and API key are required." },
          400,
        );
      }

      let validation: Awaited<ReturnType<OpenRouterKeyValidator["validate"]>>;
      try {
        validation = await options.validator.validate(body.apiKey, {
          signal: context.req.raw.signal,
        });
      } catch {
        const failure = validatorFailures.provider_unavailable;
        return context.json({ error: failure.error }, failure.status);
      }
      if (!validation.ok) {
        const failure = validatorFailures[validation.code];
        return context.json({ error: failure.error }, failure.status);
      }

      try {
        const status = await options.store.connect(
          {
            actorUserId: context.var.actor.id,
            provider: "openrouter",
            plaintext: body.apiKey,
            safeMetadata: validation.metadata,
          },
          deviceFlows?.cancelInvalidated,
        );
        return context.json(connectionEnvelope(status));
      } catch {
        return unavailable(context);
      }
    },
  );

  routes.delete(
    CONNECTION_PATH,
    options.requireUser,
    rejectQuery,
    requireMutationOrigin,
    limitMutationBody,
    async (context) => {
      const body = await context.req.arrayBuffer().catch(() => undefined);
      if (body?.byteLength !== 0) {
        return context.json(
          { error: "A disconnect request must have an empty body." },
          400,
        );
      }
      try {
        const status = await options.store.disconnect(
          context.var.actor.id,
          deviceFlows?.cancelInvalidated,
        );
        return context.json(connectionEnvelope(status));
      } catch {
        return unavailable(context);
      }
    },
  );

  if (deviceFlows) {
    routes.use(CHATGPT_DEVICE_FLOW_PATH, async (context, next) => {
      context.header("cache-control", "private, no-store");
      await next();
    });
    routes.use(`${CHATGPT_DEVICE_FLOW_PATH}/*`, async (context, next) => {
      context.header("cache-control", "private, no-store");
      await next();
    });

    routes.post(
      CHATGPT_DEVICE_FLOW_PATH,
      options.requireUser,
      rejectQuery,
      requireMutationOrigin,
      requireJson,
      limitMutationBody,
      async (context) => {
        const body = await context.req.json().catch(() => undefined);
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length !== 0
        ) {
          return context.json(
            { error: "An empty JSON object is required." },
            400,
          );
        }
        try {
          const flow = await deviceFlows.start(context.var.actor.id);
          return context.json(publicDeviceFlow(flow), 201);
        } catch (error) {
          return deviceFlowFailure(context, error);
        }
      },
    );

    routes.get(
      `${CHATGPT_DEVICE_FLOW_PATH}/:flowId`,
      options.requireUser,
      rejectQuery,
      async (context) => {
        try {
          const flow = await deviceFlows.status(
            context.var.actor.id,
            context.req.param("flowId"),
          );
          return context.json(publicDeviceFlow(flow));
        } catch (error) {
          return deviceFlowFailure(context, error);
        }
      },
    );

    routes.delete(
      `${CHATGPT_DEVICE_FLOW_PATH}/:flowId`,
      options.requireUser,
      rejectQuery,
      requireMutationOrigin,
      limitMutationBody,
      async (context) => {
        const body = await context.req.arrayBuffer().catch(() => undefined);
        if (body?.byteLength !== 0) {
          return context.json(
            { error: "A cancellation request must have an empty body." },
            400,
          );
        }
        try {
          const flow = await deviceFlows.cancel(
            context.var.actor.id,
            context.req.param("flowId"),
          );
          return context.json(publicDeviceFlow(flow));
        } catch (error) {
          return deviceFlowFailure(context, error);
        }
      },
    );
  }

  return routes;
}
