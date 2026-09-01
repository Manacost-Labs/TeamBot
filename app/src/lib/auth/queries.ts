import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

export type AuthenticatedUser = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role: "admin" | "user";
};

export const authKeys = {
  all: ["auth"] as const,
  currentUser: () => [...authKeys.all, "current-user"] as const,
  providers: () => [...authKeys.all, "providers"] as const,
};

/** An identity provider this deployment can sign somebody in with. */
export type AuthProviderId = "google" | "microsoft" | "okta";

/** What the sign-in screen may offer, answered by the process that knows. */
export type SignInOptions = {
  providers: AuthProviderId[];
  /**
   * Whether any enterprise identity provider is registered.
   *
   * A boolean, not a list: naming them would tell anybody who loads the sign-in page which companies
   * use this deployment, before they have signed in.
   */
  sso: boolean;
  /** The only public Telegram setting: the BotFather username used by the official widget. */
  telegram: { botUsername: string } | null;
};

const TELEGRAM_BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]$/;
const TELEGRAM_LOGIN_STATE = /^[a-f0-9]{64}$/;

async function signInOptions(): Promise<SignInOptions> {
  // The whole body, so both fields arrive together. Reading a field off the Response `client`
  // returns without a key quietly yields undefined: the screen would say no provider is configured
  // while the server was saying it has one.
  const body = (await (
    await client("/api/capabilities", { fallback: "Could not load sign-in" })
  ).json()) as {
    authProviders?: AuthProviderId[];
    ssoConfigured?: boolean;
    telegramEnabled?: boolean;
    botUsername?: unknown;
  };

  const botUsername =
    body.telegramEnabled === true &&
    typeof body.botUsername === "string" &&
    TELEGRAM_BOT_USERNAME.test(body.botUsername)
      ? body.botUsername
      : null;

  return {
    providers: body.authProviders ?? [],
    sso: body.ssoConfigured === true,
    telegram: botUsername ? { botUsername } : null,
  };
}

/** Ask the server for one browser-bound state; neither the destination nor its shape is caller-controlled. */
export async function telegramLoginState(
  signal?: AbortSignal,
): Promise<string> {
  const response = await client("/api/auth/telegram/state?returnPath=/", {
    fallback: "Could not prepare Telegram sign-in",
    method: "POST",
    signal,
  });
  const body = (await response.json()) as { state?: unknown };
  if (
    typeof body.state !== "string" ||
    !TELEGRAM_LOGIN_STATE.test(body.state)
  ) {
    throw new Error("Telegram sign-in returned an invalid state");
  }
  return body.state;
}

/**
 * Which providers the sign-in screen may offer.
 *
 * From the server rather than from the build. The image is built once with no deployment
 * environment, so a list compiled into the bundle can only ever describe the build machine.
 */
export function authProvidersQueryOptions() {
  return queryOptions({
    queryKey: authKeys.providers(),
    queryFn: signInOptions,
    // Configuration, not data. It cannot change without the process restarting.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

async function currentUser(): Promise<AuthenticatedUser | null> {
  /*
   * `tryClient` rather than `client`: not being signed in is an answer here, not a failure, and it
   * arrives as a 401 that has to be read before anything decides the request went wrong.
   */
  const response = await tryClient("/api/me");
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Could not load the current user (${response.status})`);
  }

  const body = (await response.json()) as { user: AuthenticatedUser };
  return body.user;
}

export function currentUserQueryOptions() {
  return queryOptions({
    queryKey: authKeys.currentUser(),
    queryFn: currentUser,
    staleTime: 60_000,
  });
}
