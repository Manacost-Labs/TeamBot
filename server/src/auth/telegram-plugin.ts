import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";

/**
 * The only value the session-minting layer accepts from Telegram verification.
 *
 * The browser never gets to choose this id. Tasks 4-6 provide the verifier and account binding;
 * until then the default resolver rejects every request. Keeping that boundary in the plugin
 * contract prevents a future callback from accidentally turning a query-string `userId` into a
 * session.
 */
export type VerifiedTelegramUser = Readonly<{ userId: string }>;

export type TelegramSessionPluginOptions = {
  resolveVerifiedUser: (
    request: Request,
  ) => Promise<VerifiedTelegramUser | null>;
};

const rejectUnverifiedRequest = async (): Promise<null> => null;

/**
 * Create an ordinary Better Auth session after a server-side Telegram verifier has authenticated
 * and authorized the request.
 *
 * This is deliberately a Better Auth plugin endpoint rather than a Hono route with its own token:
 * `createSession` runs the existing session hooks and `setSessionCookie` uses the same signed,
 * HttpOnly cookie as every other sign-in method. The default resolver is fail-closed while the
 * Telegram cryptographic and allowlist boundary is implemented in Tasks 4-6.
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
      telegramCallback: createAuthEndpoint(
        "/telegram/callback",
        {
          method: "GET",
          requireHeaders: true,
        },
        async (context) => {
          const request = context.request;
          if (!request) {
            throw new APIError("UNAUTHORIZED", {
              message: "Authentication failed.",
            });
          }

          const verifiedUser = await options.resolveVerifiedUser(request);
          if (!verifiedUser) {
            throw new APIError("UNAUTHORIZED", {
              message: "Authentication failed.",
            });
          }

          const user = await context.context.internalAdapter.findUserById(
            verifiedUser.userId,
          );
          if (!user) {
            // Do not reveal whether Telegram verification succeeded or which local id was resolved.
            throw new APIError("UNAUTHORIZED", {
              message: "Authentication failed.",
            });
          }

          const session = await context.context.internalAdapter.createSession(
            user.id,
          );
          if (!session) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Unable to create a session.",
            });
          }

          await setSessionCookie(context, { session, user });
          return context.json({ success: true });
        },
      ),
    },
  };
}
