import { beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  type JSONWebKeySet,
} from "jose";
import {
  createTelegramOidcAuthorizationUrl,
  exchangeTelegramOidcCode,
  verifyTelegramOidcIdToken,
} from "../src/auth/telegram-oidc";

const CLIENT_ID = "123456789";
const CLIENT_SECRET = "synthetic-telegram-oidc-secret";
const TRUSTED_ORIGIN = "https://work.kolodahearthstone.com";
const REDIRECT_URI = `${TRUSTED_ORIGIN}/api/auth/telegram/callback`;
const STATE = "a".repeat(64);
const NONCE = "b".repeat(64);
const CODE_VERIFIER = "c".repeat(64);
const NOW_SECONDS = 1_700_000_000;

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
let localJwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const jwk = await exportJWK(publicKey);
  localJwks = createLocalJWKSet({
    keys: [{ ...jwk, alg: "RS256", kid: "telegram-test-key", use: "sig" }],
  } as JSONWebKeySet);
});

async function signedToken(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const issuer =
    typeof overrides.iss === "string"
      ? overrides.iss
      : "https://oauth.telegram.org";
  const audience =
    typeof overrides.aud === "string" ? overrides.aud : CLIENT_ID;
  const issuedAt =
    typeof overrides.iat === "number" ? overrides.iat : NOW_SECONDS;
  const {
    iss: _issuer,
    aud: _audience,
    iat: _issuedAt,
    ...profileOverrides
  } = overrides;
  return new SignJWT({
    sub: "telegram-oidc-subject-883935723",
    id: 883935723,
    name: "Manacost Editor",
    given_name: "Manacost",
    family_name: "Editor",
    preferred_username: "manacost_editor",
    picture: "https://t.me/i/userpic/320/editor.jpg",
    nonce: NONCE,
    ...profileOverrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "telegram-test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(NOW_SECONDS + 300)
    .sign(privateKey);
}

describe("Telegram OIDC authorization", () => {
  test("builds the fixed Telegram authorization-code flow with S256 PKCE", () => {
    const url = createTelegramOidcAuthorizationUrl({
      clientId: CLIENT_ID,
      codeVerifier: CODE_VERIFIER,
      nonce: NONCE,
      redirectUri: REDIRECT_URI,
      state: STATE,
    });

    expect(url.origin).toBe("https://oauth.telegram.org");
    expect(url.pathname).toBe("/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: "S256",
      nonce: NONCE,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "openid profile",
      state: STATE,
    });
    expect(url.toString()).not.toContain(CLIENT_SECRET);
    expect(url.toString()).not.toContain(CODE_VERIFIER);
  });

  test("redeems a code only at Telegram with Basic client authentication", async () => {
    const requests: Request[] = [];
    const idToken = await signedToken();
    const result = await exchangeTelegramOidcCode({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code: "one-time-code",
      codeVerifier: CODE_VERIFIER,
      redirectUri: REDIRECT_URI,
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({ id_token: idToken });
      },
    });

    expect(result).toBe(idToken);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toBe("https://oauth.telegram.org/token");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    );
    expect(request?.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(new URLSearchParams(await request?.text()))).toEqual({
      client_id: CLIENT_ID,
      code: "one-time-code",
      code_verifier: CODE_VERIFIER,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    });
  });

  test("uses one generic exchange error without leaking Telegram credentials", async () => {
    let caught: unknown;
    try {
      await exchangeTelegramOidcCode({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        code: "sensitive-code",
        codeVerifier: CODE_VERIFIER,
        redirectUri: REDIRECT_URI,
        fetcher: async () =>
          Response.json(
            { error: "invalid_grant", error_description: "sensitive-code" },
            { status: 400 },
          ),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const serialized = String(caught);
    expect(serialized).toBe("Error: Telegram OIDC exchange failed.");
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain("sensitive-code");
  });
});

describe("Telegram OIDC ID token verification", () => {
  test("maps a verified Telegram identity to the existing immutable login contract", async () => {
    const login = await verifyTelegramOidcIdToken(await signedToken(), {
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
      key: localJwks,
      nowSeconds: NOW_SECONDS,
    });

    expect(login).toEqual({
      id: "883935723",
      firstName: "Manacost",
      lastName: "Editor",
      username: "manacost_editor",
      photoUrl: "https://t.me/i/userpic/320/editor.jpg",
      authDate: NOW_SECONDS,
      replayKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test.each([
    ["wrong issuer", { iss: "https://attacker.example" }, NONCE],
    ["wrong audience", { aud: "other-client" }, NONCE],
    ["wrong nonce", {}, "wrong-nonce"],
    ["missing Telegram id", { id: undefined }, NONCE],
    ["non-canonical Telegram id", { id: "0883935723" }, NONCE],
    ["an issued-at time from the future", { iat: NOW_SECONDS + 61 }, NONCE],
  ])("rejects %s with one generic verification error", async (_name, claims, nonce) => {
    const token = await signedToken(claims as Record<string, unknown>);

    await expect(
      verifyTelegramOidcIdToken(token, {
        clientId: CLIENT_ID,
        expectedNonce: nonce as string,
        key: localJwks,
        nowSeconds: NOW_SECONDS,
      }),
    ).rejects.toThrow("Telegram OIDC verification failed.");
  });
});
