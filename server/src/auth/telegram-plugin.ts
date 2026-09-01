import type { InternalAdapter } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { expireCookie, setSessionCookie } from "better-auth/cookies";
import {
  type TelegramLoginOneTimeStorage,
  TelegramLoginProofReplayStore,
  type TelegramLoginStateStorageRecord,
  TelegramLoginStateStore,
  type VerifiedTelegramLogin,
  verifyTelegramLoginPayload,
} from "./telegram-login";

const TELEGRAM_BINDING_COOKIE = "telegram_login_binding";
const TELEGRAM_STATE_PREFIX = "manacost:telegram:state:";
const TELEGRAM_PROOF_PREFIX = "manacost:telegram:proof:";

/** The only value the low-level session contract accepts from a server-side verifier. */
export type VerifiedTelegramUser = Readonly<{ userId: string }>;

type TelegramLoginSettings = Readonly<{
  botToken: string;
  allowedUserIds: ReadonlySet<string>;
  ownerUserIds: ReadonlySet<string>;
  trustedOrigin: string;
}>;

export type TelegramRefusalReason =
  | "invalid_proof_or_state"
  | "not_allowlisted"
  | "owner_binding_required"
  | "identity_binding_unavailable"
  | "session_refused";

type TelegramVerifiedFlowOptions = Readonly<{
  telegram: TelegramLoginSettings;
  provisionVerifiedUser: (
    login: VerifiedTelegramLogin,
  ) => Promise<VerifiedTelegramUser | null>;
  /** Test/reference override. Production deliberately uses the internal database adapter. */
  oneTimeStorage?: TelegramLoginOneTimeStorage;
  /** Receives only a bounded reason code—never a Telegram id, hash, state or signed payload. */
  recordRefusal?: (reason: TelegramRefusalReason) => Promise<void>;
}>;

type TelegramContractOptions = Readonly<{
  resolveVerifiedUser: (
    request: Request,
  ) => Promise<VerifiedTelegramUser | null>;
}>;

export type TelegramSessionPluginOptions =
  | TelegramVerifiedFlowOptions
  | TelegramContractOptions;

const rejectUnverifiedRequest = async (): Promise<null> => null;

function unauthorized(): never {
  throw new APIError("UNAUTHORIZED", {
    message: "Authentication failed.",
  });
}

function secureResponseHeaders(context: {
  setHeader(name: string, value: string): void;
}): void {
  context.setHeader("Cache-Control", "no-store");
  context.setHeader("Referrer-Policy", "no-referrer");
}

function isVerifiedFlow(
  options: TelegramSessionPluginOptions,
): options is TelegramVerifiedFlowOptions {
  return "telegram" in options;
}

function parseStoredState(value: string): TelegramLoginStateStorageRecord {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object") unauthorized();
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.stateDigest !== "string" ||
    typeof candidate.trustedOrigin !== "string" ||
    typeof candidate.returnPath !== "string" ||
    typeof candidate.browserBindingDigest !== "string" ||
    typeof candidate.expiresAt !== "number"
  ) {
    unauthorized();
  }
  return {
    stateDigest: candidate.stateDigest,
    trustedOrigin: candidate.trustedOrigin,
    returnPath: candidate.returnPath,
    browserBindingDigest: candidate.browserBindingDigest,
    expiresAt: candidate.expiresAt,
  };
}

/** Map Task 5's atomic storage contract onto Better Auth's shared verification table. */
function databaseOneTimeStorage(
  adapter: InternalAdapter,
): TelegramLoginOneTimeStorage {
  return {
    async createState(record) {
      await adapter.createVerificationValue({
        identifier: `${TELEGRAM_STATE_PREFIX}${record.stateDigest}`,
        value: JSON.stringify(record),
        expiresAt: new Date(record.expiresAt),
      });
      return true;
    },
    async consumeState(stateDigest) {
      const verification = await adapter.consumeVerificationValue(
        `${TELEGRAM_STATE_PREFIX}${stateDigest}`,
      );
      return verification ? parseStoredState(verification.value) : null;
    },
    async reserveProof(replayKey, expiresAt) {
      return adapter.reserveVerificationValue({
        identifier: `${TELEGRAM_PROOF_PREFIX}${replayKey}`,
        value: "reserved",
        expiresAt: new Date(expiresAt),
      });
    },
  };
}

function strictStateRequest(request: Request): {
  origin: string;
  returnPath: string;
} {
  const origin = request.headers.get("origin");
  if (!origin) unauthorized();
  const params = new URL(request.url).searchParams;
  const values = params.getAll("returnPath");
  if (
    values.length !== 1 ||
    [...params.keys()].some((name) => name !== "returnPath")
  ) {
    unauthorized();
  }
  return { origin, returnPath: values[0] ?? "" };
}

function splitCallbackParameters(request: Request): {
  state: string;
  signedFields: URLSearchParams;
} {
  const input = new URL(request.url).searchParams;
  const states = input.getAll("state");
  if (states.length !== 1) unauthorized();
  const signedFields = new URLSearchParams();
  for (const [name, value] of input) {
    if (name !== "state") signedFields.append(name, value);
  }
  return { state: states[0] ?? "", signedFields };
}

/**
 * Create an ordinary Better Auth session after server-side Telegram verification and binding.
 *
 * The default remains fail-closed for non-Telegram deployments and the Task 3 contract seam. The
 * production flow validates the signed proof, consumes shared one-time state, reserves the proof,
 * resolves an immutable account binding, then creates the repository's normal session cookie.
 */
export function telegramSessionPlugin(
  options: TelegramSessionPluginOptions = {
    resolveVerifiedUser: rejectUnverifiedRequest,
  },
) {
  return {
    id: "manacost-telegram-session",
    version: "1.0.0",
    endpoints: {
      telegramState: createAuthEndpoint(
        "/telegram/state",
        { method: "GET", requireHeaders: true },
        async (context) => {
          secureResponseHeaders(context);
          if (!isVerifiedFlow(options) || !context.request) unauthorized();

          try {
            const request = strictStateRequest(context.request);
            const storage =
              options.oneTimeStorage ??
              databaseOneTimeStorage(context.context.internalAdapter);
            const stateStore = new TelegramLoginStateStore({
              trustedOrigin: options.telegram.trustedOrigin,
              storage,
            });
            const issued = await stateStore.issue({
              requestOrigin: request.origin,
              returnPath: request.returnPath,
            });
            const bindingCookie = context.context.createAuthCookie(
              TELEGRAM_BINDING_COOKIE,
              { maxAge: 120 },
            );
            await context.setSignedCookie(
              bindingCookie.name,
              issued.browserBinding,
              context.context.secret,
              bindingCookie.attributes,
            );
            return context.json({ state: issued.state });
          } catch {
            unauthorized();
          }
        },
      ),
      telegramCallback: createAuthEndpoint(
        "/telegram/callback",
        { method: "GET", requireHeaders: true },
        async (context) => {
          secureResponseHeaders(context);
          const request = context.request;
          if (!request) unauthorized();

          if (!isVerifiedFlow(options)) {
            const verifiedUser = await options.resolveVerifiedUser(request);
            if (!verifiedUser) unauthorized();
            const user = await context.context.internalAdapter.findUserById(
              verifiedUser.userId,
            );
            if (!user) unauthorized();
            const session = await context.context.internalAdapter.createSession(
              user.id,
            );
            if (!session) unauthorized();
            await setSessionCookie(context, { session, user });
            return context.json({ success: true });
          }

          const bindingCookie = context.context.createAuthCookie(
            TELEGRAM_BINDING_COOKIE,
            { maxAge: 120 },
          );
          let refusalReason: TelegramRefusalReason = "invalid_proof_or_state";
          try {
            const { state, signedFields } = splitCallbackParameters(request);
            const login = verifyTelegramLoginPayload(signedFields, {
              botToken: options.telegram.botToken,
            });
            if (!options.telegram.allowedUserIds.has(login.id)) {
              refusalReason = "not_allowlisted";
              unauthorized();
            }

            const browserBinding = await context.getSignedCookie(
              bindingCookie.name,
              context.context.secret,
            );
            if (!browserBinding) unauthorized();
            expireCookie(context, bindingCookie);

            const storage =
              options.oneTimeStorage ??
              databaseOneTimeStorage(context.context.internalAdapter);
            const stateStore = new TelegramLoginStateStore({
              trustedOrigin: options.telegram.trustedOrigin,
              storage,
            });
            const returnPath = await stateStore.consume({
              state,
              requestOrigin: options.telegram.trustedOrigin,
              browserBinding,
            });
            await new TelegramLoginProofReplayStore({ storage }).reserve(
              login.replayKey,
            );

            const verifiedUser = await options.provisionVerifiedUser(login);
            if (!verifiedUser) {
              refusalReason = options.telegram.ownerUserIds.has(login.id)
                ? "owner_binding_required"
                : "identity_binding_unavailable";
              unauthorized();
            }
            const user = await context.context.internalAdapter.findUserById(
              verifiedUser.userId,
            );
            if (!user) {
              refusalReason = "identity_binding_unavailable";
              unauthorized();
            }
            refusalReason = "session_refused";
            const session = await context.context.internalAdapter.createSession(
              user.id,
            );
            if (!session) unauthorized();
            await setSessionCookie(context, { session, user });
            return context.redirect(
              new URL(returnPath, options.telegram.trustedOrigin).toString(),
            );
          } catch {
            expireCookie(context, bindingCookie);
            try {
              await options.recordRefusal?.(refusalReason);
            } catch {
              // Authentication failure must remain fail-closed even if optional audit storage fails.
            }
            unauthorized();
          }
        },
      ),
    },
  };
}
