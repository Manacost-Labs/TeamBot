import { createHash } from "node:crypto";
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import type { VerifiedTelegramLogin } from "./telegram-login";

const TELEGRAM_OIDC_ISSUER = "https://oauth.telegram.org";
const TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT = `${TELEGRAM_OIDC_ISSUER}/auth`;
const TELEGRAM_OIDC_TOKEN_ENDPOINT = `${TELEGRAM_OIDC_ISSUER}/token`;
const TELEGRAM_OIDC_JWKS_ENDPOINT = `${TELEGRAM_OIDC_ISSUER}/.well-known/jwks.json`;
const MAX_TOKEN_RESPONSE_BYTES = 16 * 1024;
const MAX_TELEGRAM_ID = (1n << 52n) - 1n;
const CANONICAL_POSITIVE_INTEGER = /^[1-9]\d*$/;
const FLOW_SECRET = /^[A-Za-z0-9_-]{43,128}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const USERNAME = /^[A-Za-z0-9_]{1,64}$/;

const telegramJwks = createRemoteJWKSet(new URL(TELEGRAM_OIDC_JWKS_ENDPOINT), {
  cacheMaxAge: 10 * 60_000,
  cooldownDuration: 30_000,
  timeoutDuration: 5_000,
  [customFetch]: (url, init) => fetch(url, { ...init, redirect: "error" }),
});

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type TelegramOidcAuthorizationInput = Readonly<{
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}>;

type TelegramOidcExchangeInput = Readonly<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetcher?: Fetcher;
}>;

type TelegramOidcVerificationOptions = Readonly<{
  clientId: string;
  expectedNonce: string;
  key?: JWTVerifyGetKey;
  nowSeconds?: number;
}>;

function genericExchangeError(): Error {
  return new Error("Telegram OIDC exchange failed.");
}

function genericVerificationError(): Error {
  return new Error("Telegram OIDC verification failed.");
}

function boundedText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength) {
    return null;
  }
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || point === 127;
  })
    ? null
    : value;
}

function canonicalClientId(value: string): boolean {
  return CANONICAL_POSITIVE_INTEGER.test(value) && value.length <= 20;
}

function canonicalRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname === "/api/auth/telegram/callback"
    );
  } catch {
    return false;
  }
}

function canonicalTelegramId(value: unknown): string | null {
  const candidate =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  if (!CANONICAL_POSITIVE_INTEGER.test(candidate) || candidate.length > 16) {
    return null;
  }
  try {
    return BigInt(candidate) <= MAX_TELEGRAM_ID ? candidate : null;
  } catch {
    return null;
  }
}

function profilePicture(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  const candidate = boundedText(value, 2_048);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && !url.username && !url.password
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function pkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

/** A nonce derived from the browser-bound verifier, without another client-readable secret. */
export function telegramOidcNonce(codeVerifier: string): string {
  if (!PKCE_VERIFIER.test(codeVerifier)) throw genericVerificationError();
  return createHash("sha256")
    .update("telegram-oidc-nonce\0")
    .update(codeVerifier)
    .digest("hex");
}

/** Build only Telegram's documented Authorization Code + PKCE request. */
export function createTelegramOidcAuthorizationUrl(
  input: TelegramOidcAuthorizationInput,
): URL {
  if (
    !canonicalClientId(input.clientId) ||
    !canonicalRedirectUri(input.redirectUri) ||
    !FLOW_SECRET.test(input.state) ||
    !FLOW_SECRET.test(input.nonce) ||
    !PKCE_VERIFIER.test(input.codeVerifier)
  ) {
    throw genericVerificationError();
  }

  const url = new URL(TELEGRAM_OIDC_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    scope: "openid profile",
    redirect_uri: input.redirectUri,
    state: input.state,
    nonce: input.nonce,
    code_challenge: pkceChallenge(input.codeVerifier),
    code_challenge_method: "S256",
  }).toString();
  return url;
}

/** Redeem one authorization code without surfacing Telegram's response or credentials. */
export async function exchangeTelegramOidcCode(
  input: TelegramOidcExchangeInput,
): Promise<string> {
  try {
    if (
      !canonicalClientId(input.clientId) ||
      !boundedText(input.clientSecret, 512) ||
      !canonicalRedirectUri(input.redirectUri) ||
      !boundedText(input.code, 4_096) ||
      !PKCE_VERIFIER.test(input.codeVerifier)
    ) {
      throw genericExchangeError();
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
    });
    const response = await (input.fetcher ?? fetch)(TELEGRAM_OIDC_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (
      !response.ok ||
      (Number.isFinite(declaredLength) && declaredLength > MAX_TOKEN_RESPONSE_BYTES)
    ) {
      throw genericExchangeError();
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_TOKEN_RESPONSE_BYTES) {
      throw genericExchangeError();
    }
    const parsed: unknown = JSON.parse(text);
    const idToken =
      parsed && typeof parsed === "object"
        ? boundedText((parsed as Record<string, unknown>).id_token, 14_000)
        : null;
    if (!idToken || idToken.split(".").length !== 3) {
      throw genericExchangeError();
    }
    return idToken;
  } catch {
    throw genericExchangeError();
  }
}

/** Verify Telegram's signed profile and map it to the existing numeric-ID account contract. */
export async function verifyTelegramOidcIdToken(
  idToken: string,
  options: TelegramOidcVerificationOptions,
): Promise<VerifiedTelegramLogin> {
  try {
    if (
      !boundedText(idToken, 14_000) ||
      !canonicalClientId(options.clientId) ||
      !FLOW_SECRET.test(options.expectedNonce)
    ) {
      throw genericVerificationError();
    }
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
      throw genericVerificationError();
    }

    const { payload } = await jwtVerify(idToken, options.key ?? telegramJwks, {
      algorithms: ["RS256"],
      audience: options.clientId,
      currentDate: new Date(nowSeconds * 1_000),
      issuer: TELEGRAM_OIDC_ISSUER,
      requiredClaims: ["sub", "iat", "exp", "nonce"],
    });
    if (payload.nonce !== options.expectedNonce) {
      throw genericVerificationError();
    }

    const id = canonicalTelegramId(payload.id);
    const firstName =
      boundedText(payload.given_name, 256) ?? boundedText(payload.name, 256);
    const lastName =
      payload.family_name === undefined
        ? undefined
        : boundedText(payload.family_name, 256);
    const username =
      payload.preferred_username === undefined
        ? undefined
        : boundedText(payload.preferred_username, 64);
    const picture = profilePicture(payload.picture);
    if (
      !id ||
      !firstName ||
      (payload.family_name !== undefined && !lastName) ||
      (username !== undefined &&
        (username === null || !USERNAME.test(username))) ||
      picture === null ||
      typeof payload.sub !== "string" ||
      payload.sub.length < 1 ||
      payload.sub.length > 256 ||
      typeof payload.iat !== "number" ||
      !Number.isSafeInteger(payload.iat) ||
      payload.iat <= 0
    ) {
      throw genericVerificationError();
    }

    const replayKey = createHash("sha256")
      .update("telegram-oidc-proof\0")
      .update(
        JSON.stringify([
          payload.iss,
          payload.aud,
          payload.sub,
          id,
          payload.iat,
          payload.exp,
          options.expectedNonce,
        ]),
      )
      .digest("hex");
    return Object.freeze({
      id,
      firstName,
      ...(lastName ? { lastName } : {}),
      ...(username ? { username } : {}),
      ...(picture ? { photoUrl: picture } : {}),
      authDate: payload.iat,
      replayKey,
    });
  } catch {
    throw genericVerificationError();
  }
}
